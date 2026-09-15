/**
 * Which of the ten categorical tones a label gets.
 *
 * Shared by the service/source badges (`TagCell`) and the fallback rep avatars,
 * so a value that has no photo still has one stable colour everywhere it
 * appears. The colour is derived from the text, never from the position in a
 * list: a table that re-colours itself when it is re-sorted is worse than one
 * with no colour at all.
 *
 * The two constants are not arbitrary. Ten tones against ~45 distinct labels
 * means collisions cannot be ruled out - fourteen account sources into ten
 * tones forces at least four. So the pair was chosen by search: the one that
 * spreads the labels this app actually holds (the 14 commonest sources, the 8
 * services, the 7 invoice departments) across the most tones, weighted by how
 * many accounts carry each. Re-run scratchpad/tune_tone_hash.py if the
 * picklists move far enough to matter.
 */

export const DATA_TONE_COUNT = 10;

const MULTIPLIER = 54677;
const SEED = 251886;

/**
 * Accents stripped and case folded, so Zoho's two spellings of
 * "Distribution Publicitaire" - and a rep name typed with a stray double space
 * - resolve to one key rather than two colours.
 */
export function dataToneKey(label: string): string {
    return label
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

export function dataToneIndex(label: string): number {
    const k = dataToneKey(label);
    let h = SEED;
    for (let i = 0; i < k.length; i++) h = (h * MULTIPLIER + k.charCodeAt(i)) | 0;
    return Math.abs(h) % DATA_TONE_COUNT;
}
