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

const inv = {
  supplierOid: 's1',
  itemInventory: [{ date: '2026-08-10', quantity: 10 }],
  itemSupplierMapping: [{ supplier_oid: 's1', is_default: true }],
  itemCalendarRule: { big: 'blob', that: 'should not pass through' },
}

describe('be2_get_inventory_settings', () => {
  it('validates year_month format', () => {
    const schema = z.object(inventorySettingsTool.inputShape)
    expect(schema.safeParse({ item_oid: 'i1', year_month: '2026-13' }).success).toBe(false)
    expect(schema.safeParse({ item_oid: 'i1', year_month: '2026-08' }).success).toBe(true)
    expect(schema.safeParse({ item_oid: 'i1' }).success).toBe(true)
  })
  it('fetches inventory + status, returns trimmed item', async () => {
    const env = await inventorySettingsTool.handler({ item_oid: 'i1' },
      ctxWith({ '/inventory/status': { has_inventory: true }, '/inventory': inv }))
    const item = env.items[0] as Record<string, unknown>
    expect(item.item_oid).toBe('i1')
    expect(item.inventory_status).toEqual({ has_inventory: true })
    expect(item.inventories).toEqual([{ date: '2026-08-10', quantity: 10 }])
    expect(JSON.stringify(item)).not.toContain('should not pass through')
  })
  it('passes supplier_oid and year_month through as query', async () => {
    let seen: Record<string, string> | undefined
    const env = await inventorySettingsTool.handler({ item_oid: 'i1', supplier_oid: 's9', year_month: '2026-09' },
      ctxWith({ '/inventory/status': {}, '/inventory': (q: Record<string, string>) => { seen = q; return inv } }))
    expect(env.errors).toEqual([])
    expect(seen).toEqual({ supplier_oid: 's9', year_month: '2026-09' })
  })
  it('gateway failure -> envelope error, no throw', async () => {
    const env = await inventorySettingsTool.handler({ item_oid: 'bad' }, ctxWith({}))
    expect(env.items).toEqual([])
    expect(env.errors[0]!.key).toBe('bad')
  })
  it('inventory (main) call rejects -> fatal, empty items, one error keyed by item_oid', async () => {
    const boom = Object.assign(new Error('GET inventory -> 500'), { status: 500 })
    const env = await inventorySettingsTool.handler({ item_oid: 'i1' },
      ctxWith({ '/inventory/status': { has_inventory: true }, '/inventory': boom }))
    expect(env.items).toEqual([])
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'i1', status: 500 })
    expect(env.read_oids).toEqual([])
  })
  it('inventory succeeds but status rejects -> degraded item still returned, non-fatal error recorded', async () => {
    const boom = Object.assign(new Error('GET inventory/status -> 503'), { status: 503 })
    const env = await inventorySettingsTool.handler({ item_oid: 'i1' },
      ctxWith({ '/inventory/status': boom, '/inventory': inv }))
    expect(env.items).toHaveLength(1)
    const item = env.items[0] as Record<string, unknown>
    expect(item.item_oid).toBe('i1')
    expect(item.inventory_status).toBeUndefined()
    expect(item.inventories).toEqual([{ date: '2026-08-10', quantity: 10 }])
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatchObject({ key: 'i1', status: 503 })
    expect(env.read_oids).toEqual(['i1'])
  })
})

describe.skipIf(!existsSync('tests/fixtures/inventory.json'))('fixture: real SIT shape', () => {
  it('trims the captured fixture without throwing', () => {
    const fx = JSON.parse(readFileSync('tests/fixtures/inventory.json', 'utf8'))
    const out = trimInventory('fx', fx, {})
    expect(out.item_oid).toBe('fx')
  })
})
