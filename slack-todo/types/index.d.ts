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

declare module 'claude-code' {
  interface PluginState {
    'slack-todo': {
      todos: Shaped<Todo[]>
      revisingId: string | null
      expandedIds: string[]
    }
  }
}
