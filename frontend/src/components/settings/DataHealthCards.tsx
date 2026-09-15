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
            <div className="bg-white rounded-xl shadow-card p-6 flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-primary-press" />
                <span className="text-sm text-ink-mute">Vérification des départements…</span>
            </div>
        );
    }

    const clean = rows.length === 0;

    return (
        <div className={cn(
            'bg-white rounded-xl border shadow-card p-6 space-y-4',
            clean ? 'border-hairline' : 'border-tone-warn/40',
        )}>
            <div>
                <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                    {clean
                        ? <CheckCircle2 className="w-4 h-4 text-tone-good" />
                        : <AlertTriangle className="w-4 h-4 text-tone-warn" />}
                    Départements non reconnus
                </h2>
                <p className="text-xs text-ink-mute mt-1">
                    Documents que Zoho a envoyés avec un département que l&rsquo;application ne connaît pas.
                    L&rsquo;argent est bien enregistré, mais il n&rsquo;apparaît dans aucune répartition par
                    département tant que l&rsquo;étiquette n&rsquo;est pas ajoutée au fichier de correspondance
                    (<code className="text-2xs bg-sand px-1 rounded-xs">DEPT_MAP</code>, dans
                    {' '}<code className="text-2xs bg-sand px-1 rounded-xs">zoho-invoice-sync</code> et
                    {' '}<code className="text-2xs bg-sand px-1 rounded-xs">zoho-sync</code>).
                </p>
            </div>

            {clean ? (
                <p className="text-sm text-tone-good-ink font-medium">
                    Tous les départements sont reconnus.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hairline">
                                <th className="py-2 pr-4 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Module</th>
                                <th className="py-2 pr-4 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Étiquette Zoho</th>
                                <th className="py-2 pr-4 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Documents</th>
                                <th className="py-2 pr-4 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Montant</th>
                                <th className="py-2 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Période</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                            {rows.map(r => (
                                <tr key={`${r.module}-${r.zoho_label}`}>
                                    <td className="py-2 pr-4 text-ink-mute text-xs capitalize">{r.module}</td>
                                    <td className="py-2 pr-4 font-semibold text-ink-secondary text-xs">
                                        {r.zoho_label === '(vide)'
                                            ? <span className="text-ink-mute italic">aucun département</span>
                                            : r.zoho_label}
                                    </td>
                                    <td className="py-2 pr-4 text-right tabular-nums text-ink-secondary">{r.record_count.toLocaleString('fr-CA')}</td>
                                    <td className="py-2 pr-4 text-right tabular-nums font-semibold text-ink-secondary text-xs">
                                        {formatCurrencyCAD(r.total_amount)}
                                    </td>
                                    <td className="py-2 text-ink-mute text-xs whitespace-nowrap">
                                        {r.first_seen ? formatShortDate(new Date(r.first_seen)) : '—'}
                                        {' → '}
                                        {r.last_seen ? formatShortDate(new Date(r.last_seen)) : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-2xs text-ink-mute mt-3 leading-relaxed">
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
        <div className="bg-white rounded-xl shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                        <FileSignature className="w-4 h-4 text-primary-press" />
                        Créateurs des devis
                    </h2>
                    <p className="text-xs text-ink-mute mt-1">
                        Récupère qui a <em>saisi</em> chaque devis, ce que Zoho ne donne que document par
                        document. Chaque exécution traite une tranche&nbsp;; un travail automatique reprend
                        toutes les 3&nbsp;minutes jusqu&rsquo;à ce qu&rsquo;il ne reste rien. Les factures sont
                        déjà complètes — Zoho fournit leur créateur directement.
                    </p>
                </div>
                <button
                    onClick={runSlice}
                    disabled={running}
                    className="btn btn-md btn-primary shrink-0"
                >
                    {running ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {running ? 'En cours…' : 'Traiter une tranche'}
                </button>
            </div>

            {error && <p className="text-xs text-tone-critical-ink font-medium">{error}</p>}

            {status && (
                <>
                    <div className="h-2 rounded-full bg-stone overflow-hidden">
                        <div
                            className={cn('h-2 rounded-full transition-all',
                                pending === 0 ? 'bg-tone-good' : 'bg-primary')}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                        <Stat label="Devis traités" value={`${status.quotes_linked.toLocaleString('fr-CA')} / ${status.quotes_total.toLocaleString('fr-CA')}`} />
                        <Stat label="Restant" value={pending.toLocaleString('fr-CA')} tone={pending === 0 ? 'good' : 'neutral'} />
                        <Stat label="Erreurs" value={status.quotes_error.toLocaleString('fr-CA')} tone={status.quotes_error > 0 ? 'bad' : 'good'} />
                        <Stat label="Personnes" value={status.distinct_creators.toLocaleString('fr-CA')} />
                    </div>
                    <p className="text-2xs text-ink-mute">
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
        <div className="bg-sand rounded-md py-3 px-2">
            <p className={cn('text-sm font-bold tabular-nums',
                tone === 'good' ? 'text-tone-good-ink' : tone === 'bad' ? 'text-tone-critical-ink' : 'text-ink-secondary')}>
                {value}
            </p>
            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mt-0.5">{label}</p>
        </div>
    );
}
