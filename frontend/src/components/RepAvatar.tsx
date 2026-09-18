import { useState } from 'react';
import { Users, Building2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { repIdentity } from '../lib/reps';
import { useRepTeam, INTERNAL_LABEL } from '../lib/repTeam';

/**
 * A rep's face, wherever their name appears.
 *
 * Four outcomes, in order: the portrait if we have one; a group glyph for a
 * dropdown option that stands for several people ("Tous les reps", "Interne");
 * a building glyph for a billing entity that is not a person ("Vente interne",
 * "Magasin Affichez"); otherwise their initials on a stable colour.
 *
 * A name that is not on the current sales team belongs to the Interne group, so
 * it is drawn as that group - the same glyph the filter shows - rather than as
 * the person. The rule lives here so every screen follows it (see lib/repTeam).
 *
 * The colour comes from the same hash the service and source badges use, so a
 * rep without a photo is the same colour on the leaderboard, in the filter and
 * in the table - and two reps side by side are almost never the same colour.
 *
 * `sm` is the size for a table row or a dropdown option, `md` for a card
 * header, `lg` for the picker headers on /reps and Ma Paye. They are fixed
 * rather than free-form so avatars line up down a column.
 */

const SIZES = {
    xs: { box: 'w-5 h-5', text: 'text-[9px]', icon: 'w-2.5 h-2.5', px: 20 },
    sm: { box: 'w-6 h-6', text: 'text-[10px]', icon: 'w-3 h-3', px: 24 },
    md: { box: 'w-8 h-8', text: 'text-xs', icon: 'w-4 h-4', px: 32 },
    lg: { box: 'w-12 h-12', text: 'text-lg', icon: 'w-6 h-6', px: 48 },
} as const;

export type RepAvatarSize = keyof typeof SIZES;

const TONE_FILL = [
    'bg-data-1 text-data-1-ink',
    'bg-data-2 text-data-2-ink',
    'bg-data-3 text-data-3-ink',
    'bg-data-4 text-data-4-ink',
    'bg-data-5 text-data-5-ink',
    'bg-data-6 text-data-6-ink',
    'bg-data-7 text-data-7-ink',
    'bg-data-8 text-data-8-ink',
    'bg-data-9 text-data-9-ink',
    'bg-data-10 text-data-10-ink',
] as const;

export function RepAvatar({ name, size = 'sm', className, square, literal }: {
    name: string | null | undefined;
    size?: RepAvatarSize;
    className?: string;
    /** Rounded square instead of a circle, for the large picker headers that
     *  already use that shape. */
    square?: boolean;
    /**
     * Draw this person, not the group they belong to.
     *
     * For the few screens whose subject IS the individual - the signed-in user,
     * a rep picker, who typed a document, whose commission line this is. Every
     * screen that reports a rep's numbers leaves it off, so off-team names
     * collapse into Interne there.
     */
    literal?: boolean;
}) {
    // A portrait that 404s - a slug renamed, a file not deployed - must fall
    // back to initials rather than leave a broken-image box in the table.
    const [failed, setFailed] = useState(false);

    const { isInternal } = useRepTeam();
    const id = repIdentity(!literal && isInternal(name) ? INTERNAL_LABEL : name);
    const s = SIZES[size];
    const shape = square ? 'rounded-lg' : 'rounded-full';
    const base = cn('shrink-0 flex items-center justify-center overflow-hidden select-none', s.box, shape, className);

    if (id.kind === 'photo' && !failed) {
        return (
            <img
                src={id.src}
                alt=""
                aria-hidden="true"
                width={s.px}
                height={s.px}
                // Not lazy. There are nine portraits and 23 KB of them in
                // total, so every one is in cache after the first screen; lazy
                // loading bought nothing and cost a visible pop-in each time a
                // dropdown opened. A hundred-row table still requests at most
                // nine distinct URLs.
                decoding="async"
                onError={() => setFailed(true)}
                className={cn(base, 'object-cover bg-stone')}
            />
        );
    }

    if (id.kind === 'group' || id.kind === 'system') {
        const Icon = id.kind === 'group' ? Users : Building2;
        return (
            <span className={cn(base, 'bg-stone text-ink-mute')} aria-hidden="true">
                <Icon className={s.icon} />
            </span>
        );
    }

    return (
        <span
            className={cn(base, TONE_FILL[id.tone], 'font-semibold tracking-tight', s.text)}
            aria-hidden="true"
            translate="no"
        >
            {id.initials}
        </span>
    );
}

/**
 * Avatar and name together - the shape almost every call site wants.
 *
 * The avatar is aria-hidden and the name carries the meaning, so a screen
 * reader says the name once rather than describing a picture of it.
 */
export function RepName({ name, size = 'sm', className, nameClassName, fallback = '—', literal }: {
    name: string | null | undefined;
    size?: RepAvatarSize;
    className?: string;
    nameClassName?: string;
    /** Shown when there is no name at all; no avatar is drawn for it. */
    fallback?: string;
    /** See RepAvatar: name the person rather than the group. */
    literal?: boolean;
}) {
    const { display } = useRepTeam();
    if (!name || !name.trim()) {
        return <span className={cn('text-ink-faint', className)}>{fallback}</span>;
    }
    return (
        <span className={cn('inline-flex items-center gap-2 min-w-0', className)}>
            <RepAvatar name={name} size={size} literal={literal} />
            <span className={cn('truncate', nameClassName)}>{literal ? name : display(name)}</span>
        </span>
    );
}
