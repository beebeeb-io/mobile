// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { columnsForPinchScale } from './photo-grid';

describe('photo grid pinch density', () => {
  test('updates column density from the gesture start columns', () => {
    expect(columnsForPinchScale(4, 0.88)).toBe(7);
    expect(columnsForPinchScale(4, 0.64)).toBe(12);
    expect(columnsForPinchScale(12, 1.2)).toBe(7);
    expect(columnsForPinchScale(12, 1.7)).toBe(4);
  });

  test('does not drift when the same live gesture scale is applied repeatedly', () => {
    const first = columnsForPinchScale(4, 0.88);
    const second = columnsForPinchScale(4, 0.88);

    expect(first).toBe(7);
    expect(second).toBe(7);
  });

  test('clamps at the smallest and largest densities', () => {
    expect(columnsForPinchScale(2, 3)).toBe(2);
    expect(columnsForPinchScale(12, 0.3)).toBe(12);
  });
});
