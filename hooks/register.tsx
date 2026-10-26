import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCompactResult, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { CoachSettings, CostBook, CostPeriod, Costs, InlineHint, Savings, Snapshot, Suggestion, Tab } from '../types'
import { BYLINE_HEIGHT, BYLINE_WIDTH, byline } from './brand'
import { IMPROVE_SYSTEM, TEMPLATES, analyzeDraft, keywords } from './draft'
import { CONTEXT_WORDING_SYSTEM, NO_CONTEXT, chatContext, contextWordingPrompt, inlineSuggestions, parseWordings, vagueRanges } from './inline'
import type { ChatContext, InlineSuggestion } from './inline'
import {
  COMPACT_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  EMPTY_BOOK,
  NO_COSTS,
  NO_SAVINGS,
  addCosts,
  bookCosts,
  cacheReadUsd,
  costOf,
  priceFor,
  monthOf,
  periodCosts,
  durationLines,
  PRICE_FAMILIES,
  applyCustomPrices,
  builtInPrice,
  familyPrice,
  fmtPrice,
  parsePrice,
  fmtMonths,
  projectMonth,
  stillSaves,
  monthDaysCounted,
  addSavings,
  clamp,
  crossedLevels,
  estimateSavings,
  fmtClock,
  fmtDuration,
  fmtGain,
  fmtReset,
  fmtSigned,
  forecast,
  forecastAt,
  recentPace,
  windowLength,
  fmtCount,
  fmtUsd,
  inputTokens,
  limitColor,
  limitLabel,
  shouldCompact,
  timeGained,
} from './logic'
import type { Sample, SavingsChange } from './logic'
import { COLORS, limitChart, limitChartHeight, ring, savingsBars, textBar } from './visual'
import type { ChartRow, Tone } from './visual'

const PANE = 'token-coach'
const TITLE = 'Token-Coach'
const STORED_SETTINGS = 'settings'
const STORED_STATS = 'stats'
const STORED_COSTS = 'costs'

const snapshot = atom({ plugin: 'token-coach', key: 'snapshot' } as const, null)
const settings = atom({ plugin: 'token-coach', key: 'prefs' } as const, DEFAULT_SETTINGS)
const tab = atom({ plugin: 'token-coach', key: 'tab' } as const, 'overview')
const isCompacting = atom({ plugin: 'token-coach', key: 'isCompacting' } as const, false)
const notice = atom({ plugin: 'token-coach', key: 'notice' } as const, null)
const lastCompact = atom({ plugin: 'token-coach', key: 'lastCompact' } as const, null)
const bandDismissedAt = atom({ plugin: 'token-coach', key: 'bandDismissedAt' } as const, null)
const sessionSavings = atom({ plugin: 'token-coach', key: 'sessionSavings' } as const, NO_SAVINGS)
const allTimeSavings = atom({ plugin: 'token-coach', key: 'allTimeSavings' } as const, NO_SAVINGS)
const sessionCosts = atom({ plugin: 'token-coach', key: 'sessionCosts' } as const, NO_COSTS)
const costBook = atom({ plugin: 'token-coach', key: 'costBook' } as const, EMPTY_BOOK)
const costPeriod = atom({ plugin: 'token-coach', key: 'costPeriod' } as const, 'all')
const inlineHint = atom({ plugin: 'token-coach', key: 'inlineHint' } as const, null)
const draft = atom({ plugin: 'token-coach', key: 'draft' } as const, null)
const suggestion = atom({ plugin: 'token-coach', key: 'suggestion' } as const, null)
const draftDismissed = atom({ plugin: 'token-coach', key: 'draftDismissed' } as const, null)
// Tokens the last compaction keeps out of every later request.
const perRequest = atom({ plugin: 'token-coach', key: 'perRequest' } as const, 0)

// What the requests cost at list price since the coach started, and the
// model the main thread last used.
const ledger = { spent: 0, model: undefined as string | undefined }

// Several sessions share the stored totals: each write starts from what is
// stored now, so one session's additions never overwrite another's.
async function storedBook($: EngineInterface): Promise<CostBook> {
  const stored = await $.store.get(STORED_COSTS)

  return stored && typeof stored === 'object' ? { ...EMPTY_BOOK, ...(stored as Partial<CostBook>) } : read($, costBook)
}

async function storedStats($: EngineInterface): Promise<Savings> {
  const stored = await $.store.get(STORED_STATS)

  return stored && typeof stored === 'object' ? { ...NO_SAVINGS, ...(stored as Partial<Savings>) } : read($, allTimeSavings)
}

async function recordCost($: EngineInterface, change: Partial<Costs>) {
  await update($, sessionCosts, c => addCosts(c, change))
  const now = await $.clock.now()
  const base = await storedBook($)
  const book = await update($, costBook, () => bookCosts(base, change, now))
  await $.store.set(STORED_COSTS, book)
}

// The smallest context a main-thread request of this chat carried: what even
// a fresh chat sends (system prompt, tools, project notes). A new chat saves
// the context above it, not all of it.
let chatBase: number | undefined

// Readings of each limit window (kind and reset), for the last half hour's pace.
const samples = new Map<string, Sample[]>()

function sample(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], now: number) {
  for (const l of rateLimits) {
    const key = `${l.kind}|${l.resetsAt ?? ''}`
    const list = (samples.get(key) ?? []).filter(x => x.t > now - 2 * 3_600_000)
    const last = list[list.length - 1]
    if (!last || last.percent !== l.percentUsed || now - last.t > 5 * 60_000) list.push({ t: now, percent: l.percentUsed })
    samples.set(key, list)
  }
}

// The 5-hour window as first seen: its reset, and the percent and cost then.
const limitBase = { resetsAt: undefined as string | undefined, percent: 0, cost: 0 }

async function timeFor($: EngineInterface, usd: number | undefined): Promise<number | undefined> {
  const snap = await read($, snapshot)
  const five = snap?.limits.find(l => l.kind === 'five_hour')
  if (usd === undefined || !five || limitBase.resetsAt !== five.resetsAt) return undefined
  const percents = five.percentUsed - limitBase.percent
  const dollars = ledger.spent - limitBase.cost
  if (percents < 1 || dollars <= 0) return undefined
  const f = forecast(five, await $.clock.now())
  const length = windowLength('five_hour') ?? 0
  const elapsed = f.resetIn === undefined ? 0 : length - f.resetIn

  return timeGained(usd, dollars / percents, elapsed > 0 ? five.percentUsed / elapsed : undefined)
}

