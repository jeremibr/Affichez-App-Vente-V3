import { useMemo, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { INTERNAL_REP_NAMES } from './constants';

/**
 * Who is on the sales team, and therefore who is "Interne".
 *
 * A name that is not on the current team - a former rep, a billing entity, a CRM
 * task owner - is shown as **Interne** everywhere, never by name, and rows for
 * those names are summed into a single Interne line. That is the same
 * membership rule the rep filter uses (see hooks/useRepFilter), so a filter and
 * the rows it filters can never disagree.
 *
 * The team list is fetched **once per session and shared**: this is now read by
 * table cells, so a per-component fetch would be one request per avatar.
 */

export const INTERNAL_LABEL = 'Interne';

interface TeamState {
    team: string[];
    /** False until allowed_users has answered. */
    loaded: boolean;
}

let state: TeamState = { team: [], loaded: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
    if (!inflight) {
        inflight = (async () => {
            const internal = new Set((INTERNAL_REP_NAMES as readonly string[]).map(n => n.normalize('NFC')));
            const { data } = await supabase
                .from('allowed_users')
                .select('rep_name')
                .not('rep_name', 'is', null);
            const team = [...new Set(
                (data ?? [])
                    .map((r: { rep_name: string }) => r.rep_name)
                    .filter(Boolean)
                    .filter((n: string) => !internal.has(n.normalize('NFC'))),
            )].sort() as string[];
            state = { team, loaded: true };
            for (const l of listeners) l();
        })();
    }
    return inflight;
}

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    void load();
    return () => { listeners.delete(onChange); };
}

export interface RepTeam {
    team: string[];
    loaded: boolean;
    /** True when the name belongs to the Interne group. */
    isInternal: (name: string | null | undefined) => boolean;
    /** What to show for this name: their own name, or "Interne". */
    display: (name: string | null | undefined) => string;
}

export function repTeamFrom({ team, loaded }: TeamState): RepTeam {
    const set = new Set(team.map(n => n.normalize('NFC')));
    const isInternal = (name: string | null | undefined): boolean => {
        const n = (name ?? '').trim();
        if (!n) return false;
        // Before the list arrives everybody looks like an outsider. Treating
        // nobody as internal for that one render is better than flashing every
        // rep's name to "Interne" and back.
        if (!loaded) return false;
        if (n === INTERNAL_LABEL) return true;
        return !set.has(n.normalize('NFC'));
    };
    return {
        team,
        loaded,
        isInternal,
        display: (name) => (isInternal(name) ? INTERNAL_LABEL : (name ?? '')),
    };
}

export function useRepTeam(): RepTeam {
    // Stable identity while the team list is unchanged, so callers can pass it
    // as a useMemo dependency without recomputing on every render.
    const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
    return useMemo(() => repTeamFrom(snapshot), [snapshot]);
}

/**
 * Collapses every internal row of a grouped table into one "Interne" row.
 *
 * `combine` receives the running Interne row and the next internal row and
 * returns their sum; derived values (rates, per-account averages) must be
 * recomputed there rather than added.
 */
export function mergeInternalRows<T>(
    rows: T[],
    repTeam: RepTeam,
    nameOf: (row: T) => string | null | undefined,
    toInterne: (row: T) => T,
    combine: (acc: T, row: T) => T,
): T[] {
    if (!repTeam.loaded) return rows;

    const out: T[] = [];
    let interne: T | null = null;
    for (const row of rows) {
        if (!repTeam.isInternal(nameOf(row))) {
            out.push(row);
            continue;
        }
        interne = interne === null ? toInterne(row) : combine(interne, row);
    }
    if (interne !== null) out.push(interne);
    return out;
}
