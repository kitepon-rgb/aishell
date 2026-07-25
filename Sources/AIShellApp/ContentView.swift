import AIShellCore
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel

    /// 境界の位置は窓の高さに対する比で持つ。窓をresizeしても見え方の比率が保たれる。
    @AppStorage("configurationPaneFraction") private var configurationPaneFraction = 0.5
    /// drag開始時の比。translationは開始点からの累積なので、基準を固定しないと加速する。
    @State private var dragBaselineFraction: Double?

    private static let dividerHitHeight: CGFloat = 10
    private static let paneFractionRange = 0.15...0.85

    var body: some View {
        VStack(spacing: 0) {
            installationBanner
            header
            Divider()
            // header以下を設定と履歴で分ける。既定は半分ずつで、境界はdragで動かせる。
            // 内容量で比率が決まると、rootが増えた時に履歴が押し出されて見えなくなる。
            // 溢れた分は各paneの内側でscrollさせる。
            GeometryReader { proxy in
                let available = max(proxy.size.height - Self.dividerHitHeight, 0)
                let configurationHeight = available * clampedPaneFraction
                VStack(spacing: 0) {
                    configurationPanel
                        .frame(height: configurationHeight)
                    paneDivider(available: available)
                    activityPanel
                        .frame(height: available - configurationHeight)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await model.poll() }
        .alert("AIShellでエラーが発生しました", isPresented: errorBinding) {
            Button("閉じる") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "不明なエラー")
        }
    }

    private var clampedPaneFraction: Double {
        min(max(configurationPaneFraction, Self.paneFractionRange.lowerBound), Self.paneFractionRange.upperBound)
    }

    /// 掴める境界。透明な領域はgestureを拾わないため、実体のあるbarとgripを描いて掴める場所を見せる。
    private func paneDivider(available: CGFloat) -> some View {
        ZStack {
            Rectangle()
                .fill(.quaternary.opacity(0.6))
            Capsule()
                .fill(.secondary)
                .frame(width: 34, height: 3)
        }
        .frame(height: Self.dividerHitHeight)
        .contentShape(Rectangle())
        .onHover { isInside in
            if isInside {
                NSCursor.resizeUpDown.push()
            } else {
                NSCursor.pop()
            }
        }
        .gesture(
            DragGesture(minimumDistance: 1)
                .onChanged { value in
                    guard available > 0 else { return }
                    let baseline = dragBaselineFraction ?? clampedPaneFraction
                    if dragBaselineFraction == nil { dragBaselineFraction = baseline }
                    let moved = baseline + value.translation.height / available
                    configurationPaneFraction = min(
                        max(moved, Self.paneFractionRange.lowerBound),
                        Self.paneFractionRange.upperBound
                    )
                }
                .onEnded { _ in dragBaselineFraction = nil }
        )
        .accessibilityLabel("設定と操作履歴の境界")
        .accessibilityHint("dragで上下の割合を変えます。ダブルクリックで半分に戻します。")
        .onTapGesture(count: 2) { configurationPaneFraction = 0.5 }
    }

    /// 実体を差し替えられた窓はUIも操作も受け付けるのにファイル選択だけが無反応になる。
    /// 黙って壊れたままにせず、状態と復帰手段を最上段で明示する。
    @ViewBuilder
    private var installationBanner: some View {
        if model.installationStatus.requiresRestart {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 20, weight: .semibold))

                VStack(alignment: .leading, spacing: 3) {
                    Text("新しい版がインストールされ、この窓は古い実体で動いています")
                        .font(.callout.bold())
                    Text(installationBannerDetail)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 12)

                if canOfferRelaunch {
                    Button("再起動") { model.relaunchForReplacedInstallation() }
                        .buttonStyle(.borderedProminent)
                        .tint(.white)
                } else {
                    Button("終了") { model.quitForRemovedInstallation() }
                        .buttonStyle(.borderedProminent)
                        .tint(.white)
                }
            }
            .foregroundStyle(.white)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange)
        }
    }

    /// 一度失敗した再起動を勧め続けない。失敗後は手動での開き直しへ切り替える。
    private var canOfferRelaunch: Bool {
        model.installationStatus.canRelaunchInPlace && model.relaunchFailure == nil
    }

    private var installationBannerDetail: String {
        if let failure = model.relaunchFailure {
            return "新版の起動に失敗しました（\(failure)）。"
                + "終了して aishell-open で開き直してください。"
        }
        if model.installationStatus.canRelaunchInPlace {
            return "開き直すまで、rootの追加などファイル選択を伴う操作は無反応になります。再起動すると新版へ移ります。"
        }
        return "この窓の実行ファイルは削除済みです。開き直すまで、rootの追加などファイル選択を伴う操作は無反応になります。"
            + "終了して aishell-open で開き直してください。"
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "macwindow")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(.blue)

            VStack(alignment: .leading, spacing: 3) {
                Text("AIShell")
                    .font(.title2.bold())
                Text("AIからmacOS APIへ、shellを介さない直接操作")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            statusBadge
        }
        .padding(20)
    }

    private var statusBadge: some View {
        Label(
            model.isReady ? "操作可能" : model.configuration.isPaused ? "停止中" : "設定が必要",
            systemImage: model.isReady ? "checkmark.circle.fill" : "pause.circle.fill"
        )
        .font(.callout.weight(.semibold))
        .foregroundStyle(model.isReady ? .green : .orange)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.quaternary, in: Capsule())
    }

    private var configurationPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("直接操作の設定")
                .font(.headline)

            HStack {
                Text("許可root（\(model.configuration.allowedRootPaths.count)件）")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button("rootを追加", systemImage: "plus") {
                    model.addRoots()
                }
            }

            if model.configuration.allowedRootPaths.isEmpty {
                ContentUnavailableView(
                    "許可rootがありません",
                    systemImage: "folder.badge.plus",
                    description: Text("rootを追加すると、その内側をAIが直接操作できます。")
                )
                .frame(maxHeight: .infinity)
            } else {
                // rootが増えた分はこのScrollViewの中だけで伸び、履歴の領域を押し出さない。
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(model.configuration.allowedRootPaths, id: \.self) { path in
                            HStack(spacing: 10) {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(.blue)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(URL(fileURLWithPath: path).lastPathComponent)
                                        .font(.body.weight(.semibold))
                                    Text(path)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                                Spacer()
                                Button("削除", systemImage: "minus.circle") {
                                    model.removeRoot(path)
                                }
                                .labelStyle(.iconOnly)
                                .foregroundStyle(.red)
                                .help("この許可rootを削除")
                            }
                            .padding(.vertical, 8)
                            if path != model.configuration.allowedRootPaths.last {
                                Divider()
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                }
                .frame(maxHeight: .infinity)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            }

            HStack {
                Text("絶対パスは一致するrootへ自動割当て、相対パスは先頭rootを基準にします。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(model.configuration.isPaused ? "AI操作を再開" : "AI操作を停止") {
                    model.togglePaused()
                }
                .buttonStyle(.borderedProminent)
                .tint(model.configuration.isPaused ? .green : .red)
                .disabled(model.configuration.allowedRootPaths.isEmpty)
            }
        }
        .padding(20)
    }

    private var activityPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("操作履歴")
                    .font(.headline)
                Spacer()
                Text("直近100件")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if model.activities.isEmpty {
                ContentUnavailableView(
                    "まだ操作はありません",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("AIからmacOSを操作すると、ここに記録されます。")
                )
            } else {
                List(model.activities) { record in
                    ActivityRow(record: record)
                }
                .listStyle(.inset)
            }
        }
        .padding(20)
        .frame(maxHeight: .infinity)
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )
    }
}

private struct ActivityRow: View {
    let record: OperationRecord

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: record.success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(record.success ? .green : .red)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(record.operation)
                        .font(.body.weight(.medium))
                    Spacer()
                    Text(record.timestamp, format: .dateTime.hour().minute().second())
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Text(record.target)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if !record.success {
                    Text(record.message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(.vertical, 3)
    }
}
