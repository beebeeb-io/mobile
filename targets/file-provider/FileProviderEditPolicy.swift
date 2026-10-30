import Foundation

// SF-0002 M2a run 3 — the File Provider's write policy for an owned row.
//
// The Files app asks modifyItem to change `.contents` and/or `.filename`. For a
// row saved under an older id convention (SF-0002 UpperRepair) the content must
// never be replaced in place: the edit is kept as a NEW file (fresh lowercase
// id, the app's Keep-both name, same folder) and the original is returned
// unchanged. An unclassified row (`unknown`) takes the same safe path. A move
// is always allowed and keeps the name byte-identical.
//
// Deliberately dependency-free: the FileProviderExtension feeds it the
// classified state, and the Swift harness compiles it with swiftc only.

/// The three write states the app and the extension share.
enum FileProviderWriteState: String, Equatable {
    case writable
    case readOnly = "read_only"
    case unknown
}

enum FileProviderContentDecision: Equatable {
    /// The row is writable: the edited bytes replace the current version.
    case uploadInPlace
    /// The row must not be replaced: upload a fresh file and leave the original.
    case uploadAsCopy(fileId: String, name: String)
}

enum FileProviderEditError: Error, Equatable {
    /// The copy upload failed; the edit stays pending and Files shows an error.
    case copyUploadFailed
}

/// The two side effects a copy upload performs, injected so the policy is
/// testable without FileProvider or the network.
protocol FileProviderCopyUploading {
    func uploadCopy(source: URL, fileId: String, name: String, parentId: String?) async throws
    func signalEnumerator()
}

enum FileProviderEditPolicy {
    /// What a `.contents` change does to this row.
    static func contentDecision(
        state: FileProviderWriteState,
        originalName: String,
        deviceLabel: String,
        uuid: String = UUID().uuidString
    ) -> FileProviderContentDecision {
        switch state {
        case .writable:
            return .uploadInPlace
        case .readOnly, .unknown:
            // A fresh LOWERCASE id: the repair convention only uppercases ids,
            // so a lowercase id can never be mistaken for the damaged row.
            return .uploadAsCopy(
                fileId: uuid.lowercased(),
                name: keepBothName(originalName, deviceLabel: deviceLabel)
            )
        }
    }

    /// Rename is declined on an UpperRepair name and on a NULL convention.
    static func renameAllowed(nameConvention: String?) -> Bool {
        guard let nameConvention else { return false }
        return nameConvention == "string"
            || nameConvention == "binary"
            || nameConvention == "string_or_binary"
    }

    /// A move is allowed everywhere and never rewrites the name.
    static func moveKeepsName() -> Bool { true }

    static func nameForMove(_ original: String) -> String { original }

    /// Mirrors the app's `buildKeepBothName`: "<stem> (edited on <label>)<ext>".
    static func keepBothName(_ original: String, deviceLabel: String) -> String {
        guard let dot = original.lastIndex(of: "."), dot > original.startIndex,
              dot < original.index(before: original.endIndex) else {
            return "\(original) (edited on \(deviceLabel))"
        }
        let stem = String(original[..<dot])
        let ext = String(original[dot...])
        return "\(stem) (edited on \(deviceLabel))\(ext)"
    }

    /// Runs the copy upload, then signals the enumerator. A failure THROWS: the
    /// edit must stay pending with a visible error, never a silent decline.
    static func applyCopy(
        decision: FileProviderContentDecision,
        source: URL,
        parentId: String?,
        uploader: FileProviderCopyUploading
    ) async throws {
        guard case let .uploadAsCopy(fileId, name) = decision else { return }
        do {
            try await uploader.uploadCopy(source: source, fileId: fileId, name: name, parentId: parentId)
        } catch {
            throw FileProviderEditError.copyUploadFailed
        }
        uploader.signalEnumerator()
    }
}
