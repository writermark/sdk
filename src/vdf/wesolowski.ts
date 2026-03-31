// Vendored from crypto-vdf-js (Apache 2.0)
// https://github.com/jose-compu/crypto-vdf-js/blob/main/src/wesolowski.ts

import { ClassGroup, iterateSquarings } from './classgroup.js'
import { createDiscriminant } from './discriminant.js'
import { InvalidProof, InvalidIterations, type VDF } from './types.js'
import { sha256, bytesToBigInt, isProbablePrime, u64ToBytes, modPow } from './utils.js'

export function approximateParameters(t: number): [number, number, number] {
  const logMemory = Math.log2(10_000_000)
  const logT = Math.log2(t)

  const l = logT - logMemory > 0
    ? Math.ceil(Math.pow(2, logMemory - 20))
    : 1

  const intermediate = (t * Math.LN2) / (2 * l)
  const k = Math.max(1, Math.round(
    Math.log(intermediate) - Math.log(Math.log(intermediate)) + 0.25,
  ))

  const w = Math.floor(t / (t / k + l * Math.pow(2, k + 1)) - 2)
  return [l, k, w]
}

function hashPrime(seed: Uint8Array[]): bigint {
  let j = 0n

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const jBytes = u64ToBytes(j)
    const primeBytes = new TextEncoder().encode('prime')

    const allBytes: Uint8Array[] = [primeBytes, jBytes, ...seed]
    const totalLength = allBytes.reduce((sum, arr) => sum + arr.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const arr of allBytes) {
      combined.set(arr, offset)
      offset += arr.length
    }

    const hash = sha256(combined)
    const n = bytesToBigInt(hash.subarray(0, 16))
    if (isProbablePrime(n, 2)) return n
    j++
  }
}

function getBlock(i: number, k: number, t: number, b: bigint): bigint {
  const two = 2n
  const exp = BigInt(t - k * (i + 1))
  let res = modPow(two, exp, b)
  res = (res * ((two >> 1n) << BigInt(k))) / b
  return res
}

function evalOptimized(
  h: ClassGroup, b: bigint, t: number, k: number, l: number,
  powers: Map<number, ClassGroup>,
): ClassGroup {
  const kl = k * l
  const kExp = 1 << k
  const k0 = k >> 1
  const k1 = k - k0
  const k0Exp = 1 << k0
  const k1Exp = 1 << k1

  let x = h.identity()
  const identity = h.identity()

  for (let j = l - 1; j >= 0; j--) {
    x.pow(BigInt(kExp))

    const ys = new Map<bigint, ClassGroup>()
    for (let block = 0; block < kExp; block++) {
      ys.set(BigInt(block), identity.clone())
    }

    const endOfLoop = Math.ceil(t / kl)
    for (let i = 0; i < endOfLoop; i++) {
      if (t < k * (i * l + j + 1)) continue
      const blockValue = getBlock(i * l, k, t, b)
      const power = powers.get(i * kl)!.clone()
      const current = ys.get(blockValue)!
      ys.set(blockValue, current.multiply(power))
    }

    for (let b1 = 0; b1 < k1Exp; b1++) {
      let z = identity.clone()
      for (let b0 = 0; b0 < k0Exp; b0++) {
        z = z.multiply(ys.get(BigInt(b1 * k0Exp + b0))!)
      }
      z.pow(BigInt(b1 * k0Exp))
      x = x.multiply(z)
    }

    for (let b0 = 0; b0 < k0Exp; b0++) {
      let z = identity.clone()
      for (let b1 = 0; b1 < k1Exp; b1++) {
        z = z.multiply(ys.get(BigInt(b1 * k0Exp + b0))!)
      }
      z.pow(BigInt(b0))
      x = x.multiply(z)
    }
  }
  return x
}

export function generateProof(
  x: ClassGroup, iterations: number, k: number, l: number,
  powers: Map<number, ClassGroup>, intSizeBits: number,
): ClassGroup {
  const size = (intSizeBits + 16) >> 4
  const xBuf = x.serialize(size)
  const yBuf = powers.get(iterations)!.serialize(size)
  const b = hashPrime([xBuf, yBuf])
  return evalOptimized(x, b, iterations, k, l, powers)
}

