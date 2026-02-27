# Zoho Books → Supabase Real-Time Sync — Setup Guide

## Architecture

```
Zoho Books (Estimate accepted/declined)
    ↓ Workflow Rule triggers webhook
Supabase Edge Function (zoho-sync)
    ↓ Upsert or Delete
Supabase PostgreSQL (sales table)
    ↓ Views auto-compute
Web App Dashboard (real-time)
```

---

## Step 1: Deploy the Edge Function

### 1.1 Install Supabase CLI (if not already)

```bash
npm install -g supabase
supabase login
```

### 1.2 Initialize and deploy

```bash
# In your project root
supabase init
mkdir -p supabase/functions/zoho-sync
# Copy index.ts into supabase/functions/zoho-sync/index.ts

supabase functions deploy zoho-sync --project-ref YOUR_PROJECT_REF
```

### 1.3 Set environment secrets

```bash
# Generate a random secret for webhook auth
# Use this same value in Zoho's webhook URL as a query param or header
supabase secrets set ZOHO_WEBHOOK_SECRET="your-random-secret-here"
```

The function URL will be:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/zoho-sync
```

---

## Step 2: Find Your Zoho Custom Field API Names

Before configuring webhooks, you need the exact API names of your custom fields.

### Via Zoho Books UI:
1. Go to **Settings → Preferences → Estimates**
2. Click on **Custom Fields**
3. Note the **API Name** of your department field (e.g., `cf_departement`)

### Via API (optional):
```
GET https://www.zohoapis.com/books/v3/estimates?organization_id=YOUR_ORG_ID
```
Look at the `custom_fields` array in any estimate response. The `label` is the display name, the `api_name` is what you need (e.g., `cf_departement`).

Also confirm the **Salesperson** field — it may be `salesperson_name` in the webhook payload.

---

## Step 3: Configure Zoho Books Webhooks

### 3.1 Create the webhook action

1. Go to **Settings → Automation → Workflow Actions → Webhooks**
2. Click **+ New Webhook**
3. Fill in:

| Field | Value |
|-------|-------|
| Name | `Sync Accepted Estimate to Supabase` |
| Module | **Estimates** |
| URL & Method | **POST** `https://YOUR_PROJECT_REF.supabase.co/functions/v1/zoho-sync` |

4. **Headers** — Add:

| Key | Value |
|-----|-------|
| `Content-Type` | `application/json` |
| `x-webhook-secret` | `your-random-secret-here` (same as ZOHO_WEBHOOK_SECRET) |

5. **Entity Parameters** — Select **JSON** format and add these fields:

| Parameter Name | Zoho Field |
|---------------|------------|
| `estimate_id` | Estimate ID |
| `estimate_number` | Estimate Number |
| `status` | Estimate Status |
| `customer_name` | Customer Name |
| `total` | Total |
| `sub_total` | Sub Total |
| `date` | Estimate Date |
| `salesperson_name` | Salesperson Name |
| `cf_d_partement` | YOUR custom field for department |

6. Click **Save**

### 3.2 Create a second webhook for declined (optional but recommended)

Repeat the same process with name `Sync Declined Estimate to Supabase`.
Same URL, same headers, same parameters. The Edge Function reads the `status` field to determine the action.

> **Note:** You can use the SAME webhook for both rules since the status field determines the action.
> But having separate webhooks makes the Zoho workflow logs easier to debug.

---

## Step 4: Create Zoho Books Workflow Rules

### 4.1 Rule: Estimate Accepted

1. Go to **Settings → Automation → Workflow Rules**
2. Click **+ New Workflow Rule**
3. Fill in:

| Field | Value |
|-------|-------|
| Workflow Rule Name | `Push Accepted Estimate to Dashboard` |
| Module | **Estimates** |
| Workflow Type | **Event Based** |
| Execute When | **Created or Edited** |

4. **Filter the Triggers:**
   - Field: `Status`
   - Condition: `is`
   - Value: `Accepted`

5. **Immediate Action:**
   - Type: **Webhook**
   - Select: `Sync Accepted Estimate to Supabase`

6. Click **Save**

### 4.2 Rule: Estimate Declined

Repeat with:

| Field | Value |
|-------|-------|
| Workflow Rule Name | `Remove Declined Estimate from Dashboard` |
| Execute When | **Created or Edited** |
| Filter | Status **is** `Declined` |
| Immediate Action | Webhook: `Sync Declined Estimate to Supabase` |

---

## Step 5: Test the Integration

### 5.1 Test from Zoho Books

1. Create a test estimate in Zoho Books
2. Fill in all fields (client, amount, salesperson, department custom field)
3. Mark it as **Accepted**
4. Check Supabase:
   ```sql
   SELECT * FROM sales ORDER BY created_at DESC LIMIT 5;
   ```
5. Now mark it as **Declined**
6. Verify it was deleted:
   ```sql
   SELECT * FROM sales WHERE zoho_id = 'TEST_ID';
   -- Should return 0 rows
   ```

### 5.2 Check Edge Function logs

```bash
supabase functions logs zoho-sync --project-ref YOUR_PROJECT_REF
```

### 5.3 Check Zoho workflow logs

Go to **Settings → Automation → Workflow Rules → Logs** to see execution history and any failures.

---

## Step 6: Configure Webhook Retry Policy (Recommended)

1. Go to **Settings → Automation → Workflow Logs → Webhooks**
2. Click **Configure Failure Preferences**
3. Set retry attempts (recommended: 3 retries with increasing delay)
4. Enable failure notifications to your email

---

## Field Mapping Reference

This is the complete mapping from Zoho → Edge Function → Supabase:

```
Zoho Books Estimate          Edge Function Variable     Supabase Column
─────────────────────────    ──────────────────────     ─────────────────────
Estimate ID                  estimate_id                zoho_id
Estimate Number              estimate_number            quote_number
Estimate Status              status                     (determines action)
Customer Name                customer_name              client_name
Total (or Sub Total)         total / sub_total          amount
Estimate Date                date                       sale_date
Salesperson Name             salesperson_name            → resolved to rep_id
cf_d_partement (custom)      cf_d_partement             → mapped to department enum
                             (computed)                 week_start
                             (computed)                 week_end
                             (computed)                 month (generated column)
                             (computed)                 year (generated column)
```

---

## Important Notes

### What triggers the webhook
- Manually marking an estimate as Accepted/Declined
- Customer accepting/declining via the client portal
- Status change via Zoho Books API

### What does NOT trigger the webhook
- Bulk-imported estimates (Zoho limitation)
- Estimates created by custom functions from other Zoho apps
- Estimates synced from Zoho Inventory or other Zoho modules

### Custom field API name
The custom field API name for department is `cf_d_partement`. This is already configured in the Edge Function.

### Adding new reps
When a new sales rep joins, add them to both:
1. Zoho Books (as a Salesperson)
2. Supabase `reps` table: `INSERT INTO reps (name, office) VALUES ('New Rep', 'QC');`

The name must match EXACTLY between Zoho and Supabase.

### Adding new departments
If a new department is created:
1. Update the `department_enum` type in Supabase
2. Add the mapping to `department_mappings` table
3. Update the `DEPT_MAP` in the Edge Function
4. Redeploy: `supabase functions deploy zoho-sync`
