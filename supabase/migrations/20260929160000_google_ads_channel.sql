-- Publicité: the Google channel counts only accounts tagged "Google Ads".
--
-- WHY. "Publicité/Recherche Google" has always meant two things at once: a
-- click on a Google ad and an organic Google search. The Zoho source picklist
-- cleanup also merges the old "Internet" value (3,336 accounts) into it, so it
-- becomes a general "found us on the web" bucket and cannot stand in for paid
-- traffic. "Google Ads" is the paid-only value of the shared Origine picklist
-- (Leads + Comptes), applied to new clients only.
--
-- CONSEQUENCE. Months before the first "Google Ads" account report no Google
-- accounts and a NULL return. get_ad_performance / get_ad_monthly already
-- return source_first_used and NULL roas/net for that case, and the page says
-- so on screen. Meta is unchanged.
--
-- No SET search_path: SECURITY INVOKER, inlined into the callers' joins (see
-- the performance rules in CLAUDE.md). Grants survive CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.ad_channel_source_map()
RETURNS TABLE (source_value TEXT, channel TEXT)
LANGUAGE sql IMMUTABLE
AS $$
  VALUES ('Google Ads', 'google'),
         ('Meta Ads',   'meta');
$$;
