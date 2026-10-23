export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  costUsd?: number
}

export type CoachSettings = {
  showCompact: boolean
  showLimits: boolean
  useBand: boolean
  useToasts: boolean
  compactAt: number
  limitWarnAt: number
  expectedTurns: number
  showDraft: boolean
  showHelper: boolean
  showInline: boolean
  // Inline wordings fitted to the chat by Claude Haiku; costs a few tokens each.
  smartInline: boolean
  aboUsd: number
}

export type LastCompact = { before?: number; after?: number }

export type Tab = 'overview' | 'prompt' | 'costs' | 'settings'

// Tokens are net of what the compactions cost; usd is undefined until the
// session's cost ledger gave a rate to price them with.
export type Savings = {
  tokens: number
  usd?: number
  compactions: number
  requests: number
  // Extra working time before the 5-hour limit, in ms.
  timeMs?: number
  since?: string
}

export type DraftCheck = { id: string; label: string; state: 'ok' | 'missing' | 'warn' }

export type DraftAdvice = 'newChat' | 'compactFirst'

export type DraftAnalysis = {
  tokens: number
  advice?: DraftAdvice
  reason?: string
  savingPerRequest?: number
  checks: DraftCheck[]
}

// A vague word just typed, where it stands, and precise wordings for it.
export type InlineHint = { start: number; end: number; word: string; options: string[] }

export type Suggestion = { status: 'loading' | 'done' | 'error'; text?: string; note?: string }

// What requests cost at API prices, as the session's cost ledger counts it.
export type Costs = { usd: number; tokens: number }

export type CostBook = { total: Costs; months: Record<string, Costs>; since?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-coach': {
      snapshot: Snapshot | null
      prefs: CoachSettings
      tab: Tab
      isCompacting: boolean
      notice: string | null
      lastCompact: LastCompact | null
      bandDismissedAt: number | null
      sessionSavings: Savings
      allTimeSavings: Savings
      perRequest: number
      draft: DraftAnalysis | null
      suggestion: Suggestion | null
      inlineHint: InlineHint | null
      draftDismissed: string | null
      sessionCosts: Costs
      costBook: CostBook
    }
  }
}
