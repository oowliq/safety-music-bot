import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { MusicPlayer } from '../src/player/MusicPlayer.ts';

type VoiceMock = {
  stopCalls: number;
  sendAudio: () => Promise<void>;
  stopAudio: () => void;
};

type FfmpegMock = EventEmitter & {
  stdout: PassThrough;
  kill: () => void;
};

function createVoice() {
  return {
    stopCalls: 0,
    async sendAudio() {},
    stopAudio() {
      this.stopCalls += 1;
    },
  } as VoiceMock;
}

test('play() on empty queue stops voice stream before queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player.play();

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('_handleTrackClose with empty queue stops voice stream and emits queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const track = player._buildTrack({
    title: 'Track',
    url: 'https://example.com/audio',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });

  player.queue.current = track;
  player.playing = true;
  player.skipRequested = false;

  let queueEmptyCount = 0;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });

  await player._handleTrackClose(track, 0, null);

  assert.equal(queueEmptyCount, 1);
  assert.equal(voice.stopCalls, 1);
});

test('play() halts queue drain after repeated startup failures', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const attemptedTracks: string[] = [];
  const queueEmptyEvents: Array<{ reason?: string; droppedTracks?: number }> = [];
  let trackErrorCount = 0;

  let activeFfmpeg: FfmpegMock | null = null;
  const emitActiveClose = () => {
    assert.ok(activeFfmpeg);
    activeFfmpeg.emit('close', 1, null);
  };
  player._startHttpUrlPipeline = async (url: string) => {
    attemptedTracks.push(url);
    const ffmpeg = new EventEmitter() as FfmpegMock;
    ffmpeg.stdout = new PassThrough();
    ffmpeg.kill = () => {};
    player.ffmpeg = ffmpeg;
    activeFfmpeg = ffmpeg;
  };

  player.on('trackError', () => {
    trackErrorCount += 1;
  });
  player.on('queueEmpty', (event: { reason?: string; droppedTracks?: number }) => {
    queueEmptyEvents.push(event);
  });

  player.enqueueResolvedTracks([
    player._buildTrack({ title: 'Track 1', url: 'https://example.com/1', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 2', url: 'https://example.com/2', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 3', url: 'https://example.com/3', duration: '03:00', source: 'url', requestedBy: 'u' }),
    player._buildTrack({ title: 'Track 4', url: 'https://example.com/4', duration: '03:00', source: 'url', requestedBy: 'u' }),
  ]);

  const playPromise = player.play();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await new Promise((resolve) => setImmediate(resolve));
  emitActiveClose();
  await playPromise;

  assert.equal(trackErrorCount, 3);
  assert.deepEqual(attemptedTracks, [
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
  ]);
  assert.equal(queueEmptyEvents.at(-1)?.reason, 'startup_error_limit');
  assert.equal(queueEmptyEvents.at(-1)?.droppedTracks, 1);
  assert.equal(player.pendingTracks.length, 0);
});

test('seekTo rejects positions at or beyond the current track length', () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});

  player.playing = true;
  player.queue.current = player._buildTrack({
    title: 'Bounded Track',
    url: 'https://www.youtube.com/watch?v=OBoMLZTtqb8',
    duration: '47:00',
    source: 'youtube',
    requestedBy: 'user-1',
  });

  assert.throws(() => {
    player.seekTo(47 * 60);
  }, /exceeds track length/i);
});

test('skip() advances to the next queued track immediately after cleanup', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const currentTrack = player._buildTrack({
    title: 'Current Track',
    url: 'https://example.com/current',
    duration: '03:00',
    source: 'url',
    requestedBy: 'user-1',
  });
  const nextTrack = player._buildTrack({
    title: 'Next Track',
    url: 'https://example.com/next',
    duration: '02:30',
    source: 'url',
    requestedBy: 'user-1',
  });

  const staleFfmpeg = new EventEmitter() as FfmpegMock;
  staleFfmpeg.stdout = new PassThrough();
  staleFfmpeg.kill = () => {};

  const startedUrls: string[] = [];
  player.queue.current = currentTrack;
  player.queue.add(nextTrack);
  player.playing = true;
  player.trackStartedAtMs = Date.now() - 1_000;
  player.ffmpeg = staleFfmpeg;
  player._startHttpUrlPipeline = async (url: string) => {
    startedUrls.push(url);
    player.ffmpeg = {
      stdout: new PassThrough(),
      once() {},
      stderr: new PassThrough(),
    } as unknown as typeof player.ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {};

  assert.equal(player.skip(), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedUrls, ['https://example.com/next']);
  assert.equal(player.currentTrack?.title, 'Next Track');
});

test('play() reports a startup pipeline close as trackError instead of queueEmpty', async () => {
  const voice = createVoice();
  const player = new MusicPlayer(voice, {});
  const ffmpeg = new EventEmitter() as FfmpegMock;
  ffmpeg.stdout = new PassThrough();
  ffmpeg.kill = () => {};

  player._startHttpUrlPipeline = async () => {
    player.ffmpeg = ffmpeg;
  };
  player._awaitInitialPlaybackChunk = async () => {
    throw new Error('Playback pipeline exited before audio output (code=1).');
  };

  let queueEmptyEvent: { reason?: string } | null = null;
  let trackError: Error | null = null;
  player.on('queueEmpty', (event: { reason?: string }) => {
    queueEmptyEvent = event;
  });
  player.on('trackError', ({ error }: { error: Error }) => {
    trackError = error;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Broken startup track',
      url: 'https://example.com/audio',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.equal((queueEmptyEvent as { reason?: string } | null)?.reason, 'startup_error');
  assert.match(String((trackError as Error | null)?.message ?? ''), /before audio output/i);
});

test('play() pauses the queue instead of draining it when voice is disconnected', async () => {
  const voice = {
    stopCalls: 0,
    connected: false,
    async sendAudio() {
      throw new Error('Voice room is not connected.');
    },
    stopAudio() {
      this.stopCalls += 1;
    },
  };
  const player = new MusicPlayer(voice, {});
  const ffmpeg = new EventEmitter() as FfmpegMock;
  ffmpeg.stdout = new PassThrough();
  ffmpeg.kill = () => {};
  player._startHttpUrlPipeline = async () => {
    player.ffmpeg = ffmpeg;
  };

  let queueEmptyCount = 0;
  let pausedEvent: { reason?: string; pendingTracks?: number } | null = null;
  player.on('queueEmpty', () => {
    queueEmptyCount += 1;
  });
  player.on('playbackPaused', (event: { reason?: string; pendingTracks?: number }) => {
    pausedEvent = event;
  });

  player.enqueueResolvedTracks([
    player._buildTrack({
      title: 'Track A',
      url: 'https://example.com/a',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
    player._buildTrack({
      title: 'Track B',
      url: 'https://example.com/b',
      duration: '03:00',
      source: 'url',
      requestedBy: 'user-1',
    }),
  ]);

  await player.play();

  assert.equal(queueEmptyCount, 0);
  assert.equal((pausedEvent as { reason?: string } | null)?.reason, 'voice_disconnected');
  assert.equal(player.playing, false);
  assert.equal(player.queue.pendingSize, 2);
  assert.equal(player.currentTrack, null);
});

