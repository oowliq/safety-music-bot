import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';

function buildEnv(overrides: Record<string, string> = {}) {
  return {
    BOT_TOKEN: 'test-token',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
    NODELINK_BASE_URL: 'http://nodelink:3000',
    NODELINK_PASSWORD: 'a-long-random-test-password',
    ...overrides,
  };
}

test('loadConfig normalizes Fluxer API/Gateway URLs and intents', () => {
  const config = loadConfig(buildEnv({
    API_BASE: 'api.fluxer.app',
    GATEWAY_URL: 'https://gateway.fluxer.app/',
    GATEWAY_INTENTS: '513',
  }));

  assert.equal(config.apiBase, 'https://api.fluxer.app/v1');
  assert.equal(config.gatewayUrl, 'wss://gateway.fluxer.app');
  assert.equal(config.gatewayIntents, 513);
});

test('loadConfig falls back to official API base for app/web URLs', () => {
  const config = loadConfig(buildEnv({
    API_BASE: 'https://app.fluxer.app/api',
    GATEWAY_URL: 'https://app.fluxer.app/gateway',
  }));

  assert.equal(config.apiBase, 'https://api.fluxer.app/v1');
  assert.equal(config.gatewayUrl, 'wss://gateway.fluxer.app');
});

test('loadConfig enables unhealthy-exit watchdog by default', () => {
  const config = loadConfig(buildEnv());

  assert.equal(config.unhealthyExitEnabled, true);
  assert.equal(config.unhealthyExitAfterMs, 180000);
  assert.equal(config.gatewayOutageExitAfterMs, 1800000);
  assert.equal(config.unhealthyCheckIntervalMs, 5000);
});

test('loadConfig disables gateway presence updates by default', () => {
  const defaultConfig = loadConfig(buildEnv());
  const enabledConfig = loadConfig(buildEnv({
    GATEWAY_PRESENCE_ENABLED: '1',
  }));

  assert.equal(defaultConfig.gatewayPresenceEnabled, false);
  assert.equal(enabledConfig.gatewayPresenceEnabled, true);
});

test('loadConfig enables memory telemetry defaults and heap snapshot signal', () => {
  const config = loadConfig(buildEnv());

  assert.equal(config.memoryTelemetryIntervalMs, 15000);
  assert.equal(config.memoryTelemetryLogIntervalMs, 300000);
  assert.equal(config.memoryRssExitMb, 0);
  assert.equal(config.heapSnapshotSignalEnabled, true);
  assert.equal(config.heapSnapshotDir, '.heap-snapshots');
});

test('loadConfig accepts optional RSS exit threshold', () => {
  const config = loadConfig(buildEnv({
    MEMORY_RSS_EXIT_MB: '1536',
  }));

  assert.equal(config.memoryRssExitMb, 1536);
});

test('loadConfig requires NodeLink (base URL and password)', () => {
  assert.throws(
    () => loadConfig(buildEnv({ NODELINK_BASE_URL: '' })),
    /NODELINK_BASE_URL/
  );
  assert.throws(
    () => loadConfig(buildEnv({ NODELINK_PASSWORD: '' })),
    /NODELINK_PASSWORD/
  );
});

test('loadConfig rejects well-known or short NodeLink passwords', () => {
  assert.throws(
    () => loadConfig(buildEnv({ NODELINK_PASSWORD: 'youshallnotpass' })),
    /NODELINK_PASSWORD is a well-known default/
  );
  assert.throws(
    () => loadConfig(buildEnv({ NODELINK_PASSWORD: 'short' })),
    /NODELINK_PASSWORD is a well-known default/
  );
});

test('loadConfig binds the monitoring server to localhost by default', () => {
  assert.equal(loadConfig(buildEnv()).monitoringHost, '127.0.0.1');
});

test('loadConfig no longer exposes removed integrations', () => {
  const config = loadConfig(buildEnv({
    DASHBOARD_API_ENABLED: '1',
    SENTRY_DSN: 'https://example.invalid/1',
    YTDLP_COOKIES_FILE: '/tmp/cookies.txt',
    LASTFM_ENABLED: '1',
    FLUXERLIST_STATS_ENABLED: '1',
  })) as Record<string, unknown>;
  for (const key of ['dashboardApiEnabled', 'sentryDsn', 'ytdlpCookiesFile', 'lastfmEnabled', 'fluxerlistStatsEnabled', 'auddApiToken', 'deezerArl']) {
    assert.equal(key in config, false, key);
  }
});
