import XCTest

/// Smallest running XCTest target for the native iOS stack (task 1439). Standalone unit-test
/// bundle (no app/test host) — compiles `ProvenanceHeaders.swift` directly alongside this file
/// (see `ProvenanceHeadersTests` target in `Beebeeb.xcodeproj`), so `ProvenanceHeaders` is visible
/// without `@testable import`.
final class ProvenanceHeadersTests: XCTestCase {
    private func makeRequest() -> URLRequest {
        URLRequest(url: URL(string: "https://api.beebeeb.io/api/v1/uploads/init")!)
    }

    func testAppliesClientNameHeader() {
        var request = makeRequest()
        ProvenanceHeaders.apply(to: &request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Beebeeb-Client"), "mobile-ios")
    }

    func testAppliesClientVersionHeader() {
        var request = makeRequest()
        ProvenanceHeaders.apply(to: &request)
        let version = request.value(forHTTPHeaderField: "X-Beebeeb-Client-Version")
        XCTAssertEqual(version, ProvenanceHeaders.clientVersion)
        XCTAssertFalse(version?.isEmpty ?? true, "version header must not be empty")
    }

    func testSetsExactlyTheTwoProvenanceHeaders() {
        var request = makeRequest()
        ProvenanceHeaders.apply(to: &request)
        XCTAssertEqual(
            request.allHTTPHeaderFields?.keys.sorted(),
            ["X-Beebeeb-Client", "X-Beebeeb-Client-Version"]
        )
    }

    func testDoesNotClobberExistingHeaders() {
        var request = makeRequest()
        request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
        ProvenanceHeaders.apply(to: &request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Beebeeb-Client"), "mobile-ios")
    }
}
