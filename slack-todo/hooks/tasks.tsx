import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SlackTask } from '../types'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const POLL_MS = 3000
const NOTIFY_TITLE = 'Slack 监控'

const tasks = atom({ plugin: 'slack-todo', key: 'tasks' } as const, [])

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

async function dropTasks($: EngineInterface, isDropped: (task: SlackTask) => boolean) {
  // shortcut: read-modify-write on the file the monitor session's hook also writes, so a removal in the same instant as a task start or end can undo it; give removals a file of their own if that shows up.
  const kept = (await loadTasks($)).filter(task => !isDropped(task))
  await $.fs.write(await resolveTasksPath($), JSON.stringify(kept))
  await update($, tasks, () => kept)
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

// Every session follows the task file, so the list and the toasts show wherever the person is working.
export async function followTasks($: EngineInterface) {
  const sessionId = await $.session.id()
  let seenPhases: Map<string, string> | undefined
  const follow = async () => {
    const current = await loadTasks($)
    const known = seenPhases
    const phases = new Map(current.map(task => [task.id, task.ended ?? '']))
    seenPhases = phases
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
}

export async function drawTasks($: EngineInterface, { Box, Text, Button, Link }: Elements) {
  const newestFirst = [...(await read($, tasks))].reverse()
  if (newestFirst.length === 0) return undefined
  const endedCount = newestFirst.filter(task => task.ended !== undefined).length

  return (
    <Box flexDirection="column" gap="sm">
      <Box gap="sm" alignItems="center">
        <Text dimColor size="footnote">
          任务 · 处理中 {newestFirst.length - endedCount} · 已完成 {endedCount}
        </Text>
        <Box flexGrow={1} />
        {endedCount > 0 && (
          <Button key="clear-tasks" plain onPress={() => dropTasks($, task => task.ended !== undefined)}>
            <Text dimColor size="footnote">
              清空已完成
            </Text>
          </Button>
        )}
      </Box>
      {newestFirst.map(task => (
        <Box flexDirection="column" gap="xs" padding="md" borderStyle="round" borderColor="subtle">
          <Box gap="sm" alignItems="center">
            <Text weight="semibold" wrap="truncate-end">
              {task.sender ?? task.title}
            </Text>
            <Box flexGrow={1} />
            {task.ended !== undefined ? (
              <Text dimColor size="footnote">
                已完成 · {task.ended}
              </Text>
            ) : (
              <Text color="claude" size="footnote">
                {task.handed_at === undefined ? `处理中 · ${task.started}` : `已转给别的会话 · ${task.handed_at}`}
              </Text>
            )}
          </Box>
          {task.sender !== undefined && <Text dimColor>{task.title}</Text>}
          {task.ended !== undefined && task.summary !== undefined && task.summary !== '' && (
            <Text size="footnote">{task.summary}</Text>
          )}
          <Box gap="md" alignItems="center">
            {task.permalink !== undefined && <Link href={task.permalink} label="原文" />}
            {/* A task handed to a session that never reports back would stay open for good, so it can be removed by hand. */}
            {(task.ended !== undefined || task.handed_at !== undefined) && (
              <Button key={`remove-task-${task.id}`} plain onPress={() => dropTasks($, one => one.id === task.id)}>
                <Text dimColor size="footnote">
                  移除
                </Text>
              </Button>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
