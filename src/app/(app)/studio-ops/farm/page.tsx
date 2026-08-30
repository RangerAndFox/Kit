import { UnavailableSurface } from '@/components/unavailable-surface'

export const metadata = {
  title: 'Render Farm — Kit',
  description: 'Monitor your render farm health',
}

export default function RenderFarmPage() {
  return <UnavailableSurface title="Render Farm dashboard is not connected" detail="This page previously showed demonstration nodes. Use the authenticated Control Center worker status until the live farm telemetry source is connected here." />
}
