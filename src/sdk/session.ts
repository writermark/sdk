import type { Collector } from './collector.js'
import type { ScoringResult, CertifyResponse, EditorEvent, AuthorshipMap, VdfState, EvidenceBundle } from '../types.js'
import { normalizeText } from '../normalize.js'
import { computeChunkHashes, buildMerkleTree } from '../attestation/merkle.js'

/**
 * @deprecated Use WritermarkSession from './writermark-session.js' instead.
 *
 * Writermark Streaming Session
 *
 * Wraps a Collector and streams micro-batches of telemetry to the
 * scoring server in real time.
 *
 * KEY CONCEPT: Sessions are tied to a DOCUMENT, not a single sitting.
 *
 * A writer can:
 *   1. Open the editor, write 400 words, close the tab
 *   2. Come back a week later, write 600 more words
 *   3. Publish → finalize
 *
 * Each time they open the editor, a new session starts for the same
 * documentId. The server groups all sessions by documentId. On
 * finalize, the server aggregates telemetry from ALL sessions and
 * scores the full picture.
 *
 * Tab closure: The SDK fires a final flush on `beforeunload` and
 * tells the server the session is pausing. Whatever batches already
 * reached the server are preserved. Events since the last flush
 * (up to 30s of typing) are lost — acceptable for long-form writing.
 *
 * Usage:
 *   // Session 1 (Monday)
 *   const collector = new Collector()
 *   collector.start()
 *   attachToTipTap(editor, collector)
   *   const session = new StreamingSession('https://api.writermark.org', collector, 'chapter-abc')
 *   await session.start()
 *   // ... user writes 400 words, closes tab ...
 *   // (beforeunload fires, session pauses cleanly)
 *
 *   // Session 2 (next week)
 *   const collector2 = new Collector()
 *   collector2.start()
 *   attachToTipTap(editor, collector2)
   *   const session2 = new StreamingSession('https://api.writermark.org', collector2, 'chapter-abc')
 *   await session2.start()
 *   // ... user writes 600 more words, clicks publish ...
 *   const { result, attestation } = await session2.finalize(fullText)
 */

const FLUSH_INTERVAL_MS = 30_000
const FLUSH_FIRST_MS = 3_000
const FLUSH_MIN_EVENTS = 5

export interface SessionResult {
  result: ScoringResult
  attestation: string | null
  certificate: string | null
}

export class StreamingSession {
  private serverUrl: string
  private collector: Collector
  private documentId: string
  private sessionId: string | null = null
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private lastFlushedIndex = 0
  private started = false
  private boundBeforeUnload: (() => void) | null = null

  /**
   * @param serverUrl  - Base URL of the writermark scoring server
   * @param collector  - A Collector instance (already started)
   * @param documentId - Persistent ID for the document being written
   *                     (e.g., chapter ID, post ID, etc.)
   *                     All sessions with the same documentId are
   *                     grouped together for scoring.
   */
  constructor(serverUrl: string, collector: Collector, documentId: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.collector = collector
    this.documentId = documentId
  }

