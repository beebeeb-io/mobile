// Beebeeb preview-matrix fixture — Go (task 1565).
package main

import "fmt"

const greeting = "café naïve 日本語 Ελληνικά Москва €19.99"

func main() {
	longLine := ""
	for i := 0; i < 20; i++ {
		longLine += "0123456789 "
	}
	longLine += "end-of-long-line"
	fmt.Println(greeting)
	fmt.Println(longLine)
}
