import type { EditorEvent, TelemetryPayload } from '../types.js'
import { normalizeText } from '../normalize.js'

const SDK_VERSION = '0.2.0'

/**
 * Physical key zone mapping (QWERTY keyboard).
 * Maps KeyboardEvent.code to a zone number (0–8) based on
 * standard finger assignment. This lets us analyze digraph
 * timing (zone-pair transitions) without recording which
 * actual character was typed.
 *
 *   0 = left pinky    1 = left ring    2 = left middle
 *   3 = left index    4 = thumbs       5 = right index
 *   6 = right middle  7 = right ring   8 = right pinky
 */
const ZONE_MAP: Record<string, number> = {}
// Left pinky (0)
for (const c of ['Backquote','Digit1','KeyQ','KeyA','KeyZ','Tab','CapsLock','ShiftLeft']) ZONE_MAP[c] = 0
// Left ring (1)
for (const c of ['Digit2','KeyW','KeyS','KeyX']) ZONE_MAP[c] = 1
// Left middle (2)
for (const c of ['Digit3','KeyE','KeyD','KeyC']) ZONE_MAP[c] = 2
// Left index (3)
for (const c of ['Digit4','Digit5','KeyR','KeyT','KeyF','KeyG','KeyV','KeyB']) ZONE_MAP[c] = 3
// Thumbs (4)
for (const c of ['Space']) ZONE_MAP[c] = 4
// Right index (5)
for (const c of ['Digit6','Digit7','KeyY','KeyU','KeyH','KeyJ','KeyN','KeyM']) ZONE_MAP[c] = 5
// Right middle (6)
for (const c of ['Digit8','KeyI','KeyK','Comma']) ZONE_MAP[c] = 6
// Right ring (7)
for (const c of ['Digit9','KeyO','KeyL','Period']) ZONE_MAP[c] = 7
// Right pinky (8)
for (const c of ['Digit0','Minus','Equal','KeyP','BracketLeft','BracketRight','Backslash','Semicolon','Quote','Slash','ShiftRight','Enter','Backspace']) ZONE_MAP[c] = 8

export function getKeyZone(code: string): number | undefined {
  return ZONE_MAP[code]
}

/**
 * Get a high-resolution relative timestamp.
 * Uses performance.now() for sub-millisecond precision in browsers,
 * falls back to Date.now() in environments without it.
 */
