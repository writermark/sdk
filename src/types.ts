// ============================================================
// writermark — shared types
// ============================================================

// ---- Client-side telemetry (what the SDK captures) ---------

/**
 * A single editor event. We NEVER capture actual characters —
 * only the type, timestamp, and structural metadata.
 *
 * Some event types are actively scored. Some are collected for
 * future analysis. Some are decoys. The SDK captures all of them;
 * the server decides which matter. This is intentional.
 */
export type EditorEvent = {
  /** Milliseconds since session start (sub-ms precision via performance.now) */
  t: number
  /** Event type */
  type:
    | 'key'        // A character was typed (we don't record which)
    | 'keyup'      // Key released (for dwell time: duration = keyup.t - key.t)
    | 'backspace'  // Backspace / delete
    | 'paste'      // Text was pasted
    | 'cursor'     // Cursor moved to a different position (non-adjacent)
    | 'enter'      // New line / paragraph
    | 'select'     // Text was selected (highlight, not just cursor)
    | 'copy'       // Text was copied (for authorship map clipboard buffer)
    | 'cut'        // Text was cut (clipboard buffer + deletion from map)
    | 'undo'       // Undo action (Ctrl+Z / Cmd+Z)
    | 'redo'       // Redo action (Ctrl+Shift+Z / Cmd+Shift+Z)
    | 'focus'      // Editor/window gained focus
    | 'blur'       // Editor/window lost focus
    | 'scroll'     // User scrolled in the editor
    | 'mouse'      // Mouse moved within the editor
    | 'visibility' // Tab became visible/hidden
    | 'compose'    // IME composition event (CJK input)
    | 'mutation'   // Precise document mutation from TipTap transaction diff (v5)
  /** For 'paste' events: how many characters were pasted */
  pasteLength?: number
  /**
   * For 'paste' events: where the pasted content came from.
   *   - 'internal': rearrangement within the editor (clipboard hash matched)
   *   - 'external': pasted from outside (no clipboard hash match)
   *   - 'certified': pasted from a writermark-certified document
   *     (client detected a writermark token in clipboard HTML;
   *      server MUST verify the JWT + text hash before crediting)
   */
  pasteSource?: 'internal' | 'external' | 'certified'
  /** For 'cursor' events: how far the cursor jumped (in characters) */
  jumpDistance?: number
  /** For 'select' events: how many characters were selected */
  selectLength?: number
  /** For 'scroll' events: scroll delta (positive = down) */
  scrollDelta?: number
  /** For 'mouse' events: coarse position bucket (not exact coords) */
  zone?: number
  /** For 'visibility' events: true = visible, false = hidden */
  visible?: boolean
  /**
   * Physical key zone (0–8) based on standard finger assignment.
   * Used for digraph/trigraph timing analysis WITHOUT recording characters.
   *
   * Zone mapping (QWERTY):
   *   0 = left pinky  (q,a,z,1,`,tab,caps,shift)
   *   1 = left ring   (w,s,x,2)
   *   2 = left middle  (e,d,c,3)
   *   3 = left index  (r,t,f,g,v,b,4,5)
   *   4 = thumbs      (space)
   *   5 = right index  (y,u,h,j,n,m,6,7)
   *   6 = right middle (i,k,comma,8)
   *   7 = right ring   (o,l,period,9)
   *   8 = right pinky  (p,;,/,',brackets,0,-,=,enter,backspace,shift)
   */
  kz?: number
  /**
   * Dwell time in ms (key hold duration: keydown to keyup).
   * Only present on 'keyup' events.
   */
  dwell?: number

  // ---- Per-position authorship fields (v4) ----

  /**
   * Cursor position (0-based character offset) at the time of the event.
   * Present on key, backspace, enter, paste events for authorship tracking.
   * For key/enter: the position where the character will be inserted.
   * For backspace: the position of the character being deleted.
   * For paste: the position where the paste begins.
   */
  pos?: number

  /**
   * For copy/cut events: the start position of the selected range.
   * Together with copyLen, defines the copied/cut region for
   * authorship map clipboard buffering.
   */
  copyStart?: number

  /**
   * For copy/cut events: the length of the selected text.
   */
  copyLen?: number

  // ---- Mutation fields (v5) ----

  /**
   * For 'mutation' events: number of plain-text characters deleted at pos.
   * 0 for pure insertions.
   */
  deleteLen?: number

  /**
   * For 'mutation' events: number of plain-text characters inserted at pos.
   * 0 for pure deletions.
   */
  insertLen?: number

  /**
   * For 'mutation' events: provenance of the inserted content.
   *   - 'typed': normal keyboard input (tag 't')
   *   - 'paste-internal': rearrangement within the editor (inherit clipboard buffer tags)
   *   - 'paste-external': pasted from outside (tag 'e')
   *   - 'paste-certified': pasted from a certified document (tag 'c', pending server verification)
   *   - 'undo'/'redo': undo/redo operation (tag 'e' to prevent laundering)
   */
  insertSource?: 'typed' | 'paste-internal' | 'paste-external' | 'paste-certified' | 'undo' | 'redo'
}

