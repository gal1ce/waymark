/** Any picture, cut to a centred square and scaled to 256 px, so a phone photo doesn't travel as 8 MB. */
export async function squareAvatar(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const side = Math.min(bmp.width, bmp.height), out = Math.min(256, side)
  const cv = document.createElement('canvas'); cv.width = cv.height = out
  cv.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out)
  bmp.close()
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('The picture could not be read'))), 'image/png'))
}
