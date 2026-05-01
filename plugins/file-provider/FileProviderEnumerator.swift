import FileProvider
import os.log

private let logger = Logger(subsystem: "io.beebeeb.app.file-provider", category: "Enumerator")

class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    private let parentId: String?
    private let apiClient: FileProviderAPIClient
    private let crypto: FileProviderCrypto

    init(parentId: String?, apiClient: FileProviderAPIClient, crypto: FileProviderCrypto) {
        self.parentId = parentId
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
                logger.info("Enumerating items for parentId: \(self.parentId ?? "root")")
                let files = try await apiClient.listFiles(parentId: parentId)
                let items = files.map { FileProviderItem(metadata: $0, crypto: crypto) }
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch {
                logger.error("enumerateItems failed: \(error.localizedDescription)")
                observer.finishEnumeratingWithError(error)
            }
        }
    }

    func enumerateChanges(
        for observer: NSFileProviderChangeObserver,
        from anchor: NSFileProviderSyncAnchor
    ) {
        // For now, report no changes — the system will do a full re-enumeration
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let anchorData = "\(Date().timeIntervalSince1970)".data(using: .utf8) ?? Data()
        completionHandler(NSFileProviderSyncAnchor(anchorData))
    }
}