/**
 * An audio amplitude spike detected by the microphone.
 * We don't record audio — just the timestamp and peak amplitude.
 */
export type AudioPeak = {
  /** Milliseconds since session start */
  t: number
  /** Normalized amplitude 0–1 */
  amplitude: number
}

/**
 * The full telemetry payload sent from the client SDK to the
 * scoring server. Contains NO text content — only process data.
 */
export type TelemetryPayload = {
  /** Unique session identifier */
  sessionId: string
  /** ISO timestamp when the session started */
  sessionStart: string
  /** Total session duration in milliseconds */
  sessionDurationMs: number
  /** Total characters in the final text (not the text itself) */
  finalCharCount: number
  /** Total words in the final text */
  finalWordCount: number
  /** SHA-256 hash of the final text content */
  textHash: string
  /** All editor events, ordered by timestamp */
  events: EditorEvent[]
  /** Audio peaks from microphone correlation (optional) */
  audioPeaks?: AudioPeak[]
  /** Whether audio capture was enabled */
  audioEnabled: boolean
  /** Client SDK version */
  sdkVersion: string
}


// ---- Server-side scoring -----------------------------------

/**
 * The result of a single scoring signal (one dimension of analysis).
 */
export type SignalScore = {
  /** Signal name (e.g. 'speed-variance', 'pause-distribution') */
  name: string
  /** Score from 0 (definitely not human) to 1 (definitely human) */
  score: number
  /** Confidence in this signal, 0–1 (low if insufficient data) */
  confidence: number
  /** Human-readable explanation of the result */
  reason: string
}

/**
 * Weights for each scoring signal. Higher = more influence.
 */
export type SignalWeights = {
  speedVariance: number
  pauseDistribution: number
  revisionRatio: number
  nonLinearity: number
  burstPatterns: number
  pasteAnalysis: number
  audioCorrelation: number
  sessionPlausibility: number
  // Deep signals (v2) — derived from adversarial testing
  timestampEntropy: number
  burstAcceleration: number
  intervalShape: number
  timingAutocorrelation: number
  // Motor signals (v3) — dwell time, rollover, digraph timing
  dwellConsistency: number
  rolloverRate: number
  digraphTiming: number
  dfaScaling: number
  spacebarDynamics: number
}

/**
 * Minimum effective score required for a document to pass certification.
 * Single source of truth — import this instead of hardcoding 0.55.
 */
export const PASS_THRESHOLD = 0.55

/**
 * Bump this when scoring logic, weights, or signals change.
 * Stored in every checkpoint so we know which algorithm version
 * produced a given score. This lets future code handle old
 * checkpoints differently if needed (e.g. re-score vs. trust).
 */
export const SCORING_VERSION = 1

/**
 * Default weights — tuned via adversarial testing.
 *
 * v1 signals that are easily gamed by bots (pause distribution,
 * session plausibility, non-linearity) have reduced weights.
 * v2 "deep" signals based on motor-control properties have
 * increased weights because they're structurally hard to fake.
 */
