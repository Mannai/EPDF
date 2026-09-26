import type { ReactNode } from 'react'

function Svg({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
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
      className={className}
    >
      {children}
    </svg>
  )
}

export const IconBookmarks = (): JSX.Element => (
  <Svg>
    <path d="M4 2.5h8v11L8 10.5l-4 3z" />
  </Svg>
)
export const IconAddBookmark = (): JSX.Element => (
  <Svg>
    <path d="M3.5 2.5h6.5M3.5 2.5v11L7 10.5l3.5 3V9" />
    <path d="M12.5 2.5v4M10.5 4.5h4" />
  </Svg>
)
export const IconRename = (): JSX.Element => (
  <Svg>
    <path d="m10.5 3 2.5 2.5-7 7H3.5V10z" />
  </Svg>
)
export const IconTrash = (): JSX.Element => (
  <Svg>
    <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9M7 7v4M9 7v4" />
  </Svg>
)
export const IconIndent = (): JSX.Element => (
  <Svg className="rtl:-scale-x-100">
    <path d="M2.5 3.5h11M7.5 6.5h6M7.5 9.5h6M2.5 12.5h11M2.5 6l2.5 2-2.5 2" />
  </Svg>
)
export const IconOutdent = (): JSX.Element => (
  <Svg className="rtl:-scale-x-100">
    <path d="M2.5 3.5h11M7.5 6.5h6M7.5 9.5h6M2.5 12.5h11M5 6 2.5 8 5 10" />
  </Svg>
)
export const IconUp = (): JSX.Element => (
  <Svg>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Svg>
)
export const IconDown = (): JSX.Element => (
  <Svg>
    <path d="M8 3v9.5M4 8.5l4 4 4-4" />
  </Svg>
)
export const IconChevron = ({ open }: { open: boolean }): JSX.Element => (
  <Svg className={`${open ? 'rotate-90' : 'rtl:-scale-x-100'} transition-none`}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
)
export const IconGenerate = (): JSX.Element => (
  <Svg>
    <path d="M3 13 11 5M9.5 3.5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM3 4l.5 1L4.5 5.5 3.5 6 3 7 2.5 6 1.5 5.5 2.5 5z" />
  </Svg>
)
export const IconTarget = (): JSX.Element => (
  <Svg>
    <circle cx="8" cy="8" r="5" />
    <circle cx="8" cy="8" r="1.5" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
  </Svg>
)
export const IconClearFilter = (): JSX.Element => (
  <Svg>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
)
