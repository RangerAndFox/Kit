// @ts-nocheck
/**
 * Thin wrappers around `deadlinecommand` (the Deadline CLI). Submitting via the
 * CLI keeps the relay dependency-free and needs no Web Service / networking —
 * it talks straight to the repository over the LAN.
 */

import { spawn } from 'child_process'
import { config } from './config'

export interface DeadlineRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function runDeadline(args: string[], timeoutMs = 120000): Promise<DeadlineRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.deadlineCommand, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { proc.kill() } catch {} ; reject(new Error(`deadlinecommand timed out: ${args[0]}`)) }, timeoutMs)
    proc.stdout.on('data', (c) => { stdout += c.toString('utf8') })
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8') })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }) })
  })
}

/**
 * Submit a job from a job-info + plugin-info file pair. Returns the Deadline
 * JobID. deadlinecommand prints `JobID=<id>` on success.
 */
export async function submitJob(jobInfoPath: string, pluginInfoPath: string): Promise<string> {
  const res = await runDeadline(['-SubmitJob', jobInfoPath, pluginInfoPath])
  const out = `${res.stdout}\n${res.stderr}`
  const m = out.match(/JobID=([0-9a-fA-F]+)/)
  if (!m) {
    throw new Error(`Deadline submit did not return a JobID.\n${out.split(/\r?\n/).slice(-8).join('\n')}`)
  }
  return m[1]
}

/**
 * Normalized status for a Deadline job. deadlinecommand -GetJob prints a block
 * of Key=Value lines including `Status`.
 */
export type NormalizedStatus = 'completed' | 'failed' | 'active' | 'unknown'

export async function getJobStatus(jobId: string): Promise<NormalizedStatus> {
  const res = await runDeadline(['-GetJob', jobId])
  const line = res.stdout.split(/\r?\n/).find((l) => /^Status=/i.test(l.trim()))
  const raw = line ? line.split('=')[1]?.trim().toLowerCase() : ''
  if (!raw) return 'unknown'
  if (raw.includes('completed')) return 'completed'
  if (raw.includes('failed')) return 'failed'
  if (raw.includes('active') || raw.includes('rendering') || raw.includes('queued') || raw.includes('pending') || raw.includes('idle')) {
    return 'active'
  }
  return 'unknown'
}
