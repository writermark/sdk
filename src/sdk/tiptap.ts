import { Collector } from './collector.js'
import { normalizeText } from '../normalize.js'
import { hashText } from '../attestation/certificate.js'
import {
  computeChunkHashes, buildMerkleTree, getMerkleProof,
  getChunkIndicesForRange,
  CHUNK_SIZE,
  type MerkleTree,
} from '../attestation/merkle.js'
import type { AuthorshipMap, EditorEvent } from '../types.js'

const MAX_DERIVE_CHARS = 250_000

/**
 * Writermark TipTap Integration (v5)
 *
 * Wires a Collector into a TipTap editor instance.
 * Captures all telemetry signals including dwell time, key zones,
 * clipboard events, and transaction-based mutation events for
 * accurate authorship map tracking.
 *
 * Features:
 *   - Precise plain-text mutation events via TipTap transaction diffing
 *   - Early paste/undo/redo detection via capture-phase DOM listeners
 *   - Clipboard enrichment on copy/cut (derived certs via /derive)
 *   - Certified paste detection (writermark tokens in clipboard HTML)
 *   - Event compression before server transmission
 *
 * Framework-agnostic — no React, no Vue, no Angular dependencies.
 */

export interface TipTapEditor {
  on: (event: any, callback: (...args: any[]) => void) => any
  off: (event: any, callback: (...args: any[]) => void) => any
  view: { dom: HTMLElement }
  getText: () => string
  chain?: () => any
  state?: { selection: { from: number; to: number } }
}

export type PendingPasteVerification = {
  eventIndex: number
  token: string
  text: string
}

export type CertificationContext = {
  merkleTree: MerkleTree | null
  merkleNormalizedText: string | null
  checkpoint: string | null
  isPassing: boolean
  pasteVerifications: PendingPasteVerification[]
  writermarkUrl: string
  authorshipMap: AuthorshipMap | null
  debug?: boolean
  /** Injected by the React hook — forces an immediate certify and returns the result */
  flushAndCertify?: () => Promise<unknown | null>
}

export function createCertificationContext(
  writermarkUrl?: string,
  opts?: {
    checkpoint?: string | null
    isPassing?: boolean
    authorshipMap?: AuthorshipMap | null
    debug?: boolean
  },
): CertificationContext {
  return {
    merkleTree: null,
    merkleNormalizedText: null,
    checkpoint: opts?.checkpoint ?? null,
    isPassing: opts?.isPassing ?? false,
    pasteVerifications: [],
    writermarkUrl: writermarkUrl || 'https://api.writermark.org',
    authorshipMap: opts?.authorshipMap ?? null,
    debug: opts?.debug,
  }
}

export async function computeMerkleRoot(
  text: string,
  ctx: CertificationContext,
): Promise<string | null> {
  const normalized = normalizeText(text)
  if (normalized.length === 0) {
    ctx.merkleTree = null
    ctx.merkleNormalizedText = null
    return null
  }
  const hashes = await computeChunkHashes(normalized)
  const tree = await buildMerkleTree(hashes)
  ctx.merkleTree = tree
  ctx.merkleNormalizedText = normalized
  return tree.root || null
}

// ---- Text diffing for mutation events ----

function diffTexts(
  oldText: string,
  newText: string,
): { pos: number; deleteLen: number; insertLen: number } | null {
  if (oldText === newText) return null
  const oldLen = oldText.length
  const newLen = newText.length

  let prefix = 0
  const minLen = Math.min(oldLen, newLen)
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++

  let suffix = 0
  while (
    suffix < (oldLen - prefix) &&
    suffix < (newLen - prefix) &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) suffix++

  const deleteLen = oldLen - prefix - suffix
  const insertLen = newLen - prefix - suffix
  if (deleteLen === 0 && insertLen === 0) return null
  return { pos: prefix, deleteLen, insertLen }
}

// ---- Event compression ----

/**
 * Compress events before sending to server by merging consecutive
 * same-source mutation events into batched mutations.
 * Non-mutation events are preserved as-is (needed for behavioral scoring).
 */
