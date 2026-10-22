import { expect, test } from 'claude-code/testing'

import { inlineSuggestions, isVague, vagueRanges } from '../hooks/inline'

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
