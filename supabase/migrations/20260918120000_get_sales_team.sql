-- The sales team's names, readable by every signed-in user.
--
-- The app decides who is "Interne" by comparing each rep name against the team
-- (see frontend/src/lib/repTeam.ts). It used to read the team straight from
-- allowed_users, whose RLS lets a member see only their own row - so for a rep
-- the team was themselves alone, and every colleague on the dashboards
-- collapsed into one Interne line. Admins, who can read every row, never saw it.
--
-- SECURITY DEFINER so it can read past that policy, and it returns rep_name and
-- nothing else: emails and roles stay behind RLS. The names are not a secret -
-- every leaderboard RPC already returns them to the same callers.
--
-- The internal-name exclusion is deliberately NOT applied here. It lives in one
-- place, the client's INTERNAL_REP_NAMES, so this function and that list can
-- never disagree about who is internal.

CREATE OR REPLACE FUNCTION public.get_sales_team()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT au.rep_name
    FROM public.allowed_users au
   WHERE au.rep_name IS NOT NULL
     AND btrim(au.rep_name) <> ''
   ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.get_sales_team() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_sales_team() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sales_team() TO authenticated;
