/**
 * Per-rep commission rate store — backed by Supabase `rep_comm_rates` table.
 */
import { supabase } from '../lib/supabase';

const DEFAULT_RATE = 0.05; // 5%

/** Fetch the commission rate for a single rep from the DB. */
export async function fetchCommRate(repName: string): Promise<number> {
    if (!repName) return DEFAULT_RATE;
    const { data } = await supabase
        .from('rep_comm_rates')
        .select('rate')
        .eq('rep_name', repName)
        .single();
    return (data as { rate: number } | null)?.rate ?? DEFAULT_RATE;
}

/** Fetch all commission rates (admin use). */
export async function fetchAllCommRates(): Promise<Record<string, number>> {
    const { data } = await supabase.from('rep_comm_rates').select('rep_name, rate');
    const result: Record<string, number> = {};
    for (const row of (data ?? []) as { rep_name: string; rate: number }[]) {
        result[row.rep_name] = row.rate;
    }
    return result;
}

/** Persist a commission rate for a rep. */
export async function saveCommRate(repName: string, rate: number): Promise<void> {
    await supabase
        .from('rep_comm_rates')
        .upsert({ rep_name: repName, rate, updated_at: new Date().toISOString() }, { onConflict: 'rep_name' });
}