export const DEFAULT_WEIGHTS: SignalWeights = {
  // v1 signals — reduced weights where bots outscore humans
  speedVariance: 1.0,
  pauseDistribution: 0.8,    // Reduced: bot easily fakes "perfect" pause mix
  revisionRatio: 1.0,
  nonLinearity: 0.4,         // Reduced: terminal/simple-editor users never jump cursor
  burstPatterns: 1.0,
  pasteAnalysis: 1.5,
  audioCorrelation: 0.0,     // BONUS signal — never penalizes, only helps
  sessionPlausibility: 0.5,  // Reduced: trivially gamed, penalizes fast human typists
  // v2 deep signals — hard to fake, based on motor-control properties
  timestampEntropy: 0.0,      // Not discriminating (d ≈ 0 with integer timestamps)
  burstAcceleration: 2.0,     // Strong discriminator (d = -1.8)
  intervalShape: 2.0,         // Strong (kurtosis d = +1.1)
  timingAutocorrelation: 1.5, // Strong (d = +1.0)
  // v3 motor signals — dwell time and physical key mechanics
  dwellConsistency: 2.0,      // Key hold duration variance
  rolloverRate: 1.5,          // Overlapping keypresses (negative flight time)
  digraphTiming: 1.5,         // Zone-pair timing patterns
  dfaScaling: 0.5,             // Permutation entropy + DFA — weak discriminator at typical session lengths
  spacebarDynamics: 2.0,       // Post-space delay + pre-space variability (d = 2.4)
}

/**
 * The combined scoring result from all signals.
 */
export type ScoringResult = {
  /** Overall score 0–1 */
  score: number
  /** Whether the telemetry passes the human-authorship threshold */
  pass: boolean
  /** The threshold used */
  threshold: number
  /** Individual signal scores */
  signals: SignalScore[]
  /** Overall confidence (weighted average of signal confidences) */
  confidence: number
  /** Whether audio keystroke correlation was confirmed (bonus signal) */
  audioVerified: boolean
}


// ---- Attestation -------------------------------------------

/**
 * The signed attestation payload (what goes inside the JWT).
 */
export type AttestationPayload = {
  /** SHA-256 hash of the attested text */
  textHash: string
  /** Overall human-authorship score */
  score: number
  /** Whether it passed the threshold */
  pass: boolean
  /** Confidence level */
  confidence: number
  /** When the attestation was issued (ISO) */
  issuedAt: string
  /** Summary of individual signal results (omitted from slim certificates) */
  signals?: Array<{ name: string; score: number }>
  /** Session/document ID for traceability (omitted from slim certificates) */
  sessionId?: string
  /** writermark version (omitted from slim certificates) */
  version?: string
  /** Whether audio keystroke matching was confirmed (omitted from slim certificates) */
  audioVerified?: boolean
  /** Cumulative active writing time in ms (omitted from slim certificates if unavailable) */
  activeWritingTimeMs?: number
  /** Percentage of keystrokes that were deletions (0–100) */
  revisionPercent?: number
}


// ---- Continuous Certification (Checkpoint Chain) -----------

/**
 * Welford online accumulator for computing mean, variance,
 * skewness, and kurtosis in a single pass without storing values.
 */
export type WelfordAccumulator = {
  n: number
  mean: number
  m2: number   // for variance
  m3: number   // for skewness
  m4: number   // for kurtosis
}

/**
 * Simple running sum accumulator for computing mean and variance.
 */
export type SumAccumulator = {
  n: number
  sum: number
  sumSq: number
}

/**
 * Tracks per zone-pair digraph timing statistics.
 */
export type DigraphAccumulator = {
  /** Map of "zone1-zone2" → { n, sum, sumSq } */
  pairs: Record<string, SumAccumulator>
}

/**
 * Running aggregates for all scoring signals.
 * Incrementally updated with each batch of events.
 * Stored inside signed checkpoints — the server never
 * needs to replay raw events.
 */
