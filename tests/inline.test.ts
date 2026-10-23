import { expect, test } from 'claude-code/testing'

import { NO_CONTEXT, chatContext, fillPlaceholders, inlineSuggestions, isVague, parseWordings, vagueRanges } from '../hooks/inline'

test('a vague word gets precise wordings in its own language', () => {
  const de = inlineSuggestions('besser')
  expect(de.length).toBe(3)
  expect(de[0]?.text).toBe('schneller (Ziel: <Zeit>)')
  const en = inlineSuggestions('Better,')
  expect(en[0]?.text).toBe('faster (target: <time>)')
  expect(inlineSuggestions('Panel').length).toBe(0)
})

test('vague words are found where they stand', () => {
  const text = 'Mach das Panel irgendwie schöner'
  expect(vagueRanges(text)).toEqual([
    { start: 15, end: 24 },
    { start: 25, end: 32 },
  ])
  expect(isVague('Stuff')).toBe(true)
  expect(isVague('register')).toBe(false)
})

test('the chat names its files and code names, newest first', () => {
  const ctx = chatContext(['Look at hooks/register.tsx and `refreshRecent`', 'Now src\\app.ts and logic.ts with fmtGain'])
  expect(ctx.files).toEqual(['logic.ts', 'src/app.ts', 'hooks/register.tsx'])
  expect(ctx.names).toEqual(['fmtGain', 'refreshRecent'])
})

test('place placeholders are filled from the chat, others stay', () => {
  const ctx = { files: ['hooks/register.tsx'], names: [] }
  expect(fillPlaceholders('Speicherbedarf senken in <Datei/Funktion>', ctx)).toBe('Speicherbedarf senken in hooks/register.tsx')
  expect(fillPlaceholders('alle Dateien in <Ordner>', ctx)).toBe('alle Dateien in hooks')
  expect(fillPlaceholders('schneller (Ziel: <Zeit>)', ctx)).toBe('schneller (Ziel: <Zeit>)')
  expect(fillPlaceholders('nur <Datei>', NO_CONTEXT)).toBe('nur <Datei>')
  expect(inlineSuggestions('optimieren', ctx)[1]?.text).toBe('Speicherbedarf senken in hooks/register.tsx')
})

test("Haiku's reply becomes up to three clean rows", () => {
  const rows = parseWordings('1. übersichtlicher in register.tsx\n- „kompakter“\n\nschneller\nnoch eine')
  expect(rows.map(r => r.text)).toEqual(['übersichtlicher in register.tsx', 'kompakter', 'schneller'])
})
