import type { AttestationPayload } from '../types.js'
import { normalizeText } from '../normalize.js'

/**
 * Writermark Portable Certificate
 *
 * A human-readable + machine-verifiable certificate that can be
 * pasted alongside text to prove human authorship.
 *
 * The certificate contains:
 *   - A human-readable summary
 *   - The raw JWT (machine-verifiable)
 *   - Instructions for verification
 *
 * Format:
 *   ═══ WRITERMARK CERTIFICATE ═══
 *   Status: VERIFIED HUMAN
 *   Score: 0.82 / 1.00
 *   Date: 2026-02-11
 *   Text hash: a1b2c3d4...
 *   ───
 *   Token: eyJhbG...
 *   ───
 *   Verify: https://writermark.org/verify
 *   ═══════════════════════════════
 *
 * Anyone can take the token, hash the text, and verify independently.
 */

/**
 * Format an attestation as a portable, pasteable certificate.
 */
export function formatCertificate(
  jwt: string,
  payload: AttestationPayload,
  verifyUrl: string = 'https://writermark.org/verify',
): string {
  const status = payload.pass ? 'VERIFIED HUMAN' : 'NOT VERIFIED'
  const date = payload.issuedAt.split('T')[0]
  const lines = [
    `═══ WRITERMARK CERTIFICATE ═══`,
    `Status: ${status}`,
    `Score: ${payload.score.toFixed(2)} / 1.00`,
    `Confidence: ${(payload.confidence * 100).toFixed(0)}%`,
    ...(payload.audioVerified === true ? [`+ Audio keystroke matching confirmed`] : []),
    ...(payload.activeWritingTimeMs != null ? [`Time spent writing: ${formatDuration(payload.activeWritingTimeMs)}`] : []),
    ...(payload.revisionPercent != null ? [`Revision: ${payload.revisionPercent}%`] : []),
    `Date: ${date}`,
    `Text hash: ${payload.textHash}`,
    `───`,
    `Token: ${jwt}`,
    `───`,
    `Verify at: ${verifyUrl}`,
    `Paste the original text + this token to verify.`,
    `═══════════════════════════════`,
  ]

  return lines.join('\n')
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * Format a certificate from a raw JWT token (decodes the payload internally).
 * Returns the formatted certificate string, or null if the token can't be decoded.
 */
export function formatCertificateFromToken(
  jwt: string,
  verifyUrl: string = 'https://writermark.org/verify',
): string | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const raw = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    const payload: AttestationPayload = {
      textHash: raw.textHash ?? '?',
      score: raw.score ?? 0,
      pass: !!raw.pass,
      confidence: raw.confidence ?? 0,
      issuedAt: raw.serverIssuedAt ?? raw.issuedAt ?? new Date().toISOString(),
      audioVerified: raw.audioVerified,
      activeWritingTimeMs: raw.activeWritingTimeMs,
      revisionPercent: raw.revisionPercent,
    }
    return formatCertificate(jwt, payload, verifyUrl)
  } catch {
    return null
  }
}

/**
 * Extract the JWT token from any input: raw JWT, URL, or formatted certificate.
 * Strips whitespace first to handle line-wrapped JWTs, then scans for
 * the base64url "eyJ" header with exactly 2 dots. Format-agnostic.
 */
export function extractToken(input: string): string | null {
  const trimmed = input.trim()

  // Fast path: raw JWT (entire input is the token)
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed
  }

  // Strip all whitespace so line-wrapped JWTs are reassembled
  const flat = input.replace(/\s+/g, '')
  const match = flat.match(/eyJ[A-Za-z0-9_.-]+/)
  if (match) {
    const candidate = match[0]
    const dots = candidate.split('.').length - 1
    if (dots === 2 && candidate.length > 64) {
      return trimJwtSignature(candidate)
    }
  }

  return null
}

/**
 * After whitespace stripping, adjacent text (e.g. "Verify") can get glued
 * onto the signature.  Decode the header to learn the algorithm, then trim
 * the signature segment to the exact expected base64url length.
 */
function trimJwtSignature(candidate: string): string | null {
  const dot1 = candidate.indexOf('.')
  const dot2 = candidate.indexOf('.', dot1 + 1)
  if (dot1 === -1 || dot2 === -1) return null

  const headerB64 = candidate.slice(0, dot1)
  try {
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')))
    const alg: string = header.alg ?? ''

    // base64url chars for the raw signature bytes of each algorithm
    const sigLengths: Record<string, number> = {
      EdDSA: 86,   // Ed25519: 64 bytes
      ES256: 86,   // ECDSA P-256: 64 bytes
      ES384: 128,  // ECDSA P-384: 96 bytes
      RS256: 342,  // RSA-2048: 256 bytes
      RS384: 342,
      RS512: 342,
    }
    const expectedLen = sigLengths[alg]
    if (expectedLen) {
      const sig = candidate.slice(dot2 + 1, dot2 + 1 + expectedLen)
      return candidate.slice(0, dot2 + 1) + sig
    }
  } catch {
    // header wasn't decodable — return as-is
  }
  return candidate
}

/**
 * Hash text with normalization (SHA-256, hex).
 *
 * Text is normalized before hashing so that cosmetically-identical
 * text (differing only in trailing spaces, line endings, nbsps,
 * zero-width chars, etc.) always produces the same hash.
 *
 * Works in both browser and Node.
 */
export async function hashText(text: string): Promise<string> {
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