export type RunningAggregates = {
  // ---- Interval distribution (for interval-shape, speed-variance) ----
  intervals: WelfordAccumulator

  // ---- Dwell time (for dwell-consistency) ----
  /** Global dwell time stats */
  dwellGlobal: WelfordAccumulator
  /** Per-zone dwell accumulators (zone 0–8) */
  dwellByZone: Record<number, WelfordAccumulator>

  // ---- Digraph timing ----
  digraphs: DigraphAccumulator

  // ---- Rollover ----
  rollover: {
    totalPairs: number
    overlaps: number
    flightTimeAcc: WelfordAccumulator
  }

  // ---- Spacebar dynamics ----
  spacebar: {
    postSpace: SumAccumulator   // delays after space
    preSpace: SumAccumulator    // delays before space
    intraWord: SumAccumulator   // delays within words (non-space to non-space)
  }

  // ---- Burst analysis ----
  bursts: {
    /** Intervals at the end of last batch (for cross-batch burst continuity) */
    pendingIntervals: number[]
    /** Completed burst count */
    burstCount: number
    /** Burst lengths for CV calculation */
    burstLengthSum: number
    burstLengthSumSq: number
    /** Burst ramp-up slopes */
    rampUpSum: number
    rampUpCount: number
    /** Short / long burst counts */
    shortBursts: number
    longBursts: number
  }

  // ---- Paste tracking ----
  paste: {
    pasteCount: number
    externalPasteChars: number
    internalPasteChars: number
    largestPaste: number
  }

  // ---- Revision tracking ----
  revisions: {
    backspaceCount: number
    totalKeystrokes: number   // key + backspace + enter
  }

  // ---- Pause distribution ----
  pauses: {
    shortCount: number     // ≤ 300ms
    mediumCount: number    // 300ms – 2000ms
    longCount: number      // > 2000ms
    /** Medium-pause accumulator for CV calculation */
    mediumAcc: SumAccumulator
  }

  // ---- Timing autocorrelation ----
  autocorrelation: {
    /** Last 3 intervals for lag computation at batch boundaries */
    lastIntervals: number[]
    /** Running products for lag-1, lag-2, lag-3 */
    lag1Sum: number
    lag2Sum: number
    lag3Sum: number
    lag1Count: number
  }

  // ---- Carryover state (for cross-batch continuity) ----
  carryover: {
    /** Last typing event timestamp */
    lastEventT: number
    /** Last typing event key zone */
    lastEventKz: number | null
    /** Pending keydowns awaiting keyup (code → downTime) */
    pendingKeydowns: Record<string, number>
    /** Last event zone for spacebar analysis */
    lastSpacebarKz: number | null
  }

  // ---- Speed variance (30s window counts) ----
  speedWindows: {
    /** Welford accumulator of per-window keystroke counts */
    windowAcc: WelfordAccumulator
    /** Current (incomplete) window index */
    currentWindowIndex: number
    /** Keystroke count in the current window */
    currentWindowCount: number
  }

  // ---- Timestamp entropy (LSB histogram) ----
  /** Histogram of timestamp mod 100 values (100 bins) */
  timestampLsbHistogram: number[]

  // ---- Non-linearity ----
  nonLinearity: {
    cursorJumps: number
    largeCursorJumps: number   // jumpDistance > 50
  }

  // ---- Event counts ----
  eventCounts: Record<string, number>
  totalEvents: number

  // ---- Timing metadata ----
  firstEventTs: number
  lastEventTs: number
  totalDurationMs: number
  totalSessionCount: number
}

/**
 * Tracks what fraction of the document's text is explained
 * by validated telemetry events.
 *
 * Coverage = explainedChars / currentCharCount, where:
 *   explainedChars = typedChars - deletedChars + internalPasteChars + certifiedPasteChars
 *
 * External paste chars do NOT count toward coverage (they represent
 * unverified text injection).
 *
 * Certified paste chars DO count — the server has independently
 * verified their JWT signature and text hash, confirming they
 * originated from a human-written, certified document.
 */
export type CoverageTracker = {
  /** Cumulative characters typed (key events) */
  typedChars: number
  /** Cumulative characters deleted (backspace events) */
  deletedChars: number
  /** Characters pasted from within the editor (clipboard hash matched) */
  internalPasteChars: number
  /** Characters pasted from outside (no clipboard hash match) */
  externalPasteChars: number
  /**
   * Characters pasted from another certified document.
   * Only incremented AFTER the server verifies:
   *   1. The JWT signature is valid (Ed25519)
   *   2. The server-computed SHA-256 of the pasted text matches
   *      the textHash inside the JWT
   *
   * This prevents a modified client from claiming fake coverage.
   */
  certifiedPasteChars: number
  /** Text length at the previous checkpoint */
  lastKnownCharCount: number
}

/**
 * The payload stored inside a signed checkpoint JWT.
 * Each checkpoint IS a full attestation — the document is
 * continuously certified as the writer types.
 */
