# Branding Guidelines
This document outlines the strict branding rules for the application. Any UI component, page, or layout created for this project MUST adhere to these guidelines to ensure a consistent, premium user experience.

## 1. Color Palette
The application uses a specific set of colors assigned to variables. These hex codes must be configured in `tailwind.config.js` and used consistently.

**Primary Colors:**
- **Main (Brand Default)**: `#e38800` (Orange)
  - *Usage*: CTA Buttons, active states, primary brand highlights.
- **Contrast Dark**: `#154633` (Dark Green)
  - *Usage*: Headers, footers, primary text on light backgrounds, high-contrast UI elements.

**Neutral Colors:**
- **White**: `#ffffff`
  - *Usage*: Main background for content areas, cards, text on dark backgrounds.
- **Gray**: `#f3f3f3`
  - *Usage*: Subtle backgrounds, borders, off-white surface layers, inactive states.

## 2. Typography
**Primary Font Family:** `Poppins`, sans-serif
- *Usage*: All headings (`h1` to `h6`), body text, buttons, and navigation links.
- *Implementation*: Ensure the font is imported (e.g., via Google Fonts) and set as the default sans family in `tailwind.config.js` (`fontFamily: { sans: ['Poppins', 'sans-serif'] }`).

## 3. Logos
There are two primary logo formats uploaded for this project. Use them according to available screen space and context.
- **Long Form Logo**: The primary logo. Used in the main navigation bar (desktop), large footers, and spacious areas.
- **Square Logo**: The condensed mark. Used in the mobile navigation bar, browser favicons, avatars, and tight UI spaces.

**Logo Rules:**
- Avoid altering the aspect ratio, colors, or adding unauthorized drop shadows.
- Ensure proper contrast when placing logos over colored backgrounds (use a white or transparent version if appropriate).

## 4. UI Vibe & Aesthetic Requirements
- Ensure contrast ratios between text and backgrounds are accessible.
- Avoid using default Tailwind colors (e.g., `text-blue-500`) unless mapping them directly to our custom palette is impossible or inappropriate.
- Strive for a clean, generous use of whitespace. The design should feel intentional, readable, and modern.
