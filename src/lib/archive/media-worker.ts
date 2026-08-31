import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getDropboxAccessToken } from '../dropbox/client'

export interface ArchiveMediaWorkerRequest {
  jobId: string
  sourcePath: string
  archiveFolderPath: string
  baseName: string
}
export function derivativePlan(durationSeconds: number): { stillInterval: number; gifStarts: number[] } {
  const duration = Math.max(0, Number(durationSeconds || 0))
  const stillInterval = Math.max(2, duration / 150)
  if (duration < 3) return { stillInterval, gifStarts: [] }
  const count = Math.max(1, Math.min(8, Math.ceil(duration / 30)))
  const usable = Math.max(0, duration - 6)
  const gifStarts = Array.from({ length: count }, (_, index) => count === 1 ? usable / 2 : index * usable / (count - 1))
  return { stillInterval, gifStarts }
}

async function command(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1000)}`)))
  })
}

async function downloadDropbox(path: string, destination: string): Promise<void> {
  const token = await getDropboxAccessToken()
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  })
  if (!response.ok || !response.body) throw new Error(`Dropbox media download failed ${response.status}: ${(await response.text()).slice(0, 300)}`)
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destination))
}

async function uploadDropbox(localPath: string, destination: string): Promise<void> {
  const token = await getDropboxAccessToken()
  const body = await readFile(localPath)
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: destination, mode: 'overwrite', autorename: false, mute: true }),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Dropbox media upload failed ${response.status}: ${(await response.text()).slice(0, 300)}`)
}

let mediaQueue: Promise<unknown> = Promise.resolve()

export function enqueueArchiveMedia(request: ArchiveMediaWorkerRequest): Promise<any> {
  const run = mediaQueue.then(() => processArchiveMedia(request))
  mediaQueue = run.catch(() => undefined)
  return run
}

export async function processArchiveMedia(request: ArchiveMediaWorkerRequest): Promise<any> {
  if (!/^[a-zA-Z0-9_-]+$/.test(request.jobId)) throw new Error('Invalid archive media job id.')
  if (!request.sourcePath.startsWith('/') || !request.archiveFolderPath.startsWith('/')) throw new Error('Dropbox media paths must be absolute.')
  const safeBase = request.baseName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  if (!safeBase) throw new Error('Archive media base name is empty.')

  const work = join(tmpdir(), `kit-archive-${request.jobId}`)
  const stills = join(work, 'stills')
  const gifs = join(work, 'gifs')
  const source = join(work, `source${extname(request.sourcePath) || '.mp4'}`)
  await rm(work, { recursive: true, force: true })
  await mkdir(stills, { recursive: true })
  await mkdir(gifs, { recursive: true })
  try {
    await downloadDropbox(request.sourcePath, source)
    const duration = Number(await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source]))
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('FFprobe could not determine video duration.')
    const plan = derivativePlan(duration)

    await command('ffmpeg', ['-y', '-i', source, '-vf', `fps=1/${plan.stillInterval}`, '-frames:v', '150', join(stills, 'frame_%03d.png')])
    for (let index = 0; index < plan.gifStarts.length; index++) {
      const start = plan.gifStarts[index].toFixed(3)
      const palette = join(work, `palette_${index}.png`)
      const output = join(gifs, `clip_${index + 1}.gif`)
      const filters = 'fps=12,scale=640:-1:flags=lanczos'
      await command('ffmpeg', ['-y', '-ss', start, '-t', '6', '-i', source, '-vf', `${filters},palettegen`, palette])
      await command('ffmpeg', ['-y', '-ss', start, '-t', '6', '-i', source, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=sierra2_4a`, output])
    }

    const stillFiles = (await readdir(stills)).filter((name) => name.endsWith('.png')).sort()
    const gifFiles = (await readdir(gifs)).filter((name) => name.endsWith('.gif')).sort()
    const uploaded: string[] = []
    for (let index = 0; index < stillFiles.length; index++) {
      const destination = `${request.archiveFolderPath}/02_Stills/${safeBase}_Still_${String(index + 1).padStart(2, '0')}.png`
      await uploadDropbox(join(stills, stillFiles[index]), destination)
      uploaded.push(destination)
    }
    for (let index = 0; index < gifFiles.length; index++) {
      const destination = `${request.archiveFolderPath}/03_Gifs/${safeBase}_GIF_${String(index + 1).padStart(2, '0')}.gif`
      await uploadDropbox(join(gifs, gifFiles[index]), destination)
      uploaded.push(destination)
    }
    return { duration, stills: stillFiles.length, gifs: gifFiles.length, uploaded }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
