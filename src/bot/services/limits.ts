export interface PerkLimits {
  maxPlaylistTracks: number | null;
  searchResultLimit: number;
  playCommandCooldownMs: number;
  maxFavoritesPerUser: number;
}

export interface PerkConfig {
  maxPlaylistTracks?: number | null;
  searchResultLimit?: number;
  playCommandCooldownMs?: number;
  maxFavoritesPerUser?: number;
}

export function baseLimits(config: PerkConfig): PerkLimits {
  return {
    maxPlaylistTracks: config.maxPlaylistTracks ?? null,
    searchResultLimit: config.searchResultLimit ?? 5,
    playCommandCooldownMs: config.playCommandCooldownMs ?? 0,
    maxFavoritesPerUser: config.maxFavoritesPerUser ?? 500,
  };
}
