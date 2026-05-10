import WidgetKit
import SwiftUI

struct WidgetData: Codable {
    var storageUsed: Int64
    var storageTotal: Int64
    var recentFiles: [RecentFile]
    struct RecentFile: Codable {
        var name: String
        var updatedAt: String
    }
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
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.io.beebeeb.shared"),
              let data = try? Data(contentsOf: container.appendingPathComponent("widget-data.json")),
              let decoded = try? JSONDecoder().decode(WidgetData.self, from: data) else { return nil }
        return decoded
    }
}

private let amberColor = Color(red: 0.96, green: 0.72, blue: 0.0)

struct BeebeebWidgetView: View {
    let entry: BeebeebEntry
    @Environment(\.widgetFamily) var widgetFamily

    var usedBytes: Int64 { entry.data?.storageUsed ?? 0 }
    var quotaBytes: Int64 { entry.data?.storageTotal ?? 1 }
    var usedFraction: Double { Double(usedBytes) / Double(max(quotaBytes, 1)) }

    var body: some View {
#if os(iOS)
        if #available(iOSApplicationExtension 16.0, *) {
            switch widgetFamily {
            case .accessoryCircular:
                Gauge(value: usedFraction) {
                    Image(systemName: "lock.fill")
                        .foregroundColor(amberColor)
                } currentValueLabel: {
                    Text("\(Int(usedFraction * 100))%")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .gaugeStyle(.accessoryCircular)
                .tint(amberColor)

            case .accessoryInline:
                Text("\(formatBytes(usedBytes)) / \(formatBytes(quotaBytes))")
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
            } else {
                Text("Open Beebeeb to load").font(.system(size: 10)).foregroundColor(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(.fill, for: .widget)
    }

    func formatBytes(_ bytes: Int64) -> String {
        if bytes < 1_000_000_000 { return String(format: "%.0f MB", Double(bytes) / 1_000_000) }
        return String(format: "%.1f GB", Double(bytes) / 1_000_000_000)
    }
}

@main
struct BeebeebWidget: Widget {
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
