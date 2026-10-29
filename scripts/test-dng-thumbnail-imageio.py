#!/usr/bin/env python3
"""Task 1721 hostless ImageIO harness for the real iOS DNG thumbnail body.

Extracts BeebeebCryptoModule.swift's actual generateDngThumbnail closure body at
runtime, wraps it with tiny UIImage/ThumbnailGenerator stubs, and runs the
resulting temporary Swift program against the committed DNG fixture.

Mutation mode removes kCGImageSourceThumbnailMaxPixelSize from the extracted body
only, proving the real body's dimension guard goes red without the ImageIO cap.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap


def extract_generate_dng_body(swift_source: str) -> str:
    marker = 'AsyncFunction("generateDngThumbnail")'
    marker_index = swift_source.find(marker)
    if marker_index < 0:
        raise RuntimeError(f"missing {marker}")

    signature_end_token = 'throws -> String in'
    signature_end = swift_source.find(signature_end_token, marker_index)
    if signature_end < 0:
        raise RuntimeError("generateDngThumbnail signature changed")

    open_brace = swift_source.find('{', marker_index, signature_end)
    if open_brace < 0:
        raise RuntimeError("missing generateDngThumbnail closure opening brace")

    body_start = swift_source.find('\n', signature_end)
    if body_start < 0:
        raise RuntimeError("missing newline after generateDngThumbnail signature")
    body_start += 1

    depth = 0
    in_line_comment = False
    in_block_comment = False
    in_string = False
    escape_next = False

    for index in range(open_brace, len(swift_source)):
        char = swift_source[index]
        nxt = swift_source[index + 1] if index + 1 < len(swift_source) else ''

        if in_line_comment:
            if char == '\n':
                in_line_comment = False
            continue
        if in_block_comment:
            if char == '*' and nxt == '/':
                in_block_comment = False
            continue
        if in_string:
            if escape_next:
                escape_next = False
                continue
            if char == '\\':
                escape_next = True
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
                return swift_source[body_start:index].rstrip() + '\n'

    raise RuntimeError("could not find generateDngThumbnail closure end")


def mutate_remove_max_pixel_size(body: str) -> str:
    mutated, count = re.subn(
        r'^\s*kCGImageSourceThumbnailMaxPixelSize:\s*safeMaxSize\s*,?\n',
        '',
        body,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise RuntimeError("mutation could not remove kCGImageSourceThumbnailMaxPixelSize line")
    return mutated


def indent(text: str, spaces: int) -> str:
    prefix = ' ' * spaces
    return ''.join(prefix + line if line.strip() else line for line in text.splitlines(keepends=True))


def build_swift_program(body: str) -> str:
    return textwrap.dedent(
        f'''
        import CoreGraphics
        import Foundation
        import ImageIO

        private struct UIImage {{
          let cgImage: CGImage
        }}

        private struct CapturedThumbnail {{
          let width: Int
          let height: Int
          let config: ThumbnailGenerator.Config
        }}

        private enum ThumbnailGenerator {{
          enum Config: String {{
            case small
            case medium
            case large
          }}

          private(set) static var lastCapture: CapturedThumbnail?

          static func generate(from image: UIImage, config: Config) -> Data? {{
            lastCapture = CapturedThumbnail(
              width: image.cgImage.width,
              height: image.cgImage.height,
              config: config
            )
            return Data([0x42])
          }}

          static func clear() {{
            lastCapture = nil
          }}
        }}

        private enum HarnessError: Error, CustomStringConvertible {{
          case missingFixture(String)
          case missingOutput(String)
          case missingCapture
          case assertion(String)

          var description: String {{
            switch self {{
            case .missingFixture(let path): return "missing fixture: \\(path)"
            case .missingOutput(let path): return "missing output: \\(path)"
            case .missingCapture: return "ThumbnailGenerator stub did not capture input"
            case .assertion(let message): return message
            }}
          }}
        }}

        private func fileURL(fromURI uri: String) -> URL {{
          if let url = URL(string: uri), url.isFileURL {{
            return url
          }}
          return URL(fileURLWithPath: uri)
        }}

        private func generateDngThumbnail(localUri: String, maxSize: Int) throws -> String {{
        {indent(body, 2).rstrip()}
        }}

        private struct Case {{
          let maxSize: Int
          let expectedConfig: ThumbnailGenerator.Config
        }}

        private let fixturePath = CommandLine.arguments[1]
        private let mutation = CommandLine.arguments.dropFirst().contains("--mutate-no-max-pixel-size")
        private var passCount = 0
        private var failCount = 0
        private var latencyLines: [String] = []

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

        record("fixture exists") {{
          guard FileManager.default.fileExists(atPath: fixturePath) else {{
            throw HarnessError.missingFixture(fixturePath)
          }}
        }}

        for testCase in [
          Case(maxSize: 384, expectedConfig: .small),
          Case(maxSize: 768, expectedConfig: .medium),
          Case(maxSize: 1600, expectedConfig: .large),
        ] {{
          record("sample.dng max \\(testCase.maxSize) stays capped and uses \\(testCase.expectedConfig.rawValue)") {{
            ThumbnailGenerator.clear()
            let start = DispatchTime.now().uptimeNanoseconds
            let outputPath = try generateDngThumbnail(localUri: fixturePath, maxSize: testCase.maxSize)
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            defer {{ try? FileManager.default.removeItem(atPath: outputPath) }}
            guard FileManager.default.fileExists(atPath: outputPath) else {{
              throw HarnessError.missingOutput(outputPath)
            }}
            let outputSize = ((try? FileManager.default.attributesOfItem(atPath: outputPath)[.size] as? NSNumber)?.intValue) ?? 0
            guard outputSize > 0 else {{
              throw HarnessError.assertion("output was empty")
            }}
            guard let capture = ThumbnailGenerator.lastCapture else {{
              throw HarnessError.missingCapture
            }}
            let maxDecodedDimension = max(capture.width, capture.height)
            latencyLines.append(
              "max=\\(testCase.maxSize) decoded=\\(capture.width)x\\(capture.height) config=\\(capture.config.rawValue) outputBytes=\\(outputSize) elapsedMs=\\(String(format: "%.2f", elapsedMs))"
            )
            guard maxDecodedDimension <= testCase.maxSize else {{
              throw HarnessError.assertion(
                "decoded \\(capture.width)x\\(capture.height) exceeds cap \\(testCase.maxSize)"
              )
            }}
            guard capture.config == testCase.expectedConfig else {{
              throw HarnessError.assertion(
                "config \\(capture.config.rawValue) != \\(testCase.expectedConfig.rawValue)"
              )
            }}
          }}
        }}

        record("corrupt DNG source throws") {{
          let corruptPath = NSTemporaryDirectory() + "corrupt-\\(UUID().uuidString).dng"
          try Data("not-a-dng".utf8).write(to: URL(fileURLWithPath: corruptPath))
          defer {{ try? FileManager.default.removeItem(atPath: corruptPath) }}
          do {{
            _ = try generateDngThumbnail(localUri: corruptPath, maxSize: 384)
            throw HarnessError.assertion("corrupt source unexpectedly generated a thumbnail")
          }} catch HarnessError.assertion {{
            throw HarnessError.assertion("corrupt source unexpectedly generated a thumbnail")
          }} catch {{
            return
          }}
        }}

        for line in latencyLines {{
          print("LATENCY \\(line)")
        }}
        print("RESULT pass=\\(passCount) fail=\\(failCount) mutation=\\(mutation ? "no-max-pixel-size" : "none")")
        if failCount > 0 {{
          exit(1)
        }}
        '''
    ).strip() + '\n'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mutate-no-max-pixel-size', action='store_true')
    parser.add_argument('--keep-temp', action='store_true')
    args = parser.parse_args()

    repo_root = Path.cwd()
    module_path = repo_root / 'modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'
    fixture_path = repo_root / 'e2e/fixtures/preview-matrix/raw/sample.dng'
    body = extract_generate_dng_body(module_path.read_text())
    if args.mutate_no_max_pixel_size:
      body = mutate_remove_max_pixel_size(body)
    program = build_swift_program(body)

    with tempfile.TemporaryDirectory(prefix='beebeeb-dng-imageio-') as tmpdir:
      temp_path = Path(tmpdir) / 'GeneratedDngImageIOHarness.swift'
      temp_path.write_text(program)
      command = ['swift', str(temp_path), str(fixture_path)]
      if args.mutate_no_max_pixel_size:
        command.append('--mutate-no-max-pixel-size')
      result = subprocess.run(command, text=True, capture_output=True)
      if args.keep_temp:
        kept = repo_root / '.tmp-generated-dng-imageio-harness.swift'
        kept.write_text(program)
        print(f'KEPT {kept}')
      sys.stdout.write(result.stdout)
      sys.stderr.write(result.stderr)
      return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
