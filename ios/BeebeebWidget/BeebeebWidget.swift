import ActivityKit
import WidgetKit
import SwiftUI

struct BackupStatusData: Codable {
    var total: Int
    var completed: Int
    var pending: Int
    var waitingToEncrypt: Int?
    var encryptedPendingUpload: Int?
    var uploading: Int?
    var inProgress: Int
    var failed: Int
    var bytesUploaded: Int64
    var bytesTotal: Int64
    var state: String
    var reason: String
    var lastBackupAt: String?
    var lastChangeAt: String
    var updatedAt: String
}

struct WidgetData: Codable {
    var storageUsed: Int64
    var storageTotal: Int64
    var recentFiles: [RecentFile]
    var backup: BackupStatusData?
    struct RecentFile: Codable {
        var name: String
        var updatedAt: String
    }
}

@available(iOSApplicationExtension 16.1, *)
struct BeebeebBackupActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var total: Int
        var completed: Int
        var pending: Int
        var waitingToEncrypt: Int
        var encryptedPendingUpload: Int
        var uploading: Int
        var failed: Int
        var state: String
        var reason: String
        var updatedAt: Date
    }

    var startedAt: Date
}

struct BeebeebEntry: TimelineEntry {
    let date: Date
    let data: WidgetData?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> BeebeebEntry {
        BeebeebEntry(date: Date(), data: nil)
    }
    func getSnapshot(in context: Context, completion: @escaping (BeebeebEntry) -> Void) {
        completion(BeebeebEntry(date: Date(), data: loadData()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<BeebeebEntry>) -> Void) {
        let entries = [BeebeebEntry(date: Date(), data: loadData())]
        completion(Timeline(entries: entries, policy: .after(Date().addingTimeInterval(15 * 60))))
    }
    func loadData() -> WidgetData? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.io.beebeeb.shared") else { return nil }
        var decoded: WidgetData
        if let data = try? Data(contentsOf: container.appendingPathComponent("widget-data.json")),
           let storage = try? JSONDecoder().decode(WidgetData.self, from: data) {
            decoded = storage
        } else {
            decoded = WidgetData(storageUsed: 0, storageTotal: 1, recentFiles: [], backup: nil)
        }
        decoded.backup = loadBackupStatus(container: container)
        return decoded
    }

    func loadBackupStatus(container: URL) -> BackupStatusData? {
        guard let data = try? Data(contentsOf: container.appendingPathComponent("backup-status.json")),
              let decoded = try? JSONDecoder().decode(BackupStatusData.self, from: data) else { return nil }
        return decoded
    }
}

private let amberColor = Color(red: 0.96, green: 0.72, blue: 0.0)

private func activityInlineRunning(completed: Int, total: Int, encrypted: Int, uploading: Int) -> String {
    if encrypted + uploading > 0 {
        return "\(encrypted + uploading) encrypted, \(completed)/\(total) backed up"
    }
    return "\(completed)/\(total) backed up"
}

private func pendingBreakdown(waiting: Int, encrypted: Int, uploading: Int) -> String {
    if waiting > 0 && encrypted + uploading > 0 {
        return "\(waiting) to encrypt · \(encrypted + uploading) to upload"
    }
    if encrypted + uploading > 0 {
        return "\(encrypted + uploading) encrypted, waiting to upload"
    }
    if waiting > 0 {
        return "\(waiting) waiting to encrypt"
    }
    return "Preparing backup"
}

struct BeebeebWidgetView: View {
    let entry: BeebeebEntry
    @Environment(\.widgetFamily) var widgetFamily

    var usedBytes: Int64 { entry.data?.storageUsed ?? 0 }
    var quotaBytes: Int64 { entry.data?.storageTotal ?? 1 }
    var usedFraction: Double { Double(usedBytes) / Double(max(quotaBytes, 1)) }
    var backup: BackupStatusData? { entry.data?.backup }
    var backupFraction: Double {
        guard let backup, backup.total > 0 else { return 0 }
        return min(1, max(0, Double(backup.completed) / Double(backup.total)))
    }

