import { UnavailableSurface } from '@/components/unavailable-surface'

export const metadata = {
  title: 'Business Health — Kit',
  description: 'Financial overview and margins',
}

export default function BusinessHealthPage() {
  return <UnavailableSurface title="Business Health is not connected" detail="The previous demonstration figures have been removed. This page will return only when it is backed by authoritative, workspace-scoped financial data." />
}
