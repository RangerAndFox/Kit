import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'

const { createCaption } = vi.hoisted(() => ({ createCaption: vi.fn() }))
vi.mock('../src/llm/client', () => ({ anthropic: { messages: { create: createCaption } }, ORCHESTRATOR_MODEL: 'test' }))
import { CELEBRATION_TEMPLATES, isMemeImageUrl, normalizeImageCaption, postMeme, renderMemeImage } from '../src/memes/meme-engine'
import { postWeeklyTimesheetMeme } from '../src/memes/timesheet-meme'

const template = CELEBRATION_TEMPLATES[1]
const imageUrl = 'https://i.imgflip.com/test123.jpg'
const fetchMock = vi.fn()
const captions = (boxes: string[]) => createCaption.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ boxes }) }] })
function slack() {
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '123' })
  return { app: { client: { chat: { postMessage } } } as unknown as App, postMessage }
}
beforeEach(() => {
  vi.stubEnv('IMGFLIP_USERNAME', 'fixture-user')
  vi.stubEnv('IMGFLIP_PASSWORD', 'fixture-password')
  vi.stubEnv('KIT_TEAM_CHANNEL_ID', 'C_FIXTURE')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { url: imageUrl } }) })
  captions(['Files ready', 'Teamwork wins'])
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('image caption boundary', () => {
  it('normalizes smart punctuation, accents and whitespace to readable ASCII', () => {
    expect(normalizeImageCaption('“Café” — it’s ready…\nYes!')).toBe('"Cafe" - it\'s ready... Yes!')
  })
  it.each(['Client replies with 👍🔥', '🎉', '👩🏽‍💻', 'Client replies with ðŸ‘�', 'bad\u0000text', 'a'.repeat(181)])('rejects unsupported or corrupted captions: %s', text => {
    expect(normalizeImageCaption(text)).toBeNull()
  })
  it('never sends unsupported captions to the renderer', async () => {
    expect(await renderMemeImage(template, ['Files ready', 'Client replies with 👍🔥'])).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects empty or incorrect box counts', async () => {
    expect(await renderMemeImage(template, ['', ''])).toBeNull()
    expect(await renderMemeImage(template, ['One box'])).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('sends normalized captions as UTF-8 form fields, not URL parameters', async () => {
    expect(await renderMemeImage(template, ['“Ready”', 'Teamwork — it’s great'])).toBe(imageUrl)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.imgflip.com/caption_image')
    expect(request.headers['Content-Type']).toContain('charset=UTF-8')
    const body = new URLSearchParams(request.body)
    expect(body.get('boxes[0][text]')).toBe('"Ready"')
    expect(body.get('boxes[1][text]')).toBe("Teamwork - it's great")
  })
  it('falls back on provider failure, timeout or invalid image URLs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { url: 'https://other.example/image.jpg' } }) })
    for (let i = 0; i < 3; i++) expect(await renderMemeImage(template, ['Files ready', 'Teamwork wins'])).toBeNull()
  })
  it('allows only expected HTTPS image URLs', () => {
    expect(isMemeImageUrl(imageUrl)).toBe(true)
    for (const url of ['http://i.imgflip.com/a.jpg', 'https://i.imgflip.com.evil.test/a.jpg', 'https://i.imgflip.com/a.jpg?secret=1', 'https://user@i.imgflip.com/a.jpg', null]) expect(isMemeImageUrl(url)).toBe(false)
  })
})

describe('Slack delivery and public-image privacy', () => {
  it('uses only a generic occasion for image generation, keeping project details out of the prompt', async () => {
    const { app, postMessage } = slack()
    await postMeme(app, { channel: 'C_FIXTURE', headline: 'Delivery files ready - SecretClient Project123', briefing: 'SecretClient Project123 budget $50,000 contact private@example.test', publicOccasion: 'delivery_prepared', templateIndex: 1 })
    const prompt = JSON.stringify(createCaption.mock.calls[0])
    expect(prompt).not.toMatch(/SecretClient|Project123|50,000|private@example/)
    expect(prompt).toContain('prepared files for delivery')
    expect(fetchMock.mock.calls[0][1].body).not.toMatch(/SecretClient|Project123|50,000|private/)
    expect(postMessage.mock.calls[0][0].blocks[1].alt_text).toContain('Files ready / Teamwork wins')
  })
  it('keeps custom/ad-hoc captions inside Slack, never sending them to Imgflip', async () => {
    captions(['SecretClient', 'Project123'])
    const { app, postMessage } = slack()
    const result = await postMeme(app, { channel: 'C_FIXTURE', headline: 'A studio win', briefing: 'A custom project celebration', templateIndex: 1 })
    expect(result.image).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(postMessage.mock.calls[0][0].blocks[1].text.text).toContain('SecretClient')
  })
  it('keeps emoji captions readable as Slack text rather than broken image lettering', async () => {
    captions(['Files ready', 'Team says 🎉'])
    const { app, postMessage } = slack()
    expect((await postMeme(app, { channel: 'C_FIXTURE', headline: 'Files ready', briefing: '', publicOccasion: 'delivery_prepared', templateIndex: 1 })).image).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(postMessage.mock.calls[0][0].blocks[1].text.text).toContain('🎉')
  })
  it('applies the same caption guard to weekly timesheet memes', async () => {
    captions(['Log your hours', 'Friday wins 🎉'])
    const { app, postMessage } = slack()
    expect((await postWeeklyTimesheetMeme(app, 0)).image).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(postMessage.mock.calls[0][0].blocks[1].text.text).toContain('🎉')
  })
})
