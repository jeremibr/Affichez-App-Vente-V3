/**
 * CSV export, shared by every table in the app.
 *
 * Asked for directly in the 2026-09-04 meeting: "je veux tout le temps qu'on
 * puisse télécharger les rapports partout" - the point is not the file, it is
 * that Dominic can pivot the numbers himself instead of asking for a new view
 * every time a question changes shape.
 *
 * Excel-first, because that is where these files are opened:
 *
 *  - **Semicolon, not comma.** A French-locale Excel splits on `;`. Handed a
 *    comma-separated file it puts every row in column A, which reads as a broken
 *    export rather than a locale mismatch.
 *  - **UTF-8 BOM.** Without it Excel decodes the file as the system codepage and
 *    "Référence employé" arrives as "RÃ©fÃ©rence employÃ©". Every account name in
 *    this data has an accent in it.
 *  - **Numbers with a decimal comma and no separators, unquoted.** 1234.5 is
 *    written `1234,5`, which a French Excel reads as a number. Formatting it as
 *    "1 234,50 $" would export a string nobody can sum.
 */

/** A cell: rendered as-is for strings, localised for numbers, blank for null. */
export type CsvValue = string | number | boolean | null | undefined;

export type CsvColumn<T> = {
    /** Column heading, in French - this file is read by people, not by code. */
    header: string;
    value: (row: T) => CsvValue;
};

/**
 * RFC 4180 quoting, adapted to a semicolon delimiter.
 *
 * A field is quoted only when it has to be - a delimiter, a quote, or a newline
 * in it. Quoting everything would be valid CSV, but it also turns every number
 * into text as far as Excel is concerned, which defeats the point of exporting.
 */
function escapeCell(v: CsvValue): string {
    if (v === null || v === undefined) return '';

    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        // Decimal comma, no thousands separator, never quoted: that is the one
        // shape a French Excel parses as a number.
        return String(v).replace('.', ',');
    }

    if (typeof v === 'boolean') return v ? 'Oui' : 'Non';

    const s = String(v);
    // A leading =, +, - or @ makes Excel treat the cell as a formula. Zoho fields
    // are free text and do contain them ("-None-", "+1 450..."), so the cell is
    // prefixed with a tab, which Excel strips on display but not on evaluation.
    const safe = /^[=+\-@]/.test(s) ? `\t${s}` : s;

    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Columns derived from the first row's keys.
 *
 * For tables whose shape is defined by an RPC and mirrored straight onto the
 * screen - the header is then the column name, which is not pretty but is
 * honest, and it means a new field added to the query is exported without
 * anybody having to remember to add it here.
 *
 * Prefer an explicit CsvColumn[] where the headings are read by people.
 */
export function autoColumns<T extends object>(rows: T[]): CsvColumn<T>[] {
    const first = rows[0];
    if (!first) return [];
    return (Object.keys(first) as (keyof T & string)[]).map(k => ({
        header: k,
        value: (row: T) => row[k] as CsvValue,
    }));
}

/** Rows → a CSV string, headers included. Exported for tests and for callers
 *  that want the text without triggering a download. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
    const lines = [columns.map(c => escapeCell(c.header)).join(';')];
    for (const row of rows) {
        lines.push(columns.map(c => escapeCell(c.value(row))).join(';'));
    }
    // CRLF: Excel is happy either way, but Notepad on Windows is not.
    return lines.join('\r\n');
}

/**
 * A filename that sorts and does not collide: `comptes_2026-09-07.csv`.
 * Date first in ISO so a folder of exports sorts chronologically by name.
 */
export function csvFilename(base: string): string {
    const d = new Date();
    const stamp = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
    ].join('-');
    return `${base}_${stamp}.csv`;
}

/**
 * Build the CSV and hand it to the browser as a download.
 *
 * U+FEFF (the character prefixed to the blob below) is the UTF-8 BOM - see
 * the header note. It is prepended to the string rather than set as a charset
 * parameter because Excel reads the bytes, not the MIME type.
 */
export function downloadCsv<T>(rows: T[], columns: CsvColumn<T>[], base: string): void {
    const blob = new Blob(['﻿' + toCsv(rows, columns)], {
        type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFilename(base);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoked on the next tick, not synchronously: Safari cancels an in-flight
    // download if the object URL disappears during the click handler.
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
