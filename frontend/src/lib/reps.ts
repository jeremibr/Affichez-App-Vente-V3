/**
 * Faces for rep names.
 *
 * The nine portraits in `public/reps/` are the whole current sales team - every
 * name the View picker offers and every name a rep filter lists. The originals
 * they were cut from live in `assets/reps-source/` at the repo root, outside
 * anything Vite serves; that folder's README says where they came from and how
 * to regenerate. Here they are square-cropped and down to 128x128: they are
 * shown between 20px in a dropdown row and 48px in a picker header, so the
 * kit's 768x768 originals were 574 KB to render about a postage stamp. At 128
 * they are sharp on a 2x screen at every size the app uses, for 23 KB in total.
 *
 * **Everyone else gets initials, not a stock silhouette.** The data holds ~69
 * distinct names - former staff, CRM task owners, invoice creators - and a
 * single grey person icon repeated sixty times is worse than no picture at all:
 * in a leaderboard it removes the one thing an avatar is for, which is telling
 * rows apart at a glance. Initials on a stable colour is what every CRM does,
 * costs no request, and never collides with a real face.
 *
 * This is a **snapshot and it does not sync.** When somebody joins or leaves,
 * `allowed_users` changes but this file does not, and the new person quietly
 * falls back to initials - which is the right failure, but it is a failure.
 * Add the portrait to assets/reps-source/, re-run scratchpad/build_rep_photos.py
 * and add the name below.
 */
import { dataToneIndex } from './dataTone';

/** Photo slugs, keyed by the name as the database spells it. */
const PHOTO_BY_NAME: Record<string, string> = {
    'Dominic Letendre': 'dominic-letendre',
    'Francis Adam': 'francis-adam',
    'Guillaume Montambeault': 'guillaume-montambeault',
    'Kim Foster Cunningham': 'kim-foster-cunningham',
    'Morgane Owczarzak': 'morgane-owczarzak',
    'Nadya Rocheleau': 'nadya-rocheleau',
    'Paul Ayoub': 'paul-ayoub',
    'Richard Courville': 'richard-courville',
    'Sylvain Desrosiers': 'sylvain-desrosiers',
};

/**
 * Names that are not people.
 *
 * Billing entities and system accounts that own rows exactly like a rep does.
 * They get a building glyph rather than initials, because "MA" in a coloured
 * circle reads as a colleague nobody can place.
 */
const SYSTEM_NAMES = new Set([
    'affichez quebec', 'magasin affichez', 'vente interne', 'zoho books',
    'crm master', 'henri affichez', 'eva (ia)',
]);

/**
 * Group labels the rep filters put in the dropdown. They stand for a set of
 * people, so they get a group glyph - never a face and never initials, which
 * would read as a person called "Interne".
 */
const GROUP_LABELS = new Set([
    'tous', 'tous les reps', 'toutes', 'interne', 'equipe', 'equipe entiere',
    "toute l'equipe", 'tous les representants',
]);

/** Accents stripped, case folded, runs of whitespace collapsed - the database
 *  holds at least one name with a double space ("Ibrahim  Melhem"). */
function key(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

const PHOTO_BY_KEY: Record<string, string> = Object.fromEntries(
    Object.entries(PHOTO_BY_NAME).map(([name, slug]) => [key(name), slug]),
);

export type RepAvatarKind = 'photo' | 'initials' | 'system' | 'group';

export interface RepIdentity {
    kind: RepAvatarKind;
    /** Served from public/reps. Only set when kind is 'photo'. */
    src?: string;
    /** One or two letters. Only set when kind is 'initials'. */
    initials?: string;
    /** 0-9, into the shared categorical palette. */
    tone: number;
}

/**
 * At most two letters, from the first and last word.
 *
 * "Anne-Marie Delisle-Maltais" gives AD, not AMDM - more than two letters stops
 * fitting a 20px circle and stops being readable at a glance, which is the
 * whole job. A single-word name ("Alexis", "Tomy") gives one letter rather than
 * two from the same word, because "AL" looks like a surname that is not there.
 */
export function repInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    const first = words[0][0] ?? '';
    const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
    return (first + last).toUpperCase();
}

export function repIdentity(name: string | null | undefined): RepIdentity {
    const raw = (name ?? '').trim();
    if (!raw) return { kind: 'group', tone: 0 };

    const k = key(raw);
    const slug = PHOTO_BY_KEY[k];
    if (slug) return { kind: 'photo', src: `/reps/${slug}.webp`, tone: dataToneIndex(raw) };
    if (GROUP_LABELS.has(k)) return { kind: 'group', tone: dataToneIndex(raw) };
    if (SYSTEM_NAMES.has(k)) return { kind: 'system', tone: dataToneIndex(raw) };
    return { kind: 'initials', initials: repInitials(raw), tone: dataToneIndex(raw) };
}
