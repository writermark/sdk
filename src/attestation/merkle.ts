/**
 * merkle.ts — Merkle tree utilities for content chunk verification.
 *
 * ============================================================
 * PURPOSE
 * ============================================================
 *
 * When a user copies an excerpt from a certified document, we need
 * to prove that excerpt belongs to the certified text WITHOUT sending
 * the entire document. We do this by:
 *
 *   1. Splitting the normalized text into fixed-size chunks (5,000 chars)
 *   2. Hashing each chunk with SHA-256
 *   3. Building a Merkle tree from those hashes
 *   4. Storing ONLY the root (64 chars) in the signed checkpoint
 *
 * Later, to prove a chunk belongs to the certified document:
 *   - Provide the chunk text + a Merkle proof (a few sibling hashes)
 *   - The verifier hashes the chunk, walks the proof to the root,
 *     and checks it against the signed root in the checkpoint
 *
 * ============================================================
 * HOW MERKLE PROOFS WORK
 * ============================================================
 *
 * Given 4 chunks [C0, C1, C2, C3]:
 *
 *   Leaves:    H(C0)     H(C1)     H(C2)     H(C3)
 *                 \        /           \        /
 *   Level 1:   H(H0+H1)            H(H2+H3)
 *                    \                /
 *   Root:          H(H01 + H23)  ← this goes in the checkpoint
 *
 * To prove C2 is in the tree, the proof is:
 *   [ { hash: H(C3), position: 'right' },    ← sibling at leaf level
 *     { hash: H(H0+H1), position: 'left' } ] ← sibling at level 1
 *
 * Verification:
 *   1. Compute H(C2)
 *   2. H(C3) is on the right → compute H(H(C2) + H(C3)) = H(H2+H3)
 *   3. H(H0+H1) is on the left → compute H(H(H0+H1) + H(H2+H3)) = root
 *   4. Compare to the signed root ✓
 *
 * If C2 is altered, step 1 gives a different hash, and the final
 * root won't match. SHA-256 collision resistance makes this secure.
 *
 * ============================================================
 * CHUNK BOUNDARIES
 * ============================================================
 *
 * Chunks are fixed at CHUNK_SIZE characters of the NORMALIZED text.
 * They are NOT aligned to paragraphs, sentences, or any structure.
 * This is intentional:
 *   - Deterministic: anyone can recompute chunk boundaries from the text
 *   - Content-agnostic: no dependency on document structure
 *   - Stable: chunk N always starts at character N * CHUNK_SIZE
 *
 * The last chunk may be smaller than CHUNK_SIZE. If the number of
 * chunks is odd at any tree level, the last hash is duplicated
 * (standard Merkle tree padding).
 *
 * ============================================================
 * USAGE
 * ============================================================
 *
 * // Build tree (client, during /certify):
 * const hashes = await computeChunkHashes(normalizedText)
 * const tree = buildMerkleTree(hashes)
 * // Send tree.root to server → stored in checkpoint
 *
 * // Generate proof (client, on copy):
 * const proof = getMerkleProof(tree.layers, chunkIndex)
 *
 * // Verify proof (server, in /derive):
 * const leafHash = await sha256hex(chunkText)
 * const valid = verifyMerkleProof(leafHash, proof, signedRoot)
 */

import { normalizeText } from '../normalize.js'

/** Fixed chunk size in characters. */
export const CHUNK_SIZE = 5000

/**
 * A single step in a Merkle proof.
 * 'position' indicates where the sibling hash goes when concatenating:
 *   - 'left':  hash = H(proof.hash + currentHash)
 *   - 'right': hash = H(currentHash + proof.hash)
 */
export type MerkleProofStep = {
  hash: string
  position: 'left' | 'right'
}

/**
 * The full Merkle tree structure.
 * layers[0] = leaf hashes, layers[last] = [root].
 */
export type MerkleTree = {
  root: string
  layers: string[][]
}

// ---- Hashing (works in both browser and Node) ----

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Hash two hex strings together: SHA-256(left + right).
 * The inputs are concatenated as-is (hex strings), not decoded to bytes.
 */
async function hashPair(left: string, right: string): Promise<string> {
  return sha256hex(left + right)
}

// ---- Public API ----

/**
 * Split normalized text into fixed-size chunks and hash each one.
 *
 * @param normalizedText - Text AFTER normalization (call normalizeText first)
 * @returns Array of SHA-256 hex hashes, one per chunk
 */
