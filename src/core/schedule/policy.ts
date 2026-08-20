// spec §4/§7 的排程 policy 常數(單一事實來源;env 覆寫留待真有需求,YAGNI)。
export interface SchedulePolicy {
  minLeadMs: number; horizonMs: number; graceMs: number
  staleClaimMs: number; tickMs: number; keepAliveWindowMs: number
}

export const SCHEDULE_POLICY: SchedulePolicy = {
  minLeadMs: 5 * 60_000,        // 建立時:至少 5 分鐘後(留人審查餘裕;批准時只驗「仍在未來」,spec §5)
  horizonMs: 30 * 24 * 3600_000, // 建立時:最遠 30 天
  graceMs: 30 * 60_000,          // 停機吸收窗:超過即 missed,寧可不執行(spec §7)
  staleClaimMs: 10 * 60_000,     // stranded-approved 回收判準(spec §7 步驟 4)
  tickMs: 30_000,                // scheduler 輪詢間隔
  keepAliveWindowMs: 2 * 30_000 + 5 * 60_000, // access 將於「2 tick + tokenManager skew」內到期才 keep-alive
}
