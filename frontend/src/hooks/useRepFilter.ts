import { useMemo } from 'react';
import { useRepList } from './useRepList';

/**
 * The rep filter, with two group options above the individual names.
 *
 * Asked for on 2026-09-08. The dropdown used to list every name that has ever
 * owned a record — 30 of them on the accounts, most of whom left years ago —
 * with no way to say "just the current sales team".
 *
 *   Équipe entière   the reps in the View dropdown        ← DEFAULT
 *   Interne          everybody else
 *   Tous les reps    both, i.e. no filter at all
 *   ── then each rep individually ──
 *
 * "Équipe entière" is the default because it is the only one of the three that
 * answers "how is the sales team doing" — the question these dashboards exist
 * for. The other two are always one click away, and the two groups together are
 * exhaustive, so nothing is ever hidden without the reader choosing it.
 *
 * The team list comes from useRepList(), the same source the View dropdown uses,
 * so the two can never disagree: allowed_users minus INTERNAL_REP_NAMES.
 */

export const REP_ALL = 'Tous';
export const REP_TEAM = 'Equipe';
export const REP_INTERNAL = 'Interne';

/** What the page should default to. */
export const REP_DEFAULT = REP_TEAM;

export interface RepFilter {
    /** Options for the <Select>, groups first. */
    options: { value: string; label: string }[];
    /**
     * The rep list to send as `p_reps`. NULL means "no filter" — used by
     * "Tous les reps" and while the team list is still loading, because a
     * half-loaded team would silently under-report rather than show everything.
     */
    reps: string[] | null;
    /** The single name to send as `p_rep`, or null for a group. Kept separate
     *  because on the invoice functions p_rep also selects that rep's objective,
     *  and a group has no single target. */
    rep: string | null;
    /** The current sales team, for anything that needs it directly. */
    team: string[];
}

/**
 * @param selected   current dropdown value
 * @param allReps    every rep name present in the data being filtered
 */
export function useRepFilter(selected: string, allReps: string[]): RepFilter {
    const team = useRepList();

    return useMemo(() => {
        const teamSet = new Set(team.map(n => n.normalize('NFC')));
        // Anyone in the data who is not on the current team: internal billing
        // entities and former staff alike. Team + internal is exhaustive by
        // construction, so the two groups always add up to "Tous".
        const internal = allReps
            .filter(n => !teamSet.has(n.normalize('NFC')))
            .sort();

        const options = [
            { value: REP_TEAM, label: 'Équipe entière' },
            { value: REP_INTERNAL, label: 'Interne' },
            { value: REP_ALL, label: 'Tous les reps' },
            ...team.map(n => ({ value: n, label: n })),
            ...internal.map(n => ({ value: n, label: n })),
        ];

        let reps: string[] | null = null;
        let rep: string | null = null;

        if (selected === REP_TEAM) {
            // Until allowed_users has answered, team is []. Sending an empty
            // array would filter everything out and show a page of zeros; NULL
            // shows everything for the one render before the list arrives.
            reps = team.length > 0 ? team : null;
        } else if (selected === REP_INTERNAL) {
            reps = internal.length > 0 ? internal : null;
        } else if (selected !== REP_ALL) {
            rep = selected;
        }

        return { options, reps, rep, team };
    }, [selected, allReps, team]);
}
