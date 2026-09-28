import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function globalSetup(): void {
  // Every app a test starts has its license agreement accepted (Linux and macOS ask on first start otherwise);
  // the workers inherit this environment.
  process.env['EPDF_ACCEPT_EULA'] = '1'
  execFileSync(process.execPath, ['tests/fixtures/generate.mjs', resolve('test-results/fixtures')], { stdio: 'inherit' })
}
