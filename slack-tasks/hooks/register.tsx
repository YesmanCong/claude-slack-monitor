import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SlackTask } from '../types'

const POLL_MS = 3000
const NOTIFY_TITLE = 'Slack 监控'

const tasks = atom({ plugin: 'slack-tasks', key: 'tasks' } as const, [])
const isExpanded = atom({ plugin: 'slack-tasks', key: 'isExpanded' } as const, false)

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

async function removeTask($: EngineInterface, id: string) {
  // shortcut: read-modify-write on the file the monitor session's hook also writes, so a removal in the same instant as a task start or end can undo it; give removals a file of their own if that shows up.
  const kept = (await loadTasks($)).filter(task => task.id !== id)
  await $.fs.write(await resolveTasksPath($), JSON.stringify(kept))
  await update($, tasks, () => kept)
}

function announce(task: SlackTask) {
  return `${task.ended === undefined ? '开始处理' : '处理完'}：${task.title}`
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
      const current = await loadTasks($)
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
    const list = await read($, tasks)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const expanded = await read($, isExpanded)
    const running = list.filter(task => task.ended === undefined)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // bodyColumns counts terminal cells; a graphical surface lays the row out to its own width.
    const width = e.surface === 'terminal' ? e.props.bodyColumns : undefined
    const header = (
      <Box flexDirection="row" alignItems="center" gap={1} width={width}>
        <Button key="toggle" plain onPress={() => update($, isExpanded, value => !value)}>
          {expanded ? '▾' : '▸'} slack
        </Button>
        {!expanded && running[0] !== undefined && <Text>{running[0].title}</Text>}
        <Box flexGrow={1} />
        <Text dimColor>
          处理中 {running.length} · 已完成 {list.length - running.length}
        </Text>
      </Box>
    )
    if (!expanded) return header

    return (
      <Box flexDirection="column">
        {header}
        {list.map(task => (
          <Box flexDirection="row" alignItems="center" gap={1} width={width}>
            <Text>{task.title}</Text>
            {task.permalink !== undefined && <Link href={task.permalink} label="原文" />}
            <Box flexGrow={1} />
            {task.ended === undefined ? (
              <Text color="claude">处理中 · {task.started} 开始</Text>
            ) : (
              <Text dimColor>已完成 · {task.ended}</Text>
            )}
            {task.ended !== undefined && (
              <Button key={`remove-${task.id}`} plain label="移除" onPress={() => removeTask($, task.id)} />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