export async function computeChunkHashes(normalizedText: string): Promise<string[]> {
  if (normalizedText.length === 0) return []

  const chunks: string[] = []
  for (let i = 0; i < normalizedText.length; i += CHUNK_SIZE) {
    chunks.push(normalizedText.slice(i, i + CHUNK_SIZE))
  }

  return Promise.all(chunks.map(chunk => sha256hex(chunk)))
}

/**
 * Split text into chunks (for sending specific chunks to /derive).
 *
 * @param text - Raw text (will be normalized internally)
 * @returns Array of { index, text } for each chunk
 */
export function splitIntoChunks(text: string): Array<{ index: number; text: string }> {
  const normalized = normalizeText(text)
  if (normalized.length === 0) return []

  const chunks: Array<{ index: number; text: string }> = []
  for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
    chunks.push({
      index: Math.floor(i / CHUNK_SIZE),
      text: normalized.slice(i, i + CHUNK_SIZE),
    })
  }
  return chunks
}

/**
 * Build a Merkle tree from leaf hashes.
 *
 * @param leafHashes - Array of SHA-256 hex hashes (from computeChunkHashes)
 * @returns The tree with root and all layers
 */
export async function buildMerkleTree(leafHashes: string[]): Promise<MerkleTree> {
  if (leafHashes.length === 0) {
    return { root: '', layers: [] }
  }

  if (leafHashes.length === 1) {
    return { root: leafHashes[0], layers: [leafHashes] }
  }

  const layers: string[][] = [[...leafHashes]]

  let currentLayer = leafHashes
  while (currentLayer.length > 1) {
    const nextLayer: string[] = []

    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(await hashPair(currentLayer[i], currentLayer[i + 1]))
      } else {
        // Odd number of nodes: duplicate the last one
        nextLayer.push(await hashPair(currentLayer[i], currentLayer[i]))
      }
    }

    layers.push(nextLayer)
    currentLayer = nextLayer
  }

  return { root: currentLayer[0], layers }
}

/**
 * Extract a Merkle proof for a specific leaf.
 *
 * The proof is the set of sibling hashes needed to reconstruct
 * the root from the leaf hash.
 *
 * @param layers - The tree layers from buildMerkleTree
 * @param leafIndex - Index of the leaf to prove
 * @returns Array of proof steps, from leaf level to root
 */
export function getMerkleProof(layers: string[][], leafIndex: number): MerkleProofStep[] {
  if (layers.length === 0) return []
  if (layers[0].length <= 1) return [] // single leaf = root, no proof needed

  const proof: MerkleProofStep[] = []
  let idx = leafIndex

  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]
    const isRight = idx % 2 === 1
    const siblingIdx = isRight ? idx - 1 : idx + 1

    if (siblingIdx < layer.length) {
      proof.push({
        hash: layer[siblingIdx],
        position: isRight ? 'left' : 'right',
      })
    } else {
      // Odd layer: sibling is a duplicate of self
      proof.push({
        hash: layer[idx],
        position: 'right',
      })
    }

    idx = Math.floor(idx / 2)
  }

  return proof
}

/**
 * Verify a Merkle proof against a known root.
 *
 * @param leafHash - SHA-256 hex hash of the chunk being verified
 * @param proof - Proof steps from getMerkleProof
 * @param root - The signed Merkle root from the checkpoint
 * @returns true if the proof is valid
 */
export async function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProofStep[],
  root: string,
): Promise<boolean> {
  if (!root) return false

  // Single-leaf tree: leaf IS the root
  if (proof.length === 0) return leafHash === root

  let currentHash = leafHash

  for (const step of proof) {
    if (step.position === 'left') {
      currentHash = await hashPair(step.hash, currentHash)
    } else {
      currentHash = await hashPair(currentHash, step.hash)
    }
  }

  return currentHash === root
}

/**
 * Given a selection range in normalized text, determine which chunk
 * indices it spans.
 *
 * @param startOffset - Start character offset in normalized text
 * @param endOffset - End character offset in normalized text
 * @returns Array of chunk indices the selection covers
 */
export function getChunkIndicesForRange(
  startOffset: number,
  endOffset: number,
): number[] {
  const startChunk = Math.floor(startOffset / CHUNK_SIZE)
  const endChunk = Math.floor(Math.max(0, endOffset - 1) / CHUNK_SIZE)

  const indices: number[] = []
  for (let i = startChunk; i <= endChunk; i++) {
    indices.push(i)
  }
  return indices
}

/**
 * Hash a single chunk of text (for server-side verification).
 * This is the same hash used in computeChunkHashes — sha256 of the raw chunk string.
 */
export async function hashChunk(chunkText: string): Promise<string> {
  return sha256hex(chunkText)
}
