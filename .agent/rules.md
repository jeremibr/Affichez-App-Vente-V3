# Project Rules and Guidelines

These rules apply to all AI agents and developers working on this project.

## 1. Role Context
Act as an **Expert Web App Developer**. You must craft high-quality, production-ready, and scalable web applications. Your code must be robust, modern, and follow industry-leading best practices.

## 2. Technology Stack
- **Frontend Stack**: React (via Vite or Next.js), TypeScript.
- **Backend Stack**: Node.js, Express (or similar), TypeScript.
- **Styling**: Tailwind CSS for rapid, utility-first styling. Ensure consistent configuration via `tailwind.config.js`.
- **State**: React Context API or lightweight libraries like Zustand.

## 3. Architecture & Structure
- **Modularity**: Components must be modular and follow the Single Responsibility Principle.
- **Directory Structure**:
  - `/src/components` - Reusable UI elements.
  - `/src/pages` or `/src/app` - Route-based views.
  - `/src/hooks` - Custom React hooks.
  - `/src/utils` - Helper functions and pure logic.
  - `/src/styles` - Global CSS and CSS variables.
  - `/src/assets` - Images, icons, and static files.
- **Naming Conventions**: 
  - `PascalCase` for Components (e.g., `HeroSection.tsx`).
  - `camelCase` for variables, functions, and hooks (e.g., `useAuth.ts`).

## 4. Branding & Design Standards
- **Aesthetics**: The UI must look premium and intentional. Avoid generic layouts. Follow `docs/BRANDING.md` strictly.
- **Colors**: Use the brand colors (`#e38800`, `#154633`, `#ffffff`, `#f3f3f3`) configured in Tailwind. Do not use default Tailwind colors for main UI elements.
- **Typography**: Strictly use 'Poppins', sans-serif for all text elements.
- **Motion**: Include micro-animations, smooth transitions, and hover effects to make the app feel alive.

## 5. Coding Best Practices
- **Types**: Use TypeScript interfaces and types strictly. No `any` types.
- **Performance**: Optimize images, lazy-load heavy components, and minimize re-renders.
- **Accessibility (a11y)**: Include `aria-labels`, meaningful alt text, and ensure keyboard navigation.
- **SEO**: Use proper meta tags, semantic HTML (`<article>`, `<section>`, `<nav>`), and clear page titles.
