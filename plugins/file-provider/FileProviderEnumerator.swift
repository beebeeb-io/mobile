import FileProvider
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Enumerator")

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
                logger.info("Enumerating items for: \(self.scope.logLabel)")
                let files: [FileMetadata]
                switch scope {
                case .root:
                    files = try await apiClient.listFiles(parentId: nil)
                case .workingSet:
                    files = try await apiClient.listWorkingSet()
                case .empty:
                    files = []
                case .folder(let parentId):
                    files = try await apiClient.listFiles(parentId: parentId)
                }
                let items = files.map { FileProviderItem(metadata: $0, crypto: crypto) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                logger.error("enumerateItems failed: \(error.localizedDescription)")
                observer.finishEnumeratingWithError(fileProviderError(error))
            }
        }
    }

    func enumerateChanges(
        for observer: NSFileProviderChangeObserver,
        from anchor: NSFileProviderSyncAnchor
    ) {
        observer.finishEnumeratingChanges(upTo: currentAnchor(), moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(currentAnchor())
    }

    private func currentAnchor() -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data("beebeeb-file-provider-v1".utf8))
    }
}
