// VDF Coordinator — manages the per-event VDF checkpoint chain.
//
// Runs on the main thread. Coordinates between:
//   1. The event stream (events pushed here as they arrive)
//   2. The VDF Web Worker (computes proofs in the background)
//
// Every ~2s the worker completes a Wesolowski proof. The coordinator
// hashes the events that accumulated during that period, chains them
// into the next VDF input, and starts the next computation.
//
// At certify time, the coordinator exports the completed checkpoint chain
// for inclusion in the /certify payload.

import { sha256Hex } from './sha256.js'
import type { VdfWorkerRequest, VdfWorkerResponse } from './vdf-worker.js'

const VDF_DIFFICULTY = 100
const VDF_BITS = 512
const IDLE_GAP_MS = 1000

export interface VdfCheckpoint {
  challenge: string
  proof: string
  checkpointHash: string
  eventCount: number
  difficulty: number
}

export interface VdfCoordinatorState {
  currentSeed: string
  checkpoints: VdfCheckpoint[]
  pendingEvents: any[]
  workerBusy: boolean
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function hashEvents(events: any[]): string {
  const json = JSON.stringify(events)
  const data = new TextEncoder().encode(json)
  return sha256Hex(data)
}

function computeVdfInput(previousOutput: string, checkpointHash: string): string {
  const combined = previousOutput + checkpointHash
  const data = new TextEncoder().encode(combined)
  return sha256Hex(data)
}

export class VdfCoordinator {
  private worker: Worker | null = null
  private currentSeed: string
  private currentVdfInput: string | null = null
  private pendingEvents: any[] = []
  private completedCheckpoints: VdfCheckpoint[] = []
  private requestId = 0
  private destroyed = false
  private debug: boolean
  private _idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(initialSeed: string, options?: { debug?: boolean }) {
    this.currentSeed = initialSeed
    this.debug = options?.debug ?? false
    this._startWorker()
  }

  private _startWorker() {
    try {
      this.worker = new Worker(
        new URL('./vdf-worker.js', import.meta.url),
        { type: 'module' },
      )
      this.worker.onmessage = (e: MessageEvent<VdfWorkerResponse>) => {
        this._onWorkerResult(e.data)
      }
      this.worker.onerror = (ev: Event) => {
        const ee = ev as ErrorEvent
        if (this.debug) console.warn('[vdf] worker error:', ee.message ?? ev.type, ee.filename ?? '')
      }

      if (this.debug) console.log('[vdf] worker created, sending first challenge')
      this._sendNextChallenge(this.currentSeed)
    } catch (err) {
      if (this.debug) console.warn('[vdf] failed to create worker:', err)
      this.worker = null
    }
  }

  private _sendNextChallenge(input: string) {
    if (!this.worker || this.destroyed) return

    this.currentVdfInput = input
    const challenge = hexToBytes(input)
    const id = ++this.requestId

    if (this.debug) console.log('[vdf] starting proof', id, 'challenge:', input.slice(0, 16) + '...')

    const msg: VdfWorkerRequest = {
      type: 'solve',
      id,
      challenge,
      difficulty: VDF_DIFFICULTY,
    }
    this.worker.postMessage(msg)
  }

  private _onWorkerResult(data: any) {
    if (this.destroyed) return

    if (data.type === 'error') {
      if (this.debug) console.warn('[vdf] worker solve error:', data.error)
      return
    }

    if (data.type !== 'result') return

    const proof = data.proof as Uint8Array
    const proofHex = bytesToHex(proof)

    // Hash the events that accumulated during this VDF computation
    const boundEvents = [...this.pendingEvents]
    this.pendingEvents = []
    const checkpointHash = hashEvents(boundEvents)

    const checkpoint: VdfCheckpoint = {
      challenge: this.currentVdfInput!,
      proof: proofHex,
      checkpointHash,
      eventCount: boundEvents.length,
      difficulty: VDF_DIFFICULTY,
    }
    this.completedCheckpoints.push(checkpoint)

    if (this.debug) {
      console.log('[vdf] proof', data.id, 'complete:', boundEvents.length, 'events bound')
    }

    // Chain: next input = SHA-256(vdf_output || checkpoint_hash)
    // Wait IDLE_GAP_MS before starting the next proof to avoid pinning
    // a CPU core at 100%. Events arriving during the gap accumulate in
    // pendingEvents and get hashed into the next proof's challenge.
    const nextInput = computeVdfInput(proofHex, checkpointHash)
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      this._sendNextChallenge(nextInput)
    }, IDLE_GAP_MS)
  }

  /** Push an event into the current accumulation window. */
  pushEvent(event: any) {
    if (!this.destroyed) this.pendingEvents.push(event)
  }

  /**
   * Export completed VDF checkpoints for the /certify payload.
   * Returns the checkpoints and clears the internal buffer.
   * Pending events (after the last completed proof) remain unbound.
   */
  flush(): { checkpoints: VdfCheckpoint[]; initialSeed: string; discriminantBits: number } {
    const result = {
      checkpoints: [...this.completedCheckpoints],
      initialSeed: this.currentSeed,
      discriminantBits: VDF_BITS,
    }
    this.completedCheckpoints = []
    return result
  }

  /** Reset with a new seed (e.g., from server response after certify). */
  resetSeed(newSeed: string) {
    this.currentSeed = newSeed
    this.completedCheckpoints = []
    // The worker will pick up the new seed on the next challenge
  }

  /** Whether the VDF worker is running. */
  isActive(): boolean {
    return this.worker !== null && !this.destroyed
  }

  destroy() {
    this.destroyed = true
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }
}

/**
 * Generate a random hex seed for VDF initialization.
 * Uses crypto.getRandomValues (available in browsers and Web Workers).
 */
export function generateVdfSeed(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}
