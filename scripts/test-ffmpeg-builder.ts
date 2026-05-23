// @ts-nocheck
/**
 * Smoke test for ffmpeg-builder + channel-mapper + loudness-parser + naming.
 *
 * No external services. Run: npx tsx scripts/test-ffmpeg-builder.ts
 */

import { buildFFmpegArgs, buildLoudnessAnalysisArgs, argsToShellCommand, CODEC_MAP } from '../src/lib/delivery/ffmpeg-builder'
import { buildChannelMapFilter } from '../src/lib/delivery/channel-mapper'
import { parseLoudnessJson } from '../src/lib/delivery/loudness-parser'
import { parseFFmpegProgress } from '../src/lib/delivery/progress-parser'
import { applyNamingTemplate, buildOutputFilename } from '../src/lib/delivery/naming'

const igniteProfile: any = {
  id: 'p-ignite',
  name: 'Microsoft Ignite 2025',
  video_codec: 'prores_422',
  resolution_w: 1920,
  resolution_h: 1080,
  frame_rate: '59.94',
  frame_rate_mode: 'cfr',
  scan_mode: 'progressive',
  pixel_format: 'yuv422p10le',
  audio_codec: 'pcm_s24le',
  audio_sample_rate: 48000,
  audio_bit_depth: 24,
  audio_channels: [
    { channel: 1, label: 'L', source: 'L' },
    { channel: 2, label: 'R', source: 'R' },
  ],
  lufs_target: -24,
  true_peak_limit: -10,
  lufs_lra: 11,
  container: 'mov',
  naming_template: '{session}_{speaker}_V{version}_{event}',
}

const measuredLoudness = {
  input_i: -18.5,
  input_tp: -3.2,
  input_lra: 8.1,
  input_thresh: -29.0,
  target_offset: -5.5,
}

let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`${status}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// CODEC_MAP sanity
check('CODEC_MAP has prores_422', !!CODEC_MAP.prores_422)
check('CODEC_MAP prores_422 uses prores_ks', CODEC_MAP.prores_422.encoder === 'prores_ks')

// Channel mapper — stereo Ignite case
const stereoFilter = buildChannelMapFilter(igniteProfile.audio_channels)
check('channel-mapper stereo Ignite', stereoFilter === 'pan=stereo|c0=c0|c1=c1', `got: ${stereoFilter}`)

// Channel mapper — 5.1 case
const surroundFilter = buildChannelMapFilter([
  { channel: 1, label: 'FL', source: 'FL' },
  { channel: 2, label: 'FR', source: 'FR' },
  { channel: 3, label: 'FC', source: 'FC' },
  { channel: 4, label: 'LFE', source: 'LFE' },
  { channel: 5, label: 'SL', source: 'SL' },
  { channel: 6, label: 'SR', source: 'SR' },
])
check('channel-mapper 5.1 passthrough', surroundFilter === 'pan=5.1|c0=c0|c1=c1|c2=c2|c3=c3|c4=c4|c5=c5', `got: ${surroundFilter}`)

// Naming
check('naming template Ignite',
  applyNamingTemplate('{session}_{speaker}_V{version}_{event}', {
    session: 'STUDIO100', speaker: 'BradS', version: '1', event: 'Ignite25',
  }) === 'STUDIO100_BradS_V1_Ignite25')

check('naming output filename',
  buildOutputFilename('{session}_{speaker}_V{version}_{event}', {
    session: 'STUDIO100', speaker: 'BradS', version: '1', event: 'Ignite25',
  }, 'mov') === 'STUDIO100_BradS_V1_Ignite25.mov')

// Loudness JSON parse
const sampleStderr = `
[Parsed_loudnorm_0 @ 0x...]
{
  "input_i" : "-18.5",
  "input_tp" : "-3.2",
  "input_lra" : "8.1",
  "input_thresh" : "-29.0",
  "output_i" : "-23.99",
  "target_offset" : "-5.5"
}
size= ...
`
const parsed = parseLoudnessJson(sampleStderr)
check('loudness parser input_i', parsed.input_i === -18.5)
check('loudness parser target_offset', parsed.target_offset === -5.5)

// Pass-1 args
const pass1 = buildLoudnessAnalysisArgs(igniteProfile, 'input.mov')
check('pass-1 includes -af loudnorm', pass1.some((a) => a.startsWith('loudnorm=I=-24:TP=-10:LRA=11:print_format=json')))
check('pass-1 includes -f null', pass1.includes('-f') && pass1[pass1.indexOf('-f') + 1] === 'null')

// Pass-2 args
const pass2 = buildFFmpegArgs({
  profile: igniteProfile,
  sourceFiles: [{ path: 'input.mov', type: 'video', size_bytes: 0 }],
  outputPath: 'STUDIO100_BradS_V1_Ignite25.mov',
  loudness: measuredLoudness,
})
check('pass-2 includes prores_ks',
  pass2.includes('-c:v') && pass2[pass2.indexOf('-c:v') + 1] === 'prores_ks')
check('pass-2 includes -profile:v 2 (ProRes 422)',
  pass2.includes('-profile:v') && pass2[pass2.indexOf('-profile:v') + 1] === '2')
check('pass-2 includes -s 1920x1080',
  pass2.includes('-s') && pass2[pass2.indexOf('-s') + 1] === '1920x1080')
check('pass-2 includes -r 59.94',
  pass2.includes('-r') && pass2[pass2.indexOf('-r') + 1] === '59.94')
check('pass-2 includes -c:a pcm_s24le',
  pass2.includes('-c:a') && pass2[pass2.indexOf('-c:a') + 1] === 'pcm_s24le')
check('pass-2 -af contains loudnorm measured_I',
  pass2.includes('-af') && pass2[pass2.indexOf('-af') + 1].includes('measured_I=-18.5'))
check('pass-2 -af contains pan=stereo',
  pass2.includes('-af') && pass2[pass2.indexOf('-af') + 1].includes('pan=stereo|c0=c0|c1=c1'))
check('pass-2 ends at output filename',
  pass2[pass2.length - 1] === 'STUDIO100_BradS_V1_Ignite25.mov')

// Shell command serialization
const cmd = argsToShellCommand(pass2)
check('shell command starts with ffmpeg', cmd.startsWith('ffmpeg'))

// Progress parser
const progLine = 'frame= 1234 fps=45 q=2.0 size= 102400kB time=00:00:41.23 bitrate=20345.6kbits/s'
const prog = parseFFmpegProgress(progLine, 120)
check('progress parser current_seconds', prog && Math.abs(prog.current_seconds - 41.23) < 0.01)
check('progress parser percent ~34', prog && prog.percent === 34)
check('progress parser fps 45', prog && prog.raw_fps === 45)

if (failed) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll FFmpeg builder checks passed.')
