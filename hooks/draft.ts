import type { DraftAnalysis, DraftCheck } from '../types'

// Live checks of the prompt being typed: local rules only, no tokens spent.

const STOPWORDS = new Set(
  (
    'aber alle alles also auch auf aus bei bin bis bitte dann das dass dein deine dem den der des die dies diese dieser doch dort durch eine einem einen einer eines etwas fuer für habe hast hat hier ich ihr ist jetzt kann kannst mal mehr mein meine mich mir mit muss nach nicht noch nur oder schon sein sich sie sind soll sollte und uns unter vom von vor war was wenn werden wie wieder will wir wird zum zur über ' +
    'about also and are but can could does for from have here into just like make more need not now only please should some than that the then there this what when which will with would your'
  ).split(' '),
)

export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[`"'„“”()[\]{}<>]/g, ' ')
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map(w => w.replace(/^[./-]+|[./-]+$/g, ''))
    .filter(w => w.length >= 4 && !STOPWORDS.has(w))

  return new Set(words)
}

const NEW_TOPIC = /\b(neues thema|anderes thema|anderes projekt|ganz was anderes|etwas anderes|vergiss (das|alles)|unabhängig davon|new topic|something else|unrelated)\b/i
// Words that point back at the conversation: a follow-up, not a new topic.
const FOLLOW_UP = /\b(auch|noch|nochmal|wieder|dazu|davon|daran|darin|dort|oben|unten|weiter|ebenfalls|again|too|as well|still|there)\b/i
const ACTION =
  /\b(erstell|bau|fix|behebe|änder|ander|füg|schreib|prüf|erklär|implementier|entfern|lösch|refactor|teste|ergänz|optimier|ersetz|verschieb|benenn|zeig|add|fix|create|build|write|remove|explain|update|rename|refactor|test|check|review)/i
const LOCATION = /([\w-]+\.(tsx?|jsx?|py|md|json|css|scss|html|ya?ml|toml|sql|sh|ps1|cs|java|go|rs|rb|php|vue|svelte))|[\w-]+\/[\w./-]+|\\[\w.\\-]+|:\d+\b|`[^`]+`/i
const DONE = /\b(sodass|so dass|damit|fertig,? wenn|erwartet|ergebnis|soll(te)? (danach|dann)|akzeptanz|test(s)? (laufen|grün|bestehen)|expected|should|until|done when)\b/i
const VAGUE = /\b(irgendwie|irgendwas|besser machen|schöner machen|alles|etwas|bisschen|halt|mal eben|optimieren|verbessern|somehow|something|stuff|make it better|make it nicer|improve it|a bit)\b/i
const MULTI = /(\n\s*[-*•]\s|\n\s*\d+[.)]\s|\b(außerdem|zusätzlich|und dann|danach noch|also noch|and then|additionally)\b)/gi

export type DraftContext = {
  percent?: number
  tokens?: number
  compactAt: number
  // Keywords of the conversation's recent messages, and how many there are.
  recent: Set<string>
  messageCount: number
  // Time since the last turn ended, when there was one.
  idleMs?: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function checklist(text: string): DraftCheck[] {
  const checks: DraftCheck[] = [
    { id: 'goal', label: 'A clear goal (what should happen?)', state: ACTION.test(text) || text.includes('?') ? 'ok' : 'missing' },
    { id: 'where', label: 'A place (file, path, line)', state: LOCATION.test(text) ? 'ok' : 'missing' },
    { id: 'done', label: 'How to tell it is done', state: DONE.test(text) ? 'ok' : 'missing' },
  ]
  const vague = text.match(VAGUE)
  if (vague) checks.push({ id: 'vague', label: `Vague: say “${vague[0]}” more precisely`, state: 'warn' })
  const tasks = (text.match(MULTI) ?? []).length
  if (tasks >= 2) checks.push({ id: 'multi', label: 'Several tasks: split them or bundle on purpose', state: 'warn' })
  if (text.length > 3000) checks.push({ id: 'paste', label: 'Long text: cut it to the lines needed or name the file path', state: 'warn' })

  return checks
}

// Whether this prompt belongs in this chat. A new chat pays off when the
// topic changed (nothing in common with the recent messages, or said so):
// every request then leaves the old context behind.
export function analyzeDraft(text: string, ctx: DraftContext): DraftAnalysis {
  const analysis: DraftAnalysis = { tokens: estimateTokens(text), checks: checklist(text) }
  const contextTokens = ctx.tokens ?? 0
  if (ctx.messageCount < 2 || contextTokens < 15_000) return analysis

  const words = keywords(text)
  let shared = 0
  for (const w of words) if (ctx.recent.has(w)) shared++
  const overlap = words.size === 0 ? 1 : shared / words.size
  const saysNew = NEW_TOPIC.test(text)
  // Off topic needs a substantial draft, almost nothing in common, no word
  // pointing back, and enough context that leaving it behind pays off.
  const isOffTopic = words.size >= 6 && overlap < 0.1 && !FOLLOW_UP.test(text) && contextTokens >= 30_000
  const isStale = ctx.idleMs !== undefined && ctx.idleMs > 60 * 60_000 && (ctx.percent ?? 0) >= 40

  if (saysNew || isOffTopic || isStale) {
    analysis.advice = 'newChat'
    analysis.reason = saysNew
      ? 'You announce a new topic.'
      : isOffTopic
        ? 'The draft has little to do with this chat.'
        : 'Over an hour since the last answer: the cache expired, the old history would be processed again.'
    analysis.savingPerRequest = contextTokens

    return analysis
  }
  if (ctx.percent !== undefined && ctx.percent >= ctx.compactAt) {
    analysis.advice = 'compactFirst'
    analysis.reason = `The context is ${ctx.percent} % full.`
    analysis.savingPerRequest = Math.max(0, contextTokens - Math.min(12_000, Math.max(2_000, contextTokens * 0.1)))
  }

  return analysis
}

export const IMPROVE_SYSTEM =
  'You improve prompts for Claude Code. Rewrite the user\'s prompt to be more precise and concise, in the user\'s language. ' +
  'Keep every fact, file path, name and requirement. Where it helps, structure it as: Goal, Where, Requirements, Done when. ' +
  'Invent nothing; where something is missing, put a placeholder in angle brackets. Answer with the improved prompt only.'

export const TEMPLATES: { id: string; label: string; text: string }[] = [
  { id: 'bugfix', label: 'Bug fix', text: 'Bug: <what happens>\nExpected: <what should happen>\nWhere: <file:line>\nTo reproduce: <steps>\nDone when: <test or observation>' },
  { id: 'feature', label: 'Feature', text: 'Goal: <what to build>\nWhere: <files or area>\nRequirements:\n- <…>\nDone when: <…>\nDo not change: <…>' },
  { id: 'refactor', label: 'Refactoring', text: 'Refactor <file or function>\nGoal: <more readable, faster, …>\nBehavior stays the same, tests: <command>\nScope: only <…>' },
  { id: 'review', label: 'Review', text: 'Review <file or change> for <bugs, security, readability>.\nAnswer as a short list: place, problem, suggestion.' },
  { id: 'explain', label: 'Explain', text: 'Explain <file or concept> in at most 5 sentences.\nFor: <audience>\nExplain only, change nothing.' },
]
