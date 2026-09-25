import type { DetectKind } from './logic/detect'

export const DETECT_LABEL: Record<DetectKind, string> = {
  text: 'Text field',
  checkbox: 'Check box',
  radio: 'Radio group',
  comb: 'Comb field',
  date: 'Date field',
  signature: 'Signature field'
}

export const DETECT_KINDS: DetectKind[] = ['text', 'date', 'comb', 'checkbox', 'radio', 'signature']
