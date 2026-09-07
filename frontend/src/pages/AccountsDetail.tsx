import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import {
    Loader2, ExternalLink, Search, RefreshCw, ChevronLeft, ChevronRight, FileText, X,
} from 'lucide-react';
import type {
    ZohoAccountRow, ZohoAccountFilterOptions, LeadInvoiceRow, LeadInvoiceTotals,
    AccountDeptRevenueRow,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import {
    formatShortDate, formatCurrencyCAD, formatPhone, phoneSearchPattern, clipServices, cn,
} from '../lib/utils';

/**
 * Comptes — détail.
 *
 * The searchable client directory Dominic asked for on 2026-09-04: "avoir comme
 * une search feature que tu peux aller chercher ton client, puis tu cliques puis
 * ça show les stats". Clicking a row opens the account's full billing history —
 * per department, per year — which is the "data client" half of that ask.
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
    paid: 'bg-emerald-50 text-emerald-600',
    partial: 'bg-amber-50 text-amber-600',
    sent: 'bg-slate-100 text-slate-500',
    viewed: 'bg-slate-100 text-slate-500',
    overdue: 'bg-rose-50 text-rose-600',
    avoir: 'bg-rose-50 text-rose-600',
    void: 'bg-slate-100 text-slate-400',
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
    const [selectedRep, _setSelectedRep] = useUrlState('rep', 'Tous');
    const [selectedSource, _setSelectedSource] = useUrlState('source', 'Toutes');
    const [selectedService, _setSelectedService] = useUrlState('service', 'Tous');
    const [selectedDomaine, _setSelectedDomaine] = useUrlState('domaine', 'Tous');
    const [selectedRegion, _setSelectedRegion] = useUrlState('region', 'Toutes');
    const [selectedInvoiced, _setSelectedInvoiced] = useUrlState('factures', 'Tous');
    const [ratingScope, _setRatingScope] = useUrlState('statut', 'Clients');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    const [rows, setRows] = useState<ZohoAccountRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [invoiceTotals, setInvoiceTotals] = useState<Record<string, LeadInvoiceTotals>>({});
    const [detailAccount, setDetailAccount] = useState<ZohoAccountRow | null>(null);
    const [options, setOptions] = useState<ZohoAccountFilterOptions | null>(null);

    // Any filter change invalidates the current page number — page 7 of a
    // 3-page result is an empty table, which reads as "no data" rather than
    // "wrong page".
    const resetPage = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); };
    const setYear = resetPage((v: number | 'Toutes') => _setYearParam(v === 'Toutes' ? 'Toutes' : String(v)));
    const setSelectedMonth = resetPage((v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v)));
    const setSelectedRep = resetPage(_setSelectedRep);
    const setSelectedSource = resetPage(_setSelectedSource);
    const setSelectedService = resetPage(_setSelectedService);
    const setSelectedDomaine = resetPage(_setSelectedDomaine);
    const setSelectedRegion = resetPage(_setSelectedRegion);
    const setSelectedInvoiced = resetPage(_setSelectedInvoiced);
    const setRatingScope = resetPage(_setRatingScope);

    useEffect(() => {
        const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
        return () => clearTimeout(t);
        // setPage is stable; search is the only real trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search]);

    const [serviceVariants, setServiceVariants] = useState<Record<string, string[]>>({});

    /**
     * Bounds for the year/month filter, as an ISO half-open range on
     * created_time. Built in Montreal time so an account created 31 December at
     * 20:00 EST counts in December and not in January — the same rule the RPCs
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
        if (selectedRep !== 'Tous') query = query.eq('rep_name', selectedRep);
        if (selectedSource !== 'Toutes') query = query.eq('origine_du_client', selectedSource);
        if (selectedDomaine !== 'Tous') query = query.eq('domaine_activite', selectedDomaine);
        if (selectedRegion !== 'Toutes') query = query.eq('region_administrative', selectedRegion);
        if (selectedInvoiced !== 'Tous') query = query.eq('has_invoices', selectedInvoiced === 'avec');
        // A precomputed boolean, not `rating not.in (...)`: PostgREST turns that
        // into NOT (rating IN ...), which is NULL — and therefore false — for the
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
    }, [dateBounds, selectedRep, selectedSource, selectedService, selectedDomaine,
        selectedRegion, selectedInvoiced, ratingScope, debouncedSearch, serviceVariants]);

    const fetchInvoiceTotals = useCallback(async (pageRows: ZohoAccountRow[]) => {
        const ids = pageRows.map(r => r.zoho_account_id).filter(Boolean);
        if (ids.length === 0) { setInvoiceTotals({}); return; }
        const { data } = await supabase.rpc('get_account_invoice_totals', { p_account_ids: ids });
        if (!data) return;
        const byAccount: Record<string, LeadInvoiceTotals> = {};
        for (const row of data as LeadInvoiceTotals[]) byAccount[row.account_id] = row;
        setInvoiceTotals(byAccount);
    }, []);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const from = (page - 1) * PAGE_SIZE;
        const { data, count } = await buildQuery(false).range(from, from + PAGE_SIZE - 1);
        const pageRows = (data as ZohoAccountRow[]) ?? [];
        setRows(pageRows);
        setTotal(count ?? 0);
        setLoading(false);
        // After setLoading on purpose: the table is useful without the Factures
        // column, so it renders on the first result rather than waiting on a
        // second round trip.
        fetchInvoiceTotals(pageRows);
    }, [buildQuery, page, fetchInvoiceTotals]);

    const fetchOptions = useCallback(async () => {
        const { data } = await supabase
            .rpc('get_zoho_account_filter_options', {
                p_year: year === 'Toutes' ? null : year,
                // null = every rating, so the dropdowns still offer a source or a
                // rep carried only by internal accounts when that filter is on.
                p_exclude_ratings: null,
            })
            .single<ZohoAccountFilterOptions>();
        if (data) { setOptions(data); setServiceVariants(data.service_variants ?? {}); }
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    /** The export runs the same filters with no LIMIT, so what lands in Excel is
     *  the whole filtered set — not the 100 rows that happen to be on screen. */
    const exportRows = useCallback(async () => {
        const { data } = await buildQuery(true).range(0, EXPORT_MAX - 1);
        return (data as ZohoAccountRow[]) ?? [];
    }, [buildQuery]);

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
                    <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Comptes — Détail</h1>
                    <p className="text-xs md:text-sm text-slate-400 mt-0.5">
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
                        onClick={() => fetchDataRef.current()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                                   border border-slate-200 text-slate-500 bg-white hover:border-brand-main
                                   hover:text-brand-main transition-colors"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                        Actualiser
                    </button>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Recherche">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Nom, téléphone, ville…"
                            aria-label="Rechercher un compte"
                            className="w-64 pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm
                                       placeholder:text-slate-300 focus:outline-none focus:ring-2
                                       focus:ring-brand-main/30 focus:border-brand-main"
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
                    <Select value={selectedRep} onChange={setSelectedRep} options={optionList('Tous', options?.reps, 'Tous les reps')} className="w-44" />
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
            </FilterBar>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                    <p className="text-xs font-medium text-slate-400" translate="no">
                        {total === 0 ? 'Aucun compte' : `${rangeStart}–${rangeEnd} sur ${total.toLocaleString('fr-CA')} comptes`}
                    </p>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setPage(Math.max(1, page - 1))}
                            disabled={page <= 1}
                            aria-label="Page précédente"
                            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-xs font-semibold text-slate-500 px-2 tabular-nums">
                            {page} / {totalPages}
                        </span>
                        <button
                            onClick={() => setPage(Math.min(totalPages, page + 1))}
                            disabled={page >= totalPages}
                            aria-label="Page suivante"
                            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-brand-main" />
                    </div>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-slate-400">Aucun compte ne correspond à ces filtres.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full">
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
                            <tbody className="divide-y divide-slate-50">
                                {rows.map(a => {
                                    const totals = invoiceTotals[a.zoho_account_id];
                                    const svc = clipServices(a.service_interest ?? []);
                                    return (
                                        <tr key={a.zoho_account_id} className="hover:bg-slate-50/70 transition-colors">
                                            <td className="td">
                                                <button
                                                    onClick={() => setDetailAccount(a)}
                                                    className="text-left font-semibold text-brand-dark hover:text-brand-main transition-colors"
                                                    title="Voir la facturation de ce compte"
                                                >
                                                    {a.account_name ?? '—'}
                                                </button>
                                                {a.parent_account_name && (
                                                    <p className="text-[10px] text-slate-400 mt-0.5">
                                                        Sous-compte de {a.parent_account_name}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-slate-500">{formatPhone(a.phone) ?? '—'}</td>
                                            <td className="td text-slate-500">{a.billing_city ?? '—'}</td>
                                            <td className="td text-slate-500">{a.rep_name ?? '—'}</td>
                                            <td className="td text-slate-500">
                                                <span className="inline-flex items-center gap-1.5">
                                                    {a.is_bulk_import && (
                                                        <span
                                                            className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"
                                                            title="Liste de clients rachetée, pas une campagne"
                                                        />
                                                    )}
                                                    {isBlankPick(a.origine_du_client) ? '—' : a.origine_du_client}
                                                </span>
                                            </td>
                                            <td className="td text-slate-500">{isBlankPick(a.domaine_activite) ? '—' : a.domaine_activite}</td>
                                            <td className="td text-slate-500" title={(a.service_interest ?? []).join(', ')}>
                                                {svc.text || '—'}
                                                {svc.hiddenCount > 0 && !svc.truncated && <span className="text-slate-400">&hellip;</span>}
                                            </td>
                                            <td className="td text-right">
                                                {totals ? (
                                                    <button
                                                        onClick={() => setDetailAccount(a)}
                                                        className="inline-flex items-center gap-1.5 font-semibold text-brand-dark
                                                                   hover:text-brand-main transition-colors tabular-nums"
                                                        title={`${totals.invoice_count} facture(s)`}
                                                    >
                                                        <FileText className="w-3.5 h-3.5 text-slate-300" />
                                                        {formatCurrencyCAD(totals.total_amount)}
                                                    </button>
                                                ) : (
                                                    <span className="text-slate-300">—</span>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-slate-400 text-xs">
                                                {a.created_time ? formatShortDate(new Date(a.created_time)) : '—'}
                                            </td>
                                            <td className="td">
                                                {a.zoho_crm_url && (
                                                    <a
                                                        href={a.zoho_crm_url} target="_blank" rel="noopener noreferrer"
                                                        aria-label={`Ouvrir ${a.account_name ?? 'le compte'} dans Zoho CRM`}
                                                        className="text-slate-300 hover:text-brand-main transition-colors inline-block"
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
            </div>

            {detailAccount && (
                <AccountDetailModal account={detailAccount} onClose={() => setDetailAccount(null)} />
            )}
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
 * puis voir la progression" — reading a year-over-year trend off a flat list of
 * invoices is exactly the work this page exists to remove.
 */
function AccountDetailModal({ account, onClose }: { account: ZohoAccountRow; onClose: () => void }) {
    const [invoices, setInvoices] = useState<LeadInvoiceRow[]>([]);
    const [deptRows, setDeptRows] = useState<AccountDeptRevenueRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const [{ data: inv }, { data: dept }] = await Promise.all([
                supabase.rpc('get_account_invoices', { p_account_id: account.zoho_account_id }),
                supabase.rpc('get_account_revenue_by_department', { p_account_id: account.zoho_account_id }),
            ]);
            if (cancelled) return;
            setInvoices((inv as LeadInvoiceRow[]) ?? []);
            setDeptRows((dept as AccountDeptRevenueRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [account.zoho_account_id]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    /** Departments as rows, years as columns — the shape people read a trend in. */
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Facturation de ${account.account_name ?? 'ce compte'}`}
                onClick={e => e.stopPropagation()}
                className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-brand-dark truncate">
                            {account.account_name ?? 'Compte'}
                        </h2>
                        <p className="mt-0.5 text-sm text-slate-400 truncate">
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
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-main transition-colors"
                                aria-label="Ouvrir dans Zoho CRM"
                            >
                                <ExternalLink className="h-4 w-4" />
                            </a>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Fermer"
                            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-brand-main" />
                    </div>
                ) : invoices.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-slate-400">
                        Aucune facture pour ce compte.
                        {(account.ventes_totales ?? 0) > 0 && (
                            <p className="mt-3 text-xs text-slate-400 max-w-lg mx-auto leading-relaxed">
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
                            <div className="px-6 pt-5 pb-4 border-b border-slate-100 bg-slate-50/40">
                                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
                                    Par département et par année
                                </h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-slate-200">
                                                <th className="py-2 pr-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Département</th>
                                                {pivot.years.map(y => (
                                                    <th key={y} className="py-2 px-3 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest tabular-nums">{y}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100">
                                            {pivot.depts.map(d => (
                                                <tr key={d}>
                                                    <td className="py-2 pr-4 font-semibold text-slate-600 text-xs">{d}</td>
                                                    {pivot.years.map(y => {
                                                        const v = pivot.cell.get(`${d}|${y}`);
                                                        return (
                                                            <td key={y} className={cn(
                                                                'py-2 px-3 text-right tabular-nums text-xs',
                                                                v === undefined ? 'text-slate-300' : 'text-slate-700 font-medium',
                                                            )}>
                                                                {v === undefined ? '—' : formatCurrencyCAD(v)}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                            <tr className="border-t-2 border-slate-200">
                                                <td className="py-2 pr-4 font-bold text-slate-700 text-xs">Total</td>
                                                {pivot.years.map(y => (
                                                    <td key={y} className="py-2 px-3 text-right font-bold text-brand-dark tabular-nums text-xs">
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
                                        <tr key={inv.zoho_id} className={cn('transition-colors hover:bg-slate-50/70', inv.is_avoir && 'bg-rose-50/30')}>
                                            <td className="td font-medium text-brand-dark">{inv.invoice_number ?? '—'}</td>
                                            <td className="td whitespace-nowrap text-slate-500">
                                                {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '—'}
                                            </td>
                                            <td className="td text-slate-500">{inv.department ?? '—'}</td>
                                            <td className="td text-slate-500">{inv.office ?? '—'}</td>
                                            <td className="td text-slate-500">{inv.rep_name ?? '—'}</td>
                                            <td className="td">
                                                <span className={cn('badge', INVOICE_STATUS_COLORS[key])}>
                                                    {INVOICE_STATUS_LABELS[key] ?? key}
                                                </span>
                                            </td>
                                            <td className={cn('td text-right font-semibold tabular-nums',
                                                inv.is_avoir ? 'text-rose-600' : 'text-brand-dark')}>
                                                {formatCurrencyCAD(inv.amount)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3">
                    <span className="text-sm text-slate-500" translate="no">
                        {`${invoiceCount} facture${invoiceCount > 1 ? 's' : ''}`}
                        {creditCount > 0 && ` · ${creditCount} avoir${creditCount > 1 ? 's' : ''}`}
                    </span>
                    <div className="flex items-center gap-3">
                        <ExportButton
                            rows={invoices} columns={INVOICE_CSV}
                            filename={`factures_${(account.account_name ?? 'compte').replace(/[^\w-]+/g, '_').slice(0, 40)}`}
                            disabled={invoices.length === 0}
                        />
                        <span className="text-sm font-semibold text-brand-dark">
                            Total net <span className="tabular-nums text-base">{formatCurrencyCAD(net)}</span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
