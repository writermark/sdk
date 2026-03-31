/**
 * Writermark Verification SDK
 *
 * Golden-path functions for verifying certificates and files.
 *
 *   // Verify a file (the one-liner)
 *   const result = await verifyFile(file)
 *
 *   // Verify text + token manually
 *   const result = await verify({ token: 'eyJ...', text: '...' })
 *
 *   // Extract text + token from a file without verifying
 *   const { text, token } = await extractFromFile(file)
 */

import { extractToken, hashText } from '../attestation/certificate.js'
import { normalizeText } from '../normalize.js'

// ---- Types ----

export interface VerifyOptions {
  /** JWT token or full certificate text (the JWT is extracted automatically) */
  token: string
  /** Original document text. If omitted, only the signature is verified. */
  text?: string
  /** API URL. Defaults to https://api.writermark.org */
  apiUrl?: string
}

export interface VerifyResult {
  valid: boolean
  pass?: boolean
  score?: number
  confidence?: number
  issuedAt?: string
  /** True if only the signature was checked (no text provided or hash mismatch fallback) */
  signatureOnly: boolean
  /** Human-readable detail on failure */
  detail?: string
  /** The raw server response */
  raw?: any
}

export interface ExtractedFile {
  text: string
  token: string | null
  fileType: 'wtxt' | 'docx' | 'rtf' | 'md' | 'txt' | 'html'
}

export interface VerifyFileResult extends VerifyResult {
  /** The text extracted from the file */
  text?: string
  /** The token extracted from the file */
  token?: string | null
  /** Detected file type */
  fileType?: string
}

export interface VerifyFileOptions {
  apiUrl?: string
}

// ---- High-level verify ----

/**
 * Verify a Writermark certificate.
 *
 * Accepts a raw JWT, a full certificate block, or any string containing a JWT.
 * If `text` is provided, verifies both signature and text hash match.
 * If `text` is omitted, verifies signature only.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const apiUrl = (options.apiUrl || 'https://api.writermark.org').replace(/\/$/, '')
  const token = extractToken(options.token) || options.token.trim()

  if (!token) {
    return { valid: false, signatureOnly: false, detail: 'No valid JWT token found in input' }
  }

  if (options.text != null && options.text.trim().length > 0) {
    // Full verification: signature + text hash
    try {
      const res = await fetch(`${apiUrl}/verify-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: options.text, token }),
      })
      const data = await res.json()
      if (data.valid) {
        return {
          valid: true,
          pass: data.summary?.pass,
          score: data.summary?.score,
          confidence: data.summary?.confidence,
          issuedAt: data.summary?.issuedAt,
          signatureOnly: false,
          raw: data,
        }
      }
      // If signature is valid but text hash mismatches, fall back to signature-only
      if (data.signatureValid && data.detail && data.detail.indexOf('hash') !== -1) {
        const sigResult = await _verifySignatureOnly(apiUrl, token)
        if (sigResult.valid) {
          return { ...sigResult, signatureOnly: true, detail: 'Certificate signature is valid but the text does not match the originally certified text' }
        }
      }
      return {
        valid: false,
        signatureOnly: false,
        detail: data.error || data.detail || 'Verification failed',
        raw: data,
      }
    } catch (e: any) {
      return { valid: false, signatureOnly: false, detail: e.message || 'Network error' }
    }
  }

  // Signature-only verification
  return _verifySignatureOnly(apiUrl, token)
}

async function _verifySignatureOnly(apiUrl: string, token: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${apiUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const data = await res.json()
    if (data.valid && data.summary) {
      return {
        valid: true,
        pass: data.summary.pass,
        score: data.summary.score,
        confidence: data.summary.confidence,
        issuedAt: data.summary.issuedAt,
        signatureOnly: true,
        raw: data,
      }
    }
    return {
      valid: false,
      signatureOnly: true,
      detail: data.error || 'Signature verification failed',
      raw: data,
    }
  } catch (e: any) {
    return { valid: false, signatureOnly: true, detail: e.message || 'Network error' }
  }
}

// ---- Golden path: verify a file ----

/**
 * Verify a file in one call. Extracts text and token from the file,
 * then verifies the certificate against the daemon API.
 *
 * Supports: .wtxt, .docx, .rtf, .md, .txt, .html
 * DOCX support requires JSZip (npm install jszip, or load via script tag).
 */
export async function verifyFile(
  file: File | { name: string; data: ArrayBuffer | string },
  options?: VerifyFileOptions,
): Promise<VerifyFileResult> {
  let extracted: ExtractedFile
  try {
    extracted = await extractFromFile(file)
  } catch (e: any) {
    return { valid: false, signatureOnly: false, detail: e.message || 'Failed to read file' }
  }

  if (!extracted.token) {
    return {
      valid: false,
      signatureOnly: false,
      detail: 'No Writermark certificate found in this file',
      text: extracted.text,
      token: null,
      fileType: extracted.fileType,
    }
  }

  const result = await verify({
    token: extracted.token,
    text: extracted.text || undefined,
    apiUrl: options?.apiUrl,
  })

  return {
    ...result,
    text: extracted.text,
    token: extracted.token,
    fileType: extracted.fileType,
  }
}

