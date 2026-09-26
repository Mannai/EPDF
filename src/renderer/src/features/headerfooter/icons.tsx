import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const IconHeaderFooter = (): JSX.Element => (
  <Svg>
    <rect x="3" y="1.5" width="10" height="13" rx="1" />
    <path d="M5 4h6M5 12h6" />
  </Svg>
)
export const IconBates = (): JSX.Element => (
  <Svg>
    <rect x="3" y="1.5" width="10" height="13" rx="1" />
    <path d="M7 11.5h4M9.5 10v3" />
  </Svg>
)
export const IconWatermark = (): JSX.Element => (
  <Svg>
    <rect x="3" y="1.5" width="10" height="13" rx="1" />
    <path d="M5.5 11 10.5 5" strokeDasharray="1.5 1.5" />
  </Svg>
)
export const IconBackground = (): JSX.Element => (
  <Svg>
    <rect x="3" y="1.5" width="10" height="13" rx="1" fill="currentColor" fillOpacity="0.25" />
  </Svg>
)
