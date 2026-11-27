// One task as the monitor session's slack_task_log.py hook writes it to slack-tasks.json.
export type SlackTask = {
  id: string
  session_id: string
  sender?: string
  title: string
  permalink?: string
  quiet: boolean
  started: string
  listed_from_ms?: number
  handed_at?: string
  ended?: string
  summary?: string
}

declare module 'claude-code' {
  interface PluginState {
    'slack-tasks': {
      tasks: SlackTask[]
      isExpanded: boolean
      firstVisibleRow: number
    }
  }
}
