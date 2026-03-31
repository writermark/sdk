// Web Worker for VDF computation.
// Receives a challenge + difficulty, runs the Wesolowski VDF solve (~2s),
// and posts back the proof. Runs continuously: after completing one proof,
// it waits for the next challenge.

import { WesolowskiVDFParams } from './wesolowski.js'
import { DISCRIMINANT_512 } from './precomputed-discriminants.js'

const VDF_BITS = 512
const vdf = new WesolowskiVDFParams(VDF_BITS).new()

export interface VdfWorkerRequest {
  type: 'solve'
  id: number
  challenge: Uint8Array
  difficulty: number
}

export interface VdfWorkerResponse {
  type: 'result'
  id: number
  proof: Uint8Array
}

const ctx = globalThis as any

ctx.onmessage = async (e: MessageEvent<VdfWorkerRequest>) => {
  const { type, id, challenge, difficulty } = e.data
  if (type !== 'solve') return

  try {
    const proof = await vdf.solve(challenge, difficulty, DISCRIMINANT_512)
    ctx.postMessage({ type: 'result', id, proof } as VdfWorkerResponse)
  } catch (err) {
    ctx.postMessage({ type: 'error', id, error: String(err) })
  }
}
