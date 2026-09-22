export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
      },
      colors: {
        paper: {
          DEFAULT: 'hsl(var(--paper))',
          sunk: 'hsl(var(--paper-sunk))',
        },
        ink: {
          DEFAULT: 'hsl(var(--ink))',
          muted: 'hsl(var(--ink-muted))',
          faint: 'hsl(var(--ink-faint))',
        },
        rule: {
          DEFAULT: 'hsl(var(--rule))',
          strong: 'hsl(var(--rule-strong))',
        },
        mark: 'hsl(var(--mark))',
        border: 'hsl(var(--border))',
      },
    },
  },
}
