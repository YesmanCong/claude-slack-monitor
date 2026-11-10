import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Todo, TodoStatus } from '../types'

const PANE = 'slack-todo'
const TOOL = 'mcp__slack-todo__add_todo'
const RESOLVE_TOOL = 'mcp__slack-todo__resolve_todo'
const STORE_KEY = 'todos'
const HISTORY_LIMIT = 300
const TITLE_MAX = 40
const SUGGESTION_MAX = 120

const todos = atom({ plugin: 'slack-todo', key: 'todos' } as const, [], {
  shape: 'todos-1',
})
const revisingId = atom(
  { plugin: 'slack-todo', key: 'revisingId' } as const,
  null,
)
const expandedIds = atom(
  { plugin: 'slack-todo', key: 'expandedIds' } as const,
  [],
)

const TOOL_DESCRIPTION = `Put an item on the user's todo board instead of asking about it in chat.

Use it whenever you find something that needs the user's decision or action (a Slack message asking them for something, a review request, a question only they can answer). One call per item. The user picks one of three answers on the board:
- accept: you receive a prompt starting with "[待办看板] 按建议执行" — carry out the suggestion.
- revise: you receive a prompt starting with "[待办看板] 不按原建议" with the user's own instructions — follow those instead.
- ignore: nothing comes back; do not raise the item again.

The board is read at a glance, so keep the card short:
- title: at most ${TITLE_MAX} characters, who wants what ("PM 问老域名要不要加进 hostnames").
- suggestion: at most ${SUGGESTION_MAX} characters, the one action you will take on accept.
- detail: everything else the user may want before deciding (background, reasoning, session ids, risks), in Markdown; shown only when the user expands the card.
A title or suggestion over its limit is refused. Items are de-duplicated by \`source\`; a repeated source is refused with its current status. Write in Simplified Chinese.`

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      maxLength: TITLE_MAX,
      description: 'Who wants what from the user, one short line.',
    },
    source: {
      type: 'string',
      description:
        'Where it came from, unique per item: the Slack message permalink when there is one.',
    },
    suggestion: {
      type: 'string',
      maxLength: SUGGESTION_MAX,
      description: 'The one action you will take if the user accepts.',
    },
    detail: {
      type: 'string',
      description:
        'Optional Markdown: background, reasoning, ids and risks the user may want before deciding.',
    },
  },
  required: ['title', 'source', 'suggestion'],
} as const

const RESOLVE_DESCRIPTION = `Take a pending card off the user's todo board because it no longer needs them: the user already handled it elsewhere (answered the session directly, merged the PR themselves), or the thing it waited for happened. Nothing is sent back to you and the user is not asked.

Only resolve a card you have checked: the session's last turn no longer asks the same question, the PR is merged, the person replied. Pass the card's exact \`source\` and a short Chinese \`reason\` saying what you saw. A card that is not pending (already accepted, revised, ignored or resolved) is refused with its status.`

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description: 'The source the card was added with.',
    },
    reason: {
      type: 'string',
      description: 'What you checked that shows the user no longer needs to act, one short line.',
    },
  },
  required: ['source', 'reason'],
} as const

async function saveTodos($: EngineInterface, change: (list: Todo[]) => Todo[]) {
  const list = await update($, todos, change)
  await $.store.set(STORE_KEY, list)
}

async function decide(
  $: EngineInterface,
  todo: Todo,
  status: Exclude<TodoStatus, 'pending'>,
  prompt?: string,
) {
  await saveTodos($, list =>
    list.map(one => (one.id === todo.id ? { ...one, status } : one)),
  )
  await update($, revisingId, () => null)
  if (prompt !== undefined) {
    // submit resolves only when the queued turn starts, which waits for a busy session to go idle.
    void $.prompt.submit({ text: prompt, asUser: true })
  }
}

function describeTodo(todo: Todo) {
  const lines = [`来源：${todo.source}`, `建议：${todo.suggestion}`]
  if (todo.detail !== undefined) lines.push(`详情：\n${todo.detail}`)
  return lines.join('\n')
}

function acceptPrompt(todo: Todo) {
  return `[待办看板] 按建议执行：${todo.title}\n${describeTodo(todo)}`
}

function revisePrompt(todo: Todo, instructions: string) {
  return `[待办看板] 不按原建议，按我的方式执行：${todo.title}\n${describeTodo(todo)}\n我的执行方式：${instructions}`
}