async function credit($: EngineInterface, change: SavingsChange) {
  if (change.timeMs === undefined) change = { ...change, timeMs: await timeFor($, change.usd) }
  await update($, sessionSavings, s => addSavings(s, change))
  const s = await storedStats($)
  const all = await update($, allTimeSavings, () => addSavings(s.since ? s : { ...s, since: new Date().toISOString().slice(0, 10) }, change))
  await $.store.set(STORED_STATS, all)
}

// What the live check compares a draft with: the recent conversation.
// The inline suggestions fill their placeholders from its files and names,
// and Haiku reads its last lines.
const recent = {
  words: new Set<string>(),
  count: 0,
  lastTurnAt: undefined as number | undefined,
  context: NO_CONTEXT as ChatContext,
  excerpt: '',
}
let draftText = ''
let draftSeq = 0

async function refreshRecent($: EngineInterface) {
  const found = await $.session.messages().catch(() => [])
  const messages = Array.isArray(found) ? found : []
  const texts = messages.slice(-12).map(m => m.text)
  recent.count = messages.length
  recent.words = keywords(texts.join(' '))
  recent.context = chatContext(texts)
  recent.excerpt = texts.slice(-4).join('\n').slice(-1500)
}

// Haiku's wordings per vague word, asked once for each state of the chat.
const wordings = new Map<string, { rows?: InlineSuggestion[]; pending: Promise<InlineSuggestion[]> }>()

function wordingKey(word: string): string {
  return `${word.toLowerCase().replace(/[^\p{L}]/gu, '')}|${recent.count}`
}

function askHaiku($: EngineInterface, word: string, draftNow: string): Promise<InlineSuggestion[]> {
  const key = wordingKey(word)
  const known = wordings.get(key)
  if (known) return known.pending
  const entry: { rows?: InlineSuggestion[]; pending: Promise<InlineSuggestion[]> } = { pending: Promise.resolve([]) }
  entry.pending = (async () => {
      const prompt = contextWordingPrompt(word, draftNow, recent.context, recent.excerpt)
      let r: Awaited<ReturnType<EngineInterface['model']['complete']>> | undefined
      try {
        r = await $.model.complete({ model: 'haiku', system: CONTEXT_WORDING_SYSTEM, prompt, maxTokens: 150, timeoutMs: 8_000 })
      } catch {
        r = undefined
      }
      const rows = r?.isAnswered ? parseWordings(r.text) : []
      entry.rows = rows
      // A failed answer is asked again next time.
      if (!r?.isAnswered) wordings.delete(key)

      return rows
    })()
  wordings.set(key, entry)

  return entry.pending
}

// The wordings for a vague word: Haiku's first where switched on and known,
// then the local ones with their places filled from the chat.
function wordingsFor(word: string, smart: boolean, haiku: InlineSuggestion[] = []): InlineSuggestion[] {
  const local = inlineSuggestions(word, recent.context)
  const lead = word.match(/^[^\p{L}]*/u)?.[0] ?? ''
  const fitted = smart ? haiku.map(row => ({ ...row, text: lead + row.text })) : []
  const seen = new Set<string>()

  return [...fitted, ...local].filter(s => !seen.has(s.text) && seen.add(s.text))
}

async function runAnalysis($: EngineInterface, text: string) {
  const s = await read($, settings)
  if ((!s.showDraft && !s.showHelper) || text.trim().length < 15) {
    await update($, draft, () => null)

    return
  }
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const result = analyzeDraft(text, {
    percent: snap?.percent,
    tokens: snap?.tokens,
    baseTokens: chatBase,
    compactAt: s.compactAt,
    recent: recent.words,
    messageCount: recent.count,
    idleMs: recent.lastTurnAt === undefined ? undefined : now - recent.lastTurnAt,
  })
  await update($, draft, () => result)
}

function scheduleAnalysis($: EngineInterface, text: string) {
  draftText = text
  const mine = ++draftSeq
  void (async () => {
    await $.clock.sleep(900)
    if (mine === draftSeq) await runAnalysis($, text)
  })().catch(() => undefined)
}

// Puts a draft in the prompt box, and checks it as if it had been typed.
async function fillDraft($: EngineInterface, text: string) {
  await $.prompt.fill({ text, mode: 'replace' })
  scheduleAnalysis($, text)
}

async function improveDraft($: EngineInterface) {
  const text = (await $.prompt.read()).text || draftText
  if (!text.trim()) return
  await update($, suggestion, () => ({ status: 'loading' }))
  let r: Awaited<ReturnType<EngineInterface['model']['complete']>> | undefined
  try {
    r = await $.model.complete({ model: 'haiku', system: IMPROVE_SYSTEM, prompt: text, maxTokens: 800, timeoutMs: 30_000 })
  } catch {
    r = undefined
  }
  await update($, suggestion, (): Suggestion =>
    r?.isAnswered
      ? { status: 'done', text: r.text.trim(), note: `Cost: ${fmtCount(r.usage.input_tokens + r.usage.output_tokens)} tokens (Haiku)` }
      : { status: 'error', note: 'Improving did not work. Please try again.' },
  )
}

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

// A new chat leaves this one as it is: a plugin cannot open a chat, so the
// draft goes to the clipboard, for the person to paste into one they open.
async function startNewChat($: EngineInterface, surface: Surface) {
  const text = (await $.prompt.read()).text || draftText
  const advice = (await read($, draft))?.advice
  if (advice) await update($, draftDismissed, () => advice)
  if (!text.trim()) {
    $.ui.toast('Open a new chat for the next topic. This one stays as it is.', { timeoutMs: 10_000 })

    return
  }
  const copied = await $.ui.copy({ text, surface }).catch(() => undefined)
  $.ui.toast(
    copied?.isCopied
      ? 'Draft copied. Open a new chat and paste it there. This one stays as it is.'
      : 'Copying did not work: copy your draft, then open a new chat and paste it there.',
    { timeoutMs: 10_000 },
  )
}

// After a compaction the context is what it left, at once: the engine's
// own figure only moves with the next answer. The advice that was due goes.
// The engine's context figure as it stood when a compaction replaced it:
// while the engine still reports it, the compacted figure is the true one.
let staleTokens: number | undefined
let lastEngineTokens: number | undefined

function withContext(snap: Snapshot, tokens: number): Snapshot {
  return { ...snap, tokens, percent: Math.round((tokens / snap.window) * 100) }
}

async function applyCompaction($: EngineInterface, r: SessionCompactResult) {
  if (r.skip !== undefined || r.tokensAfter === undefined) return
  staleTokens = (await read($, snapshot))?.tokens
  const after = r.tokensAfter
  await update($, snapshot, snap => (snap ? { ...snap, tokens: after, percent: Math.round((after / snap.window) * 100) } : snap))
  await update($, draft, () => null)
  await update($, draftDismissed, () => null)
  await update($, bandDismissedAt, () => null)
}

