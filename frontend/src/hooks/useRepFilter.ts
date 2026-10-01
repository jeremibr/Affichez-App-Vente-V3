import { createElement, useMemo } from 'react';
import { useRepList } from './useRepList';
import { RepAvatar } from '../components/RepAvatar';

/**
 * The rep filter, shared by every page that has one. It takes several values:
 *
 *   (nothing selected)   everyone - the sales team plus internal      ← DEFAULT
 *   Interne              everybody NOT in the View dropdown
 *   ── then each rep in the View dropdown, individually ──
 *
 * **Only the current sales team is listed by name.** The other ~21 names on the
 * data - internal billing entities and former staff - are what "Interne" is for;
 * listing them individually as well made a 30-item dropdown in which the nine
 * people anybody actually looks for were buried.
 *
 * There is deliberately no "Équipe entière" option. No selection already means
 * team + internal, so a group that meant "everyone except internal" was one
 * more thing to reason about for a view nobody had asked to start on. Ticking
 * the whole team now says exactly that, for whoever wants it.
 *
 * The team list comes from useRepList() - the same source the View dropdown
 * uses, allowed_users minus INTERNAL_REP_NAMES - so the two can never disagree.
 */

/** The label, and the avatar key, of the empty selection. */
export const REP_ALL = 'Tous';
export const REP_ALL_LABEL = 'Tous les reps';
export const REP_INTERNAL = 'Interne';

export interface RepFilter {
    /** Options for the <MultiSelect>: Interne, then the team by name. Each
     *  carries the rep's face, so the filter reads the same way as the rows it
     *  filters. "Tous les reps" is the empty selection, not an option. */
    options: { value: string; label: string; icon?: React.ReactNode }[];
    /** The face shown beside "Tous les reps". */
    allIcon: React.ReactNode;
    /**
     * The rep list to send as `p_reps`. NULL means "no filter" - used when
     * nothing is selected, by a single rep (which uses `rep` instead), and while
     * the team list is still loading, because a half-loaded team would silently
     * under-report rather than show everything.
     */
    reps: string[] | null;
    /** The single name to send as `p_rep`, or null for a group. Kept separate
     *  because on the dashboard functions p_rep also selects that rep's
     *  objective. */
    rep: string | null;
    /**
     * The names to send as `p_target_reps`: set when several reps are selected
     * and every one of them is on the sales team, so the objective shown is the
     * sum of theirs. NULL as soon as "Interne" is part of the selection - that
     * group has no objective, and scoring it against the others' would compare
     * two different sets of people.
     */
    targetReps: string[] | null;
    /** True when nothing (recognised) is selected. */
    isAll: boolean;
    /**
     * The selection as the dropdown should show it: only values it recognises.
     * A name from an old link that is not on the team is dropped here exactly as
     * it is dropped from the query, so the control never shows a filter that is
     * not being applied.
     */
    selected: string[];
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
 * @param selected   current selection (empty = everyone)
 * @param allReps    every rep name present in the data being filtered
 */
export function useRepFilter(selected: string[], allReps: string[]): RepFilter {
    const team = useRepList();

    return useMemo(() => {
        const nfc = (n: string) => n.normalize('NFC');
        const teamSet = new Set(team.map(nfc));
        const teamHas = (n: string) => teamSet.has(nfc(n));
        // Everyone in the data who is not on the current team: internal billing
        // entities and former staff alike. Never listed by name - this is the
        // membership of the "Interne" option.
        const internal = allReps.filter(n => !teamHas(n)).sort();

        // createElement rather than JSX so this stays a .ts file. Renaming it to
        // .tsx trips react-refresh/only-export-components, which treats any .tsx
        // exporting non-components as a Fast Refresh hazard - and this file
        // exports a hook and constants, no component at all.
        const avatar = (n: string) => createElement(RepAvatar, { name: n, size: 'sm' });
        const options = [
            { value: REP_INTERNAL, label: REP_INTERNAL, icon: avatar(REP_INTERNAL) },
            ...team.map(n => ({ value: n, label: n, icon: avatar(n) })),
        ];

        // Anything unrecognised - an old ?rep=Equipe link from before the groups
        // were reworked, a rep who has left the team - is dropped rather than
        // matched against nothing, so a stale link shows everything instead of
        // an empty page.
        const wantsInternal = selected.includes(REP_INTERNAL);
        const names = [...new Set(selected.filter(n => n !== REP_INTERNAL && teamHas(n)))].sort();

        // Until the team list and the names in the data have both answered,
        // "internal" cannot be computed: with no team everybody looks internal,
        // and with no data nobody does. Sending either would look like a working
        // filter showing wrong numbers, so Interne narrows nothing for the one
        // render before they arrive.
        //
        // Once both are known, an empty internal group is a real answer: the
        // data holds no internal rep, and the selection matches no row.
        const internalReady = team.length > 0 && allReps.length > 0;
        const internalNames = wantsInternal && internalReady ? internal : [];

        let rep: string | null = null;
        let reps: string[] | null = null;
        let targetReps: string[] | null = null;

        if (names.length === 1 && !wantsInternal) {
            rep = names[0];
        } else if (names.length > 0 || (wantsInternal && internalReady)) {
            reps = [...internalNames, ...names];
            if (!wantsInternal && names.length > 1) targetReps = names;
        }

        // Decided from the selection itself, not from `rep`/`reps`: the pages
        // that filter in memory pass the team as `allReps`, so `internal` is
        // empty there and "Interne" would otherwise read as no filter at all.
        const isAll = !wantsInternal && names.length === 0;
        const nameSet = new Set(names.map(nfc));
        const matches = (repName: string | null | undefined): boolean => {
            if (isAll) return true;
            const n = nfc(repName ?? '');
            if (n === '') return false;
            if (nameSet.has(n)) return true;
            return wantsInternal && !teamHas(n);
        };

        const shown = [...(wantsInternal ? [REP_INTERNAL] : []), ...names];

        return { options, allIcon: avatar(REP_ALL), reps, rep, targetReps, isAll, selected: shown, team, matches };
    }, [selected, allReps, team]);
}
