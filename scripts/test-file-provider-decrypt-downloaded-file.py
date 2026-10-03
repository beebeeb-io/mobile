#!/usr/bin/env python3
"""Task 1722 hostless harness for CryptoBridge.decryptDownloadedFile.

Extracts the actual decryptDownloadedFile function body from targets/file-provider/
CryptoBridge.swift at runtime, wraps it with minimal MasterKeyHandle/FileKeyHandle
and DownloadedEncryptedFile stubs, then executes the generated Swift program.
"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap


def extract_function_body(source: str, signature: str) -> str:
    sig_start = source.find(signature)
    if sig_start < 0:
        raise RuntimeError(f"missing signature: {signature}")
    open_brace = source.find('{', sig_start)
    if open_brace < 0:
        raise RuntimeError("missing function opening brace")
    body_start = source.find('\n', open_brace) + 1
    depth = 0
    in_line_comment = False
    in_block_comment = False
    in_string = False
    escape = False
    for index in range(open_brace, len(source)):
        char = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ''
        if in_line_comment:
            if char == '\n':
                in_line_comment = False
            continue
        if in_block_comment:
            if char == '*' and nxt == '/':
                in_block_comment = False
            continue
        if in_string:
            if escape:
                escape = False
                continue
            if char == '\\':
                escape = True
                continue
            if char == '"':
                in_string = False
            continue
        if char == '/' and nxt == '/':
            in_line_comment = True
            continue
        if char == '/' and nxt == '*':
            in_block_comment = True
            continue
        if char == '"':
            in_string = True
            continue
        if char == '{':
            depth += 1
            continue
        if char == '}':
            depth -= 1
            if depth == 0:
                return source[body_start:index].rstrip() + '\n'
    raise RuntimeError("could not find function end")


def indent(text: str, spaces: int) -> str:
    prefix = ' ' * spaces
    return ''.join(prefix + line if line.strip() else line for line in text.splitlines(keepends=True))


def build_swift(body: str) -> str:
    return textwrap.dedent(
        f'''
        import Foundation

        struct DownloadedEncryptedFile {{
          var data: Data
          let chunkCount: Int
          let chunkSize: Int
        }}

        enum HarnessError: Error, CustomStringConvertible {{
          case assertion(String)
          var description: String {{
            switch self {{
            case .assertion(let message): return message
            }}
          }}
        }}

        final class FileKeyHandle {{
          func decryptChunk(nonce: Data.SubSequence, ciphertext: Data.SubSequence) throws -> Data {{
            guard nonce.count == 12 else {{ throw HarnessError.assertion("nonce count \\(nonce.count) != 12") }}
            guard ciphertext.count >= 16 else {{ throw HarnessError.assertion("ciphertext too short") }}
            return Data(ciphertext.dropLast(16))
          }}
        }}

        final class MasterKeyHandle {{
          func deriveFileKey(fileId: Data) throws -> FileKeyHandle {{
            guard String(data: fileId, encoding: .utf8) == "file-1" else {{
              throw HarnessError.assertion("unexpected file id")
            }}
            return FileKeyHandle()
          }}
        }}

        enum CryptoBridge {{
          enum CryptoBridgeError: Error {{
            case decodeFailed
          }}

          static func decryptDownloadedFile(
            masterKeyHandle: MasterKeyHandle,
            fileId: String,
            encryptedFile: DownloadedEncryptedFile,
            plaintextSize: Int
          ) throws -> Data {{
        {indent(body, 4).rstrip()}
          }}
        }}

        private func encryptedChunk(_ plaintext: [UInt8], seed: UInt8) -> Data {{
          var data = Data(repeating: seed, count: 12)
          data.append(contentsOf: plaintext)
          data.append(Data(repeating: 0xEE, count: 16))
          return data
        }}

        private func encryptedFile(chunks: [[UInt8]], chunkSize: Int, declaredChunkCount: Int? = nil) -> DownloadedEncryptedFile {{
          var data = Data()
          for (index, chunk) in chunks.enumerated() {{
            data.append(encryptedChunk(chunk, seed: UInt8(index + 1)))
          }}
          return DownloadedEncryptedFile(
            data: data,
            chunkCount: declaredChunkCount ?? chunks.count,
            chunkSize: chunkSize
          )
        }}

        private var passCount = 0
        private var failCount = 0

        private func record(_ name: String, _ body: () throws -> Void) {{
          do {{
            try body()
            passCount += 1
            print("PASS \\(name)")
          }} catch {{
            failCount += 1
            print("FAIL \\(name): \\(error)")
          }}
        }}

        private func decrypt(_ encryptedFile: DownloadedEncryptedFile, plaintextSize: Int) throws -> [UInt8] {{
          let data = try CryptoBridge.decryptDownloadedFile(
            masterKeyHandle: MasterKeyHandle(),
            fileId: "file-1",
            encryptedFile: encryptedFile,
            plaintextSize: plaintextSize
          )
          return Array(data)
        }}

        record("single chunk uses full plaintext size") {{
          let file = encryptedFile(chunks: [[1, 2, 3, 4, 5]], chunkSize: 8)
          let plain = try decrypt(file, plaintextSize: 5)
          guard plain == [1, 2, 3, 4, 5] else {{ throw HarnessError.assertion("wrong plaintext \\(plain)") }}
        }}

        record("multi chunk exact multiple uses declared chunk size") {{
          let file = encryptedFile(chunks: [[1, 2, 3, 4], [5, 6, 7, 8]], chunkSize: 4)
          let plain = try decrypt(file, plaintextSize: 8)
          guard plain == [1, 2, 3, 4, 5, 6, 7, 8] else {{ throw HarnessError.assertion("wrong plaintext \\(plain)") }}
        }}

        record("multi chunk remainder sizes the last chunk from plaintextSize") {{
          let file = encryptedFile(chunks: [[10, 11, 12, 13], [14, 15]], chunkSize: 4)
          let plain = try decrypt(file, plaintextSize: 6)
          guard plain == [10, 11, 12, 13, 14, 15] else {{ throw HarnessError.assertion("wrong plaintext \\(plain)") }}
        }}

        record("declared chunk count lower than size inference still decrypts all chunks") {{
          let file = encryptedFile(chunks: [[20, 21, 22, 23], [24, 25]], chunkSize: 4, declaredChunkCount: 1)
          let plain = try decrypt(file, plaintextSize: 6)
          guard plain == [20, 21, 22, 23, 24, 25] else {{ throw HarnessError.assertion("wrong plaintext \\(plain)") }}
        }}

        record("truncated encrypted stream fails closed") {{
          var file = encryptedFile(chunks: [[1, 2, 3, 4], [5, 6]], chunkSize: 4)
          file.data.removeLast(1)
          do {{
            _ = try decrypt(file, plaintextSize: 6)
            throw HarnessError.assertion("truncated stream unexpectedly decrypted")
          }} catch CryptoBridge.CryptoBridgeError.decodeFailed {{
            return
          }}
        }}

        record("extra trailing encrypted bytes fail closed") {{
          var file = encryptedFile(chunks: [[1, 2, 3, 4]], chunkSize: 4)
          file.data.append(0x99)
          do {{
            _ = try decrypt(file, plaintextSize: 4)
            throw HarnessError.assertion("extra trailing bytes unexpectedly decrypted")
          }} catch CryptoBridge.CryptoBridgeError.decodeFailed {{
            return
          }}
        }}

        record("zero cached plaintext size rejects non-empty encrypted stream") {{
          let file = encryptedFile(chunks: [[90, 91, 92, 93]], chunkSize: 4)
          do {{
            _ = try decrypt(file, plaintextSize: 0)
            throw HarnessError.assertion("zero plaintext size unexpectedly decrypted")
          }} catch CryptoBridge.CryptoBridgeError.decodeFailed {{
            return
          }}
        }}

        print("RESULT pass=\\(passCount) fail=\\(failCount)")
        if failCount > 0 {{ exit(1) }}
        '''
    ).strip() + '\n'


def remove_final_consumed_bytes_guard(body: str) -> str:
    mutated, count = re.subn(
        r'\n\s*guard offset == encryptedFile\.data\.count else \{\n\s*throw CryptoBridgeError\.decodeFailed\n\s*\}',
        '\n    // MUTATION: final consumed-bytes guard removed',
        body,
        count=1,
    )
    if count != 1:
        raise RuntimeError('final consumed-bytes guard not found')
    return mutated


def main() -> int:
    mutate_no_final_size_check = sys.argv[1:] == ['--mutate-no-final-size-check']
    if sys.argv[1:] and not mutate_no_final_size_check:
        raise SystemExit('usage: test-file-provider-decrypt-downloaded-file.py [--mutate-no-final-size-check]')

    repo = Path.cwd()
    source_path = repo / 'targets/file-provider/CryptoBridge.swift'
    source = source_path.read_text()
    body = extract_function_body(source, 'static func decryptDownloadedFile')
    if mutate_no_final_size_check:
        body = remove_final_consumed_bytes_guard(body)
    program = build_swift(body)
    with tempfile.TemporaryDirectory(prefix='beebeeb-fp-decrypt-') as tmpdir:
        temp = Path(tmpdir) / 'DecryptDownloadedFileHarness.swift'
        temp.write_text(program)
        result = subprocess.run(['swift', str(temp)], text=True, capture_output=True)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
