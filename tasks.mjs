// One public shape for both single-agent and parallel calls. Reject ambiguity
// before configuration is read or any process is launched.
export function validateTasks(params) {
  const example = '{"tasks":[{"agent":"opencode","task":"oi"}]}';
  if (!params || Object.keys(params).some(key => key !== 'tasks')) {
    throw new Error(`ACP: use only tasks at the top level; put agent, task and cwd inside each item. Example: ${example}`);
  }
  if (!Array.isArray(params.tasks) || params.tasks.length < 1 || params.tasks.length > 4) {
    throw new Error(`ACP: tasks must contain 1–4 assignments. Example: ${example}`);
  }
  for (const task of params.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || Object.keys(task).some(key => !['agent', 'task', 'cwd', 'model', 'timeoutSeconds', 'timeout'].includes(key))
      || typeof task.agent !== 'string' || !task.agent.trim()
      || typeof task.task !== 'string' || !task.task.trim()
      || (task.cwd !== undefined && typeof task.cwd !== 'string')
      || (task.model !== undefined && (typeof task.model !== 'string' || !task.model.trim()))
      || (task.timeoutSeconds !== undefined && (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1 || task.timeoutSeconds > 86400))
      || (task.timeout !== undefined && (!Number.isInteger(task.timeout) || task.timeout < 1 || task.timeout > 86400))) {
      throw new Error(`ACP: each task needs non-empty agent and task strings, with optional cwd string, model, and timeoutSeconds (1–86400). Example: ${example}`);
    }
    if (task.timeout !== undefined && task.timeoutSeconds === undefined) {
      task.timeoutSeconds = task.timeout;
    }
  }
  return params.tasks;
}
