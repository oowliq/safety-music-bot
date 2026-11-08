import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRouter } from '../src/bot/commandRouter.ts';

type PreviewCall = { query: string; startedAt: number };

function createRouter(options: {
  similar?: Array<{ artist: string; track: string; match: number }>;
  history?: Array<{ title: string; artist: string; duration: string }>;
  resolve?: (query: string) => unknown[];
  previewDelayMs?: number;
  slowQueries?: string[];
  slowDelayMs?: number;
  listeners?: number;
  similarFor?: (artist: string, track: string) => Array<{ artist: string; track: string; match: number }>;
  topTracksFor?: (artist: string) => Array<{ artist: string; track: string; match: number }>;
}) {
  const seeds: string[] = [];
  const previewCalls: PreviewCall[] = [];
  const enqueued: unknown[] = [];
  const inFlight = { current: 0, max: 0 };

  const player = {
    playing: false,
    historyTracks: options.history ?? [],
    searchBackend: 'deezer',
    async previewTracks(this: { searchBackend: string }, query: string) {
      if (this?.searchBackend !== 'deezer') {
        throw new TypeError('previewTracks lost its player binding');
      }
      previewCalls.push({ query, startedAt: Date.now() });
      inFlight.current += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.current);
      try {
        if (options.slowQueries?.includes(query)) {
          await new Promise((resolve) => setTimeout(resolve, options.slowDelayMs ?? 5_000).unref?.());
        }
        if (options.previewDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.previewDelayMs));
        }
        return options.resolve ? options.resolve(query) : [{ title: query, duration: '3:00', source: 'deezer' }];
      } finally {
        inFlight.current -= 1;
      }
    },
    enqueueResolvedTracks(tracks: unknown[]) {
      enqueued.push(...tracks);
      return tracks;
    },
    async play() {
      this.playing = true;
    },
  };

  const session = {
    guildId: 'guild-1',
    sessionId: 'session-1',
    settings: { autoplayEnabled: true },
    connection: { channelId: 'voice-1' },
    player,
  };

  const router = new CommandRouter({
    config: { prefix: '!', sessionIdleMs: 300_000 },
    rest: {
      async sendTyping() {},
      async sendMessage() {},
      async editMessage() {},
    },
    gateway: {},
    sessions: {
      has: () => true,
      bindTextChannel: () => null,
      get: () => session,
      destroy: async () => null,
      on: () => null,
      sessions: new Map(),
    },
    voiceStateStore: { countUsersInChannel: () => options.listeners ?? 1 },
    lyrics: null,
  } as unknown as ConstructorParameters<typeof CommandRouter>[0]);

  return { router, session, previewCalls, enqueued, seeds, inFlight };
}

const AMY = { title: 'Back To Black', artist: 'Amy Winehouse', duration: '4:00' };

test('autoplay stays quiet when nothing resolves', async () => {
  const { router, session, enqueued } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
    resolve: () => [],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(enqueued.length, 0);
});

test('autoplay stops once the channel is empty so the session can time out', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
    listeners: 0,
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0, 'no lookups for an empty room');
});

test('autoplay stays off when the guild did not enable it', async () => {
  const { router, session, previewCalls } = createRouter({
    similar: [{ artist: 'Amy Winehouse', track: 'Rehab', match: 1 }],
  });

  session.settings.autoplayEnabled = false;
  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0);
});

test('autoplay only gives up when neither source knows anything', async () => {
  const { router, session, previewCalls } = createRouter({
    similarFor: () => [],
    topTracksFor: () => [],
  });

  router.lastPlayedTracks.set('session-1', AMY);

  assert.equal(await router._tryAutoplay(session as never), null);
  assert.equal(previewCalls.length, 0);
});

test('autoplay falls back to the YouTube mix when Last.fm is not configured', async () => {
  const enqueued: unknown[] = [];
  const player = {
    playing: false,
    historyTracks: [],
    async previewTracks(query: string) {
      if (!query.includes('list=RD')) return [];
      return [
        { title: 'Seed Song', url: 'https://www.youtube.com/watch?v=seed0000001', duration: '3:00' },
        { title: 'Mix Song', url: 'https://www.youtube.com/watch?v=mix00000001', duration: '3:30' },
      ];
    },
    enqueueResolvedTracks(tracks: unknown[]) {
      enqueued.push(...tracks);
      return tracks;
    },
    async play() {
      this.playing = true;
    },
  };
  const session = {
    guildId: 'guild-1',
    sessionId: 'session-1',
    settings: { autoplayEnabled: true },
    connection: { channelId: 'voice-1' },
    player,
  };
  const router = new CommandRouter({
    config: { prefix: '!', sessionIdleMs: 300_000 },
    rest: {
      async sendTyping() {},
      async sendMessage() {},
      async editMessage() {},
    },
    gateway: {},
    sessions: {
      has: () => true,
      bindTextChannel: () => null,
      get: () => session,
      destroy: async () => null,
      on: () => null,
      sessions: new Map(),
    },
    voiceStateStore: { countUsersInChannel: () => 1 },
    lyrics: null,
  });
  router.lastPlayedTracks.set('session-1', {
    title: 'Seed Song',
    url: 'https://www.youtube.com/watch?v=seed0000001',
    duration: '3:00',
  });

  const title = await router._tryAutoplay(session);

  assert.equal(title, 'Mix Song');
  assert.equal(enqueued.length, 1);
  assert.equal(player.playing, true);
});
