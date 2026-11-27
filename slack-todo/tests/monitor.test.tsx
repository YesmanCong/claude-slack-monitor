import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'slack-todo',
  component: 'Pane',
  requestId: 'slack-todo',
  props: {
    title: '待办',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const TASKS_PATH = '/home/me/.claude/slack-tasks.json'
const RUNNING = {
  id: 'monitor:1',
  session_id: 'monitor',
  sender: 'Alice · rc-dev',
  title: '帮忙 review 一下 PR',
  permalink: 'https://example.slack.com/archives/C1/p1',
  quiet: false,
  started: '10:53',
}
const ENDED = { ...RUNNING, ended: '10:57', summary: '已在 thread 里回复 Alice。' }
const STATUS = { state: 'connected', needs_login: false, last_error: null, last_item: '2026-11-27 17:01:05', last_push: '2026-11-27 17:01:09' }
const HOUR = { received: 0, pushed: 0, filtered: 0, sent: 0 }
const TODAY = {
  totals: { received: 25, pushed: 13, filtered: 12, sent: 3 },
  by_time: Array.from({ length: 24 }, (_, hour) => ({
    ...HOUR,
    slot: String(hour).padStart(2, '0'),
    ...(hour === 15 ? { received: 25, pushed: 13, filtered: 12, sent: 3 } : {}),
  })),
}

type On = Parameters<Parameters<typeof test>[1]>[1]

// Stands for the engine beneath the mod: the task file in memory, the poller's two answers (none: it is not running), and a record of every toast and notification raised.
function mockEngine(on: On, sessionId: string, pollerAnswers?: Record<string, unknown>) {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  const notices: string[] = []
  const commands: (readonly string[])[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notices.push(e.text)
    return { value: { isSent: true, channel: 'client' } }
  })
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('missing')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    commands.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('http.fetch', (_, e) => {
    const answer = pollerAnswers?.[e.url]
    if (answer === undefined) throw new Error('connection refused')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })

  return { files, toasts, notices, commands }
}

const POLLER_UP = {
  'http://127.0.0.1:8765/status.json': STATUS,
  'http://127.0.0.1:8765/activity.json?days=1': TODAY,
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane shows the poller, the todo board, the tasks and today on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const { files, toasts, notices, commands } = mockEngine(on, 'monitor', POLLER_UP)

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const idle = await $.ui.mount({ ...PANE, surface })
    await idle.press({ key: 'open-settings' })
    expect(commands).toEqual([['open', 'http://127.0.0.1:8765']])
    expect((await idle.find({ type: 'Text', text: /poller/ }))?.text).toBe('● poller 在跑')
    expect((await idle.find({ type: 'Text', text: /最后收到/ }))?.text).toBe('最后收到 17:01 · 最后推给 Claude 17:01')
    expect((await idle.find({ type: 'Text', text: /没有待处理/ }))?.text).toBe('没有待处理的事项')
    expect(await idle.find({ type: 'Text', text: /^任务/ })).toBeUndefined()
    expect((await idle.find({ type: 'Text', text: /^25$/ }))?.text).toBe('25')
    expect((await idle.find({ type: 'Svg' })) !== undefined).toBe(surface === 'desktop')
    await idle.unmount()

    files[TASKS_PATH] = JSON.stringify([RUNNING])
    await clock.advance(3000)
    expect(toasts).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])
    expect(notices).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])

    const running = await $.ui.mount({ ...PANE, surface })
    expect((await running.find({ type: 'Text', text: /^任务/ }))?.text).toBe('任务 · 处理中 1 · 已完成 0')
    expect((await running.find({ type: 'Text', text: /^处理中 ·/ }))?.text).toBe('处理中 · 10:53')
    expect(await running.find({ type: 'Text', text: /移除/ })).toBeUndefined()
    await running.unmount()

    files[TASKS_PATH] = JSON.stringify([ENDED])
    await clock.advance(3000)
    expect(toasts[1]).toBe('处理完：Alice · rc-dev：帮忙 review 一下 PR')
    expect(notices[1]).toBe('处理完：Alice · rc-dev：帮忙 review 一下 PR\n已在 thread 里回复 Alice。')

    const done = await $.ui.mount({ ...PANE, surface })
    expect((await done.find({ type: 'Text', text: /^已完成 ·/ }))?.text).toBe('已完成 · 10:57')
    expect(await done.find({ type: 'Text', text: /已在 thread/ })).toBeDefined()
    await done.press({ key: 'remove-task-monitor:1' })
    await done.unmount()
    expect(files[TASKS_PATH]).toBe('[]')
    expect(toasts).toHaveLength(2)
  })
}

