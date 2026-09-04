import { loadConfig } from '../src/config.js'
import { AuthServiceClient } from '../src/auth/authServiceClient.js'
import { saveFixture as saveShared, shape } from './probeShared.js'

// Probes the blueMountain (工單) read API through api-gateway.
// Manual run only: npm run probe-sit-bm -- <orderMid> [serviceName]
//
// Answers the three open questions from the 2026-09-04 architecture probe:
//   Q1 does the gateway route /bluemountain/** at all, or only the workflow subtree?
//   Q2 does auth-service /verify have an entry rule for these uris (fail-closed 404-ish
//      vs open-to-any-logged-in-user vs business_keys required)?
//   Q3 serviceName BCS or CRM — only BCS/AM take the gateway-JWT branch in UserFilter.
//
// NEVER prints or writes token values. Response bodies are shape-only on stdout;
// full bodies go to tests/fixtures/ after a JWT scan.

const [orderMid, serviceNameArg] = process.argv.slice(2)
if (!orderMid) {
  console.error('usage: npm run probe-sit-bm -- <orderMid|discover> [BCS|CRM|AM]')
  console.error('  discover: omit orderMid so BM falls back to "my tickets" (TicketEventFacade:265-291),')
  console.error('            used to find a SIT ticket with real data when the target order has none.')
  process.exit(1)
}
const DISCOVER = orderMid.toLowerCase() === 'discover'

const cfg = loadConfig()
const auth = new AuthServiceClient({ baseUrl: cfg.authsvcUrl, serviceKey: cfg.serviceKey })

// UserFilter.java: authKey === serviceName === 'BCS' (or 'AM') switches to the
// gateway-JWT branch, where the real authKey is read from the Bearer token.
const SERVICE_NAMES = serviceNameArg ? [serviceNameArg] : ['BCS', 'CRM']

// .local.json is gitignored — probe output carries live ticket text and employee emails.
const saveFixture = (name: string, body: unknown) => saveShared(`${name}.local.json`, body)

// Keys that would mean raw ticket_task.extra_info leaked through the DTO whitelist.
// Matched against object KEYS, not the serialized blob: a substring test would flag
// the benign `taskExtraInfo` field for the `extraInfo` entry on every run.
const PII_KEYS = [
  'contactEmail', 'contactTel', 'contactFirstName', 'contactLastName',
  'memberEmail', 'memberPhone', 'memberFirstname', 'memberLastname',
  'custDataList', 'passport', 'twIdentityNumber', 'hkmoIdentityNumber',
  'birthday', 'foodAllergy', 'extraInfo',
]

function collectKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out); return out }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.add(k); collectKeys(x, out) }
  }
  return out
}

function reportPii(label: string, body: unknown) {
  const keys = collectKeys(body)
  const leaked = PII_KEYS.filter(k => keys.has(k))
  console.log(`  PII keys in ${label}:`, leaked.length ? `🔴 ${leaked.join(', ')}` : 'none ✅')
}

