export type TodoStatus = 'pending' | 'accepted' | 'revised' | 'ignored' | 'resolved' | 'archived'

export type Todo = {
  id: string
  title: string
  source: string
  suggestion: string
  detail?: string
  status: TodoStatus
  createdAt: number
  resolution?: string
}

// One task as the monitor session's slack_task_log.py hook writes it to slack-tasks.json.
export type SlackTask = {
  id: string
  session_id: string
  sender?: string
  title: string
  permalink?: string
  quiet: boolean
  started: string
  handed_at?: string
  ended?: string
  summary?: string
}

// What slack_poller.py answers at /status.json.
export type PollerStatus = {
  state: string
  needs_login: boolean
  last_error: string | null
  last_item: string | null
  last_push: string | null
}

export type MessageCounts = { received: number; pushed: number; filtered: number; sent: number }

// What slack_poller.py answers at /activity.json?days=1: today's counts, whole and by hour ("00" to "23").
export type TodayActivity = {
  totals: MessageCounts
  by_time: (MessageCounts & { slot: string })[]
}

declare module 'claude-code' {
  interface PluginState {
    'slack-todo': {
      todos: Shaped<Todo[]>
      revisingId: string | null
      expandedIds: string[]
      tasks: SlackTask[]
      poller: PollerStatus | null
      today: TodayActivity | null
    }
  }
}
