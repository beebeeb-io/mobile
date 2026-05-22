#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC_ENGINE="$ROOT/targets/file-provider/SyncEngine.swift"
CRYPTO_BRIDGE="$ROOT/targets/file-provider/CryptoBridge.swift"
KEY_LOADER="$ROOT/targets/file-provider/KeychainKeyLoader.swift"
KEYCHAIN_MANAGER="$ROOT/modules/beebeeb-crypto/ios/KeychainManager.swift"

if ! grep -q 'CryptoBridge.loadMasterKeyHandle' "$SYNC_ENGINE"; then
  echo "FileProvider SyncEngine must load the extension-safe master key handle" >&2
  exit 1
fi

if ! grep -q 'CryptoBridge.decryptNameWithMime' "$SYNC_ENGINE"; then
  echo "FileProvider SyncEngine must decrypt encrypted filenames before caching rows" >&2
  exit 1
fi

if ! grep -q 'masterKeyHandle.decryptNameWithMime' "$CRYPTO_BRIDGE"; then
  echo "FileProvider CryptoBridge must support the canonical Rust/Core name envelope" >&2
  exit 1
fi

if ! grep -q 'R8352WDJJR.io.beebeeb.shared' "$KEY_LOADER"; then
  echo "FileProvider KeychainKeyLoader must query the same shared keychain group as the main app" >&2
  exit 1
fi

if ! awk '/private static func findSEKey\(tag: Data\)/,/^  }/' "$KEY_LOADER" | grep -q 'kSecAttrAccessGroup: accessGroup'; then
  echo "FileProvider KeychainKeyLoader must include the shared access group when querying its SE key" >&2
  exit 1
fi

if grep -q 'fetchWrappedBlob(label: label, service: BeebeebConstants.keychainService)' "$KEY_LOADER"; then
  echo "FileProvider KeychainKeyLoader must not fall back to the primary biometric key" >&2
  exit 1
fi

if ! grep -q 'private static func storeExtensionWrappedKey(masterKeyBytes: Data, label: String) throws' "$KEYCHAIN_MANAGER"; then
  echo "Main app KeychainManager must require extension wrapped key writes to succeed" >&2
  exit 1
fi

if ! grep -q 'try storeExtensionWrappedKey(masterKeyBytes: plaintextData, label: label)' "$KEYCHAIN_MANAGER"; then
  echo "Main app KeychainManager must repair the extension wrapped key after unlock" >&2
  exit 1
fi

if grep -q 'When biometric is OFF the primary key already uses .devicePasscode' "$KEYCHAIN_MANAGER"; then
  echo "Main app KeychainManager must keep the extension wrapped key available regardless of biometric setting" >&2
  exit 1
fi

if ! grep -q 'forceReset: Bool = false' "$ROOT/modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift"; then
  echo "File Provider registration must support forced reset for explicit remount" >&2
  exit 1
fi

if ! grep -q 'fileProviderDomainSchemaVersion = "replicated-v6-cache-bootstrap"' "$ROOT/modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift"; then
  echo "File Provider domain schema must force one repair reset after cache bootstrap fixes" >&2
  exit 1
fi

if ! grep -q 'registerMountedFileProviderDomain(defaults: defaults, forceReset: true)' "$ROOT/modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift"; then
  echo "Explicit File Provider mount must force remove/re-add stale Files domains" >&2
  exit 1
fi

if ! grep -q 'ensureFileProviderCacheDatabase()' "$ROOT/modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift"; then
  echo "File Provider registration must bootstrap the shared SQLite cache before reporting success" >&2
  exit 1
fi

echo "FileProvider decrypt-name guard passed"
