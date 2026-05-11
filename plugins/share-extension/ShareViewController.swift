import UIKit
import MobileCoreServices
import UniformTypeIdentifiers

// MARK: - Constants

private enum ShareConstants {
    static let appGroup = "group.io.beebeeb.shared"
    static let sharedDirName = "IncomingShares"
    static let amber = UIColor(red: 0xF5/255.0, green: 0xB8/255.0, blue: 0x00/255.0, alpha: 1.0)
    static let amberBg = UIColor(red: 0xFE/255.0, green: 0xF7/255.0, blue: 0xE0/255.0, alpha: 1.0)
    static let ink = UIColor(red: 0x2A/255.0, green: 0x25/255.0, blue: 0x20/255.0, alpha: 1.0)
    static let ink3 = UIColor(red: 0x7D/255.0, green: 0x77/255.0, blue: 0x70/255.0, alpha: 1.0)
    static let paper = UIColor(red: 0xFA/255.0, green: 0xF8/255.0, blue: 0xF5/255.0, alpha: 1.0)

    /// Type identifiers we accept, in priority order. Files first so that
    /// a shared image's underlying file URL is preferred over its raw bytes.
    static let typeIdentifiersInPriorityOrder = [
        "public.file-url",
        "public.image",
        "public.movie",
        "public.url",
        "public.data",
        "public.text",
    ]
}

// MARK: - Manifest entry

private struct ShareManifest: Codable {
    let id: String
    let filename: String
    let relativePath: String
    let mimeType: String?
    let sizeBytes: Int64
    let timestamp: TimeInterval
    let kind: String
}

// MARK: - View controller

class ShareViewController: UIViewController {

