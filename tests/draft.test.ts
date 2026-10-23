import { expect, test } from 'claude-code/testing'

import { analyzeDraft, checklist, keywords } from '../hooks/draft'
import { EMPTY_BOOK, bookCosts, cacheReadUsd, costOf, fmtClock, fmtGain, forecastAt, priceFor, projectMonth, recentPace, timeGained } from '../hooks/logic'

const CHAT = keywords('Wir bauen das Token-Coach Panel in register.tsx, mit Ringanzeige, Lizenzschlüssel und Komprimieren-Button.')
const BASE = { percent: 30, tokens: 60_000, compactAt: 60, recent: CHAT, messageCount: 10 }

test('a draft on the same topic stays in this chat', () => {
  const a = analyzeDraft('Mach die Ringanzeige im Panel in register.tsx etwas kleiner', BASE)
  expect(a.advice).toBeUndefined()
})

test('an unrelated draft suggests a new chat, saving the whole context', () => {
  const a = analyzeDraft('Schreibe eine Einkaufsliste für Lasagne mit Zutaten und Mengenangaben für vier Personen', BASE)
  expect(a.advice).toBe('newChat')
  expect(a.savingPerRequest).toBe(60_000)
})

test('a short or follow-up draft stays in this chat', () => {
  expect(analyzeDraft('Kannst du die Überschrift entfernen?', BASE).advice).toBeUndefined()
  expect(analyzeDraft('Schreibe außerdem noch eine Einkaufsliste für Lasagne mit Zutaten und Mengenangaben', BASE).advice).toBeUndefined()
  expect(analyzeDraft('Schreibe eine Einkaufsliste für Lasagne mit Zutaten und Mengenangaben für vier Personen', { ...BASE, tokens: 20_000 }).advice).toBeUndefined()
})

test('saying it is a new topic suggests a new chat', () => {
  expect(analyzeDraft('Neues Thema: wie richte ich ein Backup ein?', BASE).advice).toBe('newChat')
})

test('a full context on the same topic suggests compacting first', () => {
  const a = analyzeDraft('Mach die Ringanzeige im Panel in register.tsx kleiner', { ...BASE, percent: 70, tokens: 140_000 })
  expect(a.advice).toBe('compactFirst')
})

test('a short chat gets no advice', () => {
  expect(analyzeDraft('Schreibe eine Einkaufsliste für Lasagne mit Zutaten', { ...BASE, messageCount: 1 }).advice).toBeUndefined()
})

test('the checklist sees goal, place, done criterion and vague words', () => {
  const good = checklist('Behebe den Absturz in src/app.ts:42, sodass der Test login.test.ts grün ist')
  expect(good.map(c => c.state)).toEqual(['ok', 'ok', 'ok'])
  const vague = checklist('mach das irgendwie schöner')
  expect(vague.find(c => c.id === 'where')?.state).toBe('missing')
  expect(vague.find(c => c.id === 'vague')?.state).toBe('warn')
})

test('costs add up per month and in total, and project to the month', () => {
  const oct = Date.parse('2026-10-10T12:00:00Z')
  let book = bookCosts(EMPTY_BOOK, { usd: 2, tokens: 1000 }, oct)
  book = bookCosts(book, { usd: 3 }, Date.parse('2026-11-02T12:00:00Z'))
  expect(book.total).toEqual({ usd: 5, tokens: 1000 })
  expect(book.months['2026-10']).toEqual({ usd: 2, tokens: 1000 })
  expect(book.months['2026-11']).toEqual({ usd: 3, tokens: 0 })
  expect(book.since).toBe('2026-10-10')
  expect(Math.round(projectMonth(10, Date.parse('2026-10-16T00:00:00')))).toBe(21)
})

test('saved money buys time before the 5-hour limit', () => {
  // 1 $ per percent, 20 % per hour: 0,50 $ saved is half a percent, 1,5 minutes.
  expect(timeGained(0.5, 1, 20 / 3_600_000)).toBe(90_000)
  expect(timeGained(0.5, undefined, 1)).toBeUndefined()
  expect(fmtGain(90_000)).toBe('+2 min')
  expect(fmtGain(undefined)).toBe('0 min')
})

test('requests are priced at the model list price', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
  // Opus 5.5: 4 $ in, 20 $ out, 0,20 $ cache read per million.
  expect(Math.round(costOf(usage, 'claude-opus-5-5') * 100)).toBe(620)
  expect(priceFor('claude-sonnet-5-5').input).toBe(2)
  expect(priceFor('claude-haiku-5-5[1m]').output).toBe(0.5)
  expect(Math.round(cacheReadUsd(1_000_000, 'claude-fable-5-1') * 100)).toBe(25)
})

test('the last half hour gives its own pace and forecast', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const min = 60_000
  // 50 % forty minutes ago, 55 % thirty minutes ago, 70 % now: 15 % in 30 minutes.
  const samples = [
    { t: now - 40 * min, percent: 50 },
    { t: now - 30 * min, percent: 55 },
    { t: now, percent: 70 },
  ]
  const pace = recentPace(samples, now)
  expect(Math.round((pace ?? 0) * 60 * min * 10) / 10).toBe(30)
  // 30 % left at 30 % per hour: full in 1 h; the reset is 2 h away.
  const f = forecastAt({ kind: 'five_hour', percentUsed: 70, resetsAt: '2026-10-22T14:00:00Z' }, now, pace ?? 0)
  expect(f).toEqual({ resetIn: 2 * 60 * min, exhaustIn: 60 * min, waitAfter: 60 * min })
  // Readings spanning under 10 minutes are not enough.
  expect(recentPace([{ t: now - 5 * min, percent: 60 }, { t: now, percent: 61 }], now)).toBeUndefined()
})

test('reset times read as clock times', () => {
  const now = new Date(2026, 9, 22, 12, 0).getTime()
  expect(fmtClock(new Date(2026, 9, 22, 15, 40).toISOString(), now)).toBe('15:40')
  expect(fmtClock(new Date(2026, 9, 24, 9, 5).toISOString(), now)).toBe('Sat 09:05')
})
