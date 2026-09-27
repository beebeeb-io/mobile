// Beebeeb preview-matrix fixture — TypeScript (task 1565).

const greeting: string = 'café naïve 日本語 Ελληνικά Москва €19.99';

function longLine(): string {
  return Array.from({ length: 20 }, () => '0123456789').join(' ') + ' end-of-long-line';
}

export function main(): void {
  console.log(greeting);
  console.log(longLine());
}

main();
