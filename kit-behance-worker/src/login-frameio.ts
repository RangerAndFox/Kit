import { launchBehanceContext } from './behance.js'
import { config } from './config.js'

const context = await launchBehanceContext()
const page = context.pages()[0] || await context.newPage()
await page.goto(config.frameioStartUrl, { waitUntil: 'domcontentloaded' })
console.log('Sign into the Ranger & Fox Frame.io account in the open Chrome window.')
console.log('When the Frame.io workspace shows its projects, return here and press Enter.')
process.stdin.resume()
process.stdin.once('data', async () => {
  await context.close()
  process.exit(0)
})
