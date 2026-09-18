import { useRepTeam } from '../lib/repTeam';

/** Rep names from allowed_users, excluding internal sales reps. */
export function useRepList(): string[] {
    return useRepTeam().team;
}
