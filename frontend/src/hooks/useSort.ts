import { useState, useMemo } from 'react';

export type SortOrder = 'asc' | 'desc' | null;

export interface SortConfig<T> {
    key: keyof T | null;
    order: SortOrder;
}

export function useSort<T>(data: T[], initialKey: keyof T | null = null, initialOrder: SortOrder = null) {
    const [sortConfig, setSortConfig] = useState<SortConfig<T>>({
        key: initialKey,
        order: initialOrder,
    });

    const sortedData = useMemo(() => {
        if (!sortConfig.key || !sortConfig.order) {
            return data;
        }

        return [...data].sort((a, b) => {
            const aValue = a[sortConfig.key!];
            const bValue = b[sortConfig.key!];

            if (aValue === bValue) return 0;

            const comparison = aValue < bValue ? -1 : 1;
            return sortConfig.order === 'asc' ? comparison : -comparison;
        });
    }, [data, sortConfig]);

    const handleSort = (key: keyof T) => {
        setSortConfig((prev) => {
            if (prev.key === key) {
                if (prev.order === 'asc') return { key, order: 'desc' };
                if (prev.order === 'desc') return { key: null, order: null };
            }
            return { key, order: 'asc' };
        });
    };

    return { sortedData, sortConfig, handleSort };
}
