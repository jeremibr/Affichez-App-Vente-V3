-- ============================================================
-- LEADS MODULE — Supabase SQL
-- Run this in the Supabase SQL Editor (in order)
-- ============================================================


-- ─── 1. TABLE ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leads (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lead_date        DATE NOT NULL,
  rep_name         TEXT NOT NULL,
  source           TEXT NOT NULL,
  service_interest TEXT,
  amount_sold      NUMERIC NOT NULL DEFAULT 0,
  zoho_lead_id     TEXT,
  zoho_contact_id  TEXT,
  zoho_crm_url     TEXT,
  notes            TEXT,
  lead_status      TEXT NOT NULL DEFAULT 'active'
    CHECK (lead_status IN ('active', 'won', 'lost'))
);

CREATE INDEX IF NOT EXISTS leads_rep_name_idx   ON leads(rep_name);
CREATE INDEX IF NOT EXISTS leads_lead_date_idx  ON leads(lead_date);
CREATE INDEX IF NOT EXISTS leads_source_idx     ON leads(source);
CREATE INDEX IF NOT EXISTS leads_zoho_lead_idx  ON leads(zoho_lead_id);
CREATE INDEX IF NOT EXISTS leads_zoho_cont_idx  ON leads(zoho_contact_id);

-- Enable RLS (Row Level Security) — adjust policies as needed
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Policy: all authenticated users can read all leads
CREATE POLICY "leads_select_authenticated"
  ON leads FOR SELECT
  TO authenticated
  USING (true);

-- Policy: all authenticated users can insert/update/delete leads
CREATE POLICY "leads_all_authenticated"
  ON leads FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- ─── 2. RPC FUNCTIONS ──────────────────────────────────────────────────────────


-- 2a. KPIs
CREATE OR REPLACE FUNCTION get_leads_kpis(
  p_year    INT,
  p_month   INT     DEFAULT NULL,
  p_rep     TEXT    DEFAULT NULL,
  p_source  TEXT    DEFAULT NULL,
  p_service TEXT    DEFAULT NULL
)
RETURNS TABLE (
  total_leads     BIGINT,
  won_leads       BIGINT,
  conversion_rate NUMERIC,
  total_amount    NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*)                                              AS total_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')           AS won_leads,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(COUNT(*) FILTER (WHERE lead_status = 'won') * 100.0 / COUNT(*), 1)
    END                                                   AS conversion_rate,
    COALESCE(SUM(amount_sold), 0)                         AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
$$;


