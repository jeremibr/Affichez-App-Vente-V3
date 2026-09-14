# Affichez brand — instructions for Claude Code

This folder is the brand for **affichez.ca**. Read `brand-guide.md` **before building or
restyling any UI** in this project. Tokens live in `tokens/`; logo and icon files live
in `assets/`; `reference/` holds working React implementations.

> Copy the section below into the project's own root `CLAUDE.md` (or `AGENTS.md`) so it
> is loaded on every session, and adjust the path to this folder.

---

## Brand (2026 — affichez.ca)

Read `branding/brand-guide.md` before building or restyling any UI. The essentials:

- **Orange `#F5570E`** = action (primary button, links, active accents, logo).
  **Black** = headings and identity text. Type on an orange fill is **white**.
  The retired 2025 brand — deep green `#154633`, Poppins, the swoosh logo — must not
  appear anywhere.
- **Inter** everywhere, headings **600** (never 700). One accent word per display
  heading in **Inria Serif italic**: write `*word*` in the copy and render with
  `<Accented>`.
- Buttons and inputs are **10px radius** (`rounded-md`), **never pills**. Pills are for
  chips, tags, avatars and badges only.
- Colour bands (`bg-sand`, `bg-stone`, `bg-mint`, `bg-lavender`, `bg-black`,
  `bg-primary`) mark big moments, full width — most of a page stays white. `text-lime`
  only on black. Black is a band, never a half-screen. `rounded-signature` is the site's
  135px corner, one per element.
- Status colours (critical crimson / warn amber / good green) are **not** brand colours
  — pick a `--tone-*`, never a hex, and always pair the colour with a word.
- Logo only through the real files in `branding/assets/logo/`. **No hex values in
  component code** — everything comes from `branding/tokens/tokens.css`.
- No gradients, glows, decorative emoji, or icon-in-a-rounded-square clichés. The brand
  is flat colour, real photography, and type.

---

## When you're asked to build something new

1. **Check the guide first.** Colour, type, radius, button variant and spacing decisions
   are already made — §2 through §5. Don't invent a second answer.
2. **Reach for a token, then a utility, then — only if neither exists — add a token.**
   A hex in a component is a bug.
3. **Ask what the moment is worth.** A colour band is for a genuine section opener or
   hero. A screen full of bands is noise.
4. **One orange thing per screen.** If two elements are both orange, one of them is
   wrong.
5. **Don't copy patterns from the guide's examples blindly** — they describe the brand,
   not this app's information architecture.
