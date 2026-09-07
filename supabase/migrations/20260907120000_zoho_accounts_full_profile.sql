-- Widen zoho_accounts from an attribution lookup into the module's own table.
--
-- The original table (20260903050000) carried three fields, because all it had
-- to do was lend a Contact the source and service it does not store itself. The
-- Comptes module reads the account as the record, so it needs the rest: who owns
-- it, when it arrived, how to reach it, and what segment it sits in.
--
-- Field selection is not "everything Zoho has". Accounts exposes 70 fields; the
-- 33 below are the ones something on screen or in a filter actually reads.
-- Skipped on purpose: Shipping_* (a duplicate of Billing_* for a company that
-- ships nothing), the five zthrive* loyalty fields (an app nobody here uses),
-- Exchange_Rate and Currency (single-currency org), Enrich_Status/Record_Status
-- (Zoho housekeeping), Date_4/Date_5 (unlabelled and unpopulated).
--
-- Measured against the live org on 2026-09-07 (20,645 accounts):
--   Phone                 18,844 (91%)
--   Origine_du_client     17,858 (86%)
--   Domaine_d_activit     14,127 (68%)
--   service multiselect    8,382 (41%)
--   Created_Time 2026       4,385  · 2025  3,116
--
-- Nothing here is destructive: every column is added nullable, so the existing
-- contact-attribution path in 20260903060000 keeps working untouched while the
-- sync backfills.

-- ─── Reach and identity ───────────────────────────────────────────────────────

ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS phone            TEXT,
  ADD COLUMN IF NOT EXISTS website          TEXT,
  ADD COLUMN IF NOT EXISTS billing_street   TEXT,
  ADD COLUMN IF NOT EXISTS billing_city     TEXT,
  ADD COLUMN IF NOT EXISTS billing_state    TEXT,
  ADD COLUMN IF NOT EXISTS billing_code     TEXT,
  ADD COLUMN IF NOT EXISTS billing_country  TEXT,
  ADD COLUMN IF NOT EXISTS description      TEXT,
  ADD COLUMN IF NOT EXISTS zoho_crm_url     TEXT;

-- ─── Ownership ────────────────────────────────────────────────────────────────
-- owner_* is Zoho's word for it; rep_name is the app's, resolved through
-- allowed_users.email exactly as zoho-lead-sync does, so a Comptes figure and a
-- Factures figure for the same person carry the same name.

ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS owner_id           TEXT,
  ADD COLUMN IF NOT EXISTS owner_name         TEXT,
  ADD COLUMN IF NOT EXISTS owner_email        TEXT,
  ADD COLUMN IF NOT EXISTS rep_name           TEXT,
  -- Accounts."Charg_e_de_projets" is an email field, not a lookup: it holds the
  -- address of the project manager, not a CRM user id.
  ADD COLUMN IF NOT EXISTS charge_de_projets  TEXT;

-- ─── Dates ────────────────────────────────────────────────────────────────────
-- created_time is the axis the whole module turns on: it is what "un compte
-- arrivé en juillet" means, and what the attribution window counts forward from.
-- Zoho returns it with the org's own offset (-04:00/-05:00), so it is already
-- Montreal wall-clock before Postgres normalises it to UTC.

ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS created_time        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_time  TIMESTAMPTZ;

-- ─── Segmentation ─────────────────────────────────────────────────────────────
-- Stored in Zoho's own wording, like origine_du_client above and for the same
-- reason: folding two picklist values together asserts they mean the same thing,
-- and if that is wrong nothing on screen shows it.

ALTER TABLE zoho_accounts
  -- Rating: "Actif", "Client à reprendre", "Compte interne : Ne pas reprendre",
  -- "Sous-Compte", "Arrêté", "Neutre", "Fournisseur". The dashboard ships with
  -- the internal and supplier ratings filtered out by default — LUMEN
  -- (Hydro-Québec) alone is an internal account carrying six figures.
  ADD COLUMN IF NOT EXISTS rating                      TEXT,
  -- 53 values, "Dentiste" through "Toiture". The vertical Dominic segments by.
  ADD COLUMN IF NOT EXISTS domaine_activite            TEXT,
  ADD COLUMN IF NOT EXISTS region_administrative       TEXT,
  ADD COLUMN IF NOT EXISTS region_cible                TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS type_marche                 TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS periode_publicitaire        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS nombre_employes             TEXT,
  ADD COLUMN IF NOT EXISTS budget_publicitaire_annuel  NUMERIC,
  ADD COLUMN IF NOT EXISTS potentiel_multi_annonceurs  TEXT,
  ADD COLUMN IF NOT EXISTS potentiel_services_ia       BOOLEAN,
  ADD COLUMN IF NOT EXISTS revendeur                   BOOLEAN,
  ADD COLUMN IF NOT EXISTS tags                        TEXT[] NOT NULL DEFAULT '{}';