export function verifyProof(
  x: ClassGroup, y: ClassGroup, proof: ClassGroup,
  t: number, intSizeBits: number,
): void {
  const size = (intSizeBits + 16) >> 4
  const xBuf = x.serialize(size)
  const yBuf = y.serialize(size)
  const b = hashPrime([xBuf, yBuf])

  const r = modPow(2n, BigInt(t), b)
  const proofCopy = proof.clone()
  proofCopy.pow(b)
  const xCopy = x.clone()
  xCopy.pow(r)
  const result = proofCopy.multiply(xCopy)

  if (!result.equals(y)) throw new InvalidProof()
}

function serialize(proof: ClassGroup, y: ClassGroup, intSizeBits: number): Uint8Array {
  const size = (intSizeBits + 16) >> 4
  const elementLength = 2 * size
  const result = new Uint8Array(elementLength * 2)
  result.set(y.serialize(size), 0)
  result.set(proof.serialize(size), elementLength)
  return result
}

/**
 * Derive a challenge-dependent starting group element.
 *
 * When using a precomputed discriminant, the challenge must still affect the
 * starting element — otherwise all proofs are identical regardless of input.
 * We hash the challenge to a 256-bit BigInt and raise the generator g=(2,1)
 * to that power, producing a unique starting point per challenge.
 *
 * When the discriminant is derived from the challenge (no precomputed),
 * the standard generator (2, 1) is already unique per challenge.
 */
function deriveStartElement(challenge: Uint8Array, disc: bigint, precomputed: boolean): ClassGroup {
  const g = ClassGroup.fromAbDiscriminant(2n, 1n, disc)
  if (!precomputed) return g

  const h = bytesToBigInt(sha256(challenge).subarray(0, 32))
  const exponent = h < 0n ? -h : h
  if (exponent <= 1n) return g
  const x = g.clone()
  x.pow(exponent)
  return x
}

export class WesolowskiVDF implements VDF {
  constructor(public readonly intSizeBits: number) {}

  checkDifficulty(_difficulty: number): void {
    if (_difficulty <= 0) throw new InvalidIterations('Difficulty must be positive')
  }

  async solve(challenge: Uint8Array, difficulty: number, discriminant?: bigint): Promise<Uint8Array> {
    this.checkDifficulty(difficulty)
    const disc = discriminant ?? createDiscriminant(challenge, this.intSizeBits)
    const x = deriveStartElement(challenge, disc, discriminant !== undefined)

    const [l, k] = approximateParameters(difficulty)
    const q = l * k
    const powersToCalculate: number[] = []
    for (let i = 0; i <= Math.floor(difficulty / q) + 1; i++) {
      powersToCalculate.push(i * q)
    }
    powersToCalculate.push(difficulty)

    const powers = iterateSquarings(x, powersToCalculate)
    const proof = generateProof(x, difficulty, k, l, powers, this.intSizeBits)
    return serialize(proof, powers.get(difficulty)!, this.intSizeBits)
  }

  verify(challenge: Uint8Array, difficulty: number, allegedSolution: Uint8Array, discriminant?: bigint): void {
    this.checkDifficulty(difficulty)
    const disc = discriminant ?? createDiscriminant(challenge, this.intSizeBits)
    const x = deriveStartElement(challenge, disc, discriminant !== undefined)

    const intSize = (this.intSizeBits + 16) >> 4
    const elementLength = 2 * intSize
    if (allegedSolution.length !== elementLength * 2) throw new InvalidProof()

    const y = ClassGroup.fromBytes(allegedSolution.subarray(0, elementLength), disc)
    const proof = ClassGroup.fromBytes(allegedSolution.subarray(elementLength), disc)
    verifyProof(x, y, proof, difficulty, this.intSizeBits)
  }
}

export class WesolowskiVDFParams {
  constructor(public readonly intSizeBits: number) {}
  new(): WesolowskiVDF { return new WesolowskiVDF(this.intSizeBits) }
}
