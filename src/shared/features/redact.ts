/** Result of `redact:purgeHistory`: removing the copies Epdf keeps of a document (version history, recovery copy). */
export interface PurgeSummary {
  /** Version-history snapshots that existed. */
  versions: number
  /** Snapshots that were deleted. */
  deleted: number
  /** An autosaved recovery copy was removed. */
  recovery: boolean
  /** Copies that could not be deleted; their records are kept, so a later purge retries them. Main always reports it;
   *  when absent, the renderer falls back to `versions - deleted`. */
  failed?: number
}
