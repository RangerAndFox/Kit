import { UnavailableSurface } from '@/components/unavailable-surface'

export const metadata = {
  title: 'Win/Loss — Kit',
  description: 'Track your pitch success rate',
}

export default function WinLossPage() {
  return <UnavailableSurface title="Win/Loss is not connected" detail="The previous demonstration pitches have been removed. This page will return only when it is backed by authoritative pipeline data." />
}
