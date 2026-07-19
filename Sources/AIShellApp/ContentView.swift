import AIShellCore
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            configurationPanel
            Divider()
            activityPanel
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await model.poll() }
        .alert("AIShellでエラーが発生しました", isPresented: errorBinding) {
            Button("閉じる") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "不明なエラー")
        }
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
                .frame(maxHeight: 120)
            } else {
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
