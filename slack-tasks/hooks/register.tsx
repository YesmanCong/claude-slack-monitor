import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SlackTask } from '../types'

const POLL_MS = 3000
const VISIBLE_ROWS = 5
const NOTIFY_TITLE = 'Slack 监控'

const tasks = atom({ plugin: 'slack-tasks', key: 'tasks' } as const, [])
const isExpanded = atom({ plugin: 'slack-tasks', key: 'isExpanded' } as const, false)
const firstVisibleRow = atom({ plugin: 'slack-tasks', key: 'firstVisibleRow' } as const, 0)

async function resolveTasksPath($: EngineInterface) {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${configDir}/slack-tasks.json`
}

async function loadTasks($: EngineInterface): Promise<SlackTask[]> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(await resolveTasksPath($)))
    return Array.isArray(parsed) ? (parsed as SlackTask[]) : []
  } catch {
    return []
  }
}

// The hook lets a running task into the list only once it has outlasted a quick answer.
async function loadListedTasks($: EngineInterface) {
  const now = await $.clock.now()
  return (await loadTasks($)).filter(task => task.ended !== undefined || now >= (task.listed_from_ms ?? 0))
}

async function dropTasks($: EngineInterface, isDropped: (task: SlackTask) => boolean) {
  // shortcut: read-modify-write on the file the monitor session's hook also writes, so a removal in the same instant as a task start or end can undo it; give removals a file of their own if that shows up.
  const kept = (await loadTasks($)).filter(task => !isDropped(task))
  await $.fs.write(await resolveTasksPath($), JSON.stringify(kept))
  const listed = await loadListedTasks($)
  await update($, tasks, () => listed)
}

function nameTask(task: SlackTask) {
  return task.sender === undefined ? task.title : `${task.sender}：${task.title}`
}

function announce(task: SlackTask) {
  return `${task.ended === undefined ? '开始处理' : '处理完'}：${nameTask(task)}`
}

async function notify($: EngineInterface, task: SlackTask) {
  const text = [announce(task), task.ended === undefined ? undefined : task.summary].filter(Boolean).join('\n')
  try {
    const sent = await $.ui.notify(text, { title: NOTIFY_TITLE })
    if (!sent.isSent) $.ui.toast(`系统通知没发出去：${sent.reason}`)
  } catch {
    $.ui.toast('系统通知被拦下了')
  }
}

export const register: Register = on => {
  // Every session follows the task file, so the list and the toasts show wherever the person is working.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const sessionId = await $.session.id()
    let seen: Map<string, string> | undefined
    const follow = async () => {
      const current = await loadListedTasks($)
      const known = seen
      const phases = new Map(current.map(task => [task.id, task.ended ?? '']))
      seen = phases
      // The first read only takes stock: what was already there is announced by nobody.
      const changed = known === undefined ? [] : current.filter(task => known.get(task.id) !== phases.get(task.id))
      if (known !== undefined && known.size === phases.size && changed.length === 0) return
      await update($, tasks, () => current)
      for (const task of changed) {
        if (task.quiet) continue
        $.ui.toast(announce(task))
        // The session doing the work raises the notification, so it arrives once however many sessions are open.
        if (task.session_id === sessionId) await notify($, task)
      }
    }
    await follow()
    $.clock.every(POLL_MS, () => void follow())

    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const newestFirst = [...(await read($, tasks))].reverse()
    if (e.props.hasSurvey || newestFirst.length === 0) return next(e)

    const expanded = await read($, isExpanded)
    const running = newestFirst.filter(task => task.ended === undefined)
    const endedCount = newestFirst.length - running.length
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // bodyColumns counts terminal cells; a graphical surface lays the row out to its own width.
    const width = e.surface === 'terminal' ? e.props.bodyColumns : undefined
    const toggle = (
      <Button key="toggle" plain onPress={() => update($, isExpanded, value => !value)}>
        {expanded ? '▾' : '▸'} slack
      </Button>
    )
    const counts = (
      <Text dimColor>
        处理中 {running.length} · 已完成 {endedCount}
      </Text>
    )

    if (!expanded) {
      const current = running[0]

      return (
        <Box flexDirection="row" alignItems="center" gap="md" width={width}>
          {toggle}
          {current?.sender !== undefined && <Text>{current.sender}</Text>}
          {current !== undefined && (
            <Text dimColor={current.sender !== undefined} wrap="truncate-end">
              {current.title}
            </Text>
          )}
          <Box flexGrow={1} />
          {counts}
        </Box>
      )
    }

    // A Box has no vertical scroll, so the list is a window of VISIBLE_ROWS rows that the two arrows move.
    const lastStart = Math.max(0, newestFirst.length - VISIBLE_ROWS)
    const start = Math.min(await read($, firstVisibleRow), lastStart)
    const visible = newestFirst.slice(start, start + VISIBLE_ROWS)
    const move = (rows: number) =>
      update($, firstVisibleRow, value => Math.max(0, Math.min(Math.min(value, lastStart) + rows, lastStart)))

    return (
      <Box flexDirection="column" gap="sm" width={width}>
        <Box flexDirection="row" alignItems="center" gap="md">
          {toggle}
          <Box flexGrow={1} />
          {counts}
          {lastStart > 0 && (
            <Text dimColor>
              {start + 1}–{start + visible.length} / {newestFirst.length}
            </Text>
          )}
          {lastStart > 0 && <Button key="rows-up" plain label="▲" onPress={() => move(-VISIBLE_ROWS)} />}
          {lastStart > 0 && <Button key="rows-down" plain label="▼" onPress={() => move(VISIBLE_ROWS)} />}
          {endedCount > 0 && (
            <Button key="clear" plain label="清空已完成" onPress={() => dropTasks($, task => task.ended !== undefined)} />
          )}
        </Box>
        {visible.map(task => (
          <Box flexDirection="row" alignItems="center" gap="md" paddingLeft="md">
            {task.sender !== undefined && <Text>{task.sender}</Text>}
            <Text dimColor={task.sender !== undefined} wrap="truncate-end">
              {task.title}
            </Text>
            <Box flexGrow={1} />
            {task.ended !== undefined ? (
              <Text dimColor>已完成 · {task.ended}</Text>
            ) : task.handed_at !== undefined ? (
              <Text color="claude">已转给别的会话 · {task.handed_at}</Text>
            ) : (
              <Text color="claude">处理中 · {task.started}</Text>
            )}
            {task.permalink !== undefined && <Link href={task.permalink} label="原文" />}
            {/* A task handed to a session that never reports back would stay open for good, so it can be removed by hand. */}
            {(task.ended !== undefined || task.handed_at !== undefined) && (
              <Button key={`remove-${task.id}`} plain onPress={() => dropTasks($, one => one.id === task.id)}>
                <Text dimColor>移除</Text>
              </Button>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
