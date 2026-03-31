/**
 * authorship/map.ts — Per-character authorship tracking (RLE intervals).
 *
 * Every character in a document has an authorship tag:
 *   't' — typed at this position (direct key event evidence, weight = 1.0)
 *   'c' — pasted from a certified source (transitive evidence, weighted by sourceScore)
 *   'e' — pasted from an unknown/external source (no evidence, weight = 0)
 *
 * The map is stored as run-length-encoded intervals for compactness.
 * A 200K-char novel with typical editing patterns produces 50–200
 * intervals (~2–5 KB serialized).
 *
 * Operations:
 *   - insertAt(pos, length, tag, sourceScore?)  — insert chars
 *   - deleteAt(pos, length)                     — delete chars
 *   - insertSlice(pos, slice)                   — insert a saved slice (for internal paste)
 *   - slice(start, end)                         — extract a sub-range
 *   - weightedCoverage()                        — compute coverage with score weighting
 *   - hashMap()                                 — SHA-256 of serialized map
 *   - serialize() / deserialize()               — JSON-safe encoding
 *   - totalLength()                             — sum of all intervals
 *   - validate()                                — assert invariants
 *
 * Thread safety: NOT thread-safe. Intended for single-threaded use
 * (browser main thread or Node.js server-side replay).
 */

import type { AuthorshipTag, AuthorshipInterval, AuthorshipMap } from '../types.js'

// ============================================================
// Core operations
// ============================================================

/**
 * Create an empty authorship map.
 */
export function createEmptyMap(): AuthorshipMap {
  return []
}

/**
 * Get the total character count covered by the map.
 */
export function totalLength(map: AuthorshipMap): number {
  if (map.length === 0) return 0
  const last = map[map.length - 1]
  return last.end
}

/**
 * Insert `length` characters at `pos` with the given tag.
 * Shifts all subsequent intervals right by `length`.
 *
 * For 'c' tags, sourceScore is required.
 */
export function insertAt(
  map: AuthorshipMap,
  pos: number,
  length: number,
  tag: AuthorshipTag,
  sourceScore?: number,
): void {
  if (length <= 0) return

  const newInterval: AuthorshipInterval = {
    start: pos,
    end: pos + length,
    tag,
  }
  if (tag === 'c' && sourceScore != null) {
    newInterval.sourceScore = sourceScore
  }

  // Find where pos falls
  let insertIdx = map.length
  for (let i = 0; i < map.length; i++) {
    if (pos <= map[i].start) {
      insertIdx = i
      break
    }
    if (pos > map[i].start && pos < map[i].end) {
      // Split this interval
      const original = map[i]
      const after: AuthorshipInterval = {
        start: pos + length,
        end: original.end + length,
        tag: original.tag,
      }
      if (original.sourceScore != null) after.sourceScore = original.sourceScore
      original.end = pos
      // Shift everything after
      for (let j = i + 1; j < map.length; j++) {
        map[j].start += length
        map[j].end += length
      }
      // Insert new interval and the split remainder
      map.splice(i + 1, 0, newInterval, after)
      mergeAdjacent(map)
      return
    }
  }

  // Shift everything at or after insertIdx
  for (let i = insertIdx; i < map.length; i++) {
    map[i].start += length
    map[i].end += length
  }

  // Insert the new interval
  map.splice(insertIdx, 0, newInterval)
  mergeAdjacent(map)
}

/**
 * Delete `length` characters starting at `pos`.
 * Shrinks or removes intervals that overlap the deleted range.
 * Shifts subsequent intervals left.
 */
export function deleteAt(
  map: AuthorshipMap,
  pos: number,
  length: number,
): void {
  if (length <= 0) return
  const delEnd = pos + length

  const result: AuthorshipInterval[] = []

  for (const interval of map) {
    if (interval.end <= pos) {
      // Entirely before deletion — keep as-is
      result.push({ ...interval })
    } else if (interval.start >= delEnd) {
      // Entirely after deletion — shift left
      result.push({
        ...interval,
        start: interval.start - length,
        end: interval.end - length,
      })
    } else {
      // Overlapping — may split or shrink
      // Part before deletion
      if (interval.start < pos) {
        const before: AuthorshipInterval = {
          ...interval,
          start: interval.start,
          end: pos,
        }
        result.push(before)
      }
      // Part after deletion
      if (interval.end > delEnd) {
        const after: AuthorshipInterval = {
          ...interval,
          start: pos,
          end: interval.end - length,
        }
        result.push(after)
      }
      // Part fully inside deletion — dropped
    }
  }

  // Replace map contents
  map.length = 0
  map.push(...result)
  mergeAdjacent(map)
}