export function compressEvents(events: EditorEvent[]): EditorEvent[] {
  const result: EditorEvent[] = []
  let pending: EditorEvent | null = null

  const flushPending = () => {
    if (pending) { result.push(pending); pending = null }
  }

  for (const e of events) {
    if (e.type !== 'mutation') {
      if (e.type === 'copy' || e.type === 'cut') flushPending()
      result.push(e)
      continue
    }

    if (!pending) {
      pending = { ...e }
      continue
    }

    // Merge consecutive pure insertions at contiguous positions with same source
    if (
      pending.deleteLen === 0 && e.deleteLen === 0 &&
      e.insertSource === pending.insertSource &&
      e.pos === (pending.pos! + pending.insertLen!)
    ) {
      pending.insertLen! += e.insertLen!
      continue
    }

    // Merge consecutive pure deletions (backspace: pos decreases)
    if (
      pending.insertLen === 0 && e.insertLen === 0 &&
      e.insertSource === pending.insertSource &&
      e.pos! + e.deleteLen! === pending.pos!
    ) {
      pending.pos = e.pos
      pending.deleteLen! += e.deleteLen!
      continue
    }

    flushPending()
    pending = { ...e }
  }
  flushPending()

  return result
}

// ---- TipTap attachment ----

export function attachToTipTap(
  editor: TipTapEditor,
  collector: Collector,
  ctx?: CertificationContext | null,
): () => void {
  let lastCursorPos = 0
  let isPasting = false
  let lastCopiedText = ''
  let pendingAction: 'undo' | 'redo' | null = null
  let lastPasteSource: EditorEvent['insertSource'] = 'paste-external'
  let prevText = editor.getText()

  const dom = editor.view.dom
  const debug = ctx?.debug ?? false

  const getCursorPos = (): number | undefined => {
    try { return editor.state?.selection?.from } catch { return undefined }
  }

  // Early detection handlers registered on document with capture phase.
  // These fire BEFORE ProseMirror's handlers, ensuring isPasting/pendingAction
  // are set before the transaction fires.
  const earlyPasteDetect = (e: Event) => {
    if (!dom.contains(e.target as Node)) return
    const ce = e as ClipboardEvent
    const plainText = ce.clipboardData?.getData('text/plain') ?? ''
    const htmlText = ce.clipboardData?.getData('text/html') ?? ''
    if (plainText.length === 0) return

    isPasting = true
    const tokenMatch = htmlText.match(/data-writermark-token="([^"]+)"/)
    if (tokenMatch && tokenMatch[1]) {
      lastPasteSource = 'paste-certified'
    } else if (plainText === lastCopiedText && lastCopiedText.length > 0) {
      lastPasteSource = 'paste-internal'
    } else {
      lastPasteSource = 'paste-external'
    }
    if (debug) console.log('[writermark] early paste detect:', lastPasteSource, plainText.length, 'chars')
  }

  const earlyKeyDetect = (e: Event) => {
    if (!dom.contains(e.target as Node)) return
    const ke = e as KeyboardEvent
    if ((ke.ctrlKey || ke.metaKey) && ke.key === 'z') {
      pendingAction = ke.shiftKey ? 'redo' : 'undo'
    }
  }

  document.addEventListener('paste', earlyPasteDetect, true)
  document.addEventListener('keydown', earlyKeyDetect, true)

  // ---- Copy handler ----
  // ProseMirror's copy handler runs BEFORE ours (registered earlier on the
  // same DOM element). By the time we fire, clipboardData already contains
  // ProseMirror's correctly serialized HTML (with data-pm-slice and full
  // document structure). We read it, enrich it with the writermark token
  // asynchronously, and overwrite the system clipboard. We never call
  // preventDefault — ProseMirror already did.
  const handleCopy = (e: ClipboardEvent) => {
    const selectedText = e.clipboardData?.getData('text/plain') || document.getSelection()?.toString() || ''
    const pmHtml = e.clipboardData?.getData('text/html') ?? ''
    const selFrom = getCursorPos()
    const copyLen = selectedText.length
    if (selectedText.length > 0) {
      lastCopiedText = selectedText
      collector.recordCopyOrCut(selectedText, selFrom, copyLen, false)
    }

    if (
      ctx &&
      selectedText.length > 0 &&
      selectedText.length <= MAX_DERIVE_CHARS &&
      ctx.isPassing &&
      ctx.checkpoint &&
      ctx.writermarkUrl
    ) {
      const currentNormalized = normalizeText(editor.getText())
      const textIsDirty = currentNormalized !== ctx.merkleNormalizedText

      if (textIsDirty && ctx.flushAndCertify) {
        if (debug) console.log('[writermark] copy: text changed since last certify, forcing certify first')
        ctx.flushAndCertify().then(() => {
          if (!ctx.merkleTree || !ctx.checkpoint || !ctx.isPassing) {
            if (debug) console.log('[writermark] copy: certify did not produce a valid state, falling back')
            return
          }
          if (debug) console.log('[writermark] copy: enriching clipboard via /derive (after forced certify)', selectedText.length, 'chars')
          return deriveCertAndEnrichClipboard(
            selectedText, editor, ctx.checkpoint, ctx.merkleTree, ctx.writermarkUrl,
            ctx.authorshipMap ?? undefined, debug, ctx.merkleNormalizedText, pmHtml,
          )
        }).catch((err) => {
          if (debug) console.warn('[writermark] copy: forced certify + /derive failed', err)
        })
      } else if (ctx.merkleTree) {
        if (debug) console.log('[writermark] copy: enriching clipboard via /derive', selectedText.length, 'chars')
        deriveCertAndEnrichClipboard(
          selectedText, editor, ctx.checkpoint, ctx.merkleTree, ctx.writermarkUrl,
          ctx.authorshipMap ?? undefined, debug, ctx.merkleNormalizedText, pmHtml,
        ).catch((err) => {
          if (debug) console.warn('[writermark] copy: /derive failed', err)
        })
      }
    } else if (debug && ctx) {
      console.log('[writermark] copy: skipping enrichment —', {
        hasText: selectedText.length > 0,
        overSizeLimit: selectedText.length > MAX_DERIVE_CHARS,
        isPassing: ctx.isPassing,
        hasCheckpoint: !!ctx.checkpoint,
        hasUrl: !!ctx.writermarkUrl,
      })
    }
  }

  // ---- Cut handler ----
  // Same approach as copy: ProseMirror's handler already serialized HTML,
  // called preventDefault, AND deleted the selection. We read from
  // clipboardData and asynchronously enrich.
  const handleCut = (e: ClipboardEvent) => {
    const selectedText = e.clipboardData?.getData('text/plain') || ''
    const pmHtml = e.clipboardData?.getData('text/html') ?? ''
    const selFrom = getCursorPos()
    const copyLen = selectedText.length
    if (selectedText.length > 0) {
      lastCopiedText = selectedText
      collector.recordCopyOrCut(selectedText, selFrom, copyLen, true)
    }

    if (
      ctx &&
      selectedText.length > 0 &&
      selectedText.length <= MAX_DERIVE_CHARS &&
      ctx.isPassing &&
      ctx.checkpoint &&
      ctx.writermarkUrl
    ) {
      const currentNormalized = normalizeText(editor.getText())
      const textIsDirty = currentNormalized !== ctx.merkleNormalizedText

      if (textIsDirty && ctx.flushAndCertify) {
        if (debug) console.log('[writermark] cut: text changed since last certify, forcing certify first')
        ctx.flushAndCertify().then(() => {
          if (!ctx.merkleTree || !ctx.checkpoint || !ctx.isPassing) {
            return
          }
          return deriveCertAndEnrichClipboard(
            selectedText, editor, ctx.checkpoint, ctx.merkleTree, ctx.writermarkUrl,
            ctx.authorshipMap ?? undefined, debug, ctx.merkleNormalizedText, pmHtml,
          )
        }).catch((err) => {
          if (debug) console.warn('[writermark] cut: forced certify + /derive failed', err)
        })
      } else if (ctx.merkleTree) {
        deriveCertAndEnrichClipboard(
          selectedText, editor, ctx.checkpoint, ctx.merkleTree, ctx.writermarkUrl,
          ctx.authorshipMap ?? undefined, debug, ctx.merkleNormalizedText, pmHtml,
        ).catch((err) => {
          if (debug) console.warn('[writermark] cut: /derive failed', err)
        })
      }
    }
  }

  // ---- Paste handler ----
  const handlePaste = (e: ClipboardEvent) => {
    const plainText = e.clipboardData?.getData('text/plain') ?? ''
    const htmlText = e.clipboardData?.getData('text/html') ?? ''
    if (plainText.length === 0) return

    isPasting = true
    const pos = getCursorPos()

    const tokenMatch = htmlText.match(/data-writermark-token="([^"]+)"/)
    if (tokenMatch && tokenMatch[1]) {
      lastPasteSource = 'paste-certified'
      if (debug) console.log('[writermark] paste: certified,', plainText.length, 'chars')
      collector.recordPaste(plainText.length, plainText, 'certified', pos)
      if (ctx) {
        ctx.pasteVerifications.push({
          eventIndex: collector.getEventCount() - 1,
          token: tokenMatch[1],
          text: plainText,
        })
      }
    } else if (plainText === lastCopiedText && lastCopiedText.length > 0) {
      lastPasteSource = 'paste-internal'
      if (debug) console.log('[writermark] paste: internal,', plainText.length, 'chars')
      collector.recordPaste(plainText.length, plainText, 'internal', pos)
    } else {
      lastPasteSource = 'paste-external'
      if (debug) console.log('[writermark] paste: external,', plainText.length, 'chars')
      collector.recordPaste(plainText.length, plainText, 'external', pos)
    }
    setTimeout(() => { isPasting = false }, 50)
  }

  // ---- Keydown / Keyup ----
  const handleKeydown = (e: KeyboardEvent) => {
    if (isPasting) return
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      pendingAction = e.shiftKey ? 'redo' : 'undo'
      if (e.shiftKey) collector.recordRedo(); else collector.recordUndo()
      return
    }
    const pos = getCursorPos()
    if (e.key === 'Backspace' || e.key === 'Delete') collector.recordBackspace(e.code, pos)
    else if (e.key === 'Enter') collector.recordEnter(e.code, pos)
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) collector.recordKey(e.code, pos)
  }

  const handleKeyup = (e: KeyboardEvent) => {
    if (isPasting) return
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
      collector.recordKeyUp(e.code)
    }
  }

  // ---- Transaction listener: diff old/new plain text to emit precise mutation events ----
  const handleTransaction = ({ transaction }: { editor: any; transaction: any }) => {
    if (!transaction.docChanged) return
    const newText = editor.getText()
    const diff = diffTexts(prevText, newText)
    prevText = newText

    if (!diff) return

    let insertSource: EditorEvent['insertSource'] = 'typed'
    if (isPasting) {
      insertSource = lastPasteSource
    } else if (pendingAction) {
      insertSource = pendingAction
      pendingAction = null
    }

    if (debug) console.log('[writermark] mutation:', { pos: diff.pos, del: diff.deleteLen, ins: diff.insertLen, src: insertSource })
    collector.recordMutation(diff.pos, diff.deleteLen, diff.insertLen, insertSource)
  }

  // ---- Selection / cursor ----
  const handleSelectionUpdate = ({ editor: ed }: { editor: any }) => {
    const { from, to } = ed.state.selection
    const distance = from - lastCursorPos
    if (Math.abs(distance) > 1) collector.recordCursorJump(distance)
    const selectLen = to - from
    if (selectLen > 1) collector.recordSelect(selectLen)
    lastCursorPos = from
  }

  // ---- Auxiliary signals ----
  const handleFocus = () => collector.recordFocus()
  const handleBlur = () => collector.recordBlur()
  const handleScroll = () => collector.recordScroll(dom.scrollTop)
  const handleMouseMove = (e: MouseEvent) => {
    const rect = dom.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    collector.recordMouse(
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    )
  }
  const handleVisibility = () => collector.recordVisibility(!document.hidden)
  const handleComposition = () => collector.recordCompose()

  // ---- Attach all listeners ----
  dom.addEventListener('keydown', handleKeydown)
  dom.addEventListener('keyup', handleKeyup)
  dom.addEventListener('copy', handleCopy as EventListener)
  dom.addEventListener('cut', handleCut as EventListener)
  dom.addEventListener('paste', handlePaste as EventListener)
  dom.addEventListener('focus', handleFocus)
  dom.addEventListener('blur', handleBlur)
  dom.addEventListener('scroll', handleScroll)
  dom.addEventListener('mousemove', handleMouseMove)
  dom.addEventListener('compositionstart', handleComposition)
  document.addEventListener('visibilitychange', handleVisibility)
  editor.on('selectionUpdate', handleSelectionUpdate)
  editor.on('transaction', handleTransaction)

  // ---- Cleanup ----
  return () => {
    document.removeEventListener('paste', earlyPasteDetect, true)
    document.removeEventListener('keydown', earlyKeyDetect, true)
    dom.removeEventListener('keydown', handleKeydown)
    dom.removeEventListener('keyup', handleKeyup)
    dom.removeEventListener('copy', handleCopy as EventListener)
    dom.removeEventListener('cut', handleCut as EventListener)
    dom.removeEventListener('paste', handlePaste as EventListener)
    dom.removeEventListener('focus', handleFocus)
    dom.removeEventListener('blur', handleBlur)
    dom.removeEventListener('scroll', handleScroll)
    dom.removeEventListener('mousemove', handleMouseMove)
    dom.removeEventListener('compositionstart', handleComposition)
    document.removeEventListener('visibilitychange', handleVisibility)
    editor.off('selectionUpdate', handleSelectionUpdate)
    editor.off('transaction', handleTransaction)
  }
}

