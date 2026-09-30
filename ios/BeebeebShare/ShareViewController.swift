import UIKit
import UniformTypeIdentifiers

/// Share Extension view controller for "Save to Beebeeb".
///
/// Flow:
/// 1. Load master key via SharedKeychain (triggers Face ID if needed)
/// 2. If no key → show "Unlock Beebeeb to save files" + OK button → dismiss
/// 3. If no session token → show "Sign in to Beebeeb first" + OK button → dismiss
/// 4. Fetch top-level folders from API
/// 5. Show file preview + folder picker (recents + all folders)
/// 6. On Save → encrypt (or stage) → upload → show result → dismiss
final class ShareViewController: UIViewController {

    // MARK: - Constants

    // App Group UserDefaults is still used for `recentFoldersKey` (recent
    // folder ids/names — no secret material). The session token and API
    // base URL moved to the shared Keychain in task 0447; this extension
    // read them from these two UserDefaults keys until task 1671 — dead
    // reads the main app had stopped writing to, which is why "Save to
    // Beebeeb" always showed "Sign in to Beebeeb first" even right after a
    // successful Face ID unlock. See `loadSharedConfig()` below.
    private static let appGroup = "group.io.beebeeb.shared"
    private static let recentFoldersKey = "beebeeb_share_recent_folders"
    private static let defaultApiUrl = "https://api.beebeeb.io"

    // MARK: - Colors (dark theme)

