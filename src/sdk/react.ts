/**
 * Writermark React Integration — the single source of truth.
 *
 * Both Wintertext and Sondernote (and any future app) import this hook
 * instead of maintaining their own copy. All Writermark client-side
 * logic lives in the humanproof package.
 *
 * Usage:
 *   import { useWritermark } from 'writermark/sdk/react'
 *
 *   const { status, coverage, certificate } = useWritermark(documentId, editor, {
 *     onCheckpoint: (checkpoint, coverage, pass, certificate, authorshipMap) => { ... },
 *   })
 */

import { useRef, useEffect, useCallback, useState, createElement } from 'react'
import { Collector } from './collector.js'
import {
  attachToTipTap,
  createCertificationContext,
  computeMerkleRoot,
  compressEvents,
  type TipTapEditor,
  type CertificationContext,
} from './tiptap.js'
import { normalizeText } from '../normalize.js'
import type { AuthorshipMap } from '../types.js'
import { TelemetryUploader } from './telemetry-uploader.js'
import { getTelemetryConsent, setTelemetryConsent } from './consent.js'
import { VdfCoordinator, generateVdfSeed } from '../vdf/coordinator.js'

export type { TipTapEditor, CertificationContext, PendingPasteVerification } from './tiptap.js'
export { Collector } from './collector.js'
export {
  attachToTipTap,
  createCertificationContext,
  computeMerkleRoot,
  compressEvents,
} from './tiptap.js'

export { getTelemetryConsent, setTelemetryConsent } from './consent.js'
export { WritermarkSession } from './writermark-session.js'
export type { WritermarkSessionOptions } from './writermark-session.js'
export { verify, verifyFile, extractFromFile, stripCertificateFooter } from './verify.js'
export type { VerifyOptions, VerifyResult, VerifyFileResult, VerifyFileOptions, ExtractedFile } from './verify.js'

export type { CertificationStatus, VdfState } from './writermark-session.js'
import type { CertificationStatus, VdfState } from './writermark-session.js'

const CERTIFY_INTERVAL_MS = 30_000
const CERTIFY_FIRST_MS = 5_000
const CERTIFY_MIN_EVENTS = 10
const IDLE_EVENTS = new Set(['focus', 'blur', 'visibility', 'scroll', 'mouse'])

export interface UseWritermarkOptions {
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
  previousCheckpoint?: string | null
  previousCheckpoints?: string[] | null
  previousPass?: boolean
  previousAuthorshipMap?: AuthorshipMap | null
  previousVdfState?: VdfState | null
  debug?: boolean
  telemetryConsent?: boolean
  sourceApp?: string
  /** Fires after each successful certify with the full daemon response and the compressed events that were sent. Useful for telemetry / ML training data collection. */
  onCertifyResponse?: (response: any, events: any[]) => void
}

export interface UseWritermarkReturn {
  status: CertificationStatus
  coverage: number | null
  lastCertifiedAt: string | null
  certifyNow: () => Promise<any>
  checkpoint: string | null
  certificate: string | null
  authorshipMap: AuthorshipMap | null
  isTracking: boolean
}

