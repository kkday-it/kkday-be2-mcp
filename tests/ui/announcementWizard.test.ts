import { describe, it, expect, vi } from 'vitest'
import { createFakeDocument, type FakeElement } from './fakeDom.js'

const doc = createFakeDocument()
vi.stubGlobal('document', doc)
// initAnnouncementWizard's bootstrap guard (`typeof window !== 'undefined'`) keeps the real
// connectApp()/MCP-transport path from running under this document-only stub.
const { initAnnouncementWizard, toUtcDateTime } = await import('../../src/ui/announcement-wizard.js')

interface ToolCall { name: string; arguments: Record<string, unknown> }
function makeFakeApp(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: ToolCall[] = []
  const app = {
    async callServerTool({ name, arguments: args }: ToolCall) {
      calls.push({ name, arguments: args })
      const h = handlers[name]
      if (!h) throw new Error(`no handler stubbed for tool ${name}`)
      return { structuredContent: await h(args) as any }
    },
  }
  return { app, calls }
}
function flush(): Promise<void> { return new Promise(r => setTimeout(r, 0)) }
function byRole(root: FakeElement, role: string): FakeElement {
  const f = root.querySelectorAll(`[data-role=${role}]`)[0]
  if (!f) throw new Error(`no element with data-role=${role}`)
  return f
}
const wizardEl = () => doc.getElementById('wizard')

describe('toUtcDateTime (pure conversion)', () => {
  it('Asia/Taipei 2026-09-01 08:00 -> 2026-09-01 00:00:00 UTC', () => {
    expect(toUtcDateTime('2026-09-01', '08:00', 'Asia/Taipei')).toBe('2026-09-01 00:00:00')
  })
})

describe('announcement wizard panel', () => {
  it('step1 load calls app_get_announcement_view with the entered prod_oids', async () => {
    const { app, calls } = makeFakeApp({
      app_get_announcement_view: () => ({ items: [{ products: [{ prod_oid: '7781', name: 'A', existing_count: 0 }] }], errors: [] }),
    })
    initAnnouncementWizard(app as any)
    const input = byRole(wizardEl(), 'prodOidsInput') as any
    input.value = '7781, 16384'
    ;(byRole(wizardEl(), 'loadBtn') as any).onclick()
    await flush()
    const viewCall = calls.find(c => c.name === 'app_get_announcement_view')
    expect(viewCall).toBeTruthy()
    expect(viewCall!.arguments.prod_oids).toEqual(['7781', '16384'])
  })

  it('builds ONE announcement item spanning selected prod_oids and stages it via app_create_changeset', async () => {
    const { app, calls } = makeFakeApp({
      app_get_announcement_view: () => ({ items: [{ products: [{ prod_oid: '7781', name: 'A', existing_count: 0 }, { prod_oid: '16384', name: 'B', existing_count: 1 }] }], errors: [] }),
      app_create_changeset: () => ({ items: [{ changeset_id: 'cs-1' }], errors: [] }),
      app_get_changeset_view: () => ({ items: [{ changeset_id: 'cs-1', status: 'pending_approval', diff: { items: [] }, nonce: 'n1', diff_version: 'v1' }], errors: [] }),
    })
    initAnnouncementWizard(app as any)
    ;(byRole(wizardEl(), 'prodOidsInput') as any).value = '7781, 16384'
    ;(byRole(wizardEl(), 'loadBtn') as any).onclick()
    await flush()
    ;(byRole(wizardEl(), 'toStep2Btn') as any).onclick()
    // fill the form
    ;(byRole(wizardEl(), 'nameInput') as any).value = '颱風公告'
    ;(byRole(wizardEl(), 'startDate') as any).value = '2026-09-01'
    ;(byRole(wizardEl(), 'startTime') as any).value = '08:00'
    const zhCb = byRole(wizardEl(), 'lang-zh-tw') as any; zhCb.checked = true
    ;(byRole(wizardEl(), 'content-zh-tw') as any).value = '颱風期間暫停'
    ;(byRole(wizardEl(), 'nextBtn') as any).onclick()
    await flush()

    const createCall = calls.find(c => c.name === 'app_create_changeset')
    expect(createCall).toBeTruthy()
    expect(createCall!.arguments.action_type).toBe('announcement')
    const items = createCall!.arguments.items as any[]
    expect(items).toHaveLength(1)
    const it = items[0]
    expect(it.prod_oids).toEqual(['7781', '16384'])   // one row spans both selected products
    expect(it.name).toBe('颱風公告')
    expect(it.is_enabled).toBe(true)
    expect(it.start_time).toBe('2026-09-01 00:00:00')  // 08:00 Taipei -> 00:00 UTC
    expect(it.langs).toEqual(['zh-tw'])
    expect(it.contents).toEqual([{ lang: 'zh-tw', content: '颱風期間暫停' }])
  })
})
