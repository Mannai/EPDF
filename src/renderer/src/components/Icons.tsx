import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconUndo = (): JSX.Element => (
  <Svg>
    <path d="M5.5 3 2.5 6l3 3" />
    <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
  </Svg>
)
export const IconRedo = (): JSX.Element => (
  <Svg>
    <path d="m10.5 3 3 3-3 3" />
    <path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4" />
  </Svg>
)
export const IconSave = (): JSX.Element => (
  <Svg>
    <path d="M3 2.5h8l2 2v9H3z" />
    <path d="M5.5 2.5v3.5h4V2.5M5.5 13.5V9.5h5v4" />
  </Svg>
)
export const IconThumbnails = (): JSX.Element => (
  <Svg>
    <rect x="2.5" y="2" width="4.5" height="5.5" rx="0.75" />
    <rect x="9" y="2" width="4.5" height="5.5" rx="0.75" />
    <rect x="2.5" y="9" width="4.5" height="5" rx="0.75" />
    <rect x="9" y="9" width="4.5" height="5" rx="0.75" />
  </Svg>
)

export const IconSidebar = (): JSX.Element => (
  <Svg>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M6 2.5v11" />
  </Svg>
)
export const IconOpen = (): JSX.Element => (
  <Svg>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
)
export const IconUp = (): JSX.Element => (
  <Svg>
    <path d="m4 10 4-4 4 4" />
  </Svg>
)
export const IconDown = (): JSX.Element => (
  <Svg>
    <path d="m4 6 4 4 4-4" />
  </Svg>
)
export const IconPlus = (): JSX.Element => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)
export const IconMinus = (): JSX.Element => (
  <Svg>
    <path d="M3 8h10" />
  </Svg>
)
export const IconSearch = (): JSX.Element => (
  <Svg>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
)
export const IconClose = (): JSX.Element => (
  <Svg>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
)
export const IconSingle = (): JSX.Element => (
  <Svg>
    <rect x="4.5" y="2" width="7" height="12" rx="1" />
  </Svg>
)
export const IconContinuous = (): JSX.Element => (
  <Svg>
    <rect x="4.5" y="1.5" width="7" height="5" rx="1" />
    <rect x="4.5" y="9.5" width="7" height="5" rx="1" />
  </Svg>
)
export const IconTwo = (): JSX.Element => (
  <Svg>
    <rect x="1.5" y="3" width="6" height="10" rx="1" />
    <rect x="8.5" y="3" width="6" height="10" rx="1" />
  </Svg>
)
