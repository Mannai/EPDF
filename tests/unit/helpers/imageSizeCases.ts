import { makeFakeJpeg, makePng } from './pdfBuilder'

export interface ImageSizeCase {
  name: string
  bytes: Uint8Array
  kind: 'png' | 'jpg'
  size: { width: number; height: number }
}

export function imageSizeCases(): ImageSizeCase[] {
  return [
    { name: 'png 1x1', bytes: makePng(1, 1), kind: 'png', size: { width: 1, height: 1 } },
    { name: 'png 50x25', bytes: makePng(50, 25), kind: 'png', size: { width: 50, height: 25 } },
    { name: 'png 300x7', bytes: makePng(300, 7), kind: 'png', size: { width: 300, height: 7 } },
    { name: 'jpeg 40x20', bytes: makeFakeJpeg(40, 20), kind: 'jpg', size: { width: 40, height: 20 } },
    { name: 'jpeg 1023x767', bytes: makeFakeJpeg(1023, 767), kind: 'jpg', size: { width: 1023, height: 767 } }
  ]
}
