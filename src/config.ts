import { ConfigurationError } from './core/errors.ts';
import { parseShardAssignment } from './core/sharding.ts';
import { DEFAULT_LOCALE, normalizeLocale } from './i18n/index.ts';

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WEAK_NODELINK_PASSWORDS = new Set(['youshallnotpass', 'changeme', 'change-me', 'password']);

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBool(value: unknown, fallback = false): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRatio(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function ensureUrlScheme(value: unknown, fallbackScheme: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `${fallbackScheme}://${trimmed.replace(/^\/+/, '')}`;
}

function stripTrailingSlashes(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const normalized = pathname.replace(/\/+$/g, '');
  return normalized || '/';
}

function normalizeApiBase(value: unknown): string {
  const fallback = 'https://api.fluxer.app/v1';
  if (!value) return fallback;

  const candidate = ensureUrlScheme(value, 'https');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'app.fluxer.app' || host === 'web.fluxer.app') {
    return fallback;
  }

  parsed.hash = '';
  const path = stripTrailingSlashes(parsed.pathname);
  if (host === 'api.fluxer.app') {
    if (path === '/' || path.toLowerCase() === '/api' || path.toLowerCase() === '/api/v1') {
      parsed.pathname = '/v1';
    } else {
      parsed.pathname = path;
    }
  } else {
    parsed.pathname = path === '/' ? '' : path;
  }

  return parsed.toString().replace(/\/$/, '');
}

function normalizeGatewayUrl(value: unknown): string {
  const fallback = 'wss://gateway.fluxer.app';
  if (!value) return fallback;

  const candidate = ensureUrlScheme(value, 'wss');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'app.fluxer.app' || host === 'api.fluxer.app' || host === 'web.fluxer.app') {
    return fallback;
  }

  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';

  parsed.hash = '';
  parsed.pathname = stripTrailingSlashes(parsed.pathname);

  return parsed.toString().replace(/\/$/, '');
}

function normalizeNodeLinkBaseUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const candidate = ensureUrlScheme(raw, 'http');
  try {
    return new URL(candidate).toString().replace(/\/$/, '');
  } catch {
    throw new ConfigurationError('NODELINK_BASE_URL must be a valid http(s) URL');
  }
}