    var body: some View {
#if os(iOS)
        if #available(iOSApplicationExtension 16.0, *) {
            switch widgetFamily {
            case .accessoryCircular:
                Gauge(value: backup != nil ? backupFraction : usedFraction) {
                    Image(systemName: "lock.fill")
                        .foregroundColor(amberColor)
                } currentValueLabel: {
                    Text("\(Int((backup != nil ? backupFraction : usedFraction) * 100))%")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .gaugeStyle(.accessoryCircular)
                .tint(amberColor)

            case .accessoryInline:
                Text(accessoryInlineText)
                    .font(.system(.caption2, design: .monospaced))

            default:
                homeScreenView
            }
        } else {
            homeScreenView
        }
#else
        homeScreenView
#endif
    }

    var homeScreenView: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("beebeeb").font(.system(size: 11, weight: .bold)).foregroundColor(amberColor)
            if let d = entry.data {
                let pct = d.storageTotal > 0 ? Double(d.storageUsed) / Double(d.storageTotal) : 0
                Gauge(value: pct) { EmptyView() }
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(amberColor)
                Text(formatBytes(d.storageUsed) + " of " + formatBytes(d.storageTotal))
                    .font(.system(size: 10)).foregroundColor(.secondary)
                if let backup = d.backup {
                    Divider().padding(.vertical, 3)
                    Text(backupTitle(backup))
                        .font(.system(size: 11, weight: .semibold))
                    ProgressView(value: backup.total > 0 ? Double(backup.completed) / Double(backup.total) : 0)
                        .tint(amberColor)
                    Text(backupSubtitle(backup))
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
            } else {
                Text("Open Beebeeb to load").font(.system(size: 10)).foregroundColor(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .beebeebWidgetBackground()
    }

    func formatBytes(_ bytes: Int64) -> String {
        if bytes < 1_000_000_000 { return String(format: "%.0f MB", Double(bytes) / 1_000_000) }
        return String(format: "%.1f GB", Double(bytes) / 1_000_000_000)
    }

    var accessoryInlineText: String {
        guard let backup else {
            return "\(formatBytes(usedBytes)) / \(formatBytes(quotaBytes))"
        }
        switch backup.state {
        case "preparing", "encrypting", "uploading", "running":
            return activityInlineRunning(
                completed: backup.completed,
                total: backup.total,
                encrypted: backup.encryptedPendingUpload ?? 0,
                uploading: backup.uploading ?? 0
            )
        case "waitingForAppOpen", "needsAppOpen":
            return "Open Beebeeb: \(backup.pending) pending"
        case "waitingForWifi":
            return "Waiting: \(backup.pending) pending"
        default:
            return backup.lastBackupAt == nil ? "Backup ready" : "Backup complete"
        }
    }

    func backupTitle(_ backup: BackupStatusData) -> String {
        switch backup.state {
        case "preparing", "encrypting", "uploading", "running": return "Backup active"
        case "waitingForAppOpen", "needsAppOpen": return "Open to continue"
        case "waitingForWifi": return "Waiting"
        case "pausedByUser", "paused": return "Paused"
        case "needsAttention", "failed": return "Needs attention"
        default: return "Backup complete"
        }
    }

    func backupSubtitle(_ backup: BackupStatusData) -> String {
        let encrypted = backup.encryptedPendingUpload ?? 0
        let uploading = backup.uploading ?? 0
        if ["waitingForAppOpen", "needsAppOpen"].contains(backup.state), backup.pending > 0 {
            return pendingBreakdown(waiting: backup.waitingToEncrypt ?? backup.pending, encrypted: encrypted, uploading: uploading)
        }
        if ["preparing", "encrypting", "uploading", "running"].contains(backup.state), encrypted + uploading > 0 {
            return pendingBreakdown(waiting: backup.waitingToEncrypt ?? 0, encrypted: encrypted, uploading: uploading)
        }
        if backup.total > 0 {
            return "\(backup.completed) of \(backup.total) photos backed up"
        }
        return backup.reason
    }
}

private extension View {
    @ViewBuilder
    func beebeebWidgetBackground() -> some View {
#if os(iOS)
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(.fill, for: .widget)
        } else {
            self.background(Color(.systemBackground))
        }
#else
        self
#endif
    }
}

struct BeebeebStorageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "io.beebeeb.widget.storage", provider: Provider()) { entry in
            BeebeebWidgetView(entry: entry)
        }
        .configurationDisplayName("Beebeeb Storage")
        .description("Shows your vault storage usage.")
        .supportedFamilies(supportedWidgetFamilies)
    }

    var supportedWidgetFamilies: [WidgetFamily] {
#if os(iOS)
        if #available(iOSApplicationExtension 16.0, *) {
            return [.systemSmall, .systemMedium, .accessoryCircular, .accessoryInline]
        }
