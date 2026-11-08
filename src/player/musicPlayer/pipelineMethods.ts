import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { LiveAudioProcessor, isLiveFilterPresetSupported } from '../LiveAudioProcessor.ts';
import { SpectrumAnalyzer } from '../audio/SpectrumAnalyzer.ts';
import { FILTER_PRESETS, HTTP_STREAM_USER_AGENT } from './constants.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import { readField } from '../../utils/unknownData.ts';

const MAX_LIVE_VOLUME_COMPENSATION_PERCENT = 400;
const LIVE_RECONNECT_DELAY_MAX_SEC = 10;
const LIVE_READ_TIMEOUT_US = 15_000_000;
const LIVE_STDERR_TAIL_CHARS = 2_000;
// User-supplied URLs reach ffmpeg/ffprobe: allow network protocols only (no file:, concat:, data:, subfile:).
const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto,hls';
import {
  clamp,
} from './trackUtils.ts';
import type { PipelineProcess } from '../../types/domain.ts';

type ProcessEventListener = (...args: unknown[]) => void;

export interface ProcessEventEmitterLike {
  on?: (event: string, listener: ProcessEventListener) => unknown;
  off?: (event: string, listener: ProcessEventListener) => unknown;
  once?: (event: string, listener: ProcessEventListener) => unknown;
}

export interface ProcessOutputStreamLike extends ProcessEventEmitterLike {
  setEncoding?: (encoding: BufferEncoding) => unknown;
}

export interface ProcessOutputSource extends ProcessEventEmitterLike {
  kill?: (signal?: NodeJS.Signals | number) => unknown;
  stdout?: ProcessOutputStreamLike | null;
  stderr?: ProcessOutputStreamLike | null;
}

export type SpawnedProcess = PipelineProcess & ProcessEventEmitterLike & {
  stdin?: (NonNullable<PipelineProcess['stdin']> & NodeJS.WritableStream) | null;
};

export interface ProcessOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HttpPipelineOptions {
  isLive?: boolean;
}

export interface LiveVolumeCompensation {
  required: number;
  reachable: boolean;
}

export interface LiveAudioProcessorState {
  volumePercent: number;
  filterPreset: string;
  eqPreset: string;
  tempoRatio: number;
  pitchSemitones: number;
}

export interface HttpAudioProbeResult {
  durationSec: number | null;
  title: string | null;
  artist: string | null;
}

export interface InitialPlaybackChunkTrack {
  seekStartSec?: unknown;
  source?: unknown;
  url?: unknown;
  startupRetryCount?: unknown;
}

export interface PipelineMethodMembers {
  _lastSpectrumFrameAtMs?: number;
  _spectrumFrameCount?: number;
  _spectrumMaxGapMs?: number;
  _lastSpectrumLeadLogAtMs?: number;
  _spectrumBaselineSec?: number | null;
  _ffmpegHttpArgs(inputUrl: string, seekSec?: number, options?: HttpPipelineOptions): string[];
  _startHttpUrlPipeline(url: string, seekSec?: number, options?: HttpPipelineOptions): Promise<void>;
  _ffmpegArgs(seekSec?: number, options?: { realtimeInput?: boolean }): string[];
  _buildTranscodeFilterChain(): string;
  isLiveFilterPresetSupported(name?: string): boolean;
  _liveVolumeCompensation(): LiveVolumeCompensation;
  _getLiveAudioProcessorState(): LiveAudioProcessorState;
  _createLiveAudioProcessor(): LiveAudioProcessor;
  _createPlaybackOutputStream(): SpectrumAnalyzer;
  _reportSpectrumLead(analyzer: { analyzedSamples?: number }): void;
  setSpectrumEnabled(enabled: unknown): boolean;
  _shouldUseLiveAudioProcessor(): boolean;
  _applyAudioEffectsLive(): boolean;
  _canDelegateVolumeToStream(): boolean;
  _syncLiveAudioProcessor(): boolean;
  _enableLiveAudioProcessorDuringPlayback(): boolean;
  _probeHttpAudioTrack(url: string, timeoutMs?: number): Promise<HttpAudioProbeResult | null>;
  _collectProcessOutput(proc: ProcessOutputSource, timeoutMs?: number): Promise<ProcessOutput>;
  _awaitInitialPlaybackChunk(
    stream: ProcessEventEmitterLike | null | undefined,
    proc: ProcessEventEmitterLike | null | undefined,
    timeoutMs?: number
  ): Promise<void>;
  _getInitialPlaybackChunkTimeoutMs(
    track: InitialPlaybackChunkTrack | null | undefined,
    options?: { hint?: string | null }
  ): number;
  _spawnProcess(cmd: string, args: string[], options: SpawnOptions): Promise<SpawnedProcess>;
}

