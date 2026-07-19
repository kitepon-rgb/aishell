#!/bin/zsh

set -euo pipefail

project_dir="${0:A:h:h}"
configuration="${1:-debug}"
app_dir="$project_dir/build/AIShell.app"
contents_dir="$app_dir/Contents"
swift_build_dir="$project_dir/.build/arm64-apple-macosx/$configuration"

swift build --package-path "$project_dir" -c "$configuration"

mkdir -p "$contents_dir/MacOS" "$contents_dir/Helpers" "$contents_dir/Resources"
ditto "$project_dir/Packaging/Info.plist" "$contents_dir/Info.plist"
ditto "$swift_build_dir/AIShell" "$contents_dir/MacOS/AIShell"
ditto "$swift_build_dir/aishell-mcp" "$contents_dir/Helpers/aishell-mcp"
chmod 755 "$contents_dir/MacOS/AIShell" "$contents_dir/Helpers/aishell-mcp"
codesign --force --deep --sign - "$app_dir"

print "$app_dir"
