# Affichez reps kit

The nine Affichez people a client-facing document can be signed by — **names, contact
details and portraits** — packaged so another internal app can use them without
talking to the audit product's database.

Copy the whole folder into a project (`public/team/`, `src/data/`, wherever shared
references live). Everything is self-contained; nothing imports from outside it.

---

## What's in here

```
team-reps/
├── README.md        you are here
├── reps.json        the roster, machine-readable (any language)
├── reps.ts          the same roster as a typed TS constant + helpers
├── preview.html     open it in a browser to see all nine
└── photos/
    ├── webp/        768×768 originals — smallest, use these on the web
    ├── png/         768×768 PNG copies — for anything that can't read WebP
    └── svg/         768×768 .svg files, the photo embedded inside
```

Portrait filenames are the person's `slug`, so `reps.json` → `photos/<format>/<slug>.<ext>`
needs no lookup table.

## The nine

| Name | Email | Phone | Slug |
|---|---|---|---|
| Dominic Letendre | dletendre@affichez.ca | 418 265-6248 | `dominic-letendre` |
| Francis Adam | fadam@affichez.ca | 418 655-3212 | `francis-adam` |
| Guillaume Montambeault | gmontambeault@affichez.ca | 581 849-5297 | `guillaume-montambeault` |
| **Kim Foster Cunningham** (default) | kim@affichez.ca | 581 999-6811 | `kim-foster-cunningham` |
| Morgane Owczarzak | morgane@affichez.ca | 450 848-0124 | `morgane-owczarzak` |
| Nadya Rocheleau | nrocheleau@affichez.ca | 450 517-2726 | `nadya-rocheleau` |
| Paul Ayoub | paul@affichez.ca | 450 820-7966 | `paul-ayoub` |
| Richard Courville | rcourville@affichez.ca | 438 526-8527 | `richard-courville` |
| Sylvain Desrosiers | sylvain@affichez.ca | 581 703-6431 | `sylvain-desrosiers` |

Listed alphabetically by first name — the order the audit product's picker uses.
**Kim is the default**: the person a document falls back to when nobody was chosen.
The roster carries no job titles, because the product's table has none.

## About the SVGs

These portraits are **photographs**, so there is no true vector version of them and
there can't be one. What `photos/svg/` gives you is a real, valid `.svg` file for each
person with the photo embedded inside it as a data URI — one self-contained file, no
second request, drop-in anywhere your app expects an `.svg`:

```html
<img src="photos/svg/kim-foster-cunningham.svg" alt="Kim Foster Cunningham" width="160" height="160">
```

Opaque portraits embed a quality-88 JPEG; Morgane's portrait is cut out with a
transparent background, so hers embeds a PNG to keep the alpha. The `<image>` uses the
SVG 2 `href` attribute — fine in every current browser, Inkscape and resvg. If your
renderer is old enough to need `xlink:href`, use the WebP or PNG file instead.

**If you just need a picture, use `photos/webp/` (or `photos/png/`).** They are 4–10×
smaller than the SVG wrapper and always the better choice when the format is up to you.

## Using it

**JSON, any stack**

```js
import roster from './team-reps/reps.json' with { type: 'json' };
const kim = roster.representatives.find((r) => r.isDefault);
// kim.fullName, kim.email, kim.phoneE164, kim.photo.webp
```

**TypeScript**

```ts
import { REPRESENTATIVES, DEFAULT_REPRESENTATIVE, getRepresentative } from './team-reps/reps';
```

Portrait paths in both files are **relative to this folder** (`photos/webp/…`). Prefix
them with wherever you serve the folder from — e.g. `/team/` if it lands in `public/team/`.

**The round portrait**, the way the audit report closes its contact panel: a circle with
a 4px orange ring on white.

```html
<img src="photos/webp/kim-foster-cunningham.webp" alt="Kim Foster Cunningham"
     style="width:11rem;height:11rem;border-radius:9999px;border:4px solid #f5570e;background:#fff;object-fit:cover">
```

Phone numbers link as `tel:` with the `phoneE164` field, never the printed one:
`<a href="tel:+15819996811">581 999-6811</a>`.

## Keeping it current

This is a **snapshot**, taken 2026-09-15 from the audit product's database roster
(`Affichez_Internal_Backend/drizzle/0015_report_representatives.sql`, with the phone
correction from `0016`). Nothing syncs on its own: when someone joins, leaves or
changes number, the product gets a migration and this folder has to be re-copied.

The portraits came from `Affichez_Internal_Frontend/public/team/reps/`, which in turn
came from affichez.ca's own team photos.

## Brand

Names and faces only. For the colours, type and logo that should frame them, use the
sibling **`branding/`** kit — `branding/brand-guide.md`.
