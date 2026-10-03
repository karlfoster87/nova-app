// Turns server events into activity-log lines (presence/log.js): tool calls, delegated
// sub-agents and how they ended, prompts, errors and finished turns. chats.js calls logEvent
// before an event changes any state, so a state change can be compared with what it was.
// Replayed events (prompts re-sent on reconnect, task progress on open) are logged once.
import { state, titleOf } from '../state.js';
import { log } from '../presence/log.js';
import { toolSummary, AGENT_TOOLS } from './transcript.js';
import { toolLabel } from '../lib/format.js';
import { modeName } from './pickers.js';

const logged = new Set();
const once = (key) => !logged.has(key) && logged.add(key);
const toolNames = new Map();  // tool_use_id -> tool name, to name a failure
const agentNames = new Map(); // Agent tool_use_id or task id -> sub-agent type
const withSummary = (name, input) => { const s = toolSummary(name, input); return s ? `${toolLabel(name)}: ${s}` : toolLabel(name); };

export function logEvent(m) {
  const where = m.chatId ? titleOf(m.chatId) : '';
  switch (m.t) {
    case 'state': {
      const before = state.chatState.get(m.chatId);
      if (m.state === 'running' && before !== 'running') log('chat', 'Nova started working', where);
      else if (m.state === 'closed' && before && before !== 'closed') log('system', 'Chat process closed', where);
      return;
    }
    case 'permission':
      if (once(`req:${m.reqId}`)) log('prompt', m.toolName === 'AskUserQuestion' ? 'Nova asked you a question' : `Approval needed: ${m.title || m.toolName}`, where);
      return;
    case 'permission_resolved': log('prompt', 'Prompt answered', where); return;
    case 'permission_cancelled': log('prompt', 'Prompt withdrawn', where); return;
    case 'error': log('error', m.message, where); return;
    case 'restarting': log('system', 'Nova is restarting'); return;
    case 'mode': {
      const chat = state.chats.find((c) => c.id === m.chatId);
      if (chat && chat.permission_mode !== m.mode) log('system', `Permissions set to ${modeName(m.mode)}`, where);
      return;
    }
    case 'sdk': break;
    default: return;
  }
  const msg = m.msg;
  if (msg.type === 'assistant') {
    for (const b of msg.message?.content || []) {
      if (b.type !== 'tool_use' || !once(`tool:${b.id}`)) continue;
      toolNames.set(b.id, toolLabel(b.name));
      if (msg.parent_tool_use_id) log('agent', `${agentNames.get(msg.parent_tool_use_id) || 'Sub-agent'} used ${withSummary(b.name, b.input)}`, where);
      else if (AGENT_TOOLS.has(b.name)) {
        const name = b.input?.subagent_type || 'a sub-agent';
        agentNames.set(b.id, b.input?.subagent_type || 'Sub-agent');
        log('agent', `Delegated to ${name}${b.input?.description ? `: ${b.input.description}` : ''}`, where);
      } else log('tool', withSummary(b.name, b.input), where);
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result' && b.is_error && once(`err:${b.tool_use_id}`)) log('error', `${toolNames.get(b.tool_use_id) || 'A tool'} returned an error`, where);
    }
  } else if (msg.type === 'result') {
    const secs = Math.round((msg.duration_ms || 0) / 1000);
    if (!msg.subtype || msg.subtype === 'success') log('chat', `Finished in ${secs}s${msg.num_turns > 1 ? `, ${msg.num_turns} steps` : ''}`, where);
    else log('error', `Turn ended: ${msg.subtype.replace(/_/g, ' ')}`, where);
  } else if (msg.type === 'system') {
    if (msg.subtype === 'task_started' && (msg.task_type === 'local_agent' || msg.subagent_type)) {
      agentNames.set(msg.task_id, msg.subagent_type || agentNames.get(msg.tool_use_id) || 'Sub-agent');
      if (msg.tool_use_id) agentNames.set(msg.tool_use_id, agentNames.get(msg.task_id));
    } else if (msg.subtype === 'task_notification' && agentNames.has(msg.task_id) && once(`end:${msg.task_id}`)) {
      log(msg.status === 'failed' ? 'error' : 'agent', `${agentNames.get(msg.task_id)} ${msg.status === 'completed' ? 'finished' : msg.status}`, where);
    } else if (msg.subtype === 'compact_boundary') log('system', 'Earlier context was summarised', where);
    else if (msg.subtype === 'init' && msg.model && once(`init:${m.chatId}:${msg.model}`)) log('system', `Session running on ${msg.model}`, where);
  }
}
