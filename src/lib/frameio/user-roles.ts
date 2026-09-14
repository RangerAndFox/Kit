type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value==='object' && !Array.isArray(value) ? value as Data : {}
export type FrameUserRole = {id:string;email:string;role:string}
/** Current V4 responses nest identity inside `user`; legacy flat data is also
 * accepted. Pagination URLs supply only a cursor, never a new fetch origin. */
export async function frameUserRoles(path: string, get: (path:string)=>Promise<Data>): Promise<FrameUserRole[]> {
  const result: FrameUserRole[] = []; let cursor=''; const seen = new Set<string>()
  for (let page=0;page<20;page++) {
    const data=await get(`${path}?${new URLSearchParams({page_size:'100',...(cursor?{after:cursor}:{})})}`)
    if (!Array.isArray(data.data)) throw new Error('Frame.io membership response invalid')
    for (const value of data.data) {
      const row=object(value); const user=row.user ? object(row.user) : row
      result.push({id:String(user.id || ''),email:String(user.email || object(user.attributes).email || '').trim().toLowerCase(),role:String(row.role || '')})
    }
    const next=object(data.links).next
    let token=String(object(next).after || object(data.meta).next_cursor || '')
    if (typeof next==='string' && next) token=new URL(next,'https://api.frame.io').searchParams.get('after') || ''
    if (next && !token) throw new Error('Frame.io next page cannot be verified')
    if (!token) return result
    if (seen.has(token)) throw new Error('Frame.io pagination repeated')
    seen.add(token); cursor=token
  }
  throw new Error('Frame.io membership pagination incomplete')
}
