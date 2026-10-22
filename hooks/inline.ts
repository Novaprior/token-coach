// Inline prompt help: precise wordings for vague words, and file paths from
// this chat, offered in the prompt box's typeahead for the word being typed.
// Local rules only; no tokens spent.

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

const FILE = /(?:[\w.-]+[\\/])*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|md|json|css|scss|html|ya?ml|toml|sql|sh|ps1|cs|java|go|rs|rb|php|vue|svelte|txt)\b/gi

// File paths named in a chat's messages, most recent last, without repeats.
export function extractFiles(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(FILE)) seen.add(m[0].replace(/\\\\/g, '\\'))

  return [...seen]
}

export function inlineSuggestions(token: string, files: readonly string[]): InlineSuggestion[] {
  const fixes = FIXES[bare(token)]
  if (fixes) {
    const lead = token.match(/^[^\p{L}]*/u)?.[0] ?? ''

    return fixes.map(([text, description]) => ({ text: lead + text, description }))
  }
  const typed = token.toLowerCase()
  if (typed.length < 3 || !/^[\w.\\/-]+$/.test(token)) return []
  const name = (path: string) => path.split(/[\\/]/).pop()?.toLowerCase() ?? ''

  return [...files]
    .reverse()
    .filter(f => f.toLowerCase() !== typed && (name(f).startsWith(typed) || f.toLowerCase().includes(typed)))
    .slice(0, 5)
    .map(f => ({ text: f, description: 'file from this chat' }))
}
