import {
  AudioFrame,
  AudioSource,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
export const FRAME_DURATION_MS = 40;
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;
const SAMPLES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;
const STATS_TIMEOUT_MS = 750;
const TARGET_QUEUE_MS = 600;
const MAX_QUEUE_MS = 1200;
const QUEUE_REFILL_HEADROOM_MS = 120;
const PUMP_IDLE_WAIT_MS = 5;
const CAPTURE_FRAME_MAX_RETRIES = 12;
const CAPTURE_FRAME_RETRY_DELAY_MS = 20;
const VOICE_STATE_RESET_SETTLE_MS = 400;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const GATEWAY_RECOVERY_MAX_WAIT_MS = 30 * 60_000;
const GATEWAY_RECOVERY_POLL_MS = 1_000;
const GATEWAY_RECOVERY_SETTLE_MIN_MS = 3_000;
const GATEWAY_RECOVERY_SETTLE_MAX_MS = 15_000;
const PLAYBACK_DRAIN_MAX_WAIT_MS = 3_000;
const PLAYBACK_DRAIN_POLL_MS = 20;

export const GATEWAY_OFFLINE_MESSAGE = 'Gateway socket is not open, voice join was not sent.';

export function toVoiceRoomUrl(endpoint: string): string {
  const trimmed = String(endpoint ?? '').trim();
  if (!trimmed) return trimmed;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!scheme) return `wss://${trimmed}`;

  const name = String(scheme[1]).toLowerCase();
  if (name === 'ws' || name === 'wss') return trimmed;

  const rest = trimmed.slice(scheme[0].length);
  return name === 'http' ? `ws://${rest}` : `wss://${rest}`;
}

type VoiceConnectionOptions = {
  logger?: {
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    info?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  } | null;
  connectTimeoutMs?: number;
  voiceMaxBitrate?: number;
  autoReconnectEnabled?: boolean;
  hasSiblingConnections?: (() => boolean) | null;
};

type VoiceServerUpdate = {
  guild_id?: string;
  channel_id?: string;
  connection_id?: string;
  endpoint?: string;
  token?: string;
};

type GatewayConnectionState = {
  socketOpen: boolean;
  readyState: number | null;
  hasSession: boolean;
  reconnectAttempts: number;
  heartbeatLatencyMs: number | null;
};

type GatewayLike = {
  joinVoice: (
    guildId: string,
    channelId: string,
    options?: { selfDeaf?: boolean; connectionId?: string | null },
  ) => boolean | void;
  leaveVoice: (guildId: string, connectionId?: string | null) => boolean | void;
  describeConnectionState?: () => GatewayConnectionState;
  on: (event: string, listener: (data: VoiceServerUpdate) => void) => void;
  off: (event: string, listener: (data: VoiceServerUpdate) => void) => void;
};

type PcmReadableLike = AsyncIterable<unknown> & {
  destroy?: (error?: Error) => void;
  pause?: () => void;
  resume?: () => void;
};

type PeerConnectionLike = {
  getStats?: () => Promise<unknown> | unknown;
};

type StatsRowLike = {
  type?: string;
  kind?: string;
  mediaType?: string;
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
  roundTripTime?: number;
  jitter?: number;
};

type PumpStats = {
  startedAtMs: number | null;
  bytesIn: number;
  framesCaptured: number;
  concealedFrames: number;
  maxQueuedDurationMs: number;
  backpressureWaits: number;
  pendingBufferBytes: number;
};

