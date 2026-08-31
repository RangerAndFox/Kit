import { UnavailableSurface } from '@/components/unavailable-surface'

export const metadata = {
  title: 'Ask Kit — Kit',
  description: 'Ask anything about your projects',
}

export default function AskPage() {
  return <UnavailableSurface title="Ask Kit is temporarily unavailable" detail="This web surface will remain disabled until every response is grounded in authoritative, workspace-scoped project data. Continue asking Kit in Slack." />
}
