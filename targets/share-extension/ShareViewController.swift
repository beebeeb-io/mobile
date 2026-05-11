import UIKit
import UniformTypeIdentifiers

/// Custom Share Extension view controller for "Save to Beebeeb".
///
/// Flow:
/// 1. Show minimal "Saving to Beebeeb..." UI with amber progress bar
/// 2. For each shared item: copy to App Group container
/// 3. Write an import manifest to App Group container
/// 4. Call completeRequest — the main app encrypts and uploads after vault unlock
final class ShareViewController: UIViewController {

    // MARK: - Constants

    private static let appGroup = "group.io.beebeeb.shared"

    // MARK: - UI

    private let backdropView: UIView = {
        let v = UIView()
        v.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private let card: UIView = {
        let v = UIView()
        v.backgroundColor = UIColor(red: 0.980, green: 0.973, blue: 0.961, alpha: 1)  // FAF8F5
        v.layer.cornerRadius = 20
        v.layer.shadowColor = UIColor.black.cgColor
        v.layer.shadowOpacity = 0.12
        v.layer.shadowRadius = 24
        v.layer.shadowOffset = CGSize(width: 0, height: 8)
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private let logoMark: UIView = {
        // Amber rounded square — placeholder for Beebeeb logo mark
        let v = UIView()
        v.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.047, alpha: 1)  // D97706
        v.layer.cornerRadius = 10
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private let titleLabel: UILabel = {
        let l = UILabel()
        l.text = "Saving to Beebeeb"
        l.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        l.textColor = UIColor(red: 0.102, green: 0.090, blue: 0.082, alpha: 1)  // 1A1714
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }()

    private let subtitleLabel: UILabel = {
        let l = UILabel()
        l.text = "Open Beebeeb to encrypt and upload."
        l.font = UIFont.systemFont(ofSize: 14)
        l.textColor = UIColor(red: 0.420, green: 0.380, blue: 0.341, alpha: 1)
        l.translatesAutoresizingMaskIntoConstraints = false
        return l
    }()

    private let progressTrack: UIView = {
        let v = UIView()
        v.backgroundColor = UIColor(red: 0.925, green: 0.910, blue: 0.886, alpha: 1)
        v.layer.cornerRadius = 3
        v.clipsToBounds = true
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private let progressFill: UIView = {
        let v = UIView()
        v.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.047, alpha: 1)  // D97706 amber
        v.layer.cornerRadius = 3
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private var progressFillLeading: NSLayoutConstraint?
    private var progressFillWidth: NSLayoutConstraint?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startIndeterminateProgress()
        processSharedItems()
    }

    // MARK: - UI setup

    private func setupUI() {
        view.backgroundColor = .clear

        view.addSubview(backdropView)
        view.addSubview(card)
        card.addSubview(logoMark)
        card.addSubview(titleLabel)
        card.addSubview(subtitleLabel)
        card.addSubview(progressTrack)
        progressTrack.addSubview(progressFill)

        progressFillLeading = progressFill.leadingAnchor.constraint(equalTo: progressTrack.leadingAnchor)
        progressFillWidth = progressFill.widthAnchor.constraint(equalTo: progressTrack.widthAnchor, multiplier: 0.35)

        NSLayoutConstraint.activate([
            backdropView.topAnchor.constraint(equalTo: view.topAnchor),
            backdropView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdropView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            backdropView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 300),

            logoMark.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            logoMark.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            logoMark.widthAnchor.constraint(equalToConstant: 36),
            logoMark.heightAnchor.constraint(equalToConstant: 36),

            titleLabel.centerYAnchor.constraint(equalTo: logoMark.centerYAnchor),
            titleLabel.leadingAnchor.constraint(equalTo: logoMark.trailingAnchor, constant: 12),
            titleLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),

            subtitleLabel.topAnchor.constraint(equalTo: logoMark.bottomAnchor, constant: 16),
            subtitleLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            subtitleLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),

            progressTrack.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 12),
            progressTrack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            progressTrack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
            progressTrack.heightAnchor.constraint(equalToConstant: 6),
            progressTrack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),

