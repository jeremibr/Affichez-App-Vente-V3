import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

/** Returns a deduplicated sorted list of rep names from the sales table. */
export function useRepList(): string[] {
    const [repList, setRepList] = useState<string[]>([]);
    useEffect(() => {
        supabase
            .from('sales')
            .select('rep_name')
            .not('rep_name', 'is', null)
            .limit(1000)
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
