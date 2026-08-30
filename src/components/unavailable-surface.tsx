export function UnavailableSurface(props: { title: string; detail: string }) {
  return (
    <section className="mx-auto max-w-3xl py-16">
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">Not connected</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">{props.title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#aab0bc]">{props.detail}</p>
        <p className="mt-5 text-xs text-[#737b88]">Kit will not display sample data or claim that changes were saved.</p>
      </div>
    </section>
  )
}
