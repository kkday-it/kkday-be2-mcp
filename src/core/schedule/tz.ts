import { AppError } from '../../errors.js'

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

// 指定 tz 在 utcMs 這一刻的 UTC offset(ms)。用 formatToParts 反推——Node 內建 ICU,無需新依賴。
function tzOffsetMs(tz: string, utcMs: number): number {
  // hourCycle:'h23' 而非 hour12:false——後者在 en-US 走 h24,午夜會格式化成「前一天 24:00」,
  // day 部件差一天 → offset 差 24h(排在整點午夜的排程全錯)。h23 強制 00-23,day 對齊當日。
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - utcMs
}

// 牆鐘 + IANA tz → UTC epoch(ms)。spec §4 時區規則:只在這裡換算一次,之後所有比較用 epoch。
// DST-safe 兩步法:先以 UTC 猜值取 offset、再驗 round-trip;不存在的牆鐘(春季跳時)明確拒絕。
export function wallToUtcEpoch(wall: string, tz: string): number {
  const m = WALL_RE.exec(wall)
  if (!m) throw new AppError('INVALID_WALL', `schedule wall time must be YYYY-MM-DDTHH:mm, got: ${wall}`, 400)
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[]
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi)
  const g = new Date(utcGuess)
  if (g.getUTCFullYear() !== y || g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d || g.getUTCHours() !== h || g.getUTCMinutes() !== mi) {
    throw new AppError('INVALID_WALL', `not a real calendar time: ${wall}`, 400)
  }
  let utc = utcGuess - tzOffsetMs(tz, utcGuess)
  const off2 = tzOffsetMs(tz, utc)
  utc = utcGuess - off2
  if (utc + tzOffsetMs(tz, utc) !== utcGuess) {
    throw new AppError('NONEXISTENT_TIME', `wall time ${wall} does not exist in ${tz} (DST gap)`, 400)
  }
  return utc
}