  /**
   * Open a streaming session with the server.
   * Multiple sessions can exist for the same documentId.
   */
  async start(): Promise<void> {
    const res = await fetch(`${this.serverUrl}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientSessionId: this.collector.getSessionId(),
        documentId: this.documentId,
      }),
    })

    if (!res.ok) {
      throw new Error(`Failed to start session: ${res.status}`)
    }

    const data = await res.json() as { sessionId: string; priorSessions: number }
    this.sessionId = data.sessionId
    this.started = true
    this.lastFlushedIndex = 0

    // First flush after 3s so short sessions have streaming data,
    // then every 30s after that.
    this.flushTimer = setTimeout(() => {
      this.flush().catch(console.warn)
      this.flushTimer = setInterval(() => {
        this.flush().catch(console.warn)
      }, FLUSH_INTERVAL_MS)
    }, FLUSH_FIRST_MS)

    // Flush + pause on tab close
    this.boundBeforeUnload = () => this.pause()
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.boundBeforeUnload)
    }
  }

  /**
   * Send a micro-batch of new events since the last flush.
   * Called automatically every 30s, but can be called manually.
   */
  async flush(): Promise<void> {
    if (!this.started || !this.sessionId) return

    const allEvents = this.collector.peekEvents()
    const newEvents = allEvents.slice(this.lastFlushedIndex)

    if (newEvents.length < FLUSH_MIN_EVENTS) return

    try {
      const res = await fetch(`${this.serverUrl}/session/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          events: newEvents,
          batchIndex: this.lastFlushedIndex,
        }),
      })

      if (res.ok) {
        this.lastFlushedIndex = allEvents.length
      }
    } catch {
      // Network error — will retry on next flush
    }
  }

  /**
   * Pause the session (tab closing, navigating away).
   * Flushes remaining events synchronously via sendBeacon,
   * and tells the server the session is pausing (not finalizing).
   * The server keeps all data for this documentId.
   */
  pause(): void {
    if (!this.started || !this.sessionId) return

    // Stop auto-flushing
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Best-effort flush via sendBeacon (works during beforeunload)
    const allEvents = this.collector.peekEvents()
    const newEvents = allEvents.slice(this.lastFlushedIndex)

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // Flush remaining events
      if (newEvents.length > 0) {
        navigator.sendBeacon(
          `${this.serverUrl}/session/batch`,
          new Blob([JSON.stringify({
            sessionId: this.sessionId,
            events: newEvents,
            batchIndex: this.lastFlushedIndex,
          })], { type: 'application/json' })
        )
      }

      // Tell the server this session is pausing
      navigator.sendBeacon(
        `${this.serverUrl}/session/pause`,
        new Blob([JSON.stringify({
          sessionId: this.sessionId,
        })], { type: 'application/json' })
      )
    }

    this.cleanup()
  }

  /**
   * Finalize: publish the document and request an attestation.
   *
   * The server aggregates telemetry from ALL sessions for this
   * documentId (not just the current one), scores the aggregate,
   * and issues an attestation tied to the final text hash.
   */
  async finalize(finalText: string): Promise<SessionResult> {
    if (!this.started || !this.sessionId) {
      throw new Error('Session not started. Call start() first.')
    }

    // Stop auto-flushing
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Build telemetry (hashes the text)
    const telemetry = await this.collector.finalize(finalText)
    const remainingEvents = telemetry.events.slice(this.lastFlushedIndex)

    const res = await fetch(`${this.serverUrl}/session/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        documentId: this.documentId,
        remainingEvents,
        textHash: telemetry.textHash,
        finalCharCount: telemetry.finalCharCount,
        finalWordCount: telemetry.finalWordCount,
        sessionDurationMs: telemetry.sessionDurationMs,
        audioEnabled: telemetry.audioEnabled,
        audioPeaks: telemetry.audioPeaks,
      }),
    })

    if (!res.ok) {
      throw new Error(`Finalization failed: ${res.status}`)
    }

    const data = await res.json() as SessionResult
    this.cleanup()
    return data
  }

  /** Whether the session is currently active. */
  isActive(): boolean {
    return this.started
  }

  /** Clean up all listeners and timers. */
  private cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.boundBeforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.boundBeforeUnload)
      this.boundBeforeUnload = null
    }
    this.started = false
  }

  /**
   * Abort and discard this session entirely.
   * Server-side data for this session is NOT deleted (the
   * document's other sessions still exist). This just stops
   * the client-side session.
   */
  abort(): void {
    this.cleanup()
  }
}


// ============================================================
// ContinuousSession — stateless checkpoint-based certification
// ============================================================

const CERTIFY_INTERVAL_MS = 30_000
const CERTIFY_FIRST_MS = 5_000
const CERTIFY_MIN_EVENTS = 10

export type CertificationStatus = 'idle' | 'certifying' | 'certified' | 'not-certified'

export interface ContinuousSessionOptions {
  /** Base URL of the writermark server */
  serverUrl: string
  /** Persistent document identifier */
  documentId: string
  /** Collector instance (already started) */
  collector: Collector
  /** Returns current plain text of the document */
  getText: () => string
  /** Called on each certification with the new checkpoint */
  onCheckpoint?: (checkpoint: string, score: number, coverage: number, pass: boolean) => void
  /** Called when the certification status changes */
  onStatusChange?: (status: CertificationStatus) => void
  /** Previous checkpoint JWT to resume from (null = fresh start) */
  previousCheckpoint?: string | null
  /** Previous authorship map to resume from (loaded from storage) */
  previousAuthorshipMap?: AuthorshipMap | null
  /** Previous VDF state to resume from (loaded from storage) */
  previousVdfState?: VdfState | null
  /** Previous checkpoint JWTs to resume from (sliding window) */
  previousCheckpoints?: string[]
}

/**
 * @deprecated Use WritermarkSession from './writermark-session.js' instead.
 *
 * ContinuousSession — stateless checkpoint-based certification.
 *
 * Every 30 seconds, sends events + state to /certify and gets back
 * a signed checkpoint (= certificate). Maintains:
 *   - Event ring buffer: last 5 windows (~2.5 min) for ML context
 *   - Checkpoint sliding window: last 5 signed JWTs
 *   - VDF state: cumulative temporal proof
 *   - Authorship map: per-character provenance
 *   - Merkle root: content integrity hash
 *
 * The server is fully stateless — all state travels in the signed
 * checkpoints and the fields below.
 */
export class ContinuousSession {
  private serverUrl: string
  private documentId: string
  private collector: Collector
  private getText: () => string
  private onCheckpoint?: (checkpoint: string, score: number, coverage: number, pass: boolean) => void
  private onStatusChange?: (status: CertificationStatus) => void

  /** Sliding window of the last 5 signed checkpoint JWTs */
  private checkpoints: string[] = []
  private bufferedEvents: EditorEvent[] = []
  /** Ring buffer of events from previous windows (for ML context) */
  private recentEvents: EditorEvent[][] = []
  private lastFlushedIndex = 0
  private certifyTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private status: CertificationStatus = 'idle'
  private boundBeforeUnload: (() => void) | null = null
  /** Current authorship map (round-tripped through the server) */
  private authorshipMap: AuthorshipMap | null = null
  /** Cumulative VDF state */
  private vdfState: VdfState | null = null

  private static readonly MAX_CHECKPOINT_WINDOW = 2
  private static readonly MAX_EVENT_WINDOWS = 4  // previous windows (current is sent separately)

  constructor(options: ContinuousSessionOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '')
    this.documentId = options.documentId
    this.collector = options.collector
    this.getText = options.getText
    this.onCheckpoint = options.onCheckpoint
    this.onStatusChange = options.onStatusChange

    // Resume from previous state
    if (options.previousCheckpoint) {
      this.checkpoints = [options.previousCheckpoint]
    }
    if (options.previousCheckpoints?.length) {
      this.checkpoints = options.previousCheckpoints.slice(-ContinuousSession.MAX_CHECKPOINT_WINDOW)
    }
    this.authorshipMap = options.previousAuthorshipMap ?? null
    this.vdfState = options.previousVdfState ?? null
  }

  /** Start the continuous certification cycle. */
  start(): void {
    if (this.started) return
    this.started = true

    this.certifyTimer = setTimeout(() => {
      this.certify().catch(console.warn)
      this.certifyTimer = setInterval(() => {
        this.certify().catch(console.warn)
      }, CERTIFY_INTERVAL_MS) as unknown as ReturnType<typeof setTimeout>
    }, CERTIFY_FIRST_MS)

    this.boundBeforeUnload = () => this.pause()
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.boundBeforeUnload)
    }
  }

  /** Force an immediate certification round-trip. */
  async certifyNow(): Promise<CertifyResponse | null> {
    return this.certify()
  }

  /** Get the current status. */
  getStatus(): CertificationStatus {
    return this.status
  }

  /** Get the latest checkpoint JWT. */
  getCheckpoint(): string | null {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null
  }

  /** Get all checkpoints in the sliding window. */
  getCheckpoints(): string[] {
    return [...this.checkpoints]
  }

  /** Get the current VDF state (for persistence). */
  getVdfState(): VdfState | null {
    return this.vdfState
  }

  /** Get the current authorship map (for persistence). */
  getAuthorshipMap(): AuthorshipMap | null {
    return this.authorshipMap
  }

  /** Get buffered events (for saving on close). */
  getBufferedEvents(): EditorEvent[] {
    const allEvents = this.collector.peekEvents()
    return allEvents.slice(this.lastFlushedIndex)
  }

  /**
   * Export the three-layer evidence bundle for embedding in a document.
   * Calls the server's /bundle endpoint.
   */
  async exportEvidence(): Promise<EvidenceBundle | null> {
    if (this.checkpoints.length === 0 || !this.vdfState) return null

    try {
      const res = await fetch(`${this.serverUrl}/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recentCheckpoints: this.checkpoints,
          vdfState: this.vdfState,
        }),
      })
      if (!res.ok) return null
      return await res.json() as EvidenceBundle
    } catch {
      return null
    }
  }

  /**
   * Pause the session. Saves state locally — no server call.
   * Use getCheckpoint(), getCheckpoints(), getBufferedEvents(),
   * getVdfState(), getAuthorshipMap() to persist state.
   */
  pause(): void {
    if (this.certifyTimer) {
      clearInterval(this.certifyTimer as unknown as number)
      clearTimeout(this.certifyTimer)
      this.certifyTimer = null
    }
    if (this.boundBeforeUnload && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.boundBeforeUnload)
      this.boundBeforeUnload = null
    }
    this.started = false
  }

  /** Set buffered events from a previous session (loaded from storage). */
  setBufferedEvents(events: EditorEvent[]): void {
    this.bufferedEvents = events
  }

  /** Whether the session is active. */
  isActive(): boolean {
    return this.started
  }

  /** Perform a single certification cycle. */
  private async certify(): Promise<CertifyResponse | null> {
    if (!this.started) return null

    const allEvents = this.collector.peekEvents()
    const newEvents = allEvents.slice(this.lastFlushedIndex)

    if (newEvents.length < CERTIFY_MIN_EVENTS && this.bufferedEvents.length === 0) {
      return null
    }

    const text = this.getText()
    if (!text || text.length < 10) return null

    this.setStatus('certifying')

    try {
      // Compute Merkle root of current document content
      const normalized = normalizeText(text)
      const chunkHashes = await computeChunkHashes(normalized)
      const tree = await buildMerkleTree(chunkHashes)
      const textHash = await hashText(text)

      const body: Record<string, unknown> = {
        documentId: this.documentId,
        events: newEvents,
        // New protocol fields
        checkpoints: this.checkpoints,
        merkleRoot: tree.root || textHash,
        authorshipMap: this.authorshipMap,
        vdfState: this.vdfState,
        recentEvents: this.recentEvents.flat(),
        // Backward compat fields (for TypeScript server)
        textHash,
        charCount: text.length,
        checkpoint: this.getCheckpoint(),
      }

      if (this.bufferedEvents.length > 0) {
        body.bufferedEvents = this.bufferedEvents
      }

      const res = await fetch(`${this.serverUrl}/certify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        console.warn('[writermark] Certification failed:', res.status)
        return null
      }

      const data = await res.json() as CertifyResponse

      // Update checkpoint sliding window
      this.checkpoints.push(data.checkpoint)
      if (this.checkpoints.length > ContinuousSession.MAX_CHECKPOINT_WINDOW) {
        this.checkpoints.shift()
      }

      // Update event ring buffer (push this window's events, drop oldest)
      this.recentEvents.push([...newEvents])
      if (this.recentEvents.length > ContinuousSession.MAX_EVENT_WINDOWS) {
        this.recentEvents.shift()
      }

      // Update authorship map from server response
      if (data.authorshipMap !== undefined) {
        this.authorshipMap = data.authorshipMap
      }

      // Update VDF state from server response
      if (data.vdfState) {
        this.vdfState = data.vdfState
      }

      this.lastFlushedIndex = allEvents.length
      this.bufferedEvents = []

      // Notify
      this.onCheckpoint?.(data.checkpoint, data.score, data.coverage, data.pass)
      this.setStatus(data.pass ? 'certified' : 'not-certified')

      return data
    } catch (err) {
      console.warn('[writermark] Certification error:', err)
      return null
    }
  }

  private setStatus(status: CertificationStatus): void {
    if (status !== this.status) {
      this.status = status
      this.onStatusChange?.(status)
    }
  }
}

// ---- Helpers ----

async function hashText(text: string): Promise<string> {
  const normalized = normalizeText(text)
  const data = new TextEncoder().encode(normalized)

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(normalized).digest('hex')
}
