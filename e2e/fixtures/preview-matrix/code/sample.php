<?php
// Beebeeb preview-matrix fixture — PHP (task 1565).

$greeting = "café naïve 日本語 Ελληνικά Москва €19.99";
$longLine = implode(" ", array_fill(0, 20, "0123456789")) . " end-of-long-line";

echo $greeting . "\n";
echo $longLine . "\n";
