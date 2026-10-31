import Foundation

// Photos grid thumbnail variant choice and the small-thumbnail miss limit.
// The REAL shipped file (ThumbnailServiceTypes.swift) is compiled with this driver.

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { print("FAIL: \(name)"); exit(1) }
    assertions += 1
    print("PASS: \(name)")
}

// Variant by density: small at 7 and 12 columns, medium at 2 and 4.
check(ThumbnailVariantPolicy.variant(forColumns: 2) == "medium", "2 columns -> medium")
check(ThumbnailVariantPolicy.variant(forColumns: 4) == "medium", "4 columns -> medium")
check(ThumbnailVariantPolicy.variant(forColumns: 7) == "small", "7 columns -> small")
check(ThumbnailVariantPolicy.variant(forColumns: 12) == "small", "12 columns -> small")

// A small image upgrades only when the grid wants medium.
check(ThumbnailVariantPolicy.needsUpgrade(showingSmall: true, wanted: "medium"), "small on screen, medium wanted -> upgrade")
check(!ThumbnailVariantPolicy.needsUpgrade(showingSmall: true, wanted: "small"), "small on screen, small wanted -> keep")
check(!ThumbnailVariantPolicy.needsUpgrade(showingSmall: false, wanted: "medium"), "medium on screen is never replaced")
check(!ThumbnailVariantPolicy.needsUpgrade(showingSmall: false, wanted: "small"), "medium on screen is never downgraded")

// Misses: remembered per file, three in a row stop small for everyone.
var t = SmallVariantTracker()
check(t.shouldTry("a"), "fresh tracker tries small")
t.record(.missing, fileId: "a")
check(!t.shouldTry("a"), "a missing file is not asked again")
check(t.shouldTry("b"), "other files are still asked after one miss")
t.record(.missing, fileId: "b")
check(t.shouldTry("c"), "two misses do not stop small yet")
t.record(.missing, fileId: "c")
check(!t.shouldTry("d"), "three misses in a row stop small for the session")
check(t.consecutiveMisses == SmallVariantTracker.missLimit, "miss count reached the limit")

// A hit resets the streak.
var h = SmallVariantTracker()
h.record(.missing, fileId: "a")
h.record(.missing, fileId: "b")
h.record(.hit, fileId: "c")
check(h.consecutiveMisses == 0, "a hit resets the consecutive misses")
h.record(.missing, fileId: "d")
check(h.shouldTry("e"), "after a hit, new misses start from zero")

// 429 / 5xx style failures never count as misses.
var x = SmallVariantTracker()
for i in 0..<10 { x.record(.transient, fileId: "f\(i)") }
check(x.consecutiveMisses == 0, "transient failures are not counted")
check(x.shouldTry("f0"), "a file with a transient failure may be retried")
check(x.missingFiles.isEmpty, "transient failures are not remembered as missing")

// Forgetting a file (deleted or replaced) allows a new attempt.
var f = SmallVariantTracker()
f.record(.missing, fileId: "z")
f.forget("z")
check(f.shouldTry("z"), "forget clears the per-file miss")

print("thumbnail-variant-policy: \(assertions) assertions, 0 failed")