function hrtime(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * Writermark Telemetry Collector
 *
 * Attaches to any text input and silently records process telemetry.
 * NEVER captures actual text content — only event types, timestamps,
 * and structural metadata (paste sizes, cursor jumps, key zones).
 *
 * v0.2.0 additions:
 *   - Sub-millisecond timestamps via performance.now()
 *   - keyup events for dwell time (hold duration)
 *   - Key zone (kz) field for digraph/trigraph timing analysis
 */
export class Collector {
  private events: EditorEvent[] = []
  private sessionStart: number = 0
  private started = false
  private sessionId: string
  /** Tracks pending keydowns for dwell time computation */
  private pendingKeys: Map<string, number> = new Map()
  /** Clipboard shadow hash for internal/external paste detection */
  private pendingClipboardHash: string | null = null
  /** Optional listener called whenever a new event is recorded. */
  onEvent: ((event: EditorEvent) => void) | null = null

  constructor() {
    this.sessionId = crypto.randomUUID()
  }

  /** Begin collecting. Call this when the editor opens. */
  start(): void {
    this.sessionStart = hrtime()
    this.events = []
    this.pendingKeys.clear()
    this.started = true
  }

  /** Time since session start, in ms (sub-ms precision) */
  private now(): number {
    return Math.round((hrtime() - this.sessionStart) * 100) / 100
  }

  private _push(ev: EditorEvent): void {
    this.events.push(ev)
    this.onEvent?.(ev)
  }

  // ---- Core typing events ----

  /** Record a character keystroke. Pass KeyboardEvent.code for zone mapping. */
  recordKey(code?: string, pos?: number): void {
    if (!this.started) return
    const t = this.now()
    const ev: EditorEvent = { t, type: 'key' }
    if (code) {
      const kz = getKeyZone(code)
      if (kz !== undefined) ev.kz = kz
      // Track for dwell time
      this.pendingKeys.set(code, t)
    }
    if (pos != null) ev.pos = pos
    this._push(ev)
  }

  /** Record key release. Pass KeyboardEvent.code to compute dwell time. */
  recordKeyUp(code?: string): void {
    if (!this.started) return
    const t = this.now()
    const ev: EditorEvent = { t, type: 'keyup' }
    if (code) {
      const kz = getKeyZone(code)
      if (kz !== undefined) ev.kz = kz
      // Compute dwell time from matching keydown
      const downTime = this.pendingKeys.get(code)
      if (downTime !== undefined) {
        ev.dwell = Math.round((t - downTime) * 100) / 100
        this.pendingKeys.delete(code)
      }
    }
    this._push(ev)
  }

  /** Record a backspace / delete. */
  recordBackspace(code?: string, pos?: number): void {
    if (!this.started) return
    const t = this.now()
    const ev: EditorEvent = { t, type: 'backspace' }
    if (code) {
      const kz = getKeyZone(code)
      if (kz !== undefined) ev.kz = kz
      this.pendingKeys.set(code, t)
    }
    if (pos != null) ev.pos = pos
    this._push(ev)
  }

  /** Record an Enter / newline. */
  recordEnter(code?: string, pos?: number): void {
    if (!this.started) return
    const t = this.now()
    const ev: EditorEvent = { t, type: 'enter' }
    if (code) {
      const kz = getKeyZone(code)
      if (kz !== undefined) ev.kz = kz
      this.pendingKeys.set(code, t)
    }
    if (pos != null) ev.pos = pos
    this._push(ev)
  }

  /**
   * Record a copy/cut event. Hashes the selected text to detect
   * internal paste (rearrangement) vs external paste (injection).
   * The text is never stored — only accessed momentarily for hashing.
   *
   * @param selectedText - The selected text (used only for hash, never stored)
   * @param copyStart    - Start position of the selection in the document
   * @param copyLen      - Length of the selected text
   * @param isCut        - True if this is a cut (not just a copy)
   */
  async recordCopyOrCut(
    selectedText: string,
    copyStart?: number,
    copyLen?: number,
    isCut?: boolean,
  ): Promise<void> {
    if (!this.started || !selectedText) return
    this.pendingClipboardHash = await hashForClipboard(selectedText)

    // Record a copy or cut event with position data for authorship tracking.
    // The server's replay engine uses copyStart/copyLen to buffer the
    // clipboard's authorship tags. For 'cut', it also deletes the range.
    if (copyStart != null && copyLen != null) {
      this._push({
        t: this.now(),
        type: isCut ? 'cut' : 'copy',
        copyStart,
        copyLen,
      })
    }
  }

  /**
   * Record a paste event. If pastedText is provided, it's hashed and
   * compared with the pending clipboard hash to determine if this is
   * an internal (rearrangement) or external (injection) paste.
   * The text is never stored — only accessed momentarily for hashing.
   *
   * If `source` is explicitly provided (e.g. 'certified' when the clipboard
   * contains a writermark token), it overrides the internal/external detection.
   */
  async recordPaste(
    charCount: number,
    pastedText?: string,
    source?: 'internal' | 'external' | 'certified',
    pos?: number,
  ): Promise<void> {
    if (!this.started) return

    let pasteSource: 'internal' | 'external' | 'certified' = source ?? 'external'
    if (!source && pastedText && this.pendingClipboardHash) {
      const pasteHash = await hashForClipboard(pastedText)
      if (pasteHash === this.pendingClipboardHash) {
        pasteSource = 'internal'
      }
    }

    const ev: EditorEvent = {
      t: this.now(),
      type: 'paste',
      pasteLength: charCount,
      pasteSource,
    }
    if (pos != null) ev.pos = pos
    this._push(ev)
  }

  /** Record a non-adjacent cursor movement. */
  recordCursorJump(distance: number): void {
    if (!this.started) return
    if (Math.abs(distance) > 1) {
      this._push({ t: this.now(), type: 'cursor', jumpDistance: Math.abs(distance) })
    }
  }

  /** Record a text selection. */
  recordSelect(length: number): void {
    if (!this.started || length < 2) return
    this._push({ t: this.now(), type: 'select', selectLength: length })
  }

  /** Record an undo action. */
  recordUndo(): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'undo' })
  }

  /** Record a redo action. */
  recordRedo(): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'redo' })
  }

  /** Record window/editor focus. */
  recordFocus(): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'focus' })
  }

  /** Record window/editor blur. */
  recordBlur(): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'blur' })
  }

  /** Record a scroll event. */
  recordScroll(delta: number): void {
    if (!this.started) return
    const last = this.events[this.events.length - 1]
    if (last?.type === 'scroll' && this.now() - last.t < 200) return
    this._push({ t: this.now(), type: 'scroll', scrollDelta: Math.round(delta) })
  }

  /** Record mouse movement (coarsened to zones, not exact pixels). */
  recordMouse(xRatio: number, yRatio: number): void {
    if (!this.started) return
    const last = this.events[this.events.length - 1]
    if (last?.type === 'mouse' && this.now() - last.t < 1000) return
    const zone = Math.floor(xRatio * 4) + Math.floor(yRatio * 4) * 4
    this._push({ t: this.now(), type: 'mouse', zone })
  }

  /** Record tab visibility change. */
  recordVisibility(visible: boolean): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'visibility', visible })
  }

  /** Record IME composition event. */
  recordCompose(): void {
    if (!this.started) return
    this._push({ t: this.now(), type: 'compose' })
  }

  /**
   * Record a precise document mutation derived from TipTap transaction diffing.
   * These carry the ground truth for authorship map updates on the server.
   */
  recordMutation(
    pos: number,
    deleteLen: number,
    insertLen: number,
    insertSource: EditorEvent['insertSource'],
  ): void {
    if (!this.started) return
    this._push({
      t: this.now(),
      type: 'mutation',
      pos,
      deleteLen,
      insertLen,
      insertSource,
    })
  }

  /** Get the current session ID. */
  getSessionId(): string {
    return this.sessionId
  }

  /** Peek at the current events without finalizing. */
  peekEvents(): EditorEvent[] {
    return [...this.events]
  }

  /** Drain events since the given index (for batch sending). */
  drainEventsSince(index: number): EditorEvent[] {
    return this.events.slice(index)
  }

  /** Get total event count. */
  getEventCount(): number {
    return this.events.length
  }

  /**
   * Finalize the telemetry and produce the payload.
   * @param finalText - The final text content (used for hashing — NOT included in payload)
   * @param audioPeaks - Optional audio peaks from the AudioMonitor
   */
  async finalize(
    finalText: string,
    audioPeaks?: Array<{ t: number; amplitude: number }>,
  ): Promise<TelemetryPayload> {
    if (!this.started) {
      throw new Error('Collector was never started. Call start() first.')
    }

    const textHash = await hashText(finalText)
    const wordCount = finalText.trim().split(/\s+/).filter(Boolean).length

    return {
      sessionId: this.sessionId,
      sessionStart: new Date(Date.now() - (hrtime() - this.sessionStart)).toISOString(),
      sessionDurationMs: this.now(),
      finalCharCount: finalText.length,
      finalWordCount: wordCount,
      textHash,
      events: [...this.events],
      audioPeaks: audioPeaks ?? undefined,
      audioEnabled: !!audioPeaks && audioPeaks.length > 0,
      sdkVersion: SDK_VERSION,
    }
  }
}

/**
 * Hash text for clipboard comparison (internal vs external paste).
 * Uses SHA-256. Text is never stored — only the hash transiently.
 */
async function hashForClipboard(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}

async function hashText(text: string): Promise<string> {
  const normalized = normalizeText(text)
  const encoder = new TextEncoder()
  const data = encoder.encode(normalized)

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(normalized).digest('hex')
}