function normalizeDnsResultOrder(value: unknown): 'ipv4first' | 'verbatim' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'ipv4first';
  if (normalized === 'ipv4first' || normalized === 'verbatim') return normalized;
  throw new ConfigurationError('DNS_RESULT_ORDER must be one of: ipv4first, verbatim');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const token = env.BOT_TOKEN?.trim();
  if (!token) {
    throw new ConfigurationError('Missing environment variable BOT_TOKEN');
  }

  const prefix = (env.PREFIX ?? '!').trim() || '!';
  const logLevel = (env.LOG_LEVEL ?? 'info').toLowerCase();

  const config = {
    token,
    prefix,
    logLevel,
    apiBase: normalizeApiBase(env.API_BASE),
    gatewayUrl: normalizeGatewayUrl(env.GATEWAY_URL),
    fluxerCdnBase: env.FLUXER_CDN_BASE?.trim().replace(/\/+$/, '') || null,
    gatewayIntents: parseNonNegativeInt(env.GATEWAY_INTENTS, 0),
    ...parseShardAssignment(env.SHARD_ID, env.SHARD_COUNT),
    gatewayPresenceEnabled: parseBool(env.GATEWAY_PRESENCE_ENABLED, false),
    dnsResultOrder: normalizeDnsResultOrder(env.DNS_RESULT_ORDER),
    allowPrivateMediaUrls: parseBool(env.ALLOW_PRIVATE_MEDIA_URLS, false),
    nowPlayingCardEnabled: parseBool(env.NOW_PLAYING_CARD_ENABLED, true),
    autoGatewayUrl: parseBool(env.AUTO_GATEWAY_URL, true),
    gatewayOnlyMode: parseBool(env.GATEWAY_ONLY_MODE, false),
    strictStartupCheck: parseBool(env.STRICT_STARTUP_CHECK, false),
    enableEmbeds: parseBool(env.ENABLE_EMBEDS, true),
    allowDefaultPrefixFallback: parseBool(env.ALLOW_DEFAULT_PREFIX_FALLBACK, false),

    apiCheckRetries: parsePositiveInt(env.API_CHECK_RETRIES, 5),
    apiCheckDelayMs: parsePositiveInt(env.API_CHECK_DELAY_MS, 1_000),

    restTimeoutMs: parsePositiveInt(env.REST_TIMEOUT_MS, 10_000),
    restMaxRetries: parsePositiveInt(env.REST_MAX_RETRIES, 4),
    restRetryBaseDelayMs: parsePositiveInt(env.REST_RETRY_BASE_DELAY_MS, 300),

    sessionIdleMs: parsePositiveInt(env.SESSION_IDLE_MS, 5 * 60_000),
    maxConcurrentVoiceChannelsPerGuild: parsePositiveInt(env.MAX_CONCURRENT_VOICE_CHANNELS_PER_GUILD, 5),
    sessionSnapshotMinWriteIntervalMs: parsePositiveInt(env.SESSION_SNAPSHOT_MIN_WRITE_INTERVAL_MS, 10_000),
    sessionSnapshotFlushIntervalMs: parsePositiveInt(env.SESSION_SNAPSHOT_FLUSH_INTERVAL_MS, 30_000),
    sessionSnapshotMaxPendingTracks: parsePositiveInt(env.SESSION_SNAPSHOT_MAX_PENDING_TRACKS, 25),
    maxQueueSize: parsePositiveInt(env.MAX_QUEUE_SIZE, 100),
    maxTrackLengthHours: parsePositiveInt(env.MAX_TRACK_LENGTH_HOURS, 6),
    maxPlaylistTracks: parsePositiveInt(env.MAX_PLAYLIST_TRACKS, 25),
    maxSavedPlaylistsPerGuild: parsePositiveInt(env.MAX_SAVED_PLAYLISTS_PER_GUILD, 100),
    maxSavedTracksPerPlaylist: parsePositiveInt(env.MAX_SAVED_TRACKS_PER_PLAYLIST, 500),
    maxFavoritesPerUser: parsePositiveInt(env.MAX_FAVORITES_PER_USER, 500),
    persistentHistorySize: parsePositiveInt(env.PERSISTENT_HISTORY_SIZE, 200),
    defaultVolumePercent: parsePositiveInt(env.DEFAULT_VOLUME_PERCENT, 100),
    maxVolumePercent: parsePositiveInt(env.MAX_VOLUME_PERCENT, 200),
    minVolumePercent: parseNonNegativeInt(env.MIN_VOLUME_PERCENT, 0),
    voiceMaxBitrate: parsePositiveInt(env.VOICE_MAX_BITRATE, 192_000),
    voiceConnectTimeoutMs: parsePositiveInt(env.VOICE_CONNECT_TIMEOUT_MS, 8_000),

    mongoUri: env.MONGODB_URI?.trim() || null,
    mongoDb: env.MONGODB_DB?.trim() || 'fluxer_music_bot',
    mongoMaxPoolSize: parsePositiveInt(env.MONGODB_MAX_POOL_SIZE, 20),
    mongoMinPoolSize: parseNonNegativeInt(env.MONGODB_MIN_POOL_SIZE, 5),
    mongoConnectTimeoutMs: parsePositiveInt(env.MONGODB_CONNECT_TIMEOUT_MS, 10_000),
    mongoServerSelectionTimeoutMs: parsePositiveInt(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10_000),
    mongoPingIntervalMs: parsePositiveInt(env.MONGODB_PING_INTERVAL_MS, 15_000),
    guildConfigCacheTtlMs: parsePositiveInt(env.GUILD_CONFIG_CACHE_TTL_MS, 60_000),
    guildConfigCacheMaxSize: parsePositiveInt(env.GUILD_CONFIG_CACHE_MAX_SIZE, 5_000),

    autoplayDefaultEnabled: parseBool(env.AUTOPLAY_DEFAULT_ENABLED, false),

    ffmpegBin: env.FFMPEG_BIN?.trim() || null,

    defaultLanguage: normalizeLocale(env.DEFAULT_LANGUAGE) ?? DEFAULT_LOCALE,
    defaultDedupeEnabled: parseBool(env.DEFAULT_DEDUPE_ENABLED, false),
    defaultStayInVoiceEnabled: parseBool(env.DEFAULT_247_ENABLED, false),
    voteSkipRatio: parseRatio(env.VOTE_SKIP_RATIO, 0.5),
    voteSkipMinVotes: parsePositiveInt(env.VOTE_SKIP_MIN_VOTES, 2),

    nodeLinkBaseUrl: normalizeNodeLinkBaseUrl(env.NODELINK_BASE_URL),
    nodeLinkPassword: env.NODELINK_PASSWORD?.trim() || null,
    nodeLinkDefaultSearch: env.NODELINK_DEFAULT_SEARCH?.trim() || 'search',
    nodeLinkMirrorSearchOrder: env.NODELINK_MIRROR_SEARCH_ORDER?.trim()
      || 'dzsearch,tdsearch,scsearch,ytsearch,ytmsearch',
    nodeLinkRequestTimeoutMs: parsePositiveInt(env.NODELINK_REQUEST_TIMEOUT_MS, 15_000),
    nodeLinkStreamStartTimeoutMs: parsePositiveInt(env.NODELINK_STREAM_START_TIMEOUT_MS, 10_000),
    playCommandCooldownMs: parseNonNegativeInt(env.PLAY_COMMAND_COOLDOWN_MS, 2_000),
    searchResultLimit: parsePositiveInt(env.SEARCH_RESULT_LIMIT, 5),
    searchPickTimeoutMs: parsePositiveInt(env.SEARCH_PICK_TIMEOUT_MS, 45_000),
    playbackDiagnosticsEnabled: parseBool(env.PLAYBACK_DIAGNOSTICS_ENABLED, false),
    playbackDiagnosticsIntervalMs: parsePositiveInt(env.PLAYBACK_DIAGNOSTICS_INTERVAL_MS, 1_000),
    memoryTelemetryIntervalMs: parsePositiveInt(env.MEMORY_TELEMETRY_INTERVAL_MS, 15_000),
    memoryTelemetryLogIntervalMs: parseNonNegativeInt(env.MEMORY_TELEMETRY_LOG_INTERVAL_MS, 300_000),
    memoryRssExitMb: parseNonNegativeInt(env.MEMORY_RSS_EXIT_MB, 0),
    audioThreadIdleRestart: parseNonNegativeInt(env.AUDIO_THREAD_IDLE_RESTART, 150),
    audioThreadRestart: parseNonNegativeInt(env.AUDIO_THREAD_RESTART, 400),
    heapSnapshotSignalEnabled: parseBool(env.HEAP_SNAPSHOT_SIGNAL_ENABLED, true),
    heapSnapshotDir: env.HEAP_SNAPSHOT_DIR?.trim() || '.heap-snapshots',

    commandRateLimitEnabled: parseBool(env.COMMAND_RATE_LIMIT_ENABLED, true),
    commandUserWindowMs: parsePositiveInt(env.COMMAND_USER_WINDOW_MS, 10_000),
    commandUserMax: parsePositiveInt(env.COMMAND_USER_MAX, 8),
    commandGuildWindowMs: parsePositiveInt(env.COMMAND_GUILD_WINDOW_MS, 10_000),
    commandGuildMax: parsePositiveInt(env.COMMAND_GUILD_MAX, 40),
    commandRateLimitBypass: String(env.COMMAND_RATE_LIMIT_BYPASS ?? 'help,ping')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),

    monitoringEnabled: parseBool(env.MONITORING_ENABLED, true),
    monitoringHost: (env.MONITORING_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
    monitoringPort: parsePositiveInt(env.MONITORING_PORT, 9091),
    unhealthyExitEnabled: parseBool(env.UNHEALTHY_EXIT_ENABLED, true),
    unhealthyExitAfterMs: parsePositiveInt(env.UNHEALTHY_EXIT_AFTER_MS, 180_000),
    gatewayOutageExitAfterMs: parsePositiveInt(env.GATEWAY_OUTAGE_EXIT_AFTER_MS, 1_800_000),
    unhealthyCheckIntervalMs: parsePositiveInt(env.UNHEALTHY_CHECK_INTERVAL_MS, 5_000),

    errorChannelId: /^\d{6,}$/.test(env.ERROR_CHANNEL_ID?.trim() ?? '') ? env.ERROR_CHANNEL_ID!.trim() : null,
  };

  if (!config.mongoUri) {
    throw new ConfigurationError('Missing environment variable MONGODB_URI');
  }

  if (config.minVolumePercent > config.maxVolumePercent) {
    throw new ConfigurationError('MIN_VOLUME_PERCENT cannot be greater than MAX_VOLUME_PERCENT');
  }

  if (config.defaultVolumePercent < config.minVolumePercent || config.defaultVolumePercent > config.maxVolumePercent) {
    throw new ConfigurationError('DEFAULT_VOLUME_PERCENT is out of configured volume bounds');
  }

  if (config.searchResultLimit > 10) {
    throw new ConfigurationError('SEARCH_RESULT_LIMIT must be <= 10');
  }

  if (!config.nodeLinkBaseUrl) {
    throw new ConfigurationError('Missing environment variable NODELINK_BASE_URL (NodeLink is required in this build)');
  }

  if (!config.nodeLinkPassword) {
    throw new ConfigurationError('Missing environment variable NODELINK_PASSWORD');
  }

  if (WEAK_NODELINK_PASSWORDS.has(config.nodeLinkPassword.toLowerCase()) || config.nodeLinkPassword.length < 16) {
    throw new ConfigurationError('NODELINK_PASSWORD is a well-known default or shorter than 16 characters; generate a random one');
  }

  return Object.freeze(config);
}

export type AppConfig = ReturnType<typeof loadConfig>;


