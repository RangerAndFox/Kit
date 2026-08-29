import { behanceBrowserVersion, isBehanceSignedIn, launchBehanceContext } from './behance.js'
import { heartbeat } from './store.js'

const context = await launchBehanceContext()
try {
  const signedIn = await isBehanceSignedIn(context)
  const browserVersion = await behanceBrowserVersion(context)
  await heartbeat(
    signedIn ? 'idle' : 'needs_login',
    null,
    signedIn ? null : 'The dedicated Behance browser profile is signed out. Run npm run login.',
    browserVersion,
  )
  console.log(signedIn ? 'Behance dedicated profile is signed in.' : 'Behance dedicated profile needs login.')
  process.exitCode = signedIn ? 0 : 2
} finally {
  await context.close()
}
