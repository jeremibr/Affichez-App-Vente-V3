import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { INTERNAL_REP_NAMES } from '../lib/constants';

/** Returns rep names from allowed_users, excluding internal sales reps. */
export function useRepList(): string[] {
    const [repList, setRepList] = useState<string[]>([]);
    useEffect(() => {
        const internalSet = new Set((INTERNAL_REP_NAMES as readonly string[]).map(n => n.normalize('NFC')));
        supabase
            .from('allowed_users')
            .select('rep_name')
            .not('rep_name', 'is', null)
            .then(({ data }) => {
                const unique = [
                    ...new Set(
                        (data ?? [])
                            .map((r: { rep_name: string }) => r.rep_name)
                            .filter(Boolean)
                            .filter((n: string) => !internalSet.has(n.normalize('NFC')))
                    ),
                ].sort() as string[];
                setRepList(unique);
            });
    }, []);
    return repList;
}
