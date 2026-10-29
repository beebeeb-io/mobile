// Beebeeb preview-matrix fixture — Rust (task 1565).

const GREETING: &str = "café naïve 日本語 Ελληνικά Москва €19.99";

fn long_line() -> String {
    let mut s = String::new();
    for _ in 0..20 {
        s.push_str("0123456789 ");
    }
    s.push_str("end-of-long-line");
    s
}

fn main() {
    println!("{}", GREETING);
    println!("{}", long_line());
}
