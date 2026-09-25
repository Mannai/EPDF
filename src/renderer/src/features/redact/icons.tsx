import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** A block of text with a solid bar over part of it. */
export const IconMarkText = (): JSX.Element => (
  <Svg>
    <path d="M2 4h12M2 12h7" />
    <rect x="3" y="6.5" width="10" height="3" fill="currentColor" stroke="none" />
  </Svg>
)

/** A dashed rectangle being drawn. */
export const IconMarkArea = (): JSX.Element => (
  <Svg>
    <path d="M2.5 2.5h11v11h-11z" strokeDasharray="2 2" />
    <path d="M6 8h4M8 6v4" />
  </Svg>
)

export const IconFind = (): JSX.Element => (
  <Svg>
    <circle cx="7" cy="7" r="4" />
    <path d="m10 10 3.5 3.5" />
  </Svg>
)

export const IconApply = (): JSX.Element => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />
    <path d="m5.5 8 2 2 3-4" stroke="white" />
  </Svg>
)

export const IconRedactPanel = (): JSX.Element => (
  <Svg>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M5 6h6M5 10h3" />
  </Svg>
)
