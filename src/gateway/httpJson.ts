import { GatewayError } from '../errors.js'

// 低階 HTTP-JSON 原語：fetch + timeout + JSON 解析，網路層失敗統一映射成 GatewayError
// GATEWAY_UNREACHABLE(502)。**不**決定「成功」語義與錯誤碼萃取——那由呼叫端各自處理
// （product gateway 看 res.ok + meta/metadata；svc-b2c 看 res.ok + metadata.status '0000'）。
// 抽出此原語消除 GatewayClient 與 announcement svc-b2c client 各自手刻 try/fetch/catch/json 的重複
// （code-review Standards 軸 Duplicated Code）。`label`（如 "GET /x"）只進錯誤訊息、不含 token/header。
export interface HttpJsonResult { ok: boolean; status: number; body: Record<string, unknown> }

export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<HttpJsonResult> {
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new GatewayError('GATEWAY_UNREACHABLE', `${label} failed: ${(e as Error).name}`, 502)
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}
