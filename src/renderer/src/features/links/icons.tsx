import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const IconAddLink = (): JSX.Element => (
  <Svg>
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.75.75" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
  </Svg>
)
export const IconEditLinks = (): JSX.Element => (
  <Svg>
    <rect x="2" y="4" width="9" height="7" rx="1" strokeDasharray="2 2" />
    <path d="M9 9.5 14 12l-2 .5-.5 2z" />
  </Svg>
)
