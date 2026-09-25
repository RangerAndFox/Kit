import { redirect } from 'next/navigation'

/** Former prototype controls did not persist changes. Use the verified control surface. */
export default function SettingsPage() {
  redirect('/settings/team')
}
