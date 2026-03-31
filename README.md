# @writermark/sdk

Human-authorship certification for text editors. The SDK observes how users type and issues cryptographic certificates proving a human wrote the text. No text content is stored on the server.

**Status:** Alpha — this SDK is in early development. Breaking changes may occur before the official 1.0.0 release. Reach out at `human@writermark.org` if you need help getting started.

## Install

```bash
npm install @writermark/sdk
```

Optional for DOCX verification support:

```bash
npm install jszip
```

## Quick Start: React + TipTap

The fastest path. One hook, one component, ~15 lines of code.

```jsx
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useWritermark, CertIndicator } from '@writermark/sdk/react'

function MyEditor() {
  const editor = useEditor({ extensions: [StarterKit] })

  const { status, certificate, certifyNow } = useWritermark('doc-1', editor, {
    onCheckpoint: (checkpoint, coverage, pass, cert, map, checkpoints) => {
      localStorage.setItem('my-checkpoint', checkpoint)
      localStorage.setItem('my-checkpoints', JSON.stringify(checkpoints))
    },
    previousCheckpoint: localStorage.getItem('my-checkpoint'),
    previousCheckpoints: JSON.parse(localStorage.getItem('my-checkpoints') || 'null'),
  })

  return (
    <div>
      <EditorContent editor={editor} />
      <CertIndicator status={status} certificate={certificate} certifyNow={certifyNow} />
    </div>
  )
}
```

That's it. The hook handles the full certification lifecycle — collecting behavioral telemetry, sending it to the server every 30 seconds, and maintaining a signed checkpoint chain. The `CertIndicator` shows a colored dot with the current status and a hover panel with score details.

### useWritermark options

| Prop | Type | Description |
|------|------|-------------|
| writermarkUrl | string? | API URL (defaults to `https://api.writermark.org`) |
| onCheckpoint | function | Called after each certification with `(checkpoint, coverage, pass, certificate, authorshipMap, checkpoints, vdfState)` |
| previousCheckpoint | string \| null | Restore a saved checkpoint to continue certification across sessions |
| previousCheckpoints | string[] \| null | Rolling window of recent checkpoint JWTs (max 2). Falls back to `previousCheckpoint` if not provided. |
| previousPass | boolean | Whether the previous checkpoint was passing |
| previousAuthorshipMap | AuthorshipMap \| null | Saved authorship map from a previous session |
| previousVdfState | VdfState \| null | VDF temporal proof state (not yet integrated) |
| debug | boolean | Log certification details to console |

### useWritermark return values

| Field | Type | Description |
|-------|------|-------------|
| status | 'idle' \| 'certifying' \| 'certified' \| 'not-certified' | Current certification state |
| coverage | number \| null | Fraction of text covered by observed keystrokes (0–1) |
| certificate | string \| null | Signed attestation JWT when passing |
| checkpoint | string \| null | Latest signed checkpoint JWT |
| certifyNow | () => Promise | Force an immediate certification cycle |
| authorshipMap | AuthorshipMap \| null | RLE array tracking provenance of each character |
| isTracking | boolean | Whether the collector is attached and running |

## TipTap without React

Use `WritermarkSession` — one constructor, full lifecycle handled for you. No manual fetch loops.

```javascript
import { WritermarkSession } from '@writermark/sdk'

const session = new WritermarkSession(editor, {
  documentId: 'my-doc',
  onCheckpoint: (checkpoint, coverage, pass, cert, map, checkpoints) => {
    myDatabase.save({ checkpoint, checkpoints, authorshipMap: map })
  },
  onStatusChange: (status) => {
    console.log('certification status:', status)
  },
  previousCheckpoint: myDatabase.get('checkpoint'),
  previousCheckpoints: myDatabase.get('checkpoints'),
})

// Force immediate certification (e.g. before publish or export)
const result = await session.certifyNow()

// Clean up when done
session.destroy()
```

`WritermarkSession` handles event collection, compression, the 30-second certification loop, checkpoint chain management, clipboard enrichment on copy, and certified paste detection — all internally. Same class works for all editor types.

### WritermarkSession options

