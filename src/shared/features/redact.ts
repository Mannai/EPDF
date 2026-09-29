/** Result of `redact:purgeHistory`: removing the copies Epdf keeps of a document (version history, recovery copy). */
export interface PurgeSummary {
  /** Version-history snapshots that existed. */
  versions: number
  /** Snapshots that were deleted. */
  deleted: number
  /** An autosaved recovery copy was removed. */
  recovery: boolean
  /** Snapshots that could not be deleted (when reported; otherwise `versions - deleted`). */
  failed?: number
}
