# Affichez branding kit (2026)

Everything needed to put the **affichez.ca** brand into an application: the logo and
icon files, the design tokens, and the guide that says how to use them.

Copy this whole folder into a project (repo root, or `docs/branding/`, or `public/` —
wherever the project keeps shared references) and point people and agents at
`brand-guide.md`.

---

## What's in here

```
branding/
├── README.md              you are here — install steps
├── CLAUDE.md              drop-in instructions for Claude Code / AI agents
├── brand-guide.md         THE GUIDE. Colour, type, shape, components, voice.
├── tokens/
│   ├── tokens.css         CSS custom properties — any framework
│   ├── tailwind-v4.css    Tailwind 4 @theme + base layer + helper classes
│   └── tokens.json        machine-readable mirror (design tools, native, email)
├── assets/
│   ├── logo/              wordmark (orange + white), mark, untouched site original
│   ├── icons/             favicon.ico, icon.svg, apple touch icon, PNG sizes
│   └── social/            OpenGraph card
└── reference/
    ├── Logo.tsx           React/Next wordmark component
    ├── Accented.tsx       renders the *marked* serif accent word
    └── Button.tsx         the brand button, all six variants
```

## Install it

**1. Copy the folder in.** Everything is self-contained; nothing imports from outside it.

**2. Fonts — Inter + Inria Serif italic.** The tokens expect two CSS variables,
`--font-inter` and `--font-inria-serif`. Both faces are on Google Fonts.
`brand-guide.md` §3 has the `next/font` snippet and the plain `<link>` version. Until
you wire them up the fallback stacks keep everything readable, so this can be step two
rather than a blocker.

**3. Styles.** In a Tailwind 4 app, your entry stylesheet becomes:

```css
@import "tailwindcss";
@import "./branding/tokens/tokens.css";
@import "./branding/tokens/tailwind-v4.css";
```

Anything else: import `tokens/tokens.css` and use the custom properties directly.
`tailwind-v4.css` is the only Tailwind-specific file — skip it and read §3–§5 of the
guide for the type scale and the `.eyebrow` / `.accent-serif` / `.label-caps` helpers.

**4. Assets.** Put `assets/logo/*` somewhere public (e.g. `public/brand/`) and update
the paths at the top of `reference/Logo.tsx`. For a Next.js App Router app, drop
`assets/icons/icon.svg`, `favicon.ico` and `apple-icon-180.png` (renamed
`apple-icon.png`) into `src/app/` and the framework wires up the tab and home-screen
icons for you.

**5. Components.** `reference/` is React + Tailwind. `Accented.tsx` is dependency-free.
`Logo.tsx` wants `next/image` and a `cn()` helper. `Button.tsx` wants
`@radix-ui/react-slot`, `class-variance-authority`, `cn()`, and a `Spinner` of your own.
In a non-React app, read them as a spec — the guide describes every variant in words.

## Check it worked

- A heading computes to **Inter 600, black**, and an `<em class="accent-serif">`
  computes to **Inria Serif italic 400** (not a synthesised italic).
- A primary button is **`#F5570E`, white text, 10px radius, 40px tall**.
- `rgb(21, 70, 51)` — the retired deep green — appears **nowhere**.
- Nothing is a pill except chips, tags, avatars and badges.

---

## Keeping it honest

The brand belongs to the website. If affichez.ca changes, re-derive from the live site
rather than patching a token here and letting the two drift — the verification log at
the end of `brand-guide.md` records exactly how the current values were read
(Elementor kit globals, downloaded assets, computed styles), so the same check can be
run again.

Extracted 2026-09-11. Two owner decisions since then are marked inline in the guide
(white type on orange; black is a band, never a half-screen).
