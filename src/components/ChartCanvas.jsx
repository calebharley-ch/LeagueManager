import { useEffect, useRef } from 'react'
import { Chart, applyChartTheme } from '../lib/chartTheme'

/**
 * A Chart.js chart as a React component.
 *
 * ⚠️ DESTROYS THE PREVIOUS INSTANCE ON EVERY CHANGE. Chart.js binds to a canvas
 * and refuses to attach a second chart to one already in use — in React's dev
 * StrictMode, which mounts effects twice, skipping this throws
 * "Canvas is already in use" and the chart never renders.
 */
export default function ChartCanvas({ type, data, options, height = 260, label }) {
  const ref = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    applyChartTheme()
    if (!ref.current) return

    chartRef.current?.destroy()
    chartRef.current = new Chart(ref.current, { type, data, options })

    return () => {
      chartRef.current?.destroy()
      chartRef.current = null
    }
  }, [type, data, options])

  return (
    <div style={{ height }} className="relative">
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  )
}
