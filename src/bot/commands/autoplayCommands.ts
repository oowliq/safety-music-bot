import { ValidationError } from '../../core/errors.ts';
import {
  createCommand,
  ensureGuild,
  getGuildConfigOrThrow,
  ensureManageGuildAccess,
  parseOnOff,
  requireLibrary,
  resolveActiveVoiceChannelOrThrow,
} from './commandHelpers.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { CommandContextLike } from './helpers/types.ts';

export function registerAutoplayCommands(registry: CommandRegistry) {
  registry.register(createCommand({
    name: 'autoplay',
    description: 'Keep playback going with related tracks when the queue runs out.',
    usage: 'autoplay [on|off]',
    async execute(ctx: CommandContextLike) {
      ensureGuild(ctx);
      const library = requireLibrary(ctx);
      const guildConfig = await getGuildConfigOrThrow(ctx);
      const voiceChannelId = await resolveActiveVoiceChannelOrThrow(ctx, { fallbackCommand: 'autoplay' });
      const profile = await library.getVoiceProfile(ctx.guildId, voiceChannelId).catch(() => null);
      const current = typeof profile?.autoplayEnabled === 'boolean'
        ? profile.autoplayEnabled
        : Boolean(guildConfig.settings.autoplayEnabled);

      if (!ctx.args.length) {
        const state = ctx.t(current ? 'common.on' : 'common.off');
        await ctx.reply.info(ctx.t('autoplay.current', { channel: `<#${voiceChannelId}>`, state }));
        return;
      }

      await ensureManageGuildAccess(ctx, 'access.changeAutoplay');
      const value = parseOnOff(ctx.args[0], null);
      if (value == null) throw new ValidationError(ctx.t('config.useOnOff'));

      await library.setVoiceProfile(ctx.guildId, voiceChannelId, { autoplayEnabled: value });
      await ctx.sessions.refreshVoiceProfileSettings?.(ctx.guildId, { voiceChannelId });
      await ctx.reply.success(ctx.t('autoplay.set', {
        channel: `<#${voiceChannelId}>`,
        state: ctx.t(value ? 'common.on' : 'common.off'),
      }));
    },
  }));
}
