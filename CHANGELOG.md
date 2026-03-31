# Changelog

## [0.6.5] - 2026-03-25
### Added
- **Per-event VDF checkpoint binding** — enabled by default. A background Web Worker runs continuous Wesolowski VDF proofs (~2s each, 512-bit discriminant, T=100). Events are cryptographically bound into the VDF chain, proving they occurred over real sequential time. A bot cannot batch-fabricate a 30-second session instantaneously. Set `enableVdf: false` to disable.
- Vendored `crypto-vdf-js` (Apache 2.0) into `src/vdf/` — pure TypeScript Wesolowski VDF using native BigInt. No WASM, no native dependencies. Replaces the external npm dependency for full code control and replaceability.
- `VdfCoordinator` class for managing the VDF checkpoint chain on the main thread
- `VdfCheckpoint` type exported from the SDK
- Daemon now accepts `vdfCheckpoints`, `vdfDiscriminantBits`, and `vdfInitialSeed` fields on `/certify` requests
- Daemon verifies the entire per-event VDF chain (~5ms per checkpoint via GMP-backed Rust `vdf` crate) and returns `event_vdf_checkpoint_count`, `event_vdf_chain_valid`, and `event_vdf_unbound_count`
- 1-second idle gap between VDF proofs to reduce continuous CPU load
- VDF worker built as a separate self-contained ESM bundle for cross-bundler compatibility (Vite, webpack 5, Rollup)
### Changed
- `Collector` now supports an `onEvent` callback for real-time event forwarding (used internally by the VDF coordinator)

## [0.6.4] - 2026-03-22
### Added
- `onCertifyResponse(response, events)` callback on both `useWritermark` and `WritermarkSession` — fires after each successful certification with the full daemon response (including per-window metrics, individual scoring signals, revision percent) and the compressed events that were sent. Enables host apps to collect ML training data without SDK coupling.
- Daemon now returns `scoringSignals` (individual signal breakdown) and `revisionPercent` in the `/certify` response

## [0.6.3] - 2026-03-22
### Changed
- `CertIndicator` now accepts an optional `certifyNow` prop — when provided, clicking "Copy certificate" or "View certificate" triggers an immediate certification cycle first, so the certificate always matches the latest text
- `telemetryConsent` and `sourceApp` removed from `WritermarkSession` options (telemetry is now handled separately by host apps)
- `TelemetryConsentBanner` and "Telemetry & Consent" section removed from public SDK documentation
- `vdfState` / `previousVdfState` marked as "(not yet integrated)" in all documentation — still accepted as parameters but VDF is not active
- `certifyNow()` documentation simplified — removed `{ final: true }` language since all certificates are full
- Wintertext now calls `certifyNow()` before every document export, ensuring the embedded certificate matches the exported text

## [0.6.2] - 2026-03-21
### Fixed
- Cleaned up codebase
- Updated Readme with new package usage documentation

## [0.6.1] - 2026-03-21
### Added
- **`WritermarkSession`** — new universal, framework-agnostic class that encapsulates the full certification lifecycle. One constructor, four golden paths:
  - React + TipTap: `useWritermark` hook (unchanged API, now re-exports Session types)
  - TipTap without React: `new WritermarkSession(editor, opts)`
  - Generic DOM (textarea/contenteditable): `new WritermarkSession(element, opts)`
  - Browser script tag: `new Writermark.WritermarkSession(element, opts)`