            progressFill.topAnchor.constraint(equalTo: progressTrack.topAnchor),
            progressFill.bottomAnchor.constraint(equalTo: progressTrack.bottomAnchor),
            progressFillLeading!,
            progressFillWidth!,
        ])
    }

    private func startIndeterminateProgress() {
        view.layoutIfNeeded()
        let trackWidth = progressTrack.bounds.width
        let fillWidth = trackWidth * 0.35

        UIView.animate(
            withDuration: 0.9,
            delay: 0,
            options: [.repeat, .autoreverse, .curveEaseInOut]
        ) {
            self.progressFillLeading?.constant = trackWidth - fillWidth
            self.view.layoutIfNeeded()
        }
    }

    // MARK: - Process shared items

    private func processSharedItems() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            finish(subtitle: "Nothing to save.")
            return
        }

        let masterKey = SharedKeychain.loadMasterKey()
        let group = DispatchGroup()
        var pendingUploads: [PendingUpload] = []
        let lock = NSLock()

        for item in items {
            for provider in item.attachments ?? [] {
                group.enter()
                handle(provider: provider, masterKey: masterKey) { upload in
                    if let upload = upload {
                        lock.lock()
                        pendingUploads.append(upload)
                        lock.unlock()
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .global(qos: .userInitiated)) {
            guard !pendingUploads.isEmpty else {
                self.finish(subtitle: "Could not read shared files.")
                return
            }
            self.enqueueUploads(pendingUploads)
        }
    }

    // MARK: - Content type handlers

    private func handle(provider: NSItemProvider, masterKey: Data?, completion: @escaping (PendingUpload?) -> Void) {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            loadFileRepresentation(provider: provider, typeID: UTType.image.identifier, masterKey: masterKey, completion: completion)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            loadFileRepresentation(provider: provider, typeID: UTType.movie.identifier, masterKey: masterKey, completion: completion)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            loadURL(provider: provider, masterKey: masterKey, completion: completion)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            loadText(provider: provider, masterKey: masterKey, completion: completion)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            loadFileRepresentation(provider: provider, typeID: UTType.data.identifier, masterKey: masterKey, completion: completion)
        } else {
            completion(nil)
        }
    }

    private func loadFileRepresentation(
        provider: NSItemProvider,
        typeID: String,
        masterKey: Data?,
        completion: @escaping (PendingUpload?) -> Void
    ) {
        provider.loadFileRepresentation(forTypeIdentifier: typeID) { url, error in
            guard let url = url else {
                completion(nil)
                return
            }
            // loadFileRepresentation URL is only valid inside this block — copy immediately
            let tmpURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(url.pathExtension)
            do {
                try FileManager.default.copyItem(at: url, to: tmpURL)
                self.stageFile(at: tmpURL, originalName: url.lastPathComponent, masterKey: masterKey, completion: completion)
            } catch {
                completion(nil)
            }
        }
    }

    private func loadURL(provider: NSItemProvider, masterKey: Data?, completion: @escaping (PendingUpload?) -> Void) {
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
            guard let url = item as? URL else {
                completion(nil)
                return
            }
            let content = url.absoluteString.data(using: .utf8) ?? Data()
            let filename = (url.host ?? "bookmark") + ".url"
            let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            do {
                try content.write(to: tmpURL)
                self.stageFile(at: tmpURL, originalName: filename, masterKey: masterKey, completion: completion)
            } catch {
                completion(nil)
            }
        }
    }

    private func loadText(provider: NSItemProvider, masterKey: Data?, completion: @escaping (PendingUpload?) -> Void) {
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
            guard let text = item as? String, let data = text.data(using: .utf8) else {
                completion(nil)
                return
            }
            let filename = "shared-\(Int(Date().timeIntervalSince1970)).txt"
            let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            do {
                try data.write(to: tmpURL)
                self.stageFile(at: tmpURL, originalName: filename, masterKey: masterKey, completion: completion)
            } catch {
                completion(nil)
            }
        }
    }

    // MARK: - Encrypt + stage

    private func stageFile(
        at srcURL: URL,
        originalName: String,
        masterKey: Data?,
        completion: @escaping (PendingUpload?) -> Void
    ) {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else {
            // App Group not provisioned — stage in process temp dir as fallback
            let upload = PendingUpload(
                fileID: UUID().uuidString,
                originalName: originalName,
                encryptedName: originalName,
                stagedURL: srcURL,
                encrypted: false,
                size: (try? srcURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map { Int64($0) } ?? 0
            )
            completion(upload)
            return
        }

        let fileID = UUID().uuidString
        let pendingDir = containerURL.appendingPathComponent("pending-uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: pendingDir, withIntermediateDirectories: true)
        let destURL = pendingDir.appendingPathComponent(fileID)

        do {
            let rawData = try Data(contentsOf: srcURL)
            var stagedData = rawData
            var encryptedName = originalName
            var encrypted = false

            if let key = masterKey {
                // Attempt encryption — throws NotLinkedError until xcframework is linked
                do {
                    stagedData = try BeebeebCryptoShim.encrypt(data: rawData, masterKey: key, fileID: fileID)
                    encryptedName = try BeebeebCryptoShim.encryptFilename(originalName, masterKey: key, fileID: fileID)
                    encrypted = true
                } catch {
                    // Crypto stubs not yet linked — fall through to plaintext staging
                    // Main app will re-encrypt on next launch before committing to server
                }
            }

            try stagedData.write(to: destURL)
            try? FileManager.default.removeItem(at: srcURL)

            completion(PendingUpload(
                fileID: fileID,
                originalName: originalName,
                encryptedName: encryptedName,
                stagedURL: destURL,
                encrypted: encrypted,
                size: Int64(stagedData.count)
            ))
        } catch {
            completion(nil)
        }
    }

    // MARK: - Upload queue + background URLSession

    private func enqueueUploads(_ uploads: [PendingUpload]) {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else {
            finish(subtitle: "Saved locally.")
            return
        }

        // Persist upload manifest — main app reads this on launch to track/retry
        let queueURL = containerURL.appendingPathComponent("upload-queue.json")
        var existing: [PendingUpload] = []
        if let data = try? Data(contentsOf: queueURL),
           let decoded = try? JSONDecoder().decode([PendingUpload].self, from: data) {
            existing = decoded
        }
        existing.append(contentsOf: uploads)
        if let encoded = try? JSONEncoder().encode(existing) {
            try? encoded.write(to: queueURL)
        }

        finish(subtitle: "Saved. Open Beebeeb to encrypt and upload.")
    }

    // MARK: - Completion

    private func finish(subtitle: String) {
        DispatchQueue.main.async {
            self.subtitleLabel.text = subtitle
            // Stop indeterminate animation, show full bar
            self.progressFill.layer.removeAllAnimations()
            self.progressFillLeading?.constant = 0
            UIView.animate(withDuration: 0.25) {
                self.progressFillWidth = self.progressFill.widthAnchor.constraint(
                    equalTo: self.progressTrack.widthAnchor, multiplier: 1.0
                )
                self.view.layoutIfNeeded()
            }

            UIView.animate(withDuration: 0.3, delay: 0.8, options: .curveEaseIn) {
                self.card.alpha = 0
                self.backdropView.alpha = 0
            } completion: { _ in
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }
}

// MARK: - PendingUpload model

struct PendingUpload: Codable {
    let fileID: String
    let originalName: String
    let encryptedName: String
    let stagedURL: URL
    let encrypted: Bool
    let size: Int64
}
