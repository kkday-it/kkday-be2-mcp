import { z } from 'zod'
import type { AppToolDef, AppToolContext } from '../server/appPipeline.js'
import { makeEnvelope } from './envelope.js'

// 無 existence leak：找不到 id 與「id 存在但非自己建立」回同一種錯誤，讓外部觀察者無法用
// error 差異探測他人 change-set 是否存在。
const NOT_FOUND = (id: string) => makeEnvelope([], [{ key: id, code: 'NOT_FOUND', message: 'No such change-set for this user.' }])

export const appGetChangesetViewTool: AppToolDef = {
  name: 'app_get_changeset_view',
  description: 'Panel-only: fetch a change-set the caller created (status, diff, per-item results).',
  inputShape: { changeset_id: z.string().min(1) } as never,
  async handler(args, ctx: AppToolContext) {
    const rec = ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    const results = ['pending_approval', 'approved'].includes(rec.status) ? undefined : ctx.changeSets.getResults(rec.id)
    const view: Record<string, unknown> = { changeset_id: rec.id, status: rec.status, action_type: rec.actionType, note: rec.note, diff: { items: rec.diff } }
    if (rec.status === 'pending_approval') {
      // nonce 只在 app-only tool 回傳裡發放（model 讀不到，見 T6）；面板批准操作（Task 11）需帶
      // 這個 nonce + diff_version，把「按下批准」綁到一個 model 拿不到的一次性密碼。
      view.diff_version = rec.diffVersion
      view.nonce = ctx.nonces.issue({ changesetId: rec.id, diffVersion: rec.diffVersion, sessionId: ctx.sessionId })
    } else if (results) {
      view.results = results
    }
    return makeEnvelope([view])
  },
}

export const appGetConfirmLinkTool: AppToolDef = {
  name: 'app_get_confirm_link',
  description: 'Panel-only: get the confirm-page URL for a change-set the caller created (opened via openLink).',
  inputShape: { changeset_id: z.string().min(1) } as never,
  async handler(args, ctx: AppToolContext) {
    const rec = ctx.changeSets.get(args.changeset_id)
    if (!rec || rec.creatorLabel !== ctx.userLabel) return NOT_FOUND(args.changeset_id)
    return makeEnvelope([{ confirm_url: `${ctx.baseUrl}/confirm/${rec.id}` }])
  },
}

export const APP_TOOLS: AppToolDef[] = [appGetChangesetViewTool, appGetConfirmLinkTool]
