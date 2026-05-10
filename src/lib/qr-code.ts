const SIZE = 21
const DATA_CODEWORDS = 19
const ECC_CODEWORDS = 7
const ECC_GENERATOR = [87, 229, 146, 149, 238, 102, 21]

type Cell = 0 | 1

/**
 * Minimal QR version 1-L encoder for short byte payloads.
 *
 * Constellation only needs to render the 6-digit fallback code, so this keeps
 * the implementation intentionally small instead of adding a QR dependency.
 */
export function createQrMatrix(payload: string): Cell[][] {
  const bytes = asciiBytes(payload)
  if (bytes.length > 17) {
    throw new Error('QR payload is too long for version 1-L')
  }

  const modules = blankMatrix()
  const reserved = blankReserved()
  drawFunctionPatterns(modules, reserved)

  const data = buildDataCodewords(bytes)
  const ecc = reedSolomonRemainder(data)
  drawCodewords(modules, reserved, [...data, ...ecc])
  drawFormatBits(modules, reserved, 0)

  return modules
}

function asciiBytes(value: string): number[] {
  const out: number[] = []
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code > 0x7f) throw new Error('QR payload must be ASCII')
    out.push(code)
  }
  return out
}

function blankMatrix(): Cell[][] {
  return Array.from({ length: SIZE }, () => Array<Cell>(SIZE).fill(0))
}

function blankReserved(): boolean[][] {
  return Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false))
}

function setModule(modules: Cell[][], reserved: boolean[][], x: number, y: number, value: Cell, markReserved = true) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  modules[y]![x] = value
  if (markReserved) reserved[y]![x] = true
}

function drawFunctionPatterns(modules: Cell[][], reserved: boolean[][]) {
  drawFinder(modules, reserved, 0, 0)
  drawFinder(modules, reserved, SIZE - 7, 0)
  drawFinder(modules, reserved, 0, SIZE - 7)

  for (let i = 8; i < SIZE - 8; i++) {
    const value: Cell = i % 2 === 0 ? 1 : 0
    setModule(modules, reserved, i, 6, value)
    setModule(modules, reserved, 6, i, value)
  }

  setModule(modules, reserved, 8, SIZE - 8, 1)

  for (let i = 0; i < 9; i++) {
    setModule(modules, reserved, 8, i, modules[i]![8]!)
    setModule(modules, reserved, i, 8, modules[8]![i]!)
    setModule(modules, reserved, SIZE - 1 - i, 8, modules[8]![SIZE - 1 - i]!)
    setModule(modules, reserved, 8, SIZE - 1 - i, modules[SIZE - 1 - i]![8]!)
  }
}

function drawFinder(modules: Cell[][], reserved: boolean[][], left: number, top: number) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = left + dx
      const y = top + dy
      const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
      const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6
      const center = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4
      setModule(modules, reserved, x, y, inFinder && (ring || center) ? 1 : 0)
    }
  }
}

function buildDataCodewords(bytes: number[]): number[] {
  const bits: number[] = []
  appendBits(bits, 0b0100, 4) // byte mode
  appendBits(bits, bytes.length, 8)
  for (const byte of bytes) appendBits(bits, byte, 8)
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j]!
    out.push(value)
  }
  for (let pad = 0xec; out.length < DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) {
    out.push(pad)
  }
  return out
}

function appendBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

function reedSolomonRemainder(data: number[]): number[] {
  const result = Array<number>(ECC_CODEWORDS).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < ECC_CODEWORDS; i++) {
      result[i] = result[i]! ^ gfMultiply(ECC_GENERATOR[i]!, factor)
    }
  }
  return result
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff
    if (((y >>> i) & 1) !== 0) z ^= x
  }
  return z
}

function drawCodewords(modules: Cell[][], reserved: boolean[][], codewords: number[]) {
  const bits = codewords.flatMap((byte) => {
    const out: number[] = []
    appendBits(out, byte, 8)
    return out
  })

  let bitIndex = 0
  let upward = true
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--
    for (let vert = 0; vert < SIZE; vert++) {
      const y = upward ? SIZE - 1 - vert : vert
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx
        if (reserved[y]![x]) continue
        const bit: Cell = (bits[bitIndex++] ?? 0) as Cell
        modules[y]![x] = (bit ^ (mask0(x, y) ? 1 : 0)) as Cell
      }
    }
    upward = !upward
  }
}

function mask0(x: number, y: number): boolean {
  return ((x + y) & 1) === 0
}

function drawFormatBits(modules: Cell[][], reserved: boolean[][], mask: number) {
  const bits = getFormatBits(mask)

  for (let i = 0; i <= 5; i++) setModule(modules, reserved, 8, i, ((bits >>> i) & 1) as Cell)
  setModule(modules, reserved, 8, 7, ((bits >>> 6) & 1) as Cell)
  setModule(modules, reserved, 8, 8, ((bits >>> 7) & 1) as Cell)
  setModule(modules, reserved, 7, 8, ((bits >>> 8) & 1) as Cell)
  for (let i = 9; i < 15; i++) setModule(modules, reserved, 14 - i, 8, ((bits >>> i) & 1) as Cell)

  for (let i = 0; i < 8; i++) setModule(modules, reserved, SIZE - 1 - i, 8, ((bits >>> i) & 1) as Cell)
  for (let i = 8; i < 15; i++) setModule(modules, reserved, 8, SIZE - 15 + i, ((bits >>> i) & 1) as Cell)
  setModule(modules, reserved, 8, SIZE - 8, 1)
}

function getFormatBits(mask: number): number {
  const errorCorrectionLevelL = 1
  const data = (errorCorrectionLevelL << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537)
  }
  return ((data << 10) | rem) ^ 0x5412
}
