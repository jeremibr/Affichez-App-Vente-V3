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
 * Where a contact's source or service came from, once resolved.
 *
 * 'own'     the record states it itself (always the case for a lead)
 * 'lead'    inherited from the lead this contact converted from
 * 'account' taken from the CRM account the contact belongs to
 * 'invoice' the departments the account has actually been billed under
 */
export type AttributionOrigin = 'own' | 'lead' | 'account' | 'invoice';

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
     * Attribution as it should be shown. For a lead these are just its own
     * values; for a contact they are resolved in zoho_leads_unique from the
     * account and the invoices billed to it, because Zoho's Contacts module
     * carries neither field.
     *
     * Use these for display and filtering. `lead_source` and `service_interest`
     * above stay exactly what Zoho's Leads module said, which for most contacts
     * is nothing at all.
     *
     * Optional only so a frontend build can ship ahead of its migration; both are
     * always present once 20260903060000 is applied.
     */
    source_resolved?: string | null;
    service_resolved?: string[];

    /** Where each resolved value came from, for the inherited-value marker. */
    source_origin?: AttributionOrigin | null;
    service_origin?: AttributionOrigin | null;

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

// ─── Comptes (Zoho CRM Accounts) ──────────────────────────────────────────────
//
// The Comptes module reads the ACCOUNT as the record, not the lead or the
// contact. An account is unique where a contact is not: a company with three
// contacts is one account, so revenue is counted once without any dedupe layer.
// That is the whole reason this module exists — see docs/COMPTES.md.

/**
 * One row of zoho_accounts_enriched — a Zoho account with its lifetime invoice
 * rollup attached. Revenue here is lifetime, not windowed: a row is an account,
 * and the 12-month attribution window is a property of a cohort comparison,
 * which lives on the dashboard RPCs instead.
 */
export type ZohoAccountRow = {
    zoho_account_id: string;
    account_name: string | null;

    phone: string | null;
    website: string | null;
    description: string | null;
    billing_street: string | null;
    billing_city: string | null;
    billing_state: string | null;
    billing_code: string | null;
    billing_country: string | null;

    owner_name: string | null;
    owner_email: string | null;
    rep_name: string | null;
    charge_de_projets: string | null;

    created_time: string | null;
    created_date: string | null;
    modified_time: string | null;
    last_activity_time: string | null;

    origine_du_client: string | null;
    service_interest: string[];
    domaine_activite: string | null;
    region_administrative: string | null;
    region_cible: string[];
    type_marche: string[];
    periode_publicitaire: string[];
    nombre_employes: string | null;
    budget_publicitaire_annuel: number | null;
    potentiel_multi_annonceurs: string | null;
    potentiel_services_ia: boolean | null;
    revendeur: boolean | null;
    rating: string | null;
    tags: string[];

    parent_account_id: string | null;
    parent_account_name: string | null;

    nombre_taches: number | null;
    derniere_tache_fermee: string | null;

    /**
     * Royer & Fils / VotreLogo.ca promo revenue, from a Zoho CRM rollup field.
     * That business is invoiced outside the QC and MTL Books orgs, so it never
     * appears in `invoices` and must never be added to revenue_lifetime — the
     * two measure different companies.
     */
    ventes_totales: number | null;
    ventes_2026: number | null;
    ventes_2025: number | null;

    zoho_crm_url: string | null;

    invoice_count: number;
    credit_count: number;
    revenue_lifetime: number;
    first_invoice_date: string | null;
    last_invoice_date: string | null;
    has_invoices: boolean;

    /** "Client Royer & Fils / VotreLogo.ca" or "Client PLOGG/BUCCO" — an acquired
     *  customer list, not a campaign. Flagged so a 2,028-account import is never
     *  read against a Meta Ads bar as though they measured the same thing. */
    is_bulk_import: boolean;

    /**
     * Rating is one of Affichez's own entities ("Compte interne : Ne pas
     * reprendre", "Fournisseur") rather than a client. Precomputed in the view
     * because PostgREST's `rating=not.in.(...)` becomes NOT (rating IN ...),
     * which is NULL — not TRUE — for the 977 accounts with no rating, and would
     * hide them from the table while the dashboard still counted them.
     */
    is_internal: boolean;

    /**
     * What the Service column shows: the CRM multiselect when the account has
     * one, otherwise the departments actually billed. 59% of accounts never had
     * the CRM field filled in, so without the fallback the column sat empty for
     * companies that had plainly bought things.
     *
     * `service_origin` says which branch won, so a borrowed value can be marked
     * rather than passed off as a CRM answer.
     */
    service_resolved: string[];
    service_origin: 'crm' | 'invoice' | 'none';
};

/**
 * get_zoho_account_kpis.
 *
 * `revenue_per_account` is the figure the module exists for: what a cohort
 * actually billed, per account acquired. Divided by accounts_created, not by
 * accounts_invoiced — the accounts that bought nothing are exactly what makes a
 * bad source bad.
 *
 * `ventes_royer` sits beside the invoice figures and never inside them.
 */
