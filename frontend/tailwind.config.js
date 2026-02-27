/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          // New: clean dark/light palette with orange accent retained
          main: '#e38800',
          dark: '#0f172a',   // slate-900 – deep modern dark
          mid: '#334155',    // slate-700
          muted: '#94a3b8',  // slate-400
          subtle: '#f1f5f9', // slate-100
          white: '#ffffff',
          gray: '#f8fafc',   // slate-50
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-hover': '0 4px 12px 0 rgb(0 0 0 / 0.08)',
      }
    },
  },
  plugins: [],
}
