import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRadioNowPlaying } from '../src/bot/commands/helpers/radioNowPlaying.ts';
import { _setSafeFetchTransport } from '../src/utils/safeHttp.ts';

_setSafeFetchTransport((url, init) => globalThis.fetch(url, init as RequestInit));

type RadioResponseInit = {
  ok?: boolean;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
  json?: unknown;
};

function createReadableStreamFromChunks(chunks: Uint8Array[]) {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      if (!queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(queue.shift());
    },
  });
}

function createResponse({ ok = true, headers = {}, body = null, json = null }: RadioResponseInit): Response {
  return {
    ok,
    headers: {
      get(name: string) {
        return headers[String(name ?? '').toLowerCase()] ?? null;
      },
    },
    body,
    async json() {
      return typeof json === 'function' ? json() : json;
    },
  } as unknown as Response;
}

test('detectRadioNowPlaying prefers ICY metadata when available', async () => {
  const originalFetch = global.fetch;
  const metaint = 5;
  const metadataText = "StreamTitle='Artist Demo - Song Demo';";
  const metadataBytes = new Uint8Array(48);
  metadataBytes.set(Buffer.from(metadataText, 'utf8'));
  const chunk = new Uint8Array([
    ...Buffer.from('abcde', 'utf8'),
    3,
    ...metadataBytes,
  ]);

  global.fetch = (async () => createResponse({
    headers: {
      'icy-metaint': String(metaint),
    },
    body: createReadableStreamFromChunks([chunk]),
  })) as typeof fetch;

  try {
    const detected = await detectRadioNowPlaying({
      url: 'https://radio.example/icy',
    });
    assert.deepEqual(detected, {
      artist: 'Artist Demo',
      title: 'Song Demo',
      source: 'icy',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

