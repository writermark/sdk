/**
 * WritermarkSession — the universal certification session.
 *
 * One class, four golden paths:
 *
 *   // React + TipTap (via useWritermark wrapper)
 *   const { status } = useWritermark('doc-1', editor, { ... })
 *
 *   // TipTap, no React
 *   const session = new WritermarkSession(editor, { documentId: 'doc-1' })
 *
 *   // Generic DOM (textarea, contenteditable)
 *   const session = new WritermarkSession(document.querySelector('#editor'), { documentId: 'doc-1' })
 *
 *   // Script tag
 *   const session = new Writermark.Session(element, { documentId: 'doc-1' })
 *
 * Handles the full lifecycle: event collection, compression, certification
 * loop, checkpoint management, paste verification, and clipboard enrichment.
 */

import { Collector } from './collector.js'
import {
  attachToTipTap,
  createCertificationContext,
  computeMerkleRoot,
  compressEvents,
  type TipTapEditor,
  type CertificationContext,
} from './tiptap.js'
import { attachToElement } from './generic.js'
import { normalizeText } from '../normalize.js'
import type { AuthorshipMap } from '../types.js'
import { VdfCoordinator, generateVdfSeed, type VdfCheckpoint } from '../vdf/coordinator.js'

export type CertificationStatus = 'idle' | 'certifying' | 'certified' | 'not-certified'

export interface VdfState {
  seed: string
  output: string
  stepCount: number
}

const CERTIFY_INTERVAL_MS = 30_000
const CERTIFY_FIRST_MS = 5_000
const CERTIFY_MIN_EVENTS = 10
const MAX_CHECKPOINTS = 2
const IDLE_EVENTS = new Set(['focus', 'blur', 'visibility', 'scroll', 'mouse'])

