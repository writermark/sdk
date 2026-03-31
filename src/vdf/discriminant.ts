// Vendored from crypto-vdf-js (Apache 2.0)
// https://github.com/jose-compu/crypto-vdf-js/blob/main/src/discriminant.ts

import { sha256, isProbablePrime, setBit, bytesToBigInt } from './utils.js'

const M = 11_0950_45730n

const RESIDUES = generateResidues()

function generateResidues(): bigint[] {
  const residues: bigint[] = []
  for (let i = 0; i < 65536; i++) {
    const r = BigInt(i) % M
    if (r % 8n === 7n) residues.push(r)
  }
  return residues
}

const SIEVE_INFO: [number, number][] = [
  [3, 2], [5, 4], [7, 6], [11, 10], [13, 12], [17, 16], [19, 18],
  [23, 22], [29, 28], [31, 30], [37, 36], [41, 40], [43, 42],
  [47, 46], [53, 52], [59, 58], [61, 60], [67, 66], [71, 70],
  [73, 72], [79, 78], [83, 82], [89, 88], [97, 96],
]

function randomBytesFromSeed(seed: Uint8Array, byteCount: number): Uint8Array {
  const blob = new Uint8Array(byteCount)
  let offset = 0
  let extra = 0

  while (offset < byteCount) {
    const extraBytes = new Uint8Array(2)
    extraBytes[0] = (extra >> 8) & 0xff
    extraBytes[1] = extra & 0xff
    const hash = sha256(seed, extraBytes)
    const copyLength = Math.min(hash.length, byteCount - offset)
    blob.set(hash.subarray(0, copyLength), offset)
    offset += copyLength
    extra++
  }
  return blob
}

export function createDiscriminant(seed: Uint8Array, length: number): bigint {
  const extra = length & 7
  const randomBytesLen = Math.floor((length + 7) / 8) + 2
  const randomBytes = randomBytesFromSeed(seed, randomBytesLen)

  const nBytes = randomBytes.subarray(0, randomBytesLen - 2)
  const last2 = randomBytes.subarray(randomBytesLen - 2)
  const numerator = (last2[0] << 8) + last2[1]

  let n = bytesToBigInt(nBytes)
  n >>= BigInt((8 - extra) & 7)
  n = setBit(n, length - 1)

  const residue = RESIDUES[numerator % RESIDUES.length]
  const rem = n % M
  if (residue > rem) {
    n += residue - rem
  } else {
    n -= rem - residue
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sieve = new Array(65536).fill(false)
    for (const [p, q] of SIEVE_INFO) {
      let i = Number((n % BigInt(p)) * BigInt(q) % BigInt(p))
      while (i < sieve.length) {
        sieve[i] = true
        i += p
      }
    }
    for (let i = 0; i < sieve.length; i++) {
      if (!sieve[i]) {
        const candidate = n + M * BigInt(i)
        if (candidate % 8n === 7n && isProbablePrime(candidate, 2)) {
          return -candidate
        }
      }
    }
    n += M * 65536n
  }
}
