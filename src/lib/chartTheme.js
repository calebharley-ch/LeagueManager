import { Chart } from 'chart.js/auto'

/**
 * One place that makes Chart.js look like the rest of the app.
 *
 * The source page styled every chart inline, so a palette change meant editing
 * 29 of them. Applied once here as defaults instead — any chart rendered
 * anywhere in the app inherits it.
 *
 * Called for its side effect on Chart.defaults, so it must run before the first
 * chart is constructed.
 */
let applied = false

export function applyChartTheme() {
  if (applied) return
  applied = true

  Chart.defaults.color = '#94a3b8'                    // slate-400
  Chart.defaults.borderColor = 'rgba(148,163,184,.12)'
  Chart.defaults.font.family =
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
  Chart.defaults.font.size = 11
  Chart.defaults.maintainAspectRatio = false
  Chart.defaults.animation = { duration: 350 }

  Chart.defaults.plugins.legend.labels.usePointStyle = true
  Chart.defaults.plugins.legend.labels.boxWidth = 8
  Chart.defaults.plugins.legend.labels.padding = 12

  Chart.defaults.plugins.tooltip.backgroundColor = '#0f172a'   // slate-900
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(148,163,184,.2)'
  Chart.defaults.plugins.tooltip.borderWidth = 1
  Chart.defaults.plugins.tooltip.titleColor = '#f1f5f9'
  Chart.defaults.plugins.tooltip.bodyColor = '#cbd5e1'
  Chart.defaults.plugins.tooltip.padding = 10
  Chart.defaults.plugins.tooltip.displayColors = true
  Chart.defaults.plugins.tooltip.cornerRadius = 8
}

/** The app's accent, for single-series charts. */
export const ACCENT = '#10b981'          // emerald-500
export const ACCENT_SOFT = 'rgba(16,185,129,.25)'

export { Chart }
