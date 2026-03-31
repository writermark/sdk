// Vendored from crypto-vdf-js (Apache 2.0)
// https://github.com/jose-compu/crypto-vdf-js/blob/main/src/classgroup.ts

import { bytesToBigInt, bigIntToBytes, bitLength } from './utils.js'

function extendedGCD(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (b === 0n) {
    if (a < 0n) return [-a, -1n, 0n]
    return [a, 1n, 0n]
  }

  let oldR = a, r = b
  let oldS = 1n, s = 0n
  let oldT = 0n, t = 1n

  while (r !== 0n) {
    const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
    ;[oldS, s] = [s, oldS - quotient * s]
    ;[oldT, t] = [t, oldT - quotient * t]
  }

  if (oldR < 0n) return [-oldR, -oldS, -oldT]
  return [oldR, oldS, oldT]
}

function threeGCD(a: bigint, b: bigint, c: bigint): bigint {
  const [g1] = extendedGCD(a, b)
  const [g2] = extendedGCD(g1, c)
  return g2
}

function solveLinearCongruence(a: bigint, b: bigint, m: bigint): [bigint, bigint] {
  const mAbs = m < 0n ? -m : m
  const [g, d] = extendedGCD(a, mAbs)

  const bModG = b % g
  if (bModG !== 0n) {
    throw new Error(`Linear congruence requires exact division: b=${b} not divisible by gcd=${g}`)
  }

  const q = b / g
  const mModG = mAbs % g
  if (mModG !== 0n) {
    throw new Error(`Linear congruence requires exact division: m=${mAbs} not divisible by gcd=${g}`)
  }

  const v = mAbs / g
  const r = q * d
  let mu = r % v
  if (mu < 0n) mu += v

  return [mu, v]
}

export class ClassGroup {
  constructor(
    public a: bigint,
    public b: bigint,
    public c: bigint,
    public discriminant: bigint,
  ) {}

  static fromAbDiscriminant(a: bigint, b: bigint, discriminant: bigint): ClassGroup {
    const c = (b * b - discriminant) / (4n * a)
    return new ClassGroup(a, b, c, discriminant).reduce()
  }

  identity(): ClassGroup {
    return ClassGroup.fromAbDiscriminant(1n, 1n, this.discriminant)
  }

  clone(): ClassGroup {
    return new ClassGroup(this.a, this.b, this.c, this.discriminant)
  }

  private normalize(): void {
    const twoA = 2n * this.a
    let r = this.b % twoA
    if (r < 0n) r += twoA
    if (r > this.a) r -= twoA
    this.c = this.c + (r - this.b) * (r + this.b) / (4n * this.a)
    this.b = r
  }

  reduce(): ClassGroup {
    this.normalize()

    let iterations = 0
    while (this.a > this.c || (this.a === this.c && this.b < 0n)) {
      const s = (this.c + this.b) / (2n * this.c)
      const oldA = this.a
      const oldB = this.b
      this.a = this.c
      this.c = oldA
      this.b = 2n * s * this.a - oldB
      this.c = this.c - s * oldB + s * s * this.a
      this.normalize()
      if (++iterations > 100) break
    }
    return this
  }

  multiply(other: ClassGroup): ClassGroup {
    const g = (this.b + other.b) / 2n
    const h = (other.b - this.b) / 2n
    const w = threeGCD(this.a, other.a, g)
    const j = w
    const s = this.a / w
    const t = other.a / w
    const u = g / w

    const [mu, v] = solveLinearCongruence(t * u, h * u + s * this.c, s * t)
    const [lambda] = solveLinearCongruence(t * v, h - t * mu, s)

    const k = mu + v * lambda
    const l = (k * t - h) / s
    const m = (t * u * k - h * u - this.c * s) / (s * t)

    const A = s * t
    const B = j * u - (k * t + l * s)
    const C = k * l - j * m

    const result = new ClassGroup(A, B, C, this.discriminant)
    result.reduce()
    return result
  }

  square(): void {
    const result = this.multiply(this)
    this.a = result.a
    this.b = result.b
    this.c = result.c
  }

  repeatedSquare(n: number | bigint): void {
    const count = typeof n === 'bigint' ? Number(n) : n
    for (let i = 0; i < count; i++) this.square()
  }

  pow(exponent: bigint): void {
    if (exponent === 0n) {
      const id = this.identity()
      this.a = id.a; this.b = id.b; this.c = id.c
      return
    }
    if (exponent === 1n) return

    const bits = exponent.toString(2)
    let result = this.clone()
    for (let i = 1; i < bits.length; i++) {
      result.square()
      if (bits[i] === '1') result = result.multiply(this)
    }
    this.a = result.a; this.b = result.b; this.c = result.c
  }

  serialize(targetSize?: number): Uint8Array {
    let size: number
    if (targetSize !== undefined) {
      size = targetSize
    } else {
      const discBits = bitLength(-this.discriminant)
      size = (discBits + 16) >> 4
    }

    const totalSize = size * 2
    const result = new Uint8Array(totalSize)
    result.set(bigIntToBytes(this.a, size), 0)
    result.set(bigIntToBytes(this.b, size), size)
    return result
  }

  static fromBytes(bytes: Uint8Array, discriminant: bigint): ClassGroup {
    const size = bytes.length / 2
    const a = bytesToBigInt(bytes.subarray(0, size))
    const b = bytesToBigInt(bytes.subarray(size))
    return ClassGroup.fromAbDiscriminant(a, b, discriminant)
  }

  equals(other: ClassGroup): boolean {
    return this.a === other.a && this.b === other.b &&
      this.c === other.c && this.discriminant === other.discriminant
  }

  static sizeInBits(discriminant: bigint): number {
    return bitLength(-discriminant)
  }
}

export function iterateSquarings(
  x: ClassGroup,
  powersToCalculate: number[],
): Map<number, ClassGroup> {
  const powersCalculated = new Map<number, ClassGroup>()
  const sorted = [...powersToCalculate].sort((a, b) => a - b)
  const current = x.clone()
  let previousPower = 0

  for (const currentPower of sorted) {
    const diff = currentPower - previousPower
    current.repeatedSquare(diff)
    powersCalculated.set(currentPower, current.clone())
    previousPower = currentPower
  }
  return powersCalculated
}
