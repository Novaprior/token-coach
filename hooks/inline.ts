// Inline prompt help: vague words in the draft, and precise wordings to put
// in their place. Local rules only; no tokens spent.

export type InlineSuggestion = { text: string; label?: string; description: string }

type Fix = [text: string, description: string]

const DE_BETTER: Fix[] = [
  ['schneller (Ziel: <Zeit>)', 'messbar: wie schnell?'],
  ['lesbarer (kürzere Funktionen, klare Namen)', 'was genau soll lesbarer werden?'],
  ['robuster (Fehler abfangen bei <Fall>)', 'welcher Fehlerfall?'],
]
const DE_NICER: Fix[] = [
  ['übersichtlicher (Gruppen, Überschriften, Abstände)', 'welcher Teil der Oberfläche?'],
  ['moderner (Schrift, Farben, Abstände wie <Vorbild>)', 'woran orientieren?'],
  ['einheitlicher (gleiche Abstände und Farben in <Bereich>)', 'wo genau?'],
]
const DE_OPTIMIZE: Fix[] = [
  ['Ladezeit senken auf unter <ms> ms', 'Ziel als Zahl'],
  ['Speicherbedarf senken in <Datei/Funktion>', 'Ort nennen'],
  ['Tokenverbrauch senken bei <Aufgabe>', 'wofür?'],
]
const DE_FIX: Fix[] = [
  ['behebe den Fehler „<Meldung>“ in <Datei:Zeile>', 'Fehlermeldung und Ort'],
  ['behebe, dass <was passiert> statt <was passieren soll>', 'Ist und Soll'],
]
const EN_BETTER: Fix[] = [
  ['faster (target: <time>)', 'measurable: how fast?'],
  ['more readable (shorter functions, clear names)', 'what exactly?'],
  ['more robust (handle errors when <case>)', 'which failure case?'],
]
const EN_NICER: Fix[] = [
  ['clearer (groups, headings, spacing)', 'which part of the UI?'],
  ['more modern (type, colours, spacing like <reference>)', 'what to follow?'],
  ['more consistent (same spacing and colours in <area>)', 'where exactly?'],
]
const EN_OPTIMIZE: Fix[] = [
  ['cut load time to under <ms> ms', 'target as a number'],
  ['reduce memory use in <file/function>', 'name the place'],
  ['reduce token use for <task>', 'for what?'],
]
const EN_FIX: Fix[] = [
  ['fix the error "<message>" in <file:line>', 'error message and place'],
  ['fix that <what happens> instead of <what should happen>', 'actual and expected'],
]

const FIXES: Record<string, Fix[]> = {
  besser: DE_BETTER,
  verbessern: DE_BETTER,
  verbessere: DE_BETTER,
  schöner: DE_NICER,
  schoener: DE_NICER,
  hübscher: DE_NICER,
  optimieren: DE_OPTIMIZE,
  optimiere: DE_OPTIMIZE,
  optimiert: DE_OPTIMIZE,
  fixe: DE_FIX,
  fixen: DE_FIX,
  repariere: DE_FIX,
  reparieren: DE_FIX,
  irgendwie: [
    ['mit <Methode oder Bibliothek>', 'wie genau?'],
    ['so, dass <Ergebnis>', 'woran erkennt man es?'],
  ],
  irgendwas: [['<was genau>', 'konkret benennen']],
  etwas: [['<was genau>', 'konkret benennen']],
  alles: [
    ['alle Dateien in <Ordner>', 'Umfang eingrenzen'],
    ['nur <Datei>', 'Umfang eingrenzen'],
  ],
  better: EN_BETTER,
  improve: EN_BETTER,
  nicer: EN_NICER,
  prettier: EN_NICER,
  optimize: EN_OPTIMIZE,
  optimise: EN_OPTIMIZE,
  fix: EN_FIX,
  somehow: [
    ['using <method or library>', 'how exactly?'],
    ['so that <result>', 'how to tell?'],
  ],
  something: [['<what exactly>', 'name it']],
  stuff: [['<what exactly>', 'name it']],
  everything: [
    ['all files in <folder>', 'narrow the scope'],
    ['only <file>', 'narrow the scope'],
  ],
}

