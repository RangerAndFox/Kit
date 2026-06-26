/**
 * Delivery source pairing + validation.
 *
 * New delivery model: each project has a Dropbox `specs/` folder with `video/`
 * and `audio/` subfolders. A finished picture is dropped in `specs/video` and
 * its mix in `specs/audio`. When something lands, Kit must figure out which
 * video + audio go together and flag anything missing or in the wrong place
 * before it offers to render.
 *
 * This module is the pure decision core (no Dropbox/Slack I/O) so it's fully
 * unit-testable. The watcher feeds it the current folder listings; it returns
 * the chosen pair + human-readable warnings for the channel prompt.
 *
 * Pairing rule (default): match by filename stem — `spotV3.mov` ↔ `spotV3.wav`.
 * Falls back to "ask" when the match is missing or ambiguous.
 */

export type SpecsKind = 'video' | 'audio'

export interface SpecsFile {
  path: string // full Dropbox path
  name: string // filename only
  kind: SpecsKind // which folder it came from (video/ or audio/)
  size_bytes: number
  dropbox_id?: string
}

export interface PairResult {
  video: SpecsFile | null
  audio: SpecsFile | null
  /** Human-readable issues to surface in the channel prompt. */
  warnings: string[]
  /** True when there's a renderable picture (audio may be embedded/optional). */
  ok: boolean
  /** True when Kit can't choose confidently and should ask the operator. */
  needsChoice: boolean
}

const VIDEO_EXTS = new Set(['mov', 'mp4', 'mxf', 'mkv', 'avi', 'm4v', 'webm', 'mpg', 'mpeg'])
const AUDIO_EXTS = new Set(['wav', 'aif', 'aiff', 'mp3', 'aac', 'm4a', 'flac', 'caf'])

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/**
 * Normalize a filename to a comparison stem: drop the extension, lowercase,
 * and collapse separators so "Spot_V3 final.mov" and "spot-v3-final.wav" match.
 */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return base
    .toLowerCase()
    .replace(/[\s._-]+/g, '')
    .trim()
}

function isExpectedKind(file: SpecsFile): boolean {
  const ext = fileExt(file.name)
  if (file.kind === 'video') return VIDEO_EXTS.has(ext)
  return AUDIO_EXTS.has(ext)
}

/**
 * Pair the trigger file against the current contents of both specs subfolders.
 * The video is always the anchor: an audio drop with no matching video parks
 * until the video arrives.
 */
export function pairSpecsFiles(opts: {
  trigger: SpecsFile
  videoFiles: SpecsFile[]
  audioFiles: SpecsFile[]
}): PairResult {
  const warnings: string[] = []

  // Flag obviously-misfiled drops (audio in video/, video in audio/).
  for (const f of [...opts.videoFiles, ...opts.audioFiles]) {
    if (!isExpectedKind(f)) {
      const looksLike = AUDIO_EXTS.has(fileExt(f.name)) ? 'audio' : VIDEO_EXTS.has(fileExt(f.name)) ? 'video' : 'unknown'
      warnings.push(`\`${f.name}\` is in the *${f.kind}* folder but looks like ${looksLike} — wrong folder?`)
    }
  }

  // Choose the anchor video. If the trigger was a video, use it; otherwise
  // find the video that matches the dropped audio.
  let video: SpecsFile | null = null
  if (opts.trigger.kind === 'video') {
    video = opts.trigger
  } else {
    const stem = fileStem(opts.trigger.name)
    const matches = opts.videoFiles.filter((v) => fileStem(v.name) === stem)
    if (matches.length === 1) {
      video = matches[0]
    } else if (matches.length === 0) {
      warnings.push(
        `Audio \`${opts.trigger.name}\` dropped, but no matching video found in *specs/video* yet. Waiting for the picture.`,
      )
      return { video: null, audio: opts.trigger, warnings, ok: false, needsChoice: false }
    } else {
      warnings.push(`Audio \`${opts.trigger.name}\` matches multiple videos — pick one.`)
      return { video: null, audio: opts.trigger, warnings, ok: false, needsChoice: true }
    }
  }

  // Find the audio that matches the anchor video by stem.
  const vStem = fileStem(video.name)
  const audioMatches = opts.audioFiles.filter((a) => fileStem(a.name) === vStem)

  let audio: SpecsFile | null = null
  let needsChoice = false
  if (audioMatches.length === 1) {
    audio = audioMatches[0]
  } else if (audioMatches.length === 0) {
    if (opts.audioFiles.length === 0) {
      warnings.push(`No audio in *specs/audio* — rendering with the video's embedded audio (if any).`)
    } else {
      warnings.push(
        `No audio matched \`${video.name}\` by name (looked for a \`${vStem}\` file). Confirm the mix or drop a matching one.`,
      )
      needsChoice = true
    }
  } else {
    warnings.push(`\`${video.name}\` matches ${audioMatches.length} audio files — pick the right mix.`)
    needsChoice = true
  }

  return { video, audio, warnings, ok: true, needsChoice }
}