export type CheckpointPayload = {
  // ---- Identity & chain integrity ----
  /** Persistent document identifier */
  documentId: string
  /** Sequential checkpoint counter */
  checkpointIndex: number
  /** SHA-256 hash of the previous checkpoint JWT (null = first) */
  prevCheckpointHash: string | null

  // ---- Current attestation (THIS is the certificate) ----
  /** SHA-256 of the text at this checkpoint */
  textHash: string
  /** Current text length in characters */
  charCount: number
  /** Behavioral human-likeness score (0–1) */
  behavioralScore: number
  /** Telemetry coverage ratio (0–1) */
  coverage: number
  /** Effective score = behavioralScore * coverage */
  score: number
  /** Whether it meets the pass threshold */
  pass: boolean
  /** Overall confidence */
  confidence: number
  /** Individual signal summaries (omitted from checkpoint to keep scoring private) */
  signals?: Array<{ name: string; score: number }>
  /** Which scoring algorithm version produced this score */
  scoringVersion?: number

  // ---- Timing ----
  /** Earliest event timestamp (ms since epoch) */
  firstEventTs: number
  /** Latest event timestamp (ms since epoch) */
  lastEventTs: number
  /** Cumulative writing duration across all sessions */
  totalDurationMs: number
  /** Number of distinct writing sessions */
  totalSessionCount: number
  /** Cumulative time (ms) spent actively writing — only checkpoint intervals with meaningful telemetry count */
  activeWritingTimeMs: number
  /** Percentage of typed characters that were revised away (0–100) */
  revisionPercent: number
  /** When this checkpoint was issued (ISO string) */
  serverIssuedAt: string

  // ---- Content integrity (Merkle tree) ----
  /**
   * SHA-256 Merkle root of the document's content chunks.
   *
   * The normalized text is split into fixed 5,000-character chunks,
   * each chunk is SHA-256 hashed, and the hashes are organized into
   * a Merkle tree. Only this root (64 hex chars) is stored here.
   *
   * This enables bandwidth-efficient excerpt certification:
   * to prove an excerpt belongs to this document, only the relevant
   * chunks (~10-15KB) and a compact Merkle proof (~8 hashes) are
   * needed — not the entire document.
   *
   * null on the first checkpoint if client hasn't computed it yet,
   * or for very short documents (< CHUNK_SIZE chars).
   */
  contentMerkleRoot: string | null

  /**
   * Total characters pasted from other certified documents whose
   * JWTs have been server-verified. These count toward coverage.
   */
  certifiedPasteChars: number

  /**
   * SHA-256 hash of the serialized AuthorshipMap.
   *
   * The authorship map is a per-character provenance record:
   * every character is tagged 't' (typed), 'c' (certified paste),
   * or 'e' (external paste). The map is stored client-side (RLE
   * intervals), and only its hash is embedded in the signed checkpoint.
   *
   * The server independently reconstructs the map by replaying
   * events against the previous map, then verifies the hash matches.
   */
  authorshipHash: string | null

  // ---- State for next checkpoint (opaque to client) ----
  /** Running aggregate statistics */
  aggregates: RunningAggregates
  /** Character coverage tracking */
  coverageTracker: CoverageTracker

  // ---- Summary ----
  /** Total editor events processed */
  totalEvents: number
  /** Event counts by type */
  eventCounts: Record<string, number>
}

/**
 * Request body for POST /certify
 */
