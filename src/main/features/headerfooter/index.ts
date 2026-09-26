import { dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  DeletePresetSchema,
  GetLastSchema,
  HF_CHANNELS,
  ListPresetsSchema,
  MAX_SOURCE_BYTES,
  PickSourceSchema,
  SavePresetSchema,
  SetLastSchema,
  type PickedSource
} from '../../../shared/features/headerfooter'
import { commandItem, contributeMenu } from '../../menu/contributions'
import { registerFeatureChannel, type FeatureCallContext, type MainContext } from '../api'
import { PresetStore } from './presets'
import { sniffSource } from './sniff'

/**
 * Main-process half of headers & footers, Bates numbering, watermarks and backgrounds: presets and last-used settings
 * (feature key/value store), the native picker for a watermark picture or PDF (the renderer gets bytes, never a
 * path), and the menu items. Everything that edits the PDF happens in the renderer through the edit pipeline.
 */

async function pickSource(call: FeatureCallContext, kind: 'image' | 'pdf'): Promise<PickedSource | null> {
  const opts: Electron.OpenDialogOptions = {
    title: kind === 'image' ? 'Choose a picture' : 'Choose a PDF',
    properties: ['openFile'],
    filters: kind === 'image' ? [{ name: 'Pictures (PNG, JPEG)', extensions: ['png', 'jpg', 'jpeg'] }] : [{ name: 'PDF documents', extensions: ['pdf'] }]
  }
  const parent = call.window?.win
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  const path = res.filePaths[0]!
  const st = await stat(path)
  if (!st.isFile()) throw new Error('That is not a file.')
  if (st.size > MAX_SOURCE_BYTES) throw new Error(`That file is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.`)
  const bytes = new Uint8Array(await readFile(path))
  const sniffed = sniffSource(bytes)
  if (kind === 'image' && sniffed !== 'png' && sniffed !== 'jpeg') {
    throw new Error(`“${basename(path)}” is not a PNG or JPEG picture${extname(path) ? '' : ' (it has no file extension)'}.`)
  }
  if (kind === 'pdf' && sniffed !== 'pdf') throw new Error(`“${basename(path)}” is not a PDF file.`)
  return { name: basename(path), kind: sniffed!, bytes }
}

export function register(ctx: MainContext): void {
  const store = new PresetStore(ctx.kv('headerfooter'))
  registerFeatureChannel(HF_CHANNELS.listPresets, ListPresetsSchema, ({ group }) => store.list(group))
  registerFeatureChannel(HF_CHANNELS.savePreset, SavePresetSchema, (p) => store.save(p))
  registerFeatureChannel(HF_CHANNELS.deletePreset, DeletePresetSchema, ({ id }) => store.delete(id))
  registerFeatureChannel(HF_CHANNELS.getLast, GetLastSchema, ({ group }) => store.getLast(group))
  registerFeatureChannel(HF_CHANNELS.setLast, SetLastSchema, ({ group, settings }) => store.setLast(group, settings))
  registerFeatureChannel(HF_CHANNELS.pickSource, PickSourceSchema, ({ kind }, call) => pickSource(call, kind))

  contributeMenu({
    menu: 'Document',
    position: 'end',
    items: () => [
      { type: 'separator' },
      // (no "&" in labels: Windows menus read it as a mnemonic marker)
      commandItem('Header and Footer…', 'headerfooter.open'),
      commandItem('Bates Numbering…', 'headerfooter.bates'),
      commandItem('Watermark…', 'headerfooter.watermark'),
      commandItem('Background…', 'headerfooter.background'),
      commandItem('Remove Headers and Footers', 'headerfooter.removeHeaderFooter'),
      commandItem('Remove Bates Numbering', 'headerfooter.removeBates'),
      commandItem('Remove Watermarks', 'headerfooter.removeWatermark'),
      commandItem('Remove Backgrounds', 'headerfooter.removeBackground')
    ]
  })
}
