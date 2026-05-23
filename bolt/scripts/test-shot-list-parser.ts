// @ts-nocheck
/**
 * Smoke test for shot list parser.
 * SKIPs without ANTHROPIC_API_KEY.
 */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('SKIP — ANTHROPIC_API_KEY not set.')
    process.exit(0)
  }
  const { parseScript } = await import('../src/shotlist/parser')

  const script = `INT. WAREHOUSE — DUSK
A figure walks into frame, silhouetted against window light.
CLOSE on the briefcase as they set it down on a steel table.
Hands open the latches. A glow spills upward.`

  const shots = await parseScript(script)
  console.log(`Parsed ${shots.length} shots:`)
  for (const s of shots) {
    console.log(`  ${s.number}. ${s.action.slice(0, 60)}${s.action.length > 60 ? '…' : ''}`)
    if (s.dialogue) console.log(`     dialogue: ${s.dialogue.slice(0, 40)}`)
    if (s.duration) console.log(`     duration: ${s.duration}`)
  }
  if (shots.length === 0) {
    console.error('FAIL — parser returned 0 shots')
    process.exit(1)
  }
  console.log('OK')
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
