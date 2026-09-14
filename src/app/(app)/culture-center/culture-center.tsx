'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CELEBRATION_IDS, KINDS, SECTION_NAMES, TEMPLATE_NAMES, TIMESHEET_IDS, memeSchema, newMeme, nextDate, type CultureData, type CultureKind, type Meme } from '@/lib/culture/model'
import styles from './culture-center.module.css'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DESCRIPTIONS: Record<CultureKind, string> = {
  birthday: 'A little recognition, right on time. Month and day only — no birth years.',
  timesheet: 'Keep the weekly ritual light. Pick a template or let Kit rotate.',
  holiday: 'Studio holidays and annual occasions, with a destination you control.',
  delivery: 'Celebrate prepared delivery files. This does not imply client approval or final sign-off.',
  custom: 'Your own studio traditions. Describe the occasion, choose a schedule, then review before enabling.',
}
function timing(item: Meme): string {
  const day = item.schedule === 'annual' ? `Every ${item.month_day || '—'}` : item.schedule === 'weekly' ? WEEKDAYS[item.weekday ?? 5] : item.schedule === 'once' ? item.fire_date : item.schedule === 'holiday' ? 'Studio holidays' : 'On delivery event'
  return item.schedule === 'delivery' ? String(day) : `${day} · ${item.local_time} · ${item.timezone}`
}
function timestamp(value: string, timezone = 'America/Los_Angeles'): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value))
}
async function mutate(body: unknown) {
  const response = await fetch('/api/culture-center', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Not saved. Please refresh and try again.')
}

export function CultureCenter({ initialData }: { initialData: CultureData }) {
  const [data, setData] = useState(initialData)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<Meme | null>(null)
  const now = new Date(data.generatedAt)
  const config = data.workspace
  const enabled = data.memes.filter(item => item.status === 'enabled').length
  const drafts = data.memes.filter(item => item.status === 'draft').length
  const review = data.posts.filter(item => item.status === 'review').length
  const upcoming = data.memes.flatMap(item => {
    const date = nextDate(item, now, data.holidays)
    return date && !data.posts.some(post => post.meme_id === item.id && post.occurrence_key === date && ['posted', 'sending', 'review', 'cancelled'].includes(post.status)) ? [{ item, date }] : []
  }).sort((a, b) => a.date.localeCompare(b.date) || a.item.local_time.localeCompare(b.item.local_time)).slice(0, 8)
  const channels = new Map(data.channels.map(channel => [channel.id, `#${channel.name}`]))
  const channelName = (id: string) => channels.get(id) || id
  const pending = !!config && Date.parse(config.starts_at) > now.getTime()
  const fresh = !!config?.heartbeat_at && now.getTime() - Date.parse(config.heartbeat_at) < 180000
  const canEdit = !!config
  const canAdd = canEdit && !data.warning && data.channels.length > 0

  async function refresh() {
    setRefreshing(true)
    setError('')
    try {
      const response = await fetch('/api/culture-center', { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not refresh. Your saved records have not been changed.')
      setData(await response.json())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh.') }
    finally { setRefreshing(false) }
  }
  async function saved(message: string) {
    setEditing(null)
    setNotice(message)
    await refresh()
  }
  return <div className={styles.root}>
    <div className={styles.frame}>
      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>Ranger & Fox / Studio culture <span>ADMIN ONLY</span></p><h1>Culture Center</h1><p className={styles.description}>Memes, celebrations and the rituals that make the studio.</p></div>
        <div className={styles.heroActions}><button className={styles.primary} disabled={!canAdd} onClick={() => setEditing(newMeme('custom', config!.default_channel_id, config!.timezone, crypto.randomUUID()))}>+ Add meme</button><button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><small>Snapshot {timestamp(data.generatedAt, config?.timezone)}<br />Refresh to see the latest worker activity.</small></div>
      </header>
      <div className={styles.metrics}><div><strong>{String(enabled).padStart(2, '0')}</strong><span>Enabled rules</span></div><div><strong>{String(drafts).padStart(2, '0')}</strong><span>Drafts to shape</span></div><div><strong>{String(review).padStart(2, '0')}</strong><span>Posts needing review*</span></div><div><strong className={fresh ? styles.green : ''}>{!config ? 'Set up' : pending ? 'Staged' : fresh ? 'Online' : 'Check'}</strong><span>{!config ? 'Import existing rituals below' : pending ? 'Scheduled handover' : fresh ? 'Worker checked in' : 'Worker not recently seen'}</span></div></div>
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
      {error || data.warning ? <p role="alert" className={styles.warning}>{error || data.warning}</p> : null}
      {config ? <p className={styles.info}>{pending ? `The existing scheduler remains in charge until ${timestamp(config.starts_at, config.timezone)}. Culture Center takes over then.` : 'These rules are managed by Kit’s Slack service. Saving does not post a meme immediately.'} Drafts and paused rules never post.</p> : <Setup data={data} onSaved={saved} />}

      {KINDS.map((kind, index) => <section className={styles.section} key={kind} aria-labelledby={`section-${kind}`}>
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{String(index + 1).padStart(2, '0')} / CULTURE RULES</p><h2 id={`section-${kind}`}>{SECTION_NAMES[kind]}</h2><p>{DESCRIPTIONS[kind]}</p></div><button disabled={!canAdd} aria-label={`Add ${kind} meme`} onClick={() => setEditing(newMeme(kind, config!.default_channel_id, config!.timezone, crypto.randomUUID()))}>+ Add</button></div>
        <div className={styles.tableScroll}><table><caption className={styles.srOnly}>{SECTION_NAMES[kind]} settings</caption><thead><tr><th>{kind === 'birthday' ? 'Employee' : 'Meme / occasion'}</th><th>Type / template</th><th>Destination</th><th>{kind === 'birthday' ? 'Birthday / schedule' : 'Trigger / schedule'}</th><th>Status</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead><tbody>
          {data.memes.filter(item => item.kind === kind).map(item => <tr key={item.id}><td><strong>{kind === 'birthday' ? item.person_name : item.name}</strong>{item.briefing ? <small>{item.briefing}</small> : null}</td><td>{kind}<small>{TEMPLATE_NAMES[item.template_id]}</small></td><td>{channelName(item.channel_id)}</td><td>{timing(item)}</td><td><span className={styles.badge} data-status={item.status}>{item.status}</span></td><td><button disabled={!canEdit} aria-label={`Edit ${item.name}`} onClick={() => setEditing({ ...item })}>Edit</button></td></tr>)}
          {!data.memes.some(item => item.kind === kind) ? <tr><td colSpan={6} className={styles.empty}>No {SECTION_NAMES[kind].toLowerCase()} yet. {config ? 'Add one to start a draft.' : 'Set up Culture Center to bring your existing rituals here.'}</td></tr> : null}
        </tbody></table></div>
      </section>)}

      <section className={styles.section} aria-labelledby="upcoming"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>06 / ON THE CALENDAR</p><h2 id="upcoming">Coming up</h2><p>Next scheduled occurrence per enabled rule. Delivery celebrations appear only after their event.</p></div></div><div className={styles.tableScroll}><table><thead><tr><th>Date</th><th>Occasion</th><th>Time / zone</th><th>Destination</th></tr></thead><tbody>{upcoming.map(({ item, date }) => <tr key={item.id}><td>{date}</td><td>{item.name}</td><td>{item.local_time} · {item.timezone}</td><td>{channelName(item.channel_id)}</td></tr>)}{!upcoming.length ? <tr><td colSpan={4} className={styles.empty}>Nothing scheduled yet.</td></tr> : null}</tbody></table></div></section>
      <section className={styles.section} aria-labelledby="history"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>07 / POSTING LEDGER</p><h2 id="history">Recent activity</h2><p>*Latest 100 managed attempts. “Needs review” means Slack’s acknowledgement was uncertain — check the channel before reposting.</p></div></div><div className={styles.tableScroll}><table><thead><tr><th>When</th><th>Meme</th><th>Destination</th><th>Result</th></tr></thead><tbody>{data.posts.map(post => <tr key={post.id}><td>{timestamp(post.posted_at || post.created_at, config?.timezone)}</td><td>{post.name}{post.error ? <small>{post.error}</small> : null}</td><td>{channelName(post.channel_id)}</td><td><span className={styles.badge} data-status={post.status}>{post.status === 'review' ? 'Needs review' : post.status}</span></td></tr>)}{!data.posts.length ? <tr><td colSpan={4} className={styles.empty}>No managed posts yet. Previous Slack messages are not retroactively imported.</td></tr> : null}</tbody></table></div></section>
      <footer className={styles.footer}>RANGERANDFOX.STUDIO <span>Internal channels · Public-safe copy · No financial or client contact data</span></footer>
    </div>
    {editing ? <MemeEditor initial={editing} data={data} onClose={() => setEditing(null)} onSaved={saved} /> : null}
  </div>
}

function Setup({ data, onSaved }: { data: CultureData; onSaved: (message: string) => Promise<void> }) {
  const [channel, setChannel] = useState('')
  const [timezone, setTimezone] = useState('America/Los_Angeles')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { await mutate({ action: 'initialize', channel, timezone, confirmed }); await onSaved('Existing rituals imported. The managed scheduler takes over at the next local midnight.') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Setup was not saved.') }
    finally { setSaving(false) }
  }
  return <section className={styles.setup}><h2>Bring your rituals together</h2><p>Import existing birthdays, weekly timesheet memes and studio celebrations. Existing custom schedules arrive as drafts for review. Choose the initial destination and studio time zone; every rule can be edited afterward.</p><form onSubmit={submit}><fieldset disabled={saving || !!data.warning} className={styles.formGrid}><label>Default destination<select required value={channel} onChange={event => setChannel(event.target.value)}><option value="">Choose an internal channel</option>{data.channels.map(item => <option key={item.id} value={item.id}>#{item.name}</option>)}</select></label><label>Studio time zone<input required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/Los_Angeles" /></label><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />I’ve checked the destination. Switch to the managed schedule at the next local midnight.</label><button className={styles.primary} disabled={!confirmed || !channel}>{saving ? 'Importing…' : 'Import existing memes'}</button></fieldset>{error ? <p role="alert" className={styles.warning}>{error}</p> : null}</form></section>
}

function MemeEditor({ initial, data, onClose, onSaved }: { initial: Meme; data: CultureData; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [item, setItem] = useState(initial)
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  const update = (patch: Partial<Meme>) => { setItem(previous => ({ ...previous, ...patch })); setConfirmed(false) }
  const isNew = initial.revision === 0
  const templates = item.kind === 'timesheet' ? TIMESHEET_IDS : CELEBRATION_IDS
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    const parsed = memeSchema.safeParse(item)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || 'Check the form fields.'); return }
    setSaving(true)
    try { await mutate({ action: 'save', item: parsed.data, confirmed }); await onSaved(isNew ? 'Draft saved. Open Edit to review and enable it when ready.' : 'Meme settings saved. No message was sent by this edit.') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Not saved.'); setSaving(false) }
  }
  return <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); if (!saving) onClose() }} aria-labelledby="editor-title">
    <form onSubmit={submit}>
      <header className={styles.dialogHeader}><div><p className={styles.eyebrow}>{isNew ? 'NEW RITUAL / DRAFT FIRST' : 'CULTURE RULE / EDIT'}</p><h2 id="editor-title">{isNew ? 'New meme' : 'Edit meme'}</h2></div><button type="button" onClick={onClose} disabled={saving} aria-label="Close editor">×</button></header>
      <fieldset disabled={saving} className={styles.formGrid}>
        <label>Meme type<select value={item.kind} disabled={!isNew} onChange={event => { setItem(newMeme(event.target.value as CultureKind, item.channel_id, item.timezone, item.id)); setConfirmed(false) }}>{KINDS.map(kind => <option key={kind} value={kind}>{SECTION_NAMES[kind]}</option>)}</select></label>
        <label>Name<input required maxLength={100} value={item.name} onChange={event => update({ name: event.target.value })} placeholder="Friday wins" /></label>
        <label className={styles.wide}>What should this meme be about?<textarea rows={3} maxLength={600} value={item.briefing} onChange={event => update({ briefing: event.target.value })} placeholder="Celebrate small studio wins with friendly, low-stakes humor." /><small>Custom instructions guide text-only memes. Birthday, holiday, timesheet and delivery images use generic, privacy-safe prompts. No money, contacts, project secrets, links or targeted insults.</small></label>
        {item.kind === 'birthday' ? <><label>Employee<select required value={item.person_id || ''} onChange={event => { const person = data.people.find(person => person.id === event.target.value); update({ person_id: person?.id || null, person_name: person?.name || '', name: person ? `${person.name}’s birthday` : '' }) }}><option value="">Choose an employee</option>{data.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label>Display name<input required maxLength={80} value={item.person_name || ''} onChange={event => update({ person_name: event.target.value })} /></label></> : null}
        <label>Destination channel<select required value={item.channel_id} onChange={event => update({ channel_id: event.target.value })}><option value="">Choose a channel</option>{!data.channels.some(channel => channel.id === item.channel_id) && item.channel_id ? <option value={item.channel_id}>Current channel (verification unavailable)</option> : null}{data.channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
        <label>Template<select value={item.template_id} onChange={event => update({ template_id: event.target.value })}><option value="rotation">Automatic rotation</option>{templates.map(id => <option key={id} value={id}>{TEMPLATE_NAMES[id]}</option>)}</select></label>
        {['holiday', 'custom'].includes(item.kind) ? <label>Schedule<select value={item.schedule} onChange={event => update({ schedule: event.target.value as Meme['schedule'], fire_date: null, month_day: null, weekday: null })}>{item.kind === 'holiday' ? <option value="holiday">Studio holiday calendar</option> : <><option value="once">One date</option><option value="weekly">Every week</option></>}<option value="annual">Every year</option></select></label> : null}
        {item.schedule === 'annual' ? <label>{item.kind === 'birthday' ? 'Birthday' : 'Annual date'} (MM-DD)<input required pattern="[0-9]{2}-[0-9]{2}" placeholder="09-14" value={item.month_day || ''} onChange={event => update({ month_day: event.target.value })} /></label> : null}
        {item.schedule === 'once' ? <label>Date<input type="date" required value={item.fire_date || ''} onChange={event => update({ fire_date: event.target.value })} /></label> : null}
        {item.schedule === 'weekly' ? <label>Weekday<select required value={item.weekday ?? ''} onChange={event => update({ weekday: Number(event.target.value) })}><option value="" disabled>Choose a day</option>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label> : null}
        {item.schedule !== 'delivery' ? <><label>Local time<input type="time" required value={item.local_time} onChange={event => update({ local_time: event.target.value })} /></label><label>Time zone<input required value={item.timezone} onChange={event => update({ timezone: event.target.value })} placeholder="America/Los_Angeles" /></label></> : <p className={styles.wide}>Runs when Kit’s delivery celebration event fires, at most once per project per day. Client Progress uploads are not a delivery approval.</p>}
        {!isNew ? <label>Status<select value={item.status} onChange={event => update({ status: event.target.value as Meme['status'] })}><option value="draft">Draft — not scheduled</option><option value="enabled">Enabled — scheduled</option><option value="paused">Paused — do not post</option></select></label> : <p className={styles.wide}>This will be saved as a draft. Nothing posts until you review and enable it.</p>}
        {item.status === 'enabled' ? <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required />I’ve reviewed the wording, employee, destination and schedule. This is appropriate for everyone in the selected channel.</label> : null}
      </fieldset>
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      <p className={styles.info}>Missed schedules do not send surprise catch-up posts. Times skipped by daylight saving are skipped; repeated times post only once.</p>
      <footer className={styles.dialogFooter}><button type="button" onClick={onClose} disabled={saving}>Cancel</button><button className={styles.primary} disabled={saving || (item.status === 'enabled' && (!confirmed || !!data.warning))}>{saving ? 'Saving…' : isNew ? 'Save draft' : 'Save changes'}</button></footer>
    </form>
  </dialog>
}
