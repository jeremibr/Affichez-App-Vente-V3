# Project Architecture & Style Guide

This document defines the structural and visual rules for building the web application.

## Directory Structure
```
/src
  /assets        # Media (images, videos, fonts)
  /components    # Reusable UI building blocks (Buttons, Cards, Modals)
  /features      # Domain-specific modules (Auth, Dashboard)
  /hooks         # Shared React hooks
  /pages         # Page-level components
  /services      # API calls and external integrations
  /styles        # Global CSS variables and resets
  /utils         # Pure utility functions
```

## Styling & Theming
We use purely Vanilla CSS with CSS Variables for max control and a premium feel.

### Example `index.css` structure:
```css
:root {
  --font-primary: 'Outfit', sans-serif;
  
  /* Colors */
  --bg-base: hsl(220, 20%, 97%);
  --bg-surface: hsl(0, 0%, 100%);
  --text-primary: hsl(220, 30%, 15%);
  --accent-primary: hsl(250, 70%, 50%);
  
  /* Shadows & Radii */
  --radius-sm: 4px;
  --radius-md: 8px;
  --shadow-subtle: 0 4px 12px rgba(0,0,0,0.05);
}

* {
  box-sizing: border-box;
}

body {
  font-family: var(--font-primary);
  background: var(--bg-base);
  color: var(--text-primary);
  margin: 0;
  -webkit-font-smoothing: antialiased;
}
```

## Developer Workflow
1. **Plan**: Understand requirements and identify necessary states.
2. **Build Foundations**: Add CSS variables if new colors/spacing are needed.
3. **Componentize**: Create isolated, dumb components first.
4. **Assemble**: Group components in `/pages` or `/features`.
5. **Animate**: Add micro-interactions (hover, focus, entry animations).