export type CertifyRequest = {
  /** Persistent document identifier (required for first certify, optional afterwards — server reads from checkpoint) */
  documentId?: string
  /** New events since last checkpoint */
  events: EditorEvent[]
  /** SHA-256 hash of the current text (computed client-side) */
  textHash: string
  /** Current text length */
  charCount: number
  /** Previous checkpoint JWT (null = first certification) */
  checkpoint: string | null
  /** Events buffered client-side during close (sent on reopen) */
  bufferedEvents?: EditorEvent[]
  /** If true, include a formatted certificate in response */
  final?: boolean

  /**
   * Merkle root of the document's content chunks.
   *
   * The client splits the normalized text into fixed 5,000-char chunks,
   * hashes each, and builds a Merkle tree. Only the root is sent here.
   * The server stores it in the checkpoint for future /derive calls.
   *
   * Optional — older clients that don't compute it will send null.
   */
  contentMerkleRoot?: string | null

  /**
   * Paste verification requests for certified paste events.
   *
   * When the client detects a writermark token in pasted clipboard HTML,
   * it bundles the token and pasted text here for SERVER-SIDE verification.
   *
   * The server will:
   *   1. Verify the JWT signature (Ed25519)
   *   2. Hash the pasted text server-side (SHA-256)
   *   3. Confirm the hash matches the JWT's textHash
   *   4. If valid, credit the paste chars toward coverage
   *
   * This design prevents a modified client from faking coverage:
   *   - Can't forge a JWT (needs server's private key)
   *   - Can't provide fake text (server hashes it independently)
   *   - Can't match a stolen JWT to different text (SHA-256 preimage resistance)
   */
  pasteVerifications?: Array<{
    /** Index into the events array where the paste event is */
    eventIndex: number
    /** The writermark JWT from the clipboard */
    token: string
    /** The actual text that was pasted (server will hash this) */
    text: string
  }>

  /**
   * The current authorship map (RLE intervals).
   *
   * Sent alongside events so the server can verify the map's hash
   * matches the previous checkpoint, then replay new events against
   * the map to produce an updated version.
   *
   * null on the first checkpoint (empty document = no map yet).
   */
  authorshipMap?: AuthorshipMap | null
}

/**
 * Response body for POST /certify
 */
export type CertifyResponse = {
  /** Signed checkpoint JWT (IS the attestation) */
  checkpoint: string
  /** Effective score (behavioral * coverage) */
  score: number
  /** Raw human-likeness score */
  behavioralScore: number
  /** Telemetry coverage ratio */
  coverage: number
  /** Whether it meets the threshold */
  pass: boolean
  /** Individual signal scores (from TypeScript server) */
  signals?: SignalScore[]
  /** Formatted certificate (present when pass=true) */
  certificate?: string
  /** Cumulative active writing time in ms */
  activeWritingTimeMs?: number
  /** Percentage of keystrokes that were deletions (0–100) */
  revisionPercent?: number
  /** Updated authorship map after server replay */
  authorshipMap?: AuthorshipMap | null
  /** ML classification score (null until model exists) */
  mlScore?: number | null
  /** Evidence tier for this checkpoint (T1–T4) */
  tier?: string
  /** Updated VDF state for client to carry forward */
  vdfState?: VdfState | null
}

/**
 * VDF (Verifiable Delay Function) state.
 * Carried between client and server across checkpoints.
 * Proves sequential real-world time elapsed since session start.
 */
export type VdfState = {
  /** Random 32-byte seed (hex), set once at session start */
  seed: string
  /** Latest VDF output (hex), result of chaining SHA-256 iterations */
  output: string
  /** Number of VDF steps completed (1 per checkpoint) */
  stepCount: number
}

/**
 * Three-layer evidence bundle for document embedding.
 * Fixed ~13KB regardless of session length.
 */
export type EvidenceBundle = {
  /** Layer 1: compressed proof of full session */
  historical: {
    vdfSeed: string
    vdfOutput: string
    vdfStepCount: number
    vdfIterationsPerStep: number
    sessionStartTsa?: string | null
    finalTsa?: string | null
  }
  /** Layer 2: last N signed checkpoint JWTs */
  recentCheckpoints: string[]
  /** Layer 3: the current certificate JWT */
  certificate: string
}


// ---- Per-Position Authorship Map ----------------------------

/**
 * Authorship tag for a character position.
 *   't' — typed at this position (direct key event evidence)
 *   'c' — pasted from a certified source (transitive evidence, weighted by sourceScore)
 *   'e' — pasted from an unknown/external source (no evidence, weight = 0)
 */
export type AuthorshipTag = 't' | 'c' | 'e'

/**
 * A run-length-encoded interval in the authorship map.
 *
 * For 'c' intervals, sourceScore carries the behavioral score
 * of the source document (0–1). Coverage credit for 'c' chars
 * is weighted by this score: chars * sourceScore.
 */
export type AuthorshipInterval = {
  /** Inclusive start position */
  start: number
  /** Exclusive end position */
  end: number
  /** Authorship tag */
  tag: AuthorshipTag
  /**
   * Source document's behavioral score (only for tag === 'c').
   * Coverage contribution = (end - start) * sourceScore.
   */
  sourceScore?: number
}

/**
 * The per-character authorship map: an ordered, non-overlapping
 * list of RLE intervals covering positions [0, docLength).
 *
 * Typical size for a 200K-char novel: 50–200 intervals (~2–5 KB).
 */