-- 2b. By rep
CREATE OR REPLACE FUNCTION get_leads_by_rep(
  p_year    INT,
  p_month   INT     DEFAULT NULL,
  p_source  TEXT    DEFAULT NULL,
  p_service TEXT    DEFAULT NULL
)
RETURNS TABLE (
  rep_name     TEXT,
  nb_leads     BIGINT,
  nb_won       BIGINT,
  total_amount NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    rep_name,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY rep_name
  ORDER BY nb_leads DESC
$$;


-- 2c. By source
CREATE OR REPLACE FUNCTION get_leads_by_source(
  p_year    INT,
  p_month   INT     DEFAULT NULL,
  p_rep     TEXT    DEFAULT NULL,
  p_service TEXT    DEFAULT NULL
)
RETURNS TABLE (
  source       TEXT,
  nb_leads     BIGINT,
  nb_won       BIGINT,
  total_amount NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    source,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY source
  ORDER BY nb_leads DESC
$$;


-- 2d. By service
CREATE OR REPLACE FUNCTION get_leads_by_service(
  p_year    INT,
  p_month   INT     DEFAULT NULL,
  p_rep     TEXT    DEFAULT NULL,
  p_source  TEXT    DEFAULT NULL
)
RETURNS TABLE (
  service_interest TEXT,
  nb_leads         BIGINT,
  nb_won           BIGINT,
  total_amount     NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(service_interest, 'NON MENTIONNÉ') AS service_interest,
    COUNT(*)                                            AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')         AS nb_won,
    COALESCE(SUM(amount_sold), 0)                       AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name = p_rep)
    AND (p_source  IS NULL OR source   = p_source)
  GROUP BY service_interest
  ORDER BY nb_leads DESC
$$;


-- 2e. Monthly summary
CREATE OR REPLACE FUNCTION get_leads_monthly_summary(
  p_year    INT,
  p_rep     TEXT    DEFAULT NULL,
  p_source  TEXT    DEFAULT NULL,
  p_service TEXT    DEFAULT NULL
)
RETURNS TABLE (
  month        INT,
  nb_leads     BIGINT,
  nb_won       BIGINT,
  total_amount NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    EXTRACT(MONTH FROM lead_date)::INT              AS month,
    COUNT(*)                                        AS nb_leads,
    COUNT(*) FILTER (WHERE lead_status = 'won')     AS nb_won,
    COALESCE(SUM(amount_sold), 0)                   AS total_amount
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  GROUP BY EXTRACT(MONTH FROM lead_date)::INT
  ORDER BY month
$$;


-- 2f. Detail rows (used for the table view)
CREATE OR REPLACE FUNCTION get_leads_detail(
  p_year    INT,
  p_month   INT     DEFAULT NULL,
  p_rep     TEXT    DEFAULT NULL,
  p_source  TEXT    DEFAULT NULL,
  p_service TEXT    DEFAULT NULL,
  p_limit   INT     DEFAULT 500
)
RETURNS TABLE (
  id               UUID,
  created_at       TIMESTAMPTZ,
  lead_date        DATE,
  rep_name         TEXT,
  source           TEXT,
  service_interest TEXT,
  amount_sold      NUMERIC,
  zoho_lead_id     TEXT,
  zoho_contact_id  TEXT,
  zoho_crm_url     TEXT,
  notes            TEXT,
  lead_status      TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    id, created_at, lead_date, rep_name, source,
    service_interest, amount_sold, zoho_lead_id,
    zoho_contact_id, zoho_crm_url, notes, lead_status
  FROM leads
  WHERE EXTRACT(YEAR FROM lead_date)::INT = p_year
    AND (p_month   IS NULL OR EXTRACT(MONTH FROM lead_date)::INT = p_month)
    AND (p_rep     IS NULL OR rep_name         = p_rep)
    AND (p_source  IS NULL OR source           = p_source)
    AND (p_service IS NULL OR service_interest = p_service)
  ORDER BY lead_date DESC
  LIMIT p_limit
$$;


-- ─── 3. HISTORICAL DATA MIGRATION ─────────────────────────────────────────────
-- January 2026 leads — date set to 2026-01-01 (day unknown for historical data)
-- amount_sold = 0 for rows with no sale; non-zero amounts are marked 'won'
-- Source: Lead - Statistique 2026 - Janvier 2026.csv

INSERT INTO leads (lead_date, rep_name, source, service_interest, amount_sold, zoho_crm_url, lead_status) VALUES
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000002941001','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193415001?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',1542,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193420001?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000176590370?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193417004?pfrom=gsearch','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000189898004?pfrom=gsearch','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000009985052?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193437001?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193414002?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193419007?pfrom=gsearch','active'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000130395088?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193470001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193507001?pfrom=gsearch','active'),
('2026-01-01','Morgane','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193495058','active'),
('2026-01-01','Guillaume','Intérêt par un produit de la boutique','PROMO',3800,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193526006','won'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',1017.7,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193547001','won'),
('2026-01-01','Paul','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000152892608?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193604015?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',3895,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000178723295','won'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193526040','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000173115575?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193740001','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',1775,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193553049?pfrom=gsearch','won'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193718012?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193732012?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000193759273?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193547016?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000193759526?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',1407.87,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193697844','won'),
('2026-01-01','Sylvain','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193697879','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',4245,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193697899','won'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',31995.27,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000193620161?pfrom=gsearch','won'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193732032?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193876013','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193886001?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',345,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193876035','won'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193899001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000173115250?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193876045','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000119369246?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194208106?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193962025?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194208024?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000192245078?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',5570.4,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000118724636?pfrom=gsearch','won'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',96.05,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194217044','won'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000005863091?pfrom=gsearch','active'),
('2026-01-01','Morgane','Intérêt par un produit de la boutique','PROMO',744.59,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194217087','won'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000194208544?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000193988003?pfrom=gsearch','active'),
('2026-01-01','Richard','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194217102','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194352001?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194353006?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194364001','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000018566001?pfrom=gsearch','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',2095,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000155451305?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194382015?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194380022?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194370003?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194479004?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194382030?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194479089?pfrom=gsearch','active'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000093641493','active'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000149928166?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194359014?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194486039','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',4368.35,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000194479418?pfrom=gsearch','won'),
('2026-01-01','Kim','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000101996019?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194486092','active'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000150728020?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194515015?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194536546?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194422043?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','PROMO',857.13,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000001431003?pfrom=gsearch','won'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',5985,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000115016394?pfrom=gsearch','won'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194708006','active'),
('2026-01-01','Sylvain','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194708016','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',4800,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194801001','won'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Contacts/1402586000108975019?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194856001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194916001','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194916011','active'),
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000160078001','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194916076','active'),
('2026-01-01','Paul','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194916091','active'),
('2026-01-01','Morgane','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000194916113','active'),
('2026-01-01','Simon','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000088138206?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195013011?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000194990696?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195013031?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195028002?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195111201?pfrom=gsearch','active'),
('2026-01-01','Sylvain','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195121005','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195140006?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',4095,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195421012?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195168001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195431001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',3250,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195464001','won'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195421909?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195464030','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000135792427','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195420028?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195461008?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195582093?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195499001?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195582001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195695001?pfrom=gsearch','active'),
('2026-01-01','Morgane','Client déjà en CRM du passé','PROMO',1615,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000187004405?pfrom=gsearch','won'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',9147.35,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195700006','won'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195703001?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195705001?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',992.5,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000096256163?pfrom=gsearch','won'),
('2026-01-01','Sylvain','AUTRE (à déterminer dans les notes)','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195700085','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195778001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195799001','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195799016','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195805001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195799031','active'),
('2026-01-01','Morgane','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195852001','active'),
('2026-01-01','Richard','A reçu notre publicité imprimé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195852011','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195852021','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195837229?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195931001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',3250,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195923009?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195560667?pfrom=gsearch','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','PROMO',2604,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000065041071?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195932027?pfrom=gsearch','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195924005?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195983021?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000195961001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000195983255?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',3500,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196056001?pfrom=gsearch','won'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000107431129?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196145001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','NON MENTIONNÉ',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196141005','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',2095,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196195001?pfrom=gsearch','won'),
('2026-01-01','Guillaume','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196278003','active'),
('2026-01-01','Morgane','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196278018','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196317001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196294017?pfrom=gsearch','active'),
('2026-01-01','Paul','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000151237574?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000196366214?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',1659.96,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196496001','won'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196549001?pfrom=gsearch','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',2095,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000123358090?pfrom=gsearch','won'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',5985,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196606001?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196595029','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196671001?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000196614300?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196608006?pfrom=gsearch','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000141740322','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196941001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000196970002?pfrom=gsearch','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000051997548','active'),
('2026-01-01','Paul','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196958011?pfrom=gsearch','active'),
('2026-01-01','Morgane','Intérêt par un produit de la boutique','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196977006','active'),
('2026-01-01','Paul','AUTRE (à déterminer dans les notes)','NON MENTIONNÉ',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196977026','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',400,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000024979546','won'),
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',534,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000055733001?pfrom=gsearch','won'),
('2026-01-01','Guillaume','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000007538001','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196939014?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197021001','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197021011','active'),
('2026-01-01','Kim','Client déjà en CRM du passé','DISTRIBUTION PUB',3509.03,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000023885125?pfrom=gsearch','won'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197021021','active'),
('2026-01-01','Sylvain','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000170197013?pfrom=gsearch','active'),
('2026-01-01','Guillaume','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197024174','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197024202','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196982050?pfrom=gsearch','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000005001011','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000197150033?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000196942080?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000197153004?pfrom=gsearch','active'),
('2026-01-01','Morgane','Client déjà en CRM du passé','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000088112001?pfrom=gsearch','active'),
('2026-01-01','Morgane','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197235034','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197262001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197235049','active'),
('2026-01-01','Richard','Client déjà en CRM du passé','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000126051332','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197235123','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197351001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197358011','active'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197361015','active'),
('2026-01-01','Morgane','Site Web / Recherche Google','PROMO',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197476001','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197476011','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',1245,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197506001?pfrom=gsearch','won'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197514001?pfrom=gsearch','active'),
('2026-01-01','Paul','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197524001?pfrom=gsearch','active'),
('2026-01-01','Richard','Site Web / Recherche Google','DISTRIBUTION PUB',2095,'https://crm.zoho.com/crm/org48245615/tab/Accounts/1402586000197834030?pfrom=gsearch','won'),
('2026-01-01','Kim','Site Web / Recherche Google','NUMERIQUE',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197515006?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Site Web / Recherche Google','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197512007?pfrom=gsearch','active'),
('2026-01-01','Richard','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197553001?pfrom=gsearch','active'),
('2026-01-01','Sylvain','Meta Ads','DISTRIBUTION PUB',0,'https://crm.zoho.com/crm/org48245615/tab/Leads/1402586000197555001?pfrom=gsearch','active');

-- NOTE: The February–May 2026 data is not included in the CSV shared.
-- Add those months by repeating the same INSERT pattern with the corresponding dates:
--   February 2026 → lead_date = '2026-02-01'
--   March 2026    → lead_date = '2026-03-01'
--   April 2026    → lead_date = '2026-04-01'
--   May 2026      → lead_date = '2026-05-01'
