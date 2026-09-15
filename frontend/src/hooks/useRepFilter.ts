import { createElement, useMemo } from 'react';
import { useRepList } from './useRepList';
import { RepAvatar } from '../components/RepAvatar';

/**
 * The rep filter, shared by every page that has one.
 *
 *   Tous les reps    everyone - the sales team plus internal      ← DEFAULT
 *   Interne          everybody NOT in the View dropdown
 *   ── then each rep in the View dropdown, individually ──
 *
 * **Only the current sales team is listed by name.** The other ~21 names on the
 * data - internal billing entities and former staff - are what "Interne" is for;
 * listing them individually as well made a 30-item dropdown in which the nine
 * people anybody actually looks for were buried.
 *
 * There is deliberately no "Équipe entière" option. "Tous les reps" is the
 * default and already means team + internal, so a third group that meant
 * "everyone except internal" was one more thing to reason about for a view
 * nobody had asked to start on.
 *
 * The team list comes from useRepList() - the same source the View dropdown
 * uses, allowed_users minus INTERNAL_REP_NAMES - so the two can never disagree.
 */

export const REP_ALL = 'Tous';
export const REP_INTERNAL = 'Interne';

/** What every page starts on. */
export const REP_DEFAULT = REP_ALL;

export interface RepFilter {
    /** Options for the <Select>: Tous, Interne, then the team by name. Each
     *  carries the rep's face, so the filter reads the same way as the rows it
     *  filters. */
    options: { value: string; label: string; icon?: React.ReactNode }[];
    /**
     * The rep list to send as `p_reps`. NULL means "no filter" - used by
     * "Tous les reps", by a single rep (which uses `rep` instead), and while the
     * team list is still loading, because a half-loaded team would silently
     * under-report rather than show everything.
     */
    reps: string[] | null;
    /** The single name to send as `p_rep`, or null for a group. Kept separate
     *  because on the invoice functions p_rep also selects that rep's objective,
     *  and a group has no single target. */
    rep: string | null;
    /** The current sales team, for anything that needs it directly. */
    team: string[];
    /**
     * Does one row belong to the current selection?
     *
     * For the pages that fetch every rep and filter in memory - the weekly and
     * quarterly views - so the membership rule lives here rather than being
     * re-implemented, slightly differently, on four pages.
     */
    matches: (repName: string | null | undefined) => boolean;
}

/**
 * @param selected   current dropdown value
 * @param allReps    every rep name present in the data being filtered
 */
export function useRepFilter(selected: string, allReps: string[]): RepFilter {
    const team = useRepList();

    return useMemo(() => {
        const teamSet = new Set(team.map(n => n.normalize('NFC')));
        // Everyone in the data who is not on the current team: internal billing
        // entities and former staff alike. Never listed by name - this is the
        // membership of the "Interne" option.
        const internal = allReps
            .filter(n => !teamSet.has(n.normalize('NFC')))
            .sort();

        // createElement rather than JSX so this stays a .ts file. Renaming it to
        // .tsx trips react-refresh/only-export-components, which treats any .tsx
        // exporting non-components as a Fast Refresh hazard - and this file
        // exports a hook and two constants, no component at all.
        const avatar = (n: string) => createElement(RepAvatar, { name: n, size: 'sm' });
        const options = [
            { value: REP_ALL, label: 'Tous les reps', icon: avatar(REP_ALL) },
            { value: REP_INTERNAL, label: 'Interne', icon: avatar(REP_INTERNAL) },
            ...team.map(n => ({ value: n, label: n, icon: avatar(n) })),
        ];

        let reps: string[] | null = null;
        let rep: string | null = null;

        if (selected === REP_INTERNAL) {
            // Until allowed_users has answered, team is [] and internal is
            // therefore everyone. Sending that would look like a working filter
            // showing wrong numbers; NULL shows everything for the one render
            // before the list arrives, which at least matches the default.
            reps = team.length > 0 && internal.length > 0 ? internal : null;
        } else if (selected !== REP_ALL) {
            // A name. Anything unrecognised - an old ?rep=Equipe link from before
            // the groups were reworked - falls through to no filter rather than
            // an empty page, because `rep` stays null unless the name is a real
            // team member.
            if (teamSet.has(selected.normalize('NFC'))) rep = selected;
        }

        const teamHas = (n: string) => teamSet.has(n.normalize('NFC'));
        const matches = (repName: string | null | undefined): boolean => {
            if (selected === REP_ALL) return true;
            const n = (repName ?? '').normalize('NFC');
            if (selected === REP_INTERNAL) return n !== '' && !teamHas(n);
            // A team member: exact match. Anything else (an old ?rep= value) is
            // treated as no filter, matching how `rep` stays null above.
            return teamHas(selected) ? n === selected.normalize('NFC') : true;
        };

        return { options, reps, rep, team, matches };
    }, [selected, allReps, team]);
}