async function hashText(text: string): Promise<string> {
  const normalized = normalizeText(text)
  const data = new TextEncoder().encode(normalized)
  const buffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function useWritermark(
  documentId: string | null,
  editor: TipTapEditor | null,
  options: UseWritermarkOptions,
): UseWritermarkReturn {
  const writermarkUrl = options.writermarkUrl || 'https://api.writermark.org'
  const debug = options.debug ?? false

  const collectorRef = useRef<Collector | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const attachedEditorRef = useRef<TipTapEditor | null>(null)
  const certifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushedIndexRef = useRef(0)
  const ctxRef = useRef<CertificationContext | null>(null)
  const uploaderRef = useRef<TelemetryUploader | null>(null)
  const vdfCoordinatorRef = useRef<VdfCoordinator | null>(null)
  const documentIdRef = useRef(documentId)
  documentIdRef.current = documentId
  const onCheckpointRef = useRef(options.onCheckpoint)
  onCheckpointRef.current = options.onCheckpoint
  const onCertifyResponseRef = useRef(options.onCertifyResponse)
  onCertifyResponseRef.current = options.onCertifyResponse
  const editorRef = useRef(editor)
  editorRef.current = editor
  const previousAuthorshipMapRef = useRef(options.previousAuthorshipMap)
  previousAuthorshipMapRef.current = options.previousAuthorshipMap

  const initialStatus: CertificationStatus = options.previousCheckpoint
    ? (options.previousPass ? 'certified' : 'not-certified')
    : 'idle'

  const [status, setStatus] = useState<CertificationStatus>(initialStatus)
  const [coverage, setCoverage] = useState<number | null>(null)
  const [lastCertifiedAt, setLastCertifiedAt] = useState<string | null>(null)
  const [certificate, setCertificate] = useState<string | null>(null)
  const MAX_CHECKPOINTS = 2

  const initCheckpoints = (): string[] => {
    if (options.previousCheckpoints?.length) return options.previousCheckpoints.slice(-MAX_CHECKPOINTS)
    if (options.previousCheckpoint) return [options.previousCheckpoint]
    return []
  }
  const checkpointsRef = useRef<string[]>(initCheckpoints())
  const checkpointRef = useRef<string | null>(options.previousCheckpoint ?? checkpointsRef.current[checkpointsRef.current.length - 1] ?? null)
  const vdfStateRef = useRef<VdfState | null>(options.previousVdfState ?? null)
  const previousEventsRef = useRef<any[]>([])
  const certifyInFlightRef = useRef(false)

  // Initialize collector + context when documentId changes
  useEffect(() => {
    const restoredCheckpoints = initCheckpoints()
    checkpointsRef.current = restoredCheckpoints
    checkpointRef.current = restoredCheckpoints[restoredCheckpoints.length - 1] ?? options.previousCheckpoint ?? null
    vdfStateRef.current = options.previousVdfState ?? null
    previousEventsRef.current = []
    setCertificate(null)
    certifyInFlightRef.current = false

    const restoredStatus: CertificationStatus = options.previousCheckpoint
      ? (options.previousPass ? 'certified' : 'not-certified')
      : 'idle'
    setStatus(restoredStatus)
    setCoverage(null)
    setLastCertifiedAt(null)

    if (!documentId || !writermarkUrl) {
      if (debug) console.log('[writermark] skipping init — documentId:', documentId, 'url:', writermarkUrl || '(empty)')
      return
    }

    if (debug) console.log('[writermark] collector started for', documentId, 'previousCheckpoint:', !!options.previousCheckpoint)

    const collector = new Collector()
    collector.start()
    collectorRef.current = collector
    lastFlushedIndexRef.current = 0

    // Initialize VDF coordinator
    try {
      const seed = generateVdfSeed()
      const vdfCoord = new VdfCoordinator(seed, { debug })
      collector.onEvent = (event) => vdfCoord.pushEvent(event)
      vdfCoordinatorRef.current = vdfCoord
      if (debug) console.log('[writermark] VDF coordinator started, worker active:', vdfCoord.isActive())
    } catch (err) {
      if (debug) console.warn('[writermark] VDF init failed (continuing without):', err)
    }

    const ctx = createCertificationContext(writermarkUrl, {
      checkpoint: options.previousCheckpoint,
      isPassing: options.previousPass,
      authorshipMap: previousAuthorshipMapRef.current,
      debug,
    })
    ctxRef.current = ctx

    return () => {
      vdfCoordinatorRef.current?.destroy()
      vdfCoordinatorRef.current = null
      collectorRef.current = null
      ctxRef.current = null
      checkpointRef.current = null
      setCertificate(null)
    }
  }, [documentId])

  // Telemetry uploader — separate effect so consenting mid-session starts it immediately
  useEffect(() => {
    if (!documentId || !writermarkUrl || !options.telemetryConsent || !options.sourceApp || !collectorRef.current) {
      return
    }

    const uploader = new TelemetryUploader({
      writermarkUrl,
      sourceApp: options.sourceApp,
      documentId,
    })
    uploader.start(collectorRef.current)
    uploaderRef.current = uploader
    if (debug) console.log('[writermark] telemetry uploader started for', options.sourceApp)

    return () => {
      uploader.stop()
      uploaderRef.current = null
    }
  }, [documentId, options.telemetryConsent])

  // Attach to TipTap editor
  useEffect(() => {
    if (!editor || !collectorRef.current || !ctxRef.current) return
    if (attachedEditorRef.current === editor) return

    if (cleanupRef.current) cleanupRef.current()

    cleanupRef.current = attachToTipTap(editor, collectorRef.current, ctxRef.current)
    attachedEditorRef.current = editor

    // Pre-compute merkle tree so copy enrichment works immediately on restored docs
    const ctx = ctxRef.current
    if (ctx && ctx.isPassing && ctx.checkpoint && !ctx.merkleTree) {
      const text = editor.getText()
      if (text && text.length > 0) {
        computeMerkleRoot(text, ctx).then(() => {
          if (debug) console.log('[writermark] merkle tree pre-computed for restored doc')
        }).catch(() => {})
      }
    }

    return () => {
      if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null }
      attachedEditorRef.current = null
    }
  }, [editor])

  // Certification cycle
  const certify = useCallback(async () => {
    if (certifyInFlightRef.current) return null
    const ed = editorRef.current
    const ctx = ctxRef.current
    if (!collectorRef.current || !ed || !documentId || !writermarkUrl || !ctx) return null

    const allEvents = collectorRef.current.peekEvents()
    const newEvents = allEvents.slice(lastFlushedIndexRef.current)
    const meaningfulEvents = newEvents.filter(e => !IDLE_EVENTS.has(e.type))
    if (meaningfulEvents.length < CERTIFY_MIN_EVENTS) {
      if (debug) console.log('[writermark] not enough events yet:', meaningfulEvents.length, '/', CERTIFY_MIN_EVENTS)
      return null
    }

    const text = ed.getText()
    if (!text || text.length < 10) {
      if (debug) console.log('[writermark] text too short:', text?.length ?? 0)
      return null
    }

    certifyInFlightRef.current = true
    setStatus('certifying')

    if (debug) {
      const typeCounts: Record<string, number> = {}
      for (const e of newEvents) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
      const mutationEvents = newEvents.filter(e => e.type === 'mutation')
      console.log('[writermark] certifying...', meaningfulEvents.length, 'events,', text.length, 'chars')
      console.log('[writermark] event breakdown:', typeCounts)
      if (mutationEvents.length > 0) {
        console.log('[writermark] mutations:', mutationEvents.map(e => ({ pos: e.pos, del: e.deleteLen, ins: e.insertLen, src: e.insertSource })))
      }
      console.log('[writermark] authorshipMap sent:', ctx.authorshipMap)
    }

    try {
      const textHash = await hashText(text)
      const contentMerkleRoot = await computeMerkleRoot(text, ctx)

      const compressed = compressEvents(newEvents)
      if (debug && compressed.length !== newEvents.length) {
        console.log('[writermark] compressed', newEvents.length, '→', compressed.length, 'events')
      }

      const body: Record<string, unknown> = {
        documentId,
        events: compressed,
        checkpoints: checkpointsRef.current,
        merkleRoot: contentMerkleRoot,
        authorshipMap: ctx.authorshipMap,
        recentEvents: previousEventsRef.current,
        textHash,
        charCount: text.length,
      }
      if (vdfStateRef.current) body.vdfState = vdfStateRef.current

      // Flush per-event VDF checkpoints into the request
      const vdfCoord = vdfCoordinatorRef.current
      if (vdfCoord?.isActive()) {
        const vdfData = vdfCoord.flush()
        if (vdfData.checkpoints.length > 0) {
          body.vdfCheckpoints = vdfData.checkpoints
          body.vdfInitialSeed = vdfData.initialSeed
          body.vdfDiscriminantBits = vdfData.discriminantBits
          if (debug) console.log('[writermark] sending', vdfData.checkpoints.length, 'VDF checkpoints')
        }
      }

      if (ctx.pasteVerifications.length > 0) {
        // Map paste verifications to the compressed event indices.
        // The pasteVerification.eventIndex points to the paste event in
        // the raw collector, but the daemon needs the index of the
        // mutation event with insertSource='paste-certified' in the
        // compressed events array.
        const certifiedMutationIndices: number[] = []
        for (let ci = 0; ci < compressed.length; ci++) {
          if (compressed[ci].type === 'mutation' && compressed[ci].insertSource === 'paste-certified') {
            certifiedMutationIndices.push(ci)
          }
        }
        body.pasteVerifications = ctx.pasteVerifications.map((pv, pi) => ({
          eventIndex: certifiedMutationIndices[pi] ?? pi,
          token: pv.token,
          text: pv.text,
        }))
        ctx.pasteVerifications = []
      }

      const url = `${writermarkUrl}/certify`
      if (debug) console.log('[writermark] POST', url)

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        console.warn('[writermark] certify failed:', res.status, errText)
        certifyInFlightRef.current = false
        setStatus(checkpointRef.current ? (ctx.isPassing ? 'certified' : 'not-certified') : 'idle')
        return null
      }

      // Guard: if the user switched documents while the fetch was in-flight,
      // discard this result to prevent cross-document checkpoint contamination.
      if (documentId !== documentIdRef.current) {
        if (debug) console.log('[writermark] discarding certify result — document changed from', documentId, 'to', documentIdRef.current)
        certifyInFlightRef.current = false
        return null
      }

      const data = await res.json()
      if (debug) {
        console.log('[writermark] certify result:', {
          pass: data.pass,
          coverage: data.coverage,
          score: data.score,
          behavioralScore: data.behavioralScore,
          confidence: data.confidence,
        })
        if (data.signals) {
          console.log('[writermark] signals:')
          for (const s of data.signals) {
            console.log(`  ${s.name}: score=${s.score} confidence=${s.confidence} ${s.reason ?? ''}`)
          }
        }
        if (data.authorshipMap) console.log('[writermark] server authorshipMap:', data.authorshipMap)
      }

      // Update rolling checkpoint window (N=2)
      const updatedCheckpoints = [...checkpointsRef.current, data.checkpoint].slice(-MAX_CHECKPOINTS)
      checkpointsRef.current = updatedCheckpoints
      checkpointRef.current = data.checkpoint
      ctx.checkpoint = data.checkpoint
      ctx.isPassing = data.pass
      if (data.authorshipMap) ctx.authorshipMap = data.authorshipMap
      if (data.vdfState) vdfStateRef.current = data.vdfState
      if (data.certificate) setCertificate(data.certificate)
      previousEventsRef.current = compressed
      lastFlushedIndexRef.current = allEvents.length

      // Feed latest scores to telemetry uploader
      if (uploaderRef.current) {
        uploaderRef.current.behavioralScore = data.behavioralScore ?? null
        uploaderRef.current.pass = data.pass
        uploaderRef.current.charCount = text.length
      }

      // Update React state
      setCoverage(data.coverage)
      setLastCertifiedAt(new Date().toISOString())
      setStatus(data.pass ? 'certified' : 'not-certified')
      onCheckpointRef.current?.(data.checkpoint, data.coverage, data.pass, data.certificate ?? null, data.authorshipMap ?? null, updatedCheckpoints, vdfStateRef.current)
      onCertifyResponseRef.current?.(data, compressed)

      certifyInFlightRef.current = false
      return data
    } catch (err) {
      console.warn('[writermark] certify error:', err)
      certifyInFlightRef.current = false
      setStatus(checkpointRef.current ? (ctxRef.current?.isPassing ? 'certified' : 'not-certified') : 'idle')
      return null
    }
  }, [documentId])

  // Schedule certification on typing activity
  const scheduleCertify = useCallback(() => {
    if (certifyTimerRef.current) return
    const delay = checkpointRef.current ? CERTIFY_INTERVAL_MS : CERTIFY_FIRST_MS
    if (debug) console.log('[writermark] scheduling certify in', delay, 'ms')
    certifyTimerRef.current = setTimeout(async () => {
      certifyTimerRef.current = null
      await certify()
      if (collectorRef.current) {
        const pending = collectorRef.current.peekEvents().slice(lastFlushedIndexRef.current)
        const meaningful = pending.filter(e => !IDLE_EVENTS.has(e.type))
        if (meaningful.length >= CERTIFY_MIN_EVENTS) scheduleCertify()
      }
    }, delay)
  }, [certify])

  // Expose flush+certify to the copy handler so it can force-sync the Merkle tree
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.flushAndCertify = async () => {
      // Clear the pending timer so the 30s window resets after this forced certify
      if (certifyTimerRef.current) {
        clearTimeout(certifyTimerRef.current)
        certifyTimerRef.current = null
      }
      const result = await certify()
      // Reschedule if there are still pending events
      if (collectorRef.current) {
        const pending = collectorRef.current.peekEvents().slice(lastFlushedIndexRef.current)
        const meaningful = pending.filter(e => !IDLE_EVENTS.has(e.type))
        if (meaningful.length >= CERTIFY_MIN_EVENTS) scheduleCertify()
      }
      return result
    }
    return () => { if (ctx) ctx.flushAndCertify = undefined }
  }, [certify, scheduleCertify])

  // Wire up event-driven scheduling
  useEffect(() => {
    if (!editor || !collectorRef.current || !documentId || !writermarkUrl) {
      if (debug) console.log('[writermark] update listener skipped — editor:', !!editor, 'collector:', !!collectorRef.current, 'docId:', !!documentId, 'url:', !!writermarkUrl)
      return
    }
    if (debug) console.log('[writermark] attached update listener')
    const handleUpdate = () => {
      if (!certifyTimerRef.current) scheduleCertify()
    }
    editor.on('update', handleUpdate)
    return () => {
      editor.off('update', handleUpdate)
      if (certifyTimerRef.current) {
        clearTimeout(certifyTimerRef.current)
        certifyTimerRef.current = null
      }
    }
  }, [editor, documentId, scheduleCertify])

  return {
    status,
    coverage,
    lastCertifiedAt,
    certifyNow: certify,
    checkpoint: checkpointRef.current,
    certificate,
    authorshipMap: ctxRef.current?.authorshipMap ?? null,
    isTracking: !!collectorRef.current && !!editor,
  }
}

