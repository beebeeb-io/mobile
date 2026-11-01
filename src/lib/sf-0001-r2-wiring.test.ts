// @ts-nocheck
/**
 * Task SF-0001 round 2 (mobile#259 review) — structural guards for the native
 * and screen wiring that the Swift harness and the api tests cannot reach:
 *
 *  - M11: the File Provider and both Share copies of `UploadItemIdEcho` are
 *    VERBATIM copies of the pod's (whose Swift test covers them all);
 *  - M3: the File Provider maps a mismatch to the dead-end error (round 3:
 *    `.cannotSynchronize`, not the `.notAuthenticated` round 2 chose);
 *  - M4: the Share sheet shows the mismatch sentence;
 *  - M5: every init mismatch abandons the REQUESTED id (File Provider, engine);
 *  - M1: the Contacts/Calendar uploader runs `BackupCreateUploadFlow`;
 *  - M6/M10: the engine echo-checks what `inspectExistingUpload` reports,
 *    recovers a finished upload only under its OWN id (round 3), abandons a
 *    foreign one, and uses the minted id after the init check;
 *  - E/D/H (round 3): a re-init mismatch abandons the requested id; Discard
 *    reaches a restarted resume; a restarting resume says so;
 *  - M2/M9: FilesScreen resumes a legacy pending row under a fresh id and
 *    falls back to a new file when an add-only member's replace is refused.
 *
 * Each check runs on the real source (must pass) AND on an in-memory mutation
 * that undoes the fix (must fail).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pod = read('modules/beebeeb-crypto/ios/UploadItemIdEcho.swift');
const fileProvider = read('targets/file-provider/FileProviderExtension.swift');
const fpApi = read('targets/file-provider/ApiClient.swift');
const shareUploader = read('targets/share-extension/ShareUploader.swift');
const shareUploaderMirror = read('ios/BeebeebShare/ShareUploader.swift');
const shareVC = read('targets/share-extension/ShareViewController.swift');
const shareVCMirror = read('ios/BeebeebShare/ShareViewController.swift');
const engine = read('modules/beebeeb-crypto/ios/NativeBackupEngine.swift');
const uploader = read('modules/beebeeb-crypto/ios/NativeEncryptedBackupUploader.swift');
const filesScreen = read('src/screens/FilesScreen.tsx');

/** The `enum UploadItemIdEcho { ... }` block, each line's indentation removed. */
function echoEnum(src: string): string {
  const at = src.indexOf('enum UploadItemIdEcho {');
  if (at < 0) throw new Error('UploadItemIdEcho not found');
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1).split('\n').map((l) => l.trim()).join('\n');
    }
  }
  throw new Error('unbalanced UploadItemIdEcho');
}

/** The `{ ... }` body after `marker` (brace matched), `//` comments stripped. */
function body(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const inMarker = marker.lastIndexOf('{');
  const open = inMarker >= 0 ? at + inMarker : src.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i).replace(/\/\/[^\n]*/g, '');
    }
  }
  throw new Error(`unbalanced after: ${marker}`);
}