// ---- File extraction ----

/**
 * Extract text and token from a file. Does not verify — just parses.
 *
 * Accepts a browser File object, or a plain object with `name` and `data`
 * (for Node.js or environments without the File API).
 *
 * DOCX support requires JSZip.
 */
export async function extractFromFile(
  file: File | { name: string; data: ArrayBuffer | string },
): Promise<ExtractedFile> {
  const name = file.name
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  if (ext === 'wtxt') {
    const raw = await _getText(file)
    return extractWtxt(raw)
  }
  if (ext === 'md' || ext === 'markdown') {
    const raw = await _getText(file)
    return extractMarkdown(raw)
  }
  if (ext === 'txt') {
    const raw = await _getText(file)
    return extractPlainText(raw)
  }
  if (ext === 'rtf') {
    const raw = await _getText(file)
    return extractRtf(raw)
  }
  if (ext === 'docx') {
    const buf = await _getArrayBuffer(file)
    return extractDocx(buf)
  }
  if (ext === 'html' || ext === 'htm') {
    const raw = await _getText(file)
    return extractHtml(raw)
  }

  throw new Error(`Unsupported file type: .${ext}`)
}

async function _getText(file: File | { name: string; data: ArrayBuffer | string }): Promise<string> {
  if (file instanceof File) return file.text()
  if (typeof file.data === 'string') return file.data
  return new TextDecoder().decode(file.data)
}

async function _getArrayBuffer(file: File | { name: string; data: ArrayBuffer | string }): Promise<ArrayBuffer> {
  if (file instanceof File) return file.arrayBuffer()
  if (file.data instanceof ArrayBuffer) return file.data
  return new TextEncoder().encode(file.data).buffer as ArrayBuffer
}

// ---- Format-specific extractors (all exported for advanced use) ----

const JWT_RE = /(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/

export function extractWtxt(raw: string): ExtractedFile {
  const wtxt = JSON.parse(raw)
  const text = wtxt.content ? tiptapJsonToText(wtxt.content) : ''
  let token: string | null = null
  if (wtxt.writermark?.checkpoint) token = wtxt.writermark.checkpoint
  if (!token && wtxt.writermark?.certificate) token = wtxt.writermark.certificate
  return { text, token, fileType: 'wtxt' }
}

export function extractMarkdown(raw: string): ExtractedFile {
  const certMatch = raw.match(/<!--[\s\S]*?writermark[\s\S]*?-->/)
  let token: string | null = null
  let text = raw

  if (certMatch) {
    token = extractToken(certMatch[0])
    text = raw.replace(certMatch[0], '')
  }

  text = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^\[[ x]\]\s*/gm, '')
    .replace(/^---+$/gm, '')
    .trim()

  text = stripCertificateFooter(text)

  if (!token) {
    const m = raw.match(JWT_RE)
    if (m) token = m[1]
  }

  return { text, token, fileType: 'md' }
}

export function extractPlainText(raw: string): ExtractedFile {
  let token: string | null = null
  const m = raw.match(JWT_RE)
  if (m) token = m[1]
  const text = stripCertificateFooter(raw)
  return { text, token, fileType: 'txt' }
}

export function extractHtml(raw: string): ExtractedFile {
  let token: string | null = null
  const commentMatch = raw.match(/<!--[\s\S]*?writermark[\s\S]*?-->/)
  if (commentMatch) {
    token = extractToken(commentMatch[0])
  }
  if (!token) {
    const m = raw.match(JWT_RE)
    if (m) token = m[1]
  }

  // Strip HTML tags to get plain text
  let text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  text = stripCertificateFooter(text)
  return { text, token, fileType: 'html' }
}

export function extractRtf(raw: string): ExtractedFile {
  const token = extractTokenFromRtf(raw)
  const text = stripCertificateFooter(stripRtfToText(raw))
  return { text, token, fileType: 'rtf' }
}

export async function extractDocx(arrayBuffer: ArrayBuffer): Promise<ExtractedFile> {
  const JSZip = await _getJSZip()

  const zip = await JSZip.loadAsync(arrayBuffer)
  const docXml = await zip.file('word/document.xml')?.async('string')
  if (!docXml) return { text: '', token: null, fileType: 'docx' }

  let text = docXml
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u2610\u2611\u2612]/g, '')
    .trim()

  text = stripCertificateFooter(text)

  let token: string | null = null
  try {
    const customXml = await zip.file('docProps/custom.xml')?.async('string')
    if (customXml) {
      const m = customXml.match(JWT_RE)
      if (m) token = m[1]
    }
  } catch { /* no custom.xml */ }

  if (!token) {
    const m = docXml.match(JWT_RE)
    if (m) token = m[1]
  }

  return { text, token, fileType: 'docx' }
}