// Limits and reset countdowns move without a turn: read them every minute.
async function refreshLimits($: EngineInterface) {
  const usage = await $.session.usage()
  const fresh = toSnapshot(usage.context, usage.rateLimits, usage.cost)
  const isStale = staleTokens !== undefined && fresh.tokens === staleTokens
  if (!isStale) staleTokens = undefined
  // The engine's figure replaces the shown one only when it moved: between
  // its reports the last request's own figure (or a compaction's) is newer.
  const hasMoved = fresh.tokens !== undefined && fresh.tokens !== lastEngineTokens && !isStale
  lastEngineTokens = fresh.tokens
  await update($, snapshot, snap => (!snap ? fresh : hasMoved ? fresh : { ...fresh, tokens: snap.tokens, percent: snap.percent }))
  sample(usage.rateLimits, await $.clock.now())
}

// A compaction the person or the coach asked for: from now on every request
// is smaller by the difference, on top of what an earlier compaction keeps
// out, and the compaction's own request is its cost: what it read and the
// summary it wrote. Without the engine's figures, the context read as cache
// and the summary written as output.
async function recordCompaction($: EngineInterface, r: SessionCompactResult) {
  if (r.skip !== undefined || r.tokensBefore === undefined || r.tokensAfter === undefined) return
  const delta = Math.max(0, r.tokensBefore - r.tokensAfter)
  await update($, perRequest, n => n + delta)
  const tokens = r.usage ? inputTokens(r.usage) + r.usage.output_tokens : r.tokensBefore + r.tokensAfter
  const usd = r.usage
    ? costOf(r.usage, ledger.model)
    : cacheReadUsd(r.tokensBefore, ledger.model) + (r.tokensAfter * priceFor(ledger.model).output) / 1_000_000
  ledger.spent += usd
  await recordCost($, { usd, tokens })
  await credit($, { tokens: -tokens, usd: -usd, compactions: 1 })
}

function toSnapshot(context: SessionContextUsage, rateLimits: readonly SessionRateLimit[], cost?: SessionCost): Snapshot {
  return {
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
    limits: rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: cost?.usd,
  }
}

async function saveSettings($: EngineInterface, change: (s: CoachSettings) => CoachSettings) {
  await update($, settings, change)
  const saved = await read($, settings)
  applyCustomPrices(saved.prices)
  await $.store.set(STORED_SETTINGS, saved)
}

// Compacts as if the person sent /compact: the engine queues it until the
// session is idle, and the session.compact hook books what it saved. Where
// that is refused, the plugin's own compaction call; where that is refused
// too, /compact goes into the prompt box for the person to send.
async function compactNow($: EngineInterface) {
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  await update($, notice, () => 'Compacting … (starts once no answer is running)')
  try {
    await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    await update($, bandDismissedAt, () => null)
    await update($, notice, () => 'Compacted.')
  } catch {
    try {
      const result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
      if (result.skip !== undefined) {
        await update($, notice, () => `Compacting skipped: ${String(result.skip)}`)
      } else {
        await update($, lastCompact, () => ({ before: result.tokensBefore, after: result.tokensAfter }))
        await recordCompaction($, result)
        await applyCompaction($, result)
        await update($, notice, () => 'Compacted.')
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const filled = await $.prompt.fill({ text: `/compact ${COMPACT_INSTRUCTIONS}`, mode: 'replace' }).catch(() => undefined)
      await update($, notice, () =>
        filled?.isFilled
          ? '/compact is in the prompt box: press Enter to compact.'
          : `Compacting did not work just now (${reason.slice(0, 120)}). Please type /compact.`,
      )
      if (filled?.isFilled) $.ui.toast('Press Enter to compact.', { timeoutMs: 8000 })
    }
  } finally {
    await update($, isCompacting, () => false)
  }
}

// Puts a precise wording in place of the vague word, where it still stands.
async function replaceWord($: EngineInterface, hint: InlineHint, option: string) {
  const { text } = await $.prompt.read()
  const at = text.slice(hint.start, hint.end) === hint.word ? hint.start : text.lastIndexOf(hint.word)
  if (at < 0) return
  await fillDraft($, text.slice(0, at) + option + text.slice(at + hint.word.length))
  await update($, inlineHint, () => null)
}

// Settings and the all-time figures as stored, into the values the panel
// shows: at the start, and again after /clear, which starts no new
// session.start but leaves the panel's values empty.
async function loadStored($: EngineInterface) {
  const stored = await $.store.get(STORED_SETTINGS)
  if (stored && typeof stored === 'object') {
    await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...(stored as Partial<CoachSettings>) }))
  }
  applyCustomPrices((await read($, settings)).prices)
  const stats = await $.store.get(STORED_STATS)
  if (stats && typeof stats === 'object') await update($, allTimeSavings, () => ({ ...NO_SAVINGS, ...(stats as Partial<Savings>) }))
  const book = await $.store.get(STORED_COSTS)
  if (book && typeof book === 'object') await update($, costBook, () => ({ ...EMPTY_BOOK, ...(book as Partial<CostBook>) }))
}

async function inlineOn($: EngineInterface): Promise<boolean> {
  return (await read($, settings)).showInline
}

