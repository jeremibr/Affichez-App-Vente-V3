import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, ExternalLink, Search, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ZohoLeadRow, ZohoLeadFilterOptions } from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatShortDate, cn } from '../lib/utils';

const STAGE_LABELS: Record<string, string> = {
    lead: 'Lead',
    contact: 'Contact',
};

const STAGE_COLORS: Record<string, string> = {
    lead: 'bg-blue-50 text-blue-600',
    contact: 'bg-emerald-50 text-emerald-600',
};

/** Zoho writes "-None-" into a picklist that was never set. */
const isBlankPick = (v: string | null): boolean => !v || v === '-None-';

/** Zoho timestamps carry an offset (…-04:00); show date + time, they matter here. */
function formatDateTime(value: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return `${formatShortDate(d)} ${d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;
}

const PAGE_SIZE = 100;

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

export default function LeadsDetail({ propRepName }: { propRepName?: string }) {
    // 'Toutes' spans every year. Records go back well before 2023, so a mandatory
    // single-year filter hid most of the data with no way to widen it.
    const [yearParam, _setYearParam] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const [selectedRep, _setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedSource, _setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, _setSelectedService] = useUrlState('service', 'Tous');
    const [selectedStage, _setSelectedStage] = useUrlState('stage', 'Tous');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    // Changing any filter must return to page 1 — otherwise a narrower result set
    // leaves you stranded on a page that no longer exists, showing nothing.
    const setYear = (v: number | 'Toutes') => {
        _setYearParam(v === 'Toutes' ? 'Toutes' : String(v));
        setPage(1);
    };
    const setSelectedMonth = (v: number | 'Toutes') => {
        _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
        setPage(1);
    };
    const setSelectedRep = (v: string) => { _setSelectedRep(v); setPage(1); };
    const setSelectedSource = (v: string) => { _setSelectedSource(v); setPage(1); };
    const setSelectedService = (v: string) => { _setSelectedService(v); setPage(1); };
    const setSelectedStage = (v: string) => { _setSelectedStage(v); setPage(1); };

    const [rows, setRows] = useState<ZohoLeadRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    // Dropdown options come from the data rather than a hardcoded list: Zoho's
    // Lead Source picklist has 34 values, most unused, and the service field is a
    // multi-select. Deriving them keeps the filters honest as the CRM changes.
    const [allSources, setAllSources] = useState<string[]>([]);
    const [allServices, setAllServices] = useState<string[]>([]);
    const [allReps, setAllReps] = useState<string[]>([]);

    const effectiveRepName = propRepName ?? null;

    /** null = no date filter at all (every year). */
    const yearBounds = useMemo(() => {
        if (year === 'Toutes') return null;
        if (selectedMonth === 'Toutes') {
            return { from: `${year}-01-01T00:00:00Z`, to: `${year + 1}-01-01T00:00:00Z` };
        }
        const m = Number(selectedMonth);
        const nextYear = m === 12 ? year + 1 : year;
        const nextMonth = m === 12 ? 1 : m + 1;
        return {
            from: `${year}-${String(m).padStart(2, '0')}-01T00:00:00Z`,
            to: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`,
        };
    }, [year, selectedMonth]);

    const fetchData = useCallback(async () => {
        setLoading(true);

        // zoho_leads_unique drops a converted lead when its contact is also synced,
        // so the same person is not counted twice.
        // `count: 'exact'` gives the total across all pages, not just this slice.
        const from = (page - 1) * PAGE_SIZE;
        let query = supabase
            .from('zoho_leads_unique')
            .select('*', { count: 'exact' })
            .order('created_time', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);

        if (yearBounds) {
            query = query.gte('created_time', yearBounds.from).lt('created_time', yearBounds.to);
        }

        if (effectiveRepName) query = query.eq('rep_name', effectiveRepName);
        else if (selectedRep !== 'Tous') query = query.eq('rep_name', selectedRep);

        if (selectedSource !== 'Toutes') query = query.eq('lead_source', selectedSource);
        if (selectedService !== 'Tous') query = query.contains('service_interest', [selectedService]);
        if (selectedStage !== 'Tous') query = query.eq('stage', selectedStage);

        // Searching server-side, not over the loaded page: with 100 rows per page a
        // client-side filter would quietly search 100 of several thousand records.
        const term = sanitizeSearch(debouncedSearch);
        if (term) {
            const like = `%${term}%`;
            query = query.or(
                `full_name.ilike.${like},company.ilike.${like},` +
                `email.ilike.${like},phone.ilike.${like}`,
            );
        }

        const { data, count } = await query;
        setRows((data as ZohoLeadRow[]) ?? []);
        setTotal(count ?? 0);
        setLoading(false);
    }, [yearBounds, selectedRep, selectedSource, selectedService, selectedStage,
        effectiveRepName, page, debouncedSearch]);

    /**
     * Options are scoped to the year only, so choosing one filter never empties
     * the others. The DISTINCT runs in Postgres — pulling rows to the browser and
     * de-duplicating here would have needed all ~29k of them.
     */
    const fetchOptions = useCallback(async () => {
        const { data, error } = await supabase
            .rpc('get_zoho_lead_filter_options', { p_year: year === 'Toutes' ? null : year })
            .single<ZohoLeadFilterOptions>();
        if (error || !data) return;
        setAllSources(data.sources ?? []);
        setAllServices(data.services ?? []);
        setAllReps(data.reps ?? []);
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync upserts ~29k rows, and refetching once per change
    // event would fire thousands of queries at the browser. One refresh 1.5s after
    // the last change keeps live updates without the stampede.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel('zoho-leads-detail-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_leads' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => fetchDataRef.current(), 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, []);

    // One request per pause in typing rather than per keystroke.
    useEffect(() => {
        const id = setTimeout(() => {
            setDebouncedSearch(prev => (prev === search ? prev : search));
        }, 350);
        return () => clearTimeout(id);
    }, [search]);

    // A new search term changes the result set, so any page beyond the first is
    // meaningless. Kept separate from the setter wrappers because `search` is
    // typed, not selected.
    const lastSearchRef = useRef(debouncedSearch);
    useEffect(() => {
        if (lastSearchRef.current !== debouncedSearch) {
            lastSearchRef.current = debouncedSearch;
            setPage(1);
        }
    }, [debouncedSearch, setPage]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);

    /** Page numbers around the current one, with ellipses. 293 pages can't all be buttons. */
    const pageNumbers = useMemo<(number | 'gap')[]>(() => {
        if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
        const out: (number | 'gap')[] = [1];
        const lo = Math.max(2, page - 1);
        const hi = Math.min(totalPages - 1, page + 1);
        if (lo > 2) out.push('gap');
        for (let i = lo; i <= hi; i++) out.push(i);
        if (hi < totalPages - 1) out.push('gap');
        out.push(totalPages);
        return out;
    }, [page, totalPages]);

    // Counts describe the current page — `total` is the figure for everything.
    const counts = useMemo(() => ({
        leads: rows.filter(r => r.stage === 'lead').length,
        contacts: rows.filter(r => r.stage === 'contact').length,
    }), [rows]);

    const yearOptions = [
        { value: 'Toutes', label: 'Toutes les années' },
        ...[2027, 2026, 2025, 2024, 2023, 2022].map(y => ({ value: String(y), label: String(y) })),
    ];
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const repOptions = useMemo(
        () => [{ value: 'Tous', label: 'Tous les reps' }, ...allReps.map(r => ({ value: r, label: r }))],
        [allReps],
    );
    const sourceOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Toutes les sources' }, ...allSources.map(s => ({ value: s, label: s }))],
        [allSources],
    );
    const serviceOptions = useMemo(
        () => [{ value: 'Tous', label: 'Tous les services' }, ...allServices.map(s => ({ value: s, label: s }))],
        [allServices],
    );
    const stageOptions = [
        { value: 'Tous', label: 'Leads et contacts' },
        { value: 'lead', label: 'Leads seulement' },
        { value: 'contact', label: 'Contacts seulement' },
    ];

    const pageBtn = 'min-w-[2rem] rounded-lg px-2 py-1.5 text-sm font-medium transition-colors';

    const renderPagination = (position: 'top' | 'bottom') => (
        <div
            className={cn(
                'flex flex-wrap items-center justify-between gap-3 px-6 py-3',
                position === 'top' ? 'border-b border-slate-100' : 'border-t border-slate-100',
            )}
        >
            <span className="text-sm text-slate-500" translate="no">
                {`${rangeStart}–${rangeEnd} / ${total.toLocaleString('fr-CA')}`}
            </span>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                    aria-label="Page précédente"
                    className={cn(pageBtn, 'text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40')}
                >
                    <ChevronLeft className="h-4 w-4" />
                </button>

                {pageNumbers.map((p, i) =>
                    p === 'gap' ? (
                        <span key={`gap-${i}`} className="px-1 text-sm text-slate-300">…</span>
                    ) : (
                        <button
                            key={p}
                            onClick={() => setPage(p)}
                            aria-current={p === page ? 'page' : undefined}
                            className={cn(
                                pageBtn,
                                p === page
                                    ? 'bg-brand-main text-white'
                                    : 'text-slate-600 hover:bg-slate-100',
                            )}
                        >
                            {p}
                        </button>
                    ),
                )}

                <button
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                    aria-label="Page suivante"
                    className={cn(pageBtn, 'text-slate-600 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40')}
                >
                    <ChevronRight className="h-4 w-4" />
                </button>
            </div>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-brand-dark">Leads — Détail</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Leads et contacts synchronisés depuis Zoho CRM
                    </p>
                </div>
                <button
                    onClick={() => { fetchData(); fetchOptions(); }}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2
                               text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
                >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    Actualiser
                </button>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select
                        value={year === 'Toutes' ? 'Toutes' : String(year)}
                        onChange={v => setYear(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={yearOptions}
                        variant="accent"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={selectedMonth === 'Toutes' ? 'Toutes' : String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions}
                    />
                </FilterGroup>
                {!effectiveRepName && (
                    <FilterGroup label="Propriétaire">
                        <Select value={selectedRep} onChange={setSelectedRep} options={repOptions} />
                    </FilterGroup>
                )}
                <FilterGroup label="Source">
                    <Select value={selectedSource} onChange={setSelectedSource} options={sourceOptions} />
                </FilterGroup>
                <FilterGroup label="Service">
                    <Select value={selectedService} onChange={setSelectedService} options={serviceOptions} />
                </FilterGroup>
                <FilterGroup label="Type">
                    <Select value={selectedStage} onChange={setSelectedStage} options={stageOptions} />
                </FilterGroup>
            </FilterBar>

            <div className="card">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-6 py-4">
                    <div className="flex items-baseline gap-3">
                        <span className="text-lg font-semibold text-brand-dark" translate="no">
                            {`${total.toLocaleString('fr-CA')} ${total === 1 ? 'enregistrement' : 'enregistrements'}`}
                        </span>
                        <span className="text-sm text-slate-400" translate="no">
                            {total > 0
                                ? `${rangeStart}–${rangeEnd} affichés · ${counts.leads} leads · ${counts.contacts} contacts`
                                : ''}
                        </span>
                    </div>
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            type="search"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Nom, entreprise, courriel, téléphone…"
                            className="w-72 rounded-lg border border-slate-200 py-2 pl-9 pr-3 text-sm
                                       placeholder:text-slate-400 focus:border-brand-main
                                       focus:outline-none focus:ring-1 focus:ring-brand-main"
                        />
                    </div>
                </div>

                {totalPages > 1 && renderPagination('top')}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-brand-main" />
                    </div>
                ) : rows.length === 0 ? (
                    <div className="px-6 py-20 text-center text-sm text-slate-400">
                        Aucun enregistrement pour ces filtres.
                    </div>
                ) : (
                    <div className="max-h-[65vh] overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Nom</th>
                                    <th className="th">Entreprise</th>
                                    <th className="th">Téléphone</th>
                                    <th className="th">Courriel</th>
                                    <th className="th">Propriétaire</th>
                                    <th className="th">Source</th>
                                    <th className="th">Service</th>
                                    <th className="th">Type</th>
                                    <th className="th">Créé le</th>
                                    <th className="th">Modifié le</th>
                                    <th className="th">CRM</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.zoho_record_id} className="transition-colors hover:bg-slate-50/70">
                                        <td className="td font-medium text-brand-dark">{r.full_name ?? '—'}</td>
                                        <td className="td">{r.company ?? '—'}</td>
                                        <td className="td whitespace-nowrap tabular-nums">{r.phone ?? '—'}</td>
                                        <td className="td">
                                            {r.email
                                                ? <a href={`mailto:${r.email}`} className="text-brand-main hover:underline">{r.email}</a>
                                                : '—'}
                                        </td>
                                        <td className="td">{r.rep_name ?? r.owner_name ?? '—'}</td>
                                        <td className="td">
                                            {isBlankPick(r.lead_source) ? (
                                                <span className="text-slate-300">—</span>
                                            ) : (
                                                <span title={r.attribution_inherited ? 'Hérité du lead d’origine' : undefined}>
                                                    {r.lead_source}
                                                    {r.attribution_inherited && <span className="ml-1 text-slate-400">*</span>}
                                                </span>
                                            )}
                                        </td>
                                        <td className="td">
                                            {r.service_interest?.length
                                                ? r.service_interest.join(', ')
                                                : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="td">
                                            <span className={cn('badge', STAGE_COLORS[r.stage])}>
                                                {STAGE_LABELS[r.stage]}
                                            </span>
                                        </td>
                                        <td className="td whitespace-nowrap text-slate-500">{formatDateTime(r.created_time)}</td>
                                        <td className="td whitespace-nowrap text-slate-500">{formatDateTime(r.modified_time)}</td>
                                        <td className="td">
                                            {r.zoho_crm_url && (
                                                <a
                                                    href={r.zoho_crm_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-slate-400 transition-colors hover:text-brand-main"
                                                    title="Ouvrir dans Zoho CRM"
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                </a>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {totalPages > 1 && renderPagination('bottom')}
            </div>
        </div>
    );
}
