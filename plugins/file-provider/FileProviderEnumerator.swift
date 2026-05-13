import FileProvider
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Enumerator")
private let kEnumeratorAppGroup = "group.io.beebeeb.shared"
private let kEnumeratorStatePrefix = "io.beebeeb.fileProvider.enumerator"

class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    enum Scope {
        case root
        case workingSet
        case empty(String)
        case folder(String)

        var logLabel: String {
            switch self {
            case .root:
                return "root"
            case .workingSet:
                return "workingSet"
            case .empty(let label):
                return label
            case .folder(let parentId):
                return parentId
            }
        }

        var cacheKey: String {
            switch self {
            case .root:
                return "root"
            case .workingSet:
                return "workingSet"
            case .empty(let label):
                return "empty.\(label)"
            case .folder(let parentId):
                return "folder.\(parentId)"
            }
        }
    }

    private let scope: Scope
    private let apiClient: FileProviderAPIClient
    private let crypto: FileProviderCrypto

    init(scope: Scope, apiClient: FileProviderAPIClient, crypto: FileProviderCrypto) {
        self.scope = scope
        self.apiClient = apiClient
        self.crypto = crypto
        super.init()
    }

    func invalidate() {}

    func enumerateItems(
        for observer: NSFileProviderEnumerationObserver,
        startingAt page: NSFileProviderPage
    ) {
        Task {
            do {
                let files = try await self.loadFilesForCurrentScope()
                logger.info("Enumerating \(files.count) items for: \(self.scope.logLabel)")
                let items = files.map { FileProviderItem(metadata: $0, crypto: crypto) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
                self.persistState(files: files)
            } catch {
                if case FileProviderAPIError.fileProviderLocked = error, case .root = self.scope {
                    observer.didEnumerate([LockedFileProviderItem()])
                    observer.finishEnumerating(upTo: nil)
                    return
                }
                logger.error("enumerateItems failed: \(error.localizedDescription)")
                observer.finishEnumeratingWithError(fileProviderError(error))
            }
        }
    }

    func enumerateChanges(
        for observer: NSFileProviderChangeObserver,
        from anchor: NSFileProviderSyncAnchor
    ) {
        Task {
            do {
                let files = try await self.loadFilesForCurrentScope()
                let items = files.map { FileProviderItem(metadata: $0, crypto: crypto) }
                let previousIds = Set(self.previousIdentifiers())
                let currentIds = Set(files.map(\.id))
                let deletedIds = previousIds.subtracting(currentIds).map {
                    NSFileProviderItemIdentifier($0)
                }

                if !items.isEmpty {
                    observer.didUpdate(items)
                }
                if !deletedIds.isEmpty {
                    observer.didDeleteItems(withIdentifiers: deletedIds)
                }

                let nextAnchor = self.anchor(for: files)
                observer.finishEnumeratingChanges(upTo: nextAnchor, moreComing: false)
                self.persistState(files: files)
                logger.info("Enumerated changes for \(self.scope.logLabel): updates=\(items.count), deletes=\(deletedIds.count)")
            } catch {
                if case FileProviderAPIError.fileProviderLocked = error, case .root = self.scope {
                    observer.didUpdate([LockedFileProviderItem()])
                    observer.finishEnumeratingChanges(upTo: self.anchor(for: []), moreComing: false)
                    return
                }
                logger.error("enumerateChanges failed: \(error.localizedDescription)")
                observer.finishEnumeratingWithError(fileProviderError(error) as NSError)
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(currentAnchor())
    }

    private func loadFilesForCurrentScope() async throws -> [FileMetadata] {
        try validateFileProviderAccess()

        switch scope {
        case .root:
            return try await apiClient.listFiles(parentId: nil)
        case .workingSet:
            return try await apiClient.listWorkingSet()
        case .empty:
            return []
        case .folder(let parentId):
            return try await apiClient.listFiles(parentId: parentId)
        }
    }

    private func currentAnchor() -> NSFileProviderSyncAnchor {
        let value = sharedDefaults()?.string(forKey: stateKey("anchor")) ?? "beebeeb-file-provider-v2:\(scope.cacheKey):initial"
        return NSFileProviderSyncAnchor(Data(value.utf8))
    }

    private func anchor(for files: [FileMetadata]) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data(anchorValue(for: files).utf8))
    }

    private func anchorValue(for files: [FileMetadata]) -> String {
        let latestUpdatedAt = files.map(\.updatedAt).max() ?? "none"
        let checksum = checksumForAnchor(files: files)
        let value = "beebeeb-file-provider-v2:\(scope.cacheKey):\(files.count):\(latestUpdatedAt):\(checksum)"
        return String(value.prefix(500))
    }

    private func persistState(files: [FileMetadata]) {
        guard let defaults = sharedDefaults() else { return }
        defaults.set(anchorValue(for: files), forKey: stateKey("anchor"))
        defaults.set(files.map(\.id), forKey: stateKey("ids"))
        defaults.synchronize()
    }

    private func previousIdentifiers() -> [String] {
        sharedDefaults()?.stringArray(forKey: stateKey("ids")) ?? []
    }

    private func stateKey(_ suffix: String) -> String {
        "\(kEnumeratorStatePrefix).\(scope.cacheKey).\(suffix)"
    }

    private func sharedDefaults() -> UserDefaults? {
        UserDefaults(suiteName: kEnumeratorAppGroup)
    }

    private func checksumForAnchor(files: [FileMetadata]) -> UInt64 {
        var hash: UInt64 = 1469598103934665603
        for file in files.sorted(by: { $0.id < $1.id }) {
            hash = fnv1a(hash, file.id)
            hash = fnv1a(hash, file.updatedAt)
            hash = fnv1a(hash, String(file.versionNumber ?? 0))
        }
        return hash
    }

    private func fnv1a(_ hash: UInt64, _ value: String) -> UInt64 {
        var result = hash
        for byte in value.utf8 {
            result ^= UInt64(byte)
            result = result &* 1099511628211
        }
        return result
    }
}
