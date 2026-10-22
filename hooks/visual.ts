// SVG drawings for surfaces that render them (desktop, VS Code, mobile).
// They are drawn as images, so colors are fixed values chosen to read on
// both light and dark backgrounds.

export const COLORS = {
  success: '#2f9e6b',
  warning: '#d9902f',
  error: '#e5484d',
  neutral: '#8b8f98',
  track: 'rgba(128,128,128,0.22)',
  accent: '#6e7bf2',
} as const

const FONT = "-apple-system, 'Segoe UI', system-ui, sans-serif"

export type Tone = 'success' | 'warning' | 'error' | 'neutral'

// A ring gauge with the percentage in its middle.
export function ring(percent: number | undefined, tone: Tone, size = 76): string {
  const stroke = 8
  const r = (size - stroke) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r
  const value = percent === undefined ? 0 : Math.min(100, Math.max(0, percent))
  const dash = (value / 100) * circumference
  const color = COLORS[tone]
  const label = percent === undefined ? '–' : `${Math.round(value)}%`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${COLORS.track}" stroke-width="${stroke}"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>` +
    `<text x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="${size * 0.23}" font-weight="600" fill="${color}">${label}</text>` +
    `</svg>`
  )
}

// Two bars: the context now and after compacting, on the window's scale.
export function savingsBars(tokens: number, after: number, window: number, width = 280): string {
  const labelWidth = 56
  const room = width - labelWidth - 4
  const now = Math.max(2, (Math.min(tokens, window) / window) * room)
  const then = Math.max(2, (Math.min(after, window) / window) * room)
  const row = (y: number, label: string, w: number, color: string) =>
    `<text x="0" y="${y + 7}" dominant-baseline="central" font-family="${FONT}" font-size="11" fill="${COLORS.neutral}">${label}</text>` +
    `<rect x="${labelWidth}" y="${y}" width="${room}" height="14" rx="7" fill="${COLORS.track}"/>` +
    `<rect x="${labelWidth}" y="${y}" width="${w.toFixed(1)}" height="14" rx="7" fill="${color}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40" viewBox="0 0 ${width} 40">` +
    row(2, 'now', now, COLORS.warning) +
    row(23, 'after', then, COLORS.success) +
    `</svg>`
  )
}

// A text bar for the terminal, where no SVG is drawn.
export function textBar(percent: number, width = 18): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '━'.repeat(filled) + '╌'.repeat(width - filled)
}

export type ChartRow = { label: string; text: string; isTight: boolean }

export type LimitChart = {
  label: string
  percent: number
  tone: Tone
  // Where now sits in the window, and where the limit runs out first, as
  // 0..1 of the window's length; absent when the window's length is unknown.
  elapsed?: number
  exhaustAt?: number
  // One line per forecast: the window's average, the last half hour.
  rows: ChartRow[]
}

const ROW = 15

// One limit: a usage bar, beneath it the window as a timeline from its start
// to the reset with now marked and, when it runs out first, the wait until
// the reset in red; then a line per forecast.
export function limitChart(c: LimitChart, width = 260): string {
  const color = COLORS[c.tone]
  const text = (x: number, y: number, s: string, anchor = 'start', fill: string = COLORS.neutral, weight = 400) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="11" font-weight="${weight}" fill="${fill}">${s}</text>`
  const used = Math.max(0, Math.min(100, c.percent)) / 100
  let svg =
    text(0, 11, c.label) +
    text(width, 11, `${Math.round(c.percent)} %`, 'end', color, 600) +
    `<rect x="0" y="17" width="${width}" height="8" rx="4" fill="${COLORS.track}"/>` +
    `<rect x="0" y="17" width="${Math.max(4, used * width).toFixed(1)}" height="8" rx="4" fill="${color}"/>`
  let y = 30
  if (c.elapsed !== undefined) {
    const now = Math.max(0, Math.min(1, c.elapsed)) * width
    svg += `<rect x="0" y="33" width="${width}" height="3" rx="1.5" fill="${COLORS.track}"/>`
    svg += `<rect x="0" y="33" width="${now.toFixed(1)}" height="3" rx="1.5" fill="${COLORS.neutral}"/>`
    if (c.exhaustAt !== undefined) {
      const full = Math.max(0, Math.min(1, c.exhaustAt)) * width
      svg += `<rect x="${full.toFixed(1)}" y="33" width="${(width - full).toFixed(1)}" height="3" rx="1.5" fill="${COLORS.error}"/>`
    }
    svg += `<circle cx="${now.toFixed(1)}" cy="34.5" r="3.5" fill="${COLORS.neutral}"/>`
    y = 40
  }
  for (const row of c.rows) {
    y += ROW
    svg += text(0, y - 4, row.label)
    svg += text(width, y - 4, row.text, 'end', row.isTight ? COLORS.error : COLORS.neutral, row.isTight ? 600 : 400)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 2}" viewBox="0 0 ${width} ${y + 2}">${svg}</svg>`
}

export function limitChartHeight(c: LimitChart): number {
  return (c.elapsed !== undefined ? 40 : 30) + c.rows.length * ROW + 2
}
