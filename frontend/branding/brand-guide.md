# Affichez — Brand & Design System (2026)

> The brand is **affichez.ca**. Everything below was extracted from the live site on
> **2026-09-11** and verified three ways: the site's Elementor kit globals
> (`elementor-kit-6`: `--e-global-color-*`, `--e-global-typography-*`), its downloaded
> logo and favicon files, and the computed styles of the rendered page.
>
> This guide describes the **brand**, not any one product. Nothing here is specific to
> an internal app — take the tokens, the type, the shapes and the rules, and build
> whatever the app needs on top of them.
>
> **Retired (2025 brand, never use):** deep green `#154633`, Poppins, the uppercase
> "AFFICHEZ" wordmark with the brush swoosh `#F18C20`, orange-circle heading accents.

---

## 0. Ten rules

1. **Orange `#F5570E` means action** — the logo, the primary button, links, active
   states, the focus ring. It never marks status or severity.
2. **Black `#000000` is the identity colour** — every heading, primary text, and the
   dark bands. Nothing is green except a "success" status.
3. **Inter everywhere.** Headings are **semibold (600)**, never 700. Body is 400.
4. **One serif accent word per display heading**, in *Inria Serif italic*. Never a
   whole sentence, never in body copy, never in small headings.
5. **Controls are 10px-radius rectangles** — buttons, inputs, toggles, tabs. Pills are
   for chips, tags, avatars and status badges only.
6. **Status is separate from the brand**: critical crimson `#D0263F`, needs-work amber
   `#E38800`, good green `#157347`. Pick a tone, never a hex, and always pair colour
   with a word.
7. **Colour bands mark the big moments** — sand, stone, mint, lavender, black, orange —
   the way the site stacks its sections. Most of a page stays white. Lime appears
   **only on black**.
8. **Orange as small text is `#C4460B`.** Raw `#F5570E` is 3.4:1 on white: fine for
   fills, icons and large type, not for small text.
