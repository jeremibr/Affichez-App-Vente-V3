import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import {
    Loader2, ExternalLink, Search, RefreshCw, ChevronLeft, ChevronRight,
    ChevronsLeft, ChevronsRight, X,
} from 'lucide-react';
import type {
    ZohoAccountRow, ZohoAccountFilterOptions, LeadInvoiceRow, LeadInvoiceTotals,
    AccountDeptRevenueRow, AccountContactRow,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { ExportButton } from '../components/ExportButton';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { TagCell } from '../components/TagCell';
import { useRepFilter, REP_DEFAULT } from '../hooks/useRepFilter';
import type { CsvColumn } from '../lib/csv';
import { RepName } from '../components/RepAvatar';
import { useRepTeam } from '../lib/repTeam';
import {
    formatShortDate, formatCurrencyCAD, formatPhone, phoneSearchPattern, cn,
} from '../lib/utils';

/**
 * Comptes - détail.
 *
 * The searchable client directory Dominic asked for on 2026-09-04: "avoir comme
 * une search feature que tu peux aller chercher ton client, puis tu cliques puis
 * ça show les stats". Clicking a row opens the account's full billing history -
 * per department, per year - which is the "data client" half of that ask.
 *
 * Filtering, sorting, counting and paging all happen in Postgres. The page shows
 * 100 of 20,645 rows, so a filter applied in the browser would search 100
 * records and leave the count and the pager wrong.
 */

const INVOICE_STATUS_LABELS: Record<string, string> = {
    paid: 'Payé', partial: 'Partiel', sent: 'Envoyé',
    viewed: 'Envoyé', overdue: 'En retard', avoir: 'Avoir', void: 'Annulé',
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
    paid: 'bg-tone-good-soft text-tone-good-ink',
    partial: 'bg-tone-warn-soft text-tone-warn-ink',
    sent: 'bg-stone text-ink-secondary',
    viewed: 'bg-stone text-ink-secondary',
    overdue: 'bg-tone-critical-soft text-tone-critical-ink',
    avoir: 'bg-tone-critical-soft text-tone-critical-ink',
    void: 'bg-stone text-ink-secondary',
};

const PAGE_SIZE = 100;
/** Exports are capped: 20,645 rows is a fine CSV, but an unbounded range on a
 *  view with a LEFT JOIN aggregate is not something to hand a browser blindly. */
const EXPORT_MAX = 25000;

/** Zoho writes "-None-" into a picklist that was never set. */
const isBlankPick = (v: string | null): boolean => !v || v === '-None-';

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

export default function AccountsDetail() {
    const [yearParam, _setYearParam] = useUrlState('year', 'Toutes');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const [selectedRep, _setSelectedRep] = useUrlState('rep', REP_DEFAULT);
    const [selectedSource, _setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, _setSelectedService] = useUrlState('service', 'Tous');
    const [selectedDomaine, _setSelectedDomaine] = useUrlState('domaine', 'Tous');
    const [selectedRegion, _setSelectedRegion] = useUrlState('region', 'Toutes');
    const [selectedInvoiced, _setSelectedInvoiced] = useUrlState('factures', 'Tous');
    const [ratingScope, _setRatingScope] = useUrlState('statut', 'Clients');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [options, setOptions] = useState<ZohoAccountFilterOptions | null>(null);

    const [rows, setRows] = useState<ZohoAccountRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [invoiceTotals, setInvoiceTotals] = useState<Record<string, LeadInvoiceTotals>>({});
    const [detailAccount, setDetailAccount] = useState<ZohoAccountRow | null>(null);

    // Équipe entière / Interne / one rep. See hooks/useRepFilter.
    const repFilter = useRepFilter(selectedRep, options?.reps ?? []);

    // A filter change invalidates the page number - page 7 of a 3-page result is
    // an empty table, which reads as "no data" rather than "wrong page".
    //
    // Both params MUST move in one navigation. Calling the filter setter and then
    // setPage(1) looks equivalent and is not: react-router hands each setter the
    // search params from the render that created it, so the page reset starts
    // from a snapshot taken before the filter change and its navigate()
    // overwrites it. The filter then appears to do nothing at all - the dropdown
    // snaps back and the table never changes. LeadsDetail hit this exact bug and
    // UrlStateCompanions in hooks/useUrlState exists to solve it.
    const toPage1 = { page: null };
    const setYear = (v: number | 'Toutes') =>
        _setYearParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedMonth = (v: number | 'Toutes') =>
        _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedRep = (v: string) => _setSelectedRep(v, toPage1);
    const setSelectedSource = (v: string) => _setSelectedSource(v, toPage1);
    const setSelectedService = (v: string) => _setSelectedService(v, toPage1);
    const setSelectedDomaine = (v: string) => _setSelectedDomaine(v, toPage1);
    const setSelectedRegion = (v: string) => _setSelectedRegion(v, toPage1);
    const setSelectedInvoiced = (v: string) => _setSelectedInvoiced(v, toPage1);
    const setRatingScope = (v: string) => _setRatingScope(v, toPage1);

    /**
     * Debounced search, with the page reset skipped on the first run.
     *
     * The effect fires once on mount, and resetting the page there silently threw
     * away `?page=3` from a shared link, a bookmark or a browser Back - the table
     * jumped to page 1 about a third of a second after loading, with no
     * indication why.
     */
    const searchSettled = useRef(false);
    /**
     * Every filter back to its default in ONE navigation.
     *
     * `year` is set to its own default value, which makes useUrlState drop the
     * param; the other eight ride along as companions. Nine separate setter calls
     * would leave eight of the params behind, for the same reason a filter change
     * cannot reset the page on its own - see toPage1 above.
     *
     * `search` is component state rather than a URL param, so it is cleared
     * separately and costs no navigation.
     */
    const clearFilters = () => {
        setSearch('');
        _setYearParam('Toutes', {
            month: null, rep: null, source: null, service: null,
            domaine: null, region: null, factures: null, statut: null, page: null,
        });
    };

    // Counted from `search`, not `debouncedSearch`, so the badge reacts as you
    // type rather than a third of a second later.
    const activeFilterCount = [
        search.trim() !== '',
        year !== 'Toutes',
        selectedMonth !== 'Toutes',
        selectedRep !== REP_DEFAULT,
        selectedSource !== 'Toutes',
        selectedService !== 'Tous',
        selectedDomaine !== 'Tous',
        selectedRegion !== 'Toutes',
        selectedInvoiced !== 'Tous',
        ratingScope !== 'Clients',
    ].filter(Boolean).length;

    useEffect(() => {
        const t = setTimeout(() => {
            setDebouncedSearch(search);
            if (searchSettled.current) setPage(1);
            searchSettled.current = true;
        }, 300);
        return () => clearTimeout(t);
        // setPage is stable; search is the only real trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search]);

    const [serviceVariants, setServiceVariants] = useState<Record<string, string[]>>({});

    /**
     * Bounds for the year/month filter, as an ISO half-open range on
     * created_time. Built in Montreal time so an account created 31 December at
     * 20:00 EST counts in December and not in January - the same rule the RPCs
     * apply with AT TIME ZONE.
     */
    const dateBounds = useMemo(() => {
        if (year === 'Toutes') return null;
        const m = selectedMonth === 'Toutes' ? null : selectedMonth;
        const pad = (n: number) => String(n).padStart(2, '0');
        // -05:00/-04:00 is handled by Postgres; sending a plain local timestamp
        // with an explicit Montreal offset keeps the boundary honest either way.
        const from = m ? `${year}-${pad(m)}-01T00:00:00-05:00` : `${year}-01-01T00:00:00-05:00`;
        const toY = m ? (m === 12 ? year + 1 : year) : year + 1;
        const toM = m ? (m === 12 ? 1 : m + 1) : 1;
        const to = `${toY}-${pad(toM)}-01T00:00:00-05:00`;
        return { from, to };
    }, [year, selectedMonth]);

    /** One query builder for the table and for the export, so the CSV can never
     *  describe a different set of accounts from the one on screen. */
    const buildQuery = useCallback((forExport: boolean) => {
        let query = supabase
            .from('zoho_accounts_enriched')
            .select('*', { count: forExport ? undefined : 'exact' })
            .order('created_time', { ascending: false, nullsFirst: false });

        if (dateBounds) query = query.gte('created_time', dateBounds.from).lt('created_time', dateBounds.to);
        // A group becomes an `in` list; a single rep stays an equality. Both go
        // through repFilter so the dropdown and the query can never disagree.
        if (repFilter.rep) query = query.eq('rep_name', repFilter.rep);
        else if (repFilter.reps) query = query.in('rep_name', repFilter.reps);
        if (selectedSource !== 'Toutes') query = query.eq('origine_du_client', selectedSource);
        if (selectedDomaine !== 'Tous') query = query.eq('domaine_activite', selectedDomaine);
        if (selectedRegion !== 'Toutes') query = query.eq('region_administrative', selectedRegion);
        if (selectedInvoiced !== 'Tous') query = query.eq('has_invoices', selectedInvoiced === 'avec');
        // A precomputed boolean, not `rating not.in (...)`: PostgREST turns that
        // into NOT (rating IN ...), which is NULL - and therefore false - for the
        // 977 accounts with no rating, silently hiding them.
        if (ratingScope !== 'Tous') query = query.eq('is_internal', false);
        if (selectedService !== 'Tous') {
            // overlaps, not contains: match every spelling of the same service.
            query = query.overlaps('service_interest', serviceVariants[selectedService] ?? [selectedService]);
        }

        const term = sanitizeSearch(debouncedSearch);
        if (term) {
            const like = `%${term}%`;
            query = query.or(
                `account_name.ilike.${like},billing_city.ilike.${like},` +
                `website.ilike.${like},phone.ilike.${phoneSearchPattern(term)}`,
            );
        }
        return query;
    }, [dateBounds, repFilter, selectedSource, selectedService, selectedDomaine,
        selectedRegion, selectedInvoiced, ratingScope, debouncedSearch, serviceVariants]);

    /**
     * Monotonic request id. Nine filters over 20,645 rows means a broad query and
     * a narrow one are regularly in flight together, and they do not come back in
     * the order they were sent - so without this guard an older, wider response
     * lands last and overwrites the filtered result. On screen that looks exactly
     * like the filter having been ignored: the dropdown says "Meta Ads" and the
     * table shows every account.
     */
    const requestId = useRef(0);

    /** `id` is the request that asked for these rows; if a newer page has since
     *  loaded, its invoice totals must not be replaced by this one's. */
    const fetchInvoiceTotals = useCallback(async (pageRows: ZohoAccountRow[], id: number) => {
        const ids = pageRows.map(r => r.zoho_account_id).filter(Boolean);
        if (ids.length === 0) { setInvoiceTotals({}); return; }
        const { data } = await cachedRpc('get_account_invoice_totals', { p_account_ids: ids });
        if (!data || id !== requestId.current) return;
        const byAccount: Record<string, LeadInvoiceTotals> = {};
        for (const row of data as LeadInvoiceTotals[]) byAccount[row.account_id] = row;
        setInvoiceTotals(byAccount);
    }, []);

    const fetchData = useCallback(async () => {
        const id = ++requestId.current;
        setLoading(true);
        const from = (page - 1) * PAGE_SIZE;
        const { data, count } = await buildQuery(false).range(from, from + PAGE_SIZE - 1);
        if (id !== requestId.current) return; // a newer query has already answered
        const pageRows = (data as ZohoAccountRow[]) ?? [];
        setRows(pageRows);
        setTotal(count ?? 0);
        setLoading(false);

        // A page number can outlive the result it belonged to: a shared
        // ?page=7 link, a filter carried in from the URL, or the Back button
        // after narrowing the list. The table then renders empty and says
        // "aucun compte ne correspond à ces filtres", which is a lie - the
        // filters match plenty, you are simply past the end.
        //
        // Clamping cannot loop: the value written always satisfies
        // page <= lastPage, so the refetch it triggers takes the else branch.
        const lastPage = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
        if (page > lastPage) {
            setPage(lastPage);
            return;
        }

        // Deliberately after setLoading: the table is useful without the
        // Factures column, so it renders on the first result rather than
        // waiting on a second round trip.
        fetchInvoiceTotals(pageRows, id);
    }, [buildQuery, page, fetchInvoiceTotals, setPage]);

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<ZohoAccountFilterOptions>('get_zoho_account_filter_options', {
                p_year: year === 'Toutes' ? null : year,
                // null = every rating, so the dropdowns still offer a source or a
                // rep carried only by internal accounts when that filter is on.
                p_exclude_ratings: null,
            }, { single: true });
        if (data) { setOptions(data); setServiceVariants(data.service_variants ?? {}); }
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    /** The export runs the same filters with no LIMIT, so what lands in Excel is
     *  the whole filtered set - not the 100 rows that happen to be on screen. */
    const repTeam = useRepTeam();

    const exportRows = useCallback(async () => {
        const { data } = await buildQuery(true).range(0, EXPORT_MAX - 1);
        // The export says what the screen says: a rep off the sales team is
        // Interne there too.
        return ((data as ZohoAccountRow[]) ?? [])
            .map(a => ({ ...a, rep_name: repTeam.display(a.rep_name) }));
    }, [buildQuery, repTeam]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);

    const optionList = (all: string, values: string[] | undefined, allLabel: string) => [
        { value: all, label: allLabel },
        ...(values ?? []).map(v => ({ value: v, label: v })),
    ];
    const yearOptions = useMemo(() => [
        { value: 'Toutes', label: 'Toutes les années' },
        ...(options?.years ?? []).map(y => ({ value: String(y), label: String(y) })),
    ], [options]);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Comptes · Détail</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                        Répertoire des comptes clients. Cliquez sur un compte pour voir sa facturation par
                        département et par année.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <ExportButton
                        rows={exportRows} columns={ACCOUNT_CSV}
                        filename="comptes" disabled={total === 0}
                        label={total > 0 ? `Exporter ${total.toLocaleString('fr-CA')} comptes` : 'Exporter CSV'}
                    />
                    <button
                        // The whole point of this button is to bypass the
                        // cache; without the drop it would replay the same
                        // answer and look broken.
                        onClick={() => { invalidateRpcCache(); fetchDataRef.current(); }}
                        className="btn btn-xs btn-quiet"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                        Actualiser
                    </button>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Recherche">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-mute" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Nom, téléphone, ville…"
                            aria-label="Rechercher un compte"
                            // h-9 is the same 36px step the Selects beside it sit
                            // on; padding alone left it 2px proud of the row.
                            className="w-64 h-9 pl-9 pr-3 rounded-md border border-hairline-strong bg-white text-sm
                                       placeholder:text-ink-faint focus:outline-none focus:ring-2
                                       focus:ring-ring focus:border-primary"
                        />
                    </div>
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select
                        value={year === 'Toutes' ? 'Toutes' : String(year)}
                        onChange={v => setYear(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={yearOptions} variant="accent" className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions} className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <Select value={selectedRep} onChange={setSelectedRep} options={repFilter.options} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Source">
                    <Select value={selectedSource} onChange={setSelectedSource} options={optionList('Toutes', options?.sources, 'Toutes les sources')} className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <Select value={selectedService} onChange={setSelectedService} options={optionList('Tous', options?.services, 'Tous les services')} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Domaine">
                    <Select value={selectedDomaine} onChange={setSelectedDomaine} options={optionList('Tous', options?.domaines, 'Tous les domaines')} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Région">
                    <Select value={selectedRegion} onChange={setSelectedRegion} options={optionList('Toutes', options?.regions, 'Toutes les régions')} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Factures">
                    <Select
                        value={selectedInvoiced} onChange={setSelectedInvoiced} className="w-44"
                        options={[
                            { value: 'Tous',  label: 'Tous les comptes' },
                            { value: 'avec',  label: 'Avec factures' },
                            { value: 'sans',  label: 'Sans facture' },
                        ]}
                    />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select
                        value={ratingScope} onChange={setRatingScope} className="w-52"
                        options={[
                            { value: 'Clients', label: 'Clients seulement' },
                            { value: 'Tous',    label: 'Inclure comptes internes' },
                        ]}
                    />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <Pager
                    page={page} totalPages={totalPages} total={total}
                    rangeStart={rangeStart} rangeEnd={rangeEnd}
                    onChange={setPage} position="top"
                />

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
                    </div>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-ink-mute">Aucun compte ne correspond à ces filtres.</p>
                ) : (
                    <div className="overflow-x-auto">
                        {/* translate="no" on the whole table: none of this is prose -
                            it is company names, phone numbers, amounts and dates.
                            Translating it is never wanted, and Chrome freezing a
                            translated cell makes the table silently show stale data
                            after a filter change. */}
                        <table className="w-full" translate="no">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Compte</th>
                                    <th className="th">Téléphone</th>
                                    <th className="th">Ville</th>
                                    <th className="th">Propriétaire</th>
                                    <th className="th">Source</th>
                                    <th className="th">Domaine</th>
                                    <th className="th">Service</th>
                                    <th className="th text-right">Factures</th>
                                    <th className="th">Créé le</th>
                                    <th className="th">CRM</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {rows.map(a => {
                                    const totals = invoiceTotals[a.zoho_account_id];
                                    return (
                                        // The whole row opens the account, not just
                                        // the name: the name is a small target in a
                                        // ten-column table, and every other cell
                                        // looked clickable but was not.
                                        <tr
                                            key={a.zoho_account_id}
                                            onClick={() => setDetailAccount(a)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setDetailAccount(a);
                                                }
                                            }}
                                            tabIndex={0}
                                            role="button"
                                            aria-label={`Voir la facturation de ${a.account_name ?? 'ce compte'}`}
                                            className="cursor-pointer transition-colors hover:bg-sand/70
                                                       focus:bg-sand focus:outline-none
                                                       focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                                        >
                                            <td className="td">
                                                <span className="font-semibold text-ink">
                                                    {a.account_name ?? '—'}
                                                </span>
                                                {a.parent_account_name && (
                                                    <p className="text-2xs text-ink-mute mt-0.5">
                                                        Sous-compte de {a.parent_account_name}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-ink-mute">{formatPhone(a.phone) ?? '—'}</td>
                                            <td className="td text-ink-mute">{a.billing_city ?? '—'}</td>
                                            <td className="td text-ink-mute"><span className="inline-flex items-center gap-2">{a.rep_name ? <RepName name={a.rep_name} size="sm" /> : '—'}</span></td>
                                            <td className="td">
                                                <span className="inline-flex items-center gap-1.5">
                                                    {a.is_bulk_import && (
                                                        <span
                                                            className="w-1.5 h-1.5 rounded-full bg-tone-warn shrink-0"
                                                            title="Liste de clients rachetée, pas une campagne"
                                                        />
                                                    )}
                                                    <TagCell values={isBlankPick(a.origine_du_client) ? [] : [a.origine_du_client!]} />
                                                </span>
                                            </td>
                                            <td className="td text-ink-mute">{isBlankPick(a.domaine_activite) ? '—' : a.domaine_activite}</td>
                                            {/* service_resolved, not service_interest:
                                                59% of accounts never had the CRM field
                                                filled in, and Shop Santé showed an empty
                                                Service column while its invoices clearly
                                                named two departments. Borrowed values are
                                                greyed and marked, so an invoice department
                                                is never passed off as a CRM answer. */}
                                            <td className="td">
                                                <span className="inline-flex items-center gap-1">
                                                    <TagCell
                                                        values={a.service_resolved ?? []}
                                                        muted={a.service_origin === 'invoice'}
                                                    />
                                                    {a.service_origin === 'invoice' && (
                                                        <span
                                                            className="text-ink-faint"
                                                            title="Service déduit des départements facturés : le CRM n'en indique aucun"
                                                        >*</span>
                                                    )}
                                                </span>
                                            </td>
                                            <td className="td text-right">
                                                {totals ? (
                                                    // Amount on top, the document count under it: the
                                                    // amount is what the column is for, and "$3,400"
                                                    // over one invoice is a different client from
                                                    // "$3,400" over forty.
                                                    <span
                                                        className="inline-flex flex-col items-end leading-tight"
                                                        title={`${totals.invoice_count} facture${totals.invoice_count > 1 ? 's' : ''}`
                                                            + (totals.credit_count > 0
                                                                ? `, ${totals.credit_count} avoir${totals.credit_count > 1 ? 's' : ''}`
                                                                : '')}
                                                    >
                                                        <span className="font-semibold text-ink tabular-nums">
                                                            {formatCurrencyCAD(totals.total_amount)}
                                                        </span>
                                                        <span className="text-2xs text-ink-mute tabular-nums" translate="no">
                                                            {totals.invoice_count} facture{totals.invoice_count > 1 ? 's' : ''}
                                                            {totals.credit_count > 0 && (
                                                                <span className="text-tone-critical">
                                                                    {' '}· {totals.credit_count} avoir{totals.credit_count > 1 ? 's' : ''}
                                                                </span>
                                                            )}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <span className="text-ink-faint">—</span>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-ink-mute text-xs">
                                                {a.created_time ? formatShortDate(new Date(a.created_time)) : '—'}
                                            </td>
                                            <td className="td">
                                                {a.zoho_crm_url && (
                                                    <a
                                                        href={a.zoho_crm_url} target="_blank" rel="noopener noreferrer"
                                                        onClick={e => e.stopPropagation()}
                                                        aria-label={`Ouvrir ${a.account_name ?? 'le compte'} dans Zoho CRM`}
                                                        className="text-ink-faint hover:text-primary-press transition-colors inline-block"
                                                    >
                                                        <ExternalLink className="w-3.5 h-3.5" />
                                                    </a>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Repeated at the foot of the table: with 100 rows on screen the
                    top control has scrolled well out of view by the time somebody
                    has finished reading and wants the next page. */}
                {!loading && rows.length > 0 && (
                    <Pager
                        page={page} totalPages={totalPages} total={total}
                        rangeStart={rangeStart} rangeEnd={rangeEnd}
                        onChange={setPage} position="bottom"
                    />
                )}
            </div>

            {detailAccount && (
                <AccountDetailModal account={detailAccount} onClose={() => setDetailAccount(null)} />
            )}
        </div>
    );
}

/**
 * The pager, rendered above and below the table.
 *
 * First and last buttons matter here in a way they do not on a short list: 20,645
 * accounts is 188 pages, and stepping to the end one arrow at a time is not a
 * navigation option.
 */
function Pager({ page, totalPages, total, rangeStart, rangeEnd, onChange, position }: {
    page: number;
    totalPages: number;
    total: number;
    rangeStart: number;
    rangeEnd: number;
    onChange: (p: number) => void;
    position: 'top' | 'bottom';
}) {
    const go = (p: number) => onChange(Math.min(totalPages, Math.max(1, p)));
    const btn = 'p-1.5 rounded-md text-ink-mute hover:bg-stone disabled:opacity-30 disabled:hover:bg-transparent';
    return (
        <div className={cn(
            'flex flex-wrap items-center justify-between gap-3 px-5 py-3',
            position === 'top' ? 'border-b border-hairline' : 'border-t border-hairline bg-sand/40',
        )}>
            <p className="text-xs font-medium text-ink-mute" translate="no">
                {total === 0
                    ? 'Aucun compte'
                    : rangeStart + '–' + rangeEnd + ' sur ' + total.toLocaleString('fr-CA') + ' comptes'}
            </p>
            <div className="flex items-center gap-1">
                <button onClick={() => go(1)} disabled={page <= 1} aria-label="Première page" className={btn}>
                    <ChevronsLeft className="w-4 h-4" />
                </button>
                <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Page précédente" className={btn}>
                    <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-ink-mute px-2 tabular-nums" translate="no">
                    {page} / {totalPages}
                </span>
                <button onClick={() => go(page + 1)} disabled={page >= totalPages} aria-label="Page suivante" className={btn}>
                    <ChevronRight className="w-4 h-4" />
                </button>
                <button onClick={() => go(totalPages)} disabled={page >= totalPages} aria-label="Dernière page" className={btn}>
                    <ChevronsRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}

const ACCOUNT_CSV: CsvColumn<ZohoAccountRow>[] = [
    { header: 'Compte',             value: a => a.account_name },
    { header: 'Téléphone',          value: a => a.phone },
    { header: 'Site web',           value: a => a.website },
    { header: 'Ville',              value: a => a.billing_city },
    { header: 'Province',           value: a => a.billing_state },
    { header: 'Code postal',        value: a => a.billing_code },
    { header: 'Région',             value: a => a.region_administrative },
    { header: 'Propriétaire',       value: a => a.rep_name },
    { header: 'Source',             value: a => a.origine_du_client },
    { header: 'Liste rachetée',     value: a => a.is_bulk_import },
    { header: 'Domaine',            value: a => a.domaine_activite },
    { header: 'Services',           value: a => (a.service_interest ?? []).join(' | ') },
    { header: 'Statut CRM',         value: a => a.rating },
    { header: 'Compte interne',     value: a => a.is_internal },
    { header: 'Compte parent',      value: a => a.parent_account_name },
    { header: 'Créé le',            value: a => a.created_date },
    { header: 'Dernière activité',  value: a => a.last_activity_time?.slice(0, 10) ?? null },
    { header: 'Nb factures',        value: a => a.invoice_count },
    { header: 'Nb avoirs',          value: a => a.credit_count },
    { header: 'Revenus (net)',      value: a => a.revenue_lifetime },
    { header: '1re facture',        value: a => a.first_invoice_date },
    { header: 'Dernière facture',   value: a => a.last_invoice_date },
    { header: 'Ventes Royer/VotreLogo', value: a => a.ventes_totales },
    { header: 'Nb tâches',          value: a => a.nombre_taches },
    { header: 'Lien CRM',           value: a => a.zoho_crm_url },
];

const INVOICE_CSV: CsvColumn<LeadInvoiceRow>[] = [
    { header: 'Numéro',        value: i => i.invoice_number },
    { header: 'Date',          value: i => i.invoice_date },
    { header: 'Département',   value: i => i.department },
    { header: 'Bureau',        value: i => i.office },
    { header: 'Représentant',  value: i => i.rep_name },
    { header: 'Statut',        value: i => INVOICE_STATUS_LABELS[i.is_avoir ? 'avoir' : i.status] ?? i.status },
    { header: 'Montant',       value: i => i.amount },
];

/**
 * One account's billing history: a department × year pivot on top, the invoice
 * line items underneath.
 *
 * The pivot is the answer to "il a acheté combien par département par année,
 * puis voir la progression" - reading a year-over-year trend off a flat list of
 * invoices is exactly the work this page exists to remove.
 */
function AccountDetailModal({ account, onClose }: { account: ZohoAccountRow; onClose: () => void }) {
    const repTeam = useRepTeam();
    const [invoices, setInvoices] = useState<LeadInvoiceRow[]>([]);
    const [deptRows, setDeptRows] = useState<AccountDeptRevenueRow[]>([]);
    const [contacts, setContacts] = useState<AccountContactRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const [{ data: inv }, { data: dept }, { data: cts }] = await Promise.all([
                cachedRpc('get_account_invoices', { p_account_id: account.zoho_account_id }),
                cachedRpc('get_account_revenue_by_department', { p_account_id: account.zoho_account_id }),
                cachedRpc('get_account_contacts', { p_account_id: account.zoho_account_id }),
            ]);
            if (cancelled) return;
            setInvoices((inv as LeadInvoiceRow[]) ?? []);
            setDeptRows((dept as AccountDeptRevenueRow[]) ?? []);
            setContacts((cts as AccountContactRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [account.zoho_account_id]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    /** Departments as rows, years as columns - the shape people read a trend in. */
    const pivot = useMemo(() => {
        const years = [...new Set(deptRows.map(r => r.year))].sort((a, b) => a - b);
        const depts = [...new Set(deptRows.map(r => r.department))].sort();
        const cell = new Map<string, number>();
        for (const r of deptRows) cell.set(`${r.department}|${r.year}`, Number(r.total_amount));
        const byYear = new Map<number, number>();
        for (const r of deptRows) byYear.set(r.year, (byYear.get(r.year) ?? 0) + Number(r.total_amount));
        return { years, depts, cell, byYear };
    }, [deptRows]);

    const net = invoices.reduce((s, r) => s + Number(r.amount), 0);
    const invoiceCount = invoices.filter(r => !r.is_avoir).length;
    const creditCount = invoices.length - invoiceCount;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Facturation de ${account.account_name ?? 'ce compte'}`}
                onClick={e => e.stopPropagation()}
                className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-ink truncate">
                            {account.account_name ?? 'Compte'}
                        </h2>
                        <p className="mt-0.5 text-sm text-ink-mute truncate">
                            {[
                                formatPhone(account.phone),
                                account.billing_city,
                                isBlankPick(account.domaine_activite) ? null : account.domaine_activite,
                                isBlankPick(account.origine_du_client) ? null : account.origine_du_client,
                                account.rep_name,
                            ].filter(Boolean).join(' · ') || '—'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {account.zoho_crm_url && (
                            <a
                                href={account.zoho_crm_url} target="_blank" rel="noopener noreferrer"
                                className="rounded-md p-1.5 text-ink-mute hover:bg-stone hover:text-primary-press transition-colors"
                                aria-label="Ouvrir dans Zoho CRM"
                            >
                                <ExternalLink className="h-4 w-4" />
                            </a>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Fermer"
                            className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                {!loading && contacts.length > 0 && (
                    <div className="px-6 py-3 border-b border-hairline flex flex-wrap gap-x-5 gap-y-1.5">
                        <span className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow self-center">
                            Contacts
                        </span>
                        {contacts.slice(0, 8).map(c => (
                            <span key={c.zoho_record_id} className="text-xs text-ink-mute">
                                <span className="font-semibold text-ink-secondary">{c.full_name ?? '—'}</span>
                                {c.phone && <span className="text-ink-mute"> · {formatPhone(c.phone)}</span>}
                                {c.email && <span className="text-ink-faint"> · {c.email}</span>}
                                {c.stage === 'lead' && (
                                    <span className="ml-1 badge bg-data-2 text-data-2-ink">Lead</span>
                                )}
                            </span>
                        ))}
                        {contacts.length > 8 && (
                            <span className="text-xs text-ink-faint self-center">
                                +{contacts.length - 8} autres
                            </span>
                        )}
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-primary-press" />
                    </div>
                ) : invoices.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-ink-mute">
                        Aucune facture pour ce compte.
                        {(account.ventes_totales ?? 0) > 0 && (
                            <p className="mt-3 text-xs text-ink-mute max-w-lg mx-auto leading-relaxed">
                                Ce compte porte {formatCurrencyCAD(account.ventes_totales ?? 0)} de ventes
                                Royer&nbsp;&amp;&nbsp;Fils / VotreLogo.ca dans le CRM. Cette facturation se fait
                                en dehors des organisations Zoho Books lues par l&rsquo;application, donc aucune
                                facture n&rsquo;est disponible ici.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="overflow-auto">
                        {pivot.years.length > 0 && (
                            <div className="px-6 pt-5 pb-4 border-b border-hairline bg-sand/40">
                                <h3 className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-3">
                                    Par département et par année
                                </h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-hairline-strong">
                                                <th className="py-2 pr-4 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Département</th>
                                                {pivot.years.map(y => (
                                                    <th key={y} className="py-2 px-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow tabular-nums">{y}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-hairline">
                                            {pivot.depts.map(d => (
                                                <tr key={d}>
                                                    <td className="py-2 pr-4 font-semibold text-ink-secondary text-xs">{d}</td>
                                                    {pivot.years.map(y => {
                                                        const v = pivot.cell.get(`${d}|${y}`);
                                                        return (
                                                            <td key={y} className={cn(
                                                                'py-2 px-3 text-right tabular-nums text-xs',
                                                                v === undefined ? 'text-ink-faint' : 'text-ink-secondary font-medium',
                                                            )}>
                                                                {v === undefined ? '—' : formatCurrencyCAD(v)}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                            <tr className="border-t-2 border-hairline-strong">
                                                <td className="py-2 pr-4 font-bold text-ink-secondary text-xs">Total</td>
                                                {pivot.years.map(y => (
                                                    <td key={y} className="py-2 px-3 text-right font-bold text-ink tabular-nums text-xs">
                                                        {formatCurrencyCAD(pivot.byYear.get(y) ?? 0)}
                                                    </td>
                                                ))}
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Numéro</th>
                                    <th className="th">Date</th>
                                    <th className="th">Département</th>
                                    <th className="th">Bureau</th>
                                    <th className="th">Représentant</th>
                                    <th className="th">Statut</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invoices.map(inv => {
                                    const key = inv.is_avoir ? 'avoir' : inv.status;
                                    return (
                                        <tr key={inv.zoho_id} className={cn('transition-colors hover:bg-sand/70', inv.is_avoir && 'bg-tone-critical-soft/30')}>
                                            <td className="td font-medium text-ink">{inv.invoice_number ?? '—'}</td>
                                            <td className="td whitespace-nowrap text-ink-mute">
                                                {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '—'}
                                            </td>
                                            <td className="td text-ink-mute">{inv.department ?? '—'}</td>
                                            <td className="td text-ink-mute">{inv.office ?? '—'}</td>
                                            <td className="td text-ink-mute"><span className="inline-flex items-center gap-2">{inv.rep_name ? <RepName name={inv.rep_name} size="sm" /> : '—'}</span></td>
                                            <td className="td">
                                                <span className={cn('badge', INVOICE_STATUS_COLORS[key])}>
                                                    {INVOICE_STATUS_LABELS[key] ?? key}
                                                </span>
                                            </td>
                                            <td className={cn('td text-right font-semibold tabular-nums',
                                                inv.is_avoir ? 'text-tone-critical-ink' : 'text-ink')}>
                                                {formatCurrencyCAD(inv.amount)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {/*
                  * The figures are held back until the fetch lands, and carry
                  * translate="no".
                  *
                  * Both are needed for the same reason. Chrome Translate is on
                  * for these users; it replaces a text node with its own and
                  * then stops tracking it, so a node that rendered "0,00 $"
                  * during the load kept showing "$0.00" after the real total
                  * arrived - reopening the modal looked like it "fixed" the
                  * number because that built a fresh node. Not rendering a
                  * placeholder number means there is nothing wrong to freeze;
                  * translate="no" means it is never swapped in the first place.
                  */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-sand/60 px-6 py-3">
                    <span className="text-sm text-ink-mute" translate="no">
                        {loading ? '' : (
                            <>
                                {`${invoiceCount} facture${invoiceCount > 1 ? 's' : ''}`}
                                {creditCount > 0 && ` · ${creditCount} avoir${creditCount > 1 ? 's' : ''}`}
                            </>
                        )}
                    </span>
                    <div className="flex items-center gap-4">
                        <ExportButton
                            // Interne in the file, as on screen.
                            rows={invoices.map(i => ({ ...i, rep_name: repTeam.display(i.rep_name) }))}
                            columns={INVOICE_CSV}
                            filename={`factures_${(account.account_name ?? 'compte').replace(/[^\w-]+/g, '_').slice(0, 40)}`}
                            disabled={invoices.length === 0}
                        />
                        {/* Label small and muted, amount large and dark - at the
                          * same weight and size the two ran together. */}
                        <span className="flex items-baseline gap-2" translate="no">
                            <span className="text-2xs font-semibold uppercase tracking-eyebrow text-ink-mute">
                                Total net
                            </span>
                            <span className={cn('text-lg font-bold tabular-nums',
                                net < 0 ? 'text-tone-critical-ink' : 'text-ink')}>
                                {loading ? '—' : formatCurrencyCAD(net)}
                            </span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
