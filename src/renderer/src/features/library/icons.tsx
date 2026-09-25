import type { ReactNode } from 'react'

function Svg({ children, size = 16, label }: { children: ReactNode; size?: number; label?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  )
}

export const StarIcon = ({ filled }: { filled: boolean }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    <path d="m8 1.8 1.9 4 4.3.5-3.2 3 .9 4.3L8 11.4l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" />
  </svg>
)

export const CloudIcon = ({ label }: { label?: string }): JSX.Element => (
  <Svg label={label}>
    <path d="M4.5 12.5a3 3 0 0 1-.4-5.97A4 4 0 0 1 11.9 5.6a3.4 3.4 0 0 1-.4 6.9z" />
  </Svg>
)

export const WarnIcon = ({ label }: { label?: string }): JSX.Element => (
  <Svg label={label}>
    <path d="M8 2 1.8 13h12.4z" />
    <path d="M8 6.5v3M8 11.2v.1" />
  </Svg>
)

export const FileIcon = ({ size = 16 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M3.5 1.8h5.6l3.4 3.4v9H3.5z" />
    <path d="M9 1.8v3.6h3.5" />
  </Svg>
)

export const FolderIcon = (): JSX.Element => (
  <Svg>
    <path d="M1.8 4.2A1.2 1.2 0 0 1 3 3h3l1.4 1.5H13a1.2 1.2 0 0 1 1.2 1.2v6.1A1.2 1.2 0 0 1 13 13H3a1.2 1.2 0 0 1-1.2-1.2z" />
  </Svg>
)

export const ClockIcon = (): JSX.Element => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.3 1.4" />
  </Svg>
)

export const LibraryIcon = (): JSX.Element => (
  <Svg>
    <path d="M3 2.5v11M6.5 2.5v11M10 3l3 .8-2.6 9.7-3-.8" />
  </Svg>
)

export const ChevronIcon = ({ open }: { open: boolean }): JSX.Element => (
  <Svg>
    <path d={open ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} />
  </Svg>
)

export const ListIcon = (): JSX.Element => (
  <Svg>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1" />
  </Svg>
)

export const GridIcon = (): JSX.Element => (
  <Svg>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="0.8" />
  </Svg>
)

export const SettingsIcon = (): JSX.Element => (
  <Svg>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </Svg>
)