type FfiClientEmitterLike = {
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type DisposableHandleLike = {
  dispose?: () => void;
};

type InternalPublicationLike = {
  ffiHandle?: DisposableHandleLike;
  track?: { ffi_handle?: DisposableHandleLike } | null;
};

type InternalParticipantLike = {
  ffi_handle?: DisposableHandleLike;
  trackPublications?: Map<unknown, InternalPublicationLike>;
};

type InternalRoomLike = {
  onFfiEvent?: ((...args: unknown[]) => void) | null;
  preConnectEvents?: unknown[];
  removeAllListeners?: (event?: string) => unknown;
  ffiHandle?: DisposableHandleLike | undefined;
  localParticipant?: InternalParticipantLike | null;
  remoteParticipants?: Map<unknown, InternalParticipantLike>;
};

function disposeHandle(handle: DisposableHandleLike | undefined) {
  if (typeof handle?.dispose !== 'function') return;
  try {
    handle.dispose();
  } catch {
    return;
  }
}

function disposeParticipantHandles(participant: InternalParticipantLike | null | undefined, includeTracks: boolean) {
  if (!participant) return;
  const publications = participant.trackPublications;
  for (const publication of publications?.values() ?? []) {
    if (includeTracks) {
      disposeHandle(publication?.track?.ffi_handle);
    }
    disposeHandle(publication?.ffiHandle);
  }
  publications?.clear();
  disposeHandle(participant.ffi_handle);
}

export class VoiceConnection {
  [key: string]: unknown;
  gateway: GatewayLike;
  guildId: string;
  channelId: string | null;
  connectionId: string | null;
  hasSiblingConnections: (() => boolean) | null;
  logger: VoiceConnectionOptions['logger'];
  connectTimeoutMs: number;
  voiceMaxBitrate: number;
  room: Room | null;
  connectingPromise: Promise<void> | null;
  audioSource: AudioSource | null;
  audioTrack: LocalAudioTrack | null;
  audioTrackSid: string | null;
  currentAudioStream: PcmReadableLike | null;
  audioPumpToken: number;
  playbackPaused: boolean;
  pauseWaiters: Array<() => void>;
  _transportStatsState: { bytesSent: number; tsMs: number } | null;
  _pumpStats: PumpStats;
  _pumpStatsSample: { tsMs: number; bytesIn: number; framesCaptured: number } | null;
  roomDisconnectedListener: ((reason?: unknown) => void) | null;
  roomParticipantDisconnectedListener: ((participant: unknown) => void) | null;
  onAudioPumpFatalError: (() => void) | null;
  onReconnected: (() => void) | null;
  onReconnectFailed: ((lastError: unknown, channelId: string) => void) | null;
  autoReconnectEnabled: boolean;
  _hasConnectedBefore: boolean;
  _needsVoiceStateReset: boolean;
  _reconnectToken: number;
  _reconnectInProgress: boolean;
  _reconnectMaxAttempts: number;
  _reconnectBaseDelayMs: number;
  _reconnectMaxDelayMs: number;
  _gatewayRecoveryMaxWaitMs: number;
  _gatewayRecoveryPollMs: number;
  _gatewayRecoverySettleMinMs: number;
  _gatewayRecoverySettleMaxMs: number;
  constructor(gateway: GatewayLike, guildId: string, options: VoiceConnectionOptions = {}) {
    this.gateway = gateway;
    this.guildId = guildId;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.voiceMaxBitrate = Number.isFinite(options.voiceMaxBitrate)
      ? Math.max(24_000, Math.min(320_000, Math.trunc(options.voiceMaxBitrate ?? 192_000)))
      : 192_000;

    this.room = null;
    this.connectingPromise = null;
    this.channelId = null;
    this.connectionId = null;
    this.hasSiblingConnections = options.hasSiblingConnections ?? null;
    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;

    this.currentAudioStream = null;
    this.audioPumpToken = 0;
    this.playbackPaused = false;
    this.pauseWaiters = [];
    this._transportStatsState = null;
    this._pumpStats = this._createPumpStats();
    this._pumpStatsSample = null;
    this.roomDisconnectedListener = null;
    this.roomParticipantDisconnectedListener = null;
    this.onAudioPumpFatalError = null;

    this.onReconnected = null;
    this.onReconnectFailed = null;
    this.autoReconnectEnabled = options.autoReconnectEnabled !== false;
    this._hasConnectedBefore = false;
    this._needsVoiceStateReset = false;
    this._reconnectToken = 0;
    this._reconnectInProgress = false;
    this._reconnectMaxAttempts = RECONNECT_MAX_ATTEMPTS;
    this._reconnectBaseDelayMs = RECONNECT_BASE_DELAY_MS;
    this._reconnectMaxDelayMs = RECONNECT_MAX_DELAY_MS;
    this._gatewayRecoveryMaxWaitMs = GATEWAY_RECOVERY_MAX_WAIT_MS;
    this._gatewayRecoveryPollMs = GATEWAY_RECOVERY_POLL_MS;
    this._gatewayRecoverySettleMinMs = GATEWAY_RECOVERY_SETTLE_MIN_MS;
    this._gatewayRecoverySettleMaxMs = GATEWAY_RECOVERY_SETTLE_MAX_MS;
  }

  get connected() {
    return Boolean(this.room?.isConnected);
  }

  get isStreaming() {
    return Boolean(this.currentAudioStream);
  }

  async connect(channelId: string) {
    if (!channelId) {
      throw new Error('Missing voice channel id.');
    }

    if (!this._reconnectInProgress) {
      this._cancelAutoReconnect();
    }

    if (this.connected) {
      this.channelId = channelId;
      this._syncVoiceDeafState();
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    const attempt = this._connect(channelId).finally(() => {
      this.connectingPromise = null;
    });
    this.connectingPromise = attempt;
    return attempt;
  }

  async _discardStaleRoom() {
    const room = this.room;
    if (!room) return false;
    this._detachRoomListeners();
    await room.disconnect?.().catch(() => null);
    this._detachRoomFfiListener(room);
    this._resetRoomPreConnectEvents(room);
    this._disposeRoomHandles(room);
    room.removeAllListeners?.();
    await this._closeAudioResources();
    this.room = null;
    return true;
  }

  _resetGatewayVoiceState() {
    try {
      this._releaseGatewayVoiceState();
    } catch (err) {
      this.logger?.debug?.('Releasing the gateway voice state failed', {
        guildId: this.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  _releaseGatewayVoiceState() {
    const connectionId = this.connectionId;
    this.connectionId = null;

    if (connectionId) {
      this.gateway.leaveVoice(this.guildId, connectionId);
      return;
    }

    if (this.hasSiblingConnections?.() === true) {
      this.logger?.debug?.('Skipped a guild-wide voice leave to keep sibling connections alive', {
        guildId: this.guildId,
        channelId: this.channelId,
      });
      return;
    }

    this.gateway.leaveVoice(this.guildId);
  }

  async _connect(channelId: string) {
    const hadStaleRoom = await this._discardStaleRoom();

    if (hadStaleRoom || this._needsVoiceStateReset) {
      this._resetGatewayVoiceState();
      await new Promise<void>((resolve) => setTimeout(resolve, VOICE_STATE_RESET_SETTLE_MS));
    }

    this._needsVoiceStateReset = true;
    const joinSent = this.gateway.joinVoice(this.guildId, channelId, {
      selfDeaf: true,
    });

    if (joinSent === false) {
      this._needsVoiceStateReset = false;
      this.logger?.warn?.('Voice join was not sent because the gateway socket is not open', {
        guildId: this.guildId,
        channelId,
        ...(this.gateway.describeConnectionState?.() ?? {}),
      });
      throw new Error(GATEWAY_OFFLINE_MESSAGE);
    }

    let update: VoiceServerUpdate;
    try {
      update = await this._waitForVoiceServer(channelId);
    } catch (err) {
      this._resetGatewayVoiceState();
      throw err;
    }

    this.connectionId = update.connection_id ?? null;
    const endpoint = update.endpoint;
    const token = update.token;

    if (!endpoint || !token) {
      this._resetGatewayVoiceState();
      throw new Error('Voice server response is missing endpoint or token.');
    }

    const roomUrl = toVoiceRoomUrl(endpoint);

    const room = new Room();
    this.room = room;
    this._attachRoomListeners(room);

    try {
      await room.connect(roomUrl, token, {
        autoSubscribe: false,
        dynacast: false,
      });
      this.channelId = channelId;
      await this._ensureAudioTrack();
    } catch (err) {
      await this._cleanupFailedConnect(room);
      this._resetGatewayVoiceState();
      throw this._describeConnectFailure(err, endpoint, roomUrl);
    }

    const wasConnectedBefore = this._hasConnectedBefore;
    this._hasConnectedBefore = true;

    this.logger?.info?.('Voice connection established', {
      guildId: this.guildId,
      endpoint,
    });

    if (wasConnectedBefore) {
      try {
        this.onReconnected?.();
      } catch {
        // resume hook failures must not break the connect path
      }
    }
  }

  async forceRejoin(channelId: string) {
    this._cancelAutoReconnect();
    this.connectionId = null;
    this._needsVoiceStateReset = false;
    await this._discardStaleRoom();
    this.channelId = channelId;
    await this._runAutoReconnect(channelId);
  }

  async disconnect() {
    this._cancelAutoReconnect();
    this._stopAudioPump();
    this._releaseGatewayVoiceState();

    const room = this.room;
    this._detachRoomListeners();
    await room?.disconnect().catch(() => null);
    this._detachRoomFfiListener(room);
    this._resetRoomPreConnectEvents(room);
    this._disposeRoomHandles(room);
    room?.removeAllListeners?.();
    await this._closeAudioResources();

    this.room = null;
    this.channelId = null;
    this._needsVoiceStateReset = false;
  }

  _describeConnectFailure(err: unknown, endpoint: string, roomUrl: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    let host = roomUrl;
    try {
      host = new URL(roomUrl).host || roomUrl;
    } catch {
      host = roomUrl;
    }

    const unresolved = /failed to lookup address information|name or service not known|getaddrinfo/i
      .test(message);

    this.logger?.error?.('Voice connection failed', {
      guildId: this.guildId,
      endpoint,
      host,
      unresolvedHost: unresolved,
      error: message,
    });

    if (!unresolved) return err instanceof Error ? err : new Error(message);

    const hint = `Voice endpoint "${host}" could not be resolved. `
      + 'The media host is chosen by the Fluxer instance, not by this bot, so it has to be '
      + 'resolvable and reachable from inside this container. On a self-hosted instance this is '
      + 'usually an internal or unroutable hostname; check the voice server configuration there '
      + 'and verify with: docker compose exec app getent hosts '
      + host.replace(/:\d+$/, '');
    const wrapped = new Error(`${hint} (${message})`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }

  async _cleanupFailedConnect(room: Room) {
    this._stopAudioPump();
    this._detachRoomListeners();

    try {
      await room.disconnect();
    } catch {
      // ignore failed room teardown during connect rollback
    }

    this._detachRoomFfiListener(room);
    this._resetRoomPreConnectEvents(room);
    this._disposeRoomHandles(room);
    room.removeAllListeners?.();
    await this._closeAudioResources();

    try {
      this._releaseGatewayVoiceState();
    } catch {
      // ignore gateway leave failures during connect rollback
    }

    this.room = null;
    this.channelId = null;
  }

  _cancelAutoReconnect() {
    this._reconnectToken += 1;
    this._reconnectInProgress = false;
  }

  _handleUnexpectedRoomDisconnect(room: Room, reason?: unknown) {
    if (this.room !== room) return;

    const channelId = this.channelId;
    const willReconnect = Boolean(this.autoReconnectEnabled && channelId);

    this.logger?.warn?.('Voice room disconnected', {
      guildId: this.guildId,
      channelId,
      willReconnect,
      reason: typeof reason === 'number' ? DisconnectReason[reason] ?? reason : null,
    });

    if (!willReconnect) return;

    void this._runAutoReconnect(channelId!);
  }

  async _runAutoReconnect(channelId: string) {
    if (this._reconnectInProgress) return;

    this._reconnectToken += 1;
    const token = this._reconnectToken;
    this._reconnectInProgress = true;

    this._stopAudioPump();
    await this._closeAudioResources();

    try {
      const gatewayWaitDeadline = Date.now() + this._gatewayRecoveryMaxWaitMs;
      let gaveUpWaitingForGateway = false;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= this._reconnectMaxAttempts; attempt += 1) {
        const delayMs = Math.min(
          this._reconnectBaseDelayMs * 2 ** (attempt - 1),
          this._reconnectMaxDelayMs,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

        if (token !== this._reconnectToken) return;
        if (this.connected) return;

        try {
          await this.connect(channelId);
          if (token !== this._reconnectToken) return;

          this.logger?.info?.('Voice connection restored after unexpected disconnect', {
            guildId: this.guildId,
            channelId,
            attempt,
          });
          return;
        } catch (err) {
          if (token !== this._reconnectToken) return;
          lastError = err;

          if (err instanceof Error && err.message === GATEWAY_OFFLINE_MESSAGE) {
            const recovered = await this._waitForGatewayRecovery(token, gatewayWaitDeadline - Date.now());
            if (token !== this._reconnectToken) return;
            if (!recovered) {
              gaveUpWaitingForGateway = true;
              break;
            }
            attempt -= 1;
            continue;
          }

          this.logger?.warn?.('Voice reconnect attempt failed', {
            guildId: this.guildId,
            channelId,
            attempt,
            maxAttempts: this._reconnectMaxAttempts,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (token !== this._reconnectToken) return;

      this.logger?.error?.('Voice reconnect gave up', {
        guildId: this.guildId,
        channelId,
        attempts: this._reconnectMaxAttempts,
        reason: gaveUpWaitingForGateway ? 'gateway_unavailable' : 'attempts_exhausted',
      });
      this._notifyReconnectFailed(lastError, channelId);
    } finally {
      if (token === this._reconnectToken) {
        this._reconnectInProgress = false;
      }
    }
  }

  _isGatewayReady() {
    const state = this.gateway.describeConnectionState?.();
    return Boolean(state?.socketOpen && state.hasSession && state.reconnectAttempts === 0);
  }

  async _waitForGatewayRecovery(token: number, maxWaitMs: number): Promise<boolean> {
    if (maxWaitMs <= 0) return false;

    this.logger?.warn?.('Voice reconnect is waiting for the gateway to come back', {
      guildId: this.guildId,
      channelId: this.channelId,
      maxWaitMs,
    });

    const recovered = await new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(poll);
        this.gateway.off('READY', onRecovered);
        this.gateway.off('RESUMED', onRecovered);
        resolve(value);
      };
      const onRecovered = () => finish(true);
      const deadline = setTimeout(() => finish(false), maxWaitMs);
      const poll = setInterval(() => {
        if (token !== this._reconnectToken) finish(false);
        else if (this._isGatewayReady()) finish(true);
      }, this._gatewayRecoveryPollMs);
      deadline.unref?.();
      poll.unref?.();
      this.gateway.on('READY', onRecovered);
      this.gateway.on('RESUMED', onRecovered);
    });
    if (!recovered || token !== this._reconnectToken) return false;

    const settleSpanMs = Math.max(0, this._gatewayRecoverySettleMaxMs - this._gatewayRecoverySettleMinMs);
    const settleMs = this._gatewayRecoverySettleMinMs + Math.floor(Math.random() * (settleSpanMs + 1));
    this.logger?.info?.('Gateway is back, rejoining voice', {
      guildId: this.guildId,
      channelId: this.channelId,
      settleMs,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    return token === this._reconnectToken;
  }

  _notifyReconnectFailed(lastError: unknown, channelId: string) {
    const notify = this.onReconnectFailed;
    if (typeof notify !== 'function') return;

    try {
      notify(lastError, channelId);
    } catch (err) {
      this.logger?.error?.('Voice reconnect failure handler threw', {
        guildId: this.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async _closeAudioResources() {
    const source = this.audioSource;
    const track = this.audioTrack;

    this.audioSource = null;
    this.audioTrack = null;
    this.audioTrackSid = null;

    try {
      source?.clearQueue();
    } catch {
      // ignore queue clear errors during teardown
    }

    try {
      await track?.close(false);
    } catch {
      // ignore track teardown failures during disconnect
    }

    try {
      await source?.close();
    } catch {
      // ignore source teardown failures during disconnect
    }
  }

  _attachRoomListeners(room: Room) {
    this._detachRoomListeners();
    const roomLike = room as {
      on?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
    };
    if (typeof roomLike.on !== 'function') return;

    this.roomDisconnectedListener = (reason) => {
      this._handleUnexpectedRoomDisconnect(room, reason);
    };
    this.roomParticipantDisconnectedListener = (participant) => {
      disposeParticipantHandles(participant as InternalParticipantLike | null, true);
    };

    roomLike.on(RoomEvent.Disconnected, this.roomDisconnectedListener);
    roomLike.on(RoomEvent.ParticipantDisconnected, this.roomParticipantDisconnectedListener);
  }

  _detachRoomListeners() {
    const room = this.room as {
      off?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeAllListeners?: (event?: string | number) => unknown;
    } | null;
    if (!room) {
      this.roomDisconnectedListener = null;
      this.roomParticipantDisconnectedListener = null;
      return;
    }

    this._detachSingleRoomListener(room, RoomEvent.Disconnected, this.roomDisconnectedListener);
    this._detachSingleRoomListener(
      room,
      RoomEvent.ParticipantDisconnected,
      this.roomParticipantDisconnectedListener as ((...args: unknown[]) => void) | null,
    );
    this.roomDisconnectedListener = null;
    this.roomParticipantDisconnectedListener = null;
  }

  _detachSingleRoomListener(
    room: {
      off?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
      removeAllListeners?: (event?: string | number) => unknown;
    },
    event: string | number,
    listener: ((...args: unknown[]) => void) | null,
  ) {
    if (!listener) return;
    if (typeof room.off === 'function') {
      room.off(event, listener);
      return;
    }
    if (typeof room.removeListener === 'function') {
      room.removeListener(event, listener);
      return;
    }
    room.removeAllListeners?.(event);
  }

  _detachRoomFfiListener(room: Room | null) {
    const ffiClient = (globalThis as typeof globalThis & {
      _ffiClientInstance?: FfiClientEmitterLike;
    })._ffiClientInstance;
    const listener = (room as unknown as InternalRoomLike | null)?.onFfiEvent;

    if (!ffiClient || typeof listener !== 'function') return;

    if (typeof ffiClient.off === 'function') {
      ffiClient.off('ffi_event', listener);
      return;
    }

    ffiClient.removeListener?.('ffi_event', listener);
  }

  _resetRoomPreConnectEvents(room: Room | null) {
    const internalRoom = room as unknown as InternalRoomLike | null;
    if (!internalRoom || !Array.isArray(internalRoom.preConnectEvents)) return;
    internalRoom.preConnectEvents.length = 0;
  }

  _disposeRoomHandles(room: Room | null) {
    const internalRoom = room as unknown as InternalRoomLike | null;
    if (!internalRoom) return;

    disposeParticipantHandles(internalRoom.localParticipant, false);
    for (const participant of internalRoom.remoteParticipants?.values() ?? []) {
      disposeParticipantHandles(participant, true);
    }
    internalRoom.remoteParticipants?.clear();

    disposeHandle(internalRoom.ffiHandle);
    internalRoom.ffiHandle = undefined;
  }

  _syncVoiceDeafState() {
    if (!this.connected || !this.channelId || !this.connectionId) return;
    try {
      this.gateway.joinVoice(this.guildId, this.channelId, {
        selfDeaf: true,
        connectionId: this.connectionId,
      });
    } catch (err) {
      this.logger?.debug?.('Failed to synchronize voice deaf state', {
        guildId: this.guildId,
        channelId: this.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendAudio(pcmStream: unknown) {
    if (!this.connected) {
      throw new Error('Voice room is not connected.');
    }
    if (!this._isPcmReadableLike(pcmStream)) {
      throw new Error('Audio stream must be async-iterable PCM data.');
    }

    await this._ensureAudioTrack();
    if (!this.audioSource) {
      throw new Error('Audio source is not available.');
    }

    this._stopAudioPump();
    this.currentAudioStream = pcmStream;
    this._pumpStats = this._createPumpStats();
    this._pumpStats.startedAtMs = Date.now();
    this._pumpStatsSample = null;

    const token = ++this.audioPumpToken;
    this._pumpPcmStream(pcmStream, this.audioSource, token).catch((err) => {
      if (this._isExpectedPumpError(err, token)) {
        this.logger?.debug?.('Ignoring expected audio pump shutdown', {
          guildId: this.guildId,
          code: err?.code ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const recoverableCapture = (
        token === this.audioPumpToken
        && this.connected
        && this._isFatalCaptureError(err)
      );

      if (recoverableCapture) {
        this.logger?.warn?.('Audio pump capture error, recovering track', {
          guildId: this.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
        this._handleFatalCaptureError();
        return;
      }

      this.logger?.error?.('Audio pump failed', {
        guildId: this.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  _isClosedSourceError(err: unknown) {
    const maybeError = this._toErrorLike(err);
    const message = String(maybeError?.message ?? err ?? '').toLowerCase();
    return message.includes('audiosource is closed');
  }

  _isFatalCaptureError(err: unknown) {
    const maybeError = this._toErrorLike(err);
    const message = String(maybeError?.message ?? err ?? '').toLowerCase();
    return message.includes('failed to capture frame')
      || message.includes('invalidstate')
      || message.includes('audiosource is closed');
  }

  _handleFatalCaptureError() {
    this.logger?.warn?.('Audio source entered invalid state, resetting track', {
      guildId: this.guildId,
    });

    this._resetAudioTrack()
      .catch((err) => {
        this.logger?.error?.('Failed to reset audio track after capture error', {
          guildId: this.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        const notify = this.onAudioPumpFatalError;
        if (typeof notify !== 'function') return;
        try {
          notify();
        } catch (err) {
          this.logger?.error?.('Audio pump fatal error handler threw', {
            guildId: this.guildId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
  }

  async _resetAudioTrack() {
    this.audioPumpToken += 1;
    this.playbackPaused = false;
    this._flushPauseWaiters();
    this.currentAudioStream = null;
    this._pumpStatsSample = null;
    await this._closeAudioResources();
  }

  stopAudio() {
    this._stopAudioPump();
  }

  async waitForPlaybackDrain(timeoutMs: number = PLAYBACK_DRAIN_MAX_WAIT_MS) {
    const source = this.audioSource;
    const token = this.audioPumpToken;
    if (!source || !this.connected) return;

    const budgetMs = Math.max(0, Number(timeoutMs) || 0);
    const deadline = Date.now() + budgetMs;

    while (this.currentAudioStream && token === this.audioPumpToken && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, PLAYBACK_DRAIN_POLL_MS));
    }

    if (token !== this.audioPumpToken) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve(source.waitForPlayout()).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _waitForVoiceServer(channelId: string | null = null): Promise<VoiceServerUpdate> {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate);
        this.logger?.warn?.('Timed out waiting for VOICE_SERVER_UPDATE', {
          guildId: this.guildId,
          channelId: this.channelId,
          waitedMs: Date.now() - startedAt,
          timeoutMs: this.connectTimeoutMs,
          ...(this.gateway.describeConnectionState?.() ?? {}),
        });
        reject(new Error('Timeout waiting for VOICE_SERVER_UPDATE.'));
      }, this.connectTimeoutMs);

      const onUpdate = (data: VoiceServerUpdate) => {
        if (data?.guild_id !== this.guildId) return;
        if (channelId && data.channel_id && data.channel_id !== channelId) return;

        clearTimeout(timeout);
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate);
        resolve(data);
      };

      this.gateway.on('VOICE_SERVER_UPDATE', onUpdate);
    });
  }

  async _ensureAudioTrack() {
    if (this.audioSource && this.audioTrack && this.audioTrackSid) return;

    const participant = this.room?.localParticipant;
    if (!participant) {
      throw new Error('No local participant available.');
    }

    if (this.audioSource || this.audioTrack) {
      await this._closeAudioResources();
    }

    this.audioSource = new AudioSource(SAMPLE_RATE, CHANNELS, MAX_QUEUE_MS);
    this.audioTrack = LocalAudioTrack.createAudioTrack('music', this.audioSource);

    const options = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      dtx: false,
      red: false,
      audioEncoding: {
        maxBitrate: BigInt(this.voiceMaxBitrate),
      },
    });

    const publication = await participant.publishTrack(this.audioTrack, options);
    this.audioTrackSid = String(publication?.sid ?? '') || null;
  }

  _stopAudioPump() {
    this.audioPumpToken += 1;
    this.playbackPaused = false;
    this._flushPauseWaiters();

    if (this.currentAudioStream?.destroy) {
      try {
        this.currentAudioStream.destroy();
      } catch {
        // ignore stream teardown errors
      }
    }

    this.currentAudioStream = null;
    this._pumpStatsSample = null;

    try {
      this.audioSource?.clearQueue();
    } catch {
      // ignore queue clear errors
    }
  }

  pauseAudio() {
    if (this.playbackPaused) return false;
    this.playbackPaused = true;
    return true;
  }

  resumeAudio() {
    if (!this.playbackPaused) return false;
    this.playbackPaused = false;
    this._flushPauseWaiters();
    return true;
  }

  get playoutDelayMs(): number {
    const queued = Number(this.audioSource?.queuedDuration);
    if (!Number.isFinite(queued) || queued <= 0) return 0;
    return Math.min(MAX_QUEUE_MS, queued);
  }

  async getDiagnostics() {
    const base = {
      connected: this.connected,
      isStreaming: this.isStreaming,
      guildId: this.guildId,
      channelId: this.channelId ?? null,
      playbackPaused: this.playbackPaused,
      queuedDurationMs: this.audioSource && Number.isFinite(this.audioSource.queuedDuration)
        ? Number(this.audioSource.queuedDuration)
        : null,
      trackSid: this.audioTrackSid ?? null,
      voiceMaxBitrate: this.voiceMaxBitrate,
    };

    const transport = await this._collectTransportStats();
    const pump = this._collectPumpStatsSnapshot();
    return { ...base, transport, pump };
  }

  _flushPauseWaiters() {
    if (!this.pauseWaiters.length) return;
    const waiters = this.pauseWaiters.splice(0, this.pauseWaiters.length);
    for (const resume of waiters) {
      try {
        resume();
      } catch {
        // ignore waiter completion errors
      }
    }
  }

  _waitWhilePaused(token: number) {
    if (!this.playbackPaused || token !== this.audioPumpToken) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.pauseWaiters.push(() => resolve());
    });
  }

  _assertPumpActive(token: number) {
    if (token !== this.audioPumpToken) {
      const aborted = new Error('Audio pump aborted.');
      (aborted as Error & { code?: string }).code = 'ERR_AUDIO_PUMP_ABORTED';
      throw aborted;
    }
  }

  async _awaitPumpOperation<T>(promiseFactory: () => Promise<T>, token: number) {
    this._assertPumpActive(token);

    const operation = promiseFactory();
    while (true) {
      const result = await Promise.race([
        operation.then((value) => ({ done: true as const, value })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), PUMP_IDLE_WAIT_MS)),
      ]);

      if (result.done) {
        this._assertPumpActive(token);
        return result.value;
      }

      this._assertPumpActive(token);
    }
  }

  async _captureFrameWithRetry(source: AudioSource, frame: AudioFrame, token: number) {
    let attempt = 0;
    while (true) {
      try {
        return await this._awaitPumpOperation(() => source.captureFrame(frame), token);
      } catch (err) {
        if (
          token !== this.audioPumpToken
          || !this.connected
          || !this._isFatalCaptureError(err)
          || this._isClosedSourceError(err)
          || attempt >= CAPTURE_FRAME_MAX_RETRIES
        ) {
          throw err;
        }

        attempt += 1;
        this.logger?.debug?.('Retrying audio frame capture after invalid state', {
          guildId: this.guildId,
          attempt,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_FRAME_RETRY_DELAY_MS));
      }
    }
  }

  _isExpectedPumpError(err: unknown, token: number) {
    if (token !== this.audioPumpToken) return true;
    if (!this.connected) return true;

    const maybeError = this._toErrorLike(err);
    const code = maybeError?.code ?? null;
    const message = String(maybeError?.message ?? err ?? '').toLowerCase();
    return (
      code === 'ERR_STREAM_PREMATURE_CLOSE'
      || code === 'ERR_STREAM_DESTROYED'
      || code === 'ERR_AUDIO_PUMP_ABORTED'
      || code === 'EPIPE'
      || message.includes('premature close')
      || message.includes('stream destroyed')
      || message.includes('aborted')
    );
  }

  _createPumpStats(): PumpStats {
    return {
      startedAtMs: null,
      bytesIn: 0,
      framesCaptured: 0,
      concealedFrames: 0,
      maxQueuedDurationMs: 0,
      backpressureWaits: 0,
      pendingBufferBytes: 0,
    };
  }

  _collectPumpStatsSnapshot() {
    const stats = this._pumpStats ?? this._createPumpStats();
    const nowMs = Date.now();
    const prev = this._pumpStatsSample;

    let inputKbps = null;
    let framesPerSec = null;
    if (prev && nowMs > prev.tsMs) {
      const deltaMs = nowMs - prev.tsMs;
      const deltaBytes = Math.max(0, stats.bytesIn - prev.bytesIn);
      const deltaFrames = Math.max(0, stats.framesCaptured - prev.framesCaptured);
      inputKbps = Math.round((deltaBytes * 8) / deltaMs);
      framesPerSec = Number(((deltaFrames * 1000) / deltaMs).toFixed(1));
    }

    this._pumpStatsSample = {
      tsMs: nowMs,
      bytesIn: stats.bytesIn,
      framesCaptured: stats.framesCaptured,
    };

    return {
      inputKbps,
      framesPerSec,
      frameDurationMs: FRAME_DURATION_MS,
      bytesIn: stats.bytesIn,
      framesCaptured: stats.framesCaptured,
      concealedFrames: stats.concealedFrames,
      pendingBufferBytes: stats.pendingBufferBytes,
      maxQueuedDurationMs: stats.maxQueuedDurationMs,
      backpressureWaits: stats.backpressureWaits,
      uptimeSec: stats.startedAtMs ? Math.max(0, Math.floor((nowMs - stats.startedAtMs) / 1000)) : 0,
    };
  }

  async _collectTransportStats() {
    const peerConnection = this._resolvePublisherPeerConnection();
    const getStats = peerConnection?.getStats;
    if (typeof getStats !== 'function') {
      return null;
    }

    let report: unknown;
    try {
      report = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('stats-timeout'));
        }, STATS_TIMEOUT_MS);

        Promise.resolve(getStats.call(peerConnection))
          .then((value) => {
            clearTimeout(timeout);
            resolve(value);
          })
          .catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
      });
    } catch {
      return null;
    }

    const rows: StatsRowLike[] = [];
    if (report && typeof (report as { forEach?: (cb: (entry: StatsRowLike) => void) => void }).forEach === 'function') {
      (report as { forEach: (cb: (entry: StatsRowLike) => void) => void }).forEach((entry) => rows.push(entry));
    } else if (Array.isArray(report)) {
      rows.push(...report as StatsRowLike[]);
    } else if (report && typeof report === 'object') {
      rows.push(...Object.values(report) as StatsRowLike[]);
    }

    let bytesSent = null;
    let packetsSent = null;
    let packetsLost = null;
    let roundTripTimeSec = null;
    let jitterSec = null;

    for (const row of rows) {
      const type = String(row?.type ?? '').toLowerCase();
      const kind = String(row?.kind ?? row?.mediaType ?? '').toLowerCase();
      if (kind !== 'audio') continue;

      if (type === 'outbound-rtp') {
        if (Number.isFinite(row?.bytesSent)) bytesSent = Number(row.bytesSent);
        if (Number.isFinite(row?.packetsSent)) packetsSent = Number(row.packetsSent);
      } else if (type === 'remote-inbound-rtp') {
        if (Number.isFinite(row?.packetsLost)) packetsLost = Number(row.packetsLost);
        if (Number.isFinite(row?.roundTripTime)) roundTripTimeSec = Number(row.roundTripTime);
        if (Number.isFinite(row?.jitter)) jitterSec = Number(row.jitter);
      }
    }

    const nowMs = Date.now();
    let outboundBitrateKbps = null;
    if (Number.isFinite(bytesSent) && this._transportStatsState?.bytesSent != null && this._transportStatsState?.tsMs != null) {
      const deltaBytes = (bytesSent ?? 0) - this._transportStatsState.bytesSent;
      const deltaMs = nowMs - this._transportStatsState.tsMs;
      if (deltaBytes >= 0 && deltaMs > 0) {
        outboundBitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
      }
    }

    this._transportStatsState = Number.isFinite(bytesSent)
      ? { bytesSent: bytesSent ?? 0, tsMs: nowMs }
      : this._transportStatsState;

    return {
      outboundBitrateKbps,
      packetsSent,
      packetsLost,
      roundTripTimeMs: Number.isFinite(roundTripTimeSec) ? Math.round((roundTripTimeSec ?? 0) * 1000) : null,
      jitterMs: Number.isFinite(jitterSec) ? Math.round((jitterSec ?? 0) * 1000) : null,
    };
  }

  _resolvePublisherPeerConnection() {
    const room = this.room as Room & {
      engine?: {
        publisher?: { pc?: PeerConnectionLike | null };
        pcManager?: { publisher?: { pc?: PeerConnectionLike | null } };
        client?: {
          pcManager?: { publisher?: { pc?: PeerConnectionLike | null } };
          publisher?: { pc?: PeerConnectionLike | null };
        };
      };
    };
    if (!room) return null;

    return (
      room?.engine?.publisher?.pc
      || room?.engine?.pcManager?.publisher?.pc
      || room?.engine?.client?.pcManager?.publisher?.pc
      || room?.engine?.client?.publisher?.pc
      || null
    );
  }

  _isPcmReadableLike(value: unknown): value is PcmReadableLike {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
  }

  _toErrorLike(err: unknown): { code?: string | number | null; message?: string | null } | null {
    if (!err || typeof err !== 'object') return null;
    return err as { code?: string | number | null; message?: string | null };
  }

  _toBufferChunk(chunk: unknown): Uint8Array {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk);
    if (typeof chunk === 'string') return Buffer.from(chunk);
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.alloc(0);
  }

  async _pumpPcmStream(stream: PcmReadableLike, source: AudioSource, token: number) {
    let pending: Uint8Array = Buffer.alloc(0);
    const stats = this._pumpStats ?? this._createPumpStats();
    const targetPendingBytes = Math.max(BYTES_PER_FRAME, Math.round((TARGET_QUEUE_MS / FRAME_DURATION_MS) * BYTES_PER_FRAME));
    const maxPendingBytes = Math.max(targetPendingBytes, Math.round((MAX_QUEUE_MS / FRAME_DURATION_MS) * BYTES_PER_FRAME));
    let inputPaused = false;

    const pauseInput = () => {
      if (inputPaused || typeof stream.pause !== 'function') return;
      try {
        stream.pause();
        inputPaused = true;
      } catch {
        // ignore source pause failures
      }
    };

    const resumeInput = () => {
      if (!inputPaused || typeof stream.resume !== 'function') return;
      try {
        stream.resume();
        inputPaused = false;
      } catch {
        // ignore source resume failures
      }
    };

    try {
      for await (const chunk of stream) {
        if (token !== this.audioPumpToken) break;
        await this._waitWhilePaused(token);
        if (token !== this.audioPumpToken) break;

        const asBuffer = this._toBufferChunk(chunk);
        if (!asBuffer.length) continue;
        stats.bytesIn += asBuffer.length;

        pending = pending.length ? Buffer.concat([pending, asBuffer]) : asBuffer;
        stats.pendingBufferBytes = pending.length;
        if (pending.length >= maxPendingBytes || Number(source.queuedDuration) >= MAX_QUEUE_MS) {
          pauseInput();
        }

        while (pending.length >= BYTES_PER_FRAME && token === this.audioPumpToken) {
          await this._waitWhilePaused(token);
          if (token !== this.audioPumpToken) break;

          const frameBytes = pending.subarray(0, BYTES_PER_FRAME);
          pending = pending.subarray(BYTES_PER_FRAME);

          const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, SAMPLES_PER_FRAME);
          const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);

          if (source.queuedDuration > TARGET_QUEUE_MS) {
            stats.backpressureWaits += 1;
            const excessMs = Number(source.queuedDuration) - TARGET_QUEUE_MS;
            const waitMs = Math.min(
              MAX_QUEUE_MS,
              Math.max(1, Math.round(excessMs + QUEUE_REFILL_HEADROOM_MS)),
            );
            await this._awaitPumpOperation(
              () => new Promise<void>((resolve) => { setTimeout(resolve, waitMs); }),
              token,
            );
          }
          if (Number.isFinite(source.queuedDuration)) {
            stats.maxQueuedDurationMs = Math.max(stats.maxQueuedDurationMs, Number(source.queuedDuration));
          }

          await this._captureFrameWithRetry(source, frame, token);
          stats.framesCaptured += 1;
          stats.pendingBufferBytes = pending.length;
          if (inputPaused && pending.length <= targetPendingBytes && Number(source.queuedDuration) <= TARGET_QUEUE_MS) {
            resumeInput();
          }
        }
      }

      if (pending.length > 0 && token === this.audioPumpToken) {
        const padded = Buffer.alloc(BYTES_PER_FRAME);
        padded.set(pending.subarray(0, Math.min(pending.length, BYTES_PER_FRAME)), 0);

        const samples = new Int16Array(padded.buffer, padded.byteOffset, SAMPLES_PER_FRAME);
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, CHANNELS, SAMPLES_PER_CHANNEL);
        await this._captureFrameWithRetry(source, frame, token);
        stats.framesCaptured += 1;
        stats.pendingBufferBytes = 0;
      }
    } finally {
      resumeInput();
      if (token === this.audioPumpToken) {
        this.currentAudioStream = null;
      }
    }
  }
}




