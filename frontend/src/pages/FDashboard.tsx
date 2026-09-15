import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, TrendingUp, Target, Briefcase, Trophy, User, FileText, X, ChevronRight, Unlink } from 'lucide-react';
import type { SommaireRow, InvoiceUnassignedSummary, UnassignedInvoiceRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { DEPARTMENTS, MONTHS, OFFICES, INVOICE_STATUSES, INTERNAL_REP_NAMES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, formatShortDate, cn } from '../lib/utils';
import { InfoHint } from '../components/InfoHint';
import { useRepFilter, REP_DEFAULT, REP_ALL } from '../hooks/useRepFilter';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import { useAuth } from '../contexts/AuthContext';
import { RepAvatar } from '../components/RepAvatar';

interface InvDashboardKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    paid_total: number;
    partial_total: number;
    avoir_total: number;
}

interface TopClient { client_name: string; total_amount: number; deal_count: number; office: string; }

// Asked for directly in the 2026-09-04 meeting: "je veux tout le temps qu'on
// puisse telecharger les rapports partout". The export always carries the FULL
// list behind each card, not the five rows the card shows.
const CLIENT_CSV: CsvColumn<TopClient>[] = [
    { header: 'Client',   value: c => c.client_name },
    { header: 'Bureau',   value: c => c.office },
    { header: 'Factures', value: c => c.deal_count },
    { header: 'Montant',  value: c => c.total_amount },
];
interface LeaderboardEntry { rep_name: string; office: string; total_amount: number; deal_count: number; avg_deal: number; rank: number; }

const LEADERBOARD_CSV: CsvColumn<LeaderboardEntry>[] = [
    { header: 'Rang',              value: r => r.rank },
    { header: 'Representant',      value: r => r.rep_name },
    { header: 'Bureau',            value: r => r.office },
    { header: 'Factures',          value: r => r.deal_count },
    { header: 'Montant',           value: r => r.total_amount },
    { header: 'Facture moyenne',   value: r => r.avg_deal },
];