| Option | Type | Description |
|--------|------|-------------|
| documentId | string | Persistent identifier for the document (required) |
| writermarkUrl | string? | API URL (defaults to `https://api.writermark.org`) |
| onCheckpoint | function | Called after each certification with `(checkpoint, coverage, pass, certificate, authorshipMap, checkpoints, vdfState)` |
| onStatusChange | function | Called when status changes: `'idle' | 'certifying' | 'certified' | 'not-certified'` |
| onCertifyResult | function | Called with the full server response object after each certification |
| previousCheckpoint | string \| null | Restore a saved checkpoint to continue across sessions |
| previousCheckpoints | string[] \| null | Rolling window of recent checkpoint JWTs (max 2) |
| previousPass | boolean | Whether the previous checkpoint was passing |
| previousAuthorshipMap | AuthorshipMap \| null | Saved authorship map from a previous session |
| previousVdfState | VdfState \| null | VDF temporal proof state (not yet integrated) |
| getText | () => string | Custom text getter (auto-detected for TipTap, textarea, contenteditable) |
| debug | boolean | Log certification details to console |

### WritermarkSession methods

| Method | Returns | Description |
|--------|---------|-------------|
| certifyNow() | Promise\<object \| null\> | Force an immediate certification cycle. Call before exporting or copying a certificate to ensure it matches the latest text. |
| getStatus() | CertificationStatus | Current certification state |
| getCertificate() | string \| null | Latest attestation JWT |
| getCheckpoint() | string \| null | Latest checkpoint JWT |
| getCheckpoints() | string[] | Full rolling checkpoint window |
| getVdfState() | VdfState \| null | Current VDF state (not yet integrated) |
| getAuthorshipMap() | AuthorshipMap \| null | Current authorship map |
| getCoverage() | number \| null | Keystroke coverage fraction (0–1) |
| isActive() | boolean | Whether the session is running |
| destroy() | void | Stop the session and clean up all listeners |

## Generic DOM (textarea / contenteditable)

Pass any `<textarea>`, `<input>`, or `contenteditable` element. The session auto-detects the element type.

```javascript
import { WritermarkSession } from '@writermark/sdk'

const session = new WritermarkSession(
  document.querySelector('#my-editor'),
  {
    documentId: 'my-doc',
    onCheckpoint: (checkpoint, coverage, pass) => {
      localStorage.setItem('checkpoint', checkpoint)
    },
  }
)

session.destroy()
```

Note: clipboard enrichment on copy (certified paste provenance) requires TipTap.

## Browser Script Tag

For non-bundled environments, load the SDK as a script tag. Everything is available on `window.Writermark`.

```html
<script src="https://writermark.org/sdk.js"></script>
<script>
  var session = new Writermark.WritermarkSession(
    document.querySelector('#my-editor'),
    {
      documentId: 'my-doc',
      onCheckpoint: function(checkpoint) {
        localStorage.setItem('wm-checkpoint', checkpoint)
      },
    }
  )
</script>
```

## Verification

The SDK includes a complete verification toolkit.

### Verify a file (golden path)

Hand it a `File` object from an `<input type="file">` or drag-and-drop. Supports `.wtxt`, `.docx`, `.rtf`, `.md`, `.txt`, and `.html`.

```javascript
import { verifyFile } from '@writermark/sdk'

const input = document.querySelector('input[type="file"]')
input.addEventListener('change', async () => {
  const result = await verifyFile(input.files[0])

  if (result.valid) {
    console.log('Verified!', result.score, result.confidence)
  } else {
    console.log('Failed:', result.detail)
  }
})
```

