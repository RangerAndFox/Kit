/** Fail visibly rather than silently treating a truncated corpus as complete. */
export async function readBoundedPages<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < 10_000; from += 500) {
    const result = await read(from, from + 499)
    if (result.error || !result.data) throw new Error('Summary metadata lookup failed')
    rows.push(...result.data)
    if (result.data.length < 500) return rows
  }
  throw new Error('Summary metadata batch exceeded 10,000 rows; split the project batch')
}
