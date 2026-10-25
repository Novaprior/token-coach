import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_SETTINGS, NO_SAVINGS, addSavings, crossedLevels, estimateSavings, fmtDuration, fmtUsd, forecast, inputPrice, savedUsd, shouldCompact, weighted } from '../hooks/logic'

const PANE = {
  plugin: 'token-coach',
  component: 'Pane',
  requestId: 'token-coach',
  props: {
    title: 'Token-Coach',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  context: { tokens: 130_000, window: 200_000, percent: 65 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 41 }],
  cost: { usd: 1.5 },
}


function engine(on: On, saved: Record<string, unknown> = {}, messages: { role: string; text: string; toolUses: [] }[] = []) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T12:00:00Z') })
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: messages }))
  on('ui.status', () => ({ value: undefined }))

  return clock
}

test('the savings estimate keeps a tenth as summary, within 2k to 12k', () => {
  expect(estimateSavings(130_000, 10)).toEqual({ summary: 12_000, perTurn: 118_000, oneTimeCost: 142_000, net: 1_038_000 })
  expect(estimateSavings(10_000, 1).summary).toBe(2_000)
})

test('compacting is advised past the threshold only', () => {
  const snap = { tokens: 130_000, window: 200_000, percent: 65, limits: [] }
  expect(shouldCompact(snap, DEFAULT_SETTINGS)).toBe(true)
  expect(shouldCompact({ ...snap, percent: 50 }, DEFAULT_SETTINGS)).toBe(false)
  expect(shouldCompact(snap, { ...DEFAULT_SETTINGS, compactAt: 70 })).toBe(false)
  expect(shouldCompact(null, DEFAULT_SETTINGS)).toBe(false)
})

test('a limit warns once per level and window', () => {
  const limit = { kind: 'five_hour', percentUsed: 96, resetsAt: '2026-10-22T15:40:00Z' }
  const first = crossedLevels(limit, 80, new Set())
  expect(first.length).toBe(2)
  expect(crossedLevels(limit, 80, new Set(first)).length).toBe(0)
})

test('the pane shows the context, the limit and the compact advice, on every surface', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /130k \/ 200k/ }))?.text).toBe('Context 65 % · 130k / 200k')
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: /^5-hour limit/ }))?.text).toBe('5-hour limit: 41 % used')
    }
    expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /118k tokens on every further request/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the compact button compacts and reports the sizes', async ($, on) => {
  let instructions: string | undefined
  engine(on)
  on('session.compact', (_, e) => {
    instructions = e.instructions

    return { messages: [{ role: 'user', text: 'Zusammenfassung', toolUses: [] }], tokensBefore: 130_000, tokensAfter: 9_000 }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(instructions).toContain('open points')
  // The compaction read 130k and wrote a 9k summary; the money, with the
  // summary at the output price, takes longer to pay back than the tokens.
  expect(await ui.find({ type: 'Text', text: /^−139k$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /pays for itself/ }))?.text).toBe('Compacting pays for itself after 9 more requests.')
  await ui.unmount()
})

test('the stored totals keep what another session added meanwhile', async ($, on) => {
  const saved: Record<string, unknown> = {}
  engine(on, saved)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Zusammenfassung', toolUses: [] }], tokensBefore: 130_000, tokensAfter: 9_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A second session writes its totals after this one started.
  saved['stats'] = { ...NO_SAVINGS, tokens: 50_000, compactions: 2, requests: 10, since: '2026-10-01' }
  saved['costs'] = { since: '2026-10-01', total: { usd: 3, tokens: 400_000 }, months: { '2026-10': { usd: 3, tokens: 400_000 } } }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  const stats = saved['stats'] as { tokens: number; compactions: number; requests: number; since: string }
  expect({ tokens: stats.tokens, compactions: stats.compactions, requests: stats.requests, since: stats.since }).toEqual({ tokens: -89_000, compactions: 3, requests: 10, since: '2026-10-01' })
  const costs = saved['costs'] as { total: { tokens: number }; months: Record<string, { tokens: number }> }
  expect(costs.total.tokens).toBe(539_000)
  expect(costs.months['2026-10'].tokens).toBe(539_000)
  await ui.unmount()
})

test('a setting turned off hides its advice and is stored', async ($, on) => {
  const saved: Record<string, unknown> = {}
  engine(on, saved)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'set-compact' })
  await ui.press({ key: 'tab-overview' })

  expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeUndefined()
  const stored = saved['settings'] as { showCompact: boolean }
  expect(stored.showCompact).toBe(false)
  await ui.unmount()
})

