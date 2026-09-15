# Source portraits — not served, not bundled

`frontend/public/reps/` holds what the app actually loads: the same nine faces
re-cut square and down to 128x128, which is 23 KB for the set instead of 574 KB.
That is the right size for avatars shown between 20px and 48px, and it is a
**lossy, one-way** transform.

These are the originals it was made from, kept so a future change of size or
shape does not need the `team-reps` kit back. This folder sits outside
`frontend/`, so Vite neither serves nor bundles any of it.

To regenerate: `scratchpad/build_rep_photos.py` (point SRC at this folder).

`reps.json` is the roster the names in `frontend/src/lib/reps.ts` came from —
including emails and phone numbers the dashboard does not use but a future
document-signing feature would.
