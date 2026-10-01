import type { SommaireRow } from '../types/database';

/**
 * The rows of get_sommaire / get_inv_sommaire for the selected departments, as
 * one row per month.
 *
 * One department is returned as the RPC gave it. Several are summed, and the
 * rate is recomputed from the summed objective and amount - an average of the
 * departments' own rates would weigh a small department like a large one.
 */
export function sumDepartments(rows: SommaireRow[], departments: string[]): SommaireRow[] {
    if (departments.length === 1) {
        return rows.filter(r => r.department === departments[0]);
    }

    const wanted = new Set(departments);
    const byMonth = new Map<number, SommaireRow>();
    for (const r of rows) {
        if (!r.department || !wanted.has(r.department)) continue;
        const acc = byMonth.get(r.month)
            ?? { month: r.month, objectif: 0, actual_amount: 0, pct_atteint: 0, deal_count: 0 };
        acc.objectif += Number(r.objectif);
        acc.actual_amount += Number(r.actual_amount);
        acc.deal_count += Number(r.deal_count);
        byMonth.set(r.month, acc);
    }

    return [...byMonth.values()]
        .sort((a, b) => a.month - b.month)
        .map(r => ({
            ...r,
            pct_atteint: r.objectif > 0 ? Math.round((r.actual_amount / r.objectif) * 10000) / 100 : 0,
        }));
}
