import Foundation

// SF-0002 M2a run 3: the File Provider's write/share policy for an owned row.
// Compiles with targets/file-provider/FileProviderEditPolicy.swift only.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else {
        print("FAIL: \(name)")
        exit(1)
    }
    assertions += 1
    print("PASS: \(name)")
}

/// Records what the policy asked a copy upload to do. `fails` simulates a
/// failed upload; the policy must throw and never signal the enumerator.
final class FakeUploader: FileProviderCopyUploading {
    var uploads: [(fileId: String, name: String, parentId: String?)] = []
    var signals = 0
    var fails = false
    func uploadCopy(source: URL, fileId: String, name: String, parentId: String?) async throws {
        if fails { throw NSError(domain: "test", code: 1) }
        uploads.append((fileId, name, parentId))
    }
    func signalEnumerator() { signals += 1 }
}

do {
    // ── aDeclinedFileProviderEditIsKeptAsANewFile ───────────────────────────
    let readOnly = FileProviderEditPolicy.contentDecision(
        state: .readOnly, originalName: "Report.PDF", deviceLabel: "iPhone",
        uuid: "ABCDEF01-2345-6789-ABCD-EF0123456789")
    guard case let .uploadAsCopy(fileId, name) = readOnly else {
        print("FAIL: aDeclinedFileProviderEditIsKeptAsANewFile: read_only must copy")
        exit(1)
    }
    check(fileId == "abcdef01-2345-6789-abcd-ef0123456789",
          "aDeclinedFileProviderEditIsKeptAsANewFile: fresh LOWERCASE id")
    check(name == "Report (edited on iPhone).PDF",
          "aDeclinedFileProviderEditIsKeptAsANewFile: the app's Keep-both name")

    let unknown = FileProviderEditPolicy.contentDecision(
        state: .unknown, originalName: "notes.txt", deviceLabel: "iPad",
        uuid: "11111111-2222-3333-4444-555555555555")
    guard case let .uploadAsCopy(_, unknownName) = unknown else {
        print("FAIL: aDeclinedFileProviderEditIsKeptAsANewFile: unknown must copy")
        exit(1)
    }
    check(unknownName == "notes (edited on iPad).txt",
          "aDeclinedFileProviderEditIsKeptAsANewFile: unknown copies under a unique name")
    check(FileProviderEditPolicy.contentDecision(
        state: .writable, originalName: "a.txt", deviceLabel: "iPhone", uuid: "x")
        == .uploadInPlace,
        "aDeclinedFileProviderEditIsKeptAsANewFile: writable stays in place")

    // ── aFailedCopyUploadThrowsAndKeepsTheEditPending ───────────────────────
    let failing = FakeUploader()
    failing.fails = true
    var threw = false
    do {
        try await FileProviderEditPolicy.applyCopy(
            decision: readOnly, source: URL(fileURLWithPath: "/tmp/edit"),
            parentId: "folder", uploader: failing)
    } catch FileProviderEditError.copyUploadFailed {
        threw = true
    }
    check(threw, "aFailedCopyUploadThrowsAndKeepsTheEditPending: the error surfaces")
    check(failing.signals == 0,
          "aFailedCopyUploadThrowsAndKeepsTheEditPending: a failed copy never signals")
    check(failing.uploads.isEmpty,
          "aFailedCopyUploadThrowsAndKeepsTheEditPending: nothing acknowledged")

    let succeeding = FakeUploader()
    try await FileProviderEditPolicy.applyCopy(
        decision: readOnly, source: URL(fileURLWithPath: "/tmp/edit"),
        parentId: "folder", uploader: succeeding)
    check(succeeding.uploads.count == 1 && succeeding.signals == 1,
          "aDeclinedFileProviderEditIsKeptAsANewFile: the copy upload runs once and signals")

    // ── theFileProviderDeclinesRenameOnAnUpperRepairOrUnknownName ───────────
    check(!FileProviderEditPolicy.renameAllowed(nameConvention: "upper_repair"),
          "theFileProviderDeclinesRenameOnAnUpperRepairOrUnknownName: UpperRepair name")
    check(!FileProviderEditPolicy.renameAllowed(nameConvention: nil),
          "theFileProviderDeclinesRenameOnAnUpperRepairOrUnknownName: NULL name_convention")
    check(FileProviderEditPolicy.renameAllowed(nameConvention: "string"),
          "theFileProviderDeclinesRenameOnAnUpperRepairOrUnknownName: String name")
    check(FileProviderEditPolicy.renameAllowed(nameConvention: "binary"),
          "theFileProviderDeclinesRenameOnAnUpperRepairOrUnknownName: Binary name")

    // ── theFileProviderMovesAReadOnlyItemWithItsNameByteIdentical ───────────
    check(FileProviderEditPolicy.moveKeepsName(),
          "theFileProviderMovesAReadOnlyItemWithItsNameByteIdentical: move is allowed")
    let original = "Résumé (final) 2.PDF"
    check(FileProviderEditPolicy.nameForMove(original) == original,
          "theFileProviderMovesAReadOnlyItemWithItsNameByteIdentical: name is byte-identical")
} catch {
    print("FAIL: unexpected \(error)")
    exit(1)
}

print("file-provider-owner-write-test: \(assertions) assertions, 0 failed")
