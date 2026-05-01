// Registers ConstellationFrameProcessorPlugin with the VisionCamera frame processor runtime.
//
// VISION_EXPORT_SWIFT_FRAME_PROCESSOR creates an ObjC category on the Swift class and
// uses __attribute__((constructor)) so the plugin auto-registers at dylib load time
// before main() runs — no AppDelegate wiring needed.
//
// The Swift-generated header name depends on the CocoaPods pod name for this module.
// After running `pod install`, verify the header in:
//   ios/Pods/Headers/Private/{pod-name}/{pod-name}-Swift.h
// Typical names: beebeeb_crypto-Swift.h  (hyphens → underscores)

#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import "beebeeb_crypto-Swift.h"

VISION_EXPORT_SWIFT_FRAME_PROCESSOR(ConstellationFrameProcessorPlugin, constellationDecode)
