/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens (see src/index.css). Use these, never raw grays/blues.
        canvas: v("canvas"),
        surface: v("surface"),
        fill: v("fill"),
        line: v("line"),
        ink: { DEFAULT: v("ink"), 2: v("ink-2"), 3: v("ink-3"), 4: v("ink-4") },
        accent: { DEFAULT: v("accent"), soft: v("accent-soft") },
        danger: { DEFAULT: v("danger"), soft: v("danger-soft") },
        warn: { DEFAULT: v("warn"), soft: v("warn-soft") },
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") },
        max: "#2563eb",
        theo: "#16a34a",
        ava: "#db2777",
      },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 1px 1px rgb(0 0 0 / 0.02)",
        sheet: "0 -8px 40px rgb(0 0 0 / 0.18)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.375rem",
      },
    },
  },
  plugins: [],
};
