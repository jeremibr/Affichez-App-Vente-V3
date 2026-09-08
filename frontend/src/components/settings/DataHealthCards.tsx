import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertTriangle, CheckCircle2, Loader2, FileSignature } from 'lucide-react';
import type { UnmappedDepartmentRow, QuoteCreatorLinkStatus } from '../../types/database';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';

/**
 * Two health cards for the Synchronisation tab.
 *
 * The first one is the reason both of them exist. Until 2026-09-07 the invoice
 * and quote syncs silently discarded any record whose department they did not
 * recognise — no error, no log, nothing on screen. That had been quietly losing
 * 160 invoices and $142,918 since May 2025, because Zoho Books had started
 * billing under a department called "ÉVÈNEMENT" that the mapping had never heard
 * of, plus 92 credit notes worth -$117,764 whose department could not be
 * resolved. Dominic reported the symptom in the 2026-09-04 meeting — numbers
 * that would not add up — and nobody could find the cause, because there was
 * nothing to find it with.
 *
 * The records now land with no department rather than being thrown away, and
 * this card is what says so. It is supposed to be empty. It being non-empty is
 * the whole point.
 */
export function UnmappedDepartmentsCard() {
    const [rows, setRows] = useState<UnmappedDepartmentRow[] | null>(null);

    // The write happens in the awaited continuation, not during the render pass,
    // so this does not cascade.
    useEffect(() => {
        (async () => {
            const { data } = await supabase.rpc('get_unmapped_department_summary');
            setRows((data as UnmappedDepartmentRow[]) ?? []);
        })();
    }, []);

    if (rows === null) {
        return (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-card p-6 flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-brand-main" />
                <span className="text-sm text-slate-400">Vérification des départements…</span>
            </div>
        );
    }

    const clean = rows.length === 0;

    return (
        <div className={cn(
            'bg-white rounded-2xl border shadow-card p-6 space-y-4',
            clean ? 'border-slate-100' : 'border-amber-200',
        )}>
            <div>
                <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
                    {clean
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        : <AlertTriangle className="w-4 h-4 text-amber-500" />}
                    Départements non reconnus
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                    Documents que Zoho a envoyés avec un département que l&rsquo;application ne connaît pas.
                    L&rsquo;argent est bien enregistré, mais il n&rsquo;apparaît dans aucune répartition par
                    département tant que l&rsquo;étiquette n&rsquo;est pas ajoutée au fichier de correspondance
                    (<code className="text-[10px] bg-slate-50 px-1 rounded">DEPT_MAP</code>, dans
                    {' '}<code className="text-[10px] bg-slate-50 px-1 rounded">zoho-invoice-sync</code> et
                    {' '}<code className="text-[10px] bg-slate-50 px-1 rounded">zoho-sync</code>).
                </p>
            </div>

            {clean ? (
                <p className="text-sm text-emerald-600 font-medium">
                    Tous les départements sont reconnus.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-slate-100">
                                <th className="py-2 pr-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Module</th>
                                <th className="py-2 pr-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Étiquette Zoho</th>
                                <th className="py-2 pr-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Documents</th>
                                <th className="py-2 pr-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Montant</th>
                                <th className="py-2 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest">Période</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {rows.map(r => (
                                <tr key={`${r.module}-${r.zoho_label}`}>
                                    <td className="py-2 pr-4 text-slate-500 text-xs capitalize">{r.module}</td>
                                    <td className="py-2 pr-4 font-semibold text-slate-700 text-xs">
                                        {r.zoho_label === '(vide)'
                                            ? <span className="text-slate-400 italic">aucun département</span>
                                            : r.zoho_label}
                                    </td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-slate-600">{r.record_count.toLocaleString('fr-CA')}</td>
                                    <td className="py-2 pr-4 text-right tabular-nums font-semibold text-slate-700 text-xs">
                                        {formatCurrencyCAD(r.total_amount)}
                                    </td>
                                    <td className="py-2 text-slate-400 text-xs whitespace-nowrap">
                                        {r.first_seen ? formatShortDate(new Date(r.first_seen)) : '—'}
                                        {' → '}
                                        {r.last_seen ? formatShortDate(new Date(r.last_seen)) : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
                        Une étiquette vide veut dire que Zoho lui-même n&rsquo;a pas de département sur ces
                        documents — rien à corriger dans l&rsquo;application. Une étiquette nommée veut dire
                        qu&rsquo;il manque une correspondance.
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * Progress of the quote-creator back-fill.
 *
 * Invoices are not shown as "pending" because they never are: Zoho puts
 * `created_by` straight on the invoice list payload. An estimate's creator lives
 * only on the detail endpoint and only as an id, so every quote costs one API
 * call — 7,961 of them, against a ceiling of 100 calls per minute per
 * organisation. A cron job takes a slice every three minutes until it is done.
 */
export function QuoteCreatorCard() {
    const [status, setStatus] = useState<QuoteCreatorLinkStatus | null>(null);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchStatus = async () => {
        const { data } = await supabase.rpc('get_quote_creator_link_status').single();
        setStatus((data as QuoteCreatorLinkStatus) ?? null);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchStatus(); }, []);

    const runSlice = async () => {
        setRunning(true); setError(null);
        try {
            const res = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-quote-creator-sync`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                        'x-sync-source': 'manual',
                    },
                },
            );
            const data = await res.json();
            if (!res.ok) setError(data.error ?? 'Erreur inconnue');
            else await fetchStatus();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Erreur réseau');
        }
        setRunning(false);
    };

    const pending = status?.quotes_pending ?? 0;
    const pct = status && status.quotes_total > 0
        ? Math.round((status.quotes_linked / status.quotes_total) * 100)
        : 0;

    return (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
                        <FileSignature className="w-4 h-4 text-brand-main" />
                        Créateurs des devis
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                        Récupère qui a <em>saisi</em> chaque devis, ce que Zoho ne donne que document par
                        document. Chaque exécution traite une tranche&nbsp;; un travail automatique reprend
                        toutes les 3&nbsp;minutes jusqu&rsquo;à ce qu&rsquo;il ne reste rien. Les factures sont
                        déjà complètes — Zoho fournit leur créateur directement.
                    </p>
                </div>
                <button
                    onClick={runSlice}
                    disabled={running}
                    className="flex shrink-0 items-center gap-2 bg-brand-main text-white px-5 py-2.5 rounded-xl
                               text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90
                               disabled:opacity-50 transition-colors"
                >
                    {running ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {running ? 'En cours…' : 'Traiter une tranche'}
                </button>
            </div>

            {error && <p className="text-xs text-rose-600 font-medium">{error}</p>}

            {status && (
                <>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                            className={cn('h-2 rounded-full transition-all',
                                pending === 0 ? 'bg-emerald-500' : 'bg-brand-main')}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                        <Stat label="Devis traités" value={`${status.quotes_linked.toLocaleString('fr-CA')} / ${status.quotes_total.toLocaleString('fr-CA')}`} />
                        <Stat label="Restant" value={pending.toLocaleString('fr-CA')} tone={pending === 0 ? 'good' : 'neutral'} />
                        <Stat label="Erreurs" value={status.quotes_error.toLocaleString('fr-CA')} tone={status.quotes_error > 0 ? 'bad' : 'good'} />
                        <Stat label="Personnes" value={status.distinct_creators.toLocaleString('fr-CA')} />
                    </div>
                    <p className="text-[11px] text-slate-400">
                        Factures&nbsp;: {status.invoices_linked.toLocaleString('fr-CA')} sur{' '}
                        {status.invoices_total.toLocaleString('fr-CA')} portent déjà un créateur.
                    </p>
                </>
            )}
        </div>
    );
}

function Stat({ label, value, tone = 'neutral' }: {
    label: string; value: string; tone?: 'good' | 'bad' | 'neutral';
}) {
    return (
        <div className="bg-slate-50 rounded-xl py-3 px-2">
            <p className={cn('text-sm font-bold tabular-nums',
                tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-slate-700')}>
                {value}
            </p>
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mt-0.5">{label}</p>
        </div>
    );
}
