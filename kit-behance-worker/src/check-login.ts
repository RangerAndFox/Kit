import { behanceBrowserVersion, behanceIdentityError, inspectBehanceIdentity, launchBehanceContext } from './behance.js'
import { heartbeat } from './store.js'

const context = await launchBehanceContext()
try {
  const identity = await inspectBehanceIdentity(context)
  const identityError = behanceIdentityError(identity)
  const signedIn = identityError === null
  const browserVersion = await behanceBrowserVersion(context)
  await heartbeat(
    signedIn ? 'idle' : 'needs_login',
    null,
    identityError,
    browserVersion,
  )
  console.log(signedIn ? `Behance dedicated profile is signed in as @${identity.profileSlug}.` : identityError)
  process.exitCode = signedIn ? 0 : 2
} finally {
  await context.close()
}
