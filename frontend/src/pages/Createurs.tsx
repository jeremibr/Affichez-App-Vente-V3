import { useEffect, useState, useCallback, useMemo } from 'react';
import { useUrlState } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Loader2, X, FileSignature } from 'lucide-react';
import type {
    CreatorSummaryRow, CreatorDetailRow, QuoteCreatorLinkStatus,
} from '../types/database';
import { MONTHS, OFFICES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { ExportButton } from '../components/ExportButton';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { InfoHint } from '../components/InfoHint';
import { SortIcon } from '../components/SortIcon';
import { useSort } from '../hooks/useSort';
import type { CsvColumn } from '../lib/csv';
import { formatCurrencyCAD, formatShortDate, cn } from '../lib/utils';

/**
 * Créé par — who keyed a quote or an invoice in, as opposed to who sold it.
 *
 * Asked for on 2026-09-04. Dominic wants to see the quotes Morgane Owczarzak and
 * Guillaume Montambeault put through, "même si c'est pas les autres
 * représentants" — including the ones where somebody else is the salesperson.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN PAGE, AND MUST STAY THAT WAY
 *
 * Jérémi's objection in the meeting was correct: a quote created by Morgane and
 * sold by Dominic is one quote, but it appears here under Morgane and on the
 * Factures dashboard under Dominic. Add the two together and you double-count.
 *
 * So these figures are never mixed into a rep leaderboard, never added to a
 * dashboard total, and the page says so on screen. Dominic's own words about who
 * it is for: "c'est vraiment juste pour moi, c'est même pas pour personne."
 * ────────────────────────────────────────────────────────────────────────────
 */
export default function Createurs() {
    const [yearParam, _setYear] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const setYear = (v: number | 'Toutes') => _setYear(v === 'Toutes' ? 'Toutes' : String(v));

    const [monthParam, _setMonth] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = monthParam === 'Toutes' ? 'Toutes' : Number(monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonth(v === 'Toutes' ? 'Toutes' : String(v));

    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');

    const [rows, setRows] = useState<CreatorSummaryRow[]>([]);
    const [status, setStatus] = useState<QuoteCreatorLinkStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [openCreator, setOpenCreator] = useState<CreatorSummaryRow | null>(null);

    const yearParamValue = year === 'Toutes' ? null : year;
    const monthParamValue = selectedMonth === 'Toutes' ? null : selectedMonth;
    const officeParamValue = selectedOffice === 'Toutes' ? null : selectedOffice;

    /** All three filters in one navigation, same rule as the other pages. */
    const clearFilters = () => _setYear('2026', { month: null, office: null });

    const activeFilterCount = [
        yearParam !== '2026',
        monthParam !== 'Toutes',
        selectedOffice !== 'Toutes',
    ].filter(Boolean).length;

    const fetchData = useCallback(async () => {
        setLoading(true);
        const [{ data }, { data: st }] = await Promise.all([
            supabase.rpc('get_creator_summary', {
                p_year: yearParamValue, p_month: monthParamValue, p_office: officeParamValue,
            }),
            supabase.rpc('get_quote_creator_link_status'),
        ]);
        // PostgREST can hand a NUMERIC back as a string. Everything downstream
        // then still LOOKS right — formatCurrencyCAD coerces, and so does the
        // totals row — but sorting would compare "1000" against "9" as text and
        // put the smaller number first. Coerced once, here, rather than at each
        // of the dozen places that read these fields.
        setRows(((data as CreatorSummaryRow[]) ?? []).map(r => ({
            ...r,
            quotes_created: Number(r.quotes_created),
            quotes_won: Number(r.quotes_won),
            quotes_amount: Number(r.quotes_amount),
            quotes_won_amount: Number(r.quotes_won_amount),
            invoices_created: Number(r.invoices_created),
            invoices_amount: Number(r.invoices_amount),
            win_rate: Number(r.win_rate),
        })));
        setStatus(((st as QuoteCreatorLinkStatus[]) ?? [])[0] ?? null);
        setLoading(false);
    }, [yearParamValue, monthParamValue, officeParamValue]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    const yearOptions = useMemo(() => [
        { value: 'Toutes', label: 'Toutes les années' },
        ...[2026, 2025, 2024, 2023, 2022, 2021].map(y => ({ value: String(y), label: String(y) })),
    ], []);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const officeOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Tous les bureaux' }, ...OFFICES.map(o => ({ value: o.value, label: o.label }))],
        [],
    );

    /**
     * Sortable columns. Asked for in the meeting — "on pourrait trier" — and the
     * reason is the page's shape: it lists everyone who has ever keyed a document
     * in, so finding the two people Dominic actually cares about means sorting by
     * the column that answers his question rather than scrolling.
     *
     * No initial key: the RPC already returns the list busiest-first, which is
     * the right default. A third click on a header returns to it.
     */
    const { sortedData, sortConfig, handleSort } = useSort<CreatorSummaryRow>(rows);

    const totals = useMemo(() => rows.reduce((a, r) => ({
        quotes: a.quotes + r.quotes_created,
        won: a.won + r.quotes_won,
        invoices: a.invoices + r.invoices_created,
        invAmount: a.invAmount + Number(r.invoices_amount),
    }), { quotes: 0, won: 0, invoices: 0, invAmount: 0 }), [rows]);

    // Quotes are back-filled one Zoho call at a time; until it finishes the quote
    // columns are incomplete and saying so is the difference between "we are
    // still loading" and "Richard created no quotes".
    const backfillRunning = (status?.quotes_pending ?? 0) > 0;
    const backfillPct = status && status.quotes_total > 0
        ? Math.round((status.quotes_linked / status.quotes_total) * 100)
        : 0;

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">Créé par</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-0.5">
                    Qui a <em>saisi</em> le devis ou la facture, peu importe à quel représentant la vente est attribuée
                </p>
            </div>

            {/* The amber "ces chiffres ne s'additionnent pas" banner that sat here
                was removed on 2026-09-08 as noise on every load. The caveat is
                still true and still recorded — the page subtitle says the figures
                are per person who ENTERED the document regardless of who the sale
                is credited to, the detail modal marks a different salesperson in
                orange, and docs/COMPTES.md explains why the totals overlap the rep
                dashboards by design. */}

            {backfillRunning && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-slate-50 border border-slate-100">
                    <Loader2 className="w-4 h-4 text-brand-main shrink-0 mt-0.5 animate-spin" />
                    <p className="text-xs text-slate-500 leading-relaxed">
                        Les colonnes <span className="font-semibold">Devis</span> se remplissent encore&nbsp;:
                        {' '}{backfillPct}&nbsp;% traités ({(status?.quotes_linked ?? 0).toLocaleString('fr-CA')} sur{' '}
                        {(status?.quotes_total ?? 0).toLocaleString('fr-CA')}). Zoho ne donne le créateur d&rsquo;un
                        devis que document par document, donc la reprise historique se fait par tranches, les plus
                        récents d&rsquo;abord. Les factures, elles, sont complètes.
                    </p>
                </div>
            )}

            <FilterBar>
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
                <FilterGroup label="Bureau">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-40" />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-slate-100">
                    <p className="text-xs font-medium text-slate-400" translate="no">
                        {rows.length} personne{rows.length > 1 ? 's' : ''} &middot;{' '}
                        {totals.quotes.toLocaleString('fr-CA')} devis &middot;{' '}
                        {totals.invoices.toLocaleString('fr-CA')} factures
                    </p>
                    <ExportButton rows={rows} columns={SUMMARY_CSV} filename="cree_par" disabled={rows.length === 0} />
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-brand-main" />
                    </div>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-slate-400">Aucun document sur cette période.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full" translate="no">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <Th col="creator" label="Personne" align="left"
                                        hint="Qui a saisi le document dans Zoho, pas qui a fait la vente."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="quotes_created" label="Devis créés"
                                        hint="Tous les devis saisis, refusés compris."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="quotes_won" label="Devis gagnés"
                                        hint="Devis devenus une facture. Un devis accepté mais jamais facturé ne compte pas."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="win_rate" label="Taux"
                                        hint="Devis gagnés ÷ devis créés."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="quotes_won_amount" label="Valeur gagnée"
                                        hint="Montant des devis gagnés seulement, avant taxes."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="invoices_created" label="Factures créées"
                                        hint="Factures saisies. Les avoirs ne sont pas comptés."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                    <Th col="invoices_amount" label="Montant facturé"
                                        hint="Avant taxes, avoirs déduits. Ces montants recoupent ceux des autres pages : un document saisi par une personne et vendu par une autre compte une fois ici et une fois là-bas."
                                        sortConfig={sortConfig} onSort={handleSort} />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {sortedData.map(r => (
                                    // The whole row opens the person, not just the
                                    // name: in a seven-column table the name is a
                                    // small target and every other cell looked
                                    // clickable without being so.
                                    <tr
                                        key={r.creator}
                                        onClick={() => setOpenCreator(r)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                setOpenCreator(r);
                                            }
                                        }}
                                        tabIndex={0}
                                        role="button"
                                        aria-label={`Voir les documents de ${r.creator}`}
                                        className="cursor-pointer transition-colors hover:bg-slate-50/70
                                                   focus:bg-slate-50 focus:outline-none
                                                   focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-main/40"
                                    >
                                        <td className="td">
                                            <span className="font-semibold text-brand-dark">{r.creator}</span>
                                        </td>
                                        <td className="td text-right tabular-nums font-semibold text-slate-700">
                                            {r.quotes_created.toLocaleString('fr-CA')}
                                        </td>
                                        <td className="td text-right tabular-nums text-slate-600">
                                            {r.quotes_won.toLocaleString('fr-CA')}
                                        </td>
                                        <td className="td text-right tabular-nums">
                                            <span className={cn('font-bold text-xs',
                                                r.quotes_created === 0 ? 'text-slate-300'
                                                    : r.win_rate >= 80 ? 'text-emerald-500' : 'text-slate-400')}>
                                                {r.quotes_created === 0 ? '—' : `${Number(r.win_rate).toFixed(0)} %`}
                                            </span>
                                        </td>
                                        <td className="td text-right tabular-nums text-slate-600 text-xs">
                                            {formatCurrencyCAD(r.quotes_won_amount)}
                                        </td>
                                        <td className="td text-right tabular-nums font-semibold text-slate-700">
                                            {r.invoices_created.toLocaleString('fr-CA')}
                                        </td>
                                        <td className="td text-right tabular-nums font-bold text-brand-dark text-xs">
                                            {formatCurrencyCAD(r.invoices_amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-slate-50/70 border-t-2 border-slate-100">
                                    <td className="td font-bold text-slate-700">Total</td>
                                    <td className="td text-right tabular-nums font-bold text-slate-700">
                                        {totals.quotes.toLocaleString('fr-CA')}
                                    </td>
                                    <td className="td text-right tabular-nums font-bold text-slate-700">
                                        {totals.won.toLocaleString('fr-CA')}
                                    </td>
                                    <td className="td" />
                                    <td className="td" />
                                    <td className="td text-right tabular-nums font-bold text-slate-700">
                                        {totals.invoices.toLocaleString('fr-CA')}
                                    </td>
                                    <td className="td text-right tabular-nums font-bold text-brand-dark text-xs">
                                        {formatCurrencyCAD(totals.invAmount)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </div>

            {openCreator && (
                <CreatorDetailModal
                    creator={openCreator}
                    year={yearParamValue} month={monthParamValue} office={officeParamValue}
                    onClose={() => setOpenCreator(null)}
                />
            )}
        </div>
    );
}

/**
 * A sortable column heading with a one-line definition beside it.
 *
 * The definitions are short on purpose: they answer the two questions this table
 * actually provokes — "does gagné mean accepted?" and "does that include
 * refunds?" — and nothing else. A longer explanation belongs in docs/COMPTES.md.
 */
function Th({ col, label, hint, align = 'right', sortConfig, onSort }: {
    col: keyof CreatorSummaryRow;
    label: string;
    hint: string;
    align?: 'left' | 'right';
    sortConfig: { key: keyof CreatorSummaryRow | null; order: 'asc' | 'desc' | null };
    onSort: (key: keyof CreatorSummaryRow) => void;
}) {
    return (
        <th className={cn('th', align === 'right' && 'text-right')}>
            <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
                <InfoHint text={hint} />
                <button
                    type="button"
                    onClick={() => onSort(col)}
                    aria-label={`Trier par ${label}`}
                    className="group inline-flex items-center gap-1 hover:text-slate-600 transition-colors"
                >
                    {label}
                    <SortIcon order={sortConfig.key === col ? sortConfig.order : null} />
                </button>
            </span>
        </th>
    );
}

const SUMMARY_CSV: CsvColumn<CreatorSummaryRow>[] = [
    { header: 'Personne',        value: r => r.creator },
    { header: 'Devis crees',     value: r => r.quotes_created },
    { header: 'Devis gagnes',    value: r => r.quotes_won },
    { header: 'Taux (%)',        value: r => r.win_rate },
    { header: 'Valeur devis',    value: r => r.quotes_amount },
    { header: 'Valeur gagnee',   value: r => r.quotes_won_amount },
    { header: 'Factures creees', value: r => r.invoices_created },
    { header: 'Montant facture', value: r => r.invoices_amount },
];

const DETAIL_CSV: CsvColumn<CreatorDetailRow>[] = [
    { header: 'Type',         value: r => r.module === 'devis' ? 'Devis' : 'Facture' },
    { header: 'Numero',       value: r => r.doc_number },
    { header: 'Date',         value: r => r.doc_date },
    { header: 'Client',       value: r => r.client_name },
    { header: 'Departement',  value: r => r.department },
    { header: 'Bureau',       value: r => r.office },
    { header: 'Vendu par',    value: r => r.sold_by },
    { header: 'Statut',       value: r => r.status },
    { header: 'Montant',      value: r => r.amount },
];

/**
 * One person's documents. The `Vendu par` column is the whole point of the
 * modal: it shows, row by row, that the creator and the salesperson are
 * routinely different people — which is why this page's totals can never be
 * added to a rep's.
 */
function CreatorDetailModal({ creator, year, month, office, onClose }: {
    creator: CreatorSummaryRow;
    year: number | null;
    month: number | null;
    office: string | null;
    onClose: () => void;
}) {
    const [rows, setRows] = useState<CreatorDetailRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [module, setModule] = useState<'tous' | 'devis' | 'factures'>('tous');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const { data } = await supabase.rpc('get_creator_detail', {
                p_creator: creator.creator,
                p_year: year,
                p_month: month,
                p_office: office,
                p_module: module === 'tous' ? null : module,
            });
            if (cancelled) return;
            setRows((data as CreatorDetailRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [creator.creator, year, month, office, module]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    // How often the creator is NOT the salesperson — the number that justifies
    // the page existing at all.
    const soldByOthers = rows.filter(r => r.sold_by && r.sold_by !== creator.creator).length;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
            onClick={onClose} role="presentation"
        >
            <div
                role="dialog" aria-modal="true" aria-label={`Documents créés par ${creator.creator}`}
                onClick={e => e.stopPropagation()}
                className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-brand-dark flex items-center gap-2">
                            <FileSignature className="w-4 h-4 text-slate-300" />
                            {creator.creator}
                        </h2>
                        <p className="mt-0.5 text-sm text-slate-400">
                            {rows.length.toLocaleString('fr-CA')} document{rows.length > 1 ? 's' : ''} saisi{rows.length > 1 ? 's' : ''}
                            {soldByOthers > 0 && (
                                <span className="text-slate-300">
                                    {' '}&middot; dont {soldByOthers} vendu{soldByOthers > 1 ? 's' : ''} par quelqu&rsquo;un d&rsquo;autre
                                </span>
                            )}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Select
                            value={module}
                            onChange={v => setModule(v as 'tous' | 'devis' | 'factures')}
                            options={[
                                { value: 'tous', label: 'Tout' },
                                { value: 'devis', label: 'Devis' },
                                { value: 'factures', label: 'Factures' },
                            ]}
                            className="w-32"
                        />
                        <button
                            onClick={onClose} aria-label="Fermer"
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
                ) : rows.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-slate-400">Aucun document.</div>
                ) : (
                    <div className="overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Type</th>
                                    <th className="th">Numéro</th>
                                    <th className="th">Date</th>
                                    <th className="th">Client</th>
                                    <th className="th">Département</th>
                                    <th className="th">Vendu par</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {rows.map((r, i) => {
                                    const other = r.sold_by && r.sold_by !== creator.creator;
                                    return (
                                        <tr key={`${r.module}-${r.doc_number}-${i}`}
                                            className={cn('hover:bg-slate-50/70 transition-colors', r.is_avoir && 'bg-rose-50/30')}>
                                            <td className="td">
                                                <span className={cn('badge',
                                                    r.module === 'devis' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600')}>
                                                    {r.module === 'devis' ? 'Devis' : 'Facture'}
                                                </span>
                                            </td>
                                            <td className="td font-medium text-brand-dark">{r.doc_number ?? '—'}</td>
                                            <td className="td whitespace-nowrap text-slate-500">
                                                {r.doc_date ? formatShortDate(new Date(r.doc_date)) : '—'}
                                            </td>
                                            <td className="td text-slate-500 max-w-[220px] truncate" title={r.client_name ?? ''}>
                                                {r.client_name ?? '—'}
                                            </td>
                                            <td className="td text-slate-500 text-xs">{r.department}</td>
                                            <td className={cn('td text-xs', other ? 'text-brand-main font-semibold' : 'text-slate-400')}>
                                                {r.sold_by ?? '—'}
                                            </td>
                                            <td className={cn('td text-right font-semibold tabular-nums',
                                                r.is_avoir ? 'text-rose-600' : 'text-brand-dark')}>
                                                {formatCurrencyCAD(r.amount)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3">
                    <span className="text-xs text-slate-400">
                        Les noms en orange sont vendus par une autre personne que le créateur.
                    </span>
                    <ExportButton
                        rows={rows} columns={DETAIL_CSV}
                        filename={`cree_par_${creator.creator.replace(/[^\w-]+/g, '_').slice(0, 40)}`}
                        disabled={rows.length === 0}
                    />
                </div>
            </div>
        </div>
    );
}
