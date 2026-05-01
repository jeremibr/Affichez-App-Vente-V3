import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

/** Returns rep names from allowed_users where rep_name is set (active team members only). */
export function useRepList(): string[] {
    const [repList, setRepList] = useState<string[]>([]);
    useEffect(() => {
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
                    ),
                ].sort() as string[];
                setRepList(unique);
            });
    }, []);
    return repList;
}
