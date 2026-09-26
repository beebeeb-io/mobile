/* Beebeeb preview-matrix fixture — C (task 1565). */
#include <stdio.h>

int main(void) {
    const char *greeting = "cafe naive (non-ASCII in this comment: café naïve 日本語 Ελληνικά Москва €19.99)";
    printf("%s\n", greeting);
    printf("0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 0123456789 end-of-long-line\n");
    return 0;
}
