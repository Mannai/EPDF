import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CreatePrefsSchema, type CreatePrefs } from '../../../shared/features/create'

/** Small per-user preferences of the Create PDF feature (which Office engine to use), stored as JSON in the profile folder. */
export class CreatePrefsStore {
  private value: CreatePrefs
  private file: string

  constructor(userData: string) {
    this.file = join(userData, 'create-prefs.json')
    let raw: unknown = {}
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      /* first run or unreadable: defaults */
    }
    const parsed = CreatePrefsSchema.safeParse(raw)
    this.value = parsed.success ? parsed.data : CreatePrefsSchema.parse({})
  }

  get(): CreatePrefs {
    return this.value
  }

  async set(p: Partial<CreatePrefs>): Promise<CreatePrefs> {
    this.value = CreatePrefsSchema.parse({ ...this.value, ...p })
    await writeFile(this.file, JSON.stringify(this.value), 'utf8').catch(() => undefined)
    return this.value
  }
}
