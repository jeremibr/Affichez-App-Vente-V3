import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadCsv, type CsvColumn } from '../lib/csv';
import { cn } from '../lib/utils';

/**
 * "Exporter CSV" — the same button on every table.
 *
 * `rows` may be a function returning a promise, because the two cases are not
 * the same: a breakdown table already holds everything it shows, while a
 * paginated table holds 100 of 20,645 rows and has to go and fetch the rest.
 * Exporting the visible page would quietly produce a file that answers a
 * different question from the one on screen, so the caller is given somewhere to
 * do the full fetch and the button handles the wait.
 */
export function ExportButton<T>({ rows, columns, filename, label = 'Exporter CSV', className, disabled }: {
    rows: T[] | (() => Promise<T[]>);
    columns: CsvColumn<T>[];
    /** Base name; the helper appends the date and the extension. */
    filename: string;
    label?: string;
    className?: string;
    disabled?: boolean;
}) {
    const [busy, setBusy] = useState(false);

    const handleClick = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const data = typeof rows === 'function' ? await rows() : rows;
            downloadCsv(data, columns, filename);
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={disabled || busy}
            title="Télécharger ces données en CSV (ouvre dans Excel)"
            className={cn('btn btn-xs btn-quiet', className)}
        >
            {busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
            {/* translate="no": the label usually carries a live row count, and
                Chrome's translator replaces a text node once and then leaves the
                stale copy in place when React updates it. That produced a button
                reading "Exporter CSV" (the count-is-zero label from first paint)
                next to a table showing 18,705 rows. */}
            <span translate="no">{busy ? 'Préparation…' : label}</span>
        </button>
    );
}