test('savings are priced from the session cost as cache reads', () => {
  const usage = { input_tokens: 1_000, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000 }
  expect(weighted(usage)).toBe(1_000 + 5_000 + 10_000 + 5_000)
  expect(inputPrice(1.5, 0.5, 200_000)).toBe(0.000005)
  expect(inputPrice(1.5, undefined, 200_000)).toBeUndefined()
  expect(Math.round((savedUsd(100_000, 0.000005) ?? 0) * 1e6)).toBe(50_000)
  const s = addSavings(addSavings(NO_SAVINGS, { tokens: -130_000, usd: -0.2, compactions: 1 }), { tokens: 120_000, usd: 0.06, requests: 1 })
  expect({ ...s, usd: Math.round((s.usd ?? 0) * 100) }).toEqual({ tokens: -10_000, usd: -14, compactions: 1, requests: 1 })
  expect(fmtUsd(1.234)).toBe('$1.23')
  expect(fmtUsd(undefined)).toBe('–')
})

test('a limit forecasts when it runs out and how long one waits', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  // 3 h into a 5 h window, 75 % used: full in 1 h, then 1 h until the reset.
  const tight = forecast({ kind: 'five_hour', percentUsed: 75, resetsAt: '2026-10-22T14:00:00Z' }, now)
  expect(tight).toEqual({ resetIn: 2 * 3_600_000, exhaustIn: 3_600_000, waitAfter: 3_600_000 })
  // 3 h in, 30 % used: lasts until the reset.
  expect(forecast({ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-22T14:00:00Z' }, now)).toEqual({ resetIn: 2 * 3_600_000 })
  expect(forecast({ kind: 'five_hour', percentUsed: 30 }, now)).toEqual({})
  expect(fmtDuration(2 * 3_600_000 + 10 * 60_000)).toBe('2 h 10 min')
  expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h')
  expect(fmtDuration(30_000)).toBe('1 min')
})

test('the pane says when a tight limit runs out', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-22T12:00:00Z') })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 75, resetsAt: '2026-10-22T14:00:00Z' }] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^5-hour limit/ }))?.text).toMatch(/^5-hour limit: 75 % used, Window average: full in 1 h · 1 h wait, Last 30 min: measuring …, Next reset: \d\d:\d\d \(in 2 h\)$/)
  await ui.unmount()
})

test('a refused compaction puts /compact in the prompt box', async ($, on) => {
  let filled = ''
  engine(on)
  on('session.compact', () => {
    throw new Error('a turn is running')
  })
  on('prompt.fill', (_, e) => {
    filled = e.text

    return { isFilled: true }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(filled.startsWith('/compact ')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /press Enter to compact/ })).toBeDefined()
  await ui.unmount()
})

test('compacting sends /compact as if typed', async ($, on) => {
  let args = ''
  engine(on)
  on('command.run', { command: 'compact' }, (_, e) => {
    args = e.args

    return { text: '' }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })

  expect(args).toContain('open points')
  expect(await ui.find({ type: 'Text', text: /^Compacted\./ })).toBeDefined()
  await ui.unmount()
})

test('after compacting the context and the advice update at once', async ($, on) => {
  engine(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Zusammenfassung', toolUses: [] }], tokensBefore: 130_000, tokensAfter: 9_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeDefined()
  await ui.press({ key: 'compact' })

  expect((await ui.find({ type: 'Text', text: /^Context/ }))?.text).toBe('Context 5 % · 9k / 200k')
  expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeUndefined()
  await ui.unmount()
})

test('a reached limit says how long to wait and when it resets', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-22T12:00:00Z') })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-22T13:20:00Z' }] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^5-hour limit/ }))?.text).toMatch(/^5-hour limit: 100 % used, Limit reached: wait 1 h 20 min, Next reset: \d\d:\d\d \(in 1 h 20 min\)$/)
  await ui.unmount()
})

test('the overview shows the live check unless it is turned off', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Live check$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Start typing/ })).toBeDefined()

  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'set-draft' })
  await ui.press({ key: 'tab-overview' })
  expect(await ui.find({ type: 'Text', text: /^Live check$/ })).toBeUndefined()
  await ui.unmount()
})

test('the prompt tab is open to everyone', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-prompt' })

  expect(await ui.find({ type: 'Text', text: /^Live check$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Templates$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pro/ })).toBeUndefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'token-coach',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } },
} as const

// Types `word` at the end of `before`, as the prompt box would.
async function typeWord($: Parameters<Parameters<typeof test>[1]>[0], before: string, word: string) {
  const at = before.length
  await $.prompt.edit({ origin: { kind: 'composer' }, text: before, cursor: at, start: at, end: at, inputText: word })
}