9. **Type on an orange fill is white** — button labels, the wordmark, band copy. Black
   measures higher (6.3:1 vs 3.4:1) but reads as a different system; white is what the
   brand does everywhere. (Owner's decision, 2026-09-14.)
10. **Use the real logo files.** Never redraw it, never recolour it outside its two
    variants, never stand an icon in for it.

---

## 1. Logo

The 2026 wordmark is lowercase **affichez**, with the **z drawn as a square arrow ↗** —
a block with a diagonal cut and a rounded lower-left piece.

| Asset | File | Use |
|---|---|---|
| Wordmark, orange | `assets/logo/affichez-logo.svg` | White, sand and black surfaces |
| Wordmark, white | `assets/logo/affichez-logo-white.svg` | Orange and black surfaces |
| Mark only (the ↗ z) | `assets/logo/affichez-mark.svg` | Where the wordmark can't fit |
| Untouched site original | `assets/logo/affichez-logo-source.svg` | Reference / re-deriving assets |

- The SVGs are the site's own vectors (`/wp-content/uploads/2025/05/logo-affichez.svg`),
  **viewBox 3516.375 × 727.446, ratio ≈ 4.83 : 1**. Set a height and let the width
  follow — never squash it.
- **Clear space:** at least half the logo's height on every side.
- Practical heights: `22` in a dense toolbar, `24` in a sidebar, `28–30` in page chrome
  and on auth screens, `32` on a footer band.
- The white variant is the *same artwork*, not a filter. Don't recolour with CSS.

### App icons — `assets/icons/`

| File | What it is |
|---|---|
| `icon.svg` | Vector tab icon (white mark on an orange rounded square) |
| `favicon.ico` | 16 / 32 / 48 raster bundle |
| `favicon-16.png`, `-32.png`, `-48.png` | The individual sizes |
| `apple-icon-180.png` | iOS home screen, 180×180 |
| `mark-300.png` | 300×300 mark, for anything that wants a plain PNG |
| `favicon-source-300.png` | The site's own `Favicon_Logo-Affichez_Orange` asset |

These are drawn from the same vector as the wordmark, not resampled from a bitmap, so
they stay sharp at 16px. In a Next.js App Router app, drop `icon.svg`, `favicon.ico`
and `apple-icon.png` straight into `src/app/` and the framework wires them up.

### Social — `assets/social/`

`opengraph-affichez-2026.png` is the site's own OG card (white wordmark on orange).
Use it as the default `og:image` unless the app has a better page-specific one.

---

## 2. Colour

### 2.1 Palette (from the site's Elementor globals)

| Token | Hex | Site global | Used for |
|---|---|---|---|
| `--color-primary` | `#F5570E` | `primary` | Logo, primary buttons, links, active accents, focus |
| `--color-primary-hover` | `#FF712F` | `accent` | Button hover — the site's own |
| `--color-primary-deep` | `#D94C0C` | derived | Pressed fill |
| `--color-primary-press` | `#C4460B` | derived (AA) | Orange **text** on white (5:1) |
| `--color-primary-subdued` / `-wash` | `#FDE3D6` / `#FEF3ED` | derived | Selected tint / large tinted blocks |
| `--color-ink` | `#000000` | `text` | Headings, primary text |
| `--color-black` | `#000000` | — | Dark bands (site: about section, service marquee) |
| `--color-sand` | `#F3F3F1` | `28c62b2` | Hero and services band, page ground |
| `--color-stone` | `#E7E6E2` | `7d607b6` | News band, hairline rules |
| `--color-lavender` | `#C9B3F9` | `4d3eae4` | Stats band |
| `--color-mint` | `#CDE6D8` | `95f6658` | Testimonials band |
| `--color-lime` | `#CCD602` | `c1fb0ad` | The "+" between services, on black |
| `--color-amber` | `#E38800` | `secondary` | The site's secondary orange |
| white | `#FFFFFF` | `d8de3ff` | Cards, sheets, body |

Derived neutrals: `--color-ink-secondary #3D3D3B` (body copy), `--color-ink-mute
#6B6B68` (captions — AA on white *and* on sand), `--color-hairline #E7E6E2`,
`--color-hairline-strong #D4D3CE`, `--color-hairline-input #DDDDDD` (the site's own
form-field border).

### 2.2 Status tones — deliberately NOT brand colours

| Tone | Mark | Text (AA) | Soft fill |
|---|---|---|---|
| critical | `#D0263F` | `#B01E34` | `#FCE9EC` |
| warn ("needs work") | `#E38800` | `#9A5B00` | `#FDF0DC` |
| good | `#157347` | `#10603B` | `#E6F3EC` |
| neutral | `#D4D3CE` | `#6B6B68` | `#F3F3F1` |

Three values per tone: the solid mark, the darkened text version, and a tint for filled
blocks. Two rules: components pick a **tone**, never a hex; and a status is carried by
**word + colour + shape**, so it survives greyscale printing and colour blindness.

### 2.3 Contrast cheatsheet

| Pair | Ratio | Verdict |
|---|---|---|
| `#F5570E` on white | 3.4:1 | Fills, icons, and text ≥ 24px / 18.7px bold only |
| `#C4460B` on white | 5.0:1 | Orange text — use this one |
| White on `#F5570E` | 3.4:1 | Everything on orange: buttons, logo, band copy (brand decision, below AA for small text) |
| Black on `#F5570E` | 6.3:1 | Measures better, but off-brand — don't reach for it |
| Black on lavender / mint / sand / stone | 10:1+ | Always fine |
| `#C4460B` on lavender | 2.7:1 | **Fails** — on a colour band, accents turn ink |
| Lime on black | 13:1 | Fine. Lime on white is invisible — never |

### 2.4 Using the bands

- A band is **full width**, edge to edge, marking a genuine moment: a hero, a section
  opener, a stats strip, a footer. Most of a page stays white.
- **Black is a band, never a half-screen.** The site only runs black edge to edge
  between lighter sections. A black left half beside a white right half — the tempting
  split-screen sign-in — reads as a hard seam, not as the brand. Use sand on one side
  and white on the other, separated by a `--color-hairline` rule.
- Don't put two bands of similar weight next to each other (sand then stone reads as a
  step; sand then sand reads as a mistake).
- On a band, orange accents lose contrast — turn them ink.

---

## 3. Typography