- `WritermarkSession` handles event collection, compression, the 30s certification loop, rolling checkpoint chain, clipboard enrichment, certified paste detection, VDF state, and telemetry — all internally
- `onStatusChange` and `onCertifyResult` callbacks for fine-grained UI control
- `certifyNow({ final: true })` to request a full certificate on demand
- `destroy()` for clean teardown of all listeners and timers
- Exported from `@writermark/sdk`, `@writermark/sdk/react`, browser bundle, and homepage bundle
- **Verification toolkit** — `verify()`, `verifyFile()`, and `extractFromFile()` for certificate verification:
  - `verifyFile(file)` — golden path: hand it a File, get a verification result. Supports `.wtxt`, `.docx`, `.rtf`, `.md`, `.txt`, `.html`
  - `verify({ token, text? })` — verify text + token or signature-only, with automatic JWT extraction from full certificate text
  - `extractFromFile(file)` — parse any supported file type and extract text + token without verifying
  - Format-specific extractors exported for advanced use: `extractWtxt`, `extractDocx`, `extractRtf`, `extractMarkdown`, `extractHtml`
  - Utility functions: `stripCertificateFooter()`, `tiptapJsonToText()`, `stripRtfToText()`
  - DOCX support requires `jszip` (optional peer dependency)
### Changed
- Homepage demo now uses `WritermarkSession` instead of hand-rolled certification loop
- `/developers` page updated with golden-path examples for all integration scenarios and verification
- `StreamingSession` and `ContinuousSession` deprecated in favor of `WritermarkSession`

## [0.6.0] - 2026-03-21
### Changed
- Converted all server-side functionality to Rust daemon
- Adjusted protocol to account for future local-only mode (offline mode), and for additional hardening functionality
- `useWritermark` hook now sends the full daemon protocol: rolling checkpoint array (N=2), `recentEvents` (previous window), `merkleRoot`, and optional `vdfState`
- Checkpoint window reduced from N=5 to N=2 (lighter payloads, ~30KB total SDK state)
- `onCheckpoint` callback now includes `checkpoints` array and `vdfState` for persistence
- New options: `previousCheckpoints`, `previousVdfState` for session restoration
- Wintertext persists `writermarkCheckpoints` and `writermarkVdfState` in `.wtxt` files (backward compatible — old files upgraded on load)
- TS server sunset. All endpoints now drive to Rust daemon (same as `/verify` and `/verify-text`)
- Default `VITE_WRITERMARK_URL` changed from TS server (3100) to Rust daemon (3001)
- SDK default API URL changed from `https://writermark.org` to `https://api.writermark.org`
- All API endpoints (verify page, cert viewer, developers page examples) now call daemon directly
- TS server stripped of all API routes — now serves only the website. All API logic lives in the Rust daemon.
### Fixed
- Wintertext now talks directly to the Rust daemon for all API calls, removing the legacy TS certification path
- Certified paste now correctly marked as "c" (certified) in authorship map instead of "e" (external) — event index was misaligned after compression
- Certified paste no longer strips newlines — enriched clipboard HTML now converts `\n` to `<br>`


## [0.5.12] - 2026-03-13
### Fixed
- Telemetry logic improved

## [0.5.11] - 2026-03-13
### Fixed
- Copy now forces an immediate certify when text has changed since last checkpoint, ensuring the Merkle tree is always current before deriving — fixes "Merkle proof verification failed" errors
- Chunks are now split from the Merkle-tree text snapshot, not live editor text
- Added 250K character cap on derive to prevent oversized requests on very large documents
### Changed
- Updated privacy language: "never stored" instead of "never sent/shared"
- Added debug logging for `/derive` response errors on copy/cut
- 30-second certify timer resets after a copy-triggered certify

## [0.5.9] - 2026-03-13
- Added debug logging to copy/clipboard enrichment and `/derive` response errors

## [0.5.8] - 2026-03-13
### Fixed
- Certified paste now works immediately when opening an already-certified document (merkle tree is pre-computed on load)

## [0.5.7] - 2026-03-13
### Fixed
- Added debug logging to copy/clipboard enrichment

## [0.5.6] - 2026-03-13
### Fixed
- CertIndicator hover popup no longer disappears when moving mouse to interact with it

## [0.5.2] - 2026-03-13
### Changed
- `writermarkUrl` is now optional in all APIs — defaults to `https://writermark.org`
- Removed self-hosting references from documentation

## [0.5.1] - 2026-03-12
### Changed
- Added Alpha status notice
- License updated to MIT
- Scoring signals removed from public API responses

## [0.5.0] - 2026-03-11
- Initial public release on npm
