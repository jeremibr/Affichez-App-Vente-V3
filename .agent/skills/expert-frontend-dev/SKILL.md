---
name: expert-frontend-dev
description: "Specialized skill for creating state-of-the-art React and Tailwind CSS frontend interfaces. Focuses on planning, accessibility, performance, and best practices."
---

# Expert Frontend Developer Skill

This skill enforces the mindset and rules required to build high-quality, scalable frontend applications using React and Tailwind CSS.

## 1. Plan Mode First
- Before generated any complex UI, analyze the requirements, define the component hierarchy, and clearly state assumptions.
- Identify reusable elements (Buttons, Inputs, Cards) and plan their prop structures.

## 2. React Best Practices
- **Component Design**: Favor small, pure, and single-responsibility functional components.
- **Hooks**: Isolate side effects and data fetching into custom hooks.
- **State Management**: Use localized state where possible. Lift state up or use Context/Zustand only when necessary to avoid prop-drilling.
- **Performance**: Use `React.memo`, `useMemo`, and `useCallback` appropriately to prevent unnecessary re-renders. 

## 3. Tailwind CSS & Styling Guidelines
- **Utility-First**: Use Tailwind CSS strictly for styling. Configure `tailwind.config.js` with semantic brand colors and spacing.
- **Responsive Design**: Build mobile-first. Ensure all screens look perfect across breakpoints (`sm`, `md`, `lg`, `xl`).
- **Component Extraction**: For highly repeated utility combinations (e.g., standard buttons), use `@apply` in a CSS file or extract into a React component. 

## 4. UI/UX & Accessibility (a11y)
- Deliver premium, high-craft interfaces containing micro-interactions (e.g., `hover:scale-105`, `transition-all`, `duration-300`).
- Ensure semantic HTML (`<main>`, `<section>`, `<nav>`).
- Add appropriate `aria-labels`, `role` attributes, and `alt` tags to all media and interactive elements.
- Verify keyboard navigation visibility (`focus-visible:ring-2`).

## 5. Required Execution Steps
When building a frontend feature:
1. Explain the desired outcome and design briefly.
2. Provide the code for any required custom hooks or utilities.
3. Provide the UI component code utilizing React and Tailwind CSS.
