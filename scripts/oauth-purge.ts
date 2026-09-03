import type Database from 'better-sqlite3'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/store/db.js'

// Task 11：OAuth token 生命週期治理 —— 仿 dev-tools 的 `oauth:purge` CronJob（見
// docs/be2-mcp/reference-dev-tools-architecture.md）。硬刪三類「過期/孤兒」資料，
// 不動任何活資料：
//
// (a) 過期 authorization code（`exp < now`）—— 換碼一次即消費，過期後留著沒有任何用途。
// (b) 過期 refresh token（`exp < now`）——注意：**已 consumed 但尚未過期**的 refresh 刻意
//     保留（Task 10 的 refresh-reuse 偵測需要它存在，才能判斷「這顆已經被用過一次、現在又被
//     重放」並觸發 family revoke）。只有「過期」才代表這份歷史紀錄真的沒用了。
// (c) 無 credential 引用的 ghost `be2_identities` —— 這張表存的是**真實 be2 access/refresh
//     token**（見 identityStore.ts），一旦沒有任何 credential（oauth_access/static_bearer/
//     web_session）指向它，就是一筆單純躺著洩漏憑證風險的孤兒列。典型成因：Task 10 的
//     refresh-reuse family revoke 會 `deleteByIdentityAndKind(identityId, 'oauth_access')`
//     砍光該 identity 的 oauth_access credential，但 identity 本身不會跟著砍——這裡補上。
//
// 刻意不做：oauth_clients（DCR 註冊的 client）的孤兒清理。Interfaces 註記為「可選」，
// 且判定「這個 client 還算不算活的」需要一個寬限期（避免砍掉剛註冊、還沒換過 token 的
// client），複雜度/風險不成比例地高於三個核心項目，留給未來若有需要再補。

export interface OAuthPurgeResult {
  expiredAuthCodes: number
  expiredRefresh: number
  ghostIdentities: number
}

export function runOAuthPurge(db: Database.Database, now: number): OAuthPurgeResult {
  const codeRes = db.prepare('DELETE FROM oauth_auth_codes WHERE exp < ?').run(now)
  const refreshRes = db.prepare('DELETE FROM oauth_refresh WHERE exp < ?').run(now)
  const ghostRes = db.prepare(`
    DELETE FROM be2_identities
    WHERE identity_id NOT IN (SELECT DISTINCT identity_id FROM credentials)
    -- spec §6 purge 保護：排程件被 claim 後短暫處於 approved(execute_at_utc 非 null)，此窗內
    -- 也不能清，否則會刪掉正在執行中排程件的 executor identity。
    AND identity_id NOT IN (
      SELECT executor_identity_id FROM change_sets
      WHERE executor_identity_id IS NOT NULL
        AND (status='scheduled' OR (status='approved' AND execute_at_utc IS NOT NULL))
    )
  `).run()
  return {
    expiredAuthCodes: codeRes.changes,
    expiredRefresh: refreshRes.changes,
    ghostIdentities: ghostRes.changes,
  }
}

// 薄殼：只在直接執行本檔時跑（`npm run oauth-purge`），被 import 測試時不會誤觸發。
// 用 argv[1] 比對而非 import.meta.main（此 TS 版本/Node 目標尚未穩定支援後者）。
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  const cfg = loadConfig()
  const db = openDb('./data/be2-mcp-transition.sqlite')  // TODO(Task 7): switch to createPgDb(cfg.db)
  const result = runOAuthPurge(db, Date.now())
  console.log(`oauth-purge done: expiredAuthCodes=${result.expiredAuthCodes} expiredRefresh=${result.expiredRefresh} ghostIdentities=${result.ghostIdentities}`)
}
