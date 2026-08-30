import { launchBehanceContext } from './behance.js'
import { config } from './config.js'

const context = await launchBehanceContext()
const page = context.pages()[0] || await context.newPage()
await page.goto(config.elevenLabsStartUrl, { waitUntil: 'domcontentloaded' })
console.log('Sign into the Ranger & Fox ElevenLabs account in the open dedicated Chrome window.')
console.log('When ElevenLabs Studio is visible, return here and press Enter.')
process.stdin.resume()
process.stdin.once('data', async () => {
  await context.close()
  process.exit(0)
})
