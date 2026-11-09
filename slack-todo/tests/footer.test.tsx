import { expect, mock, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the footer button opens the pane on ${surface}`, async ($, on) => {
    const opened: string[] = []
    mock.store(on)
    mock.clock(on)
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('tool.register', (_, e) => ({ value: { tool: e.name } }))
    on('ui.open', (_, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.id', () => ({ value: 'session-1' }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>focus</Text>
    })

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const footer = { plugin: 'slack-todo', component: 'SessionMode', surface, props: { modes: ['focus'] } } as const

    const empty = await $.ui.mount(footer)
    expect(await empty.find({ type: 'Button' })).toBeUndefined()
    await empty.unmount()

    await $.tool.call({ tool: 'mcp__slack-todo__add_todo', title: '底栏测试', source: 'slack:footer', suggestion: '无' })
    const ui = await $.ui.mount(footer)
    expect((await ui.find({ type: 'Text', text: /focus/ }))?.text).toBe('focus')
    opened.length = 0
    await ui.press({ key: 'open-todo' })
    expect(opened).toEqual(['slack-todo'])
    await ui.unmount()
  })
}
