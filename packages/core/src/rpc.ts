/**
 * JSON-RPC 2.0 内核桥（L4 · 接口统一第一步）。
 *
 * CLI / TUI / 桌面端 / Web 全部通过同一个方法表访问内核——不再各自直连
 * service。零依赖 node:http；错误码遵循 JSON-RPC 2.0
 * （-32700 解析错误 / -32601 方法不存在 / -32000 内部错误）。
 *
 * 边界原则：跨 RPC 的输入必须是数据——污点策略这种"函数型"参数由
 * compileTaintPolicy 把关键词规则编译成策略，函数不出进程边界。
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CordishubService } from './service.ts';
import { loadGenomes } from './genome.ts';
import { verifyTape } from './cassette.ts';
import type { TaintPolicy } from './taint.ts';

export type RpcHandler = (params: Record<string, unknown>) => unknown;
export type RpcMethodTable = Record<string, RpcHandler>;

/** 内核方法表：所有客户端共用的唯一 API 面 */
export function buildMethodTable(svc: CordishubService): RpcMethodTable {
  return {
    'service.info': () => ({
      name: 'cordishub',
      version: '0.9.0',
      capabilities: svc.capabilities,
    }),
    'sessions.list': (p) => svc.recentSessions(Number(p['limit'] ?? 20)),
    'session.cost': (p) => svc.sessionCost(String(p['sessionId'])),
    'cost.breakdown': () => svc.costBreakdown(),
    'hub.search': (p) =>
      svc.searchHub(String(p['query'] ?? ''), {
        onlyOfficial: !!p['onlyOfficial'],
        limit: p['limit'] !== undefined ? Number(p['limit']) : undefined,
      }),
    'search.fulltext': (p) => svc.search(String(p['query'] ?? ''), { limit: p['limit'] !== undefined ? Number(p['limit']) : undefined }),
    'safety.history': (p) => svc.safetyHistory(p['limit'] !== undefined ? { limit: Number(p['limit']) } : {}),
    'replay.session': (p) => svc.replaySession(String(p['sessionId']), { upToSeq: p['upToSeq'] !== undefined ? Number(p['upToSeq']) : undefined }),
    'genome.extract': (p) => svc.extractGenome(String(p['sessionId']), { name: p['name'] !== undefined ? String(p['name']) : undefined }),
    'genome.library': () => loadGenomes(svc.storage),
    'genome.fitness': (p) => svc.genomeFitness(String(p['hash'])),
    'cassette.inspect': (p) => {
      const tape = svc.recordTape(String(p['sessionId']));
      if (!tape) return null;
      const kinds: Record<string, number> = {};
      for (const e of tape.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      return {
        entries: tape.entries.length,
        kinds,
        determinism: tape.determinism,
        verification: verifyTape(tape),
      };
    },
    'taint.scan': (p) => svc.taintScan(String(p['sessionId']), compileTaintPolicy(p['policy'] as TaintPolicySpec | undefined)),
    'audit.chains': () => svc.audit(),
    'budget.snapshot': () => svc.budget?.snapshot() ?? null,
  };
}

/** 污点策略的数据形态（RPC 边界可序列化） */
export interface TaintPolicySpec {
  contextKeywords?: Array<{ match: string; label: string }>;
  toolResultKeywords?: Array<{ match: string; label: string }>;
  sanitizeToolPattern?: string;
  forbiddenInOutput?: string[];
}

/** 关键词规则 → TaintPolicy（函数编译在服务端完成） */
export function compileTaintPolicy(spec: TaintPolicySpec | undefined): TaintPolicy {
  if (!spec) return {};
  const sanitizeRe = spec.sanitizeToolPattern ? new RegExp(spec.sanitizeToolPattern, 'i') : undefined;
  return {
    taintOfEvent: (_source, payload) =>
      (spec.contextKeywords ?? [])
        .filter((k) => String(payload['text'] ?? '').includes(k.match))
        .map((k) => k.label),
    taintOfToolResult: (_tool, result) =>
      (spec.toolResultKeywords ?? [])
        .filter((k) => JSON.stringify(result ?? '').includes(k.match))
        .map((k) => k.label),
    sanitize: (tool) => (sanitizeRe ? sanitizeRe.test(tool) : false),
    forbiddenInOutput: spec.forbiddenInOutput,
  };
}

export interface RpcServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** 启动 JSON-RPC HTTP 服务器（port 0 = 随机可用端口，测试用） */
export function startRpcServer(
  svc: CordishubService,
  opts: { port?: number; host?: string } = {},
): Promise<RpcServerHandle> {
  const table = buildMethodTable(svc);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: -32600, message: 'POST only' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      const handler = message.method !== undefined ? table[message.method] : undefined;
      if (!handler) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `method not found: ${message.method}` } }));
        return;
      }
      try {
        const result = handler(message.params ?? {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result }));
      } catch (err) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: (err as Error).message } }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** 测试/客户端辅助：发一个 JSON-RPC 请求并解析响应 */
export function rpcCall(port: number, method: string, params?: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