// ============================================================
// Derive cert and write enriched clipboard
// ============================================================

/**
 * Inject data-writermark-token into existing HTML by adding the attribute
 * to the first opening tag. This preserves ProseMirror's data-pm-slice
 * and all structural HTML intact.
 */
function injectTokenIntoHtml(html: string, token: string): string {
  const match = html.match(/^(<[a-zA-Z][a-zA-Z0-9]*)([\s>])/)
  if (match) {
    return `${match[1]} data-writermark-token="${token}"${match[2]}${html.slice(match[0].length)}`
  }
  return `<div data-writermark-token="${token}">${html}</div>`
}

async function deriveCertAndEnrichClipboard(
  selectedText: string,
  _editor: TipTapEditor,
  checkpoint: string,
  merkleTree: MerkleTree,
  writermarkUrl: string,
  authorshipMap?: AuthorshipMap,
  debug = false,
  merkleNormalizedText?: string | null,
  pmHtml?: string,
): Promise<void> {
  const normalizedExcerpt = normalizeText(selectedText)

  // Use the cached normalized text that matches the Merkle tree,
  // NOT the live editor text which may have changed since last certify
  const normalizedFull = merkleNormalizedText ?? normalizeText(_editor.getText())

  const startOffset = normalizedFull.indexOf(normalizedExcerpt)
  if (startOffset === -1) {
    if (debug) console.log('[writermark] /derive: excerpt not found in merkle text, falling back')
    await navigator.clipboard.writeText(selectedText)
    return
  }
  const endOffset = startOffset + normalizedExcerpt.length

  const chunkIndices = getChunkIndicesForRange(startOffset, endOffset)
  const allChunks: Array<{ index: number; text: string }> = []
  for (let i = 0; i < normalizedFull.length; i += CHUNK_SIZE) {
    allChunks.push({ index: Math.floor(i / CHUNK_SIZE), text: normalizedFull.slice(i, i + CHUNK_SIZE) })
  }
  const chunks = chunkIndices.map(idx => allChunks[idx]).filter(Boolean)
  const merkleProofs = chunkIndices.map(idx => ({
    leafIndex: idx,
    proof: getMerkleProof(merkleTree.layers, idx),
  }))

  const deriveBody: Record<string, unknown> = {
    token: checkpoint,
    excerpt: normalizedExcerpt,
    chunks,
    merkleProofs,
  }
  if (authorshipMap) {
    deriveBody.authorshipMap = authorshipMap
    deriveBody.excerptStart = startOffset
  }

  const res = await fetch(`${writermarkUrl}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deriveBody),
  })

  if (!res.ok) {
    if (debug) {
      const errBody = await res.json().catch(() => null)
      console.warn('[writermark] /derive returned', res.status, errBody)
    }
    await navigator.clipboard.writeText(selectedText)
    return
  }

  const data = await res.json()
  const enrichedHtml = pmHtml
    ? injectTokenIntoHtml(pmHtml, data.token)
    : `<div data-writermark-token="${data.token}">${selectedText.split('\n').map(line =>
        `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</p>`
      ).join('')}</div>`

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([selectedText], { type: 'text/plain' }),
        'text/html': new Blob([enrichedHtml], { type: 'text/html' }),
      }),
    ])
  } catch {
    await navigator.clipboard.writeText(selectedText)
  }
}