// ---- Telemetry Consent Banner ----

export interface TelemetryConsentBannerProps {
  sourceApp: string
  onConsent?: (consented: boolean) => void
  className?: string
}

const bannerStyles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    bottom: '1rem',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: '460px',
    width: 'calc(100% - 2rem)',
    background: '#ffffff',
    border: '1px solid #e4e4e7',
    borderRadius: '0.75rem',
    padding: '1rem 1.25rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    zIndex: 9999,
    boxShadow: '0 4px 24px rgba(0,0,0,0.1)',
  },
  title: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: '#18181b',
    marginBottom: '0.4rem',
  },
  body: {
    fontSize: '0.8rem',
    color: '#52525b',
    lineHeight: 1.5,
    marginBottom: '0.75rem',
  },
  buttons: {
    display: 'flex',
    gap: '0.5rem',
  },
  allowBtn: {
    padding: '0.4rem 1rem',
    borderRadius: '0.375rem',
    border: 'none',
    background: '#34d399',
    color: '#0e0e10',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  declineBtn: {
    padding: '0.4rem 1rem',
    borderRadius: '0.375rem',
    border: '1px solid #d4d4d8',
    background: 'transparent',
    color: '#71717a',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
}

/**
 * Non-blocking consent banner for opt-in telemetry collection.
 * Only renders when: (1) sourceApp is provided, (2) user hasn't answered yet.
 */
export function TelemetryConsentBanner({ sourceApp, onConsent, className }: TelemetryConsentBannerProps) {
  const [visible, setVisible] = useState(() => {
    if (!sourceApp) return false
    return getTelemetryConsent() === null
  })

  if (!visible) return null

  const handleChoice = (allow: boolean) => {
    setTelemetryConsent(allow)
    setVisible(false)
    onConsent?.(allow)
  }

  return createElement('div', { className, style: className ? undefined : bannerStyles.container },
    createElement('div', { style: bannerStyles.title }, 'Please consider helping to keep human writing verifiable!'),
    createElement('div', { style: bannerStyles.body },
      'Before you decide, remember \u2014 Writermark never collects any personal information, and never stores the content of your written text. It collects only anonymous, raw telemetric data about your typing. May we use your data to further improve the Writermark system?'
    ),
    createElement('div', { style: bannerStyles.buttons },
      createElement('button', { style: bannerStyles.allowBtn, onClick: () => handleChoice(true) }, 'Allow'),
      createElement('button', { style: bannerStyles.declineBtn, onClick: () => handleChoice(false) }, 'No thanks'),
    ),
  )
}

// ---- Certification Status Indicator ----

function _decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const p = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(p))
  } catch { return null }
}

