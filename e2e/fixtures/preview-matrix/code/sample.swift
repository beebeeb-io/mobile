// Beebeeb preview-matrix fixture — Swift (task 1565).

let greeting = "café naïve 日本語 Ελληνικά Москва €19.99"

func longLine() -> String {
    var parts = [String]()
    for _ in 0..<20 { parts.append("0123456789") }
    return parts.joined(separator: " ") + " end-of-long-line"
}

print(greeting)
print(longLine())
