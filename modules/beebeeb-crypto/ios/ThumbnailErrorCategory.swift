import Foundation

public enum ThumbnailErrorCategory: String, Codable {
    case network_5xx
    case network_429
    case photoKit_missing
    case decrypt_failed
    case generate_failed
    case upload_too_large
    case timeout
    case unknown

    public var userText: String {
        switch self {
        case .network_5xx:        return "Server hiccup"
        case .network_429:        return "Slowing down to respect server limits"
        case .photoKit_missing:   return "Photo no longer in Photos app"
        case .decrypt_failed:     return "Couldn't decrypt — file may be corrupt"
        case .generate_failed:    return "Couldn't generate thumbnail"
        case .upload_too_large:   return "Photo too small to thumbnail"
        case .timeout:            return "Took too long, will try again"
        case .unknown:            return "Something went wrong"
        }
    }

    public var isRetriable: Bool {
        switch self {
        case .network_5xx, .network_429, .timeout: return true
        default:                                    return false
        }
    }

    /// Classify an arbitrary Error or HTTP status into a category.
    public static func classify(error: Error?, httpStatus: Int?) -> ThumbnailErrorCategory {
        if let status = httpStatus {
            if status == 429 { return .network_429 }
            if status >= 500 && status < 600 { return .network_5xx }
            if status == 413 { return .upload_too_large }
            if status >= 400 && status < 500 { return .generate_failed }
        }
        if let ns = error as NSError? {
            if ns.domain == NSURLErrorDomain {
                switch ns.code {
                case NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost:
                    return .timeout
                case NSURLErrorCannotConnectToHost, NSURLErrorNotConnectedToInternet:
                    return .network_5xx
                default: break
                }
            }
            if ns.domain == "BeebeebPhotoKit"        { return .photoKit_missing }
            if ns.domain == "BeebeebCryptoDecrypt"   { return .decrypt_failed }
            if ns.domain == "BeebeebThumbnailGen"    { return .generate_failed }
        }
        return .unknown
    }
}