export const register: Register = on => {
  let tick: { cancel: () => void } | undefined
  const warned = new Set<string>()
  let compactToastAt: number | null = null

  on('session.start', async ($, e, next) => {
    await loadStored($)
    $.ui.status(undefined)
    await refreshRecent($)
    await update($, sessionSavings, () => NO_SAVINGS)
    await update($, perRequest, () => 0)
    chatBase = undefined
    await $.command.register({ name: 'token-coach', description: 'Open the Token-Coach panel' })
    await $.command.register({ name: 'token-settings', description: 'Open the Token-Coach settings' })
    const usage = await $.session.usage()
    await update($, sessionCosts, () => NO_COSTS)
    ledger.spent = 0
    limitBase.resetsAt = undefined
    await update($, snapshot, () => toSnapshot(usage.context, usage.rateLimits, usage.cost))
    sample(usage.rateLimits, await $.clock.now())
    tick?.cancel()
    tick = $.clock.every(15_000, () => void refreshLimits($).catch(() => undefined))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'token-coach' }, async $ => {
    await update($, tab, () => 'overview')
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Token-Coach opened.' }
  })

  on('command.run', { command: 'token-settings' }, async $ => {
    await update($, tab, () => 'settings')
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Token-Coach settings opened.' }
  })

  // The draft as it is typed, checked once the typing pauses.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    scheduleAnalysis($, box.text)
    if (!(await inlineOn($))) return box
    // Vague words are underlined; for the one just typed, precise wordings
    // wait in the hint bar above the prompt box, a click away.
    const ranges = vagueRanges(box.text)
    const here = ranges.find(r => r.end === box.cursor)
    const word = here ? box.text.slice(here.start, here.end) : undefined
    const s = await read($, settings)
    const options = (haiku?: InlineSuggestion[]) => (word ? wordingsFor(word, s.smartInline, haiku).map(o => o.text) : [])
    await update($, inlineHint, (): InlineHint | null =>
      here && word ? { start: here.start, end: here.end, word, options: options(wordings.get(wordingKey(word))?.rows) } : null,
    )
    // Haiku's wordings join the hint bar once they arrive, while the word is still the one shown.
    if (here && word && s.smartInline) {
      void askHaiku($, word, box.text)
        .then(rows => update($, inlineHint, shown => (shown && shown.word === word && shown.start === here.start ? { ...shown, options: options(rows) } : shown)))
        // A session that ended meanwhile has no hint bar to update.
        .catch(() => undefined)
    }
    const marks = ranges.flatMap(r => [
      { start: r.start, end: r.end, underline: true, color: 'warning' as const },
      ...(r === here ? [{ start: r.end, end: r.end, virtualText: '  ↑ pick a precise wording', dimColor: true }] : []),
    ])

    return marks.length > 0 ? { ...box, decorations: [...(box.decorations ?? []), ...marks] } : box
  })

  // Bookkeeping around a submission or a compaction never holds it up.
  on('prompt.submit', async ($, e, next) => {
    draftSeq++
    draftText = ''
    try {
      await update($, inlineHint, () => null)
      await update($, draft, () => null)
      await update($, suggestion, () => null)
      await update($, draftDismissed, () => null)
    } catch {
      // the panel is only behind
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      recent.lastTurnAt = await $.clock.now()
      await refreshRecent($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      recent.words = new Set()
      recent.count = 0
      recent.context = NO_CONTEXT
      recent.excerpt = ''
      wordings.clear()
      await update($, sessionSavings, () => NO_SAVINGS)
      await update($, sessionCosts, () => NO_COSTS)
      await update($, perRequest, () => 0)
      chatBase = undefined
      await loadStored($)
      await update($, draft, () => null)
      await update($, draftDismissed, () => null)
      await update($, inlineHint, () => null)
      await update($, lastCompact, () => null)
      await update($, notice, () => null)
    }

    return result
  })

  // Every model request: its size prices the session, and on the main thread
  // it is one more request the last compaction made smaller.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      if (response.usage) {
        const usd = costOf(response.usage, response.usage.model)
        ledger.spent += usd
        if (e.agentId === undefined) {
          ledger.model = response.usage.model
          // The context is what this request read plus what it wrote: shown at
          // once, before the turn ends and the engine reports it.
          const tokens = inputTokens(response.usage) + response.usage.output_tokens
          staleTokens = undefined
          await update($, snapshot, snap => (snap ? withContext(snap, tokens) : snap))
        }
        await recordCost($, { usd, tokens: inputTokens(response.usage) + response.usage.output_tokens })
      }
      const saved = await read($, perRequest)
      if (e.agentId === undefined && saved > 0) {
        const size = response.usage ? inputTokens(response.usage) + response.usage.output_tokens : undefined
        if (size !== undefined && !stillSaves(size, saved, (await read($, snapshot))?.window)) {
          await update($, perRequest, () => 0)
        } else {
          await credit($, { tokens: saved, usd: cacheReadUsd(saved, ledger.model), requests: 1 })
        }
      }
      if (e.agentId === undefined && response.usage) {
        const size = inputTokens(response.usage) + response.usage.output_tokens
        chatBase = chatBase === undefined ? size : Math.min(chatBase, size)
      }
    } catch {
      // Bookkeeping never stands in the way of a request.
    }

    return response
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      if (e.trigger === 'manual' && result.skip === undefined) {
        await update($, lastCompact, () => ({ before: result.tokensBefore, after: result.tokensAfter }))
        await recordCompaction($, result)
      }
      if (e.trigger === 'auto' && result.skip === undefined) {
        await update($, perRequest, () => 0)
        await update($, lastCompact, () => null)
      }
      if (e.trigger !== 'precompute') await applyCompaction($, result)
    } catch {
      // the figures are only behind
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const measured = toSnapshot(e.context, e.rateLimits, e.cost)
    // Only a new context reading replaces the context shown (which a
    // compaction may have set since the last answer).
    const snap = await update($, snapshot, prev =>
      prev && !e.changed.includes('context') ? { ...measured, tokens: prev.tokens, percent: prev.percent } : measured,
    )
    if (!snap) return next(e)
    sample(e.rateLimits, await $.clock.now())
    const five = e.rateLimits.find(l => l.kind === 'five_hour')
    if (five && limitBase.resetsAt !== five.resetsAt) {
      limitBase.resetsAt = five.resetsAt
      limitBase.percent = five.percentUsed
      limitBase.cost = ledger.spent
    }

    const s = await read($, settings)
    if (s.useToasts && s.showLimits) {
      for (const limit of snap.limits) {
        const fresh = crossedLevels(limit, s.limitWarnAt, warned)
        if (fresh.length === 0) continue
        fresh.forEach(id => warned.add(id))
        const reset = fmtReset(limit.resetsAt, await $.clock.now())
        $.ui.toast(`${limitLabel(limit.kind)} at ${limit.percentUsed} %${reset ? ` · ${reset}` : ''}`, { timeoutMs: 8000 })
      }
    }
    if (s.useToasts && s.showCompact && shouldCompact(snap, s) && snap.tokens !== undefined) {
      const level = Math.floor((snap.percent ?? 0) / 10)
      if (compactToastAt !== level) {
        compactToastAt = level
        const savings = estimateSavings(snap.tokens, s.expectedTurns)
        $.ui.toast(`Context ${snap.percent} %: compacting saves ≈ ${fmtCount(savings.perTurn)} tokens per request`, { timeoutMs: 8000 })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    const snap = await read($, snapshot)
    const hint = (await inlineOn($)) ? await read($, inlineHint) : null
    if (!e.props.hasSurvey && hint && hint.options.length > 0) {
      const { Box, Button, Text } = $.ui.resolve(e)

      return (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning" bold>{`● “${hint.word}” is vague:`}</Text>
          {hint.options.map((option, i) => (
            <Button key={`inline-${i}`} label={option} onPress={() => void replaceWord($, hint, option)} />
          ))}
          {!s.smartInline && <Text size="caption" dimColor>AI wordings fitted to this chat: turn on under Settings</Text>}
        </Box>
      )
    }
    const live = await read($, draft)
    const dismissed = await read($, draftDismissed)
    if (!e.props.hasSurvey && s.useBand && s.showDraft && live?.advice && dismissed !== live.advice) {
      const { Box, Button, Text } = $.ui.resolve(e)
      const isNew = live.advice === 'newChat'
      const advice = live.advice

      return (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning" bold>{isNew ? '● New chat?' : '● Compact first?'}</Text>
          <Text>{`${live.reason ?? ''} Saves ≈ ${fmtCount(live.savingPerRequest ?? 0)} tokens per request.`}</Text>
          {isNew ? (
            <Button key="band-new-chat" label="Copy draft for a new chat" variant="primary" onPress={press => void startNewChat($, press.surface)} />
          ) : (
            <Button key="band-compact-first" label="Compact" variant="primary" onPress={() => void compactNow($)} />
          )}
          <Button key="band-stay" label="Stay here" onPress={() => void update($, draftDismissed, () => advice)} />
        </Box>
      )
    }
    const dismissedAt = await read($, bandDismissedAt)
    const isDue = s.useBand && s.showCompact && shouldCompact(snap, s)
    const isDismissed = dismissedAt !== null && (snap?.percent ?? 0) < dismissedAt + 10
    if (e.props.hasSurvey || !isDue || isDismissed || !snap || snap.tokens === undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const savings = estimateSavings(snap.tokens, s.expectedTurns)
    const percent = snap.percent ?? 0

    return (
      <Box gap={1} alignItems="center">
        <Text color="warning" bold>● Context {percent} %</Text>
        <Text>Compacting saves ≈ {fmtCount(savings.perTurn)} tokens per request</Text>
        <Button key="band-compact" label="Compact" variant="primary" onPress={() => void compactNow($)} />
        <Button key="band-later" label="Later" onPress={() => void update($, bandDismissedAt, () => percent)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Button, Text } = el
    // The terminal draws no SVG; it gets the text versions.
    const Svg = e.surface !== 'terminal' && 'Svg' in el ? el.Svg : undefined
    const Input = 'Input' in el ? el.Input : undefined
    const current = await read($, tab)
    const s = await read($, settings)

    const tabButton = (id: Tab, label: string) => (
      <Button key={`tab-${id}`} label={label} variant={current === id ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => id)} />
    )
    // The pane's title bar already names it: the tabs come first.
    const header = (
      <Box gap={1} flexWrap="wrap">
        {tabButton('overview', 'Overview')}
        {tabButton('prompt', 'Prompt')}
        {tabButton('costs', 'Costs')}
        {tabButton('settings', 'Settings')}
      </Box>
    )
    // Hovering the logo lights it and reveals the link to novaprior.com.
    const { Link } = el
    const footer = Svg ? (
      <Box key="footer" flexDirection="column" alignItems="center" marginTop={1} paddingX={1} hover={{ scope: 'novaprior', backgroundColor: 'promptBorder' }}>
        <Svg source={byline(COLORS.neutral)} alt="Software by Novaprior" width={BYLINE_WIDTH} height={BYLINE_HEIGHT} />
        <Box display="none" hover={{ scope: 'novaprior', display: 'flex' }}>
          <Link href="https://novaprior.com" label="novaprior.com ↗" />
        </Box>
      </Box>
    ) : (
      <Box key="footer" justifyContent="center" gap={1}>
        <Text size="caption" dimColor>Software by NOVAPRIOR</Text>
        <Link href="https://novaprior.com" label="novaprior.com" />
      </Box>
    )
    const card = (key: string, title: string, children: JSX.Element, borderColor: 'warning' | 'success' | 'subtle' = 'subtle') => (
      <Box key={key} flexDirection="column" gap={1} borderStyle="round" borderColor={borderColor} paddingX={1} paddingY={Svg ? 1 : 0}>
        <Text weight="semibold">{title}</Text>
        {children}
      </Box>
    )

    // The live check, in the Prompt tab and on the overview alike.
    const live = await read($, draft)
    const liveCard = (where: string) =>
      card(`c-live-${where}`, 'Live check', !live ? (
        <Text dimColor>Start typing. The check runs as soon as you pause.</Text>
      ) : (
        <Box flexDirection="column">
          <Text weight="semibold" color={live.advice ? 'warning' : 'success'}>
            {live.advice === 'newChat' ? 'Better in a new chat' : live.advice === 'compactFirst' ? 'Compact first' : 'Fits this chat'}
          </Text>
          {live.reason && <Text>{live.reason}</Text>}
          {live.savingPerRequest !== undefined && <Text size="caption" dimColor>{`Saves ≈ ${fmtCount(live.savingPerRequest)} tokens per request`}</Text>}
          <Text size="caption" dimColor>{`Draft ≈ ${fmtCount(live.tokens)} tokens`}</Text>
          {live.advice === 'newChat' && <Button key={`live-new-chat-${where}`} label="Copy draft for a new chat" variant="primary" onPress={press => void startNewChat($, press.surface)} />}
          {live.advice === 'compactFirst' && <Button key={`live-compact-${where}`} label="Compact now" variant="primary" onPress={() => void compactNow($)} />}
        </Box>
      ), live?.advice ? 'warning' : 'subtle')

    if (current === 'prompt') {
      const idea = await read($, suggestion)
      const mark = { ok: '✓', missing: '○', warn: '!' } as const
      const markColor = { ok: 'success', missing: 'subtle', warn: 'warning' } as const
      const helperCard = !s.showHelper ? undefined : card('c-helper', 'Prompt helper', (
        <Box flexDirection="column" gap={1}>
          {live ? (
            <Box flexDirection="column">
              {live.checks.map(c => (
                <Text color={markColor[c.state]}>{`${mark[c.state]}  ${c.label}`}</Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>The checklist appears as you type.</Text>
          )}
          <Button key="improve" label={idea?.status === 'loading' ? 'Improving …' : 'Improve'} variant="primary" onPress={() => void improveDraft($)} />
          {idea?.status === 'done' && idea.text && (
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor="success" paddingX={1}>
              <Text>{idea.text}</Text>
              <Box gap={1}>
                <Button
                  key="improve-take"
                  label="Use it"
                  variant="primary"
                  onPress={() =>
                    void (async () => {
                      await fillDraft($, idea.text ?? '')
                      await update($, suggestion, () => null)
                    })()
                  }
                />
                <Button key="improve-drop" label="Discard" onPress={() => void update($, suggestion, () => null)} />
              </Box>
            </Box>
          )}
          {idea?.note && <Text size="caption" dimColor>{idea.note}</Text>}
        </Box>
      ))
      const templateCard = card('c-templates', 'Templates', (
        <Box gap={1} flexWrap="wrap">
          {TEMPLATES.map(t => (
            <Button key={`tpl-${t.id}`} label={t.label} onPress={() => void fillDraft($, t.text)} />
          ))}
        </Box>
      ))

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {s.showDraft && liveCard('prompt')}
          {helperCard}
          {templateCard}
          {footer}
        </Box>
      )
    }

    if (current === 'costs') {
      const inSession = await read($, sessionCosts)
      const book = await read($, costBook)
      const now = await $.clock.now()
      const month = book.months[monthOf(now)] ?? NO_COSTS
      const projected = projectMonth(month.usd, now, book.since)
      // Under a week of figures, the projection is a guess and says so.
      const countedDays = monthDaysCounted(now, book.since)
      const column = (key: string, title: string, c: Costs) => (
        <Box key={key} flexDirection="column" alignItems="center" flexGrow={1}>
          <Text size="caption" dimColor>{title}</Text>
          <Text size="heading" weight="semibold" tabular>{fmtUsd(c.usd)}</Text>
          <Text size="caption" dimColor tabular>{fmtCount(c.tokens)}</Text>
          <Text size="caption" dimColor>tokens</Text>
        </Box>
      )
      // The long run: the API's cost over a period against the subscription
      // for the same time, switchable between all time and the last months.
      const period = await read($, costPeriod)
      const span = periodCosts(book, period, now)
      const periodButton = (id: CostPeriod, label: string) => (
        <Button key={`period-${id}`} label={label} variant={period === id ? 'primary' : 'secondary'} onPress={() => void update($, costPeriod, () => id)} />
      )
      const aboForSpan = s.aboUsd * span.months
      const spanDiff = span.usd - aboForSpan
      const spanVerdict =
        s.aboUsd <= 0 ? (
          <Text dimColor>Enter your subscription under Settings to see the comparison.</Text>
        ) : spanDiff >= 0 ? (
          <Text weight="semibold" color="success">{`The subscription paid off: the API would have cost ≈ ${fmtUsd(spanDiff)} more.`}</Text>
        ) : (
          <Text weight="semibold" color="warning">{`The API would have been ≈ ${fmtUsd(-spanDiff)} cheaper than the subscription.`}</Text>
        )
      const months = Object.keys(book.months).sort().reverse().slice(0, 6)
      let verdict = <Text dimColor>Enter your subscription under Settings to see the comparison.</Text>
      if (s.aboUsd > 0) {
        const diff = projected - s.aboUsd
        verdict =
          diff >= 0 ? (
            <Text weight="semibold" color="success">{`The subscription pays off: the API would cost ≈ ${fmtUsd(diff)} more.`}</Text>
          ) : (
            <Text weight="semibold" color="warning">{`So far the API would be ≈ ${fmtUsd(-diff)} cheaper than the subscription.`}</Text>
          )
      }

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {card('c-costs', 'Costs at API prices', (
            <Box gap={1}>
              {column('cost-session', 'Session', inSession)}
              {column('cost-month', 'This month', month)}
              {column('cost-all', 'All time', book.total)}
            </Box>
          ))}
          {card('c-abo', 'Subscription or API?', (
            <Box flexDirection="column" gap={1}>
              <Text>{`Projected for the month: ≈ ${fmtUsd(projected)}`}</Text>
              {countedDays < 7 && (
                <Text size="caption" dimColor>{`Early estimate: run on from ${Math.max(1, Math.round(countedDays))} day${Math.round(countedDays) === 1 ? '' : 's'} counted so far.`}</Text>
              )}
              <Text dimColor>{s.aboUsd > 0 ? `Your subscription: ${fmtUsd(s.aboUsd)} per month` : 'No subscription entered'}</Text>
              {verdict}
              <Text size="caption" dimColor>At the prices listed below, counted since Token-Coach has been running, in Claude Code only. The longer it counts, the more reliable the comparison.</Text>
            </Box>
          ))}
          {card('c-period', 'In the long run', (
            <Box flexDirection="column" gap={1}>
              <Box gap={1} flexWrap="wrap">
                {periodButton('all', 'All time')}
                {periodButton('3m', '3 months')}
                {periodButton('6m', '6 months')}
              </Box>
              <Text>{`API: ≈ ${fmtUsd(span.usd)} in ${fmtMonths(span.months)} (≈ ${fmtUsd(span.usd / span.months)} per month)`}</Text>
              {s.aboUsd > 0 && <Text dimColor>{`Subscription for the same time: ≈ ${fmtUsd(aboForSpan)}`}</Text>}
              {spanVerdict}
              {span.isPartial && <Text size="caption" dimColor>{`Counted only since ${book.since}: the period is not full yet.`}</Text>}
            </Box>
          ))}
          {card('c-prices', 'Prices used ($ per million tokens)', (
            <Box flexDirection="column">
              {PRICE_FAMILIES.map(f => (
                <Box key={`price-${f.id}`} flexDirection="column">
                  <Text weight="semibold">{`${f.label}${s.prices[f.id] ? ' (yours)' : ''}`}</Text>
                  <Text size="caption" dimColor tabular>{fmtPrice(familyPrice(f.id))}</Text>
                </Box>
              ))}
              <Text size="caption" dimColor>Built in as of Oct 2026. Check anthropic.com/pricing and change them under Settings.</Text>
            </Box>
          ))}
          {months.length > 1 &&
            card('c-months', 'History', (
              <Box flexDirection="column">
                {months.map(m => (
                  <Box key={`m-${m}`} justifyContent="space-between">
                    <Text tabular>{m}</Text>
                    <Text tabular>{fmtUsd(book.months[m]?.usd ?? 0)}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          {book.since && (
            <Box justifyContent="center">
              <Text size="caption" dimColor>{`Counted since ${book.since}`}</Text>
            </Box>
          )}
          {footer}
        </Box>
      )
    }

    if (current === 'settings') {
      const toggle = (key: string, label: string, hint: string, field: 'showCompact' | 'showLimits' | 'useBand' | 'useToasts' | 'showDraft' | 'showHelper' | 'showInline' | 'smartInline') => (
        <Box gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="column" flexShrink={1}>
            <Text>{label}</Text>
            <Text size="caption" dimColor>{hint}</Text>
          </Box>
          <Button key={key} label={s[field] ? 'On' : 'Off'} variant={s[field] ? 'primary' : 'secondary'} onPress={() => void saveSettings($, x => ({ ...x, [field]: !x[field] }))} />
        </Box>
      )
      const stepper = (key: string, label: string, field: 'compactAt' | 'limitWarnAt' | 'expectedTurns' | 'aboUsd', step: number, min: number, max: number, unit: string) => (
        <Box gap={1} alignItems="center" justifyContent="space-between">
          <Box flexShrink={1}>
            <Text>{label}</Text>
          </Box>
          <Box gap={0} alignItems="center" flexShrink={0}>
            <Button key={`${key}-down`} label="−" onPress={() => void saveSettings($, x => ({ ...x, [field]: clamp(x[field] - step, min, max) }))} />
            <Box width={5} flexShrink={0} justifyContent="center">
              <Text tabular weight="semibold" wrap="truncate">{`${s[field]}${unit}`}</Text>
            </Box>
            <Button key={`${key}-up`} label="+" onPress={() => void saveSettings($, x => ({ ...x, [field]: clamp(x[field] + step, min, max) }))} />
          </Box>
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {card('c-rec', 'Recommendations', (
            <Box flexDirection="column" gap={1}>
              {toggle('set-compact', 'Compacting', 'A hint once compacting pays off', 'showCompact')}
              {toggle('set-limits', 'Usage limits', 'Show and warn about the 5-hour and 7-day limits', 'showLimits')}
              {toggle('set-draft', 'Live check', 'While typing: new chat or stay here?', 'showDraft')}
              {toggle('set-helper', 'Prompt helper', 'Checklist and Improve in the Prompt tab', 'showHelper')}
              {toggle('set-inline', 'Inline suggestions', 'Vague words underlined, precise wordings one click away', 'showInline')}
              {toggle('set-smart-inline', 'Wordings fitted to this chat', 'Claude Haiku suggests them from the conversation; a few tokens each', 'smartInline')}
            </Box>
          ))}
          {card('c-show', 'Display', (
            <Box flexDirection="column" gap={1}>
              {toggle('set-band', 'Hint bar', 'Above the prompt box when there is something to do', 'useBand')}
              {toggle('set-toasts', 'Notifications', 'Pop-ups at thresholds', 'useToasts')}
            </Box>
          ))}
          {card('c-thresholds', 'Thresholds', (
            <Box flexDirection="column" gap={1}>
              {stepper('set-compact-at', 'Compact from context', 'compactAt', 5, 20, 95, ' %')}
              {stepper('set-warn-at', 'Limit warning from', 'limitWarnAt', 5, 50, 95, ' %')}
              {stepper('set-turns', 'Expected further messages', 'expectedTurns', 1, 1, 50, '')}
              {stepper('set-abo', 'Your subscription per month', 'aboUsd', 5, 0, 500, ' $')}
            </Box>
          ))}
          {card('c-set-prices', 'API prices ($ per million tokens)', (
            <Box flexDirection="column" gap={1}>
              {PRICE_FAMILIES.map(f => {
                const mine = s.prices[f.id]
                const shown = familyPrice(f.id)

                return (
                  <Box key={`set-price-${f.id}`} flexDirection="column">
                    <Box gap={1} alignItems="center" justifyContent="space-between">
                      <Text>{`${f.label}${mine ? ' (yours)' : ''}`}</Text>
                      {mine && (
                        <Button
                          key={`set-price-${f.id}-reset`}
                          label="Built-in"
                          onPress={() => void saveSettings($, x => ({ ...x, prices: Object.fromEntries(Object.entries(x.prices).filter(([k]) => k !== f.id)) }))}
                        />
                      )}
                    </Box>
                    <Text size="caption" dimColor tabular>{fmtPrice(shown)}</Text>
                    {Input && (
                      <Input
                        key={`set-price-${f.id}-input`}
                        placeholder={`${builtInPrice(f.id).input} / ${builtInPrice(f.id).output} / ${builtInPrice(f.id).cacheRead}`}
                        submitLabel="Set"
                        onSubmit={value => {
                          const next = parsePrice(value, shown)
                          if (next) void saveSettings($, x => ({ ...x, prices: { ...x.prices, [f.id]: next } }))
                          else $.ui.toast('Type input / output / cache read, e.g. 4 / 20 / 0.2')
                        }}
                      />
                    )}
                  </Box>
                )
              })}
              <Text size="caption" dimColor>Input / output / cache read in $. Cache writes count as 1.25 × input.</Text>
            </Box>
          ))}
          <Box justifyContent="center">
            <Button key="set-reset" label="Restore defaults" onPress={() => void saveSettings($, () => DEFAULT_SETTINGS)} />
          </Box>
          {footer}
        </Box>
      )
    }

    const snap = await read($, snapshot)
    const busy = await read($, isCompacting)
    const msg = await read($, notice)
    const last = await read($, lastCompact)
    const inSession = await read($, sessionSavings)
    const allTime = await read($, allTimeSavings)
    const saving = await read($, perRequest)
    const now = await $.clock.now()

    // One recommendation, the most useful one, with its action.
    const percent = snap?.percent
    const tone: Tone = percent === undefined ? 'neutral' : limitColor(percent, s.compactAt)
    const isDue = s.showCompact && shouldCompact(snap, s)
    const savings = snap?.tokens !== undefined ? estimateSavings(snap.tokens, s.expectedTurns) : undefined
    const contextLine = snap?.tokens !== undefined ? `Context ${percent} % · ${fmtCount(snap.tokens)} / ${fmtCount(snap.window)}` : 'Context: measured after the first answer'
    let headline = 'All good'
    let detail = `Compacting pays off from ${s.compactAt} % context.`
    if (!s.showCompact) {
      headline = 'Recommendation off'
      detail = 'Turn it back on under Settings.'
    } else if (isDue && savings) {
      headline = 'Compact now'
      detail = `Saves ≈ ${fmtCount(savings.perTurn)} tokens on every further request.`
    } else if (snap?.tokens === undefined) {
      headline = 'Ready'
      detail = 'The recommendation appears after the first answer.'
    }
    const hero = (
      <Box key="hero" flexDirection="column" gap={1} borderStyle="round" borderColor={isDue ? 'warning' : 'subtle'} paddingX={1} paddingY={Svg ? 1 : 0}>
        <Box gap={2} alignItems="center">
          {Svg && <Svg source={ring(percent, tone, 64)} alt={`Context ${percent ?? '–'} %`} width={64} height={64} />}
          <Box flexDirection="column" flexShrink={1}>
            <Text size="heading" weight="semibold" color={isDue ? 'warning' : undefined}>{headline}</Text>
            <Text>{detail}</Text>
            <Text size="caption" dimColor>{contextLine}</Text>
            {!Svg && percent !== undefined && <Text color={tone === 'neutral' ? 'subtle' : tone}>{textBar(percent)}</Text>}
          </Box>
        </Box>
        {isDue && savings && snap?.tokens !== undefined && Svg && (
          <Svg source={savingsBars(snap.tokens, savings.summary, snap.window)} alt="Context now and after compacting" width={280} height={40} />
        )}
        <Button key="compact" label={busy ? 'Compacting …' : isDue ? 'Compact now' : 'Compact anyway'} variant={isDue ? 'primary' : 'secondary'} onPress={() => void compactNow($)} />
        {msg && <Text size="caption" dimColor>{msg}</Text>}
      </Box>
    )

    // What compacting has saved, net of what the compactions cost.
    // The three numbers that matter, large: this session, all time beneath.
    // The all-time figure gets its own line, so a narrow column never wraps it.
    // A large value too wide for its column takes two centered lines.
    const kpi = (key: string, value: string | string[], label: string, total: string, isGood: boolean) => (
      <Box key={key} flexDirection="column" alignItems="center" flexGrow={1}>
        {(Array.isArray(value) ? value : [value]).map(line => (
          <Text size="title" weight="bold" tabular color={isGood ? 'success' : undefined}>{line}</Text>
        ))}
        <Text size="caption" weight="semibold">{label}</Text>
        <Text size="caption" dimColor>all time</Text>
        <Text size="caption" dimColor tabular>{total}</Text>
      </Box>
    )
    const usdOf = (v: Savings) => fmtUsd(v.usd ?? (v.tokens === 0 ? 0 : undefined))
    // Paid back once both the tokens and the money are: the money takes longer,
    // as the summary is written at the output price.
    const savingUsd = cacheReadUsd(saving, ledger.model)
    const payback =
      saving > 0 && (inSession.tokens < 0 || (inSession.usd ?? 0) < 0)
        ? Math.max(
            inSession.tokens < 0 ? Math.ceil(-inSession.tokens / saving) : 0,
            (inSession.usd ?? 0) < 0 && savingUsd > 0 ? Math.ceil(-(inSession.usd ?? 0) / savingUsd) : 0,
          )
        : 0
    const kpiCard = (
      <Box key="kpi" flexDirection="column" gap={1} borderStyle="round" borderColor={inSession.tokens > 0 ? 'success' : 'subtle'} paddingX={1} paddingY={Svg ? 1 : 0}>
        <Box justifyContent="center">
          <Text size="caption" dimColor>Saved this session</Text>
        </Box>
        <Box gap={1} justifyContent="space-around">
          {kpi('kpi-tokens', fmtSigned(inSession.tokens), 'Tokens', fmtSigned(allTime.tokens), inSession.tokens > 0)}
          {kpi('kpi-usd', usdOf(inSession), 'Money', usdOf(allTime), (inSession.usd ?? 0) > 0)}
          {kpi('kpi-time', durationLines(fmtGain(inSession.timeMs)), 'More time', fmtGain(allTime.timeMs), (inSession.timeMs ?? 0) > 0)}
        </Box>
        {payback > 0 && (
          <Box justifyContent="center">
            <Text size="caption" dimColor>{`Compacting pays for itself after ${payback} more requests.`}</Text>
          </Box>
        )}
        {last && last.before !== undefined && payback === 0 && saving > 0 && (
          <Box justifyContent="center">
            <Text size="caption" dimColor>{`Last ${fmtCount(last.before)} → ${last.after !== undefined ? fmtCount(last.after) : '?'}: every request ${fmtCount(saving)} smaller`}</Text>
          </Box>
        )}
      </Box>
    )

    // The usage limits stay in the background: one quiet line.
    const limits = s.showLimits ? (snap?.limits ?? []) : []
    const limitRow =
      limits.length > 0 ? (
        <Box key="limits" flexDirection="column" alignItems="center" gap={1}>
          {limits.map(l => {
            const f = forecast(l, now)
            const pace = recentPace(samples.get(`${l.kind}|${l.resetsAt ?? ''}`) ?? [], now)
            const r = pace === undefined ? undefined : forecastAt(l, now, pace)
            const say = (x: { exhaustIn?: number; waitAfter?: number }) =>
              x.waitAfter !== undefined ? `full in ${fmtDuration(x.exhaustIn ?? 0)} · ${fmtDuration(x.waitAfter)} wait` : 'lasts until the reset'
            const rows: ChartRow[] = []
            if (f.resetIn !== undefined) {
              if (l.percentUsed >= 100) {
                rows.push({ label: 'Limit reached', text: `wait ${fmtDuration(f.resetIn)}`, isTight: true })
              } else {
                rows.push({ label: 'Window average', text: say(f), isTight: f.waitAfter !== undefined })
                rows.push(
                  r
                    ? { label: 'Last 30 min', text: say(r), isTight: r.waitAfter !== undefined }
                    : { label: 'Last 30 min', text: 'measuring …', isTight: false },
                )
              }
              rows.push({ label: 'Next reset', text: `${fmtClock(l.resetsAt, now)} (in ${fmtDuration(f.resetIn)})`, isTight: false })
            }
            const isTight = rows.some(x => x.isTight)
            const tone: Tone = isTight ? 'error' : limitColor(l.percentUsed, s.limitWarnAt)
            const length = windowLength(l.kind)
            // The red stretch starts where the earlier of the two forecasts runs out.
            const exhaustIn = [f.exhaustIn, r?.exhaustIn].filter((x): x is number => x !== undefined).sort((a, b) => a - b)[0]
            const chart = {
              label: limitLabel(l.kind),
              percent: l.percentUsed,
              tone,
              rows,
              elapsed: length && f.resetIn !== undefined ? (length - f.resetIn) / length : undefined,
              exhaustAt: length && f.resetIn !== undefined && exhaustIn !== undefined ? (length - f.resetIn + exhaustIn) / length : undefined,
            }
            const alt = `${chart.label}: ${l.percentUsed} % used${rows.map(x => `, ${x.label}: ${x.text}`).join('')}`

            return Svg ? (
              <Svg key={`limit-${l.kind}`} source={limitChart(chart)} alt={alt} width={260} height={limitChartHeight(chart)} />
            ) : (
              <Text size="caption" dimColor={!isTight} color={isTight ? 'warning' : undefined}>{alt}</Text>
            )
          })}
        </Box>
      ) : undefined

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {kpiCard}
        {s.showDraft && liveCard('overview')}
        {hero}
        {limitRow}
        {/* Short lines, each centered: a long one wraps flush left. */}
        <Box flexDirection="column" alignItems="center">
          <Text size="caption" dimColor>Estimates · $ at API prices</Text>
          <Text size="caption" dimColor>More time assumes only</Text>
          <Text size="caption" dimColor>Claude Code uses your limit</Text>
        </Box>
        {footer}
      </Box>
    )
  })
}