export const pipelineMethods: PipelineMethodMembers & ThisType<MusicPlayer> = {
  _ffmpegHttpArgs(inputUrl: string, seekSec = 0, options: HttpPipelineOptions = {}) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const isLive = options?.isLive === true;
    const args = [
      ...(isLive ? ['-re'] : []),
      '-nostdin',
      '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
      '-user_agent', HTTP_STREAM_USER_AGENT,
    ];

    if (isLive) {
      args.push(
        '-headers', 'Icy-MetaData:1\r\n',
        '-nostats',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_delay_max', String(LIVE_RECONNECT_DELAY_MAX_SEC),
        '-rw_timeout', String(LIVE_READ_TIMEOUT_US),
      );
    }

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-i', inputUrl,
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  },

  async _startHttpUrlPipeline(url: string, seekSec = 0, options: HttpPipelineOptions = {}) {
    const ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(url, seekSec, options), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.ffmpeg = ffmpeg;

    this._bindPipelineErrorHandler(ffmpeg.stdout, 'ffmpeg.stdout');
    this._bindPipelineErrorHandler(ffmpeg.stderr, 'ffmpeg.stderr');

    this.liveStreamStderrTail = null;
    if (options?.isLive === true) {
      ffmpeg.stderr?.on?.('data', (chunk: unknown) => {
        this.liveStreamStderrTail = `${this.liveStreamStderrTail ?? ''}${String(chunk ?? '')}`.slice(-LIVE_STDERR_TAIL_CHARS);
      });
    }
  },

  _ffmpegArgs(seekSec = 0, options: { realtimeInput?: boolean } = {}) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const realtimeInput = options?.realtimeInput === true;
    const args = [
      ...(realtimeInput ? ['-re'] : []),
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
    ];

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  },

  _buildTranscodeFilterChain() {
    const filters: string[] = [];
    const presetFilters = FILTER_PRESETS[this.filterPreset] ?? FILTER_PRESETS.off ?? [];
    if (!isLiveFilterPresetSupported(this.filterPreset)) {
      filters.push(...presetFilters);
    }
    return filters.join(',');
  },

  isLiveFilterPresetSupported(name?: string) {
    return isLiveFilterPresetSupported(name ?? this.filterPreset);
  },

  _liveVolumeCompensation() {
    const target = clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent);
    const applied = Number.parseInt(String(this.streamAppliedVolumePercent ?? 100), 10) || 100;
    const required = applied === 100 ? target : Math.round((target / applied) * 100);
    return {
      required,
      reachable: required <= MAX_LIVE_VOLUME_COMPENSATION_PERCENT,
    };
  },

  _getLiveAudioProcessorState() {
    const { required } = this._liveVolumeCompensation();
    return {
      volumePercent: clamp(required, 0, MAX_LIVE_VOLUME_COMPENSATION_PERCENT),
      filterPreset: this.isLiveFilterPresetSupported(this.filterPreset) ? this.filterPreset : 'off',
      eqPreset: this.eqPreset,
      tempoRatio: Number(this.tempoRatio) || 1,
      pitchSemitones: Number(this.pitchSemitones) || 0,
    };
  },

  _createLiveAudioProcessor() {
    return new LiveAudioProcessor(this._getLiveAudioProcessorState());
  },

  _createPlaybackOutputStream() {
    const output = new SpectrumAnalyzer();
    output.enabled = this.spectrumEnabled === true;
    output.onFrame = (bands: Uint8Array) => {
      this._reportSpectrumLead(output);
      this.emit('spectrum', bands);
    };
    this._bindPipelineErrorHandler(output, 'playbackOutputStream');
    this.playbackOutputStream = output;
    return output;
  },

  _reportSpectrumLead(analyzer: { analyzedSamples?: number }) {
    const now = Date.now();
    const sinceLast = now - (this._lastSpectrumFrameAtMs ?? now);
    this._lastSpectrumFrameAtMs = now;
    this._spectrumFrameCount = (this._spectrumFrameCount ?? 0) + 1;
    this._spectrumMaxGapMs = Math.max(this._spectrumMaxGapMs ?? 0, sinceLast);
    if (now - (this._lastSpectrumLeadLogAtMs ?? 0) < 5_000) return;
    const windowMs = now - (this._lastSpectrumLeadLogAtMs ?? now);
    const framesPerSec = windowMs > 0
      ? Math.round((this._spectrumFrameCount / windowMs) * 1000 * 10) / 10
      : 0;
    const maxGapMs = Math.round(this._spectrumMaxGapMs ?? 0);
    this._spectrumFrameCount = 0;
    this._spectrumMaxGapMs = 0;
    this._lastSpectrumLeadLogAtMs = now;
    const analyzedSec = Number(analyzer?.analyzedSamples ?? 0) / 48_000;
    const playbackSec = typeof this.getProgressSeconds === 'function' ? this.getProgressSeconds() : 0;
    if (this._spectrumBaselineSec == null) {
      this._spectrumBaselineSec = playbackSec - analyzedSec;
      return;
    }
    const leadMs = Math.round((analyzedSec + this._spectrumBaselineSec - playbackSec) * 1000);
    this.logger?.debug?.('Spectrum analyzer lead', { leadMs, framesPerSec, maxGapMs });
  },

  setSpectrumEnabled(enabled: unknown) {
    const next = Boolean(enabled);
    this.spectrumEnabled = next;
    const stream = this.playbackOutputStream;
    if (stream) {
      if (next && !stream.enabled) {
        stream.reset();
        this._spectrumBaselineSec = null;
        this._lastSpectrumLeadLogAtMs = 0;
      }
      stream.enabled = next;
    }
    return next;
  },

  _shouldUseLiveAudioProcessor() {
    const state = this._getLiveAudioProcessorState();
    return (
      state.volumePercent !== 100
      || state.filterPreset !== 'off'
      || state.eqPreset !== 'flat'
      || state.tempoRatio !== 1
      || state.pitchSemitones !== 0
    );
  },

  _applyAudioEffectsLive() {
    const hadLiveProcessor = Boolean(this.liveAudioProcessor);
    this._syncLiveAudioProcessor();
    if (!this.playing) return false;

    if (!this._liveVolumeCompensation().reachable) {
      this.logger?.debug?.('Restarting the stream to reach the requested volume', {
        volumePercent: this.volumePercent,
        streamAppliedVolumePercent: this.streamAppliedVolumePercent,
      });
      return this.refreshCurrentTrackProcessing();
    }

    if (hadLiveProcessor || !this._shouldUseLiveAudioProcessor()) return false;
    if (this._enableLiveAudioProcessorDuringPlayback()) return false;
    return this.refreshCurrentTrackProcessing();
  },

  _canDelegateVolumeToStream() {
    const filterPreset = this.isLiveFilterPresetSupported(this.filterPreset) ? this.filterPreset : 'off';
    return filterPreset === 'off' && this.eqPreset === 'flat';
  },

  _syncLiveAudioProcessor() {
    if (!this.liveAudioProcessor) return false;
    try {
      this.liveAudioProcessor.updateSettings(this._getLiveAudioProcessorState());
      return true;
    } catch (err) {
      this.logger?.warn?.('Failed to sync live audio processor state', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  _enableLiveAudioProcessorDuringPlayback() {
    if (this.liveAudioProcessor) {
      return this._syncLiveAudioProcessor();
    }

    const playbackSource = this.playbackSourceStream ?? this.ffmpeg?.stdout;
    const playbackOutput = this.playbackOutputStream;
    if (!playbackSource?.pipe || !playbackSource?.unpipe || !playbackOutput?.pipe) {
      return false;
    }

    const processor = this._createLiveAudioProcessor();
    this._bindPipelineErrorHandler(processor, 'liveAudioProcessor');

    try {
      playbackSource.unpipe(playbackOutput);
      playbackSource.pipe(processor);
      processor.pipe(playbackOutput);
      this.liveAudioProcessor = processor;
      return true;
    } catch (err) {
      try {
        playbackSource.unpipe?.(processor);
      } catch {}
      try {
        processor.unpipe?.(playbackOutput);
      } catch {}
      try {
        processor.destroy?.();
      } catch {}
      this.liveAudioProcessor = null;
      this.logger?.warn?.('Failed to enable live audio processor during playback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  async _probeHttpAudioTrack(url: string, timeoutMs = 15_000) {
    const ffprobeBin = this.ffmpegBin.endsWith('ffmpeg')
      ? this.ffmpegBin.replace(/ffmpeg(?:\.exe)?$/i, (match: string) => match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe';
    const args = [
      '-nostdin',
      '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
      '-user_agent', HTTP_STREAM_USER_AGENT,
      '-v', 'error',
      '-show_entries', 'format=duration:stream=duration:format_tags=title,artist:stream_tags=title,artist',
      '-of', 'json',
      url,
    ];

    const proc = await this._spawnProcess(ffprobeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const { stdout } = await this._collectProcessOutput(proc, timeoutMs).catch(() => ({ stdout: '' }));
    if (!stdout?.trim()) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return null;
    }

    const format = readField(payload, 'format');
    const streams = readField(payload, 'streams');
    const streamList: unknown[] = Array.isArray(streams) ? streams : [];
    const formatTags = readField(format, 'tags');
    const firstStreamTags = readField(readField(streams, '0'), 'tags');
    const durationCandidates: unknown[] = [
      readField(format, 'duration'),
      ...streamList.map((stream) => readField(stream, 'duration') ?? null),
    ];
    const durationRaw = durationCandidates
      .map((value) => Number.parseFloat(String(value ?? '')))
      .find((value) => Number.isFinite(value) && value > 0) ?? null;
    const durationSec = typeof durationRaw === 'number' && durationRaw > 0
      ? Math.max(1, Math.round(durationRaw))
      : null;

    return {
      durationSec,
      title: String(readField(formatTags, 'title') ?? readField(firstStreamTags, 'title') ?? '').trim() || null,
      artist: String(readField(formatTags, 'artist') ?? readField(firstStreamTags, 'artist') ?? '').trim() || null,
    };
  },

  _collectProcessOutput(proc: ProcessOutputSource, timeoutMs = 12_000) {
    return new Promise<ProcessOutput>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill?.('SIGKILL');
        reject(new Error('Media probe command timed out.'));
      }, timeoutMs);

      proc.stdout?.setEncoding?.('utf8');
      proc.stderr?.setEncoding?.('utf8');
      proc.stdout?.on?.('data', (chunk: unknown) => {
        stdout = `${stdout}${chunk}`.slice(-2_000_000);
      });
      proc.stderr?.on?.('data', (chunk: unknown) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });

      proc.once?.('error', (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.once?.('close', (code: unknown, signal: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const exitCode = typeof code === 'number' && Number.isFinite(code) ? code : 1;
        if (signal) {
          reject(new Error(`Media probe command terminated by signal ${signal}.`));
          return;
        }
        resolve({ code: exitCode, stdout, stderr });
      });
    });
  },

  _awaitInitialPlaybackChunk(
    stream: ProcessEventEmitterLike | null | undefined,
    proc: ProcessEventEmitterLike | null | undefined,
    timeoutMs = 8_000
  ) {
    if (!stream?.once || !stream?.off) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Playback pipeline did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        if (settled) return;
        cleanup();
        resolve();
      };

      const onStreamError = (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcError = (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcClose = (code: unknown, signal: unknown) => {
        if (settled) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`Playback pipeline exited before audio output (code=${codeLabel}${signalLabel}).`));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        stream.off?.('data', onData);
        stream.off?.('error', onStreamError);
        proc?.off?.('error', onProcError);
        proc?.off?.('close', onProcClose);
      };

      stream.once?.('data', onData);
      stream.once?.('error', onStreamError);
      proc?.once?.('error', onProcError);
      proc?.once?.('close', onProcClose);
    });
  },

  _getInitialPlaybackChunkTimeoutMs(
    track: InitialPlaybackChunkTrack | null | undefined,
    options: { hint?: string | null } = { hint: null }
  ) {
    const seekSec = Math.max(0, Number.parseInt(String(track?.seekStartSec ?? 0), 10) || 0);
    const normalizedHint = String(options?.hint ?? '').trim().toLowerCase();
    const isYouTubeTrack = String(track?.source ?? '').startsWith('youtube')
      || /(?:youtube\.com|youtu\.be)/i.test(String(track?.url ?? ''));
    const startupRetryAttempt = Math.max(0, Number.parseInt(String(track?.startupRetryCount ?? 0), 10) || 0);
    if (seekSec <= 0) {
      if (normalizedHint === 'skip') {
        return isYouTubeTrack
          ? 10_000 + (startupRetryAttempt * 10_000)
          : 6_000;
      }
      return isYouTubeTrack
        ? 12_000 + (startupRetryAttempt * 10_000)
        : 8_000;
    }

    return Math.min(60_000, 8_000 + (seekSec * 10));
  },

  _spawnProcess(cmd: string, args: string[], options: SpawnOptions) {
    return new Promise<SpawnedProcess>((resolve, reject) => {
      const proc = spawn(cmd, args, options);
      let settled = false;

      proc.once('spawn', () => {
        settled = true;
        resolve(proc);
      });

      proc.once('error', (err: unknown) => {
        if (!settled) {
          reject(err);
        }
      });
    });
  },
};
