import { spawn } from 'node:child_process'
import { ScanError, errorFromMessage } from './errors'
import { LineParser, type ProtocolMessage } from './protocol'

/** Runs a scanner helper process (PowerShell WIA script, macOS helper, test helper) and speaks the line protocol to it. */

export interface HelperSpec {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export interface RunHelperOptions {
  signal?: AbortSignal
  /** Kill the helper if it prints nothing for this long. */
  idleTimeoutMs: number
  /** Called for every message, in order; awaited before the next one is processed. */
  onMessage?: (m: ProtocolMessage) => void | Promise<void>
}

export interface HelperResult {
  messages: ProtocolMessage[]
  noise: string[]
}

export function runHelper(spec: HelperSpec, opts: RunHelperOptions): Promise<HelperResult> {
  return new Promise<HelperResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'))
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.file, spec.args, { env: spec.env ?? process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(new ScanError('unavailable', `The scanner helper could not be started (${err instanceof Error ? err.message : String(err)}).`))
    }
    const parser = new LineParser()
    const messages: ProtocolMessage[] = []
    let stderr = ''
    let settled = false
    let idle: NodeJS.Timeout | undefined
    let chain: Promise<void> = Promise.resolve()
    let failure: Error | null = null
    let done = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (idle) clearTimeout(idle)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    const onAbort = (): void => {
      kill()
      finish(() => reject(new Error('Cancelled')))
    }
    const armIdle = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        kill()
        finish(() => reject(new ScanError('timeout')))
      }, opts.idleTimeoutMs)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    armIdle()

    const deliver = (list: ProtocolMessage[]): void => {
      for (const m of list) {
        messages.push(m)
        if (m.type === 'error' && !failure) failure = errorFromMessage(m)
        if (m.type === 'done') done = true
        chain = chain.then(async () => {
          if (settled || failure) return
          try {
            await opts.onMessage?.(m)
          } catch (err) {
            failure = err instanceof Error ? err : new Error(String(err))
            kill()
          }
        })
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      armIdle()
      deliver(parser.push(d))
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < 8000) stderr += d
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new ScanError('unavailable', err.code === 'ENOENT' ? 'The scanner helper program was not found.' : `The scanner helper could not be started (${err.message}).`)))
    })
    child.on('close', (code) => {
      deliver(parser.end())
      void chain.then(() => {
        finish(() => {
          if (failure) return reject(failure)
          if (code !== 0 && code !== null) {
            const detail = parser.noise.concat(stderr.split(/\r?\n/)).find((l) => l.trim()) ?? ''
            return reject(new ScanError('general', `The scanner helper stopped with an error${detail ? ` (${detail.trim().slice(0, 200)})` : ''}.`))
          }
          if (!done) return reject(new ScanError('general', 'The scanner helper ended without finishing.'))
          resolve({ messages, noise: parser.noise })
        })
      })
    })
  })
}