// ---- JSZip resolution ----

async function _getJSZip(): Promise<any> {
  // 1. Check global (script tag users)
  if (typeof globalThis !== 'undefined' && (globalThis as any).JSZip) {
    return (globalThis as any).JSZip
  }
  // 2. Try dynamic import (bundler / npm users)
  // String is constructed to prevent Vite/bundlers from resolving it at build time
  try {
    const id = 'jszip'
    // @ts-ignore — jszip is an optional peer dependency
    const mod = await import(/* @vite-ignore */ id)
    return mod.default || mod
  } catch { /* not installed */ }

  throw new Error(
    'DOCX verification requires JSZip. Install it with `npm install jszip` ' +
    'or load it via <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>'
  )
}

// ---- Shared utilities ----

/** Strip the ═══ WRITERMARK CERTIFICATE ═══ block from document text */
export function stripCertificateFooter(text: string): string {
  return text
    .replace(/\n*[\u2550=]{3,}\s*WRITERMARK CERTIFICATE\s*[\u2550=]*[\s\S]*$/i, '')
    .replace(/\n*[\u2550=\u2500-]{5,}\n*(?:(?:Status|Score|Confidence|Date|Text hash|View|Verify|Token)[:\s][^\n]*\n*)*[\u2550=\u2500-]*\s*$/i, '')
    .trim()
}

/** Convert TipTap JSON document structure to plain text */
export function tiptapJsonToText(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return node.text || ''
  if (!node.content) {
    if (node.type === 'hardBreak' || node.type === 'horizontalRule') return '\n'
    return ''
  }
  const childText = node.content.map(tiptapJsonToText).join('')
  const blocks = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell', 'tableHeader']
  if (blocks.includes(node.type)) return childText + '\n'
  return childText
}

/** Strip RTF formatting and return plain text */
export function stripRtfToText(rtf: string): string {
  let out = ''
  let i = 0
  let depth = 0
  let skipGroup = false
  let skipDepth = 0

  while (i < rtf.length) {
    const ch = rtf[i]
    if (ch === '{') {
      depth++
      if (i + 1 < rtf.length && rtf[i + 1] === '\\') {
        const peek = rtf.substring(i + 1, i + 40)
        if (peek.match(/^\\(fonttbl|colortbl|stylesheet|\\\*)/)) {
          skipGroup = true
          skipDepth = depth
        }
      }
      i++
      continue
    }
    if (ch === '}') {
      if (skipGroup && depth === skipDepth) skipGroup = false
      depth--
      i++
      continue
    }
    if (skipGroup) { i++; continue }
    if (ch === '\\') {
      i++
      if (i >= rtf.length) break
      if (rtf[i] === '\\' || rtf[i] === '{' || rtf[i] === '}') {
        out += rtf[i]; i++; continue
      }
      if (rtf[i] === '*') { skipGroup = true; skipDepth = depth; i++; continue }
      if (rtf[i] === "'") {
        const hex = rtf.substring(i + 1, i + 3)
        out += String.fromCharCode(parseInt(hex, 16) || 63)
        i += 3; continue
      }
      let ctrl = ''
      while (i < rtf.length && /[a-z]/i.test(rtf[i])) { ctrl += rtf[i]; i++ }
      let num = ''
      if (i < rtf.length && (rtf[i] === '-' || /[0-9]/.test(rtf[i]))) {
        if (rtf[i] === '-') { num += '-'; i++ }
        while (i < rtf.length && /[0-9]/.test(rtf[i])) { num += rtf[i]; i++ }
      }
      if (i < rtf.length && rtf[i] === ' ') i++
      if (ctrl === 'par' || ctrl === 'line') out += '\n'
      else if (ctrl === 'tab') out += '\t'
      else if (ctrl === 'u' && num) out += String.fromCharCode(parseInt(num))
      else if (ctrl === 'emdash') out += '\u2014'
      else if (ctrl === 'endash') out += '\u2013'
      else if (ctrl === 'bullet') { /* skip — TipTap getText() doesn't emit bullets */ }
      else if (ctrl === 'lquote') out += '\u2018'
      else if (ctrl === 'rquote') out += '\u2019'
      else if (ctrl === 'ldblquote') out += '\u201C'
      else if (ctrl === 'rdblquote') out += '\u201D'
      continue
    }
    if (ch === '\r' || ch === '\n') { i++; continue }
    out += ch
    i++
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** Extract a JWT token from an RTF file's writermark destination group */
export function extractTokenFromRtf(rtf: string): string | null {
  const wm = rtf.match(/\{\\\*\\writermark\s+(eyJ[A-Za-z0-9_.-]+)\}/)
  if (wm) return wm[1]
  const m = rtf.match(JWT_RE)
  return m ? m[1] : null
}
