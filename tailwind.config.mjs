export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)', alt: 'rgb(var(--c-surface-alt) / <alpha-value>)', raised: 'rgb(var(--c-raised) / <alpha-value>)' },
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        ink: { DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)', muted: 'rgb(var(--c-ink-muted) / <alpha-value>)' },
        line: 'rgb(var(--c-line) / <alpha-value>)',
        accent: { DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)', ink: 'rgb(var(--c-accent-ink) / <alpha-value>)' },
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)'
      }
    }
  },
  plugins: []
}
