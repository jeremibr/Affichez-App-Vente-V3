import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/utils';

export type SortOrder = 'asc' | 'desc' | null;

interface SortIconProps {
    order: SortOrder;
    className?: string;
}

export function SortIcon({ order, className }: SortIconProps) {
    if (order === 'asc') return <ChevronUp className={cn("w-3 h-3 text-brand-main", className)} />;
    if (order === 'desc') return <ChevronDown className={cn("w-3 h-3 text-brand-main", className)} />;
    return <ChevronsUpDown className={cn("w-3 h-3 text-slate-300 group-hover:text-slate-400 transition-colors", className)} />;
}
