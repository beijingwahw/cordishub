/**
 * JSON-RPC 内核桥集成测试 —— 真实 HTTP 回环，覆盖方法表全链路与错误码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';

import { CordishubService } from '../src/service.ts';
import { startRpcServer, rpcCall } from '../src/rpc.ts';
import type { Session, SessionEvent } from '../src/types.ts';

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `cordishub-rpc-${name}-`)), 'db');
}

function mockCtx() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: (e: string, h: (...args: unknown[]) => void) => {
      if (!listeners.has(e)) listeners.set(e, []);
      listeners.get(e)!.push(h);
    },
    off: () => {},
    emit: (e: string, ...args: unknown[]) => {
      for (const h of listeners.get(e) ?? []) h(...args);
    },
    plugin: () => {},
    set: () => {},
    get: () => undefined,
  } as any;
}

test('rpc · 方法表全链路（info/hub/genome/taint/cassette/audit/错误码）', async () => {
  const db = tmpDb('main');
  const ctx = mockCtx();
  const svc = new CordishubService(ctx, { dbPath: db });
  svc.install();

  const sid = 'rpc-1';
  ctx.emit('session/started', { id: sid, startedAt: 1_700_000_000_000, model: 'deepseek-v4-pro', totalTokens: 0, totalCost: 0 } as Session);
  ctx.emit('context/injection', { id: 'r1', sessionId: sid, source: 'system', ts: 1, seq: 1, payload: { text: 'billing assistant' } } as SessionEvent);
  ctx.emit('tool/called', { id: 'r2c', sessionId: sid, source: 'tool', ts: 2, seq: 2, toolCallId: 'tc', payload: { tool_name: 'shell', arguments: { cmd: 'ls' } } } as SessionEvent);
  ctx.emit('tool/result', { id: 'r2r', sessionId: sid, source: 'tool', ts: 3, seq: 3, toolCallId: 'tc', payload: { tool_name: 'shell', result: { stdout: 'refund policy' } } } as SessionEvent);
  ctx.emit('model/response', { id: 'r4', sessionId: sid, source: 'model', ts: 4, seq: 4, model: 'deepseek-v4-pro', tokens: { prompt: 100, completion: 20, total: 120 }, payload: { text: 'done' } } as SessionEvent);
  svc.sealNow();

  const handle = await startRpcServer(svc, {});
  try {
    const info = await rpcCall(handle.port, 'service.info');
    assert.equal(info.result.name, 'cordishub');
    assert.equal(info.result.capabilities.hub, true);

    const hub = await rpcCall(handle.port, 'hub.search', { query: 'review' });
    assert.equal(hub.result[0].fullName, 'community/dsh-plugin-pr-review');

    const genome = await rpcCall(handle.port, 'genome.extract', { sessionId: sid });
    assert.match(genome.result.systemPrompt, /billing assistant/);
    assert.deepEqual(genome.result.tools, ['shell']);

    // 污点策略以数据形态跨 RPC：关键词规则由服务端编译
    const taint = await rpcCall(handle.port, 'taint.scan', {
      sessionId: sid,
      policy: {
        contextKeywords: [{ match: 'billing', label: 'tenant:acme' }],
        toolResultKeywords: [{ match: 'refund', label: 'pii' }],
        forbiddenInOutput: ['pii'],
      },
    });
    assert.deepEqual(taint.result.finalActive.sort(), ['pii', 'tenant:acme']);
    assert.equal(taint.result.violations.length, 1, '禁止标签在模型输出时活跃 → taint-leak');

    const cassette = await rpcCall(handle.port, 'cassette.inspect', { sessionId: sid });
    assert.equal(cassette.result.kinds['tool-call'], 1);
    assert.equal(cassette.result.verification.ok, true);

    const audit = await rpcCall(handle.port, 'audit.chains');
    assert.equal(audit.result.length, 4);
    assert.ok(audit.result.every((r: { ok: boolean }) => r.ok));

    const sessions = await rpcCall(handle.port, 'sessions.list');
    assert.ok(sessions.result.some((s: { id: string }) => s.id === sid));

    // JSON-RPC 错误码
    const unknown = await rpcCall(handle.port, 'no.such.method');
    assert.equal(unknown.error.code, -32601);
    const health = await new Promise<{ ok: boolean }>((resolve, reject) => {
      get(`http://127.0.0.1:${handle.port}/health`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(health.ok, true);
  } finally {
    await handle.close();
    svc.dispose();
    rmSync(join(db, '..'), { recursive: true, force: true });
  }
});