export default function FDashboard() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    const [selectedStatus, setSelectedStatus] = useUrlState('status', 'Toutes');
    const [selectedDept, setSelectedDept] = useUrlState('dept', 'Toutes');
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Admin can switch reps; members are locked to their own rep
    const [selectedRep, setSelectedRep] = useUrlState('rep', isAdmin ? REP_DEFAULT : (authRepName ?? REP_ALL));

    const [loading, setLoading] = useState(true);
    const [showLeaderboard, setShowLeaderboard] = useState(false);
    const [showClients, setShowClients] = useState(false);
    const [grandTotalData, setGrandTotalData] = useState<SommaireRow[]>([]);
    const [deptData, setDeptData] = useState<SommaireRow[]>([]);
    const [prevGrandTotalData, setPrevGrandTotalData] = useState<SommaireRow[]>([]);
    const [prevDeptData, setPrevDeptData] = useState<SommaireRow[]>([]);
    const [kpis, setKpis] = useState<InvDashboardKPIs | null>(null);
    // Billing the app cannot tie to a CRM account, so it never reaches a lead.
    const [unassigned, setUnassigned] = useState<InvoiceUnassignedSummary | null>(null);
    const [showUnassigned, setShowUnassigned] = useState(false);
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    /**
     * Every rep who billed anything this year, fetched WITHOUT a rep filter.
     *
     * It used to be scraped out of the leaderboard the page had just loaded,
     * which fed the filter its own output: choosing "Équipe entière" narrowed the
     * leaderboard to the team, allReps then held only the team, "Interne"
     * computed allReps-minus-team = nothing, and an empty group falls back to no
     * filter - so Interne silently showed EVERYONE, with a higher total than the
     * team it was supposed to be a subset of.
     *
     * One unfiltered read per year breaks the loop.
     */
    const [allReps, setAllReps] = useState<string[]>([]);

    /**
     * The rep filter, rebuilt 2026-09-08.
     *
     * THE BUG being fixed: 'Tous' and 'Vente Interne' BOTH resolved to
     * repParam = null, so they sent an identical query - switching between them
     * changed nothing on screen. repParam was also the effect dependency, so
     * nothing even refetched.
     *
     * The dropdown now offers groups: Équipe entière (the reps in the View
     * dropdown, and the default) and Interne (everybody else). p_rep cannot
     * express a group - it holds one name - so p_reps carries the list.
     *
     * Both are sent because they do different jobs on these functions: p_rep
     * filters rows AND selects that rep's own objective from rep_objectives,
     * while p_reps filters rows only and leaves the team objective in place. A
     * group has no single target, so a group sends p_rep = null.
     */
    const repFilter = useRepFilter(selectedRep, allReps);
    const repParam = isAdmin ? repFilter.rep : (authRepName ?? null);
    // Only an admin gets the group options; a rep is pinned to their own name,
    // where p_rep already does the right thing and a list would add nothing.
    const repsParam = isAdmin ? repFilter.reps : null;

    useEffect(() => {
        if (!isAdmin) return;
        let cancelled = false;
        (async () => {
            const { data } = await cachedRpc('get_inv_rep_leaderboard', { p_year: year });
            if (cancelled || !data) return;
            const names = (data as LeaderboardEntry[])
                .map(r => r.rep_name).filter(Boolean);
            // 'Vente interne' is dropped from the RPC by excluded_reps, so it
            // would never appear here - but it is a real biller and belongs in
            // the Interne group, so it is added back by name.
            const withInternal = [...new Set([...names, 'Vente interne'])].sort();
            setAllReps(withInternal);
        })();
        return () => { cancelled = true; };
    }, [year, isAdmin]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;
        const statusParam = selectedStatus === 'Toutes' ? null : selectedStatus;
        const deptParam = selectedDept === 'Toutes' ? null : selectedDept;
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;

        const { data: excludedClientData } = await supabase.from('excluded_clients').select('client_name');
        const excludedClients = (excludedClientData ?? []).map((r: { client_name: string }) => r.client_name);

        const [
            { data: grandData },
            { data: dData },
            { data: prevGrandData },
            { data: prevDData },
            { data: kpiData },
            { data: clientData },
            { data: leaderData },
            { data: unassignedData }
        ] = await Promise.all([
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_sommaire', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_sommaire', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_dashboard_kpis', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_dept: deptParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_top_clients', { p_year: year, p_office: officeParam, p_status: statusParam, p_limit: 200, p_month: monthParam, p_dept: deptParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_rep_leaderboard', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_dept: deptParam, p_rep: repParam, p_reps: repsParam }),
            // No status filter: an invoice is unattributed regardless of whether it is paid.
            cachedRpc('get_invoice_unassigned_summary', { p_year: year, p_office: officeParam, p_month: monthParam, p_dept: deptParam, p_rep: repParam, p_reps: repsParam })
        ]);

        setUnassigned((unassignedData as InvoiceUnassignedSummary[])?.[0] ?? null);

        // NFC-normalize both sides to handle é/è/etc. encoding differences between DB and JS strings
        const internalNamesNFC = new Set(
            (INTERNAL_REP_NAMES as readonly string[]).map(n => n.normalize('NFC'))
        );
        const isInternal = (name: string | null) => !!name && internalNamesNFC.has(name.normalize('NFC'));

        // Split internal reps: those already included in RPC results vs the one excluded at DB level
        // Only 'Vente interne' is in excluded_reps - the other 4 are already in RPC numbers
        const internalFromLeader: LeaderboardEntry[] = (leaderData || []).filter(
            (r: LeaderboardEntry) => isInternal(r.rep_name)
        );
        const baseLeader: LeaderboardEntry[] = (leaderData || []).filter(
            (r: LeaderboardEntry) => !isInternal(r.rep_name)
        );

        setTopClients(clientData || []);

        // Kept for the unfiltered view only. With a group or a single rep the
        // RPCs now reach every name themselves - p_reps stands the excluded_reps
        // guard down - so running this as well would double-count Vente interne.
        if (repParam === null && repsParam === null) {
            // Supplementary query ONLY for 'Vente interne' - the one rep actually excluded from RPC results
            // (Simon, Magasin, Charles, Pier-Alexandre are already in the RPC numbers; fetching them again would double-count)
            const buildIntQuery = (y: number) => {
                let q = supabase
                    .from('invoices')
                    .select('invoice_date, amount, is_avoir')
                    .eq('rep_name', 'Vente interne')
                    .gte('invoice_date', `${y}-01-01`)
                    .lt('invoice_date', `${y + 1}-01-01`);
                excludedClients.forEach((c: string) => { q = q.neq('client_name', c); });
                if (officeParam) q = q.eq('office', officeParam);
                if (statusParam) q = q.eq('status', statusParam as any);
                if (deptParam)   q = q.eq('department', deptParam);
                if (monthParam) {
                    const nm = monthParam === 12 ? 1 : monthParam + 1;
                    const ny2 = monthParam === 12 ? y + 1 : y;
                    const ms = String(monthParam).padStart(2, '0');
                    const me = `${ny2}-${String(nm).padStart(2, '0')}-01`;
                    q = q.gte('invoice_date', `${y}-${ms}-01`).lt('invoice_date', me);
                }
                return q;
            };

            const [{ data: intData }, { data: intPrevData }] = await Promise.all([
                buildIntQuery(year),
                buildIntQuery(year - 1),
            ]);

            // Aggregate invoice rows into a month → {amount, count} map
            const aggByMonth = (rows: any[]): Map<number, { amount: number; count: number }> => {
                const map = new Map<number, { amount: number; count: number }>();
                for (const r of (rows || [])) {
                    const m = parseInt((r.invoice_date as string).split('-')[1], 10);
                    const cur = map.get(m) || { amount: 0, count: 0 };
                    cur.amount += Number(r.amount);
                    if (!r.is_avoir) cur.count++;
                    map.set(m, cur);
                }
                return map;
            };

            const intMonthly     = aggByMonth(intData     || []);
            const intPrevMonthly = aggByMonth(intPrevData || []);

            // Merge a month-map into an array of SommaireRows (adds amounts + deal counts)
            const mergeInto = (base: SommaireRow[], extra: Map<number, { amount: number; count: number }>): SommaireRow[] => {
                const result: SommaireRow[] = (base || []).map(r => {
                    const ex = extra.get(r.month);
                    if (!ex) return r;
                    const newAmt = r.actual_amount + ex.amount;
                    return {
                        ...r,
                        actual_amount: newAmt,
                        deal_count: r.deal_count + ex.count,
                        pct_atteint: r.objectif > 0 ? (newAmt / r.objectif) * 100 : 0,
                    };
                });
                // Months present in extra but not in base
                for (const [m, ex] of extra) {
                    if (!result.find(r => r.month === m)) {
                        result.push({ month: m, objectif: 0, actual_amount: ex.amount, pct_atteint: 0, deal_count: ex.count });
                    }
                }
                return result;
            };

            setGrandTotalData(mergeInto(grandData || [], intMonthly));
            setPrevGrandTotalData(mergeInto(prevGrandData || [], intPrevMonthly));

            // Dept data: only merge when a specific dept is active (intMonthly is already dept-filtered then)
            if (deptParam) {
                const mergeDept = (base: SommaireRow[], extra: Map<number, { amount: number; count: number }>): SommaireRow[] => {
                    const result: SommaireRow[] = (base || []).map(r => {
                        if (r.department !== deptParam) return r;
                        const ex = extra.get(r.month);
                        if (!ex) return r;
                        const newAmt = r.actual_amount + ex.amount;
                        return { ...r, actual_amount: newAmt, deal_count: r.deal_count + ex.count, pct_atteint: r.objectif > 0 ? (newAmt / r.objectif) * 100 : 0 };
                    });
                    for (const [m, ex] of extra) {
                        if (!result.find(r => r.month === m && r.department === deptParam)) {
                            result.push({ month: m, department: deptParam, objectif: 0, actual_amount: ex.amount, pct_atteint: 0, deal_count: ex.count });
                        }
                    }
                    return result;
                };
                setDeptData(mergeDept(dData || [], intMonthly));
                setPrevDeptData(mergeDept(prevDData || [], intPrevMonthly));
            } else {
                setDeptData(dData || []);
                setPrevDeptData(prevDData || []);
            }

            // KPI adjustment
            const intYtdTotal = [...intMonthly.values()].reduce((s, v) => s + v.amount, 0);
            const intYtdCount = [...intMonthly.values()].reduce((s, v) => s + v.count, 0);
            const baseKpi = kpiData?.[0] ?? null;
            if (baseKpi) {
                const newTotal = baseKpi.ytd_total + intYtdTotal;
                const newCount = baseKpi.ytd_count + intYtdCount;
                setKpis({
                    ...baseKpi,
                    ytd_total: newTotal,
                    ytd_count: newCount,
                    avg_deal_size: newCount > 0 ? newTotal / newCount : 0,
                    pct_of_target: baseKpi.annual_target > 0 ? Math.round((newTotal / baseKpi.annual_target) * 100) : 0,
                });
            } else {
                setKpis(null);
            }

            // Leaderboard - combine Vente interne (from supplementary) with the other 4 internal reps (from leaderboard)
            const suppTotal   = [...intMonthly.values()].reduce((s, v) => s + v.amount, 0);
            const suppCount   = [...intMonthly.values()].reduce((s, v) => s + v.count, 0);
            const leaderTotal = internalFromLeader.reduce((s, r) => s + Number(r.total_amount), 0);
            const leaderCount = internalFromLeader.reduce((s, r) => s + Number(r.deal_count), 0);
            const intTotal = suppTotal + leaderTotal;
            const intCount = suppCount + leaderCount;
            const withInternal: LeaderboardEntry[] = (intTotal !== 0 || intCount !== 0)
                ? [...baseLeader, { rep_name: 'Vente Interne', office: '—', total_amount: intTotal, deal_count: intCount, avg_deal: intCount > 0 ? intTotal / intCount : 0, rank: 0 }]
                : baseLeader;
            const lb = withInternal
                .sort((a, b) => b.total_amount - a.total_amount)
                .map((r, i) => ({ ...r, rank: i + 1 }));
            setLeaderboard(lb);
        } else {
            setGrandTotalData(grandData || []);
            setDeptData(dData || []);
            setPrevGrandTotalData(prevGrandData || []);
            setPrevDeptData(prevDData || []);
            setKpis(kpiData?.[0] || null);
            setLeaderboard(baseLeader);
        }

        setLoading(false);
    }, [year, selectedOffice, selectedStatus, selectedDept, selectedMonth, repParam, repsParam]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        // Debounce realtime reloads: batch upserts fire many events in quick
        // succession - wait 3s of silence before re-fetching so the page doesn't
        // thrash while a sync is running.
        let timer: ReturnType<typeof setTimeout>;
        const sub = supabase.channel('inv-db-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => {
                clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 3000);
            })
            .subscribe();
        return () => { clearTimeout(timer); supabase.removeChannel(sub); };
    }, []);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous les statuts' }, ...INVOICE_STATUSES], []);
    const deptOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous services' }, ...DEPARTMENTS.map(d => ({ value: d, label: d }))], []);
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    // Groups first, then every name - from the shared hook, so the Factures and
    // Comptes pages offer exactly the same choices.
    const repOptions = repFilter.options;
    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                    Factures · Tableau de Bord
                    {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-ink-mute">({authRepName})</span>}
                </h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">Performance de facturation et indicateurs clés</p>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} className="w-40" />
                </FilterGroup>
                <FilterGroup label="Département">
                    <Select value={selectedDept} onChange={setSelectedDept} options={deptOptions} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={String(selectedMonth)} onChange={(val) => setSelectedMonth(val === 'Toutes' ? 'Toutes' : Number(val))} options={monthOptions} className="w-40" />
                </FilterGroup>
                {isAdmin && (
                    <FilterGroup label="Représentant">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} className="w-44" />
                    </FilterGroup>
                )}
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Analyse des factures en cours...</p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        <KPICard title="Total Facturé YTD" value={formatCurrencyCAD(kpis?.ytd_total || 0)} subText="Net après avoirs" icon={TrendingUp} trend={kpis?.pct_of_target} />
                        <KPICard title="Nb Factures" value={String(kpis?.ytd_count || 0)} subText="Factures (filtres actifs)" icon={FileText} />
                        <KPICard title="Montant Moyen" value={formatCurrencyCAD(kpis?.avg_deal_size || 0)} subText="Par facture" icon={Briefcase} />
                        <KPICard title="Objectif Annuel" value={formatCurrencyCAD(kpis?.annual_target || 0)} subText="Planifié pour l'année" icon={Target} />
                    </div>

                    {/* Attribution quality. Shown whenever there is anything to report so a
                        growing gap is noticed here rather than in a reconciliation later. */}
                    {unassigned && (unassigned.unassigned_count > 0 || unassigned.internal_count > 0) && (
                        <UnassignedCard data={unassigned} onOpen={() => setShowUnassigned(true)} />
                    )}

                    {showUnassigned && (
                        <UnassignedModal
                            year={year}
                            office={selectedOffice === 'Toutes' ? null : selectedOffice}
                            month={selectedMonth === 'Toutes' ? null : selectedMonth}
                            dept={selectedDept === 'Toutes' ? null : selectedDept}
                            rep={selectedRep === 'Tous' ? null : selectedRep}
                            onClose={() => setShowUnassigned(false)}
                        />
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                        {/* Leaderboard */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-ink-mute" /> Leaderboard Reps
                                </h3>
                                <div className="flex items-center gap-2">
                                    <ExportButton rows={leaderboard} columns={LEADERBOARD_CSV}
                                                  filename="leaderboard_reps_factures" disabled={leaderboard.length === 0} label="CSV" />
                                    {leaderboard.length > 5 && (
                                        <button onClick={() => setShowLeaderboard(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                            Voir tout ({leaderboard.length}) <ChevronRight className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="divide-y divide-hairline">
                                {(() => {
                                    const top5 = leaderboard.slice(0, 5);
                                    const venteInterne = leaderboard.find(r => r.rep_name === 'Vente Interne');
                                    const inTop5 = top5.some(r => r.rep_name === 'Vente Interne');
                                    const display = inTop5 || !venteInterne ? top5 : [...top5, venteInterne];
                                    return display.map((rep, idx) => (
                                        <div key={rep.rep_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                            <div className="flex items-center gap-3">
                                                <span className={cn(
                                                    "w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold",
                                                    rep.rep_name === 'Vente Interne' ? "bg-hairline-strong text-ink-secondary" :
                                                    idx === 0 ? "bg-ink text-white" : "bg-stone text-ink-secondary"
                                                )}>{rep.rep_name === 'Vente Interne' ? '—' : idx + 1}</span>
                                                <RepAvatar name={rep.rep_name} size="md" />
                                                <div className="min-w-0">
                                                    <p className="text-sm font-semibold text-ink-secondary truncate">{rep.rep_name}</p>
                                                    <p className="text-2xs text-ink-mute uppercase font-semibold">{rep.office}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm font-bold text-ink">{formatCurrencyCAD(rep.total_amount)}</p>
                                                <p className="text-sm font-bold text-ink-mute tabular-nums">{rep.deal_count} <span className="text-2xs font-normal text-ink-mute">factures</span></p>
                                            </div>
                                        </div>
                                    ));
                                })()}
                            </div>
                        </div>

                        {/* Top Clients */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <User className="w-4 h-4 text-ink-mute" /> Top 5 Clients
                                </h3>
                                <div className="flex items-center gap-2">
                                    <ExportButton rows={topClients} columns={CLIENT_CSV}
                                                  filename="top_clients_factures" disabled={topClients.length === 0} label="CSV" />
                                    {topClients.length > 5 && (
                                        <button onClick={() => setShowClients(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                            Voir tout ({topClients.length}) <ChevronRight className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="divide-y divide-hairline">
                                {topClients.slice(0, 5).map((c) => (
                                    <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                        <div className="max-w-[200px]">
                                            <p className="text-sm font-semibold text-ink-secondary truncate" title={c.client_name}>{c.client_name}</p>
                                            <p className="text-2xs text-ink-mute uppercase font-semibold">{c.office}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-ink">{formatCurrencyCAD(c.total_amount)}</p>
                                            <p className="text-sm font-bold text-ink-mute tabular-nums">{c.deal_count} <span className="text-2xs font-normal text-ink-mute">factures</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <SommaireTable
                            title={selectedDept === 'Toutes' ? "Performance Globale · Factures" : `Performance · ${selectedDept}`}
                            data={selectedDept === 'Toutes' ? grandTotalData : deptData.filter(x => x.department === selectedDept)}
                            prevYearData={selectedDept === 'Toutes' ? prevGrandTotalData : prevDeptData.filter(x => x.department === selectedDept)}
                            year={year}
                            selectedMonth={selectedMonth}
                            dealLabel="factures"
                        />
                    </div>
                </>
            )}
        </div>

        {showLeaderboard && (
            <Modal title="Leaderboard Reps · Factures" onClose={() => setShowLeaderboard(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentant</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Factures</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Moy./facture</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {leaderboard.map((rep, idx) => (
                            <tr key={rep.rep_name} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-2.5"><span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold", idx === 0 ? "bg-ink text-white" : idx === 1 ? "bg-stone text-ink-secondary" : idx === 2 ? "bg-sand text-ink-mute" : "bg-sand text-ink-faint")}>{idx + 1}</span></td>
                                <td className="px-4 py-2.5 font-semibold text-ink-secondary">
                                    <span className="flex items-center gap-2">
                                        <RepAvatar name={rep.rep_name} size="sm" />{rep.rep_name}
                                    </span>
                                </td>
                                <td className="px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase">{rep.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(rep.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink-mute tabular-nums">{rep.deal_count}</td>
                                <td className="px-4 py-2.5 text-right text-ink-mute tabular-nums text-xs">{formatCurrencyCAD(rep.avg_deal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}

        {showClients && (
            <Modal title="Tous les clients · Factures" onClose={() => setShowClients(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Client</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Factures</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {topClients.map((c, idx) => (
                            <tr key={c.client_name} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-2.5 text-xs font-bold text-ink-mute tabular-nums">{idx + 1}</td>
                                <td className="px-4 py-2.5 font-semibold text-ink-secondary max-w-[240px] truncate" title={c.client_name}>{c.client_name}</td>
                                <td className="px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase">{c.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(c.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink-mute tabular-nums">{c.deal_count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}
        </>
    );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-ink/40 backdrop-blur-xs" />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="px-5 py-4 border-b border-hairline flex items-center justify-between shrink-0">
                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                    <button onClick={onClose} className="p-1.5 rounded-md text-ink-mute hover:text-ink-secondary hover:bg-stone transition-all"><X className="w-4 h-4" /></button>
                </div>
                <div className="overflow-y-auto">{children}</div>
            </div>
        </div>
    );
}

/**
 * Invoicing with no CRM account behind it. Those invoices are real money that the
 * Leads view cannot attribute to anyone, so the figure belongs next to the totals
 * rather than in a report nobody opens.
 *
 * Internal billing is reported apart from the gap: the company invoices itself,
 * and that will never have a CRM account, so folding it in would have made the
 * number look four times worse than it is.
 */
function UnassignedCard({ data, onOpen }: {
    data: InvoiceUnassignedSummary;
    onOpen: () => void;
}) {
    return (
        <div className="bg-white rounded-xl shadow-card px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-sand rounded-md text-ink-mute">
                        <Unlink className="w-4 h-4" />
                    </div>
                    <div>
                        <div className="flex items-center gap-1.5">
                            <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                Factures non attribuées
                            </p>
                            <InfoHint text={
                                "Factures dont le client Zoho Books n'est reli\u00e9 \u00e0 aucun compte Zoho CRM. " +
                                "Elles sont bien compt\u00e9es dans le total factur\u00e9, mais n'apparaissent sur " +
                                "la fiche d'aucun lead ni d'aucun contact. La facturation interne (Affichez Inc. " +
                                "\u00e0 elle-m\u00eame) est exclue de ce chiffre et affich\u00e9e s\u00e9par\u00e9ment, " +
                                "car elle n'aura jamais de compte CRM. Cliquez pour voir les factures concern\u00e9es."
                            } />
                        </div>
                        <p className="mt-1 text-base md:text-xl font-bold text-ink tabular-nums">
                            {formatCurrencyCAD(data.unassigned_amount)}
                            <span className="ml-2 text-xs font-semibold text-ink-mute">
                                {data.unassigned_count.toLocaleString('fr-CA')}{' '}
                                {data.unassigned_count === 1 ? 'facture' : 'factures'}
                            </span>
                        </p>
                        <p className="text-2xs text-ink-mute mt-0.5 font-medium italic">
                            {data.unassigned_share}&nbsp;% de la facturation externe
                            {data.internal_count > 0 && (
                                <>
                                    {' \u00b7 '}interne exclue&nbsp;: {formatCurrencyCAD(data.internal_amount)}
                                </>
                            )}
                        </p>
                    </div>
                </div>
                {data.unassigned_count > 0 && (
                    <button
                        onClick={onOpen}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-3 py-2
                                   text-xs font-semibold text-ink-secondary transition-colors
                                   hover:border-primary hover:bg-primary-wash hover:text-primary-press"
                    >
                        Voir les factures
                        <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    );
}

/** The rows behind the figure, with the reason each one could not be linked. */
function UnassignedModal({ year, office, month, dept, rep, onClose }: {
    year: number;
    office: string | null;
    month: number | null;
    dept: string | null;
    rep: string | null;
    onClose: () => void;
}) {
    const [rows, setRows] = useState<UnassignedInvoiceRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const { data } = await cachedRpc('get_unassigned_invoices', {
                p_year: year, p_office: office, p_month: month,
                p_dept: dept, p_rep: rep, p_limit: 500,
            });
            if (cancelled) return;
            setRows((data as UnassignedInvoiceRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [year, office, month, dept, rep]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Factures non attribuées"
                onClick={e => e.stopPropagation()}
                className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-ink">Factures non attribuées</h2>
                        <p className="mt-0.5 text-sm text-ink-mute">
                            Aucun compte Zoho CRM derrière le client : ces montants n’apparaissent sur aucune fiche lead
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Fermer"
                        className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-primary-press" />
                    </div>
                ) : rows.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-ink-mute">
                        Toutes les factures de cette période sont attribuées.
                    </div>
                ) : (
                    <div className="overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Numéro</th>
                                    <th className="th">Client</th>
                                    <th className="th">Date</th>
                                    <th className="th">Bureau</th>
                                    <th className="th">Représentant</th>
                                    <th className="th">Raison</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(inv => (
                                    <tr key={inv.zoho_id} className={cn('transition-colors hover:bg-sand/70',
                                                                        inv.is_avoir && 'bg-tone-critical-soft/30')}>
                                        <td className="td font-medium text-ink">{inv.invoice_number ?? '\u2014'}</td>
                                        <td className="td text-ink-secondary">{inv.client_name}</td>
                                        <td className="td whitespace-nowrap text-ink-mute">
                                            {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '\u2014'}
                                        </td>
                                        <td className="td text-ink-mute">{inv.office ?? '\u2014'}</td>
                                        <td className="td text-ink-mute">{inv.rep_name ?? '\u2014'}</td>
                                        <td className="td">
                                            <span className="badge bg-stone text-ink-secondary">{inv.reason}</span>
                                        </td>
                                        <td className={cn('td text-right font-semibold tabular-nums',
                                                          inv.is_avoir ? 'text-tone-critical-ink' : 'text-ink')}>
                                            {formatCurrencyCAD(inv.amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-sand/60 px-6 py-3">
                    <span className="text-sm text-ink-mute" translate="no">
                        {`${rows.length} facture${rows.length > 1 ? 's' : ''}`}
                        {rows.length === 500 && ' (500 premi\u00e8res)'}
                    </span>
                    <span className="text-sm font-semibold text-ink">
                        Total <span className="tabular-nums text-base">{formatCurrencyCAD(total)}</span>
                    </span>
                </div>
            </div>
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, trend }: { title: string; value: string; subText: string; icon: React.ElementType; trend?: number }) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-sand rounded-md text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash transition-colors">
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn("text-2xs font-bold px-1.5 md:px-2 py-0.5 rounded-full", trend >= 100 ? "bg-tone-good-soft text-tone-good-ink" : "bg-tone-warn-soft text-tone-warn-ink")}>
                        {trend}%
                    </div>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className="text-base md:text-2xl font-bold text-ink mt-0.5 md:mt-1 tabular-nums">{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
