import { launchBehanceContext } from './behance.js'
import { config } from './config.js'

const context = await launchBehanceContext()
const page = context.pages()[0] || await context.newPage()
await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' })
console.log('Sign into the Ranger & Fox Behance account in the open Chrome window.')
console.log('When the Behance home page shows the signed-in profile, return here and press Enter.')
process.stdin.resume()
process.stdin.once('data', async () => {
  await context.close()
  process.exit(0)
})
