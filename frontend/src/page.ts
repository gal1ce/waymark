import type { FigBox, PageSetup, PageSize } from './api'

/* ----------------------------------------------------------------- page sizes */

/** Paper sizes in millimetres (portrait). */
export const PAGE_SIZES: Record<PageSize, [number, number]> = {
  A5: [148, 210], A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
}
const px = (mm: number) => Math.round((mm * 96) / 25.4)

/** A sheet in CSS pixels (96 per inch, as print uses), with its margin. */
export function sheetOf(p?: PageSetup): { w: number; h: number; pad: number; size: PageSize; landscape: boolean } {
  const size = p && PAGE_SIZES[p.size] ? p.size : 'A4'
  const [a, b] = PAGE_SIZES[size]
  const landscape = !!p?.landscape
  const w = px(landscape ? b : a), h = px(landscape ? a : b)
  // about 2 cm on A4, a little less on small paper, never under 40 px (the block grips sit in it)
  return { w, h, pad: Math.max(48, Math.round(Math.min(w, h) * 0.095)), size, landscape }
}

/** How much a node is scaled by CSS `zoom` on it or its ancestors (the page is zoomed to fit the column). */
export function zoomOf(el: Element | null): number {
  if (!el) return 1
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom
  if (typeof z === 'number' && z > 0) return z
  const w = (el as HTMLElement).offsetWidth
  return w ? el.getBoundingClientRect().width / w : 1
}

/** What scrolls a page: the scratch paper's own sheet, or the app's main column. */
export function scrollerOf(el: Element | null): Element | null {
  return el?.closest('.scratch-paper') ?? document.querySelector('.main')
}

/** Where a figure sits in the text column, from what the block stores. */
export function placeOf(box: FigBox, colW: number, w: number): number {
  const room = Math.max(0, colW - w)
  if (box.x != null) return Math.min(room, Math.max(0, box.x))
  return box.align === 'left' ? 0 : box.align === 'right' ? room : room / 2
}

