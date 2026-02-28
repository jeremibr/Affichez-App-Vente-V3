import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCcw } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface SyncButtonProps {
    onSyncComplete?: () => void;
}

export function SyncButton({ onSyncComplete }: SyncButtonProps) {
    const [syncing, setSyncing] = useState(false);
    const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
    const [badge, setBadge] = useState<{ upserted: number; deleted: number } | null>(null);

    const fetchLastSync = useCallback(async () => {
        const { data } = await supabase
            .from('webhook_log')
            .select('received_at')
            .like('action', 'sync%')
            .order('received_at', { ascending: false })
            .limit(1)
            .single();
        setLastSyncTime(data?.received_at ?? null);
    }, []);

    useEffect(() => { fetchLastSync(); }, [fetchLastSync]);

    const handleSync = async () => {
        setSyncing(true);
        setBadge(null);
        try {
            const res = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-sync`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                        'x-sync-source': 'manual',
                    },
                }
            );
            const data = await res.json();
            if (res.ok) {
                setBadge({ upserted: data.upserted, deleted: data.deleted });
                fetchLastSync();
                onSyncComplete?.();
            }
        } catch { /* details available in Paramètres → Synchronisation */ }
        setSyncing(false);
    };

    const formatRelative = (iso: string) => {
        const diffMs = Date.now() - new Date(iso).getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'à l\'instant';
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.floor(diffH / 24)}j`;
    };

    return (
        <div className="flex items-center gap-3 shrink-0">
            {lastSyncTime && (
                <span className="text-xs text-slate-400 hidden sm:block">
                    Sync {formatRelative(lastSyncTime)}
                </span>
            )}
            {badge && (
                <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-full">
                    +{badge.upserted} / -{badge.deleted}
                </span>
            )}
            <button
                onClick={handleSync}
                disabled={syncing}
                className="flex items-center gap-2 bg-brand-main text-white px-4 py-2 rounded-xl text-sm font-semibold shadow-sm shadow-brand-main/30 hover:bg-brand-main/90 transition-all disabled:opacity-60"
            >
                {syncing
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Sync...</>
                    : <><RefreshCcw className="w-4 h-4" /> Synchroniser</>
                }
            </button>
        </div>
    );
}
