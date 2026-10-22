import type { CoachSettings, CostBook, Costs, Limit, Snapshot } from '../types'

export const DEFAULT_SETTINGS: CoachSettings = {
  showCompact: true,
  showLimits: true,
  useBand: true,
  useToasts: true,
  compactAt: 60,
  limitWarnAt: 80,
  expectedTurns: 10,
  showDraft: true,
  showHelper: true,
  showInline: true,
  aboUsd: 20,
}

export const COMPACT_INSTRUCTIONS =
  'Keep the current task, decisions made, open points and relevant file paths. ' +
  'Leave out long tool output, logs and finished intermediate steps.'

export type Savings = {
  summary: number
  perTurn: number
  oneTimeCost: number
  net: number
}

// The summary a compaction leaves is estimated at a tenth of the context,
// at least 2k and at most 12k tokens.
export function estimateSavings(tokens: number, expectedTurns: number): Savings {
  const summary = Math.round(Math.min(12_000, Math.max(2_000, tokens * 0.1)))
  const perTurn = Math.max(0, tokens - summary)
  // Compacting reads the context once and writes the summary.
  const oneTimeCost = tokens + summary
  const net = perTurn * expectedTurns - oneTimeCost

  return { summary, perTurn, oneTimeCost, net }
}

export function shouldCompact(snapshot: Snapshot | null, settings: CoachSettings): boolean {
  if (!snapshot || snapshot.tokens === undefined || snapshot.percent === undefined) {
    return false
  }

  return (
    snapshot.percent >= settings.compactAt &&
    estimateSavings(snapshot.tokens, settings.expectedTurns).net > 0
  )
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return String(n)
}

export function bar(percent: number, width = 20): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour limit'
  if (kind === 'seven_day') return '7-day limit'
  if (kind === 'spend_limit') return 'Spend limit'

  return kind
}

export function fmtReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  const d = new Date(at)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const span = days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${rest} min` : `${rest} min`

  return `Reset ${days > 0 ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}${clock} (in ${span})`
}

export function limitColor(percent: number, warnAt: number): 'success' | 'warning' | 'error' {
  if (percent >= 95) return 'error'
  if (percent >= warnAt) return 'warning'

  return 'success'
}

// Which warn levels a limit has newly crossed, given the levels already
// warned for that window.
export function crossedLevels(limit: Limit, warnAt: number, warned: ReadonlySet<string>): string[] {
  const levels = [warnAt, 95].filter((level, i, all) => all.indexOf(level) === i)

  return levels
    .filter(level => limit.percentUsed >= level)
    .map(level => `${limit.kind}|${limit.resetsAt ?? ''}|${level}`)
    .filter(id => !warned.has(id))
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// A request's size in "input-token equivalents", using the price ratios the
// Claude models share: cache write 1.25x, cache read 0.1x, output 5x input.
// Dividing the session's cost by the sum of these gives the input price.
export function weighted(u: TokenUsage): number {
  return u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens + 5 * u.output_tokens
}

export function inputTokens(u: TokenUsage): number {
  return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
}

// Input price per token, or undefined while too little was measured.
export function inputPrice(costNow: number | undefined, costBase: number | undefined, weightSum: number): number | undefined {
  if (costNow === undefined || costBase === undefined || weightSum < 1_000) return undefined
  const spent = costNow - costBase
  if (spent <= 0) return undefined

  return spent / weightSum
}

// Tokens a compaction keeps out of each later request are cached prefix,
// so they are priced as cache reads.
export function savedUsd(tokens: number, price: number | undefined): number | undefined {
  return price === undefined ? undefined : tokens * 0.1 * price
}

export const NO_SAVINGS: { tokens: number; usd?: number; compactions: number; requests: number; timeMs?: number } = { tokens: 0, compactions: 0, requests: 0 }

export type SavingsChange = { tokens: number; usd?: number; compactions?: number; requests?: number; timeMs?: number }

export function addSavings<S extends { tokens: number; usd?: number; compactions: number; requests: number; timeMs?: number }>(
  s: S,
  change: SavingsChange,
): S {
  const usd = change.usd === undefined ? s.usd : (s.usd ?? 0) + change.usd
  const timeMs = change.timeMs === undefined ? s.timeMs : (s.timeMs ?? 0) + change.timeMs

  return {
    ...s,
    tokens: s.tokens + change.tokens,
    usd,
    timeMs,
    compactions: s.compactions + (change.compactions ?? 0),
    requests: s.requests + (change.requests ?? 0),
  }
}

export function fmtUsd(usd: number | undefined): string {
  if (usd === undefined) return '–'
  const abs = Math.abs(usd)
  const text = abs < 10 ? abs.toFixed(2) : abs.toFixed(0)

  return `${usd < 0 ? '−' : ''}$${text}`
}

export function fmtSigned(tokens: number): string {
  return tokens < 0 ? `−${fmtTokens(-tokens)}` : fmtTokens(tokens)
}

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

export function fmtDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`

  return `${rest} min`
}