    private let card = UIView()
    private let iconCircle = UIView()
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        buildUI()
        Task { [weak self] in
            await self?.runImport()
        }
    }

    // MARK: UI

    private func buildUI() {
        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = ShareConstants.paper
        card.layer.cornerRadius = 18
        card.layer.cornerCurve = .continuous
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.18
        card.layer.shadowRadius = 24
        card.layer.shadowOffset = CGSize(width: 0, height: 8)
        view.addSubview(card)

        iconCircle.translatesAutoresizingMaskIntoConstraints = false
        iconCircle.backgroundColor = ShareConstants.amberBg
        iconCircle.layer.cornerRadius = 28
        card.addSubview(iconCircle)

        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.tintColor = ShareConstants.amber
        iconView.contentMode = .scaleAspectFit
        iconView.image = UIImage(systemName: "lock.shield.fill")
        iconCircle.addSubview(iconView)

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.color = ShareConstants.amber
        spinner.startAnimating()
        card.addSubview(spinner)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = "Saving to Beebeeb"
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = ShareConstants.ink
        titleLabel.textAlignment = .center
        card.addSubview(titleLabel)

        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        subtitleLabel.text = "Open Beebeeb to encrypt and upload"
        subtitleLabel.font = .systemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor = ShareConstants.ink3
        subtitleLabel.textAlignment = .center
        subtitleLabel.numberOfLines = 2
        card.addSubview(subtitleLabel)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 280),

            iconCircle.topAnchor.constraint(equalTo: card.topAnchor, constant: 28),
            iconCircle.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            iconCircle.widthAnchor.constraint(equalToConstant: 56),
            iconCircle.heightAnchor.constraint(equalToConstant: 56),

            iconView.centerXAnchor.constraint(equalTo: iconCircle.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconCircle.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 28),
            iconView.heightAnchor.constraint(equalToConstant: 28),

            titleLabel.topAnchor.constraint(equalTo: iconCircle.bottomAnchor, constant: 16),
            titleLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            titleLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),

            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6),
            subtitleLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            subtitleLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),

            spinner.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 18),
            spinner.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            spinner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -28),
        ])
    }

    private func showSuccess(count: Int) {
        spinner.stopAnimating()
        spinner.isHidden = true
        iconView.image = UIImage(systemName: "checkmark.circle.fill")
        iconCircle.backgroundColor = ShareConstants.amber.withAlphaComponent(0.15)
        iconView.tintColor = ShareConstants.amber

        let noun = count == 1 ? "file" : "files"
        titleLabel.text = "Saved to Beebeeb"
        subtitleLabel.text = "\(count) \(noun) waiting · open Beebeeb to encrypt"
    }

    private func showFailure(_ message: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        iconView.image = UIImage(systemName: "exclamationmark.triangle.fill")
        iconCircle.backgroundColor = UIColor.systemRed.withAlphaComponent(0.12)
        iconView.tintColor = .systemRed
        titleLabel.text = "Couldn't save"
        subtitleLabel.text = message
    }

    private func dismissAfter(_ seconds: TimeInterval, error: Error? = nil) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self = self else { return }
            if let error = error {
                self.extensionContext?.cancelRequest(withError: error)
            } else {
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    // MARK: Import

    private func runImport() async {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: ShareConstants.appGroup
        ) else {
            await MainActor.run { self.showFailure("App Group is not configured") }
            dismissAfter(1.5, error: NSError(domain: "Beebeeb", code: -1))
            return
        }
        let dir = containerURL.appendingPathComponent(ShareConstants.sharedDirName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            await MainActor.run { self.showFailure(error.localizedDescription) }
            dismissAfter(1.5, error: error)
            return
        }

        let providers: [NSItemProvider] = (extensionContext?.inputItems ?? [])
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] }

        var saved = 0
        for provider in providers {
            if await saveAttachment(provider, into: dir) { saved += 1 }
        }

        if saved == 0 {
            await MainActor.run { self.showFailure("Nothing to save") }
            dismissAfter(1.4)
        } else {
            await MainActor.run { self.showSuccess(count: saved) }
            dismissAfter(0.9)
        }
    }

    private func saveAttachment(_ provider: NSItemProvider, into dir: URL) async -> Bool {
        for type in ShareConstants.typeIdentifiersInPriorityOrder {
            if provider.hasItemConformingToTypeIdentifier(type) {
                return await saveItem(provider: provider, type: type, into: dir)
            }
        }
        return false
    }

    /// Load one attachment as the requested type and write it (plus a manifest)
    /// into the shared directory. Returns true on success.
    private func saveItem(provider: NSItemProvider, type: String, into dir: URL) async -> Bool {
        return await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, _ in
                guard let self = self else {
                    continuation.resume(returning: false)
                    return
                }
                let ok = self.persist(item: item, sourceType: type, suggestedName: provider.suggestedName, into: dir)
                continuation.resume(returning: ok)
            }
        }
    }

    private func persist(item: NSSecureCoding?, sourceType: String, suggestedName: String?, into dir: URL) -> Bool {
        let id = UUID().uuidString

        // Resolve the bytes + a sensible filename + a mime type
        var data: Data?
        var filename: String?
        var mime: String?
        var kind = "data"

        if let url = item as? URL {
            if url.isFileURL {
                data = try? Data(contentsOf: url)
                filename = url.lastPathComponent
                mime = mimeType(forPathExtension: url.pathExtension)
                kind = sourceType.contains("image") ? "image"
                    : sourceType.contains("movie") ? "video"
                    : "file"
            } else {
                // Web URL — store as a .url file with the URL string inside
                let body = url.absoluteString
                data = body.data(using: .utf8)
                filename = (suggestedName ?? "shared") + ".url"
                mime = "text/uri-list"
                kind = "url"
            }
        } else if let image = item as? UIImage {
            data = image.jpegData(compressionQuality: 0.92)
            filename = (suggestedName ?? "image-\(id)") + ".jpg"
            mime = "image/jpeg"
            kind = "image"
        } else if let str = item as? String {
            data = str.data(using: .utf8)
            filename = (suggestedName ?? "note-\(id)") + ".txt"
            mime = "text/plain"
            kind = "text"
        } else if let raw = item as? Data {
            data = raw
            let ext = (sourceType == "public.image") ? "jpg"
                : (sourceType == "public.movie") ? "mov"
                : "bin"
            filename = (suggestedName ?? "shared-\(id)") + "." + ext
            mime = mimeType(forPathExtension: ext)
            kind = "data"
        }

        guard let bytes = data, let name = filename, !bytes.isEmpty else {
            return false
        }

        let safeName = sanitize(filename: name)
        let storedExt = (safeName as NSString).pathExtension
        let storedFilename = storedExt.isEmpty ? id : "\(id).\(storedExt)"
        let fileURL = dir.appendingPathComponent(storedFilename)
        let manifestURL = dir.appendingPathComponent("\(id).json")

        do {
            try bytes.write(to: fileURL, options: .atomic)
        } catch {
            return false
        }

        let manifest = ShareManifest(
            id: id,
            filename: safeName,
            relativePath: storedFilename,
            mimeType: mime,
            sizeBytes: Int64(bytes.count),
            timestamp: Date().timeIntervalSince1970,
            kind: kind
        )

        guard let payload = try? JSONEncoder().encode(manifest) else {
            try? FileManager.default.removeItem(at: fileURL)
            return false
        }
        do {
            try payload.write(to: manifestURL, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: fileURL)
            return false
        }
        return true
    }

    // MARK: Helpers

    private func sanitize(filename raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "shared" }
        let illegal = CharacterSet(charactersIn: "/\\:*?\"<>|\0")
        return String(trimmed.unicodeScalars.map { illegal.contains($0) ? "_" : Character($0) })
    }

    private func mimeType(forPathExtension ext: String) -> String? {
        guard !ext.isEmpty else { return nil }
        if #available(iOS 14.0, *) {
            return UTType(filenameExtension: ext)?.preferredMIMEType
        }
        guard let uti = UTTypeCreatePreferredIdentifierForTag(
            kUTTagClassFilenameExtension, ext as CFString, nil
        )?.takeRetainedValue() else { return nil }
        return UTTypeCopyPreferredTagWithClass(uti, kUTTagClassMIMEType)?.takeRetainedValue() as String?
    }
}
