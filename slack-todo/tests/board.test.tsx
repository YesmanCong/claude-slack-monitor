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
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TODO = {
  tool: 'mcp__slack-todo__add_todo' as const,
  title: 'Alice 问 PROJ-1 的接口字段',
  source: 'https://example.slack.com/archives/C1/p1',
  suggestion: '在 thread 里回复字段名 refund_amount',
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`three decisions on ${surface}`, async ($, on) => {
    const submitted: string[] = []
    mock.store(on)
    mock.clock(on)
    on('command.register', () => ({ value: { command: 'todo' } }))
    on('tool.register', () => ({ value: { tool: 'mcp__slack-todo__add_todo' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('prompt.submit', (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const added = await $.tool.call(TODO)
    expect('deny' in added && added.deny).toBe(false)
    const again = await $.tool.call(TODO)
    expect(again.deny).toContain('Already on the board')
    const tooLong = await $.tool.call({ ...TODO, source: 'slack:long', suggestion: '长'.repeat(121) })
    expect(tooLong.deny).toContain('Shorten them')
    await $.tool.call({ ...TODO, title: '第二条', source: 'slack:2', detail: '背景：**老域名**还在用' })
    await $.tool.call({ ...TODO, title: '第三条', source: 'slack:3' })

    const ui = await $.ui.mount({ ...PANE, surface })
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
    const [accept, , ] = keys.filter(k => k.startsWith('accept-'))
    const [, revise] = keys.filter(k => k.startsWith('revise-'))
    const [, , ignore] = keys.filter(k => k.startsWith('ignore-'))

    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    const more = keys.find(k => k.startsWith('more-'))
    await ui.press({ key: more! })
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('老域名')

    await ui.press({ key: accept! })
    expect(submitted[0]).toContain('[待办看板] 按建议执行：Alice 问 PROJ-1 的接口字段')

    await ui.press({ key: revise! })
    const field = (await ui.findAll({ type: 'Input' }))[0]
    await ui.input({ key: field!.key!, text: '先别回，等我确认' })
    expect(submitted[1]).toContain('不按原建议')
    expect(submitted[1]).toContain('我的执行方式：先别回，等我确认')

    await ui.press({ key: ignore! })
    expect(submitted).toHaveLength(2)
    expect((await ui.find({ type: 'Text', text: /没有待处理/ }))?.text).toBe('没有待处理的事项')
    await ui.unmount()
  })
}
