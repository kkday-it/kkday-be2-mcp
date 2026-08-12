import { describe, it, expect } from 'vitest'
import { hostSupportsApps } from '../src/server/app.js'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

describe('hostSupportsApps', () => {
  it('宣告 ui extension + 支援 mime → true', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } }
    expect(hostSupportsApps(caps)).toBe(true)
  })
  it('未宣告 ui extension → false', () => {
    expect(hostSupportsApps({})).toBe(false)
    expect(hostSupportsApps(null)).toBe(false)
  })
  it('宣告 extension 但不含我們的 mime → false', () => {
    const caps = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/plain'] } } }
    expect(hostSupportsApps(caps)).toBe(false)
  })
})
