-- Publicité, organic view: follow the relabelling of the two organic sources.
--
-- Two values of the Zoho Global Set "Origine" were relabelled:
--   "Publicité/Recherche Google" → "Google Organique"
--   "Facebook"                   → "Meta Organique"
--
-- Zoho keeps the old stored value and changes only the label, but its API
-- returns the label, so the syncs now write the new words. The organic map
-- names its sources literally and has to follow, otherwise the organic view
-- finds no account at all.
--
-- A relabel does not modify the records, so rows already in the mirror keep
-- the old word until a full walk rewrites them (scripts/zoho-crm-full-sync.sh).
-- Run that walk together with this migration: between the two, the organic
-- view counts only the rows that carry the spelling it is looking for.
--
-- The paid side is unchanged. No SET search_path: SECURITY INVOKER, inlined by
-- the planner (CLAUDE.md, performance rule 1). Grants survive CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.ad_channel_source_map(p_organic BOOLEAN DEFAULT false)
RETURNS TABLE (source_value TEXT, channel TEXT)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT v.source_value, v.channel
  FROM (VALUES
    ('Google Ads',       'google', false),
    ('Meta Ads',         'meta',   false),
    ('Google Organique', 'google', true),
    ('Meta Organique',   'meta',   true)
  ) AS v(source_value, channel, organic)
  WHERE v.organic = COALESCE(p_organic, false);
$$;
