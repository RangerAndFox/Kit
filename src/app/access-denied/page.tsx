import Link from 'next/link'

export default function AccessDeniedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08090a] px-6 text-[#f0f2f5]">
      <section className="max-w-xl border border-white/15 bg-white/[0.025] p-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00ff66]">Kit / access boundary</p>
        <h1 className="mt-4 text-3xl font-semibold">Dashboard access is limited</h1>
        <p className="mt-4 leading-7 text-[#9aa3ad]">Your account is signed in, but the web Control Center is currently restricted to founders and administrators. Continue using Kit in Slack for your role-authorized project work.</p>
        <Link href="/login" className="mt-7 inline-flex border border-white/20 px-4 py-2 font-mono text-xs uppercase tracking-[0.12em] hover:border-[#00ff66]">Use another account</Link>
      </section>
    </main>
  )
}
