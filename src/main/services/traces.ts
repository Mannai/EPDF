/**
 * Places other than the version history where Epdf keeps something derived from a document's content (the library's
 * page text and thumbnail). A feature registers a source; "purge the history of this document" (after redacting it)
 * asks every source to forget the document too.
 */

export interface TraceResult {
  /** Items that could not be removed. */
  failed: number
}

export type TraceSource = (path: string) => Promise<TraceResult> | TraceResult

const sources = new Map<string, TraceSource>()

/** Registers (or replaces) the source called `name`. Returns a function that unregisters it. */
export function registerTraceSource(name: string, source: TraceSource): () => void {
  sources.set(name, source)
  return () => {
    if (sources.get(name) === source) sources.delete(name)
  }
}

/** Asks every source to forget the document at `path`. A source that throws counts as one failure. */
export async function forgetTraces(path: string): Promise<TraceResult> {
  let failed = 0
  for (const [name, source] of sources) {
    try {
      failed += (await source(path)).failed
    } catch (err) {
      console.warn(`could not forget the ${name} data of a document`, err)
      failed++
    }
  }
  return { failed }
}

/** Test helper. */
export function _resetTraceSources(): void {
  sources.clear()
}
