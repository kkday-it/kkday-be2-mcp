import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const CaseSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expect: z.union([
    z.object({ kind: z.literal('tool'), tool: z.enum(['be2_find_products', 'be2_get_product_plans', 'be2_get_inventory_settings']), params_contains: z.record(z.string(), z.unknown()).optional() }),
    z.object({ kind: z.literal('no_tool'), must_mention: z.string().optional() }),
  ]),
})

describe('eval cases file', () => {
  const cases = JSON.parse(readFileSync('eval/cases/cases.json', 'utf8'))
  it('parses and covers positive + clarify + refuse + injection', () => {
    const parsed = z.array(CaseSchema).min(6).parse(cases)
    const ids = parsed.map(c => c.id)
    for (const prefix of ['pos-', 'clarify-', 'refuse-', 'inject-']) {
      expect(ids.some(i => i.startsWith(prefix)), `missing ${prefix}* case`).toBe(true)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})
