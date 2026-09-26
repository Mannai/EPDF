const c = (v) => `rgb(var(--c-${v}) / <alpha-value>)`

// Design tokens from the Epdf design system (tokens/tailwind.config.mjs), Windows (v3) flavour.
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    // Replaced, not extended: these scales are closed so ad-hoc values stop creeping in. The "migration aliases" keep
    // older feature code rendering as before until it moves to the named steps.
    borderRadius: { none: '0', sm: '4px', DEFAULT: '6px', md: '6px', lg: '8px', full: '9999px', xl: '8px', '2xl': '8px' },
    boxShadow: {
      none: 'none',
      1: 'var(--shadow-1)',
      2: 'var(--shadow-2)',
      3: 'var(--shadow-3)',
      4: 'var(--shadow-4)',
      paper: 'var(--shadow-paper)',
      // migration aliases
      DEFAULT: 'var(--shadow-1)',
      sm: 'var(--shadow-1)',
      md: 'var(--shadow-2)',
      lg: 'var(--shadow-3)',
      xl: 'var(--shadow-4)',
      '2xl': 'var(--shadow-4)'
    },
    zIndex: {
      auto: 'auto',
      0: '0',
      base: '0',
      raised: '10',
      sticky: '20',
      dropdown: '30',
      popover: '40',
      modal: '50',
      toast: '60',
      tooltip: '70',
      // migration aliases (numeric steps used by older code)
      10: '10',
      20: '20',
      30: '30',
      40: '40',
      50: '50'
    },
    fontFamily: {
      sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      mono: ['"Cascadia Mono"', 'Consolas', 'ui-monospace', 'monospace']
    },
    fontSize: {
      caption: ['12px', { lineHeight: '16px' }],
      label: ['12px', { lineHeight: '16px', fontWeight: '500' }],
      body: ['14px', { lineHeight: '20px' }],
      title: ['14px', { lineHeight: '20px', fontWeight: '600' }],
      heading: ['16px', { lineHeight: '24px', fontWeight: '600' }],
      display: ['20px', { lineHeight: '28px', fontWeight: '600' }],
      mono: ['12px', { lineHeight: '16px' }],
      // migration aliases
      xs: ['12px', { lineHeight: '16px' }],
      sm: ['14px', { lineHeight: '20px' }],
      base: ['14px', { lineHeight: '20px' }],
      lg: ['16px', { lineHeight: '24px' }],
      xl: ['20px', { lineHeight: '28px' }],
      '2xl': ['24px', { lineHeight: '32px' }],
      '3xl': ['28px', { lineHeight: '36px' }]
    },
    extend: {
      colors: {
        canvas: c('canvas'),
        sunken: c('sunken'),
        surface: { DEFAULT: c('surface'), alt: c('surface-alt'), raised: c('raised') },
        raised: c('raised'),
        chrome: c('chrome'),
        'dialog-footer': c('dialog-footer'),
        field: c('field'),
        control: { DEFAULT: c('control'), hover: c('control-hover'), press: c('control-press') },
        disabled: c('disabled'),
        line: { DEFAULT: c('line'), strong: c('line-strong') },
        ink: { DEFAULT: c('ink'), muted: c('ink-muted'), disabled: c('ink-disabled') },
        hover: 'rgb(var(--c-fill) / var(--a-hover))',
        press: 'rgb(var(--c-fill) / var(--a-press))',
        accent: {
          DEFAULT: c('accent'),
          hover: c('accent-hover'),
          press: c('accent-press'),
          ink: c('accent-ink'),
          subtle: c('accent-subtle'),
          'subtle-strong': c('accent-subtle-strong')
        },
        focus: c('focus'),
        danger: { DEFAULT: c('danger'), bg: c('danger-bg'), line: c('danger-line'), ink: c('danger-ink'), hover: c('danger-hover') },
        warning: { DEFAULT: c('warning'), bg: c('warning-bg'), line: c('warning-line') },
        success: { DEFAULT: c('success'), bg: c('success-bg'), line: c('success-line') },
        info: { DEFAULT: c('info'), bg: c('info-bg'), line: c('info-line') },
        inverse: { DEFAULT: c('inverse'), ink: c('inverse-ink') },
        scrim: 'rgb(var(--c-scrim) / var(--a-scrim))',
        paper: '#ffffff'
      },
      transitionDuration: { fast: 'var(--dur-fast)', base: 'var(--dur-base)', slow: 'var(--dur-slow)' },
      transitionTimingFunction: { standard: 'var(--ease-standard)', exit: 'var(--ease-exit)' },
      spacing: { 13: '52px' }
    }
  },
  plugins: []
}
