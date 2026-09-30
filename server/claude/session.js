// A Claude Code session that never receives a prompt. It's only there to answer control
// requests (models, the signed-in account, plan usage, slash commands), so it uses none of
// the plan's limits. Its messages are drained so the process never stalls on backpressure.
import { query } from '@anthropic-ai/claude-agent-sdk';

export function idleSession(options) {
  let stop;
  const done = new Promise((resolve) => { stop = resolve; });
  const session = query({ prompt: { async *[Symbol.asyncIterator]() { await done; } }, options });
  (async () => { try { for await (const _ of session) {} } catch {} })();
  return {
    query: session,
    close() { stop(); try { session.close(); } catch {} }
  };
}