    private static let bgColor = UIColor(red: 0.102, green: 0.090, blue: 0.078, alpha: 1)        // #1A1714
    private static let cardColor = UIColor(red: 0.141, green: 0.125, blue: 0.110, alpha: 1)       // #241F1C
    private static let surfaceColor = UIColor(red: 0.180, green: 0.160, blue: 0.141, alpha: 1)    // #2E2924
    private static let amberColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 1)      // #D97706
    private static let textPrimary = UIColor.white
    private static let textSecondary = UIColor(white: 0.6, alpha: 1)
    private static let textTertiary = UIColor(white: 0.4, alpha: 1)

    // MARK: - State

    private var masterKeyHandle: MasterKeyHandle?
    /// Task 1594 round 5: the SAME owner value `keyOwnershipVerified()`
    /// already checked (captured once here rather than re-reading the
    /// keychain in `saveTapped()`), threaded into `ShareUploader` as
    /// `X-Beebeeb-Expected-User`. `nil` whenever `keyOwnershipVerified()`
    /// was false — the two must always agree.
    private var verifiedKeyOwnerId: String?
    private var sessionToken: String?
    private var apiUrl: String = defaultApiUrl
    private var folders: [FolderFetcher.Folder] = []
    private var recentFolders: [RecentFolder] = []
    private var selectedFolderId: String? = nil
    private var fileName: String = "File"
    private var fileSize: Int64 = 0
    /// Small in-memory shares (text / URL items). nil for file shares, which use
    /// `fileURL` and stream-encrypt from disk (task 0673).
    private var fileData: Data?
    /// Stable on-disk copy of a shared file, staged in the extension container so
    /// it can be stream-encrypted later without reading the whole file into RAM.
    /// Cleaned up after the upload completes.
    private var fileURL: URL?

    // MARK: - UI Elements

    private let containerView = UIView()
    private let headerView = UIView()
    private let fileIconView = UIView()
    private let fileNameLabel = UILabel()
    private let fileSizeLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .grouped)
    private let bottomBar = UIView()
    private let cancelButton = UIButton(type: .system)
    private let saveButton = UIButton(type: .system)
    private let progressOverlay = UIView()
    private let progressBar = UIView()
    private let progressFill = UIView()
    private let progressLabel = UILabel()

    private var progressFillWidthConstraint: NSLayoutConstraint?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        loadSharedConfig()
        setupContainerUI()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        performSetup()
    }

    // MARK: - Setup

    /// Task 1594 round 2 (F3/F6): `true` only when the vault key's proven
    /// owner (mirrored by `BeebeebCryptoModule.mirrorKeyOwner`) matches the
    /// currently signed-in user (`mirrorSessionUserId`) — both in the shared
    /// keychain, both written by the MAIN APP ONLY. Either being absent, or
    /// the two disagreeing, refuses: this extension is single-shot per
    /// invocation (no persistent cache to invalidate, unlike the File
    /// Provider's `FileProviderExtension`).
    private static func keyOwnershipVerified() -> Bool {
        guard let owner = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.masterKeyOwnerKey),
              !owner.isEmpty else { return false }
        guard let signedInUser = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.sessionUserIdKey),
              !signedInUser.isEmpty else { return false }
        return owner == signedInUser
    }

    /// Task 1671: the session token + API base URL live in the shared
    /// Keychain (`BeebeebKeychainCore`), written by the main app's
    /// `mirrorSessionToAppGroup` — NOT in App Group UserDefaults. No
    /// plaintext UserDefaults fallback here: task 0447 removed that storage
    /// path for security, on purpose. `BeebeebKeychainCore.loadString`
    /// already owns the one-time legacy-UserDefaults-to-Keychain migration
    /// (same helper the main app and File Provider use) — this reader must
    /// not re-implement a separate UserDefaults read next to it.
    private func loadSharedConfig() {
        sessionToken = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.sessionTokenKey)
        if let url = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.apiBaseUrlKey), !url.isEmpty {
            apiUrl = url
        }
        loadRecentFolders()
    }

    private func performSetup() {
        // Step 1: Check for master key (may trigger Face ID via the primary
        // SE key if the extension SE key is unavailable).
        // `.extensionThenPrimary` preserves the SharedKeychain.loadMasterKey()
        // contract (task 0436).
        // Load the raw master-key bytes, immediately wrap them in an opaque
        // MasterKeyHandle, and zero the bytes — raw key material never lives in
        // this controller beyond this scope, and never crosses into
        // ShareUploader (task 0673 key hygiene).
        //
        // Task 1594 round 2 (F3): only do this once ownership is confirmed —
        // the owner record (`BeebeebCryptoModule.mirrorKeyOwner`) must match
        // the currently signed-in user (`mirrorSessionUserId`), both mirrored
        // by the main app into the SAME shared keychain access group +
        // accessibility as the key itself (F6). Before this fix, "Save to
        // Beebeeb" would happily encrypt + upload a shared file under
        // WHATEVER key sat in the keychain, with no check that it belonged to
        // the signed-in account — the same bug class as the original 1594
        // report, reachable from the share sheet.
        if Self.keyOwnershipVerified(), var keyBytes = BeebeebKeychainCore.loadMasterKey(
            label: "io.beebeeb.master-key",
            mode: .extensionThenPrimary
        ) {
            defer { keyBytes.resetBytes(in: 0..<keyBytes.count) }
            masterKeyHandle = try? MasterKeyHandle.fromKeychainBytes(bytes: keyBytes)
            // Task 1594 round 5: capture the verified owner alongside the key
            // itself — `keyOwnershipVerified()` already proved this equals
            // the signed-in user, so it's safe to send as
            // `X-Beebeeb-Expected-User` on every upload request.
            verifiedKeyOwnerId = BeebeebKeychainCore.loadString(key: BeebeebKeychainCore.masterKeyOwnerKey)
        }

        guard masterKeyHandle != nil else {
            showError("Unlock Beebeeb to save files")
            return
        }

        // Step 2: Check for session token
        guard let token = sessionToken, !token.isEmpty else {
            showError("Sign in to Beebeeb first")
            return
        }

        // Step 3: Extract shared content
        extractSharedContent { [weak self] success in
            guard let self = self, success else {
                self?.showError("Could not read shared content")
                return
            }

            // Step 4: Fetch folders and show picker
            self.fetchFolders(token: token)
        }
    }

    // MARK: - Content Extraction

    private func extractSharedContent(completion: @escaping (Bool) -> Void) {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem],
              let firstItem = items.first,
              let provider = firstItem.attachments?.first else {
            completion(false)
            return
        }

        let typeOrder: [UTType] = [.image, .movie, .pdf, .data, .url, .plainText]

        func tryLoad(index: Int) {
            guard index < typeOrder.count else {
                completion(false)
                return
            }
            let type = typeOrder[index]
            if provider.hasItemConformingToTypeIdentifier(type.identifier) {
                loadProvider(provider, typeID: type.identifier, completion: completion)
            } else {
                tryLoad(index: index + 1)
            }
        }

        tryLoad(index: 0)
    }

    private func loadProvider(_ provider: NSItemProvider, typeID: String, completion: @escaping (Bool) -> Void) {
        if typeID == UTType.url.identifier {
            provider.loadItem(forTypeIdentifier: typeID, options: nil) { [weak self] item, _ in
                guard let self = self, let url = item as? URL else {
                    DispatchQueue.main.async { completion(false) }
                    return
                }
                let content = url.absoluteString.data(using: .utf8) ?? Data()
                self.fileName = (url.host ?? "bookmark") + ".url"
                self.fileSize = Int64(content.count)
                self.fileData = content
                DispatchQueue.main.async {
                    self.updateFilePreview()
                    completion(true)
                }
            }
        } else if typeID == UTType.plainText.identifier {
            provider.loadItem(forTypeIdentifier: typeID, options: nil) { [weak self] item, _ in
                guard let self = self, let text = item as? String else {
                    DispatchQueue.main.async { completion(false) }
                    return
                }
                let data = text.data(using: .utf8) ?? Data()
                self.fileName = "shared-\(Int(Date().timeIntervalSince1970)).txt"
                self.fileSize = Int64(data.count)
                self.fileData = data
                DispatchQueue.main.async {
                    self.updateFilePreview()
                    completion(true)
                }
            }
        } else {
            provider.loadFileRepresentation(forTypeIdentifier: typeID) { [weak self] url, error in
                guard let self = self, let url = url else {
                    DispatchQueue.main.async { completion(false) }
                    return
                }
                // The provided URL is valid only inside this callback. Copy it to
                // a stable temp file in the extension container (disk-to-disk,
                // bounded memory) so the upload can stream-encrypt it later
                // without reading the whole file into RAM (task 0673).
                do {
                    let stableURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent("share-\(UUID().uuidString)")
                        .appendingPathExtension(url.pathExtension)
                    try? FileManager.default.removeItem(at: stableURL)
                    try FileManager.default.copyItem(at: url, to: stableURL)
                    let size = (try? stableURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                    self.fileName = url.lastPathComponent
                    self.fileSize = Int64(size)
                    self.fileURL = stableURL
                    self.fileData = nil
                    DispatchQueue.main.async {
                        self.updateFilePreview()
                        completion(true)
                    }
                } catch {
                    DispatchQueue.main.async { completion(false) }
                }
            }
        }
    }

    // MARK: - Folder Fetching

    private func fetchFolders(token: String) {
        Task {
            let fetcher = FolderFetcher(sessionToken: token, apiUrl: apiUrl)
            do {
                let fetched = try await fetcher.fetchTopLevelFolders()
                await MainActor.run {
                    self.folders = fetched
                    self.selectDefaultFolder()
                    self.showFolderPicker()
                }
            } catch {
                await MainActor.run {
                    // Show picker anyway with just recents (or empty)
                    self.selectDefaultFolder()
                    self.showFolderPicker()
                }
            }
        }
    }

    private func selectDefaultFolder() {
        if let recent = recentFolders.first {
            selectedFolderId = recent.id
        } else if let first = folders.first {
            selectedFolderId = first.id
        }
        // nil = root (All Files)
    }

    // MARK: - UI Setup

    private func setupContainerUI() {
        containerView.backgroundColor = Self.bgColor
        containerView.layer.cornerRadius = 16
        containerView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        containerView.clipsToBounds = true
        containerView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(containerView)

        NSLayoutConstraint.activate([
            containerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            containerView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            containerView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            containerView.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.65),
        ])

        setupHeader()
        setupTableView()
        setupBottomBar()
        setupProgressOverlay()
    }

    private func setupHeader() {
        headerView.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(headerView)

        // File icon
        fileIconView.backgroundColor = Self.surfaceColor
        fileIconView.layer.cornerRadius = 8
        fileIconView.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(fileIconView)

        let iconLabel = UILabel()
        iconLabel.text = "F"
        iconLabel.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        iconLabel.textColor = Self.amberColor
        iconLabel.textAlignment = .center
        iconLabel.translatesAutoresizingMaskIntoConstraints = false
        fileIconView.addSubview(iconLabel)

        // File name
        fileNameLabel.text = fileName
        fileNameLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
        fileNameLabel.textColor = Self.textPrimary
        fileNameLabel.lineBreakMode = .byTruncatingMiddle
        fileNameLabel.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(fileNameLabel)

        // File size — unknown until `extractSharedContent` runs (step 3 of
        // `performSetup`, after the master-key + session-token gates).
        // `updateFilePreview()` fills in the real size once extraction
        // completes; showing `formatFileSize(fileSize)` here (fileSize == 0
        // at this point) rendered a fake "0 B" — visible both briefly on
        // every share, and indefinitely whenever setup stops at an earlier
        // gate (task 1671: showError() leaves headerView on screen, so a
        // "Sign in to Beebeeb first" error was shown next to a lying "0 B").
        fileSizeLabel.text = "Preparing…"
        fileSizeLabel.font = UIFont.systemFont(ofSize: 13)
        fileSizeLabel.textColor = Self.textSecondary
        fileSizeLabel.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(fileSizeLabel)

        NSLayoutConstraint.activate([
            headerView.topAnchor.constraint(equalTo: containerView.topAnchor),
            headerView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            headerView.heightAnchor.constraint(equalToConstant: 72),

            fileIconView.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 20),
            fileIconView.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            fileIconView.widthAnchor.constraint(equalToConstant: 40),
            fileIconView.heightAnchor.constraint(equalToConstant: 40),

            iconLabel.centerXAnchor.constraint(equalTo: fileIconView.centerXAnchor),
            iconLabel.centerYAnchor.constraint(equalTo: fileIconView.centerYAnchor),

            fileNameLabel.leadingAnchor.constraint(equalTo: fileIconView.trailingAnchor, constant: 12),
            fileNameLabel.trailingAnchor.constraint(equalTo: headerView.trailingAnchor, constant: -20),
            fileNameLabel.topAnchor.constraint(equalTo: headerView.topAnchor, constant: 18),

            fileSizeLabel.leadingAnchor.constraint(equalTo: fileNameLabel.leadingAnchor),
            fileSizeLabel.topAnchor.constraint(equalTo: fileNameLabel.bottomAnchor, constant: 2),
        ])
    }

    private func setupTableView() {
        tableView.backgroundColor = .clear
        tableView.separatorStyle = .none
        tableView.delegate = self
        tableView.dataSource = self
        tableView.register(FolderCell.self, forCellReuseIdentifier: FolderCell.reuseID)
        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.isHidden = true
        containerView.addSubview(tableView)

        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: containerView.bottomAnchor, constant: -60),
        ])
    }

    private func setupBottomBar() {
        bottomBar.backgroundColor = Self.cardColor
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(bottomBar)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.setTitleColor(Self.textSecondary, for: .normal)
        cancelButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .medium)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.addSubview(cancelButton)

        saveButton.setTitle("Save", for: .normal)
        saveButton.setTitleColor(Self.bgColor, for: .normal)
        saveButton.backgroundColor = Self.amberColor
        saveButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
        saveButton.layer.cornerRadius = 8
        saveButton.translatesAutoresizingMaskIntoConstraints = false
        saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)
        bottomBar.addSubview(saveButton)

        bottomBar.isHidden = true

        NSLayoutConstraint.activate([
            bottomBar.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
            bottomBar.heightAnchor.constraint(equalToConstant: 60),

            cancelButton.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: 20),
            cancelButton.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),

            saveButton.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -20),
            saveButton.centerYAnchor.constraint(equalTo: bottomBar.centerYAnchor),
            saveButton.widthAnchor.constraint(equalToConstant: 80),
            saveButton.heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    private func setupProgressOverlay() {
        progressOverlay.backgroundColor = Self.bgColor
        progressOverlay.isHidden = true
        progressOverlay.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(progressOverlay)

        progressBar.backgroundColor = Self.surfaceColor
        progressBar.layer.cornerRadius = 3
        progressBar.clipsToBounds = true
        progressBar.translatesAutoresizingMaskIntoConstraints = false
        progressOverlay.addSubview(progressBar)

        progressFill.backgroundColor = Self.amberColor
        progressFill.layer.cornerRadius = 3
        progressFill.translatesAutoresizingMaskIntoConstraints = false
        progressBar.addSubview(progressFill)

        progressLabel.text = "Saving..."
        progressLabel.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        progressLabel.textColor = Self.textPrimary
        progressLabel.textAlignment = .center
        progressLabel.translatesAutoresizingMaskIntoConstraints = false
        progressOverlay.addSubview(progressLabel)

        progressFillWidthConstraint = progressFill.widthAnchor.constraint(equalToConstant: 0)

        NSLayoutConstraint.activate([
            progressOverlay.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            progressOverlay.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            progressOverlay.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            progressOverlay.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),

            progressLabel.centerXAnchor.constraint(equalTo: progressOverlay.centerXAnchor),
            progressLabel.centerYAnchor.constraint(equalTo: progressOverlay.centerYAnchor, constant: -20),

            progressBar.topAnchor.constraint(equalTo: progressLabel.bottomAnchor, constant: 16),
            progressBar.leadingAnchor.constraint(equalTo: progressOverlay.leadingAnchor, constant: 40),
            progressBar.trailingAnchor.constraint(equalTo: progressOverlay.trailingAnchor, constant: -40),
            progressBar.heightAnchor.constraint(equalToConstant: 6),

            progressFill.topAnchor.constraint(equalTo: progressBar.topAnchor),
            progressFill.bottomAnchor.constraint(equalTo: progressBar.bottomAnchor),
            progressFill.leadingAnchor.constraint(equalTo: progressBar.leadingAnchor),
            progressFillWidthConstraint!,
        ])
    }

    // MARK: - Show States

    private func showError(_ message: String) {
        DispatchQueue.main.async {
            // Task 1671: hide the file-preview header too. It's only ever
            // meaningful once extraction (step 3 of `performSetup`) has run;
            // every error path here fires at or before step 2, so the name/
            // size it would show is still the placeholder — showing it next
            // to "Sign in to Beebeeb first" read as "this 0-byte file failed
            // to sign in", not "we haven't looked at the file yet".
            self.headerView.isHidden = true
            self.tableView.isHidden = true
            self.bottomBar.isHidden = true

            let errorLabel = UILabel()
            errorLabel.text = message
            errorLabel.font = UIFont.systemFont(ofSize: 16, weight: .medium)
            errorLabel.textColor = Self.textPrimary
            errorLabel.textAlignment = .center
            errorLabel.numberOfLines = 0
            errorLabel.translatesAutoresizingMaskIntoConstraints = false
            self.containerView.addSubview(errorLabel)

            let okButton = UIButton(type: .system)
            okButton.setTitle("OK", for: .normal)
            okButton.setTitleColor(Self.amberColor, for: .normal)
            okButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
            okButton.addTarget(self, action: #selector(self.cancelTapped), for: .touchUpInside)
            okButton.translatesAutoresizingMaskIntoConstraints = false
            self.containerView.addSubview(okButton)

            NSLayoutConstraint.activate([
                errorLabel.centerXAnchor.constraint(equalTo: self.containerView.centerXAnchor),
                errorLabel.centerYAnchor.constraint(equalTo: self.containerView.centerYAnchor, constant: -20),
                errorLabel.leadingAnchor.constraint(equalTo: self.containerView.leadingAnchor, constant: 32),
                errorLabel.trailingAnchor.constraint(equalTo: self.containerView.trailingAnchor, constant: -32),

                okButton.centerXAnchor.constraint(equalTo: self.containerView.centerXAnchor),
                okButton.topAnchor.constraint(equalTo: errorLabel.bottomAnchor, constant: 20),
            ])
        }
    }

    private func showFolderPicker() {
        tableView.isHidden = false
        bottomBar.isHidden = false
        tableView.reloadData()
    }

    private func showProgress() {
        tableView.isHidden = true
        bottomBar.isHidden = true
        progressOverlay.isHidden = false
    }

    private func updateProgress(fraction: Float, message: String) {
        DispatchQueue.main.async {
            self.progressLabel.text = message
            let barWidth = self.progressBar.bounds.width
            self.progressFillWidthConstraint?.constant = CGFloat(fraction) * barWidth
            UIView.animate(withDuration: 0.2) {
                self.progressOverlay.layoutIfNeeded()
            }
        }
    }

    private func updateFilePreview() {
        fileNameLabel.text = fileName
        fileSizeLabel.text = formatFileSize(fileSize)
    }

    // MARK: - Actions

    @objc private func cancelTapped() {
        extensionContext?.cancelRequest(withError: NSError(
            domain: "io.beebeeb.share", code: 0,
            userInfo: [NSLocalizedDescriptionKey: "User cancelled"]
        ))
    }

    @objc private func saveTapped() {
        guard let handle = masterKeyHandle else {
            showError("Unlock Beebeeb to save files")
            return
        }
        guard fileURL != nil || fileData != nil else {
            showError("Could not read file")
            return
        }

        guard let token = sessionToken, !token.isEmpty else {
            showError("Sign in to Beebeeb first")
            return
        }

        showProgress()

        let stagedURL = fileURL
        let inMemoryData = fileData
        let name = fileName
        let parent = selectedFolderId

        Task {
            let uploader = ShareUploader(apiUrl: apiUrl, sessionToken: token, masterKey: handle, expectedUser: self.verifiedKeyOwnerId)
            // Clean up the staged temp file in all paths (success / failure / cancel).
            defer {
                if let stagedURL {
                    try? FileManager.default.removeItem(at: stagedURL)
                }
            }

            do {
                let result: ShareUploader.UploadResult
                if let stagedURL {
                    result = try await uploader.uploadFile(
                        at: stagedURL,
                        fileName: name,
                        parentId: parent,
                        onProgress: { [weak self] fraction, message in
                            self?.updateProgress(fraction: fraction, message: message)
                        }
                    )
                } else if let inMemoryData {
                    result = try await uploader.uploadData(
                        inMemoryData,
                        fileName: name,
                        parentId: parent,
                        onProgress: { [weak self] fraction, message in
                            self?.updateProgress(fraction: fraction, message: message)
                        }
                    )
                } else {
                    throw ShareUploader.UploadError.fileReadFailed
                }

                await MainActor.run {
                    // Update recents
                    self.saveRecentFolder()

                    switch result {
                    case .uploaded:
                        self.showCompletion(message: "Saved")
                    }
                }
            } catch let uploadError as ShareUploader.UploadError {
                await MainActor.run {
                    self.showError(uploadError.errorDescription ?? "Couldn't save the file.")
                }
            } catch {
                await MainActor.run {
                    self.showError("Couldn't save the file. Please try again.")
                }
            }
        }
    }

    private func showCompletion(message: String) {
        progressLabel.text = message
        progressFillWidthConstraint?.constant = progressBar.bounds.width
        UIView.animate(withDuration: 0.25) {
            self.progressOverlay.layoutIfNeeded()
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    // MARK: - Recents

    private func loadRecentFolders() {
        let defaults = UserDefaults(suiteName: Self.appGroup)
        guard let data = defaults?.data(forKey: Self.recentFoldersKey),
              let recents = try? JSONDecoder().decode([RecentFolder].self, from: data) else {
            return
        }
        recentFolders = recents
    }

    private func saveRecentFolder() {
        guard let folderId = selectedFolderId else { return }

        // Find display name for this folder
        let displayName: String
        if let recent = recentFolders.first(where: { $0.id == folderId }) {
            displayName = recent.name
        } else if let folder = folders.first(where: { $0.id == folderId }) {
            displayName = folder.displayName
        } else {
            displayName = "Folder"
        }

        // Remove existing entry for this folder, add to front
        var recents = recentFolders.filter { $0.id != folderId }
        recents.insert(RecentFolder(id: folderId, name: displayName), at: 0)

        // Keep max 3
        if recents.count > 3 {
            recents = Array(recents.prefix(3))
        }

        recentFolders = recents
        let defaults = UserDefaults(suiteName: Self.appGroup)
        if let encoded = try? JSONEncoder().encode(recents) {
            defaults?.set(encoded, forKey: Self.recentFoldersKey)
        }
    }

    // MARK: - Helpers

    private func formatFileSize(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
        if bytes < 1024 * 1024 * 1024 { return String(format: "%.1f MB", Double(bytes) / (1024 * 1024)) }
        return String(format: "%.1f GB", Double(bytes) / (1024 * 1024 * 1024))
    }
}

// MARK: - UITableViewDelegate & DataSource

extension ShareViewController: UITableViewDelegate, UITableViewDataSource {

    /// Section 0 = RECENT (if any), Section 1 = FOLDERS
    func numberOfSections(in tableView: UITableView) -> Int {
        return recentFolders.isEmpty ? 1 : 2
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        if !recentFolders.isEmpty && section == 0 {
            return recentFolders.count
        }
        return folders.count
    }

    func tableView(_ tableView: UITableView, viewForHeaderInSection section: Int) -> UIView? {
        let header = UIView()
        let label = UILabel()
        label.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
        label.textColor = Self.textTertiary

        if !recentFolders.isEmpty && section == 0 {
            label.text = "RECENT"
        } else {
            label.text = "FOLDERS"
        }

        label.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 20),
            label.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -4),
        ])
        return header
    }

    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
        return 32
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: FolderCell.reuseID, for: indexPath) as! FolderCell

        let folderId: String
        let folderName: String

        if !recentFolders.isEmpty && indexPath.section == 0 {
            let recent = recentFolders[indexPath.row]
            folderId = recent.id
            folderName = recent.name
        } else {
            let folder = folders[indexPath.row]
            folderId = folder.id
            folderName = folder.displayName
        }

        let isSelected = folderId == selectedFolderId
        cell.configure(name: folderName, isSelected: isSelected)
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        if !recentFolders.isEmpty && indexPath.section == 0 {
            selectedFolderId = recentFolders[indexPath.row].id
        } else {
            selectedFolderId = folders[indexPath.row].id
        }

        tableView.reloadData()
    }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        return 48
    }
}

