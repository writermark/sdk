import type { Collector } from './collector.js'

const FLUSH_FIRST_MS = 60 * 1000       // first flush after 60 seconds
const FLUSH_INTERVAL_MS = 5 * 60 * 1000 // subsequent flushes every 5 minutes

interface TelemetryUploaderOptions {
  writermarkUrl?: string
  sourceApp: string
  documentId: string
}

/**
 * Accumulates telemetry events from a Collector and flushes them
 * to the Writermark server every 5 minutes for ML training.
 *
 * Completely fire-and-forget — never blocks or impacts the writing UX.
 * Hashes documentId client-side before sending for privacy.
 */
export class TelemetryUploader {
  private writermarkUrl: string
  private sourceApp: string
  private documentId: string
  private documentIdHash: string | null = null
  private sessionId: string
  private batchIndex = 0
  private lastFlushIndex = 0
  private collector: Collector | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private visibilityHandler: (() => void) | null = null
  private stopped = false

  // Latest certification results to include in telemetry rows
  behavioralScore: number | null = null
  pass: boolean | null = null
  charCount: number | null = null

  constructor(options: TelemetryUploaderOptions) {
    this.writermarkUrl = options.writermarkUrl || 'https://api.writermark.org'
    this.sourceApp = options.sourceApp
    this.documentId = options.documentId
    this.sessionId = 'ts-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    this.hashDocumentId()
  }

  private async hashDocumentId(): Promise<void> {
    try {
      if (typeof globalThis.crypto?.subtle !== 'undefined') {
        const data = new TextEncoder().encode(this.documentId)
        const buffer = await globalThis.crypto.subtle.digest('SHA-256', data)
        this.documentIdHash = Array.from(new Uint8Array(buffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
      }
    } catch {
      // Leave as null if hashing unavailable
    }
  }

  start(collector: Collector): void {
    this.collector = collector
    this.lastFlushIndex = 0
    this.batchIndex = 0
    this.stopped = false

    // First flush quickly so data starts flowing, then switch to longer interval
    this.timer = setTimeout(() => {
      this.flush()
      if (!this.stopped) {
        this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
      }
    }, FLUSH_FIRST_MS) as unknown as ReturnType<typeof setInterval>

    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') this.flush()
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
  }

  stop(): void {
    this.stopped = true
    this.flush()

    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }

    this.collector = null
  }

  private flush(): void {
    if (!this.collector) return

    const allEvents = this.collector.peekEvents()
    const newEvents = allEvents.slice(this.lastFlushIndex)
    if (newEvents.length === 0) return

    const NON_TYPING = new Set(['visibility', 'focus', 'blur'])
    if (!newEvents.some((e: any) => !NON_TYPING.has(e.type))) return

    this.lastFlushIndex = allEvents.length

    const body = {
      sessionId: this.sessionId,
      batchIndex: this.batchIndex,
      documentIdHash: this.documentIdHash,
      sourceApp: this.sourceApp,
      events: newEvents,
      charCount: this.charCount,
      sessionDurationMs: newEvents.length > 0 ? newEvents[newEvents.length - 1].t : 0,
      behavioralScore: this.behavioralScore,
      pass: this.pass,
      sdkVersion: '0.5.0',
    }

    this.batchIndex++

    // Fire-and-forget — never await, never throw
    fetch(`${this.writermarkUrl}/telemetry/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  }
}