-- ─── Hierarchy ────────────────────────────────────────────────────────────────
-- 511 accounts name a parent. They stay their own row and keep their own
-- invoices — rolling a child's revenue into its parent would need a recursive
-- walk and a double-count guard on every total, to move 2.5% of the book.
-- The columns exist so a franchise can be recognised on screen.

ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS parent_account_id    TEXT,
  ADD COLUMN IF NOT EXISTS parent_account_name  TEXT;

-- ─── Activity ─────────────────────────────────────────────────────────────────

ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS nombre_taches          INTEGER,
  ADD COLUMN IF NOT EXISTS derniere_tache_fermee  DATE;

-- ─── Royer & Fils / VotreLogo.ca revenue ──────────────────────────────────────
--
-- These are NOT a second opinion on the invoices table. Measured on 2026-09-07:
-- Ventes_totales_2022_2026 sums to $5,530,878.34 across all 20,645 accounts, and
-- to $5,530,878.34 across the 2,028 accounts whose origin is "Client Royer &
-- Fils / VotreLogo.ca" — to the cent. Every account carrying a Ventes_* value
-- belongs to that cohort and no other.
--
-- That business is invoiced outside the two Zoho Books organisations we sync, so
-- its revenue reaches the app only through these CRM fields. LUMEN is the proof:
-- $1.5M of Ventes_totales in CRM, zero rows in `invoices`.
--
-- Kept in their own columns and never added into revenue_attributed or
-- revenue_lifetime. Those two answer "what did Affichez advertising bill this
-- account", which is what every other number in the app means; silently folding
-- a promo-products business into them would make the Comptes page disagree with
-- the Factures page for reasons no one could find.
ALTER TABLE zoho_accounts
  ADD COLUMN IF NOT EXISTS ventes_2022    NUMERIC,
  ADD COLUMN IF NOT EXISTS ventes_2023    NUMERIC,
  ADD COLUMN IF NOT EXISTS ventes_2024    NUMERIC,
  ADD COLUMN IF NOT EXISTS ventes_2025    NUMERIC,
  ADD COLUMN IF NOT EXISTS ventes_2026    NUMERIC,
  ADD COLUMN IF NOT EXISTS ventes_totales NUMERIC;

-- The five per-department currency fields on the account (NUM/WEB/PROM/DIST/
-- AUTRE) are deliberately NOT synced. They are abandoned: LUMEN carries
-- $1,546,855 of Ventes_totales against NUM = 47.78 and the other four null.
-- Department revenue comes from invoices.department, which is maintained.

-- ─── Indexes ──────────────────────────────────────────────────────────────────
-- One per column the detail table filters, sorts or paginates on. Without these
-- every page of a 20.6k-row table is a sequential scan plus a sort.

CREATE INDEX IF NOT EXISTS zoho_accounts_created_idx  ON zoho_accounts(created_time DESC);
CREATE INDEX IF NOT EXISTS zoho_accounts_rating_idx   ON zoho_accounts(rating);
CREATE INDEX IF NOT EXISTS zoho_accounts_origine_idx  ON zoho_accounts(origine_du_client);
CREATE INDEX IF NOT EXISTS zoho_accounts_rep_idx      ON zoho_accounts(rep_name);
CREATE INDEX IF NOT EXISTS zoho_accounts_domaine_idx  ON zoho_accounts(domaine_activite);
CREATE INDEX IF NOT EXISTS zoho_accounts_parent_idx   ON zoho_accounts(parent_account_id)
  WHERE parent_account_id IS NOT NULL;

-- Search is `account_name ILIKE '%term%'`, which no btree can serve. pg_trgm
-- turns it into an index scan; without it, typing in the search box sequentially
-- scans 20.6k rows on every keystroke.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS zoho_accounts_name_trgm_idx
  ON zoho_accounts USING gin (account_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS zoho_accounts_phone_trgm_idx
  ON zoho_accounts USING gin (phone gin_trgm_ops);

-- ─── Documentation ────────────────────────────────────────────────────────────

COMMENT ON TABLE zoho_accounts IS
  'Zoho CRM Accounts. The record behind the Comptes module, and the source of '
  'the two attribution fields a Contact does not carry itself. Synced by '
  'zoho-account-sync; never written from the app.';

COMMENT ON COLUMN zoho_accounts.created_time IS
  'Zoho Created_Time. The axis of the Comptes module: which month an account '
  'arrived in, and the zero point of the revenue attribution window.';

COMMENT ON COLUMN zoho_accounts.rating IS
  'Zoho Rating picklist. "Compte interne : Ne pas reprendre" (1,937 rows) marks '
  'Affichez''s own entities and is excluded by default on the dashboard.';

COMMENT ON COLUMN zoho_accounts.ventes_totales IS
  'Zoho Ventes totales 2022-2026. Populated ONLY for Client Royer & Fils / '
  'VotreLogo.ca accounts, whose invoices live outside the Books orgs we sync. '
  'Never added into revenue_attributed or revenue_lifetime.';

COMMENT ON COLUMN zoho_accounts.rep_name IS
  'Owner resolved through allowed_users.email, so the name matches the one the '
  'Devis and Factures modules use for the same person.';
