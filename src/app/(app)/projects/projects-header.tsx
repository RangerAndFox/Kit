export function ProjectsHeader({ projectCount }: { existingClients: string[]; projectCount: number }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-white">Projects</h1>
          <span className="px-2 py-0.5 text-xs font-mono rounded-full bg-[#2a2f3d] text-[#9ca3af]">{projectCount}</span>
        </div>
        <p className="text-sm text-[#9ca3af] mt-1">Authoritative project records synced by Kit</p>
      </div>
      <p className="max-w-xs text-right text-xs leading-5 text-[#777f90]">
        Create and update projects through Kit in Slack so every connected system stays in sync.
      </p>
    </div>
  )
}