function inOrder(hay: string, needles: string[]): boolean {
  let at = -1;
  for (const n of needles) {
    const next = hay.indexOf(n, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

function guarded(name: string, source: string, check: (s: string) => boolean, mutate: (s: string) => string) {
  test(name, () => {
    expect(check(source)).toBe(true);
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    let mutatedPasses: boolean;
    try {
      mutatedPasses = check(mutated);
    } catch {
      mutatedPasses = false;
    }
    expect({ name, mutatedPasses }).toEqual({ name, mutatedPasses: false });
  });
}

describe('M11: one UploadItemIdEcho, copied verbatim into each extension', () => {
  for (const [label, src] of [
    ['File Provider', fileProvider],
    ['Share (canonical)', shareUploader],
    ['Share (regenerated copy)', shareUploaderMirror],
  ] as const) {
    guarded(
      `${label} copy equals the pod's (the pod's Swift test covers it)`,
      src,
      (s) => echoEnum(s) === echoEnum(pod),
      (s) => s.replace('struct Mismatch: LocalizedError, Equatable {', 'struct Mismatch: Error, Equatable {'),
    );
  }
  test('the regenerated Share copies match the canonical ones', () => {
    expect(shareUploaderMirror).toBe(shareUploader);
    expect(shareVCMirror).toBe(shareVC);
  });
});

describe('M3/M4/M5: the extensions', () => {
  // Round 3: M3's premise was wrong — `signalErrorResolved` retries only
  // notAuthenticated / insufficientQuota / serverUnreachable (Apple), and
  // `.notAuthenticated` shows a false "Authentication Required" alert. The
  // dead end is `.cannotSynchronize`, carrying the honest sentence.
  guarded(
    'M3 (round 3): the File Provider maps a mismatch to .cannotSynchronize with the mismatch sentence, never .notAuthenticated',
    fileProvider,
    (s) => /if let mismatch = error as\? UploadItemIdEcho\.Mismatch \{\s*return NSFileProviderError\(\s*\.cannotSynchronize,\s*userInfo: \[NSLocalizedDescriptionKey: mismatch\.errorDescription \?\? UploadItemIdEcho\.message\]\s*\)\s*\}/.test(body(s, 'static func mapError(_ error: Error) -> Error {')),
    (s) => s.replace(/(if let mismatch = error as\? UploadItemIdEcho\.Mismatch \{\s*return NSFileProviderError\(\s*)\.cannotSynchronize/, '$1.notAuthenticated'),
  );
  guarded(
    'M5: a File Provider init mismatch abandons the requested id, then throws',
    fileProvider,
    (s) => inOrder(s, [
      'try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: session.file_id)',
      'await ApiClient.shared.abandonUploadBestEffort(fileId: fileId, expectedUser: expectedUser)',
      'throw error',
    ]) && /func abandonUploadBestEffort\(fileId: String, expectedUser: String\?\) async \{/.test(fpApi),
    (s) => s.replace('      await ApiClient.shared.abandonUploadBestEffort(fileId: fileId, expectedUser: expectedUser)\n', ''),
  );
  guarded(
    'M6: the File Provider completion check is the completion stage',
    fileProvider,
    (s) => s.includes('try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: completed.id, stage: .completion)'),
    (s) => s.replace('echoed: completed.id, stage: .completion)', 'echoed: completed.id)'),
  );
  guarded(
    'M4: the Share sheet shows the mismatch sentence instead of "please try again"',
    shareVC,
    (s) => inOrder(s, ['} catch let mismatch as UploadItemIdEcho.Mismatch {', 'self.showError(mismatch.errorDescription ?? UploadItemIdEcho.message)', '} catch {']),
    (s) => s.replace('} catch let mismatch as UploadItemIdEcho.Mismatch {', '} catch let mismatch as NSError {'),
  );
});

describe('M1: the Contacts/Calendar uploader runs the checked flow', () => {
  guarded(
    'performUpload is BackupCreateUploadFlow, its PUTs and complete go to the flow destination',
    uploader,
    (s) => {
      const b = body(s, 'private func performUpload(');
      return (
        b.includes('let flow = BackupCreateUploadFlow(') &&
        b.includes('return try flow.run()') &&
        b.includes('serverFileId: destination,') &&
        !/serverFileId: serverFileId/.test(b) &&
        !/\["file_id"\]/.test(s)
      );
    },
    // round 1's shape: the answer's id as the destination
    (s) => s.replace('          serverFileId: destination,\n', '          serverFileId: serverFileId,\n'),
  );
});

describe('M5/M6/M10: the backup engine', () => {
  guarded(
    'M5: an init mismatch abandons the requested id; M10: the minted id after the check',
    engine,
    (s) => inOrder(s, [
      'try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: session.fileId)',
      'await abandonUpload(fileId: fileId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)',
      'throw error',
      'serverFileId = fileId',
    ]) && !/serverFileId = session\.fileId/.test(s),
    (s) => s.replace('      serverFileId = fileId\n', '      serverFileId = session.fileId\n'),
  );
  guarded(
    'M6: inspectExistingUpload echo-checks the file it reports on',
    engine,
    (s) => {
      const b = body(s, 'private func inspectExistingUpload(');
      return inOrder(b, ['let state = try PhotoBackupServerResponses.existingUpload(', 'if state != .gone {', 'try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: body?["id"] as? String, stage: .completion)', 'return state']);
    },
    (s) => s.replace('        try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: body?["id"] as? String, stage: .completion)\n', ''),
  );
  // Round 3: the finished-upload recovery is ONLY for our own id (a lost
  // session). A foreign id holds bytes sealed under `fileId` that no reader
  // can open: recording it would end the retries on a backup that does not
  // exist (data loss). It is abandoned and staged again.
  const m10 = [
    '} else if let existing = asset.remoteFileId, !existing.isEmpty {',
    'if existing == fileId,',
    'try await Self.isFinishedUpload(inspectExistingUpload(fileId: existing, authToken: authToken, baseURL: baseURL)) {',
    'markUploadComplete(assetId: asset.localAssetId, remoteFileId: existing, accountId: batchAccountId)',
    'generateAndUploadThumbnail(',
    'return true',
    'await abandonUpload(fileId: existing, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)',
  ];
  guarded(
    'M10 (round 3): only our own id with a lost session is recovered as finished; a foreign id never is',
    engine,
    (s) => inOrder(s, m10),
    (s) => s.replace('      if existing == fileId,\n         try await Self.isFinishedUpload(', '      if try await Self.isFinishedUpload('),
  );
  guarded(
    'M10 (round 3): the recovery checks for a finished upload before abandoning',
    engine,
    (s) => inOrder(s, m10),
    (s) => s.replace('try await Self.isFinishedUpload(inspectExistingUpload(fileId: existing, authToken: authToken, baseURL: baseURL)) {', 'false {'),
  );
  guarded(
    'M10 (round 3): the recovery generates the thumbnails, as the resume path does',
    engine,
    (s) => inOrder(s, m10),
    (s) => {
      const at = s.indexOf('RuntimeTrace.event("backup.native.upload.pre_update_complete_recorded")');
      const thumb = s.indexOf('generateAndUploadThumbnail(', at);
      return s.slice(0, thumb) + 'skippedThumbnail(' + s.slice(thumb + 'generateAndUploadThumbnail('.length);
    },
  );
  guarded(
    'M10 (round 3): a trashed finished upload counts as finished, as on the resume path',
    engine,
    (s) => /case \.complete, \.completeInTrash: return true/.test(body(s, 'static func isFinishedUpload(')),
    (s) => s.replace('case .complete, .completeInTrash: return true', 'case .complete: return true'),
  );
  guarded(
    'E (round 3): a swept-session re-init that names another item abandons the requested id',
    engine,
    (s) => inOrder(s, [
      'guard reinitSession.fileId == fileId else {',
      'await abandonUpload(fileId: fileId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId)',
      'throw BackupError.reinitFileIdMismatch',
    ]),
    (s) => s.replace(/(guard reinitSession\.fileId == fileId else \{[\s\S]*?)        await abandonUpload\(fileId: fileId, authToken: authToken, baseURL: baseURL, accountId: batchAccountId\)\n/, '$1'),
  );
  guarded(
    'M6: the engine completion check is the completion stage',
    engine,
    (s) => /echoed: \(echoedId\?\["id"\] as\? String\),\s*stage: \.completion/.test(s),
    (s) => s.replace(/echoed: \(echoedId\?\["id"\] as\? String\),\s*stage: \.completion/, 'echoed: (echoedId?["id"] as? String)'),
  );
});

describe('M2/M9: FilesScreen', () => {
  guarded(
    'M2: a pending row resumes under resumeUploadFileId (a legacy pointer restarts under a fresh id)',
    filesScreen,
    (s) => {
      const b = body(s, 'const resumePendingUpload = useCallback(async (file: FileEntry, info: UploadResumeInfo) => {');
      return b.includes('const target = await resumeUploadFileId(info, generateFileId);') && b.includes('fileId: target.fileId,') && !b.includes('fileId: file.id,');
    },
    (s) => s.replace('          fileId: target.fileId,\n          signal: restartedAbort,', '          fileId: file.id,\n          signal: restartedAbort,'),
  );
  guarded(
    'D (round 3): Discard on the old row stops a restarted resume (its abort is registered under the old id too)',
    filesScreen,
    (s) => {
      const b = body(s, 'const resumePendingUpload = useCallback(async (file: FileEntry, info: UploadResumeInfo) => {');
      return inOrder(b, [
        'const restartedAbort = target.restarted ? registerUploadAbort(file.id) : undefined;',
        'signal: restartedAbort,',
        'settleUploadSignal(file.id, restartedAbort);',
      ]);
    },
    (s) => s.replace('          signal: restartedAbort,\n', ''),
  );
  guarded(
    'H (round 3): a restarting resume says it starts over; only a self-minted one promises the stored parts',
    filesScreen,
    (s) => inOrder(body(s, 'const handlePendingUpload = useCallback(async (file: FileEntry) => {'), [
      "? resumeInfo!.selfMinted === true",
      'Resume continues the upload with the parts that were already stored.',
      'Resume uploads it again from the start.',
    ]),
    (s) => s.replace('Resume uploads it again from the start.', 'Resume continues the upload with the parts that were already stored.'),
  );
  guarded(
    'M9: both overwrite paths fall back to a new file on an add-only refusal',
    filesScreen,
    (s) =>
      (s.match(/uploadReplacingOrAdding\(replacingExistingId, (?:uploadFileId|fileId), generateFileId, \(targetFileId, replacing\) => encryptedUpload\(\{/g) ?? []).length === 2 &&
      (s.match(/v2InitNameEncrypted: replacing \? v2InitNameEncrypted : undefined,/g) ?? []).length === 2 &&
      (s.match(/replacingExistingId = (?:existingFile\.id|decision\.existingId);/g) ?? []).length === 2,
    (s) => s.replace('          replacingExistingId = decision.existingId;\n', ''),
  );
});
