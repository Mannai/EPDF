import Database from 'better-sqlite3'
import { migrate } from './migrations'
import { RecentFilesRepo, RecoveryRepo, SessionRepo, SettingsRepo, VersionsRepo } from './repos'

export interface Repos {
  db: Database.Database
  recent: RecentFilesRepo
  session: SessionRepo
  settings: SettingsRepo
  recovery: RecoveryRepo
  versions: VersionsRepo
}

export function openRepos(file: string): Repos {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return {
    db,
    recent: new RecentFilesRepo(db),
    session: new SessionRepo(db),
    settings: new SettingsRepo(db),
    recovery: new RecoveryRepo(db),
    versions: new VersionsRepo(db)
  }
}
