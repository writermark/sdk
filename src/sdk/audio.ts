import type { AudioPeak } from '../types.js'

/**
 * Writermark Audio Monitor
 *
 * Uses the Web Audio API to detect keystroke-like audio transients
 * from the user's microphone. Does NOT record audio — only detects
 * amplitude spikes and logs their timestamps.
 *
 * How it works:
 *   1. Requests microphone access (user must grant permission).
 *   2. Routes the mic stream through an AnalyserNode.
 *   3. Monitors RMS amplitude in ~10ms windows.
 *   4. When amplitude exceeds a dynamic threshold (based on ambient
 *      noise floor), records a peak with its timestamp.
 *   5. On finalize(), returns the array of peaks.
 *
 * Privacy:
 *   - No audio data is stored or transmitted.
 *   - The raw MediaStream is discarded after analysis.
 *   - Only timestamps and normalized amplitudes leave this module.
 *
 * Usage:
 *   const audio = new AudioMonitor()
 *   await audio.start(sessionStartTime)
 *
 *   // ... user writes ...
 *
 *   const peaks = audio.stop()
 *   // Pass peaks to Collector.finalize()
 */
export class AudioMonitor {
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private peaks: AudioPeak[] = []
  private running = false
  private animFrameId: number | null = null
  private sessionStart = 0

  // Adaptive noise floor
  private noiseFloor = 0.02
  private readonly THRESHOLD_MULTIPLIER = 3.0 // Peak must be 3x the noise floor
  private readonly MIN_PEAK_GAP_MS = 30       // Debounce: ignore peaks within 30ms
  private lastPeakTime = -Infinity

  /**
   * Start monitoring the microphone.
   * @param sessionStartMs - Date.now() of the session start (to align timestamps with Collector)
   */
  async start(sessionStartMs: number): Promise<void> {
    this.sessionStart = sessionStartMs
    this.peaks = []

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false, // We WANT to hear keystrokes
          autoGainControl: false,
        },
      })
    } catch {
      console.warn('[writermark] Microphone access denied or unavailable.')
      return
    }

    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaStreamSource(this.stream)

    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.3
    source.connect(this.analyser)

    this.running = true
    this.monitor()
  }

  /** Internal: run the amplitude monitoring loop. */
  private monitor(): void {
    if (!this.running || !this.analyser) return

    const data = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(data)

    // Calculate RMS amplitude
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i]
    }
    const rms = Math.sqrt(sum / data.length)

    // Update noise floor (slow-moving average)
    this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005

    // Detect peak
    const threshold = this.noiseFloor * this.THRESHOLD_MULTIPLIER
    const now = Date.now()
    const t = now - this.sessionStart

    if (rms > threshold && rms > 0.01 && (t - this.lastPeakTime) > this.MIN_PEAK_GAP_MS) {
      this.peaks.push({ t, amplitude: Math.min(1, rms) })
      this.lastPeakTime = t
    }

    this.animFrameId = requestAnimationFrame(() => this.monitor())
  }

  /** Stop monitoring and return the detected peaks. */
  stop(): AudioPeak[] {
    this.running = false

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId)
    }

    // Clean up audio resources
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }

    return [...this.peaks]
  }

  /** Whether the monitor is currently active. */
  isRunning(): boolean {
    return this.running
  }
}