export type AuthorshipMap = AuthorshipInterval[]

/**
 * Authorship data included in a derived attestation to enable
 * proper tagging when the excerpt is pasted into a new document.
 */
export type ExcerptAuthorship = {
  /** Per-char authorship for the excerpt (RLE intervals, 0-based relative to excerpt) */
  map: AuthorshipMap
  /** The source document's overall score at derivation time */
  sourceScore: number
}


// ---- Derived Attestation (Excerpt Certification) -----------

/**
 * Payload for a derived attestation — a standalone certificate
 * for an excerpt of a certified document.
 *
 * A derived attestation:
 *   - Has its own textHash (hash of the excerpt, not the parent)
 *   - Inherits the parent's behavioral score
 *   - References the parent via derivedFrom and parentTextHash
 *   - Is cryptographically linked to the parent checkpoint via
 *     the Merkle proof verification performed by the server
 *
 * Derived attestations are normal JWTs that can be verified like
 * any other attestation. The verify page handles them transparently.
 *
 * Security chain:
 *   1. Parent checkpoint JWT is signed by server's Ed25519 key
 *   2. Parent checkpoint contains contentMerkleRoot
 *   3. /derive verifies the provided chunks against that root
 *   4. /derive confirms the excerpt is a substring of those chunks
 *   5. /derive signs a new JWT for the excerpt's hash
 *   → If any chunk was altered, the Merkle proof fails (step 3)
 *   → If the excerpt doesn't match the chunks, step 4 fails
 *   → The derived JWT can't be forged (needs the server's private key)
 */
export type DerivedAttestationPayload = AttestationPayload & {
  /** SHA-256 hash of the parent checkpoint JWT */
  derivedFrom: string
  /** textHash of the parent (full document) */
  parentTextHash: string
  /**
   * Per-character authorship for the excerpt.
   * When this excerpt is pasted into a new document, the destination
   * uses this to tag each character as 'c' (with sourceScore) or 'e'.
   * Only present when the source document has an authorship map.
   */
  excerptAuthorship?: ExcerptAuthorship
}

/**
 * Request body for POST /derive
 */
export type DeriveRequest = {
  /**
   * The checkpoint or attestation JWT for the source document.
   * Must contain a contentMerkleRoot in its payload.
   */
  token: string
  /**
   * The excerpt text to derive a standalone certificate for.
   * Will be normalized and verified as a substring of the chunks.
   */
  excerpt: string
  /**
   * Only the chunks that span the excerpt — NOT the entire document.
   * For a 200,000-word document, this might be 2-3 chunks (~15KB)
   * instead of the full ~1.2MB.
   */
  chunks: Array<{
    /** Chunk index in the document (0-based) */
    index: number
    /** The actual chunk text (5,000 chars, or less for the last chunk) */
    text: string
  }>
  /**
   * One Merkle proof per chunk, proving it belongs to the
   * contentMerkleRoot stored in the signed checkpoint.
   *
   * Each proof is an array of sibling hashes from leaf to root.
   * Verification: hash the chunk, walk the proof, compare to root.
   */
  merkleProofs: Array<{
    /** Which chunk this proof is for (matches chunks[].index) */
    leafIndex: number
    /** Proof steps from leaf level to root */
    proof: Array<{ hash: string; position: 'left' | 'right' }>
  }>
  /**
   * The source document's authorship map (RLE intervals).
   * Required for per-character authorship in the derived cert.
   * The server verifies the map hash matches the checkpoint's
   * authorshipHash before extracting the excerpt's authorship.
   *
   * Optional for backward compatibility — if not provided, the
   * derived cert won't include excerptAuthorship.
   */
  authorshipMap?: AuthorshipMap | null

  /**
   * The start offset of the excerpt within the normalized document.
   * Used to extract the correct authorship interval from the map.
   */
  excerptStart?: number
}

/**
 * Response body for POST /derive
 */
export type DeriveResponse = {
  /** Signed JWT for the excerpt (standalone, verifiable) */
  token: string
  /** Formatted certificate for the excerpt */
  certificate: string
  /** The excerpt's text hash */
  textHash: string
  /** Inherited score from the parent */
  score: number
  /** Whether it passes the threshold */
  pass: boolean
}