// RestApiReq<T> envelope: { authKey, serviceName, data }
// A business-level failure rides on HTTP 200 with metadata.status !== '0000'
// (observed: serviceName=CRM -> NU03), so `ok` gates on BOTH.
async function bmPost(
  accessToken: string,
  path: string,
  serviceName: string,
  data: unknown,
): Promise<{ ok: boolean; status: number; apiStatus?: string; body: any }> {
  const res = await fetch(`${cfg.gatewayUrl}/bluemountain${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'request-uuid': crypto.randomUUID(),
    },
    body: JSON.stringify({ authKey: serviceName, serviceName, data }),
  })
  const body = await res.json().catch(() => ({}))
  const apiStatus: string | undefined = body?.metadata?.status
  const ok = res.status === 200 && apiStatus === '0000'
  const detail = apiStatus ? ` metadata.status=${apiStatus}${ok ? '' : ` desc=${body?.metadata?.desc ?? ''}`}` : ''
  console.log(`POST /bluemountain${path} [serviceName=${serviceName}] -> http=${res.status}${detail}`)
  return { ok, status: res.status, apiStatus, body }
}

// PageReq: { currentPage >= 1, pageSize >= 1, sortProperty?, sortDirection? }
// ticket list max pageSize 100 (BaseTicketTaskPageReq), task log max 50 (CommonConstant.MAX_PAGE_SIZE).
const ticketPage = { currentPage: 1, pageSize: 100 }
const logPage = { currentPage: 1, pageSize: 50 }

async function main() {
  const { authorizationCode } = await auth.login(process.env.AUTH_email!, process.env.AUTH_pwd!)
  const tokens = await auth.exchangeCode(authorizationCode)
  const at = tokens.accessToken
  console.log('login + exchange OK; businessList length:', (tokens.businessList as unknown[]).length)

  // Q2 signal: does the caller's businessList carry anything ticket-shaped?
  const bl = tokens.businessList as unknown[]
  const ticketish = bl.filter(x => /ticket|task|bm|bluemountain|crm/i.test(JSON.stringify(x)))
  console.log('businessList entries matching /ticket|task|bm|crm/:', ticketish.length)
  if (ticketish.length) console.log(JSON.stringify(ticketish.slice(0, 10), null, 2))

  for (const serviceName of SERVICE_NAMES) {
    console.log(`\n=== serviceName=${serviceName} ===`)

    // Q1 + Q3: is the ticket-event subtree routed and does auth pass?
    // discover: `search` has no implicit caller scope (TicketEventFacade:308-397, only
    // eventOid IS NULL), so an unfiltered search surfaces any ticket in the environment.
    const list = DISCOVER
      ? await bmPost(at, '/api/v1/ticket-event/search', serviceName, { page: ticketPage })
      : await bmPost(at, '/api/v1/ticket-event/list', serviceName, { orderMid, page: ticketPage })
    if (!list.ok) {
      // Do NOT fall through to the "no tickets" message — an HTTP 200 with a
      // non-0000 metadata.status is an authz/lookup failure, not empty data.
      console.log('  ❌ call failed:', JSON.stringify(list.body).slice(0, 600))
      continue
    }
    console.log('  shape:', JSON.stringify(shape(list.body), null, 2))
    saveFixture(`bm-ticket-list-${serviceName}`, list.body)

    // RestApiPagedResp (live-confirmed 2026-09-04): { metadata, data: [...], page: {...} }
    const rows: any[] = Array.isArray(list.body?.data) ? list.body.data : []
    console.log(`  tickets returned: ${rows.length}`)
    reportPii('ticket list', list.body)
    if (!rows.length) {
      console.log('  (call succeeded with 0 tickets for this orderMid — routing + authz still proven)')
      continue
    }

    const first = rows[0]
    const taskOid = first?.taskOid
    console.log(`  first taskOid=${taskOid} parentTaskOid=${first?.parentTaskOid} taskTypeCode=${first?.taskTypeCode}`)

    if (taskOid) {
      const logs = await bmPost(at, '/api/v1/ticket-event/logs', serviceName, { taskOid, page: logPage })
      if (logs.ok) {
        console.log('  logs shape:', JSON.stringify(shape(logs.body), null, 2))
        reportPii('task logs', logs.body)
        saveFixture(`bm-task-logs-${serviceName}`, logs.body)
      } else {
        console.log('  ❌ logs failed:', JSON.stringify(logs.body).slice(0, 400))
      }

      // `one` is the widest DTO (it carries taskExtraInfo), so it is the response
      // that matters most for the "extra_info does not leak" claim in the contract doc.
      const one = await bmPost(at, '/api/v1/ticket-event/one', serviceName, { taskOid })
      if (one.ok) {
        reportPii('ticket detail (one)', one.body)
        saveFixture(`bm-ticket-one-${serviceName}`, one.body)
      } else {
        console.log('  ❌ one failed:', JSON.stringify(one.body).slice(0, 400))
      }
    }

    // task_type_name is NOT in the ticket resp (only taskTypeCode) — needs this call.
    // Valid types come from dictionary-code.json; userType 1=CS 2=OP (TaskUserType).
    const dict = await bmPost(at, '/api/v1/ticket-common/dictionary-code/list', serviceName, {
      types: ['task-type', 'reserve', 'transfer', 'assist-reject', 'reject', 'finish'],
      userType: 2,
    })
    if (dict.ok) {
      console.log('  dictionary shape:', JSON.stringify(shape(dict.body), null, 2))
      saveFixture(`bm-dictionary-${serviceName}`, dict.body)
    } else {
      console.log('  ❌ dictionary failed:', JSON.stringify(dict.body).slice(0, 400))
    }
  }

  console.log('\n--- how to read the result ---')
  console.log('404 on every path        -> gateway does not route /bluemountain/api/v1/ticket-event/*')
  console.log('401/403 with ENTRY_*     -> auth-service /verify rejected; check the code for which of the three cases')
  console.log('http=200 + metadata!=0000 -> routed, but BM rejected it (e.g. NU03 for a bad serviceName). NOT "no data".')
  console.log('http=200 + metadata=0000  -> routed AND this account is authorised for these uris')
}

// Match scripts/probe-sit.ts: print code/message only, never the whole error object.
main().catch((e: any) => { console.error(e?.code ?? '', e?.message ?? String(e)); process.exit(1) })