test('a poller that does not answer is shown as not running, and the board and tasks still draw', async ($, on) => {
  mock.clock(on)
  const { files } = mockEngine(on, 'monitor')
  files[TASKS_PATH] = JSON.stringify([{ ...RUNNING, handed_to: ['local_worker'], handed_at: '10:54' }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /poller/ }))?.text).toBe('● poller 没在跑')
  expect(await pane.find({ type: 'Text', text: /没有待处理/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^已转给/ }))?.text).toBe('已转给别的会话 · 10:54')
  expect(await pane.find({ type: 'Text', text: /^今天$/ })).toBeUndefined()
  await pane.press({ key: 'remove-task-monitor:1' })
  await pane.unmount()
  expect(files[TASKS_PATH]).toBe('[]')
})

test('another session shows the toast and leaves the notification to the session doing the work', async ($, on) => {
  const clock = mock.clock(on)
  const { files, toasts, notices } = mockEngine(on, 'elsewhere', POLLER_UP)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files[TASKS_PATH] = JSON.stringify([RUNNING, { ...RUNNING, id: 'monitor:2', title: '跟进检查', quiet: true }])
  await clock.advance(3000)

  expect(toasts).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])
  expect(notices).toEqual([])
})

test('tasks are listed newest first without an announcement at start, and the finished ones clear together', async ($, on) => {
  mock.clock(on)
  const { files, toasts, notices } = mockEngine(on, 'monitor', POLLER_UP)
  const ended = [1, 2].map(n => ({ ...ENDED, id: `monitor:${n}`, title: `第 ${n} 件` }))
  files[TASKS_PATH] = JSON.stringify([...ended, { ...RUNNING, id: 'monitor:3', title: '第 3 件' }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect([...toasts, ...notices]).toEqual([])

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^任务/ }))?.text).toBe('任务 · 处理中 1 · 已完成 2')
  expect((await pane.find({ type: 'Text', text: /^第 \d 件$/ }))?.text).toBe('第 3 件')
  await pane.press({ key: 'clear-tasks' })
  await pane.unmount()

  expect(JSON.parse(files[TASKS_PATH] ?? '[]').map((task: { id: string }) => task.id)).toEqual(['monitor:3'])
})

test('a task expands to every message it holds and the whole result', async ($, on) => {
  mock.clock(on)
  const { files } = mockEngine(on, 'monitor', POLLER_UP)
  const messages = [
    { sender: 'Carol', text: '这个订单能不能直接退款', permalink: 'https://example.slack.com/archives/C1/p1' },
    { sender: 'proj-support', text: '另外 AI 分类的准确率有数据吗' },
  ]
  files[TASKS_PATH] = JSON.stringify([
    { ...ENDED, sender: '2 条消息 · Carol、proj-support', title: messages[0]?.text, messages, summary: '第一条回了可以；第二条放进了待办。' },
  ])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const collapsed = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await collapsed.find({ type: 'Text', text: /准确率/ })).toBeUndefined()
  expect(await collapsed.find({ type: 'Text', text: /^处理结果$/ })).toBeUndefined()
  await collapsed.press({ key: 'toggle-task-monitor:1' })
  await collapsed.unmount()

  const expanded = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await expanded.find({ type: 'Text', text: /准确率/ }))?.text).toBe('另外 AI 分类的准确率有数据吗')
  expect((await expanded.find({ type: 'Text', text: /^proj-support$/ }))?.text).toBe('proj-support')
  expect(await expanded.find({ type: 'Text', text: /^处理结果$/ })).toBeDefined()
  expect((await expanded.find({ type: 'Text', text: /第二条放进了待办/ }))?.text).toBe('第一条回了可以；第二条放进了待办。')
  await expanded.unmount()
})
