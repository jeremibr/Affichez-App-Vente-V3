# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Affichez-App-Vente** is an internal sales performance dashboard for Affichez, a Quebec-based advertising company. It visualizes sales data (revenue, deals, reps, departments) from a Supabase backend. The frontend is a React + TypeScript + Vite SPA inside the `frontend/` directory.

There is no backend in this repo — all data is read directly from Supabase via `@supabase/supabase-js`, using PostgreSQL RPC functions and direct table queries. Real-time updates are handled via Supabase Realtime channels subscribed to the `sales` table.

## Development Commands

```bash
cd frontend

# Install dependencies
npm install

# Start development server (port 5173)
npm run dev

# Type-check and build for production
npm run build

# Lint
npm run lint

# Preview production build
npm run preview
```

## Environment Variables

Create `frontend/.env`:
```bash
VITE_SUPABASE_URL=       # Supabase project URL
VITE_SUPABASE_ANON_KEY=  # Supabase anonymous key
```

The app throws at startup if either variable is missing (see `src/lib/supabase.ts`).

## Architecture

### Data Layer
All data flows through `src/lib/supabase.ts` (the singleton Supabase client). Pages call either:
- `supabase.rpc('function_name', params)` — for analytics (KPIs, summaries, leaderboards, YoY)
- `supabase.from('table').select(...)` — for CRUD in Settings (reps, objectives, quarters, webhook_log)

There is no service layer abstraction; Supabase calls are made directly inside page components using `useCallback`-wrapped async functions. Real-time subscriptions (Supabase Realtime) are set up in `useEffect` and cleaned up on unmount.

### Pages and Routes

| Route | Page | Purpose |
|---|---|---|
| `/` | `Dashboard` | YTD KPIs, rep leaderboard, top clients, monthly targets |
| `/weekly` | `WeeklyDetail` | Week-by-week sales breakdown (pivot + line items) |
| `/quarterly` | `QuarterlyAverages` | YoY quarterly average deal size per rep |
| `/settings` | `Settings` | Manage reps, monthly objectives, fiscal quarters, webhook logs |

All routes are children of `Layout`, which provides the sidebar navigation.

### Key Shared Abstractions

- **`src/lib/utils.ts`**: `cn()` (Tailwind class merger), `formatCurrencyCAD()`, `formatShortDate()`, `formatLongDate()`, `formatPercentage()`
- **`src/lib/constants.ts`**: `DEPARTMENTS`, `MONTHS`, `OFFICES`, `SALE_STATUSES` — used as filter option sources across all pages
- **`src/types/database.ts`**: TypeScript types mirroring Supabase view/RPC return shapes (`SommaireRow`, `ZoneA_SummaryRow`, `ZoneB_DetailRow`, `YoYRow`, etc.)
- **`src/components/FilterBar.tsx`**: `<FilterBar>` / `<FilterGroup>` composable filter bar used on every page
- **`src/components/Select.tsx`**: Reusable styled dropdown with an `accent` variant (brand orange)
- **`src/hooks/useSort.ts`**: Generic column sort hook used in data tables

### Styling

- **Tailwind CSS** with a custom brand palette in `tailwind.config.js`:
  - `brand-main` = `#e38800` (orange) — primary accent, CTA buttons, active nav items
  - `brand-dark` = `#0f172a` — deep dark backgrounds
  - Font: `Inter` (not Poppins as in older docs — the `index.css` imports Inter)
  - Shadows: `shadow-card`, `shadow-card-hover`
- Global utility classes defined in `src/index.css` `@layer components`: `.card`, `.badge`, `.th`, `.td`
- Use `cn()` from `src/lib/utils.ts` for conditional class merging (wraps `clsx` + `tailwind-merge`)

### Branding Rules (from `docs/BRANDING.md` and `tailwind.config.js`)
- **Never** use default Tailwind color names (e.g., `text-blue-500`) for primary UI — use brand tokens
- `brand-main` (#e38800) for CTAs, active states, highlights
- All UI must feel premium: generous whitespace, smooth transitions, micro-interactions
- Long logo (`/logo-long.png`) in sidebar desktop; square logo (`/logo-square.jpg`) for mobile/favicons

### Component Patterns

Pages are self-contained — state, data fetching, filters, and rendering are colocated. Feature-specific sub-components live in `src/components/{feature}/` (e.g., `weekly/ZoneAPivotTable`, `dashboard/SommaireTable`).

The `Settings` page uses an internal tab system (`reps | objectives | quarters | logs`) with each section as a separate function component defined in the same file.

### No `any` Types
TypeScript's `no-any` rule is enforced. All Supabase RPC results must be typed against `src/types/database.ts`. Extend the types file when new RPC functions or views are added.
