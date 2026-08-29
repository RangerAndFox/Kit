'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createWorkspace } from './actions'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

type Step = 'workspace' | 'slack'

export function OnboardingWizard() {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState<Step>('workspace')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  // Auto-generate slug from workspace name
  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]/g, '')
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value
    setWorkspaceName(name)
    setWorkspaceSlug(generateSlug(name))
    setError('')
  }

  const handleContinueWorkspace = async () => {
    if (!workspaceName.trim()) {
      setError('Please enter a workspace name')
      return
    }

    if (!workspaceSlug.trim()) {
      setError('Workspace slug cannot be empty')
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const result = await createWorkspace(workspaceName, workspaceSlug)

      if (!result.success) {
        setError(result.error || 'Failed to create workspace')
        setIsLoading(false)
        return
      }

      // Move to next step
      setCurrentStep('slack')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsLoading(false)
    }
  }

  const handleSkipSlack = () => {
    router.push('/control-center')
  }

  const handleConnectSlack = () => {
    // TODO: Implement Slack OAuth flow
    // For now, just redirect to dashboard
    router.push('/control-center')
  }

  const containerVariants = {
    enter: (direction: number) => ({
      x: direction > 0 ? 1000 : -1000,
      opacity: 0,
    }),
    center: {
      zIndex: 1,
      x: 0,
      opacity: 1,
    },
    exit: (direction: number) => ({
      zIndex: 0,
      x: direction < 0 ? 1000 : -1000,
      opacity: 0,
    }),
  }

  const transitionSettings = {
    x: { type: 'spring' as const, stiffness: 300, damping: 30 },
    opacity: { duration: 0.2 },
  }

  return (
    <div className="min-h-screen bg-[#0C0E12] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Step Indicators */}
        <div className="flex items-center justify-center gap-3 mb-12">
          {/* Step 1 */}
          <div className="flex items-center gap-3">
            <motion.div
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm transition-colors',
                currentStep === 'workspace' || currentStep === 'slack'
                  ? 'bg-[#6366F1] text-white'
                  : 'bg-[#2a2f3d] text-[#b4b8c3]'
              )}
            >
              1
            </motion.div>
            <span className="text-sm font-medium text-[#b4b8c3]">Workspace</span>
          </div>

          {/* Connector */}
          <div className={cn('w-12 h-px transition-colors', 'bg-[#2a2f3d]')} />

          {/* Step 2 */}
          <div className="flex items-center gap-3">
            <motion.div
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm transition-colors',
                currentStep === 'slack'
                  ? 'bg-[#6366F1] text-white'
                  : 'bg-[#2a2f3d] text-[#b4b8c3]'
              )}
            >
              2
            </motion.div>
            <span className="text-sm font-medium text-[#b4b8c3]">Slack</span>
          </div>
        </div>

        {/* Content */}
        <AnimatePresence mode="wait" custom={currentStep === 'slack' ? 1 : -1}>
          {currentStep === 'workspace' ? (
            <motion.div
              key="workspace"
              custom={-1}
              variants={containerVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={transitionSettings}
              className="kit-card p-8 sm:p-12"
            >
              <div className="space-y-8">
                <div className="space-y-2">
                  <h1 className="text-3xl sm:text-4xl font-bold text-white">Welcome to Kit</h1>
                  <p className="text-base text-[#b4b8c3]">
                    Let&apos;s set up your studio workspace.
                  </p>
                </div>

                <div className="space-y-6">
                  {/* Workspace Name Input */}
                  <div className="space-y-2">
                    <label htmlFor="workspace-name" className="text-sm font-medium text-white">
                      Workspace Name
                    </label>
                    <input
                      id="workspace-name"
                      type="text"
                      placeholder="e.g. Ranger & Fox"
                      value={workspaceName}
                      onChange={handleNameChange}
                      disabled={isLoading}
                      className={cn(
                        'w-full px-4 py-3 rounded-lg bg-[#0C0E12] border border-[#2a2f3d] text-white placeholder-[#6b7280] text-base',
                        'transition-all duration-200',
                        'focus:outline-none focus:border-[#6366F1] focus:ring-2 focus:ring-[#6366F1]/20',
                        'disabled:opacity-50 disabled:cursor-not-allowed'
                      )}
                    />
                  </div>

                  {/* Slug Preview */}
                  {workspaceSlug && (
                    <motion.div
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-3 rounded-lg bg-[#0C0E12] border border-[#2a2f3d]"
                    >
                      <p className="text-xs text-[#6b7280] mb-1">Workspace URL</p>
                      <p className="text-sm font-mono text-[#6366F1]">kit.com/{workspaceSlug}</p>
                    </motion.div>
                  )}

                  {/* Error Message */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-3 rounded-lg bg-[#EF4444]/10 border border-[#EF4444]/30"
                    >
                      <p className="text-sm text-[#EF4444]">{error}</p>
                    </motion.div>
                  )}
                </div>

                {/* Continue Button */}
                <button
                  onClick={handleContinueWorkspace}
                  disabled={isLoading || !workspaceName.trim()}
                  className={cn(
                    'w-full px-6 py-3 rounded-lg font-medium text-white text-base',
                    'transition-all duration-200',
                    'bg-[#6366F1] hover:bg-[#4F46E5]',
                    'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#6366F1]',
                    isLoading && 'relative'
                  )}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Creating workspace...</span>
                    </div>
                  ) : (
                    'Continue'
                  )}
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="slack"
              custom={1}
              variants={containerVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={transitionSettings}
              className="kit-card p-8 sm:p-12"
            >
              <div className="space-y-8">
                <div className="space-y-2">
                  <h1 className="text-3xl sm:text-4xl font-bold text-white">Connect your team</h1>
                  <p className="text-base text-[#b4b8c3]">
                    Kit works best when it can reach your team on Slack.
                  </p>
                </div>

                {/* Slack Illustration Placeholder */}
                <div className="flex justify-center py-12">
                  <div className="w-32 h-32 rounded-2xl bg-[#0C0E12] border-2 border-[#2a2f3d] flex items-center justify-center">
                    <svg
                      className="w-16 h-16 text-[#6b7280]"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M7 0h2v10H7V0zm4 4h2v10h-2V4zm4-4h2v10h-2V0zm4 4h2v10h-2V4zm-10 11h10v2H8v-2zm0 4h10v2H8v-2z" />
                    </svg>
                  </div>
                </div>

                <div className="space-y-3">
                  {/* Connect Button */}
                  <button
                    onClick={handleConnectSlack}
                    disabled={isLoading}
                    className={cn(
                      'w-full px-6 py-3 rounded-lg font-medium text-white text-base',
                      'transition-all duration-200',
                      'bg-[#6366F1] hover:bg-[#4F46E5]',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#6366F1]'
                    )}
                  >
                    Connect Slack (Coming Soon)
                  </button>

                  {/* Skip Link */}
                  <button
                    onClick={handleSkipSlack}
                    disabled={isLoading}
                    className={cn(
                      'w-full px-6 py-3 rounded-lg font-medium text-[#6366F1] text-base',
                      'transition-all duration-200',
                      'hover:bg-[#6366F1]/10',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