/**
 * Extract a sub-range [start, end) from the map as a new map
 * with positions rebased to 0.
 *
 * Used for clipboard buffering (copy/cut) and excerpt derivation.
 */
export function sliceMap(
  map: AuthorshipMap,
  start: number,
  end: number,
): AuthorshipMap {
  const result: AuthorshipMap = []

  for (const interval of map) {
    if (interval.end <= start || interval.start >= end) continue

    const clippedStart = Math.max(interval.start, start)
    const clippedEnd = Math.min(interval.end, end)

    const entry: AuthorshipInterval = {
      start: clippedStart - start,
      end: clippedEnd - start,
      tag: interval.tag,
    }
    if (interval.sourceScore != null) entry.sourceScore = interval.sourceScore
    result.push(entry)
  }

  return result
}

/**
 * Insert a previously extracted slice (from sliceMap) at the given position.
 * Used for internal paste (rearrangement) — preserves source authorship tags.
 */
export function insertSlice(
  map: AuthorshipMap,
  pos: number,
  slice: AuthorshipMap,
): void {
  if (slice.length === 0) return

  const sliceLen = slice.length > 0 ? slice[slice.length - 1].end : 0
  if (sliceLen <= 0) return

  // First, shift everything at or after pos right by sliceLen
  // Then insert the rebased slice intervals
  // We do this by building a new map

  const before: AuthorshipMap = []
  const after: AuthorshipMap = []

  for (const interval of map) {
    if (interval.end <= pos) {
      before.push({ ...interval })
    } else if (interval.start >= pos) {
      after.push({
        ...interval,
        start: interval.start + sliceLen,
        end: interval.end + sliceLen,
      })
    } else {
      // Split
      before.push({
        ...interval,
        end: pos,
      })
      after.push({
        ...interval,
        start: pos + sliceLen,
        end: interval.end + sliceLen,
      })
    }
  }

  // Rebase slice to pos
  const rebasedSlice = slice.map(s => {
    const entry: AuthorshipInterval = {
      start: s.start + pos,
      end: s.end + pos,
      tag: s.tag,
    }
    if (s.sourceScore != null) entry.sourceScore = s.sourceScore
    return entry
  })

  // Replace map
  map.length = 0
  map.push(...before, ...rebasedSlice, ...after)
  mergeAdjacent(map)
}

// ============================================================
// Coverage computation
// ============================================================

/**
 * Compute weighted coverage from the authorship map.
 *
 * weightedExplained =
 *   count('t' positions) * 1.0
 *   + sum('c' intervals: length * sourceScore)
 *   + count('e' positions) * 0.0
 *
 * coverage = weightedExplained / totalCharCount
 */
export function weightedCoverage(map: AuthorshipMap): {
  coverage: number
  totalChars: number
  typedChars: number
  certifiedChars: number
  externalChars: number
  weightedExplained: number
} {
  let typedChars = 0
  let certifiedChars = 0
  let externalChars = 0
  let weightedExplained = 0

  for (const interval of map) {
    const len = interval.end - interval.start
    switch (interval.tag) {
      case 't':
        typedChars += len
        weightedExplained += len * 1.0
        break
      case 'c':
        certifiedChars += len
        weightedExplained += len * (interval.sourceScore ?? 0)
        break
      case 'e':
        externalChars += len
        break
    }
  }

  const totalChars = typedChars + certifiedChars + externalChars
  const coverage = totalChars > 0 ? Math.min(1.0, weightedExplained / totalChars) : 1.0

  return { coverage, totalChars, typedChars, certifiedChars, externalChars, weightedExplained }
}

/**
 * Check if all characters in the map (or a sub-range) are 't' or 'c'.
 * Used to validate excerpt derivation — excerpts with any 'e' chars
 * cannot be fully certified.
 */