// MARK: - FolderCell

private final class FolderCell: UITableViewCell {
    static let reuseID = "FolderCell"

    private let folderIcon = UILabel()
    private let nameLabel = UILabel()
    private let checkmark = UILabel()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        setupCell()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func setupCell() {
        backgroundColor = .clear
        selectionStyle = .none

        folderIcon.text = "\u{1F4C1}"
        folderIcon.font = UIFont.systemFont(ofSize: 18)
        folderIcon.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(folderIcon)

        nameLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
        nameLabel.textColor = .white
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(nameLabel)

        checkmark.text = "\u{2713}"
        checkmark.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        checkmark.textColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 1)
        checkmark.isHidden = true
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(checkmark)

        NSLayoutConstraint.activate([
            folderIcon.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            folderIcon.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),

            nameLabel.leadingAnchor.constraint(equalTo: folderIcon.trailingAnchor, constant: 10),
            nameLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            nameLabel.trailingAnchor.constraint(equalTo: checkmark.leadingAnchor, constant: -10),

            checkmark.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            checkmark.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])
    }

    func configure(name: String, isSelected: Bool) {
        nameLabel.text = name
        checkmark.isHidden = !isSelected
        nameLabel.textColor = isSelected ? .white : UIColor(white: 0.8, alpha: 1)
    }
}

// MARK: - RecentFolder model

struct RecentFolder: Codable {
    let id: String
    let name: String
}