async function hashText(text: string): Promise<string> {
  const normalized = normalizeText(text)
  const data = new TextEncoder().encode(normalized)
  const buffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface WritermarkSessionOptions {
  documentId: string
  writermarkUrl?: string
  onCheckpoint?: (
    checkpoint: string,
    coverage: number,
    pass: boolean,
    certificate: string | null,
    authorshipMap: AuthorshipMap | null,
    checkpoints: string[],
    vdfState: VdfState | null,
  ) => void
  onStatusChange?: (status: CertificationStatus) => void
  onCertifyResult?: (data: any) => void
  /** Fires after each successful certify with the full daemon response and the compressed events that were sent. Useful for telemetry / ML training data collection. */
  onCertifyResponse?: (response: any, events: any[]) => void
  previousCheckpoint?: string | null
  previousCheckpoints?: string[] | null
  previousPass?: boolean
  previousAuthorshipMap?: AuthorshipMap | null
  previousVdfState?: VdfState | null
  /** Per-event VDF checkpoint binding. Spawns a Web Worker for background VDF computation (~2s per proof). Enabled by default. Set to false to disable. */
  enableVdf?: boolean
  debug?: boolean
  getText?: () => string
}

function isTipTapEditor(obj: any): obj is TipTapEditor {
  return obj && typeof obj.getText === 'function' && typeof obj.on === 'function' && obj.view && obj.view.dom instanceof HTMLElement
}

export class WritermarkSession {
  private collector: Collector
  private ctx: CertificationContext
  private detach: (() => void) | null = null
  private certifyTimer: ReturnType<typeof setTimeout> | null = null
  private certifyInFlight = false
  private lastFlushedIndex = 0
  private destroyed = false

  private _status: CertificationStatus
  private _certificate: string | null = null
  private _coverage: number | null = null
  private _checkpoints: string[]
  private _vdfState: VdfState | null
  private _previousEvents: any[] = []
  private _vdfCoordinator: VdfCoordinator | null = null

  private writermarkUrl: string
  private documentId: string
  private debug: boolean
  private getText: () => string
  private editor: TipTapEditor | null = null

  private opts: WritermarkSessionOptions

  constructor(
    editorOrElement: TipTapEditor | HTMLElement,
    options: WritermarkSessionOptions,
  ) {
    this.opts = options
    this.documentId = options.documentId
    this.writermarkUrl = options.writermarkUrl || 'https://api.writermark.org'
    this.debug = options.debug ?? false

    // Initialize checkpoint state
    if (options.previousCheckpoints?.length) {
      this._checkpoints = options.previousCheckpoints.slice(-MAX_CHECKPOINTS)
    } else if (options.previousCheckpoint) {
      this._checkpoints = [options.previousCheckpoint]
    } else {
      this._checkpoints = []
    }
    this._vdfState = options.previousVdfState ?? null
    this._status = options.previousCheckpoint
      ? (options.previousPass ? 'certified' : 'not-certified')
      : 'idle'

    // Create collector and context
    this.collector = new Collector()
    this.collector.start()

    this.ctx = createCertificationContext(this.writermarkUrl, {
      checkpoint: options.previousCheckpoint,
      isPassing: options.previousPass,
      authorshipMap: options.previousAuthorshipMap,
      debug: this.debug,
    })

    // Detect editor type and attach
    if (isTipTapEditor(editorOrElement)) {
      this.editor = editorOrElement
      this.getText = options.getText ?? (() => editorOrElement.getText())
      this.detach = attachToTipTap(editorOrElement, this.collector, this.ctx)

      // Pre-compute merkle tree for restored docs
      if (this.ctx.isPassing && this.ctx.checkpoint && !this.ctx.merkleTree) {
        const text = this.getText()
        if (text && text.length > 0) {
          computeMerkleRoot(text, this.ctx).catch(() => {})
        }
      }

      // Wire event-driven scheduling
      editorOrElement.on('update', this._handleUpdate)
    } else {
      this.editor = null
      if (options.getText) {
        this.getText = options.getText
      } else {
        const el = editorOrElement as HTMLTextAreaElement | HTMLInputElement
        if ('value' in el) {
          this.getText = () => el.value
        } else {
          this.getText = () => (editorOrElement as HTMLElement).textContent ?? ''
        }
      }
      this.detach = attachToElement(editorOrElement, this.collector, this.ctx)

      // For generic DOM, listen for input events to schedule certification
      editorOrElement.addEventListener('input', this._handleUpdate)
      this._domElement = editorOrElement
    }

    // Wire flushAndCertify for copy/cut clipboard enrichment
    this.ctx.flushAndCertify = async () => {
      if (this.certifyTimer) {
        clearTimeout(this.certifyTimer)
        this.certifyTimer = null
      }
      const result = await this.certifyNow()
      return result
    }

    // Initialize VDF coordinator (enabled by default)
    if (options.enableVdf !== false) {
      try {
        const seed = generateVdfSeed()
        if (this.debug) console.log('[writermark] VDF initializing, seed:', seed.slice(0, 16) + '...')
        this._vdfCoordinator = new VdfCoordinator(seed, { debug: this.debug })
        this.collector.onEvent = (event) => {
          this._vdfCoordinator?.pushEvent(event)
        }
        if (this.debug) console.log('[writermark] VDF coordinator started, worker active:', this._vdfCoordinator.isActive())
      } catch (err) {
        console.warn('[writermark] VDF init failed (will continue without):', err)
      }
    }

    if (this.debug) console.log('[writermark] session started for', this.documentId)
  }

  private _domElement: HTMLElement | null = null

  private _handleUpdate = () => {
    if (!this.certifyTimer && !this.destroyed) this._scheduleCertify()
  }

  private _scheduleCertify() {
    if (this.certifyTimer || this.destroyed) return
    const delay = this._checkpoints.length > 0 ? CERTIFY_INTERVAL_MS : CERTIFY_FIRST_MS
    if (this.debug) console.log('[writermark] scheduling certify in', delay, 'ms')
    this.certifyTimer = setTimeout(async () => {
      this.certifyTimer = null
      await this._certify()
      this._scheduleIfPending()
    }, delay)
  }

  private _scheduleIfPending() {
    if (this.destroyed) return
    const pending = this.collector.peekEvents().slice(this.lastFlushedIndex)
    const meaningful = pending.filter(e => !IDLE_EVENTS.has(e.type))
    if (meaningful.length >= CERTIFY_MIN_EVENTS) this._scheduleCertify()
  }

  private _setStatus(s: CertificationStatus) {
    this._status = s
    this.opts.onStatusChange?.(s)
  }

  private async _certify(options?: { final?: boolean }): Promise<any> {
    if (this.certifyInFlight || this.destroyed) return null

    const allEvents = this.collector.peekEvents()
    const newEvents = allEvents.slice(this.lastFlushedIndex)
    const meaningfulEvents = newEvents.filter(e => !IDLE_EVENTS.has(e.type))
    if (meaningfulEvents.length < CERTIFY_MIN_EVENTS) {
      if (this.debug) console.log('[writermark] not enough events yet:', meaningfulEvents.length, '/', CERTIFY_MIN_EVENTS)
      return null
    }

    const text = this.getText()
    if (!text || text.length < 10) {
      if (this.debug) console.log('[writermark] text too short:', text?.length ?? 0)
      return null
    }

    this.certifyInFlight = true
    this._setStatus('certifying')

    if (this.debug) {
      const typeCounts: Record<string, number> = {}
      for (const e of newEvents) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
      console.log('[writermark] certifying...', meaningfulEvents.length, 'events,', text.length, 'chars')
      console.log('[writermark] event breakdown:', typeCounts)
    }

    try {
      const textHash = await hashText(text)
      const contentMerkleRoot = await computeMerkleRoot(text, this.ctx)

      const compressed = compressEvents(newEvents)
      if (this.debug && compressed.length !== newEvents.length) {
        console.log('[writermark] compressed', newEvents.length, '\u2192', compressed.length, 'events')
      }

      const body: Record<string, unknown> = {
        documentId: this.documentId,
        events: compressed,
        checkpoints: this._checkpoints,
        merkleRoot: contentMerkleRoot,
        authorshipMap: this.ctx.authorshipMap,
        recentEvents: this._previousEvents,
        textHash,
        charCount: text.length,
      }
      if (this._vdfState) body.vdfState = this._vdfState
      if (options?.final) body.final = true

      // Include per-event VDF checkpoints if coordinator is active
      if (this._vdfCoordinator?.isActive()) {
        const vdfData = this._vdfCoordinator.flush()
        if (vdfData.checkpoints.length > 0) {
          body.vdfCheckpoints = vdfData.checkpoints
          body.vdfDiscriminantBits = vdfData.discriminantBits
          body.vdfInitialSeed = vdfData.initialSeed
        }
      }

      if (this.ctx.pasteVerifications.length > 0) {
        const certifiedMutationIndices: number[] = []
        for (let ci = 0; ci < compressed.length; ci++) {
          if (compressed[ci].type === 'mutation' && compressed[ci].insertSource === 'paste-certified') {
            certifiedMutationIndices.push(ci)
          }
        }
        body.pasteVerifications = this.ctx.pasteVerifications.map((pv: any, pi: number) => ({
          eventIndex: certifiedMutationIndices[pi] ?? pi,
          token: pv.token,
          text: pv.text,
        }))
        this.ctx.pasteVerifications = []
      }

      if (this.debug) console.log('[writermark] POST', `${this.writermarkUrl}/certify`)

      const res = await fetch(`${this.writermarkUrl}/certify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        console.warn('[writermark] certify failed:', res.status, errText)
        this.certifyInFlight = false
        this._setStatus(this._checkpoints.length > 0 ? (this.ctx.isPassing ? 'certified' : 'not-certified') : 'idle')
        return null
      }

      const data = await res.json()
      if (this.debug) {
        console.log('[writermark] certify result:', {
          pass: data.pass, coverage: data.coverage,
          score: data.score, behavioralScore: data.behavioralScore,
        })
      }

      // Update rolling checkpoint window
      this._checkpoints = [...this._checkpoints, data.checkpoint].slice(-MAX_CHECKPOINTS)
      this.ctx.checkpoint = data.checkpoint
      this.ctx.isPassing = data.pass
      if (data.authorshipMap) this.ctx.authorshipMap = data.authorshipMap
      if (data.vdfState) this._vdfState = data.vdfState
      if (data.certificate) this._certificate = data.certificate
      this._previousEvents = compressed
      this._coverage = data.coverage
      this.lastFlushedIndex = allEvents.length

      this._setStatus(data.pass ? 'certified' : 'not-certified')
      this.opts.onCheckpoint?.(data.checkpoint, data.coverage, data.pass, data.certificate ?? null, data.authorshipMap ?? null, this._checkpoints, this._vdfState)
      this.opts.onCertifyResult?.(data)
      this.opts.onCertifyResponse?.(data, compressed)

      this.certifyInFlight = false
      return data
    } catch (err) {
      console.warn('[writermark] certify error:', err)
      this.certifyInFlight = false
      this._setStatus(this._checkpoints.length > 0 ? (this.ctx.isPassing ? 'certified' : 'not-certified') : 'idle')
      return null
    }
  }

  // ---- Public API ----

  getStatus(): CertificationStatus { return this._status }
  getCertificate(): string | null { return this._certificate }
  getCheckpoint(): string | null { return this._checkpoints[this._checkpoints.length - 1] ?? null }
  getCheckpoints(): string[] { return this._checkpoints }
  getVdfState(): VdfState | null { return this._vdfState }
  getAuthorshipMap(): AuthorshipMap | null { return this.ctx?.authorshipMap ?? null }
  getCoverage(): number | null { return this._coverage }
  isActive(): boolean { return !this.destroyed }

  async certifyNow(options?: { final?: boolean }): Promise<any> {
    if (this.certifyTimer) {
      clearTimeout(this.certifyTimer)
      this.certifyTimer = null
    }
    const result = await this._certify(options)
    this._scheduleIfPending()
    return result
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    if (this.certifyTimer) {
      clearTimeout(this.certifyTimer)
      this.certifyTimer = null
    }

    if (this._vdfCoordinator) {
      this._vdfCoordinator.destroy()
      this._vdfCoordinator = null
    }

    if (this.editor) {
      this.editor.off('update', this._handleUpdate)
    }
    if (this._domElement) {
      this._domElement.removeEventListener('input', this._handleUpdate)
    }
    if (this.detach) {
      this.detach()
      this.detach = null
    }

    if (this.debug) console.log('[writermark] session destroyed for', this.documentId)
  }
}
