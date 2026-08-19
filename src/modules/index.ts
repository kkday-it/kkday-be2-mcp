import { registerModule, listModules } from '../core/changeset/registry.js'
import { shelfToggleProductModule, shelfTogglePlanModule } from './product/shelfToggle/module.js'
import { inventorySettingModule } from './product/inventorySetting/module.js'
import { inventoryPlatformModule } from './product/inventoryPlatform/module.js'
import { shelfScheduleModule } from './product/shelfSchedule/module.js'
import { shelfToggleBundleModule } from './product/shelfToggleBundle/module.js'

export function registerAllModules(): void {
  const existing = new Set(listModules().map(m => m.actionType))
  if (!existing.has(shelfToggleProductModule.actionType)) registerModule(shelfToggleProductModule)
  if (!existing.has(shelfTogglePlanModule.actionType)) registerModule(shelfTogglePlanModule)
  if (!existing.has(inventorySettingModule.actionType)) registerModule(inventorySettingModule)
  if (!existing.has(inventoryPlatformModule.actionType)) registerModule(inventoryPlatformModule)
  if (!existing.has(shelfScheduleModule.actionType)) registerModule(shelfScheduleModule)
  if (!existing.has(shelfToggleBundleModule.actionType)) registerModule(shelfToggleBundleModule)
}

registerAllModules()
