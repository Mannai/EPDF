/**
 * Minimal raw driver for harfbuzz-subset.wasm, used by developer scripts (the app itself uses
 * src/shared/text/pdf/subset.ts). `subsetRaw(wasmBytes, fontBytes, options)` returns the subset font bytes.
 */
const FLAG_NO_HINTING = 0x1
const FLAG_RETAIN_GIDS = 0x2
const FLAG_NOTDEF_OUTLINE = 0x40

export async function subsetRaw(wasmBytes, fontBytes, opts = {}) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {})
  const x = instance.exports
  if (x._initialize) x._initialize()
  const u8 = () => new Uint8Array(x.memory.buffer)
  const dataPtr = x.malloc(fontBytes.length)
  u8().set(fontBytes, dataPtr)
  const blob = x.hb_blob_create(dataPtr, fontBytes.length, 0, 0, 0) // HB_MEMORY_MODE_DUPLICATE
  const face = x.hb_face_create(blob, 0)
  const input = x.hb_subset_input_create_or_fail()
  if (!input) throw new Error('hb_subset_input_create_or_fail failed')
  if (opts.keepEverything) x.hb_subset_input_keep_everything(input)
  else {
    const uni = x.hb_subset_input_unicode_set(input)
    for (const cp of opts.unicodes ?? []) x.hb_set_add(uni, cp)
  }
  let flags = FLAG_NOTDEF_OUTLINE
  if (opts.noHinting) flags |= FLAG_NO_HINTING
  if (opts.retainGids) flags |= FLAG_RETAIN_GIDS
  x.hb_subset_input_set_flags(input, flags)
  if (opts.pinAxesToDefault) x.hb_subset_input_pin_all_axes_to_default(input, face)
  const sub = x.hb_subset_or_fail(face, input)
  if (!sub) throw new Error('hb_subset_or_fail failed')
  const outBlob = x.hb_face_reference_blob(sub)
  const len = x.hb_blob_get_length(outBlob)
  const ptr = x.hb_blob_get_data(outBlob, 0)
  const out = u8().slice(ptr, ptr + len)
  x.hb_blob_destroy(outBlob)
  x.hb_face_destroy(sub)
  x.hb_subset_input_destroy(input)
  x.hb_face_destroy(face)
  x.hb_blob_destroy(blob)
  x.free(dataPtr)
  return out
}
