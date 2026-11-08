import { safeFetch } from '../../../utils/safeHttp.ts';

const RADIO_LOOKUP_CACHE_TTL_MS = 45_000;
const RADIO_LOOKUP_CACHE_MAX_SIZE = 512;
const RADIO_LOOKUP_CACHE_SWEEP_MS = Math.max(5_000, RADIO_LOOKUP_CACHE_TTL_MS);
const RADIO_LOOKUP_TIMEOUT_MS = 12_000;

type RadioLookupResult = {
  artist: string | null;
  title: string | null;
  source: string;
};

type MetadataCandidate = { artist?: unknown; title?: unknown };

const radioLookupCache = new Map<string, { value: RadioLookupResult; expiresAt: number }>();
const radioLookupInFlight = new Map<string, Promise<RadioLookupResult | null>>();

function pruneRadioLookupCache(now: number = Date.now()): void {
  for (const [key, entry] of radioLookupCache.entries()) {
    if (entry.expiresAt <= now) {
      radioLookupCache.delete(key);
    }
  }
}

function trimRadioLookupCache(): void {
  while (radioLookupCache.size > RADIO_LOOKUP_CACHE_MAX_SIZE) {
    const oldest = radioLookupCache.keys().next().value as string | undefined;
    if (!oldest) break;
    radioLookupCache.delete(oldest);
  }
}

const radioLookupCacheSweepHandle = setInterval(() => {
  pruneRadioLookupCache();
}, RADIO_LOOKUP_CACHE_SWEEP_MS);
radioLookupCacheSweepHandle.unref?.();

function getCachedRadioLookup(url: unknown): RadioLookupResult | null {
  const key = String(url ?? '').trim();
  if (!key) return null;
  const cached = radioLookupCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    radioLookupCache.delete(key);
    return null;
  }
  return cached.value ?? null;
}

function setCachedRadioLookup(url: unknown, value: RadioLookupResult | null): void {
  const key = String(url ?? '').trim();
  if (!key || !value) return;
  pruneRadioLookupCache();
  radioLookupCache.delete(key);
  radioLookupCache.set(key, {
    value,
    expiresAt: Date.now() + RADIO_LOOKUP_CACHE_TTL_MS,
  });
  trimRadioLookupCache();
}

function toNormalizedResult(value: unknown, source: string): RadioLookupResult | null {
  const candidate = value && typeof value === 'object' ? (value as MetadataCandidate) : {};
  const artist = String(candidate.artist ?? '').trim();
  const title = String(candidate.title ?? '').trim();
  if (!artist && !title) return null;
  return {
    artist: artist || null,
    title: title || null,
    source,
  };
}

function parseIcyMetadataString(raw: unknown): { artist: string | null; title: string | null } | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const titleMatch = value.match(/StreamTitle='([^']*)';?/i) ?? value.match(/StreamTitle="([^"]*)";?/i);
  const streamTitle = String(titleMatch?.[1] ?? '').trim();
  if (!streamTitle) return null;

  const separators = [' - ', ' – ', ' — ', ' by '];
  for (const separator of separators) {
    const index = streamTitle.indexOf(separator);
    if (index <= 0) continue;
    const left = streamTitle.slice(0, index).trim();
    const right = streamTitle.slice(index + separator.length).trim();
    if (left && right) {
      if (separator === ' by ') {
        return { artist: right, title: left };
      }
      return { artist: left, title: right };
    }
  }

  return { artist: null, title: streamTitle };
}

async function readIcyMetadata(url: string): Promise<{ artist: string | null; title: string | null } | null> {
  const response = await safeFetch(url, {
    method: 'GET',
    headers: {
      'Icy-MetaData': '1',
      accept: '*/*',
    },
    signal: AbortSignal.timeout(RADIO_LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok || !response.body) return null;

  const metaint = Number.parseInt(String(response.headers.get('icy-metaint') ?? ''), 10);
  if (!Number.isFinite(metaint) || metaint <= 0) {
    try {
      await response.body.cancel?.();
    } catch {
      // ignore cancellation errors
    }
    return null;
  }

  const reader = response.body.getReader?.();
  if (!reader) return null;

  let pending = new Uint8Array(0);
  let audioBytesSeen = 0;
  let metadataLength = null;
  let metadataBytesNeeded = 0;

  try {
    while (audioBytesSeen < (metaint * 4)) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      const next = new Uint8Array(pending.length + value.length);
      next.set(pending);
      next.set(value, pending.length);
      pending = next;

      while (pending.length > 0) {
        if (audioBytesSeen < metaint) {
          const need = metaint - audioBytesSeen;
          if (pending.length < need) {
            audioBytesSeen += pending.length;
            pending = new Uint8Array(0);
            break;
          }

          pending = pending.slice(need);
          audioBytesSeen = metaint;
        }

        if (metadataLength == null) {
          if (pending.length < 1) break;
          metadataLength = (pending[0] ?? 0) * 16;
          metadataBytesNeeded = metadataLength;
          pending = pending.slice(1);
          if (metadataBytesNeeded === 0) {
            audioBytesSeen = 0;
            metadataLength = null;
          }
        }

        if (metadataLength != null) {
          if (pending.length < metadataBytesNeeded) break;
          const metadataBytes = pending.slice(0, metadataBytesNeeded);
          const metadataText = new TextDecoder('utf-8', { fatal: false }).decode(metadataBytes).replace(/\0+$/g, '');
          const parsed = parseIcyMetadataString(metadataText);
          if (parsed) return parsed;

          pending = pending.slice(metadataBytesNeeded);
          audioBytesSeen = 0;
          metadataLength = null;
          metadataBytesNeeded = 0;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore cancellation errors
    }
  }

  return null;
}

export async function detectRadioNowPlaying(
  { url }: { url: unknown },
): Promise<RadioLookupResult | null> {
  const safeUrl = String(url ?? '').trim();
  if (!safeUrl) return null;

  const cached = getCachedRadioLookup(safeUrl);
  if (cached) return cached;

  const inFlight = radioLookupInFlight.get(safeUrl);
  if (inFlight) return inFlight;

  const task = (async () => {
    const icy = toNormalizedResult(await readIcyMetadata(safeUrl).catch(() => null), 'icy');
    if (icy) {
      setCachedRadioLookup(safeUrl, icy);
      return icy;
    }

    return null;
  })();

  radioLookupInFlight.set(safeUrl, task);
  try {
    return await task;
  } finally {
    radioLookupInFlight.delete(safeUrl);
  }
}