export function formatCertificateText(token: string, writermarkUrl?: string): string {
  const base = writermarkUrl || 'https://writermark.org'
  const p = _decodeJwt(token)
  if (!p) return token
  const score = typeof p.score === 'number' ? (p.score as number).toFixed(2) : '?'
  const confidence = typeof p.confidence === 'number' ? Math.round((p.confidence as number) * 100) + '%' : '?'
  const pass = p.pass ? 'VERIFIED HUMAN' : 'NOT VERIFIED'
  const date = typeof p.issuedAt === 'string'
    ? (p.issuedAt as string).split('T')[0]
    : typeof p.serverIssuedAt === 'string'
    ? (p.serverIssuedAt as string).slice(0, 10)
    : new Date().toISOString().slice(0, 10)
  const textHash = typeof p.textHash === 'string' ? (p.textHash as string) : '?'
  return [
    '\u2550\u2550\u2550 WRITERMARK CERTIFICATE \u2550\u2550\u2550',
    `Status: ${pass}`,
    `Score: ${score} / 1.00`,
    `Confidence: ${confidence}`,
    `Date: ${date}`,
    `Text hash: ${textHash}`,
    '\u2500\u2500\u2500',
    `View: ${base}/c/${token}`,
    `Verify: ${base}/verify`,
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
  ].join('\n')
}

