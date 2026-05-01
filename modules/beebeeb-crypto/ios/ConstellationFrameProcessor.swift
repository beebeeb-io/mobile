import VisionCamera
import CoreMedia

// Amber Constellation frame processor plugin for VisionCamera v4.
//
// v1 implementation: simplified amber-color detection.
// When BeebeebCore.xcframework is linked (repos/core/build-ios.sh), replace
// the local blob detection with calls to the Rust ConstellationDecoderHandle.
//
// Registered under the name "constellationDecode" — see ConstellationFrameProcessorPlugin.m.
@objc(ConstellationFrameProcessorPlugin)
public class ConstellationFrameProcessorPlugin: FrameProcessorPlugin {

    public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]? = nil) {
        super.init(proxy: proxy, options: options)
    }

    // Called for every camera frame on the VisionCamera worklet thread.
    public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(frame.buffer) else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let rawBytes = baseAddress.assumingMemoryBound(to: UInt8.self)

        // Scan 11×11 grid — constellation has 67 nodes (55 outer + 12 inner),
        // each mapped to one grid cell.
        // Amber threshold: R>200, G>150, B<100 in BGRA (iOS native pixel format).
        let gridCols = 11, gridRows = 11
        let cellW = width / gridCols
        let cellH = height / gridRows
        let step = 4  // sample every 4th pixel for performance

        var detectedNodes: [[String: Any]] = []

        for row in 0..<gridRows {
            for col in 0..<gridCols {
                let x0 = col * cellW
                let y0 = row * cellH
                var amberCount = 0
                var totalCount = 0

                var py = y0
                while py < Swift.min(y0 + cellH, height) {
                    var px = x0
                    while px < Swift.min(x0 + cellW, width) {
                        let offset = py * bytesPerRow + px * 4
                        // iOS BGRA: [0]=B [1]=G [2]=R [3]=A
                        let b = Int(rawBytes[offset])
                        let g = Int(rawBytes[offset + 1])
                        let r = Int(rawBytes[offset + 2])
                        if r > 200 && g > 150 && b < 100 {
                            amberCount += 1
                        }
                        totalCount += 1
                        px += step
                    }
                    py += step
                }

                // Cell is a hotspot if >15% of sampled pixels are amber
                guard totalCount > 0, amberCount * 100 / totalCount > 15 else { continue }

                // Normalize to [-1, 1] centered on frame
                let cx = (Float(x0 + cellW / 2) / Float(width)) * 2.0 - 1.0
                let cy = (Float(y0 + cellH / 2) / Float(height)) * 2.0 - 1.0
                let brightness = Float(amberCount) / Float(totalCount)
                detectedNodes.append(["x": cx, "y": cy, "brightness": brightness])
            }
        }

        // Constellation has 67 nodes; progress is how many we've detected
        let maxNodes = 67
        let progress = Double(detectedNodes.count) / Double(maxNodes)

        // v1: consider decoded when 80%+ of nodes are visible
        // v2: replace with Rust ConstellationDecoderHandle.ingest_frame()
        let decoded = detectedNodes.count >= Int(Double(maxNodes) * 0.8)

        return [
            "progress": Swift.min(progress, 1.0),
            "nodeCount": detectedNodes.count,
            "nodes": detectedNodes,
            "decoded": decoded,
        ] as [String: Any]
    }
}
