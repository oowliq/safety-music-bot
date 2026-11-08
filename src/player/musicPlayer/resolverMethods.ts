import { ValidationError } from '../../core/errors.ts';
import { assertPublicHttpUrl } from '../../utils/safeHttp.ts';
import { parseSearchPrefix, type SearchPrefix } from './searchPrefix.ts';
import type { Track, TrackInput } from '../../types/domain.ts';
import {
  isAudiomackUrl,
  isAmazonMusicUrl,
  isAppleMusicUrl,
  isAudiusUrl,
  isBandcampUrl,
  isDeezerUrl,
  isHttpUrl,
  isJioSaavnUrl,
  isLikelyDirectAudioFileUrl,
  isLikelyPlaylistUrl,
  isMixcloudUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isTidalUrl,
  isYouTubeUrl,
  pickThumbnailUrlFromItem,
  pickTrackArtistFromMetadata,
} from './trackUtils.ts';
import type { MusicPlayer } from '../MusicPlayer.ts';
import { asRecord, type UnknownRecord } from '../../utils/unknownData.ts';

// Hardened fork: every provider URL and every search goes through NodeLink.
// The bot itself never runs yt-dlp/play-dl, never handles cookies or provider
// credentials, and only decodes plain HTTP audio / internet radio locally.

type ResolverDiagnostics = {
  playing: boolean;
  paused: boolean;
  skipRequested: boolean;
  loopMode: string;
  progressSec: number;
  volumePercent: number;
  filterPreset: string;
  eqPreset: string;
  tempoRatio: number;
  pitchSemitones: number;
  pendingCount: number;
  hasCurrentTrack: boolean;
  sourceProcPid: number | null;
  ffmpegPid: number | null;
  ffmpegArgs: string[] | null;
  nodeLink: UnknownRecord;
};

export interface ResolverMethodMembers {
  _resolveTrackViaNodeLink(track: Partial<Track> | null | undefined): Promise<Track | null>;
  _resolveStartupMirrorFallbackTrack(
    track: Partial<Track> | null | undefined,
    requestedBy: string | null,
    exhaustedSources?: readonly string[],
  ): Promise<Track | null>;
  _isNodeLinkOnlyModeForSourceTrack(track: Partial<Track> | null | undefined, trackUrl?: string | null): boolean;
  _resolveTracks(query: string, requestedBy: string | null, limit?: number | null): Promise<Track[]>;
  _resolvePrefixedSearch(prefix: SearchPrefix, requestedBy: string | null, limit: number): Promise<Track[]>;
  _resolveSearchTrack(query: string, requestedBy: string | null): Promise<Track[]>;
  _searchNodeLinkTracks(query: string, limit: number, requestedBy: string | null): Promise<Track[]>;
  getDiagnostics(): ResolverDiagnostics;
  searchCandidates(query: string, limit?: number, options?: { requestedBy?: string | null }): Promise<Track[]>;
  previewTracks(query: string, options?: { requestedBy?: string | null; limit?: number }): Promise<Track[]>;
  createTrackFromData(data: TrackInput, requestedBy?: string | null): Track;
  hydrateTrackMetadata(data: TrackInput, options?: { requestedBy?: string | null }): Promise<Track | null>;
}

const MIRROR_TOTAL_BUDGET_MS = 20_000;

const MIRROR_SEARCH_SOURCES: Record<string, string> = {
  dzsearch: 'deezer',
  tdsearch: 'tidal',
  scsearch: 'soundcloud',
  ytsearch: 'youtube',
  ytmsearch: 'youtube',
  amsearch: 'applemusic',
  jssearch: 'jiosaavn',
};

function toText(value: unknown): string {
  return value ? String(value) : '';
}

function toOptionalText(value: unknown): string | null {
  return value ? String(value) : null;
}

function toNullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toDurationValue(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return String(value);
}

function toSeekStartValue(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number.parseInt(String(value), 10) || 0;
}

function normalizeResolveLimit(limit: number | null | undefined, fallback: number) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(fallback, parsed));
}

