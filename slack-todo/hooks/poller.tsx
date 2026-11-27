import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PollerStatus, TodayActivity } from '../types'
import { FILTERED_COLOR, PUSHED_COLOR, SENT_COLOR, buildHourlyChart } from './chart'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

// slack_poller.py serves its settings page and the two JSON answers read here.
const POLLER_URL = 'http://127.0.0.1:8765'
const POLL_MS = 15000

// null: the poller did not answer, so it is not running.
const poller = atom({ plugin: 'slack-todo', key: 'poller' } as const, null)
const today = atom({ plugin: 'slack-todo', key: 'today' } as const, null)

async function fetchJson($: EngineInterface, path: string): Promise<unknown> {
  const response = await $.http.fetch(`${POLLER_URL}${path}`)
  if (!response.ok) throw new Error(`poller answered ${response.status}`)
  return JSON.parse(response.text)
}

async function loadPollerStatus($: EngineInterface): Promise<PollerStatus | null> {
  try {
    const status = (await fetchJson($, '/status.json')) as PollerStatus | null
    return typeof status?.state === 'string' ? status : null
  } catch {
    return null
  }
}

async function loadTodayActivity($: EngineInterface): Promise<TodayActivity | null> {
  try {
    const activity = (await fetchJson($, '/activity.json?days=1')) as TodayActivity | null
    return Array.isArray(activity?.by_time) && typeof activity?.totals === 'object' ? activity : null
  } catch {
    return null
  }
}

export async function followPoller($: EngineInterface) {
  let seen = ''
  const follow = async () => {
    const [status, activity] = await Promise.all([loadPollerStatus($), loadTodayActivity($)])
    const snapshot = JSON.stringify([status, activity])
    if (snapshot === seen) return
    seen = snapshot
    await update($, poller, () => status)
    await update($, today, () => activity)
  }
  await follow()
  $.clock.every(POLL_MS, () => void follow())
}

// "2026-11-27 17:01:05" as the poller writes it.
function readClock(stamp: string | null) {
  return stamp === null ? '还没有' : stamp.slice(11, 16)
}

export async function drawPollerStatus($: EngineInterface, { Box, Text }: Elements) {
  const status = await read($, poller)
  if (status === null) {
    return (
      <Box flexDirection="column" gap="xs" padding="md" borderStyle="round" borderColor="error">
        <Text color="error" weight="semibold">
          ● poller 没在跑
        </Text>
        <Text size="footnote">新消息收不到，也推不给 Claude。在监控会话里说一声「重启 poller」就能拉起来。</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap="xs" padding="md" borderStyle="round" borderColor="subtle">
      <Box gap="sm" alignItems="center">
        <Text color="success" weight="semibold">
          ● poller 在跑
        </Text>
        {status.state === 'connected' ? (
          <Text dimColor>已连上 Slack</Text>
        ) : (
          <Text color="warning">{status.needs_login ? '要重新登录 Slack' : '正在连 Slack'}</Text>
        )}
      </Box>
      <Text dimColor size="footnote">
        最后收到 {readClock(status.last_item)} · 最后推给 Claude {readClock(status.last_push)}
      </Text>
      {status.last_error !== null && (
        <Text color="warning" size="footnote">
          {status.last_error}
        </Text>
      )}
    </Box>
  )
}

export async function drawToday($: EngineInterface, elements: Elements) {
  const activity = await read($, today)
  if (activity === null) return undefined
  const { Box, Text } = elements
  // The terminal draws no Svg; there the three totals stand alone.
  const Svg = 'Svg' in elements ? elements.Svg : undefined
  const chart = Svg === undefined ? undefined : buildHourlyChart(activity)

  return (
    <Box flexDirection="column" gap="sm">
      <Text dimColor size="footnote">
        今天
      </Text>
      <Box gap="sm">
        {(
          [
            ['收到', activity.totals.received],
            ['推给 Claude', activity.totals.pushed],
            ['代发', activity.totals.sent],
          ] as const
        ).map(([label, count]) => (
          <Box flexDirection="column" flexGrow={1} padding="sm" borderStyle="round" borderColor="subtle">
            <Text size="heading" weight="semibold">
              {String(Number(count) || 0)}
            </Text>
            <Text dimColor size="footnote">
              {label}
            </Text>
          </Box>
        ))}
      </Box>
      {Svg !== undefined && chart !== undefined && <Svg source={chart.source} alt={chart.alt} />}
      {chart !== undefined && (
        <Box gap="md" flexWrap="wrap">
          {(
            [
              [PUSHED_COLOR, '推给 Claude'],
              [FILTERED_COLOR, '被过滤'],
              [SENT_COLOR, '代发'],
            ] as const
          ).map(([color, label]) => (
            <Box gap="xs" alignItems="center">
              <Text color={color} size="footnote">
                ■
              </Text>
              <Text dimColor size="footnote">
                {label}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
