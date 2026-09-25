import { redirect } from 'next/navigation'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export default async function TeamSettingsPage() {
  const access = await getControlCenterAccess()
  if (!access) redirect('/login')
  const { data: members, error } = await createAdminClient().from('team_members')
    .select('id, name, email, role, is_active')
    .eq('workspace_id', access.workspaceId).order('name')
  if (error) throw new Error('Unable to load the verified team roster')
  return <section className="space-y-6">
    <div>
      <h2 className="text-xl font-semibold text-white">Team</h2>
      <p className="text-sm text-[#9ca3af] mt-2">Live Kit roster, read-only. Ask Kit in Slack to onboard an artist or add an existing artist to a project. Role changes require an administrator.</p>
    </div>
    <div className="overflow-x-auto rounded-xl bg-[#181B24]">
      <table className="w-full text-left text-sm text-white">
        <caption className="sr-only">Verified team members in your workspace</caption>
        <thead><tr>{['Member', 'Email', 'Kit role', 'Status'].map(label => <th key={label} scope="col" className="px-6 py-3">{label}</th>)}</tr></thead>
        <tbody>{(members || []).map(member => <tr key={member.id} className="border-t border-[#2a2f3d]">
          <td className="px-6 py-4">{member.name || 'Unnamed'}</td>
          <td className="px-6 py-4">{member.email}</td>
          <td className="px-6 py-4">{member.role}</td>
          <td className="px-6 py-4">{member.is_active ? 'Active' : 'Inactive'}</td>
        </tr>)}</tbody>
      </table>
      {!members?.length && <p className="p-6 text-[#9ca3af]">No team members are configured.</p>}
    </div>
  </section>
}
