#!/usr/bin/env bash
set -euo pipefail

project_file="ios/Beebeeb.xcodeproj/project.pbxproj"

if rg -n 'path = "../plugins/file-provider/' "$project_file"; then
  echo "File Provider target still references plugins/file-provider; expected targets/file-provider" >&2
  exit 1
fi

required=(
  "../targets/file-provider/FileProviderExtension.swift"
  "../targets/file-provider/FileProviderItem.swift"
  "../targets/file-provider/FileProviderEnumerator.swift"
  "../targets/file-provider/CacheManager.swift"
  "../targets/file-provider/ApiClient.swift"
  "../targets/file-provider/CryptoBridge.swift"
  "../targets/file-provider/KeychainKeyLoader.swift"
  "../targets/file-provider/Constants.swift"
  "../targets/file-provider/SyncEngine.swift"
)

for path in "${required[@]}"; do
  if ! rg -F "path = \"$path\"" "$project_file" >/dev/null; then
    echo "Missing File Provider source reference: $path" >&2
    exit 1
  fi
done

echo "File Provider target uses targets/file-provider sources"