| Role | Face | Weight | Notes |
|---|---|---|---|
| Everything (UI, body, headings) | **Inter** (variable) | 400 / 500 / 600 | `--font-inter` |
| The accent word | **Inria Serif** *italic* | 400 | `--font-inria-serif`, class `.accent-serif` |

On the site: H1 Inter 600 at 55px, H2 600 at 55px, H3 600 at 32/35px, hero 700 at
96/85px, body 400 at 18/28px. Headings are **black and sentence case**.

The site also declares *Inria Sans italic* and **Poppins 500** (only for its footer
column headings). Neither belongs in an app.

### Loading the fonts

Both are Google Fonts. In Next.js:

```ts
import { Inter, Inria_Serif } from "next/font/google";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const inriaSerif = Inria_Serif({
  variable: "--font-inria-serif",
  subsets: ["latin"],
  weight: "400",
  style: "italic",   // only the italic cut is ever used
  display: "swap",
});

// <html className={`${inter.variable} ${inriaSerif.variable}`}>
```

Anywhere else, link them and set the two custom properties by hand:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=Inria+Serif:ital,wght@1,400&display=swap" rel="stylesheet" />
<style>
  :root { --font-inter: "Inter"; --font-inria-serif: "Inria Serif"; }
</style>
```

> If you ever inline a stylesheet or build a standalone HTML file, resolve each
> `@font-face` `url()` against **its own stylesheet's** URL, not the page's. Next's font
> CSS uses `url("../media/*.woff2")`, which silently 404s if resolved against the page
> and drops you back to Arial.

### The accent word

One word of a display heading, set in Inria Serif italic — the way the site writes
"Agence *marketing* 360". Mark it with asterisks in your copy and render it through the
`<Accented>` component (`reference/Accented.tsx`):

```tsx
// copy:  "Your *online presence* audit."
// copy:  "Votre audit de *présence en ligne*."
<h2 className="text-4xl"><Accented text={copy.headline} /></h2>
```

`.accent-serif` pins the weight to 400 and turns font synthesis off, so a 600 heading
never fake-bolds the serif. Rules: **one per heading**, display sizes only, never in
body copy, and each language picks its own word.

### Eyebrows

The small uppercase kicker above a title ("ILS NOUS FONT CONFIANCE"): Inter 600,
uppercase, tracked `0.12em`, black. Class `.eyebrow`. **No dashes** around it — that
framing belonged to the retired brand. On a dark band, recolour with a utility.

### Type scale

One modular ramp, rem against a 16px root — never inline a px size:

`2xs 11` · `xs 12` · `sm 13` · `base 14` · `md 15` (body) · `lg 17` · `xl 20` ·
`2xl 24` · `3xl 30` · `4xl 40` · `5xl 52` · `6xl 76`

`2xs`/`xs` are for eyebrows, table furniture and legal lines. Body is `sm` (dense
tables) or `md` (prose). `xl` and up are headings. `6xl` is one hero figure per app, at
most.

---

## 4. Shape, elevation, layout

| Radius | Value | Where |
|---|---|---|
| `sm` | 6px | Inner thumbs, small toggles |
| `md` | **10px** | **Every button and input** — the site's `.elementor-button` and form fields |
| `lg` | 12px | Menus, large search fields |
| `xl` | 16px | Cards, sheets |
| `2xl` | 20px | Large cards |
| `3xl` | 32px | Photos and feature panels (the site's image cards) |
| `signature` | **135px** | The signature corner: **one** sweeping corner on a band or photo (site: testimonials band, service images) |
| `full` | pill | Chips, tags, avatars, status badges only |

- **Elevation is quiet and neutral.** The site is flat — colour bands, not cards. Our
  shadows are `rgba(0,0,0,…)` and never tinted with the brand orange.
- **The floating header**: the site's header is a white bar at ~81% opacity with a ~7px
  radius, inset from the page edges over the hero. Copy it for a sticky app toolbar:
  a sticky wrapper with `rounded-md bg-white/85 shadow-card backdrop-blur-md` inside.
- **Surfaces**: white cards on a **sand** page ground; app chrome (sidebar, header) is
  white, like the site's header.

---

## 5. Components

### Buttons

| Variant | Look | When |
|---|---|---|
| `primary` | Orange fill, white Inter 600; hover `#FF712F`, pressed `#D94C0C` | The one main action on a screen |
| `secondary` | White, black text, `ink/25` border → black border + sand fill on hover | Everything beside a primary |
| `dark` | Black fill, white text | Emphasis on sand or lavender bands |
| `ghost` | Transparent, sand on hover | Toolbars, sidebars |
| `link` | Ink text, underline on hover | Inline text actions |
| `danger` | Crimson fill | Destructive confirmations |