export function allHumanEvidenced(map: AuthorshipMap): boolean {
  return map.every(interval => interval.tag === 't' || interval.tag === 'c')
}

// ============================================================
// Serialization & hashing
// ============================================================

/**
 * Serialize the map to a stable JSON string for hashing.
 * Produces a deterministic output (sorted keys, no whitespace).
 */
export function serializeMap(map: AuthorshipMap): string {
  // Use a compact format: [[start,end,tag,sourceScore?], ...]
  const compact = map.map(i => {
    if (i.tag === 'c' && i.sourceScore != null) {
      return [i.start, i.end, i.tag, i.sourceScore]
    }
    return [i.start, i.end, i.tag]
  })
  return JSON.stringify(compact)
}

/**
 * Deserialize from the compact format.
 */
export function deserializeMap(json: string): AuthorshipMap {
  const compact = JSON.parse(json) as Array<[number, number, AuthorshipTag, number?]>
  return compact.map(([start, end, tag, sourceScore]) => {
    const entry: AuthorshipInterval = { start, end, tag }
    if (sourceScore != null) entry.sourceScore = sourceScore
    return entry
  })
}

/**
 * Compute SHA-256 hash of the serialized map.
 * Works in both browser and Node.js environments.
 */
export async function hashMap(map: AuthorshipMap): Promise<string> {
  const serialized = serializeMap(map)
  const data = new TextEncoder().encode(serialized)

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(serialized).digest('hex')
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate map invariants:
 *   - Intervals are ordered by start
 *   - Intervals are non-overlapping and contiguous
 *   - No empty intervals (start < end)
 *   - Adjacent intervals have different tags (or different sourceScores for 'c')
 */
export function validateMap(map: AuthorshipMap): { valid: boolean; error?: string } {
  for (let i = 0; i < map.length; i++) {
    const interval = map[i]
    if (interval.start >= interval.end) {
      return { valid: false, error: `Interval ${i} has start >= end: [${interval.start}, ${interval.end})` }
    }
    if (i > 0 && interval.start !== map[i - 1].end) {
      return { valid: false, error: `Gap or overlap between intervals ${i-1} and ${i}: prev.end=${map[i-1].end}, curr.start=${interval.start}` }
    }
    if (interval.tag === 'c' && interval.sourceScore == null) {
      return { valid: false, error: `Interval ${i} has tag 'c' but no sourceScore` }
    }
  }
  return { valid: true }
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Merge adjacent intervals with the same tag (and same sourceScore for 'c').
 * This keeps the RLE representation compact.
 */
function mergeAdjacent(map: AuthorshipMap): void {
  let i = 0
  while (i < map.length - 1) {
    const curr = map[i]
    const next = map[i + 1]

    if (
      curr.end === next.start &&
      curr.tag === next.tag &&
      (curr.tag !== 'c' || curr.sourceScore === next.sourceScore)
    ) {
      curr.end = next.end
      map.splice(i + 1, 1)
      // Don't increment i — check the merged interval against the next one
    } else {
      i++
    }
  }

  // Remove empty intervals
  for (let j = map.length - 1; j >= 0; j--) {
    if (map[j].start >= map[j].end) {
      map.splice(j, 1)
    }
  }
}

/**
 * Convert an AuthorshipMap from the wire format (which may come as
 * plain arrays from JSON) to properly typed intervals.
 *
 * Accepts both the compact array format [[start,end,tag,score?], ...]
 * and the full object format [{ start, end, tag, sourceScore? }, ...].
 */
export function normalizeMapFromWire(raw: unknown): AuthorshipMap {
  if (!Array.isArray(raw)) return []

  return raw.map((item: any) => {
    if (Array.isArray(item)) {
      // Compact format
      const entry: AuthorshipInterval = {
        start: item[0],
        end: item[1],
        tag: item[2],
      }
      if (item[3] != null) entry.sourceScore = item[3]
      return entry
    }
    // Object format
    const entry: AuthorshipInterval = {
      start: item.start,
      end: item.end,
      tag: item.tag,
    }
    if (item.sourceScore != null) entry.sourceScore = item.sourceScore
    return entry
  })
}