export type Forecast = {
  // Time until the window resets.
  resetIn?: number
  // At the pace so far in this window: time until it is used up, and how
  // long one would then wait for the reset. Absent when it lasts.
  exhaustIn?: number
  waitAfter?: number
}

// Where a limit stands at a pace in percent per ms: time until it is used
// up and the wait for the reset after, both absent when it lasts.
export function forecastAt(limit: Limit, now: number, perMs: number): Forecast {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (Number.isNaN(at)) return {}
  const resetIn = Math.max(0, at - now)
  if (limit.percentUsed >= 100) return { resetIn, exhaustIn: 0, waitAfter: resetIn }
  if (perMs <= 0) return { resetIn }
  const exhaustIn = (100 - limit.percentUsed) / perMs
  if (exhaustIn >= resetIn) return { resetIn }

  return { resetIn, exhaustIn, waitAfter: resetIn - exhaustIn }
}

// The pace is the window's average so far: the share used over the time
// since the window began (its reset less its length).
export function forecast(limit: Limit, now: number): Forecast {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (Number.isNaN(at)) return {}
  const resetIn = Math.max(0, at - now)
  const length = WINDOW_MS[limit.kind]
  if (length === undefined || limit.percentUsed <= 0) return { resetIn }
  const elapsed = length - resetIn
  if (elapsed <= 0) return { resetIn }

  return forecastAt(limit, now, limit.percentUsed / elapsed)
}

export type Sample = { t: number; percent: number }

export const RECENT_MS = 30 * 60_000

// The pace over the last half hour, in percent per ms: from the reading
// nearest 30 minutes ago (or the oldest, if newer) to the latest. Undefined
// until the readings span at least 10 minutes.
export function recentPace(samples: readonly Sample[], now: number): number | undefined {
  const last = samples[samples.length - 1]
  if (!last) return undefined
  const before = samples.filter(x => x.t <= now - RECENT_MS)
  const base = before[before.length - 1] ?? samples[0]
  if (!base || last.t - base.t < 10 * 60_000) return undefined

  return Math.max(0, (last.percent - base.percent) / (last.t - base.t))
}

export function windowLength(kind: string): number | undefined {
  return WINDOW_MS[kind]
}

export const NO_COSTS: Costs = { usd: 0, tokens: 0 }
export const EMPTY_BOOK: CostBook = { total: NO_COSTS, months: {} }

export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

export function addCosts(c: Costs, change: Partial<Costs>): Costs {
  return { usd: c.usd + (change.usd ?? 0), tokens: c.tokens + (change.tokens ?? 0) }
}

export function bookCosts(book: CostBook, change: Partial<Costs>, now: number): CostBook {
  const key = monthKey(now)

  return {
    since: book.since ?? new Date(now).toISOString().slice(0, 10),
    total: addCosts(book.total, change),
    months: { ...book.months, [key]: addCosts(book.months[key] ?? NO_COSTS, change) },
  }
}

// This month's API cost run on to the month's end at the pace so far.
export function projectMonth(usd: number, now: number): number {
  const d = new Date(now)
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const elapsed = Math.max(1 / 24, d.getDate() - 1 + d.getHours() / 24)

  return (usd / elapsed) * days
}

// Extra time before the 5-hour limit that saved money buys: the dollars a
// percent of the limit took so far, and the pace in percent per ms.
export function timeGained(usd: number, usdPerPercent: number | undefined, percentPerMs: number | undefined): number | undefined {
  if (!usdPerPercent || !percentPerMs || usdPerPercent <= 0 || percentPerMs <= 0) return undefined

  return usd / usdPerPercent / percentPerMs
}

export function fmtGain(ms: number | undefined): string {
  if (ms === undefined || Math.abs(ms) < 30_000) return '–'

  return `${ms < 0 ? '−' : '+'}${fmtDuration(Math.abs(ms))}`
}

// Anthropic list prices in $ per million tokens (as of October 2026).
// Cache writes cost 1.25x input; cache reads as listed.
type Price = { input: number; output: number; cacheRead: number }
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5|opus-5\.5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/sonnet/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
]
const FALLBACK: Price = { input: 4, output: 20, cacheRead: 0.2 }

export function priceFor(model: string | undefined): Price {
  const id = (model ?? '').toLowerCase()

  return PRICES.find(([match]) => match.test(id))?.[1] ?? FALLBACK
}

// What one request cost at list price.
export function costOf(u: TokenUsage, model: string | undefined): number {
  const p = priceFor(model)

  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * 1.25 +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  )
}

// Tokens kept out of a request were cached prefix: priced as cache reads.
export function cacheReadUsd(tokens: number, model: string | undefined): number {
  return (tokens * priceFor(model).cacheRead) / 1_000_000
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// A reset time as a clock reading, with the weekday when it is not today.
export function fmtClock(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const d = new Date(at)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  return new Date(now).toDateString() === d.toDateString() ? clock : `${WEEKDAYS[d.getDay()]} ${clock}`
}