function bare(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
}

export function isVague(word: string): boolean {
  return bare(word) in FIXES
}

// Where vague words stand in a draft, to underline them.
export function vagueRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const m of text.matchAll(/[\p{L}]+/gu)) {
    if (m.index !== undefined && isVague(m[0])) ranges.push({ start: m.index, end: m.index + m[0].length })
  }

  return ranges
}

// What the recent conversation is about: the files it names, newest first,
// and the code names it mentions. Fills the placeholders of a wording.
export type ChatContext = { files: string[]; names: string[] }

export const NO_CONTEXT: ChatContext = { files: [], names: [] }

const FILE = /(?:[\w.-]+[\\/])*[\w-]+\.(?:tsx?|jsx?|mjs|py|md|json|css|scss|html|ya?ml|toml|sql|sh|ps1|cs|java|go|rs|rb|php|vue|svelte)\b/g
const NAME = /`([A-Za-z_][\w.]{2,40})`|\b([a-z]+[A-Z]\w{2,40})\b/g

function newestFirst(found: string[], max: number): string[] {
  return [...new Set(found.reverse())].slice(0, max)
}

export function chatContext(texts: readonly string[]): ChatContext {
  const all = texts.join('\n')
  const files = newestFirst([...all.matchAll(FILE)].map(m => m[0].replace(/\\/g, '/')), 3)
  const isFile = new RegExp(`^${FILE.source}$`)
  const names = newestFirst(
    [...all.matchAll(NAME)].map(m => m[1] ?? m[2] ?? '').filter(n => n && !isFile.test(n)),
    3,
  )

  return { files, names }
}

const FILE_SLOT = /<(Datei(?:\/Funktion|:Zeile)?|file(?:\/function|:line)?|Bereich|area)>/g
const FOLDER_SLOT = /<(Ordner|folder)>/g

// The wording with its place placeholders filled from the chat, where it
// names a file; every other placeholder stays for the person to fill.
export function fillPlaceholders(text: string, ctx: ChatContext): string {
  const file = ctx.files[0]
  if (!file) return text
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : undefined
  const filled = text.replace(FILE_SLOT, file)

  return folder ? filled.replace(FOLDER_SLOT, folder) : filled
}

export function inlineSuggestions(word: string, ctx: ChatContext = NO_CONTEXT): InlineSuggestion[] {
  const fixes = FIXES[bare(word)]
  if (!fixes) return []
  const lead = word.match(/^[^\p{L}]*/u)?.[0] ?? ''

  return fixes.map(([text, description]) => ({ text: lead + fillPlaceholders(text, ctx), description }))
}

export const CONTEXT_WORDING_SYSTEM =
  'You help write precise prompts for Claude Code. The user typed a vague word in their draft. ' +
  'Suggest up to 3 precise replacements for that word that fit the conversation and the draft: name the actual files, ' +
  'components or goals from the conversation where they fit. Each replacement is a short phrase (under 60 characters) ' +
  "in the draft's language that reads correctly in place of the word. Answer with the replacements only, one per line, " +
  'no numbering, no quotes, no explanation.'

export function contextWordingPrompt(word: string, draft: string, ctx: ChatContext, excerpt: string): string {
  return [
    `Files in the conversation: ${ctx.files.join(', ') || 'none'}`,
    `Names in the conversation: ${ctx.names.join(', ') || 'none'}`,
    `Recent conversation (excerpt):\n${excerpt || '(none)'}`,
    `Draft:\n${draft}`,
    `Vague word: ${word}`,
  ].join('\n\n')
}

// Haiku's answer as rows: one wording per line, trimmed of list marks.
export function parseWordings(reply: string): InlineSuggestion[] {
  return reply
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["„“”']|["„“”']$/g, '').trim())
    .filter(l => l.length > 0 && l.length <= 80)
    .slice(0, 3)
    .map(text => ({ text, description: 'fits this chat (Haiku)' }))
}
