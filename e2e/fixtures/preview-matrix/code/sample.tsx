// Beebeeb preview-matrix fixture — TSX (task 1565).
import React from 'react';

const GREETING = 'café naïve 日本語 Ελληνικά Москва €19.99';
const LONG_LINE = Array.from({ length: 20 }, () => '0123456789').join(' ') + ' end-of-long-line';

export function FixtureComponent(): React.JSX.Element {
  return (
    <div>
      <p>{GREETING}</p>
      <p>{LONG_LINE}</p>
    </div>
  );
}
