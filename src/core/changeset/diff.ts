import type { ToolContext } from '../../tools/types.js'
import type { ActionType, AnyChangeSetItem, AnyDiffItem } from './types.js'
import { getModule } from './registry.js'
import '../../modules/index.js'

// Throws DiffError if any requested oid could not be read (403/500/invalid) or resolved no
// current state — we must NOT silently stage a change with current_is_active: undefined.
export class DiffError extends Error {
  // Machine-readable code so toEnvelopeError (src/tools/envelope.ts) surfaces something other
  // than `undefined` for `code` on the resulting envelope error.
  public code = 'DIFF_READ_FAILED'
  constructor(public keys: string[], message: string) {
    super(message)
  }
}

/** @deprecated 測試用跨型 dispatcher——production code 一律 getModule(actionType).computeDiff */
export async function computeChangesetDiff(actionType: ActionType, items: AnyChangeSetItem[], ctx: ToolContext): Promise<AnyDiffItem[]> {
  const mod = getModule(actionType)
  return mod.computeDiff(ctx, items as never) as Promise<AnyDiffItem[]>
}
