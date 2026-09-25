import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function globalSetup(): void {
  execFileSync(process.execPath, ['tests/fixtures/generate.mjs', resolve('test-results/fixtures')], { stdio: 'inherit' })
}