DOCX support requires [JSZip](https://www.npmjs.com/package/jszip) as an optional dependency.

### Verify text + token

```javascript
import { verify } from '@writermark/sdk'

const result = await verify({
  token: 'eyJhbGciOi...',   // raw JWT or full certificate text
  text: 'The original document text...',
})

console.log(result.valid)         // true/false
console.log(result.signatureOnly) // false (text was checked too)
console.log(result.score)         // 0.82
console.log(result.confidence)    // 0.88
```

### Verify token only (signature check)

```javascript
const result = await verify({ token: certificateText })
// result.signatureOnly === true
```

### Extract without verifying

```javascript
import { extractFromFile } from '@writermark/sdk'

const { text, token, fileType } = await extractFromFile(file)
// fileType: 'wtxt' | 'docx' | 'rtf' | 'md' | 'txt' | 'html'
```

### VerifyResult

| Field | Type | Description |
|-------|------|-------------|
| valid | boolean | Whether the certificate is valid |
| pass | boolean? | Whether the document passed certification |
| score | number? | Human-authorship score (0–1) |
| confidence | number? | Confidence level (0–1) |
| issuedAt | string? | ISO timestamp of certification |
| signatureOnly | boolean | True if only the signature was verified (no text hash check) |
| detail | string? | Human-readable detail on failure |

`verifyFile()` also returns `text`, `token`, and `fileType` on the result object.

## Custom Editor (Manual API)

For editors that aren't TipTap or standard DOM elements, use the `Collector` directly. Call `record*` methods from your editor's event handlers.

```javascript
import { Collector } from '@writermark/sdk'

const collector = new Collector()
collector.start()

collector.recordKey('KeyA', cursorPosition)
collector.recordKeyUp('KeyA')
collector.recordBackspace('Backspace', cursorPosition)
collector.recordEnter('Enter', cursorPosition)
collector.recordPaste(charCount, pastedText, 'external', cursorPosition)
collector.recordCopyOrCut(selectedText, copyStart, copyLength, isCut)
collector.recordCursorJump(distance)
collector.recordSelect(selectionLength)
collector.recordUndo()
collector.recordRedo()
collector.recordFocus()
collector.recordBlur()
collector.recordScroll(deltaY)
collector.recordMouse(xRatio, yRatio)  // 0-1 normalized
collector.recordVisibility(isVisible)
collector.recordMutation(position, deleteLength, insertLength, 'typed')
```

The `recordMutation` method is key — it tracks document changes for the authorship map. The `insertSource` parameter should be `'typed'`, `'paste-internal'`, `'paste-external'`, `'paste-certified'`, `'undo'`, or `'redo'`.

## API Reference

All API endpoints are served from `https://api.writermark.org`.

### POST /certify

The main certification endpoint. Stateless — all state lives in the signed checkpoint. Rate limit: 30/min per IP.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| documentId | string | Persistent document identifier (required on first call) |
| events | EditorEvent[] | New events since last checkpoint |
| checkpoints | string[] | Rolling window of recent checkpoint JWTs (max 2). Empty array on first call. |
| recentEvents | EditorEvent[] | Events from the previous window (for ML context). Empty on first call. |
| merkleRoot | string \| null | Merkle root of document chunks |
| authorshipMap | AuthorshipMap \| null | RLE authorship intervals |
| textHash | string | SHA-256 of normalized text |
| charCount | number | Current text length |
| vdfState | VdfState \| null | VDF temporal proof state (not yet integrated) |

The daemon also accepts legacy fields `checkpoint` (singular) and `contentMerkleRoot` for backward compatibility.

**Response:**

```json
{
  "checkpoint": "eyJhbGciOi...",
  "score": 0.72,
  "behavioralScore": 0.85,
  "coverage": 0.95,
  "pass": true,
  "certificate": "eyJhbGciOi...",
  "authorshipMap": [[0, 150, "human_evidenced"]],
  "confidence": 0.88,
  "activeWritingTimeMs": 120000,
  "revisionPercent": 8.5
}
```

### POST /verify

Verify a certificate's signature. Body: `{ "token": "eyJ..." }`

### POST /verify-text

Verify a certificate matches specific text. Body: `{ "text": "...", "token": "eyJ..." }`

### POST /derive

Create a standalone certificate for an excerpt (e.g. copy-paste certification). Requires a valid source JWT and Merkle proofs for the excerpt's chunks.

### GET /public-key

Returns the Ed25519 public key for verifying attestation JWTs.

```json
{
  "publicKey": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "..."
  }
}
```

### GET /.well-known/jwks.json

Standard JWKS endpoint for public key discovery. Key ID: `writermark-v1`.

## Components

### CertIndicator

Drop-in React component showing a colored status dot, label, and hover popup with certificate details.

```jsx
import { CertIndicator } from '@writermark/sdk/react'

<CertIndicator
  status={status}
  certificate={certificate}
  certifyNow={certifyNow}
/>
```

| Prop | Type | Description |
|------|------|-------------|
| status | CertificationStatus | From `useWritermark` |
| certificate | string \| null | Attestation JWT from `useWritermark` |
| certifyNow | () => Promise? | If provided, the indicator runs an immediate certification cycle before copying or viewing. Pass `certifyNow` from `useWritermark`. |
| writermarkUrl | string? | Server URL for "View certificate" link (defaults to writermark.org) |
| className | string? | CSS class override for the wrapper element |

## Links

- [Writermark](https://writermark.org) — Verify certificates and try the demo
- [Documentation](https://writermark.org/developers) — Full developer docs
- [Wintertext](https://wintertext.com) — Free desktop writing app with Writermark built in

## License

MIT
