import { Collector } from './collector.js'
import type { CertificationContext, PendingPasteVerification } from './tiptap.js'

/**
 * Writermark Generic DOM Integration (v3)
 *
 * Attaches a Collector to ANY text input: <textarea>, <input>,
 * or contenteditable element. Captures all telemetry signals
 * including dwell time, key zones, and auxiliary behavioral signals.
 *
 * Optionally supports certified paste detection when a
 * CertificationContext is provided. (Clipboard enrichment on
 * copy/cut is NOT supported here because generic DOM elements
 * don't provide the getText() method needed for Merkle proofs.
 * Use attachToTipTap for full excerpt certification support.)
 */

export function attachToElement(
  element: HTMLElement,
  collector: Collector,
  ctx?: CertificationContext | null,
): () => void {
  let lastSelectionStart = 0
  let isPasting = false

  // ---- Helper to get cursor position from element ----
  const getCursorPos = (): number | undefined => {
    try {
      const el = element as HTMLTextAreaElement | HTMLInputElement
      if (typeof el.selectionStart === 'number') return el.selectionStart
      // For contenteditable, use Selection API
      if (element.isContentEditable) {
        const sel = document.getSelection()
        if (sel && sel.rangeCount > 0) return sel.getRangeAt(0).startOffset
      }
    } catch { /* ignore */ }
    return undefined
  }

  // ---- Core keystroke events ----

  const handleKeydown = (e: KeyboardEvent) => {
    if (isPasting) return

    // Undo / Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      if (e.shiftKey) collector.recordRedo()
      else collector.recordUndo()
      return
    }

    const pos = getCursorPos()
    if (e.key === 'Backspace' || e.key === 'Delete') {
      collector.recordBackspace(e.code, pos)
    } else if (e.key === 'Enter') {
      collector.recordEnter(e.code, pos)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      collector.recordKey(e.code, pos)
    }
  }

  const handleKeyup = (e: KeyboardEvent) => {
    if (isPasting) return
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
      collector.recordKeyUp(e.code)
    }
  }

  const handleCopy = (e: ClipboardEvent) => {
    const sel = document.getSelection()
    const selectedText = sel?.toString() ?? ''
    const pos = getCursorPos()
    if (selectedText.length > 0) {
      collector.recordCopyOrCut(selectedText, pos, selectedText.length, false)
    }
    // No clipboard enrichment for generic elements (no getText() for Merkle)
  }

  const handleCut = (e: ClipboardEvent) => {
    const sel = document.getSelection()
    const selectedText = sel?.toString() ?? ''
    const pos = getCursorPos()
    if (selectedText.length > 0) {
      collector.recordCopyOrCut(selectedText, pos, selectedText.length, true)
    }
    // No clipboard enrichment for generic elements
  }

  // ---- Paste handler: supports certified paste detection ----
  const handlePaste = (e: ClipboardEvent) => {
    const plainText = e.clipboardData?.getData('text/plain') ?? ''
    const htmlText = e.clipboardData?.getData('text/html') ?? ''

    if (plainText.length === 0) return

    isPasting = true
    const pos = getCursorPos()

    // Check for writermark token in clipboard HTML
    if (ctx) {
      const tokenMatch = htmlText.match(/data-writermark-token="([^"]+)"/)
      if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1]
        collector.recordPaste(plainText.length, plainText, 'certified', pos)

        const eventIndex = collector.getEventCount() - 1
        ctx.pasteVerifications.push({ eventIndex, token, text: plainText })

        setTimeout(() => { isPasting = false }, 50)
        return
      }
    }

    // Normal paste — internal or external
    collector.recordPaste(plainText.length, plainText, undefined, pos)
    setTimeout(() => { isPasting = false }, 50)
  }

  // ---- Cursor / selection ----

  const handleSelect = () => {
    const el = element as HTMLTextAreaElement | HTMLInputElement
    if (typeof el.selectionStart === 'number') {
      const pos = el.selectionStart
      const distance = pos - lastSelectionStart
      if (Math.abs(distance) > 1) collector.recordCursorJump(distance)
      if (typeof el.selectionEnd === 'number') {
        const len = el.selectionEnd - el.selectionStart
        if (len > 1) collector.recordSelect(len)
      }
      lastSelectionStart = pos
    }
  }

  const handleSelectionChange = () => {
    if (!element.isContentEditable) return
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const offset = sel.getRangeAt(0).startOffset
    const distance = offset - lastSelectionStart
    if (Math.abs(distance) > 1) collector.recordCursorJump(distance)
    const range = sel.getRangeAt(0)
    if (!range.collapsed) {
      const len = range.toString().length
      if (len > 1) collector.recordSelect(len)
    }
    lastSelectionStart = offset
  }

  // ---- Auxiliary behavioral signals ----

  const handleFocus = () => collector.recordFocus()
  const handleBlur = () => collector.recordBlur()

  const handleScroll = (e: Event) => {
    const target = e.target as HTMLElement
    collector.recordScroll(target.scrollTop)
  }

  const handleMouseMove = (e: MouseEvent) => {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    collector.recordMouse(
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    )
  }

  const handleVisibility = () => {
    collector.recordVisibility(!document.hidden)
  }

  const handleCompositionStart = () => collector.recordCompose()

  // ---- Attach ----

  element.addEventListener('keydown', handleKeydown)
  element.addEventListener('keyup', handleKeyup)
  element.addEventListener('copy', handleCopy as EventListener)
  element.addEventListener('cut', handleCut as EventListener)
  element.addEventListener('paste', handlePaste as EventListener)
  element.addEventListener('focus', handleFocus)
  element.addEventListener('blur', handleBlur)
  element.addEventListener('scroll', handleScroll)
  element.addEventListener('mousemove', handleMouseMove)
  element.addEventListener('compositionstart', handleCompositionStart)
  document.addEventListener('visibilitychange', handleVisibility)

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    element.addEventListener('select', handleSelect)
    element.addEventListener('click', handleSelect)
    element.addEventListener('keyup', handleSelect)
  } else {
    document.addEventListener('selectionchange', handleSelectionChange)
  }

  // ---- Cleanup ----

  return () => {
    element.removeEventListener('keydown', handleKeydown)
    element.removeEventListener('keyup', handleKeyup)
    element.removeEventListener('copy', handleCopy as EventListener)
    element.removeEventListener('cut', handleCut as EventListener)
    element.removeEventListener('paste', handlePaste as EventListener)
    element.removeEventListener('focus', handleFocus)
    element.removeEventListener('blur', handleBlur)
    element.removeEventListener('scroll', handleScroll)
    element.removeEventListener('mousemove', handleMouseMove)
    element.removeEventListener('compositionstart', handleCompositionStart)
    document.removeEventListener('visibilitychange', handleVisibility)

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      element.removeEventListener('select', handleSelect)
      element.removeEventListener('click', handleSelect)
      element.removeEventListener('keyup', handleSelect)
    } else {
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }
}
