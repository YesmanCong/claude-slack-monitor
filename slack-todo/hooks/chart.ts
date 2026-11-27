import type { TodayActivity } from '../types'

export const PUSHED_COLOR = '#2A78D6'
export const FILTERED_COLOR = '#8E8C86'
export const SENT_COLOR = '#EB6834'
// The drawing is an image, outside the app's theme: a mid grey reads on a light and on a dark surface alike.
const AXIS_COLOR = '#8A8883'

const WIDTH = 360
const PLOT_TOP = 6
const PLOT_HEIGHT = 100
const HEIGHT = 126
const FIRST_WORK_HOUR = 8
const LAST_WORK_HOUR = 20

// The poller's JSON is text from outside this module; only a number from it reaches the markup.
function toCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function drawBar(x: number, width: number, bottom: number, height: number, color: string) {
  if (height <= 0) return ''
  return `<rect x="${x.toFixed(1)}" y="${(bottom - height).toFixed(1)}" width="${width}" height="${height.toFixed(1)}" rx="2" fill="${color}"/>`
}

// Today's messages by hour: what was received, split into pushed to Claude and filtered, beside what Claude sent. One scale for both columns.
export function buildHourlyChart(today: TodayActivity): { source: string; alt: string } | undefined {
  const hours = today.by_time.map(hour => ({
    hour: Number(hour.slot),
    pushed: toCount(hour.pushed),
    filtered: toCount(hour.filtered),
    sent: toCount(hour.sent),
  }))
  const active = hours.filter(hour => hour.pushed + hour.filtered + hour.sent > 0)
  const first = active[0]
  const last = active[active.length - 1]
  if (first === undefined || last === undefined) return undefined

  const from = Math.min(FIRST_WORK_HOUR, first.hour)
  const to = Math.max(LAST_WORK_HOUR, last.hour)
  const shown = hours.filter(hour => hour.hour >= from && hour.hour <= to)
  const busiest = shown.reduce((most, hour) => (hour.pushed + hour.filtered > most.pushed + most.filtered ? hour : most))
  const scaleTop = Math.max(10, Math.ceil(Math.max(busiest.pushed + busiest.filtered, ...shown.map(hour => hour.sent)) / 10) * 10)
  const unit = PLOT_HEIGHT / scaleTop
  const baseline = PLOT_TOP + PLOT_HEIGHT
  const slotWidth = WIDTH / shown.length

  const gridLines = [scaleTop / 2, scaleTop]
    .map(count => {
      const y = (baseline - count * unit).toFixed(1)
      return `<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="${AXIS_COLOR}" stroke-opacity="0.3"/><text x="0" y="${(Number(y) - 2).toFixed(1)}" font-size="9" fill="${AXIS_COLOR}">${count}</text>`
    })
    .join('')
  const columns = shown
    .map((hour, index) => {
      const left = index * slotWidth + slotWidth / 2 - 9
      const pushedHeight = hour.pushed * unit
      // A 2px gap keeps the two parts of the received column apart.
      const filteredBottom = baseline - pushedHeight - (pushedHeight > 0 ? 2 : 0)
      const label =
        hour.hour % 2 === 0
          ? `<text x="${(index * slotWidth + slotWidth / 2).toFixed(1)}" y="${HEIGHT - 4}" font-size="10" text-anchor="middle" fill="${AXIS_COLOR}">${hour.hour}</text>`
          : ''
      return (
        drawBar(left, 10, baseline, pushedHeight, PUSHED_COLOR) +
        drawBar(left, 10, filteredBottom, hour.filtered * unit, FILTERED_COLOR) +
        drawBar(left + 12, 6, baseline, hour.sent * unit, SENT_COLOR) +
        label
      )
    })
    .join('')

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="sans-serif">${gridLines}<line x1="0" y1="${baseline}" x2="${WIDTH}" y2="${baseline}" stroke="${AXIS_COLOR}"/>${columns}</svg>`,
    alt: `今天每小时的消息数：${busiest.hour} 点收到最多，共 ${busiest.pushed + busiest.filtered} 条，其中 ${busiest.pushed} 条推给了 Claude`,
  }
}
