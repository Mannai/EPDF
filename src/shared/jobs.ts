export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

/** Pushed to the renderer as the `job:update` feature event. */
export interface JobUpdate {
  jobId: string
  kind: string
  /** Label shown in the jobs tray, e.g. "Recognizing text". */
  title: string
  state: JobState
  /** 0..1 */
  progress: number
  message?: string
  result?: unknown
  error?: string
}
