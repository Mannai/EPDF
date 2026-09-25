import { serveJob } from './serveJob'

// Counts to `steps`, reporting progress, sleeping `delayMs` between steps. Exists so the worker pipeline
// (bundling, progress, cancel) is exercised end to end by the test-suite, including in packaged builds.
serveJob<{ steps: number; delayMs: number }, { counted: number }>(async ({ steps, delayMs }, report) => {
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    report(i / steps, `Step ${i} of ${steps}`)
  }
  return { counted: steps }
})
