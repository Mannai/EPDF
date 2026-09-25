import { getDialogs } from '../features/api'
import { GoToPageDialog, PasswordDialog } from './Dialogs'

/** Core dialogs plus every dialog host a feature registered with `registerDialog`. */
export function Dialogs(): JSX.Element {
  return (
    <>
      <PasswordDialog />
      <GoToPageDialog />
      {getDialogs().map((Dialog, i) => (
        <Dialog key={i} />
      ))}
    </>
  )
}
