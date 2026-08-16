import type { ActionModule } from './module.js'
import { AppError } from '../../errors.js'

const modules = new Map<string, ActionModule>()

export function registerModule(m: ActionModule): void {
  if (modules.has(m.actionType)) throw new Error(`duplicate module: ${m.actionType}`)
  modules.set(m.actionType, m)
}
export function getModule(actionType: string): ActionModule {
  const m = modules.get(actionType)
  if (!m) throw new AppError('UNKNOWN_ACTION_TYPE', `no module registered for ${actionType}`, 400)
  return m
}
export function listModules(): ActionModule[] { return [...modules.values()] }
export function resetRegistryForTest(): void { modules.clear() }   // 僅測試用
