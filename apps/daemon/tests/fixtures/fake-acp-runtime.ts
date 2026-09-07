#!/usr/bin/env node
/**
 * Generic ACP fixture for watchdog and same-run retry integration tests.
 * It counts actual session/prompt attempts, so ACP model-detection handshakes
 * cannot consume the retry budget.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-acp-runtime 1.0.0\n');
  process.exit(0);
}
if (!args.includes('acp')) process.exit(0);

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const result = (id: unknown, value: unknown): void => {
  write({ jsonrpc: '2.0', id, result: value });
};
const error = (id: unknown, message: string): void => {
  write({ jsonrpc: '2.0', id, error: { code: -32603, message } });
};
const update = (sessionId: string, value: Record<string, unknown>): void => {
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: value },
  });
};

const counterPath = process.env.FAKE_ACP_ATTEMPT_COUNTER_PATH ?? '';
const nextPromptAttempt = (): number => {
  if (!counterPath) return 0;
  let attempt = 0;
  try {
    attempt = Number(readFileSync(counterPath, 'utf8')) || 0;
  } catch {
    // The first prompt owns creation of the counter file.
  }
  writeFileSync(counterPath, String(attempt + 1));
  return attempt;
};

const stderrOnSigterm = process.env.FAKE_ACP_STDERR_ON_SIGTERM === '1';
const ignoreSigterm = process.env.FAKE_ACP_IGNORE_SIGTERM === '1';
if (stderrOnSigterm || ignoreSigterm) {
  let announced = false;
  process.on('SIGTERM', () => {
    if (stderrOnSigterm && !announced) {
      announced = true;
      process.stderr.write('[fake-acp] shutting down after SIGTERM\n');
    }
    if (!ignoreSigterm) process.exit(143);
  });
}

const emitText = (sessionId: string): void => {
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: process.env.FAKE_ACP_TEXT ?? 'Hello from fake ACP.',
    },
  });
};

const startDescendant = (): void => {
  const activityFile = process.env.FAKE_ACP_DESCENDANT_ACTIVITY_FILE;
  if (!activityFile) return;
  const child = spawn(process.execPath, [
    '-e',
    `const fs = require('node:fs');
const activityFile = ${JSON.stringify(activityFile)};
process.on('SIGTERM', () => {});
const tick = () => fs.appendFileSync(activityFile, String(Date.now()) + '\\n');
tick();
setInterval(tick, 25);`,
  ], { stdio: 'ignore' });
  const pidFile = process.env.FAKE_ACP_DESCENDANT_PID_FILE;
  if (pidFile && child.pid) writeFileSync(pidFile, String(child.pid));
};

const handlePrompt = (id: unknown, params: Record<string, unknown>): void => {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'fake-acp-session';
  const attempt = nextPromptAttempt();
  const errorAttempts = Number(process.env.FAKE_ACP_PROMPT_ERROR_ATTEMPTS) || 0;
  if (attempt < errorAttempts) {
    error(id, process.env.FAKE_ACP_PROMPT_ERROR ?? 'transient fatal RPC close');
    return;
  }

  const stallAttempts = Number(process.env.FAKE_ACP_STALL_ATTEMPTS) || 0;
  const shouldStall =
    process.env.FAKE_ACP_STALL_AFTER_PROMPT === '1' ||
    process.env.FAKE_ACP_ALWAYS_STALL === '1' ||
    attempt < stallAttempts;
  if (shouldStall) {
    if (process.env.FAKE_ACP_TEXT_BEFORE_STALL === '1') emitText(sessionId);
    if (process.env.FAKE_ACP_OPEN_TOOL_BEFORE_STALL === '1') {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'fake-acp-open-tool-1',
        kind: 'read',
        title: 'Read design tokens',
        status: 'in_progress',
        rawInput: { path: 'tokens.json' },
      });
    }
    startDescendant();
    const heartbeatMs = Number(process.env.FAKE_ACP_STALL_HEARTBEAT_MS) || 0;
    if (heartbeatMs > 0) {
      setInterval(() => update(sessionId, { sessionUpdate: 'heartbeat' }), heartbeatMs);
    } else {
      setInterval(() => {}, 60_000);
    }
    return;
  }

  emitText(sessionId);
  const finish = (): void => {
    result(id, {
      stopReason: 'end_turn',
      ...(process.env.FAKE_ACP_OMIT_PROMPT_USAGE === '1'
        ? {}
        : { usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } }),
    });
    const lingerMs = Number(process.env.FAKE_ACP_STAY_ALIVE_AFTER_PROMPT_MS) || 0;
    if (lingerMs > 0) setTimeout(() => {}, lingerMs);
  };
  const delayMs = Number(process.env.FAKE_ACP_PROMPT_RESULT_DELAY_MS) || 0;
  if (delayMs > 0) setTimeout(finish, delayMs);
  else finish();
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.method === 'initialize') {
          result(message.id, {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: {} },
            agentInfo: { name: 'Fake ACP Runtime', version: '1.0.0' },
          });
        } else if (message.method === 'session/new') {
          result(message.id, { sessionId: 'fake-acp-session' });
        } else if (message.method === 'session/load') {
          result(message.id, { sessionId: 'fake-acp-session' });
        } else if (
          message.method === 'session/set_model' ||
          message.method === 'session/set_config_option'
        ) {
          result(message.id, {});
        } else if (message.method === 'session/prompt') {
          handlePrompt(message.id, message.params ?? {});
        } else if (message.id !== undefined) {
          result(message.id, {});
        }
      } catch {
        // Ignore malformed fixture input so parser recovery remains host-owned.
      }
    }
    newline = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  if (!ignoreSigterm) process.exit(0);
});
