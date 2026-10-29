// Beebeeb preview-matrix fixture — C++ (task 1565).
#include <iostream>
#include <string>

int main() {
    // non-ASCII in a comment: café naïve 日本語 Ελληνικά Москва €19.99
    std::string longLine;
    for (int i = 0; i < 20; ++i) longLine += "0123456789 ";
    longLine += "end-of-long-line";
    std::cout << longLine << std::endl;
    return 0;
}
