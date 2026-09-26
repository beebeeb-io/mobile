// Beebeeb preview-matrix fixture — Kotlin (task 1565).

const val GREETING = "café naïve 日本語 Ελληνικά Москва €19.99"

fun longLine(): String = (1..20).joinToString(" ") { "0123456789" } + " end-of-long-line"

fun main() {
    println(GREETING)
    println(longLine())
}
