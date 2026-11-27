// One task as the monitor session's slack_task_log.py hook writes it to slack-tasks.json.
export type SlackTask = {
  id: string
  session_id: string
  title: string
  permalink?: string
  quiet: boolean
  started: string
  ended?: string
  summary?: string
}

declare module 'claude-code' {
  interface PluginState {
    'slack-tasks': {
      tasks: SlackTask[]
      isExpanded: boolean
    }
  }
}
