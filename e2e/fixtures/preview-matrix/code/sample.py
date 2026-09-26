#!/usr/bin/env python3
"""Beebeeb preview-matrix fixture — Python (task 1565)."""

GREETING = "café naïve 日本語 Ελληνικά Москва €19.99"
LONG_LINE = "0123456789 " * 20 + "end-of-long-line"


def main() -> None:
    print(GREETING)
    for i in range(3):
        print(f"iteration {i}: {LONG_LINE[:40]}...")


if __name__ == "__main__":
    main()
