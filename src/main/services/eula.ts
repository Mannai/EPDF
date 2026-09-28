/**
 * The End User License Agreement must be accepted before Epdf is used. On Windows the installer asks ("I Agree"
 * before anything is installed). Linux packages (.deb, AppImage) and a macOS disk image have no such page, so there
 * the app asks once, on first start, before any window opens; the answer is kept in the profile per agreement
 * version. Automated deployments and tests accept it with EPDF_ACCEPT_EULA=1, as a silent Windows install does.
 */

/** Raise when the agreement's terms change, so everyone is asked again. */
export const EULA_VERSION = '1.0'

export function eulaNeedsAcceptance(platform: NodeJS.Platform, accepted: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'win32') return false // the installer asked
  if (env['EPDF_ACCEPT_EULA'] === '1') return false
  return accepted !== EULA_VERSION
}

export type EulaAnswer = 'agree' | 'read' | 'quit'

export interface EulaDeps {
  ask(): Promise<EulaAnswer>
  openAgreement(): Promise<void>
  remember(version: string): void
}

/** Asks until the user agrees or quits (reading the agreement asks again). True when Epdf may start. */
export async function askForEula(deps: EulaDeps): Promise<boolean> {
  for (;;) {
    const a = await deps.ask()
    if (a === 'agree') {
      deps.remember(EULA_VERSION)
      return true
    }
    if (a === 'quit') return false
    await deps.openAgreement()
  }
}

export const EULA_PROMPT = {
  message: 'Epdf End User License Agreement',
  detail:
    'Epdf is licensed, not sold. During the beta it may be used for personal and noncommercial purposes only; ' +
    'copying, reselling, modifying and reverse engineering it are not allowed, and it comes without warranty. ' +
    'Please read the full agreement. By choosing “I Agree” you accept it.',
  buttons: ['I Agree', 'Read the Agreement', 'Quit']
} as const
