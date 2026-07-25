#!/usr/bin/env node

// npm global upgradeは既存packageを`@quolu/.aishell-XXXX`へrenameしてから削除する。窓を開いたまま
// upgradeすると、そのprocessは消えた実体を掴み続け、UIは動くのにbundle resourceを要求するAPI
// （NSOpenPanelなど）だけが無反応になる。errorも出ないため「rootを追加できない」と見える。
// install時点でその窓を見つけて再起動を促す。app側の自己検知（AIShellCore/InstallationIntegrity）
// と二重の網であり、どちらもinstall自体は止めない。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const executablePattern = /^(\d+)\s+(\/.*\/AIShell\.app\/Contents\/MacOS\/AIShell)$/;
// renameで退避された旧installのpath。実体が残っていてもそのbundleは削除される途中にある。
const stagingPathPattern = /\/\.aishell-[^/]+\//;

/// `ps -axo pid=,comm=`の出力から、置換済みの実体を掴んだ窓だけを選ぶ。
/// 生きているinstallのpathから動いている窓は対象にしない（localのnpm installで誤警告しないため）。
export function selectStaleWindows(processListing, { exists = existsSync } = {}) {
  return processListing
    .split("\n")
    .flatMap((line) => {
      const matched = line.trim().match(executablePattern);
      return matched ? [{ pid: Number(matched[1]), executable: matched[2] }] : [];
    })
    .filter(({ executable }) => !exists(executable) || stagingPathPattern.test(executable));
}

export function staleWindowWarning(stale) {
  const pidList = stale.map(({ pid }) => `pid ${pid}`).join(", ");
  return [
    "",
    `[AIShell] 起動中の窓（${pidList}）が、このinstallで置き換えられた実体を掴んでいます。`,
    "          そのままではrootの追加などファイル選択を伴う操作が無反応になります。",
    "          窓を終了して `aishell-open` で開き直してください。",
    ""
  ].join("\n");
}

function main() {
  const listing = spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" });

  if (listing.error || listing.status !== 0) {
    // 確認できなかったことを「問題なし」へ言い換えない。
    console.warn(
      "[AIShell] 起動中の窓を確認できませんでした（psが利用できません）。" +
        "AIShellを開いたままupgradeした場合は、窓を開き直してください。"
    );
    return;
  }

  const stale = selectStaleWindows(listing.stdout);
  if (stale.length > 0) {
    console.warn(staleWindowWarning(stale));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
