import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/utils';

export type SortOrder = 'asc' | 'desc' | null;

interface SortIconProps {
    order: SortOrder;
    className?: string;
}

export function SortIcon({ order, className }: SortIconProps) {
    if (order === 'asc') return <ChevronUp className={cn("w-3 h-3 text-primary-press", className)} />;
    if (order === 'desc') return <ChevronDown className={cn("w-3 h-3 text-primary-press", className)} />;
    return <ChevronsUpDown className={cn("w-3 h-3 text-ink-faint group-hover:text-ink-mute transition-colors", className)} />;
}
