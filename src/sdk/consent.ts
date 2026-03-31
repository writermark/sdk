const STORAGE_KEY = 'writermark_telemetry_consent'

/**
 * Read telemetry consent state from localStorage.
 * Returns true (allowed), false (declined), or null (never asked).
 * SSR-safe — returns null when localStorage is unavailable.
 */
export function getTelemetryConsent(): boolean | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const val = localStorage.getItem(STORAGE_KEY)
    if (val === 'true') return true
    if (val === 'false') return false
    return null
  } catch {
    return null
  }
}

/**
 * Store telemetry consent choice in localStorage.
 */
export function setTelemetryConsent(value: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // Silent fail (private browsing, storage full, etc.)
  }
}
