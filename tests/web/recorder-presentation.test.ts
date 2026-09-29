import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Config } from '../../web/src/api/types.ts';
import {
  DatabaseStatusPanel,
  listenerPresentation,
  recorderPresentation,
  restartFieldLabel,
  storageFieldPresentation,
  systemStatusLabel,
} from '../../web/src/features/settings.tsx';

test('recorder presentation shows healthy state and event counts', () => {
  assert.deepEqual(recorderPresentation({ degraded: false, pendingEvents: 2, retainedEvents: 150 }), {
    label: '正常',
    tone: 'good',
    pending: 2,
    retained: 150,
  });
});

test('degraded recorder presentation omits backend reason text', () => {
  const view = recorderPresentation({
    degraded: true,
    reason: 'database error at /private/path?token=secret',
    pendingEvents: 7,
    retainedEvents: 99,
  });
  assert.deepEqual(view, { label: '降级', tone: 'bad', pending: 7, retained: 99 });
  assert.equal(JSON.stringify(view).includes('secret'), false);
});

test('unknown recorder data does not invent a healthy status or event counts', () => {
  assert.deepEqual(recorderPresentation(undefined), {
    label: '状态未知',
    tone: 'neutral',
    pending: null,
    retained: null,
  });
});

test('system status and restart-required fields have Chinese friendly labels', () => {
  assert.equal(systemStatusLabel.running, '运行中');
  assert.equal(restartFieldLabel('server.port'), '代理监听端口');
  assert.equal(restartFieldLabel('server.connectTimeoutMs'), '连接超时');
  assert.equal(restartFieldLabel('quota.timezone'), '配额时区');
  assert.equal(restartFieldLabel('unexpected.secret'), '其他配置项');
});

test('listener presentation distinguishes configured values from actual bound address and port', () => {
  assert.deepEqual(
    listenerPresentation({
      enabled: true,
      configured: { bindAddress: '0.0.0.0', port: 15005 },
      actual: { bindAddress: '127.0.0.1', port: 43127 },
    }),
    {
      enabled: '已启用',
      configured: '0.0.0.0:15005',
      actual: '127.0.0.1:43127',
    },
  );
  assert.equal(
    listenerPresentation({ enabled: true, configured: { bindAddress: '0.0.0.0', port: 15005 }, actual: null }).actual,
    '未启用/尚不可读',
  );
});

test('structured settings exposes all V2 storage controls as required positive integers', () => {
  const config = {
    schemaVersion: 2,
    revision: 1,
    server: { port: 15005, bindAddress: '0.0.0.0' },
    quota: { timezone: 'UTC' },
    storage: {
      flushIntervalMs: 250,
      batchSize: 100,
      requestRetentionDays: 30,
      minuteRetentionDays: 7,
      hourRetentionDays: 90,
      dailyRetentionDays: 400,
    },
  } as Config;
  const fields = storageFieldPresentation(config.storage ?? {});
  assert.deepEqual(
    fields.map(({ key, label, value, min, step }) => ({ key, label, value, min, step })),
    [
      { key: 'flushIntervalMs', label: '记录刷新间隔（毫秒）', value: 250, min: 1, step: 1 },
      { key: 'batchSize', label: '记录批量大小', value: 100, min: 1, step: 1 },
      { key: 'requestRetentionDays', label: '请求记录保留天数', value: 30, min: 1, step: 1 },
      { key: 'minuteRetentionDays', label: '分钟汇总保留天数', value: 7, min: 1, step: 1 },
      { key: 'hourRetentionDays', label: '小时汇总保留天数', value: 90, min: 1, step: 1 },
      { key: 'dailyRetentionDays', label: '日汇总保留天数', value: 400, min: 1, step: 1 },
    ],
  );
});

test('renders both databases from the nested /system payload with connection status and capacity metrics', () => {
  const payload = {
    control: {
      health: { status: 'available', scope: 'connection', reason: null },
      capacity: {
        pageCount: 12,
        pageSizeBytes: 4096,
        freePages: 2,
        allocatedBytes: 49152,
        freeBytes: 8192,
        reason: null,
      },
    },
    telemetry: {
      health: { status: 'unavailable', scope: 'connection', reason: 'database_not_configured' },
      capacity: {
        pageCount: null,
        pageSizeBytes: null,
        freePages: null,
        allocatedBytes: null,
        freeBytes: null,
        reason: 'database_not_configured',
      },
    },
  };
  const html = renderToStaticMarkup(createElement(DatabaseStatusPanel, { databases: payload }));
  assert.match(html, /数据库状态/);
  assert.match(html, /控制数据库/);
  assert.match(html, /遥测数据库/);
  assert.match(html, /连接状态：<\/span><span class="badge good">连接正常/);
  assert.match(html, /连接状态：<\/span><span class="badge warn">连接不可用/);
  assert.match(html, /容量页数/);
  assert.match(html, /估算占用（字节）/);
  assert.match(html, /连接原因：<\/span>尚未配置数据库/);
  assert.match(html, /容量说明：<\/span>尚未配置数据库/);
  assert.doesNotMatch(html, /完整性|quickCheck|scope|database_not_configured/);
});

test('database panel ignores paths and makes no integrity claim from connection status', () => {
  const payload = {
    telemetry: {
      health: { status: 'unavailable', scope: 'connection', reason: 'connection_closed' },
      capacity: {
        pageCount: null,
        pageSizeBytes: null,
        freePages: null,
        allocatedBytes: null,
        freeBytes: null,
        reason: 'connection_closed',
      },
      path: '/private/database.sqlite',
    },
  };
  const html = renderToStaticMarkup(createElement(DatabaseStatusPanel, { databases: payload }));
  assert.match(html, /遥测数据库/);
  assert.match(html, /连接不可用/);
  assert.match(html, /数据库连接已关闭/);
  assert.doesNotMatch(html, /private|database\.sqlite|完整性|正常/);
});

test('localizes every database diagnostic reason code', () => {
  const reasons = [
    ['connection_unavailable', '数据库连接不可用'],
    ['connection_closed', '数据库连接已关闭'],
    ['ping_failed', '数据库连接检测失败'],
    ['database_not_configured', '尚未配置数据库'],
    ['sqlite_metrics_unavailable', '暂时无法读取 SQLite 容量指标'],
  ] as const;
  for (const [reason, label] of reasons) {
    const payload = {
      control: {
        health: {
          status: reason === 'sqlite_metrics_unavailable' ? 'available' : 'unavailable',
          scope: 'connection',
          reason: reason === 'sqlite_metrics_unavailable' ? null : reason,
        },
        capacity: {
          pageCount: null,
          pageSizeBytes: null,
          freePages: null,
          allocatedBytes: null,
          freeBytes: null,
          reason,
        },
      },
    };
    const html = renderToStaticMarkup(createElement(DatabaseStatusPanel, { databases: payload }));
    assert.ok(html.includes(label), `expected localized label for ${reason}`);
    assert.equal(html.includes(reason), false);
  }
});
