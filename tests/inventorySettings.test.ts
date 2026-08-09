import { describe, it, expect } from 'vitest'
import { inventorySettingsTool, trimInventory } from '../src/tools/inventorySettings.js'
import type { ToolContext } from '../src/tools/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

function ctxWith(routes: Record<string, unknown | Error>): ToolContext {
  return {
    accessToken: 'fake-jwt', userLabel: 'p@kkday.com',
    gateway: { get: async (path: string, _t: string, query?: Record<string, string>) => {
      for (const [frag, v] of Object.entries(routes)) if (path.includes(frag)) {
        if (v instanceof Error) throw v
        return typeof v === 'function' ? v(query) : v
      }
      throw new Error(`unexpected ${path}`)
    } } as never,
  }
}

const status = { is_processing: false, previous_status: null, previous_msg: '', previous_time: null }

describe('be2_get_inventory_settings', () => {
  it('validates year_month format', () => {
    const schema = z.object(inventorySettingsTool.inputShape)
    expect(schema.safeParse({ item_oid: 'i1', year_month: '2026-13' }).success).toBe(false)
    expect(schema.safeParse({ item_oid: 'i1', year_month: '2026-08' }).success).toBe(true)
    expect(schema.safeParse({ item_oid: 'i1' }).success).toBe(true)
  })

  it('no supplier_oid -> status only, no quantities call, no error', async () => {
    const env = await inventorySettingsTool.handler({ item_oid: 'i1' },
      ctxWith({ '/inventories/status': status }))
    expect(env.items).toHaveLength(1)
    const item = env.items[0] as Record<string, unknown>
    expect(item.item_oid).toBe('i1')
    expect(item.is_processing).toBe(false)
    expect(item.previous_status).toBeNull()
    expect(item).not.toHaveProperty('inventories')
    expect(env.errors).toEqual([])
    expect(env.read_oids).toEqual(['i1'])
  })

  it('supplier_oid given -> fetches quantities too, merges into item', async () => {
    let seenQuery: Record<string, string> | undefined
    const env = await inventorySettingsTool.handler({ item_oid: 'i1', supplier_oid: 's9', year_month: '2026-09' },
      ctxWith({
        '/inventories/status': status,
        '/inventories/s9': (q: Record<string, string>) => { seenQuery = q; return { itemInventory: [{ date: '2026-09-01', quantity: 5 }] } },
      }))
    expect(env.errors).toEqual([])
    expect(seenQuery).toEqual({ year_month: '2026-09' })
    const item = env.items[0] as Record<string, unknown>
    expect(item.inventories).toEqual([{ date: '2026-09-01', quantity: 5 }])
  })

  it('supplier_oid given but quantities call fails (403) -> status still returned, non-fatal error recorded', async () => {
    const boom = Object.assign(new Error('GET inventories/s9 -> 403'), { status: 403 })
    const env = await inventorySettingsTool.handler({ item_oid: 'i1', supplier_oid: 's9' },
      ctxWith({ '/inventories/status': status, '/inventories/s9': boom }))
    expect(env.items).toHaveLength(1)
    const item = env.items[0] as Record<string, unknown>
    expect(item.item_oid).toBe('i1')
    expect(item.is_processing).toBe(false)
    expect(item).not.toHaveProperty('inventories')
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'i1', status: 403 })
    expect(env.read_oids).toEqual(['i1'])
  })

  it('status call rejects -> fatal, empty items, one error keyed by item_oid', async () => {
    const boom = Object.assign(new Error('GET inventories/status -> 500'), { status: 500 })
    const env = await inventorySettingsTool.handler({ item_oid: 'i1' },
      ctxWith({ '/inventories/status': boom }))
    expect(env.items).toEqual([])
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'i1', status: 500 })
    expect(env.read_oids).toEqual([])
  })

  it('gateway failure with no routes configured -> envelope error, no throw', async () => {
    const env = await inventorySettingsTool.handler({ item_oid: 'bad' }, ctxWith({}))
    expect(env.items).toEqual([])
    expect(env.errors[0]!.key).toBe('bad')
  })
})

describe.skipIf(!existsSync('tests/fixtures/inventory-status.json'))('fixture: real SIT shape', () => {
  it('trims the captured status fixture without throwing', () => {
    const fx = JSON.parse(readFileSync('tests/fixtures/inventory-status.json', 'utf8'))
    const out = trimInventory('fx', fx)
    expect(out.item_oid).toBe('fx')
  })
})