async function hintOptions($: Parameters<Parameters<typeof test>[1]>[0]): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const labels: string[] = []
  for (let i = 0; i < 6; i++) {
    const b = await ui.find({ key: `inline-${i}` })
    if (b?.text) labels.push(b.text)
  }
  await ui.unmount()

  return labels
}

test('a vague word gets precise wordings in the hint bar, fitted to the chat', async ($, on) => {
  const saved: Record<string, unknown> = {}
  engine(on, saved, [{ role: 'user', text: 'Das Panel in hooks/register.tsx', toolUses: [] }])
  on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  let asked = 0
  on('model.complete', () => {
    asked++

    return { value: { isAnswered: true, text: 'übersichtlicher im Panel\nkompakter in register.tsx', usage: { input_tokens: 300, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await typeWord($, 'Mach es ', 'alles')
  expect(await hintOptions($)).toEqual(['alle Dateien in hooks', 'nur hooks/register.tsx'])
  expect(asked).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'set-smart-inline' })
  await ui.unmount()
  await typeWord($, 'Mach das Panel ', 'besser')
  await new Promise(resolve => setTimeout(resolve, 20))
  const fitted = await hintOptions($)
  expect(fitted.slice(0, 2)).toEqual(['übersichtlicher im Panel', 'kompakter in register.tsx'])
  expect(fitted.length).toBe(5)
  await typeWord($, 'Mach das Panel ', 'besser')
  expect(asked).toBe(1)
})

test('the long-run card compares API and subscription over the chosen period', async ($, on) => {
  const saved: Record<string, unknown> = {
    costs: { since: '2026-07-01', total: { usd: 90, tokens: 9_000_000 }, months: { '2026-07': { usd: 30, tokens: 3_000_000 }, '2026-10': { usd: 60, tokens: 6_000_000 } } },
  }
  engine(on, saved)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-costs' })
  expect(await ui.find({ type: 'Text', text: /^API: ≈ \$90 in 3\.7 months/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^The subscription paid off/ })).toBeDefined()
  await ui.press({ key: 'period-3m' })
  expect(await ui.find({ type: 'Text', text: /^API: ≈ \$60 in / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^tokens$/ })).toBeDefined()
  await ui.unmount()
})

test('a price set under Settings is stored, shown and priced with', async ($, on) => {
  const saved: Record<string, unknown> = {}
  engine(on, saved)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-settings' })
  await ui.input({ key: 'set-price-opus-input', text: '5 / 25 / 0.25', kind: 'submit' })
  expect((saved['settings'] as { prices: Record<string, unknown> }).prices).toEqual({ opus: { input: 5, output: 25, cacheRead: 0.25 } })
  expect(await ui.find({ type: 'Text', text: /^Opus 5\.5 \(yours\)$/ })).toBeDefined()
  await ui.press({ key: 'set-price-opus-reset' })
  expect((saved['settings'] as { prices: Record<string, unknown> }).prices).toEqual({})
  await ui.press({ key: 'tab-costs' })
  expect(await ui.find({ type: 'Text', text: /^\$4 in · \$20 out · \$0\.2 cache$/ })).toBeDefined()
  await ui.unmount()
})

test('the hint bar mentions the AI wordings while they are off', async ($, on) => {
  engine(on)
  on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await typeWord($, 'Mach das ', 'besser')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /turn on under Settings$/ })).toBeDefined()
  await band.unmount()
})

test('new chat runs /clear and brings the draft back', async ($, on) => {
  let cleared = 0
  const fills: string[] = []
  const clock = engine(on, {}, [
    { role: 'user', text: 'Wir bauen das Panel in register.tsx mit Ringanzeige', toolUses: [] },
    { role: 'assistant', text: 'Die Ringanzeige im Panel ist fertig', toolUses: [] },
  ])
  on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('prompt.read', () => ({ value: { text: 'Schreibe eine Einkaufsliste für Lasagne mit Zutaten und Mengenangaben für vier Personen', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)

    return { value: { isFilled: true } }
  })
  on('command.run', { command: 'clear' }, () => {
    cleared++

    return { text: '' }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await typeWord($, '', 'Schreibe eine Einkaufsliste für Lasagne mit Zutaten und Mengenangaben für vier Personen')
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-prompt' })
  await ui.press({ key: 'live-new-chat-prompt' })
  expect(cleared).toBe(1)
  expect(fills).not.toContain('/clear')
  await ui.unmount()
})