export interface CertIndicatorProps {
  status: CertificationStatus
  certificate: string | null
  writermarkUrl?: string
  className?: string
  certifyNow?: () => Promise<any>
}

const _CI = {
  green: '#22c55e',
  gray: '#a1a1aa',
  lightGray: '#d4d4d8',
  veryLight: '#e4e4e7',
  text: '#18181b',
  muted: '#71717a',
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
}

/**
 * Drop-in certification status indicator. Shows a colored dot, label,
 * and a hover popup with score details + copy/view actions.
 * Zero external dependencies — uses only inline styles and createElement.
 */
export function CertIndicator({ status, certificate, writermarkUrl, className, certifyNow }: CertIndicatorProps) {
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const baseUrl = writermarkUrl || 'https://writermark.org'

  const dotBg = status === 'certifying' ? _CI.gray
    : status === 'certified' ? _CI.green
    : status === 'not-certified' ? _CI.lightGray
    : _CI.veryLight

  const label = status === 'certifying' ? 'Certifying'
    : status === 'certified' ? 'Certified'
    : status === 'not-certified' ? 'Not certified'
    : 'Not certified'

  const payload = certificate ? _decodeJwt(certificate) : null

  const doCopy = async () => {
    if (busy) return
    let cert = certificate
    if (certifyNow) {
      setBusy(true)
      try {
        const result = await certifyNow()
        if (result?.certificate) cert = result.certificate
      } catch {}
      setBusy(false)
    }
    if (!cert) return
    const certText = formatCertificateText(cert, writermarkUrl)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(certText).catch(() => {})
    } else {
      const ta = document.createElement('textarea')
      ta.value = certText
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Build popup body
  let popupBody: any
  if (status === 'certified' && payload) {
    const rows: any[] = [
      createElement('div', { key: 'st', style: { fontWeight: 600, color: _CI.green, marginBottom: 4 } },
        payload.pass ? 'Verified Human' : 'Not Verified'),
      createElement('div', { key: 'sc', style: { display: 'flex', justifyContent: 'space-between', gap: 16, color: _CI.muted } },
        createElement('span', null, 'Score'),
        createElement('span', { style: { color: _CI.text } },
          typeof payload.score === 'number' ? (payload.score as number).toFixed(2) : '\u2013')),
      createElement('div', { key: 'co', style: { display: 'flex', justifyContent: 'space-between', gap: 16, color: _CI.muted } },
        createElement('span', null, 'Confidence'),
        createElement('span', { style: { color: _CI.text } },
          typeof payload.confidence === 'number' ? Math.round((payload.confidence as number) * 100) + '%' : '\u2013')),
    ]
    if (typeof payload.textHash === 'string') {
      rows.push(createElement('div', {
        key: 'th', style: { fontSize: 10, fontFamily: 'monospace', color: _CI.muted, marginTop: 2 },
      }, (payload.textHash as string).slice(0, 24) + '\u2026'))
    }
    rows.push(createElement('div', {
      key: 'act', style: { marginTop: 6, display: 'flex', flexDirection: 'column' as const, gap: 4 },
    },
      createElement('button', {
        key: 'cp',
        onClick: (e: any) => { e.stopPropagation(); doCopy() },
        style: {
          background: 'none', border: 'none', padding: 0, margin: 0,
          cursor: busy ? 'wait' : 'pointer', fontSize: 10,
          color: busy ? _CI.muted : copied ? _CI.green : _CI.muted,
          textAlign: 'left' as const, fontFamily: _CI.font,
        },
      }, busy ? 'Certifying\u2026' : copied ? '\u2713 Copied!' : 'Copy certificate'),
      createElement('button', {
        key: 'vw',
        onClick: async (e: any) => {
          e.stopPropagation()
          let cert = certificate
          if (certifyNow) {
            setBusy(true)
            try {
              const result = await certifyNow()
              if (result?.certificate) cert = result.certificate
            } catch {}
            setBusy(false)
          }
          if (cert) window.open(`${baseUrl}/c/${cert}`, '_blank')
        },
        style: {
          background: 'none', border: 'none', padding: 0, margin: 0,
          cursor: busy ? 'wait' : 'pointer', fontSize: 10, color: _CI.muted,
          textAlign: 'left' as const, fontFamily: _CI.font,
        },
      }, 'View certificate \u2197'),
    ))
    popupBody = rows
  } else {
    const msg = status === 'certifying'
      ? 'Verifying your writing process\u2026'
      : status === 'not-certified'
      ? 'Keep writing to build enough data for certification.'
      : 'Start writing to begin human-authorship verification.'
    popupBody = [createElement('span', { key: 'msg', style: { color: _CI.muted } }, msg)]
  }

  const kids: any[] = [
    createElement('span', {
      key: 'dot',
      style: {
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        backgroundColor: dotBg,
        ...(status === 'certifying' ? { animation: 'wmci-pulse 2s ease-in-out infinite' } : {}),
      },
    }),
  ]

  if (copied) {
    kids.push(createElement('span', { key: 'cl', style: { color: _CI.green } }, '\u2713 Copied'))
  } else {
    kids.push(createElement('span', { key: 'lb', style: { color: _CI.muted } }, label))
    if (status === 'certified' && payload && typeof payload.score === 'number') {
      kids.push(createElement('span', { key: 'si', style: { color: _CI.muted, opacity: 0.5 } },
        `(${(payload.score as number).toFixed(2)})`))
    }
  }

  if (hovered) {
    kids.push(createElement('span', {
      key: 'pop',
      style: {
        position: 'absolute' as const, bottom: '100%', left: '50%',
        transform: 'translateX(-50%)',
        paddingBottom: 8, zIndex: 9999,
      },
    },
      createElement('span', {
        style: {
          display: 'block', background: '#ffffff',
          border: `1px solid ${_CI.veryLight}`, borderRadius: 8,
          padding: '8px 12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          maxWidth: 280, minWidth: 200, fontSize: 11,
          lineHeight: '1.5', color: _CI.text, fontFamily: _CI.font,
          whiteSpace: 'normal' as const,
        },
      }, ...popupBody),
    ))
  }

  if (status === 'certifying') {
    kids.push(createElement('style', { key: 'css' },
      '@keyframes wmci-pulse{0%,100%{opacity:1}50%{opacity:.4}}'))
  }

  return createElement('span', {
    className,
    style: {
      position: 'relative' as const, display: 'inline-flex', alignItems: 'center',
      gap: 6, cursor: 'default', fontSize: 12, fontFamily: _CI.font,
    },
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  }, ...kids)
}
