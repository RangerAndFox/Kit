/**
 * Parse FFmpeg stderr progress lines into a percentage + ETA.
 *
 * FFmpeg emits lines like:
 *   frame= 1234 fps=45 q=2.0 size= 102400kB time=00:00:41.23 bitrate=20345.6kbits/s
 *
 * We extract `time=HH:MM:SS.xx` and compute percent against the known source
 * duration. ETA uses FFmpeg's reported `speed=Nx` factor (content seconds
 * encoded per wall-clock second).
 */

export interface ProgressUpdate {
  current_seconds: number
  percent: number          // 0..100
  eta_seconds: number | null
  raw_fps: number | null
}

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/
const FPS_RE = /fps=\s*(\d+(?:\.\d+)?)/
const SPEED_RE = /speed=\s*([\d.]+)x/

export function parseFFmpegProgress(
  line: string,
  totalDurationSeconds: number,
): ProgressUpdate | null {
  const timeMatch = line.match(TIME_RE)
  if (!timeMatch) return null
  const [, hh, mm, ss] = timeMatch
  const current = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
  const percent = totalDurationSeconds > 0
    ? Math.min(100, Math.max(0, (current / totalDurationSeconds) * 100))
    : 0

  const fpsMatch = line.match(FPS_RE)
  const fps = fpsMatch ? Number(fpsMatch[1]) : null

  // ETA from FFmpeg's own speed factor: remaining wall time =
  // remaining content seconds / speed (content-sec encoded per wall-sec).
  const speedMatch = line.match(SPEED_RE)
  const speed = speedMatch ? Number(speedMatch[1]) : null
  const eta = speed && speed > 0 && totalDurationSeconds > current
    ? Math.round((totalDurationSeconds - current) / speed)
    : null

  return {
    current_seconds: current,
    percent: Math.round(percent),
    eta_seconds: eta,
    raw_fps: fps,
  }
}