function sessionIdOf(source: string) {
  return source.match(/^session:(local_[^/]+)\//)?.[1]
}

function archivePrompt(todo: Todo, sessionId: string) {
  return `[待办看板] 归档 session：${sessionId}\n卡片：${todo.title}\n来源：${todo.source}`
}

function clamp(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function labelSource(source: string): { href?: string; label: string } {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return { label: source }
  }
  if (url.protocol !== 'https:') return { label: source }
  if (url.hostname.endsWith('slack.com')) return { href: source, label: '在 Slack 中打开' }
  if (url.hostname === 'github.com') {
    const pr = url.pathname.match(/\/pull\/(\d+)/)
    return { href: source, label: pr ? `GitHub PR #${pr[1]}` : '在 GitHub 中打开' }
  }
  return { href: source, label: url.hostname }
}

function formatAge(createdAt: number, now: number) {
  const minutes = Math.floor((now - createdAt) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const current = await read($, todos)
    if (current.length === 0) {
      const stored = await $.store.get(STORE_KEY)
      if (Array.isArray(stored)) {
        await saveTodos($, () => stored as Todo[])
      }
    }
    await $.tool.register({
      name: 'add_todo',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'resolve_todo',
      description: RESOLVE_DESCRIPTION,
      inputSchema: RESOLVE_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'todo',
      description: '打开待办看板',
    })
    // Earlier versions pinned a plain-text status line; the footer button replaces it.
    $.ui.status(undefined)
    // /reload-plugins does not redraw the footer, so ask for it once the module is in.
    $.ui.invalidate('ui.render')
    void $.ui.open({ id: PANE, title: '待办' })

    return started
  })

  on('command.run', { command: 'todo' }, async $ => {
    await $.ui.open({ id: PANE, title: '待办' })

    return { text: '待办看板已打开。' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as {
      title?: unknown
      source?: unknown
      suggestion?: unknown
      detail?: unknown
    }
    const text = (field: unknown) => (typeof field === 'string' ? field.trim() : '')
    const title = text(input.title)
    const source = text(input.source)
    const suggestion = text(input.suggestion)
    const detail = text(input.detail)
    if (title === '' || source === '' || suggestion === '') {
      return { deny: 'title, source and suggestion are required non-empty strings.' }
    }
    if (title.length > TITLE_MAX || suggestion.length > SUGGESTION_MAX) {
      return {
        deny: `title is ${title.length}/${TITLE_MAX} and suggestion ${suggestion.length}/${SUGGESTION_MAX} characters. Shorten them and move the rest into detail.`,
      }
    }

    const existing = (await read($, todos)).find(todo => todo.source === source)
    if (existing !== undefined) {
      return { deny: `Already on the board (status: ${existing.status}): ${existing.title}` }
    }

    const createdAt = await $.clock.now()
    const todo: Todo = {
      id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      source,
      suggestion,
      ...(detail === '' ? {} : { detail }),
      status: 'pending',
      createdAt,
    }
    await saveTodos($, list => [...list, todo].slice(-HISTORY_LIMIT))
    $.ui.toast(`新待办：${title}`)

    return { result: `Added to the board: ${title}. Wait for the user's decision; do not ask about it in chat.` }
  })

  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    const input = e as unknown as { source?: unknown; reason?: unknown }
    const source = typeof input.source === 'string' ? input.source.trim() : ''
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (source === '' || reason === '') {
      return { deny: 'source and reason are required non-empty strings.' }
    }

    const existing = (await read($, todos)).find(todo => todo.source === source)
    if (existing === undefined) {
      return { deny: `No card with source ${source}.` }
    }
    if (existing.status !== 'pending') {
      return { deny: `Not pending (status: ${existing.status}): ${existing.title}` }
    }

    await saveTodos($, list =>
      list.map(one =>
        one.id === existing.id ? { ...one, status: 'resolved', resolution: reason } : one,
      ),
    )
    await update($, revisingId, id => (id === existing.id ? null : id))
    $.ui.toast(`已自动完成：${existing.title}`)

    return { result: `Resolved: ${existing.title}` }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engineModes = await next(e)
    const pending = (await read($, todos)).filter(todo => todo.status === 'pending').length
    if (pending === 0) return engineModes
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap="sm">
        <Button key="open-todo" plain onPress={() => $.ui.open({ id: PANE, title: '待办' })}>
          <Text color="claude">待办 {pending}</Text>
        </Button>
        {engineModes}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link, Markdown } = elements
    // The mobile surface has no Input, so revising is offered only where one can be typed.
    const Input = 'Input' in elements ? elements.Input : undefined
    const pending = (await read($, todos)).filter(todo => todo.status === 'pending')
    const revising = await read($, revisingId)
    const expanded = await read($, expandedIds)
    const now = await $.clock.now()

    if (pending.length === 0) {
      return (
        <Box padding="lg" borderStyle="round" borderColor="subtle" justifyContent="center">
          <Text dimColor>没有待处理的事项</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md">
        <Text dimColor size="footnote">
          {pending.length} 条待处理
        </Text>
        {pending.map(todo => {
          const source = labelSource(todo.source)
          const sessionId = sessionIdOf(todo.source)
          const isExpanded = expanded.includes(todo.id)
          const isRevising = Input !== undefined && revising === todo.id
          const isClamped =
            todo.title.length > TITLE_MAX || todo.suggestion.length > SUGGESTION_MAX
          const hasMore = todo.detail !== undefined || isClamped

          return (
            <Box
              key={`todo-${todo.id}`}
              flexDirection="column"
              gap="sm"
              padding="md"
              borderStyle="round"
              borderColor={isRevising ? 'claude' : 'subtle'}
            >
              <Text weight="semibold">
                {isExpanded ? todo.title : clamp(todo.title, TITLE_MAX)}
              </Text>
              <Box gap="sm" flexWrap="wrap">
                {source.href === undefined ? (
                  <Text dimColor size="footnote" wrap="truncate-end">
                    {source.label}
                  </Text>
                ) : (
                  <Link href={source.href} label={`${source.label} ↗`} />
                )}
                <Text dimColor size="footnote">
                  · {formatAge(todo.createdAt, now)}
                </Text>
              </Box>
              <Box flexDirection="column" gap="xs" paddingLeft="sm" borderStyle="quote" borderColor="claude">
                <Text color="claude" size="caption" weight="semibold">
                  建议
                </Text>
                <Text>
                  {isExpanded ? todo.suggestion : clamp(todo.suggestion, SUGGESTION_MAX)}
                </Text>
              </Box>
              {hasMore && (
                <Button
                  key={`more-${todo.id}`}
                  plain
                  onPress={() =>
                    update($, expandedIds, ids =>
                      ids.includes(todo.id)
                        ? ids.filter(id => id !== todo.id)
                        : [...ids, todo.id],
                    )
                  }
                >
                  <Text color="suggestion" size="footnote">
                    {isExpanded ? '收起详情 ▴' : '展开详情 ▾'}
                  </Text>
                </Button>
              )}
              {isExpanded && todo.detail !== undefined && (
                <Box paddingLeft="sm">
                  <Markdown key={`detail-${todo.id}`} text={todo.detail} dimColor />
                </Box>
              )}
              <Box gap="sm" flexWrap="wrap">
                <Button
                  key={`accept-${todo.id}`}
                  label="按建议执行"
                  variant="primary"
                  onPress={() => decide($, todo, 'accepted', acceptPrompt(todo))}
                />
                {Input !== undefined && (
                  <Button
                    key={`revise-${todo.id}`}
                    label={isRevising ? '取消修改' : '修改执行方式'}
                    onPress={() =>
                      update($, revisingId, id => (id === todo.id ? null : todo.id))
                    }
                  />
                )}
                <Button
                  key={`ignore-${todo.id}`}
                  label="忽略"
                  onPress={() => decide($, todo, 'ignored')}
                />
                {sessionId !== undefined && (
                  <Button
                    key={`archive-${todo.id}`}
                    label="归档 session"
                    onPress={() => decide($, todo, 'archived', archivePrompt(todo, sessionId))}
                  />
                )}
              </Box>
              {Input !== undefined && isRevising && (
                <Input
                  key={`how-${todo.id}`}
                  placeholder="写下你要的执行方式，回车提交"
                  submitLabel="提交"
                  rows={3}
                  autoFocus
                  onSubmit={(value: string) => {
                    if (value.trim() === '') return
                    void decide($, todo, 'revised', revisePrompt(todo, value.trim()))
                  }}
                />
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
