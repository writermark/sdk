// Vendored from crypto-vdf-js (Apache 2.0), modified to use pure-JS SHA-256.
// Original: https://github.com/jose-compu/crypto-vdf-js/blob/main/src/utils.ts

import { sha256 as sha256Impl } from './sha256.js'

export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  const isNegative = (bytes[0] & 0x80) !== 0

  if (isNegative) {
    let result = 0n
    for (let i = 0; i < bytes.length; i++) {
      result = (result << 8n) | BigInt(bytes[i] ^ 0xff)
    }
    return -(result + 1n)
  } else {
    let result = 0n
    for (let i = 0; i < bytes.length; i++) {
      result = (result << 8n) | BigInt(bytes[i])
    }
    return result
  }
}

export function bigIntToBytes(value: bigint, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  if (value === 0n) return bytes

  if (value < 0n) {
    const notValue = -value - 1n
    const size = bitLength(notValue)
    const newByteSize = Math.ceil((size + 7) / 8)
    const offset = byteLength - newByteSize
    if (offset < 0) throw new Error(`Buffer too small: need ${newByteSize} bytes, got ${byteLength}`)

    for (let i = 0; i < offset; i++) bytes[i] = 0xff
    let n = notValue
    for (let i = byteLength - 1; i >= offset; i--) {
      bytes[i] = Number(n & 0xffn)
      n >>= 8n
    }
    for (let i = offset; i < byteLength; i++) bytes[i] ^= 0xff
  } else {
    const size = bitLength(value)
    const byteLen = Math.ceil((size + 7) / 8)
    const offset = byteLength - byteLen
    if (offset < 0) throw new Error(`Buffer too small: need ${byteLen} bytes, got ${byteLength}`)

    let n = value
    for (let i = byteLength - 1; i >= offset; i--) {
      bytes[i] = Number(n & 0xffn)
      n >>= 8n
    }
  }
  return bytes
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n
  let result = 1n
  base = base % modulus

  while (exponent > 0n) {
    if (exponent % 2n === 1n) result = (result * base) % modulus
    exponent = exponent >> 1n
    base = (base * base) % modulus
  }
  return result
}

export function isProbablePrime(n: bigint, iterations: number = 5): boolean {
  if (n < 2n) return false
  if (n === 2n || n === 3n) return true
  if (n % 2n === 0n) return false

  const smallPrimes = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]
  for (const p of smallPrimes) {
    if (n === p) return true
    if (n % p === 0n) return false
  }

  let d = n - 1n
  let r = 0n
  while (d % 2n === 0n) {
    d /= 2n
    r++
  }

  const witnesses = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]
  const numWitnesses = Math.min(iterations, witnesses.length)

  for (let i = 0; i < numWitnesses; i++) {
    const a = witnesses[i]
    if (a >= n) continue
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) continue

    let continueWitnessLoop = false
    for (let j = 0n; j < r - 1n; j++) {
      x = modPow(x, 2n, n)
      if (x === n - 1n) { continueWitnessLoop = true; break }
    }
    if (!continueWitnessLoop) return false
  }
  return true
}

export function sha256(...inputs: Uint8Array[]): Uint8Array {
  const totalLength = inputs.reduce((sum, arr) => sum + arr.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of inputs) {
    combined.set(arr, offset)
    offset += arr.length
  }
  return sha256Impl(combined)
}

export function bitLength(n: bigint): number {
  if (n === 0n) return 0
  n = n < 0n ? -n : n
  return n.toString(2).length
}

export function setBit(n: bigint, bit: number): bigint {
  return n | (1n << BigInt(bit))
}

export function u64ToBytes(n: number | bigint): Uint8Array {
  let value = typeof n === 'number' ? BigInt(n) : n
  const bytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn)
    value = value >> 8n
  }
  return bytes
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}
