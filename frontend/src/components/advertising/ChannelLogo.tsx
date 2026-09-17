import type { AdChannel } from '../../types/database';
import { cn } from '../../lib/utils';
import { CHANNEL_LABEL } from './channel';

/** Official platform marks, served unmodified from public/ads/. */
const LOGO_SRC: Record<AdChannel, string> = {
    google: '/ads/google-ads.svg',
    meta: '/ads/meta.svg',
};

const SIZE = {
    xs: 'h-3.5 w-3.5',
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
} as const;

/**
 * Google Ads / Meta logo. Decorative by default (empty alt) because it is almost
 * always shown next to the channel name; pass `decorative={false}` when it stands alone.
 */
export function ChannelLogo({ channel, size = 'sm', decorative = true, className }: {
    channel: AdChannel;
    size?: keyof typeof SIZE;
    decorative?: boolean;
    className?: string;
}) {
    return (
        <img
            src={LOGO_SRC[channel]}
            alt={decorative ? '' : CHANNEL_LABEL[channel]}
            aria-hidden={decorative || undefined}
            draggable={false}
            className={cn(SIZE[size], 'shrink-0 object-contain', className)}
        />
    );
}

/** Logo on a neutral tile, for card and table headers. */
export function ChannelLogoTile({ channel, size = 'md' }: {
    channel: AdChannel;
    size?: 'sm' | 'md';
}) {
    return (
        <span className={cn(
            'shrink-0 inline-flex items-center justify-center rounded-md bg-sand',
            size === 'md' ? 'h-9 w-9' : 'h-7 w-7',
        )}>
            <ChannelLogo channel={channel} size={size === 'md' ? 'md' : 'sm'} />
        </span>
    );
}
