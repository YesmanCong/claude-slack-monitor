import { expect, mock, test } from 'claude-code/testing'

const BAND = { plugin: 'slack-tasks', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 80 } } as const
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

type On = Parameters<Parameters<typeof test>[1]>[1]

// Stands for the engine beneath the mod: the task file in memory, and a record of every toast and notification raised.
function mockEngine(on: On, sessionId: string) {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  const notices: string[] = []
  mock.env(on, { HOME: '/home/me' })
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
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  return { files, toasts, notices }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a task is listed, announced at its start and end, and removed on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const { files, toasts, notices } = mockEngine(on, 'monitor')

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const empty = await $.ui.mount({ ...BAND, surface })
    expect(await empty.find({ type: 'Button' })).toBeUndefined()
    await empty.unmount()

    files[TASKS_PATH] = JSON.stringify([RUNNING])
    await clock.advance(3000)
    expect(toasts).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])
    expect(notices).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])

    const collapsed = await $.ui.mount({ ...BAND, surface })
    expect((await collapsed.find({ type: 'Text', text: /review/ }))?.text).toBe(RUNNING.title)
    expect((await collapsed.find({ type: 'Text', text: /已完成/ }))?.text).toBe('处理中 1 · 已完成 0')
    await collapsed.press({ key: 'toggle' })
    await collapsed.unmount()

    const expanded = await $.ui.mount({ ...BAND, surface })
    expect((await expanded.find({ type: 'Text', text: /^处理中 ·/ }))?.text).toBe('处理中 · 10:53')
    expect(await expanded.find({ type: 'Text', text: /移除/ })).toBeUndefined()
    await expanded.unmount()

    files[TASKS_PATH] = JSON.stringify([ENDED])
    await clock.advance(3000)
    expect(toasts[1]).toBe('处理完：Alice · rc-dev：帮忙 review 一下 PR')
    expect(notices[1]).toBe('处理完：Alice · rc-dev：帮忙 review 一下 PR\n已在 thread 里回复 Alice。')

    const done = await $.ui.mount({ ...BAND, surface })
    expect((await done.find({ type: 'Text', text: /^已完成 ·/ }))?.text).toBe('已完成 · 10:57')
    await done.press({ key: 'remove-monitor:1' })
    await done.unmount()
    expect(files[TASKS_PATH]).toBe('[]')

    const removed = await $.ui.mount({ ...BAND, surface })
    expect(await removed.find({ type: 'Button' })).toBeUndefined()
    await removed.unmount()
    expect(toasts).toHaveLength(2)
  })
}

test('another session shows the toast and leaves the notification to the session doing the work', async ($, on) => {
  const clock = mock.clock(on)
  const { files, toasts, notices } = mockEngine(on, 'elsewhere')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files[TASKS_PATH] = JSON.stringify([RUNNING, { ...RUNNING, id: 'monitor:2', title: '跟进检查', quiet: true }])
  await clock.advance(3000)

  expect(toasts).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])
  expect(notices).toEqual([])
})

test('tasks already in the file when a session starts are listed without an announcement', async ($, on) => {
  mock.clock(on)
  const { files, toasts, notices } = mockEngine(on, 'monitor')
  files[TASKS_PATH] = JSON.stringify([ENDED])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /已完成/ }))?.text).toBe('处理中 0 · 已完成 1')
  await band.unmount()
  expect([...toasts, ...notices]).toEqual([])
})

test('the expanded list shows five rows at a time, newest first, and clears what is finished', async ($, on) => {
  mock.clock(on)
  const { files } = mockEngine(on, 'monitor')
  const ended = [1, 2, 3, 4, 5, 6].map(n => ({ ...ENDED, id: `monitor:${n}`, title: `第 ${n} 件` }))
  files[TASKS_PATH] = JSON.stringify([...ended, { ...RUNNING, id: 'monitor:7', title: '第 7 件' }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const collapsed = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await collapsed.press({ key: 'toggle' })
  await collapsed.unmount()

  const top = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await top.find({ type: 'Text', text: /\/ 7$/ }))?.text).toBe('1–5 / 7')
  expect(await top.find({ type: 'Text', text: /第 7 件/ })).toBeDefined()
  expect(await top.find({ type: 'Text', text: /第 2 件/ })).toBeUndefined()
  await top.press({ key: 'rows-down' })
  await top.unmount()

  const bottom = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await bottom.find({ type: 'Text', text: /\/ 7$/ }))?.text).toBe('3–7 / 7')
  expect(await bottom.find({ type: 'Text', text: /第 1 件/ })).toBeDefined()
  await bottom.press({ key: 'clear' })
  await bottom.unmount()

  expect(JSON.parse(files[TASKS_PATH] ?? '[]').map((task: { id: string }) => task.id)).toEqual(['monitor:7'])
  const cleared = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cleared.find({ type: 'Text', text: /已完成/ }))?.text).toBe('处理中 1 · 已完成 0')
  await cleared.unmount()
})

test('a running task enters the list once it has outlasted a quick answer', async ($, on) => {
  const clock = mock.clock(on)
  const { files, toasts } = mockEngine(on, 'monitor')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files[TASKS_PATH] = JSON.stringify([{ ...RUNNING, listed_from_ms: 90_000 }])
  await clock.advance(87_000)
  const early = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await early.find({ type: 'Button' })).toBeUndefined()
  await early.unmount()
  expect(toasts).toEqual([])

  await clock.advance(3000)
  expect(toasts).toEqual(['开始处理：Alice · rc-dev：帮忙 review 一下 PR'])
  const listed = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await listed.find({ type: 'Text', text: /已完成/ }))?.text).toBe('处理中 1 · 已完成 0')
  await listed.unmount()
})

test('a task handed to another session stays open, says so, and can be removed by hand', async ($, on) => {
  mock.clock(on)
  const { files } = mockEngine(on, 'monitor')
  files[TASKS_PATH] = JSON.stringify([{ ...RUNNING, handed_to: ['local_worker'], handed_at: '10:54' }])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const collapsed = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await collapsed.find({ type: 'Text', text: /已完成/ }))?.text).toBe('处理中 1 · 已完成 0')
  await collapsed.press({ key: 'toggle' })
  await collapsed.unmount()

  const expanded = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await expanded.find({ type: 'Text', text: /^已转给/ }))?.text).toBe('已转给别的会话 · 10:54')
  await expanded.press({ key: 'remove-monitor:1' })
  await expanded.unmount()
  expect(files[TASKS_PATH]).toBe('[]')
})
