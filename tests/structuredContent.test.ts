import { describe, it, expect } from 'vitest'
import { makeEnvelope } from '../src/tools/envelope.js'
import { wrapTool, type PipelineDeps } from '../src/server/toolPipeline.js'
import { requestContext } from '../src/server/requestContext.js'
import type { ToolDef } from '../src/tools/types.js'

function fakeDeps(): PipelineDeps {
  return {
    tokenManager: { getFreshAccessToken: async () => ({ accessToken: 'AT', userLabel: 'u1', businessList: [] }) } as never,
    rateBudget: { consume() {} } as never,
    audit: { record() {} } as never,
    gateway: { withTrace() { return this } } as never,
    readOids: { record() {}, has: () => true } as never,
  }
}

const echoTool: ToolDef = {
  name: 'echo', description: 'd', inputShape: {} as never,
  handler: async () => makeEnvelope([{ hello: 'world' }], [], ['oid1']),
}

it('成功回傳同時帶 text 與 structuredContent，且兩者同源', async () => {
  const wrapped = wrapTool(echoTool, fakeDeps())
  const out = await requestContext.run(
    { bearer: 'b', sessionId: 's1', clientInfo: 'test' },
    () => wrapped({}),
  )
  expect(out.content[0].text).toContain('"hello":"world"')
  expect(out.structuredContent).toBeDefined()
  expect(JSON.stringify(out.structuredContent)).toBe(out.content[0].text)
})