Heights: `sm` 36px · `md` 40px · `lg` 48px (the site's own button height). All
`rounded-md`, all Inter **600**. A link out to affichez.ca ends with an `ArrowUpRight`
icon, echoing the logo's arrow. Reference implementation: `reference/Button.tsx`.

### Links

Call-to-action text links are **orange-press, semibold**, underlined on hover — the
site's "Rencontrer l'agence →".

### Inputs

`rounded-md`, 1px `#DDDDDD` border, white fill, ink text, muted placeholder. Focus:
orange border plus a 2px `--color-ring` ring. Invalid: crimson border and ring.
Height 40px to match a `md` button.

### Toggles and tabs

A toggle marks **state**, not action, so its active option is a **black** fill with
white text — not orange. Segmented tabs: sand track (`rounded-md`), white thumb
(`rounded-sm`).

### Chips and badges

Pills are allowed here and nowhere else. The site's service marquee gives the signature
version: a **black pill** with a **lime "+"** before white semibold text.

### Cards

White, `rounded-xl`, `shadow-card` (a 1px hairline plus a whisper of shadow). On a
colour band, a white card is the way content sits *on* the band.

---

## 6. Voice

- **Slogan:** *Imaginer. Réaliser. Propulser.*
- **Positioning:** "Affichez : agence marketing 360 et numérique au Québec".
- **Tone:** confident, plain, second person (*vous*), sentence-case headings.
- **Offices** (site footer, 2026-09): Québec, Laval, North Hatley.
- The site's proof points ("+13 ans d'expérience", "+1 745 clients satisfaits",
  "+26 spécialistes" as of 2026-09-11) change over time — never hardcode them.
- **Bilingual by default.** Affichez is a Québec agency: French is the primary language
  and English is a peer, not an afterthought. Keep copy in a dictionary per language,
  and let each language choose its own accent word.

---

## 7. Do / Don't

**Do**
- Reach for a token first; add a token before inlining a value.
- Keep orange for the single most important action on a screen.
- Use a colour band for a genuinely big moment, and leave most sections white.
- Keep headings sentence case with at most one accent word.
- Pair every status colour with a word.

**Don't**
- Don't use the retired deep green `#154633`, Poppins, the swoosh logo, or the
  orange-circle heading accent.
- Don't use `#E38800` as a *brand* orange — it is the amber status tone.
- Don't make buttons or inputs into pills.
- Don't put lime on anything but black, or small orange text on a colour band.
- Don't use decorative emoji, gradients or glows. The site is flat colour, real
  photography and type.
- Don't set a status in brand orange.
- Don't write a hex in a component.

---

## 8. Verification log (2026-09-11)

- **Colours** read from the live `--e-global-color-*` custom properties and confirmed
  against the rendered page. Orange `rgb(245,87,14)` was the most-used colour after
  black; the backgrounds actually rendered were `#F5570E`, white, `#F3F3F1`, black,
  `#C9B3F9`, `#CDE6D8`.
- **Buttons**: the kit's `.elementor-button` = `#F5570E`, Inter 600 16px/28px, white
  text, radius 10px, padding 10px 20px, hover `#FF712F`.
- **Inputs**: the kit's field style = 1px `#DDDDDD`, radius 10px, Inter 18px/28px.
- **Fonts**: the rendered text was Inter 600/500/400/700 plus Inria Serif 400 italic.
  Poppins appeared only in the footer column headings.
- **Logo and icons** downloaded from `wp-content/uploads`: the orange `#f5570e` SVG, the
  white SVG, the orange favicon PNGs, and the OG card
  `2026/08/Opengraph_Affichez2026.png`.
