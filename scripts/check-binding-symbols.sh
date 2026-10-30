#!/usr/bin/env bash
# Source/header gate for the 2237c ABI. Native binaries must also be rebuilt;
# this source gate alone never proves that an xcframework or .so is current.
set -euo pipefail
ROOT="${BB_BINDING_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
python3 - "$ROOT" "${1:-}" <<'PY'
import pathlib, sys, tempfile
root = pathlib.Path(sys.argv[1])
paths = [
 'modules/beebeeb-crypto/ios/beebeeb_uniffi.swift',
 'modules/beebeeb-crypto/android/src/main/java/uniffi/beebeeb_uniffi/beebeeb_uniffi.kt',
 'ios/BeebeebCore.xcframework/ios-arm64/Headers/beebeeb_uniffiFFI.h',
 'ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers/beebeeb_uniffiFFI.h',
]
symbols = [
 'constructor_filekeyhandle_' + n for n in ['generate', 'from_folder_link', 'from_folder_link_passphrase', 'from_key_bytes']
] + ['method_filekeyhandle_' + n for n in ['wrap_key', 'unwrap_key', 'wrap_folder_child', 'unwrap_folder_child', 'key_id', 'encrypt_name_for', 'decrypt_name_metadata']
] + ['constructor_chunkdecryptorhandle_for_push_with_file_key_handle'] + [
 'method_masterkeyhandle_' + n for n in ['wrap_key', 'wrap_bytes', 'wrap_owner_file_key', 'unwrap_owner_file_key', 'wrap_folder_custody', 'unwrap_folder_custody', 'wrap_link_owner_key', 'unwrap_link_owner_key', 'wrap_link_owner_token', 'unwrap_link_owner_token', 'owner_file_key_for_name', 'owner_file_key_for_content']
]

types = ['OwnerFileKey', 'OwnerKeyConvention']

def check(base, quiet=False):
    missing = []
    for path in paths:
        text = (base / path).read_text() if (base / path).is_file() else ''
        for symbol in symbols:
            if 'uniffi_beebeeb_uniffi_fn_' + symbol not in text:
                missing.append(f'{path}: missing {symbol}')
        pin = 'expected_chunk_format' if path.endswith('.h') else 'expectedChunkFormat'
        if pin not in text:
            missing.append(f'{path}: missing {pin}')
        if not path.endswith('.h'):
            for type_name in types:
                if type_name not in text:
                    missing.append(f'{path}: missing {type_name}')
    if not quiet:
        for error in missing: print(error)
        total = len(paths) * (len(symbols) + 1) + 2 * len(types)
        print(f'binding-symbols: {total-len(missing)}/{total} present, {len(missing)} missing')
    return missing

if sys.argv[2] == '--self-test':
    # A synthetic complete corpus isolates the guard from installed artifacts.
    with tempfile.TemporaryDirectory(prefix='bb-2237c-symbols-') as tmp:
        base = pathlib.Path(tmp)
        for path in paths:
            p = base / path; p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('\n'.join('uniffi_beebeeb_uniffi_fn_' + s for s in symbols) + '\nexpectedChunkFormat expected_chunk_format OwnerFileKey OwnerKeyConvention')
        assert not check(base, True)
        for path in paths:
            p = base / path; original = p.read_text()
            p.write_text(original.replace(symbols[0], 'REMOVED'))
            assert len(check(base, True)) == 1, path
            p.write_text(original)
        print('binding-symbols self-test: 5 passed, 0 failed')
else:
    sys.exit(1 if check(root) else 0)
PY
