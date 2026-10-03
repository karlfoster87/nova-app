// Numbers and dates as the page writes them.

// "1 byte", "12 KB", "3.4 MB".
export const fileSize = (b) => (b < 1024 ? `${b} ${b === 1 ? 'byte' : 'bytes'}` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// A tool by a readable name: Nova's own task and note tools (server chat/tools.js) by what they
// do, other MCP tools (mcp__server__tool) as "tool (server)", built-in tools as they are.
const NOVA_TOOLS = {
  list_tasks: 'List tasks', add_task: 'Add task', update_task: 'Update task', move_task: 'Move task', delete_task: 'Delete task',
  list_notes: 'List notes', add_note: 'Add note', update_note: 'Update note', move_note: 'Move note', delete_note: 'Delete note'
};
export function toolLabel(name = '') {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return name;
  return m[1] === 'nova' && NOVA_TOOLS[m[2]] ? NOVA_TOOLS[m[2]] : `${m[2]} (${m[1]})`;
}

// A local calendar day as 'YYYY-MM-DD', so "today" follows this device's clock, not the server's.
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
