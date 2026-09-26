// Beebeeb preview-matrix fixture — C# (task 1565).
using System;

class Sample
{
    const string Greeting = "café naïve 日本語 Ελληνικά Москва €19.99";

    static void Main()
    {
        var longLine = string.Join(" ", new string[20]).Replace("", "0123456789 ").Trim() + " end-of-long-line";
        Console.WriteLine(Greeting);
        Console.WriteLine(longLine);
    }
}
