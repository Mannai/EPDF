/*
 * Icons: Lucide-style glyphs on a 24-unit grid, drawn at 16 px with a 2-unit stroke (~1.33 px), as in the Epdf design
 * system (ep-icons.js). Paths are simplified from Lucide (https://lucide.dev), ISC License:
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright
 * (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or distribute this software
 * for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission
 * notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.
 */

const P = {
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  open: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  'chev-up': '<path d="m18 15-6-6-6 6"/>',
  'chev-down': '<path d="m6 9 6 6 6-6"/>',
  'chev-right': '<path d="m9 18 6-6-6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  continuous: '<rect x="6" y="2" width="12" height="9" rx="1.5"/><rect x="6" y="13" width="12" height="9" rx="1.5"/>',
  single: '<rect x="6" y="3" width="12" height="18" rx="1.5"/>',
  two: '<rect x="2.5" y="4" width="8.5" height="16" rx="1.5"/><rect x="13" y="4" width="8.5" height="16" rx="1.5"/>',
  thumbs: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  'bookmark-plus': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>',
  select: '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
  squiggly: '<path d="M7 3v6a5 5 0 0 0 10 0V3"/><path d="M3 19c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0 3 2 4.5 0"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  textbox: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8M12 8v8"/>',
  draw: '<path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  rect: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9.5" ry="7"/>',
  line: '<path d="M4 20 20 4"/>',
  arrow: '<path d="M6 18 18 6M8 6h10v10"/>',
  stamp: '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  date: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  signature: '<path d="M3 21h18"/><path d="M3 16c3-1 5-5 5-8a2 2 0 0 0-4 0c0 4 3 8 6 8 2 0 2-3 4-3s1.5 3 3 3 2-1 3-2"/>',
  'f-text': '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 10v4"/>',
  'f-check': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  'f-radio': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  'f-list': '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="m13 11 2 2 2-2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  redact: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="7" y="9.5" width="10" height="5" rx="0.5" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  rename: '<path d="M12 20h9"/><path d="M16.38 3.62a2.12 2.12 0 1 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  indent: '<path d="M3 5h18M11 10h10M11 14h10M3 19h18"/><path d="m3 9 3 3-3 3"/>',
  outdent: '<path d="M3 5h18M11 10h10M11 14h10M3 19h18"/><path d="m7 9-3 3 3 3"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  'file-plus': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M12 12v6M9 15h6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  palette: '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/>'
} as const

export type IconName = keyof typeof P
export const hasIcon = (name: string): name is IconName => name in P

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      // The path strings are constants in this file (never user data).
      dangerouslySetInnerHTML={{ __html: P[name] }}
    />
  )
}

export const IconUndo = (): JSX.Element => <Icon name="undo" />
export const IconRedo = (): JSX.Element => <Icon name="redo" />
export const IconSave = (): JSX.Element => <Icon name="save" />
export const IconThumbnails = (): JSX.Element => <Icon name="thumbs" />
export const IconSidebar = (): JSX.Element => <Icon name="sidebar" />
export const IconOpen = (): JSX.Element => <Icon name="open" />
export const IconUp = (): JSX.Element => <Icon name="chev-up" />
export const IconDown = (): JSX.Element => <Icon name="chev-down" />
export const IconPlus = (): JSX.Element => <Icon name="plus" />
export const IconMinus = (): JSX.Element => <Icon name="minus" />
export const IconSearch = (): JSX.Element => <Icon name="search" />
export const IconClose = (): JSX.Element => <Icon name="x" />
export const IconSingle = (): JSX.Element => <Icon name="single" />
export const IconContinuous = (): JSX.Element => <Icon name="continuous" />
export const IconTwo = (): JSX.Element => <Icon name="two" />
