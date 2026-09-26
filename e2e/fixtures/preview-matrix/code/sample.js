// Beebeeb preview-matrix fixture — JavaScript (task 1565).

const greeting = 'café naïve 日本語 Ελληνικά Москва €19.99';
const longLine = Array.from({ length: 20 }, () => '0123456789').join(' ') + ' end-of-long-line';

function main() {
  console.log(greeting);
  console.log(longLine);
}

main();
