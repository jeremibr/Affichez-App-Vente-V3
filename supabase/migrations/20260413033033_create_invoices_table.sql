-- invoices table: mirrors sales but for Zoho Books invoices + credit notes
CREATE TYPE invoice_status_enum AS ENUM (
  'sent', 'viewed', 'paid', 'partial', 'overdue', 'void', 'avoir'
);

CREATE TABLE invoices (
  zoho_id               text PRIMARY KEY,
  invoice_number        text,
  client_name           text NOT NULL,
  amount                numeric(12,2) NOT NULL, -- negative for credit notes (avoirs)
  rep_name              text,
  department            text,
  zoho_department_label text,
  office                text CHECK (office IN ('QC', 'MTL')),
  invoice_date          date,
  status                invoice_status_enum NOT NULL DEFAULT 'sent',
  is_avoir              boolean NOT NULL DEFAULT false,
  synced_at             timestamptz DEFAULT now()
);

CREATE INDEX ON invoices(invoice_date);
CREATE INDEX ON invoices(rep_name);
CREATE INDEX ON invoices(office);
CREATE INDEX ON invoices(status);
