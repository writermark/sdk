/**
 * Writermark Text Normalization (v2)
 *
 * Before hashing, text is canonicalized so that cosmetically-identical
 * text always produces the same SHA-256 hash. The goal: if the text
 * *looks the same* to a human reader, it should verify. Platforms,
 * browsers, and OS autocorrect systems constantly swap characters for
 * visually-equivalent alternatives — none of that should break
 * verification.
 *
 * Normalization rules (applied in order):
 *
 *   1. Unicode NFC normalization
 *      "é" (e + combining accent) → "é" (precomposed).
 *
 *   2. Line ending normalization → \n
 *      \r\n (Windows) and \r (old Mac) → \n.
 *
 *   3. Whitespace normalization
 *      - Non-breaking space (U+00A0) → regular space
 *      - Thin space (U+2009), hair space (U+200A), en space (U+2002),
 *        em space (U+2003), figure space (U+2007), narrow no-break
 *        space (U+202F), medium math space (U+205F),
 *        ideographic space (U+3000) → regular space
 *      - Line separator (U+2028), paragraph separator (U+2029)
 *        → regular space
 *      - Collapse trailing whitespace on each line
 *
 *   4. Strip invisible characters
 *      Zero-width space (U+200B), zero-width non-joiner (U+200C),
 *      zero-width joiner (U+200D), BOM (U+FEFF), soft hyphen (U+00AD),
 *      word joiner (U+2060), left/right marks (U+200E/F),
 *      combining grapheme joiner (U+034F), Arabic letter mark (U+061C),
 *      directional formatting (U+2066–U+206F),
 *      interlinear annotations (U+FFF9–U+FFFC).
 *
 *   5. Typographic quote normalization → ASCII equivalents
 *      - " " „ ‟ (U+201C, U+201D, U+201E, U+201F) → "
 *      - ' ' ‚ ‛ (U+2018, U+2019, U+201A, U+201B) → '
 *      - This covers smart/curly quotes from macOS autocorrect,
 *        Word, Google Docs, Twitter, and every CMS on the planet.
 *
 *   6. Typographic punctuation normalization
 *      - … (U+2026 horizontal ellipsis) → ...
 *      - – (U+2013 en dash) → -
 *      - — (U+2014 em dash) → --
 *      - ‐ (U+2010 hyphen) → -
 *      - − (U+2212 minus sign) → -
 *
 *   7. Trim leading and trailing whitespace
 *
 * What we intentionally DO NOT normalize:
 *   - Case (obviously)
 *   - Multiple spaces within a line (could be intentional)
 *   - Paragraph spacing / multiple newlines (author intent)
 *   - Actual content differences (different words, reordering, etc.)
 *
 * VERSIONING: If these rules ever change, the normalization version
 * should be embedded in the attestation so verifiers know which
 * ruleset to apply. Current version: 3.
 */
export const NORMALIZATION_VERSION = 3

/**
 * Shared steps 1–6: Unicode NFC, line endings, exotic whitespace → ASCII space,
 * strip invisibles, typographic quotes/punctuation → ASCII.
 */
function normalizeBase(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u00A0\u2002\u2003\u2007\u2009\u200A\u202F\u2028\u2029\u205F\u3000]/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F\u034F\u061C\u2066-\u206F\uFFF9-\uFFFC]/g, '')
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/\u2014/g, '--')
    .replace(/[\u2013\u2010\u2212]/g, '-')
}

/**
 * v3 (current): strips ALL whitespace after base normalization.
 * Hash represents the sequence of non-whitespace characters only.
 */
export function normalizeText(text: string): string {
  return normalizeBase(text).replace(/\s+/g, '').trim()
}

/**
 * v2 (legacy): preserves spaces and newlines, only trims + collapses trailing
 * whitespace per line. Needed to verify certificates issued before v3.
 */
export function normalizeTextV2(text: string): string {
  return normalizeBase(text)
    .replace(/[ \t]+$/gm, '')
    .trim()
}
