export type SommaireRow = {
    month: number;
    department?: string;
    objectif: number;
    actual_amount: number;
    pct_atteint: number;
    deal_count: number;
};

export type AvailableWeek = {
    week_start: string;
    week_end: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_SummaryRow = {
    week_start: string;
    week_end: string;
    rep_name: string;
    office: string;
    status: string;
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_DeptTotal = {
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneB_DetailRow = {
    sale_date: string;
    client_name: string;
    amount: number;
    quote_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'accepted' | 'invoiced' | 'declined';
    zoho_id: string;
};

export type YoYRow = {
    quarter: number;
    rep_name: string;
    office: string;
    current_avg: number;
    previous_avg: number;
    resultat: number;
    deal_count: number;
};

// True per-quarter team totals (all reps active in each year), from
// get_quarterly_yoy_totals / get_inv_quarterly_yoy_totals. Used to show the real
// last-year comparison in the "Total équipe" row instead of only summing reps
// active in the current year.
export type QuarterTotalsRow = {
    quarter: number;
    current_total: number;
    previous_total: number;
};

export type InvDetailRow = {
    invoice_date: string;
    client_name: string;
    amount: number;
    invoice_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'sent' | 'viewed' | 'paid' | 'partial' | 'overdue' | 'void' | 'avoir';
    is_avoir: boolean;
    zoho_id: string;
};

/**
 * A row of `zoho_leads` — one Zoho CRM record, Lead or Contact, told apart by
 * `stage`. Synced by the zoho-lead-sync edge function; read-only in the app.
 *
 * `lead_source` and `service_interest` exist only on Zoho's Leads module. For a
 * contact they are inherited from the originating lead by a DB trigger, in which
 * case `attribution_inherited` is true. A contact created directly in Zoho —
 * which no lead points at — has neither, and both come back empty.
 */
export type ZohoLeadRow = {
    zoho_record_id: string;
    stage: 'lead' | 'contact';

    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    phone: string | null;
    email: string | null;

    owner_name: string | null;
    owner_email: string | null;
    rep_name: string | null;

    created_time: string | null;
    modified_time: string | null;

    lead_source: string | null;
    service_interest: string[];
    lead_status: string | null;
    attribution_inherited: boolean;

    /**
     * CRM account this record belongs to — the join key to invoices. A contact
     * takes it from Account_Name; a lead only has one once converted. Invoices
     * are owned by the account, so contacts at the same company share them.
     */
    account_id: string | null;

    /**
     * The account has at least one invoice or avoir, ever. Computed in
     * zoho_leads_unique rather than derived from the per-page rollup, so the
     * Factures filter can run in Postgres over the whole table instead of over
     * the 100 rows currently on screen.
     *
     * Optional only so a build can precede its migration; the view always
     * supplies it once 20260903020000 is applied.
     */
    has_invoices?: boolean;

    is_converted: boolean;
    converted_contact_id: string | null;
    converted_account_id: string | null;
    converted_deal_id: string | null;
    converted_time: string | null;

    zoho_crm_url: string | null;
    synced_at: string;
};

/**
 * Distinct values for the Leads filter bar (get_zoho_lead_filter_options).
 *
 * `services` is folded to one entry per service: Zoho's picklist holds the same
 * service under several spellings that differ only in case or spacing, and
 * offering both meant picking one silently excluded the other's rows.
 * `service_variants` maps each label to every raw spelling behind it, so a query
 * can match them all at once — the stored array keeps Zoho's original casing.
 */
export type ZohoLeadFilterOptions = {
    sources: string[];
    services: string[];
    reps: string[];
    service_variants: Record<string, string[]>;
};

/** Legacy hand-entered leads table, superseded by ZohoLeadRow. Kept as an archive. */
export type LeadRow = {
    id: string;
    created_at: string;
    lead_date: string;
    rep_name: string;
    source: string;
    service_interest: string | null;
    amount_sold: number;
    zoho_lead_id: string | null;
    zoho_contact_id: string | null;
    zoho_crm_url: string | null;
    notes: string | null;
    lead_status: 'active' | 'won' | 'lost';
};

export type LeadKPIs = {
    total_leads: number;
    won_leads: number;
    conversion_rate: number;
    total_amount: number;
};

export type LeadsByRepRow = {
    rep_name: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsBySourceRow = {
    source: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsByServiceRow = {
    service_interest: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsMonthlySummaryRow = {
    month: number;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

// ─── Tâches CRM (Zoho CRM tasks) ────────────────────────────────────────────

export type TaskKPIs = {
    total_created: number;
    total_completed: number;
    completion_rate: number;
    total_touched: number;
    total_open: number;
    total_overdue: number;
    active_reps: number;
};

export type TasksByRepRow = {
    rep_name: string;
    nb_created: number;
    nb_completed: number;
    nb_touched: number;
    completion_rate: number;
    avg_days_to_close: number | null;
    nb_open: number;
    nb_overdue: number;
};

export type TasksByStatusRow = {
    status: string;
    nb: number;
};

export type TasksWeeklyRow = {
    week_start: string;
    nb_created: number;
    nb_completed: number;
};

export type TasksWoWRow = {
    rep_name: string;
    created_this_week: number;
    created_last_week: number;
    completed_this_week: number;
    completed_last_week: number;
};

export type TasksAvailableWeek = {
    week_start: string;
    week_end: string;
    nb_created: number;
    nb_completed: number;
};

/**
 * One invoice or credit note attached to a CRM account, from get_lead_invoices.
 * `amount` is pre-tax and negative on an avoir, so a plain sum is the net figure.
 */
export type LeadInvoiceRow = {
    zoho_id: string;
    invoice_number: string | null;
    client_name: string;
    amount: number;
    invoice_date: string | null;
    status: 'sent' | 'viewed' | 'paid' | 'partial' | 'overdue' | 'void' | 'avoir';
    is_avoir: boolean;
    department: string | null;
    office: 'QC' | 'MTL' | null;
    rep_name: string | null;
    books_customer_id: string | null;
};

/** Per-account rollup from get_lead_invoice_totals — one row per account with invoices. */
export type LeadInvoiceTotals = {
    account_id: string;
    invoice_count: number;
    credit_count: number;
    total_amount: number;
    last_invoice_date: string | null;
};

/** Progress of the Books-customer → CRM-account back-fill, from get_invoice_linkage_status. */
export type InvoiceLinkageStatus = {
    customers_total: number;
    customers_pending: number;
    customers_linked: number;
    customers_unlinked: number;
    customers_error: number;
    invoices_total: number;
    invoices_with_account: number;
};

/**
 * Leads dashboard KPI row (get_zoho_lead_kpis), computed over Zoho's Leads module.
 *
 * Two conversion figures on purpose. `leads_converted` is Zoho's own flow, which
 * marks ~97% of leads converted and so says little; `leads_invoiced` is the lead's
 * account actually being billed after the lead arrived. The second is the one that
 * moves. They are nested, not overlapping — every invoiced lead is also converted.
 *
 * `revenue_attributed` counts only invoices dated on or after the lead arrived;
 * `revenue_lifetime` is the account's whole billing history. Both are summed once
 * per account, so several leads on one account do not double-count.
 */
export type ZohoLeadKPIs = {
    leads_received: number;
    leads_converted: number;
    leads_invoiced: number;
    conversion_rate: number;
    invoiced_rate: number;
    revenue_attributed: number;
    revenue_lifetime: number;
};

/** One row of any get_zoho_leads_by_* breakdown — same shape for rep, source and service. */
export type ZohoLeadBreakdownRow = {
    label: string;
    nb_leads: number;
    nb_converted: number;
    nb_invoiced: number;
    total_amount: number;
};

/** get_zoho_leads_monthly_summary — `month` is 1-12. */
export type ZohoLeadsMonthlyRow = {
    month: number;
    nb_leads: number;
    nb_converted: number;
    nb_invoiced: number;
    total_amount: number;
};

/**
 * Invoicing the app cannot tie to a CRM account (get_invoice_unassigned_summary).
 * Internal billing — the company invoicing itself — is reported separately rather
 * than counted as a gap, since it will never have a CRM account.
 */
export type InvoiceUnassignedSummary = {
    unassigned_count: number;
    unassigned_amount: number;
    internal_count: number;
    internal_amount: number;
    assigned_amount: number;
    total_count: number;
    total_amount: number;
    unassigned_share: number;
};

/** One unattributed invoice, with why it could not be linked (get_unassigned_invoices). */
export type UnassignedInvoiceRow = {
    zoho_id: string;
    invoice_number: string | null;
    client_name: string;
    amount: number;
    invoice_date: string | null;
    status: string;
    is_avoir: boolean;
    department: string | null;
    office: 'QC' | 'MTL' | null;
    rep_name: string | null;
    reason: string;
};
