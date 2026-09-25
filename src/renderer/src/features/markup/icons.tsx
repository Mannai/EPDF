import type { ReactNode } from 'react'
import { isStateRecord } from './pdf/threads'
import type { AnnotInfo } from './pdf/model'

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const IconSelect = (): JSX.Element => (
  <Svg>
    <path d="M3.5 2.5 12 8l-4 1-1.5 4z" />
  </Svg>
)
export const IconHighlight = (): JSX.Element => (
  <Svg>
    <path d="m9.5 2.5 4 4-6 6H4v-3.5z" />
    <path d="M2.5 14h11" />
  </Svg>
)
export const IconUnderline = (): JSX.Element => (
  <Svg>
    <path d="M4.5 2.5v5a3.5 3.5 0 0 0 7 0v-5" />
    <path d="M3 14h10" />
  </Svg>
)
export const IconStrike = (): JSX.Element => (
  <Svg>
    <path d="M11 4.5a3 2 0 0 0-3-1.5c-2 0-3 .8-3 2s1 1.7 3 2.2 3 1 3 2.3-1 2-3 2a3 2 0 0 1-3.2-1.5" />
    <path d="M2.5 8h11" />
  </Svg>
)
export const IconSquiggly = (): JSX.Element => (
  <Svg>
    <path d="M4.5 2.5v4a3.5 3.5 0 0 0 7 0v-4" />
    <path d="m2.5 13 1.5-1.5L5.5 13 7 11.5 8.5 13 10 11.5 11.5 13 13 11.5" />
  </Svg>
)
export const IconNote = (): JSX.Element => (
  <Svg>
    <path d="M2.5 2.5h11v8h-4.5l-3 3v-3h-3.5z" />
  </Svg>
)
export const IconTextBox = (): JSX.Element => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M5 6h6M8 6v5" />
  </Svg>
)
export const IconInk = (): JSX.Element => (
  <Svg>
    <path d="M2.5 12.5c2-4 3-8 5-8s0 7 2.5 7 2-3 3.5-3" />
  </Svg>
)
export const IconRect = (): JSX.Element => (
  <Svg>
    <rect x="2.5" y="4" width="11" height="8" rx="0.5" />
  </Svg>
)
export const IconEllipse = (): JSX.Element => (
  <Svg>
    <ellipse cx="8" cy="8" rx="5.5" ry="4" />
  </Svg>
)
export const IconLine = (): JSX.Element => (
  <Svg>
    <path d="m3 13 10-10" />
  </Svg>
)
export const IconArrow = (): JSX.Element => (
  <Svg>
    <path d="M3 13 13 3M6.5 3H13v6.5" />
  </Svg>
)
export const IconStamp = (): JSX.Element => (
  <Svg>
    <path d="M6 9.5h4L9.5 7c-.5-1 1-1.5 1-3a2.5 2.5 0 0 0-5 0c0 1.500 1.500 2 1 3z" />
    <path d="M3 13.500h10" />
    <path d="M4.500 9.500h7v2.500h-7z" />
  </Svg>
)
export const IconComments = (): JSX.Element => (
  <Svg>
    <path d="M2.5 3h11v7.500h-6l-3 2.500v-2.500h-2z" />
    <path d="M5 6h6M5 8.200h3.500" />
  </Svg>
)
export const IconCheck = (): JSX.Element => (
  <Svg>
    <path d="m3.500 8.500 3 3 6-7" />
  </Svg>
)

/** Icon for a listed annotation, by subtype. */
export function IconFor({ annot }: { annot: Pick<AnnotInfo, 'subtype' | 'irt' | 'stateModel' | 'state'> }): JSX.Element {
  if (annot.irt || isStateRecord(annot as AnnotInfo)) return <IconNote />
  switch (annot.subtype) {
    case 'Highlight':
      return <IconHighlight />
    case 'Underline':
      return <IconUnderline />
    case 'StrikeOut':
      return <IconStrike />
    case 'Squiggly':
      return <IconSquiggly />
    case 'FreeText':
      return <IconTextBox />
    case 'Ink':
      return <IconInk />
    case 'Square':
      return <IconRect />
    case 'Circle':
      return <IconEllipse />
    case 'Line':
    case 'PolyLine':
      return <IconLine />
    case 'Stamp':
      return <IconStamp />
    default:
      return <IconNote />
  }
}
