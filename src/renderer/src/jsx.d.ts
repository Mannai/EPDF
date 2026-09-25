import type { JSX as ReactJSX } from 'react'

// React 19's types dropped the global JSX namespace; restore the bit our components use.
declare global {
  namespace JSX {
    type Element = ReactJSX.Element
  }
}