#endif
        return [.systemSmall, .systemMedium]
    }
}

@available(iOSApplicationExtension 16.1, *)
struct BeebeebBackupActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BeebeebBackupActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Beebeeb Backup")
                        .font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(activityPercent(context.state))
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(amberColor)
                }
                ProgressView(value: activityFraction(context.state))
                    .tint(amberColor)
                Text(activitySubtitle(context.state))
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            .padding()
            .activityBackgroundTint(Color(.systemBackground))
            .activitySystemActionForegroundColor(amberColor)
            .widgetURL(URL(string: "beebeeb://settings"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Backup", systemImage: "lock.fill")
                        .foregroundColor(amberColor)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(activityPercent(context.state))
                        .font(.system(.body, design: .monospaced))
                        .foregroundColor(amberColor)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        ProgressView(value: activityFraction(context.state))
                            .tint(amberColor)
                        Text(activitySubtitle(context.state))
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: "lock.fill")
                    .foregroundColor(amberColor)
            } compactTrailing: {
                Text(activityPercent(context.state))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
            } minimal: {
                Image(systemName: "lock.fill")
                    .foregroundColor(amberColor)
            }
            .widgetURL(URL(string: "beebeeb://settings"))
        }
    }

    func activityFraction(_ state: BeebeebBackupActivityAttributes.ContentState) -> Double {
        guard state.total > 0 else { return 0 }
        return min(1, max(0, Double(state.completed) / Double(state.total)))
    }

    func activityPercent(_ state: BeebeebBackupActivityAttributes.ContentState) -> String {
        "\(Int(activityFraction(state) * 100))%"
    }

    func activitySubtitle(_ state: BeebeebBackupActivityAttributes.ContentState) -> String {
        switch state.state {
        case "waitingForAppOpen", "needsAppOpen":
            return "Open Beebeeb to continue · \(pendingBreakdown(waiting: state.waitingToEncrypt, encrypted: state.encryptedPendingUpload, uploading: state.uploading))"
        case "waitingForWifi":
            return "Waiting for connection · \(pendingBreakdown(waiting: state.waitingToEncrypt, encrypted: state.encryptedPendingUpload, uploading: state.uploading))"
        case "pausedByUser", "paused":
            return "Paused · \(pendingBreakdown(waiting: state.waitingToEncrypt, encrypted: state.encryptedPendingUpload, uploading: state.uploading))"
        case "preparing", "encrypting", "uploading", "running":
            if state.waitingToEncrypt > 0 || state.encryptedPendingUpload > 0 || state.uploading > 0 {
                return pendingBreakdown(waiting: state.waitingToEncrypt, encrypted: state.encryptedPendingUpload, uploading: state.uploading)
            }
            return "\(state.completed) of \(state.total) photos backed up"
        default:
            return "\(state.completed) of \(state.total) photos backed up"
        }
    }

    func activityInlineRunning(completed: Int, total: Int, encrypted: Int, uploading: Int) -> String {
        if encrypted + uploading > 0 {
            return "\(encrypted + uploading) encrypted, \(completed)/\(total) backed up"
        }
        return "\(completed)/\(total) backed up"
    }

    func pendingBreakdown(waiting: Int, encrypted: Int, uploading: Int) -> String {
        if waiting > 0 && encrypted + uploading > 0 {
            return "\(waiting) to encrypt · \(encrypted + uploading) to upload"
        }
        if encrypted + uploading > 0 {
            return "\(encrypted + uploading) encrypted, waiting to upload"
        }
        if waiting > 0 {
            return "\(waiting) waiting to encrypt"
        }
        return "Preparing backup"
    }
}

@main
struct BeebeebWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        BeebeebStorageWidget()
        if #available(iOSApplicationExtension 16.1, *) {
            BeebeebBackupActivityWidget()
        }
    }
}