export function isKnownProviderUrl(url: string) {
  return (
    isYouTubeUrl(url)
    || isSoundCloudUrl(url)
    || isSpotifyUrl(url)
    || isDeezerUrl(url)
    || isTidalUrl(url)
    || isBandcampUrl(url)
    || isAudiomackUrl(url)
    || isMixcloudUrl(url)
    || isJioSaavnUrl(url)
    || isAmazonMusicUrl(url)
    || isAppleMusicUrl(url)
    || isAudiusUrl(url)
  );
}

export function shouldMirrorFailedStartup(options: {
  url?: string | null;
  source?: string | null;
  isLive?: boolean | null;
  previousMirrorSources?: readonly string[] | null;
  nodeLinkOnly?: boolean | null;
}): boolean {
  const source = String(options.source ?? '').toLowerCase();
  if (options.isLive) return false;
  if (source.startsWith('radio')) return false;
  if (source === 'http-audio' || source === 'url') return false;

  const alreadyMirrored = (options.previousMirrorSources?.length ?? 0) > 0;
  if (isYouTubeUrl(String(options.url ?? '')) && !alreadyMirrored && !options.nodeLinkOnly) return false;

  return true;
}

export const resolverMethods: ResolverMethodMembers & ThisType<MusicPlayer> = {
  async _resolveTrackViaNodeLink(track: Partial<Track> | null | undefined) {
    const url = String(track?.url ?? '').trim();
    if (!url || !isHttpUrl(url) || !isKnownProviderUrl(url)) return null;

    const requestedBy = track?.requestedBy ?? null;
    const resolved = await this._resolveNodeLinkTracks(url, requestedBy, 1, { urlQuery: true });
    return Array.isArray(resolved) ? (resolved[0] ?? null) : null;
  },

  async _resolveStartupMirrorFallbackTrack(
    track: Partial<Track> | null | undefined,
    requestedBy: string | null,
    exhaustedSources: readonly string[] = [],
  ) {
    const title = String(track?.title ?? '').trim();
    if (!title) return null;

    const artist = String(track?.artist ?? '').trim();
    const query = artist ? `${artist} - ${title}` : title;
    const blocked = new Set(
      [String(track?.source ?? ''), ...exhaustedSources]
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
    );

    const order = Array.isArray(this.nodeLinkMirrorSearchOrder) && this.nodeLinkMirrorSearchOrder.length
      ? this.nodeLinkMirrorSearchOrder
      : ['dzsearch', 'tdsearch', 'scsearch', 'ytsearch', 'ytmsearch'];
    const deadline = Date.now() + MIRROR_TOTAL_BUDGET_MS;

    for (const searchIdentifier of order) {
      const identifierSource = MIRROR_SEARCH_SOURCES[searchIdentifier];
      if (identifierSource && blocked.has(identifierSource)) continue;
      if (identifierSource && this._isMirrorSourceCooling?.(identifierSource)) continue;
      if (Date.now() >= deadline) {
        this.logger?.debug?.('Mirror search budget exhausted', { query, skippedFrom: searchIdentifier });
        break;
      }

      const matches = await this._resolveNodeLinkTracks(query, requestedBy, 1, { searchIdentifier })
        .catch((err: unknown) => {
          this.logger?.debug?.('NodeLink mirror search failed', {
            query,
            searchIdentifier,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        });
      const match = Array.isArray(matches) ? (matches[0] ?? null) : null;
      if (!match) continue;
      if (blocked.has(String(match.source ?? '').trim().toLowerCase())) continue;
      return match;
    }

    return null;
  },

  _isNodeLinkOnlyModeForSourceTrack(track: Partial<Track> | null | undefined, trackUrl?: string | null) {
    const url = String(trackUrl ?? track?.url ?? '');
    if (isHttpUrl(url) && isKnownProviderUrl(url)) return true;
    if (track?.isLive) return false;

    const source = String(track?.source ?? '').toLowerCase();
    if (source.startsWith('radio')) return false;
    if (source === 'http-audio' || source === 'url') return false;

    return true;
  },

  async _resolveTracks(query: string, requestedBy: string | null, limit?: number | null) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      throw new ValidationError('Missing query.');
    }

    const safeLimit = normalizeResolveLimit(limit, this.maxPlaylistTracks);
    if (!isHttpUrl(raw)) {
      const prefixed = parseSearchPrefix(raw);
      if (prefixed) return this._resolvePrefixedSearch(prefixed, requestedBy, 1);
      return this._resolveSearchTrack(raw, requestedBy);
    }

    const url = await this.sources.resolver.normalizeInputUrl(raw);
    await assertPublicHttpUrl(url);

    // Non-provider URLs (direct audio, radio streams/playlists, unknown hosts) are probed locally first.
    if (!isKnownProviderUrl(url)) {
      return this.sources.resolver.resolveSingleUrlTrack(url, requestedBy);
    }

    const resolved = await this._resolveNodeLinkTracks(url, requestedBy, safeLimit, { urlQuery: true }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`NodeLink could not resolve ${url}. It reported: ${reason}`);
    });
    if (Array.isArray(resolved) && resolved.length > 0) {
      return resolved;
    }

    this.logger?.warn?.('NodeLink returned no playable tracks for URL', { url });
    throw new ValidationError(`NodeLink returned no playable tracks for ${url}.`);
  },

  async _resolvePrefixedSearch(prefix: SearchPrefix, requestedBy: string | null, limit: number) {
    const tracks = await this._resolveNodeLinkTracks(prefix.query, requestedBy, limit, { searchIdentifier: prefix.identifier });
    if (!tracks.length) {
      throw new ValidationError(`No results on ${prefix.label}.`, {
        translationKey: 'errors.searchSourceEmpty',
        translationParams: { source: prefix.label },
      });
    }
    return tracks;
  },

  async _resolveSearchTrack(query: string, requestedBy: string | null) {
    return this._resolveNodeLinkTracks(query, requestedBy, 1);
  },

  async _searchNodeLinkTracks(query: string, limit: number, requestedBy: string | null) {
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    return this._resolveNodeLinkTracks(query, requestedBy, safeLimit, { searchIdentifier: 'search' });
  },

  getDiagnostics(): ResolverDiagnostics {
    return {
      playing: this.playing,
      paused: this.paused,
      skipRequested: this.skipRequested,
      loopMode: this.loopMode,
      progressSec: this.getProgressSeconds(),
      volumePercent: this.volumePercent,
      filterPreset: this.filterPreset,
      eqPreset: this.eqPreset,
      tempoRatio: this.tempoRatio,
      pitchSemitones: this.pitchSemitones,
      pendingCount: this.queue.pendingSize,
      hasCurrentTrack: Boolean(this.currentTrack),
      sourceProcPid: this.sourceProc?.pid ?? null,
      ffmpegPid: this.ffmpeg?.pid ?? null,
      ffmpegArgs: Array.isArray(this._lastFfmpegArgs) ? [...this._lastFfmpegArgs] : null,
      nodeLink: this.nodeLinkClient.getDiagnostics(),
    };
  },

  async searchCandidates(query: string, limit = 5, options: { requestedBy?: string | null } = { requestedBy: null }) {
    const requestedBy = options.requestedBy ?? null;
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 5));
    const prefixed = parseSearchPrefix(query);
    if (prefixed) return this._resolvePrefixedSearch(prefixed, requestedBy, safeLimit);
    return this._searchNodeLinkTracks(query, safeLimit, requestedBy);
  },

  async previewTracks(query: string, options: { requestedBy?: string | null; limit?: number } = { requestedBy: null, limit: 0 }) {
    const requestedBy = options.requestedBy ?? null;
    const limit = Number.parseInt(String(options.limit ?? 0), 10);
    return this._resolveTracks(query, requestedBy, Number.isFinite(limit) && limit > 0 ? limit : null);
  },

  createTrackFromData(data: TrackInput, requestedBy: string | null = null) {
    const normalizedThumbnailUrl = (
      data?.thumbnailUrl
      ?? data?.thumbnail_url
      ?? data?.thumbnail
      ?? pickThumbnailUrlFromItem(data)
    );
    const normalizedUrl = String(data?.url ?? '').trim();
    const rawSource = String(data?.source ?? 'stored').trim();
    const normalizedSource = rawSource.toLowerCase();
    const explicitIsLive = data?.isLive ?? data?.is_live ?? false;
    const inferredIsLive =
      explicitIsLive === true
      || String(data?.duration ?? '').trim().toLowerCase() === 'live';

    let effectiveSource = rawSource || 'stored';
    if (isHttpUrl(normalizedUrl) && !isYouTubeUrl(normalizedUrl)) {
      if (
        !isKnownProviderUrl(normalizedUrl)
        && (
          normalizedSource === 'http'
          || normalizedSource === 'youtube'
          || normalizedSource === 'ytmusic'
          || normalizedSource === 'stored'
          || normalizedSource === 'url'
        )
      ) {
        const unresolvedExtensionlessUrlFallback = (
          normalizedSource === 'url'
          && !isLikelyDirectAudioFileUrl(normalizedUrl)
          && String(data?.duration ?? '').trim().toLowerCase() === 'unknown'
        );
        effectiveSource = inferredIsLive || isLikelyPlaylistUrl(normalizedUrl)
          || unresolvedExtensionlessUrlFallback
          ? 'radio-stream'
          : 'http-audio';
      }
    }

    const nodelinkInfo = data?.nodelinkInfo ?? data?.nodelink_info ?? null;
    return this._buildTrack({
      title: toText(data?.title),
      url: normalizedUrl,
      duration: toDurationValue(data?.duration),
      metadataDeferred: Boolean(data?.metadataDeferred),
      thumbnailUrl: toNullableText(normalizedThumbnailUrl),
      requestedBy: requestedBy ?? toNullableText(data?.requestedBy),
      source: effectiveSource,
      artist: toOptionalText(data?.artist ?? data?.artist_name ?? pickTrackArtistFromMetadata(data)),
      soundcloudTrackId: toOptionalText(data?.soundcloudTrackId ?? data?.soundcloud_track_id),
      audiusTrackId: toOptionalText(data?.audiusTrackId ?? data?.audius_track_id),
      deezerTrackId: toOptionalText(data?.deezerTrackId ?? data?.deezer_track_id),
      deezerPreviewUrl: toNullableText(data?.deezerPreviewUrl ?? data?.deezer_preview_url),
      deezerFullStreamUrl: toNullableText(data?.deezerFullStreamUrl ?? data?.deezer_full_stream_url),
      spotifyTrackId: toOptionalText(data?.spotifyTrackId ?? data?.spotify_track_id),
      spotifyPreviewUrl: toNullableText(data?.spotifyPreviewUrl ?? data?.spotify_preview_url),
      isrc: toOptionalText(data?.isrc),
      nodelinkEncodedTrack: toOptionalText(data?.nodelinkEncodedTrack ?? data?.nodelink_encoded_track),
      nodelinkInfo: asRecord(nodelinkInfo),
      isPreview: Boolean(data?.isPreview ?? data?.is_preview),
      isLive: inferredIsLive || effectiveSource === 'radio-stream',
      seekStartSec: toSeekStartValue(data?.seekStartSec ?? data?.seek_start_sec ?? 0),
    });
  },

  async hydrateTrackMetadata(
    data: TrackInput,
    options: { requestedBy?: string | null } = { requestedBy: null },
  ) {
    const url = String(data?.url ?? '').trim();
    if (!url || data?.metadataDeferred !== true || !isKnownProviderUrl(url)) return null;

    const requestedBy = options.requestedBy ?? (String(data?.requestedBy ?? '').trim() || null);
    try {
      const resolved = await this._resolveNodeLinkTracks(url, requestedBy, 1, { urlQuery: true });
      return resolved[0] ?? null;
    } catch (err) {
      this.logger?.warn?.('NodeLink deferred metadata hydration failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};
