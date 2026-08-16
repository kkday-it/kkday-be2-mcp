import { describe, it, expect, beforeEach } from 'vitest'
import { registerModule, getModule, listModules, resetRegistryForTest } from '../../src/core/changeset/registry.js'
import type { ActionModule } from '../../src/core/changeset/module.js'
import { AppError } from '../../src/errors.js'

describe('Registry', () => {
  beforeEach(() => {
    resetRegistryForTest()
  })

  it('registerModule: 重複註冊 throw duplicate module', () => {
    const m = { actionType: 'test_action' } as unknown as ActionModule
    registerModule(m)
    expect(() => registerModule(m)).toThrowError('duplicate module: test_action')
  })

  it('getModule: 未註冊 throw AppError code UNKNOWN_ACTION_TYPE', () => {
    try {
      getModule('missing_action')
      expect.fail('should have thrown AppError')
    } catch (e: any) {
      expect(e).toBeInstanceOf(AppError)
      expect(e.code).toBe('UNKNOWN_ACTION_TYPE')
    }
  })

  it('listModules: 回註冊順序', () => {
    const m1 = { actionType: 'action1' } as unknown as ActionModule
    const m2 = { actionType: 'action2' } as unknown as ActionModule
    registerModule(m1)
    registerModule(m2)
    const list = listModules()
    expect(list).toEqual([m1, m2])
  })

  it('resetRegistryForTest: 清空', () => {
    const m = { actionType: 'test_action' } as unknown as ActionModule
    registerModule(m)
    expect(listModules().length).toBe(1)
    resetRegistryForTest()
    expect(listModules().length).toBe(0)
  })
})