export type ZohoAccountKPIs = {
    accounts_created: number;
    accounts_invoiced: number;
    invoiced_rate: number;
    revenue_attributed: number;
    revenue_lifetime: number;
    revenue_per_account: number;
    avg_days_to_first_invoice: number | null;
    ventes_royer: number;
};

/** One row of any get_zoho_accounts_by_* breakdown — rep, source, service, domaine. */
export type ZohoAccountBreakdownRow = {
    label: string;
    nb_accounts: number;
    nb_invoiced: number;
    total_amount: number;
    revenue_per_account: number;
    is_bulk_import: boolean;
};

/** get_zoho_accounts_monthly_summary — `month` is 1-12, every month present. */
export type ZohoAccountMonthlyRow = {
    month: number;
    nb_accounts: number;
    nb_invoiced: number;
    total_amount: number;
    revenue_per_account: number;
};

/**
 * get_zoho_account_filter_options.
 *
 * Drawn from the stored data, never from Zoho's picklist definition. Accounts
 * hold 26 distinct sources against 21 live picklist entries, and the orphans
 * include "Publicité/Recherche Google" (108 accounts) — the segment Dominic
 * asked to report on. A hardcoded list offers every source except that one.
 */
export type ZohoAccountFilterOptions = {
    years: number[];
    sources: string[];
    services: string[];
    service_variants: Record<string, string[]>;
    reps: string[];
    domaines: string[];
    regions: string[];
    ratings: string[];
};

/** get_account_revenue_by_department — one row per (year, department) for one account. */
export type AccountDeptRevenueRow = {
    year: number;
    department: string;
    invoice_count: number;
    credit_count: number;
    total_amount: number;
};

// ─── Créé par (who keyed a quote or invoice in, not who sold it) ──────────────
//
// Zoho Books stores two different people on a document: the salesperson, who
// owns the sale, and the creator, who typed it in. Everything else in this app
// reads the salesperson. This module reads the creator.
//
// These numbers deliberately do NOT reconcile with the rep figures elsewhere. A
// quote created by Morgane and sold by Dominic is counted here under Morgane and
// on the Factures dashboard under Dominic. That is what Jérémi warned about in
// the 2026-09-04 meeting — "faut pas que ça fausse les chiffres" — and the
// agreed answer was a separate page, never a column on an existing table.

/** get_creator_summary — one row per person who has created a quote or invoice. */
export type CreatorSummaryRow = {
    creator: string;
    quotes_created: number;
    quotes_won: number;
    quotes_amount: number;
    quotes_won_amount: number;
    invoices_created: number;
    invoices_amount: number;
    win_rate: number;
};

/** get_creator_detail — quotes and invoices in one list. `sold_by` is the point:
 *  it is routinely somebody other than the creator. */
export type CreatorDetailRow = {
    module: 'devis' | 'factures';
    doc_number: string | null;
    doc_date: string | null;
    client_name: string | null;
    department: string;
    office: 'QC' | 'MTL' | null;
    sold_by: string | null;
    status: string;
    amount: number;
    is_avoir: boolean;
};

/**
 * get_quote_creator_link_status — progress of the quote back-fill.
 *
 * Quotes only. Invoices need no back-fill: Zoho puts `created_by` on the invoice
 * list payload, while an estimate's creator exists only on the detail endpoint
 * and only as an id, which is one API call per quote.
 */
export type QuoteCreatorLinkStatus = {
    quotes_total: number;
    quotes_linked: number;
    quotes_pending: number;
    quotes_error: number;
    invoices_total: number;
    invoices_linked: number;
    distinct_creators: number;
};

/**
 * get_unmapped_department_summary — records Zoho sent under a department name
 * the sync does not recognise.
 *
 * Expected to be empty. A row means the money is safely stored but missing from
 * every per-department figure until the label is added to DEPT_MAP in both
 * zoho-invoice-sync and zoho-sync. This alert is how EVENEMENT was found: 160
 * invoices and $142,918 that the sync had been discarding since May 2025.
 */
export type UnmappedDepartmentRow = {
    module: 'devis' | 'factures';
    zoho_label: string;
    record_count: number;
    total_amount: number;
    first_seen: string | null;
    last_seen: string | null;
};

/**
 * get_account_contacts — the people at one company.
 *
 * Shown only on the Comptes detail modal, and counted nowhere. The Comptes
 * module measures companies on purpose; this exists because once someone has
 * found the company, "who do I call" is the next question.
 */
export type AccountContactRow = {
    zoho_record_id: string;
    stage: 'lead' | 'contact';
    full_name: string | null;
    email: string | null;
    phone: string | null;
    rep_name: string | null;
    lead_status: string | null;
    created_time: string | null;
    zoho_crm_url: string | null;
};
