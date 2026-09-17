import { useCallback, useEffect, useState } from 'react';
import { cachedRpc, invalidateRpcCache } from '../../lib/rpcCache';
import {
    RefreshCcw, Loader2, CheckCircle2, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import type { AdSpendStatusRow } from '../../types/database';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';
import { CHANNEL_LABEL } from '../advertising/channel';
import { ChannelLogo } from '../advertising/ChannelLogo';
import { AdvertisingIcon } from '../advertising/AdvertisingIcon';

const FN = 'ads-spend-sync';

function edgeUrl(): string {
    return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${FN}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'x-sync-source': 'manual',
        ...extra,
    };
}

/**
 * Google Ads / Meta spend sync: rolling sync, one-month-per-call back-fill, and
 * a credential check that prints the raw platform response.
 */
export function AdsSyncCard() {
    const [busy, setBusy] = useState<'rolling' | 'full' | 'check' | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [probe, setProbe] = useState<unknown>(null);
    const [status, setStatus] = useState<AdSpendStatusRow[] | null>(null);

    const fetchStatus = useCallback(async () => {
        const { data } = await cachedRpc('get_ad_spend_status', undefined, { ttl: 0 });
        setStatus((data as AdSpendStatusRow[]) ?? []);
    }, []);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchStatus(); }, [fetchStatus]);

    const run = async (mode: 'rolling' | 'full' | 'check') => {
        setBusy(mode); setError(null); setResult(null); setProbe(null);
        try {
            const headers = authHeaders(
                mode === 'full' ? { 'x-full-sync': 'true' }
                    : mode === 'check' ? { 'x-check-scope': 'true' }
                        : {},
            );
            const res = await fetch(edgeUrl(), { method: 'POST', headers });
            const data = await res.json();

            if (mode === 'check') {
                setProbe(data);
            } else if (!res.ok) {
                setError(data.error ?? 'Erreur inconnue');
            } else if (data.mode === 'unconfigured') {
                setError('Aucune plateforme configurée : les variables Google Ads et Meta ne sont pas définies sur la fonction.');
            } else {
                setResult(
                    `${data.upserted ?? 0} jours-campagnes importés ` +
                    `(${data.window?.start} → ${data.window?.end})` +
                    (data.mode === 'full' ? (data.done ? ' · terminé' : ' · à continuer') : '') +
                    ((data.errors?.length ?? 0) > 0 ? ` · ${data.errors.length} erreur(s) : ${data.errors[0]}` : ''),
                );
                invalidateRpcCache();
                await fetchStatus();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Erreur réseau');
        }
        setBusy(null);
    };

    return (
        <div className="bg-white rounded-xl shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                        <AdvertisingIcon className="w-4 h-4 text-ink-mute" />
                        Dépenses publicitaires (Google Ads + Meta)
                    </h2>
                    <p className="text-xs text-ink-mute mt-1 max-w-xl">
                        Importe la dépense quotidienne par campagne, automatiquement aux 4&nbsp;heures.
                        Chaque passage relit les <strong className="text-ink-secondary">35 derniers jours</strong>,
                        car les plateformes corrigent leurs chiffres après coup.
                    </p>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                    <button onClick={() => run('rolling')} disabled={busy !== null}
                            className="btn btn-md btn-primary">
                        {busy === 'rolling'
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Sync...</>
                            : <><RefreshCcw className="w-4 h-4" /> Synchroniser</>}
                    </button>
                    <button onClick={() => run('full')} disabled={busy !== null}
                            title="Importe l'historique un mois à la fois. Relancer jusqu'à « terminé »."
                            className="flex items-center gap-1.5 text-xs text-ink-mute hover:text-primary-press transition-colors disabled:opacity-50">
                        {busy === 'full'
                            ? <><Loader2 className="w-3 h-3 animate-spin" /> Historique...</>
                            : <><RefreshCcw className="w-3 h-3" /> Historique (un mois par passage)</>}
                    </button>
                    <button onClick={() => run('check')} disabled={busy !== null}
                            title="Teste les identifiants des deux plateformes sans rien importer."
                            className="flex items-center gap-1.5 text-xs text-ink-mute hover:text-primary-press transition-colors disabled:opacity-50">
                        {busy === 'check'
                            ? <><Loader2 className="w-3 h-3 animate-spin" /> Vérification...</>
                            : <><ShieldCheck className="w-3 h-3" /> Vérifier les accès</>}
                    </button>
                </div>
            </div>

            {result && (
                <div className="pt-4 border-t border-hairline flex items-center gap-2 text-sm font-semibold text-tone-good-ink">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />{result}
                </div>
            )}
            {error && (
                <div className="pt-4 border-t border-hairline flex items-start gap-2 text-sm font-medium text-tone-critical-ink">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{error}
                </div>
            )}
            {probe !== null && (
                <div className="pt-4 border-t border-hairline">
                    <p className="text-xs font-semibold text-ink-secondary mb-2">Réponse du test d&rsquo;accès</p>
                    <pre className="text-2xs bg-sand rounded-md p-3 overflow-x-auto max-h-64 text-ink-secondary">
                        {JSON.stringify(probe, null, 2)}
                    </pre>
                </div>
            )}

            {status && status.length > 0 && (
                <div className="pt-4 border-t border-hairline grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {status.map(s => (
                        <div key={s.platform} className="rounded-md bg-sand px-3 py-2.5">
                            <p className="flex items-center gap-1.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                <ChannelLogo channel={s.platform} size="xs" />
                                {CHANNEL_LABEL[s.platform]}
                            </p>
                            {s.days === 0 ? (
                                <p className="text-xs text-ink-mute mt-1 italic">Aucune donnée importée</p>
                            ) : (
                                <>
                                    <p className="text-sm font-bold text-ink tabular-nums mt-0.5">
                                        {formatCurrencyCAD(Number(s.total_spend))}
                                    </p>
                                    <p className="text-2xs text-ink-mute mt-0.5">
                                        {s.first_date && formatShortDate(s.first_date)} →{' '}
                                        {s.last_date && formatShortDate(s.last_date)} · {s.days} jours ·{' '}
                                        {s.campaigns} campagnes
                                        {s.currencies.length > 0 && (
                                            <span className={cn('ml-1 font-bold',
                                                s.currencies.some(c => c !== 'CAD')
                                                    ? 'text-tone-critical-ink' : 'text-ink-mute')}>
                                                · {s.currencies.join(', ')}
                                            </span>
                                        )}
                                    </p>
                                </>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
