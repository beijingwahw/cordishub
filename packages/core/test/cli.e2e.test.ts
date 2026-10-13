/**
 * CLI 端到端测试 —— 真实子进程运行 cli/src/index.ts，断言人类可读输出。
 * 数据目录通过 XDG_DATA_HOME 隔离到临时目录，不污染用户主目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url));

function runCli(args: string[], xdgData: string): string {
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', CLI_ENTRY, ...args],
    { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: xdgData } },
  );
}

test('cli e2e · help / version / hub / rebuild / compact / cost 全链路', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'cordishub-e2e-'));
  try {
    const help = runCli(['--help'], xdg);
    assert.ok(help.includes('cordishub hub'), '帮助应包含 hub 用法');
    assert.ok(help.includes('cordishub compact'), '帮助应包含 compact 用法');

    const version = runCli(['-v'], xdg);
    assert.match(version, /cordishub v0\.\d+\.\d+/);

    const hub = runCli(['hub', 'review'], xdg);
    assert.ok(hub.includes('dsh-plugin-pr-review'), '内置 demo 插件应可被搜索');
    assert.ok(hub.includes('官方'), '官方标记应渲染');

    const rebuild = runCli(['rebuild'], xdg);
    assert.ok(rebuild.includes('重建'), 'rebuild 应有人类可读反馈');

    const compact = runCli(['compact'], xdg);
    assert.ok(compact.includes('✓'), 'compact 应报告成功');
    assert.ok(existsSync(join(xdg, 'cordishub', 'cordishub.kv.jsonl')), '数据必须落在隔离的 XDG 目录');

    const audit = runCli(['audit'], xdg);
    assert.ok(audit.includes('✓'), '空库的哈希链审计也应通过（零封印 = 平凡有效）');

    // 数据注入机制：record-demo 后 genome/cassette 全链路可测
    const rec = runCli(['record-demo'], xdg);
    assert.ok(rec.includes('sess-demo-001'), '演示会话应录制成功');
    const genomeOut = runCli(['genome', 'sess-demo-001'], xdg);
    assert.ok(genomeOut.includes('demo assistant'), '基因型应提取出 system prompt');
    assert.ok(genomeOut.includes('shell'), '基因型应提取出工具集');
    const cassetteOut = runCli(['cassette', 'sess-demo-001'], xdg);
    assert.ok(cassetteOut.includes('tool-call'), '盒带应包含工具调用条目');

    const cost = runCli(['cost'], xdg);
    assert.ok(cost.includes('TOTAL'), 'cost 应输出汇总行');
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
