export { Collector } from './collector.js'
export { VdfCoordinator, generateVdfSeed } from '../vdf/coordinator.js'
export type { VdfCheckpoint } from '../vdf/coordinator.js'
export { AudioMonitor } from './audio.js'
export { WritermarkSession } from './writermark-session.js'
export type { WritermarkSessionOptions, CertificationStatus, VdfState } from './writermark-session.js'
export {
  verify,
  verifyFile,
  extractFromFile,
  extractWtxt,
  extractMarkdown,
  extractPlainText,
  extractHtml,
  extractRtf,
  extractDocx,
  stripCertificateFooter,
  tiptapJsonToText,
  stripRtfToText,
  extractTokenFromRtf,
} from './verify.js'
export type {
  VerifyOptions,
  VerifyResult,
  VerifyFileResult,
  VerifyFileOptions,
  ExtractedFile,
} from './verify.js'
/** @deprecated Use WritermarkSession instead */
export { StreamingSession, ContinuousSession } from './session.js'
export type { ContinuousSessionOptions } from './session.js'
export {
  attachToTipTap,
  createCertificationContext,
  computeMerkleRoot,
  compressEvents,
  type TipTapEditor,
  type CertificationContext,
  type PendingPasteVerification,
} from './tiptap.js'
export { attachToElement } from './generic.js'
export { getTelemetryConsent, setTelemetryConsent } from './consent.js'
export { TelemetryUploader } from './telemetry-uploader.js'
export { normalizeText } from '../normalize.js'
export { hashText, extractToken, formatCertificate, formatCertificateFromToken } from '../attestation/certificate.js'
export {
  CHUNK_SIZE,
  computeChunkHashes,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  splitIntoChunks,
  getChunkIndicesForRange,
  hashChunk,
  type MerkleTree,
  type MerkleProofStep,
} from '../attestation/merkle.js'
// Authorship map utilities
export {
  createEmptyMap,
  insertAt as authorshipInsertAt,
  deleteAt as authorshipDeleteAt,
  sliceMap,
  insertSlice,
  weightedCoverage,
  allHumanEvidenced,
  serializeMap,
  deserializeMap,
  hashMap,
  validateMap,
  normalizeMapFromWire,
  totalLength as authorshipTotalLength,
} from '../authorship/map.js'
export type {
  AuthorshipTag,
  AuthorshipInterval,
  AuthorshipMap,
  ExcerptAuthorship,
  EvidenceBundle,
  CertifyResponse,
} from '../types.js'
