# Cuts docs/mascot/nix.png (the mascot, drawn with ChatGPT image generation) into the layers NixFly animates:
# body (face painted out; the face is drawn live in Scenery.tsx), antenna, wing-l, wing-r, and the avatar.
#   uv run --with opencv-python-headless --with numpy python docs/mascot/layers.py docs/mascot/nix.png OUT_DIR
# then convert each PNG in OUT_DIR to webp (e.g. magick body.png -quality 88 frontend/public/nix/body.webp).

import cv2, numpy as np, json, sys
src, out = sys.argv[1], sys.argv[2]
GROW = int(sys.argv[3]) if len(sys.argv) > 3 else 8
im = cv2.imread(src, cv2.IMREAD_UNCHANGED).astype(np.float32)
H, W = im.shape[:2]
A = im[..., 3]
# 1) drop stray specks: keep only big components
keep = np.zeros((H, W), np.uint8)
n, lab, st, _ = cv2.connectedComponentsWithStats((A > 40).astype(np.uint8))
for i in range(1, n):
    if st[i, 4] > 3000: keep[lab == i] = 255
keep = cv2.dilate(keep, np.ones((9, 9), np.uint8))
A = A * (keep > 0)
# 2) body ellipse (antialiased, drawn at 4x then downsampled)
S = 4
EA, EB = 529 + 2 * GROW, 588 + 2 * GROW
big = np.zeros((H * S, W * S), np.uint8)
cv2.ellipse(big, ((626 * S, 760 * S), (EA * S, EB * S), 89.3), 255, -1, cv2.LINE_AA)
ell = cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
big[:] = 0
cv2.ellipse(big, ((626 * S, 760 * S), (529 * S, 588 * S), 89.3), 255, -1, cv2.LINE_AA)
ell0 = cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
yy, xx = np.mgrid[0:H, 0:W]
wz = ((np.abs(xx - 626) > 130) & (yy > 460) & (yy < 915)).astype(np.float32)
wz = cv2.GaussianBlur(wz, (0, 0), 6)
ell = ell * (1 - wz) + ell0 * wz          # grown only away from the wing roots
big[:] = 0
cv2.ellipse(big, ((626 * S, 760 * S), ((529 + 60) * S, (588 + 60) * S), 89.3), 255, -1)
near = cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA) > 0
Bc, Gc, Rc = [im[..., i] for i in range(3)]
rim = near & (Rc - Bc > 110) & (Gc < 215) & (im[..., 3] > 8)        # the body's orange rim, wherever it pokes past the ellipse
rim = cv2.GaussianBlur(rim.astype(np.float32), (0, 0), 1.2)
ell = np.maximum(ell, rim)                            # so it never rides along with a wing
# 3) body layer with the face painted out
rgb = im[..., :3].astype(np.uint8)
B, G, R = [im[..., i] for i in range(3)]
inb = ell > 0.5
face = inb & ((R + G + B < 330) | ((R > 235) & (G > 235) & (B > 235) & (np.abs(R - B) < 25)) | ((R - B > 22) & (G < R - 25) & (B > 140)))
face[:540, :] = False                      # the antenna knob stays
face = cv2.dilate(face.astype(np.uint8) * 255, np.ones((13, 13), np.uint8))
clean = cv2.inpaint(rgb, face, 24, cv2.INPAINT_TELEA)
clean = cv2.GaussianBlur(clean, (0, 0), 6) * (face[..., None] > 0) + clean * (face[..., None] == 0)   # smooth the patched area
def layer(rgb_, a_):
    return np.dstack([rgb_.astype(np.float32), a_]).clip(0, 255).astype(np.uint8)
body = layer(clean, A * ell)
# 4) the rest: antenna and the two wings, split by component
rest = A * (1 - ell)
# the antenna is the piece of the rest that holds the stem; everything else is wing, by side
n, lab, st, _ = cv2.connectedComponentsWithStats((rest > 160).astype(np.uint8))   # solid pixels only: faint haze bridges to the wing
stem = lab == lab[460, 676]                       # a pixel in the stem, just above the knob
stem = cv2.dilate(stem.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
yy, xx = np.mgrid[0:H, 0:W]
stem &= ~((yy > 470) & (R - B > 60))             # the body's top rim touches the stem: it stays with the body
parts = {'wingL': ~stem & (xx < 500), 'wingR': ~stem & (xx > 752)}   # the middle holds only faint rim crumbs
aa = rest * stem
aa = np.clip((aa - 70) * 255 / 130, 0, 255)      # the stem's faint haze goes, its edge stays smooth (the bulb's glow is drawn live)
ant = layer(im[..., :3], aa)
# wings: they only ever narrow toward a pivot inside the body (index.css), so their roots slide under it and nothing
# needs to be drawn beneath the body
wl, wr = layer(im[..., :3], rest * parts['wingL']), layer(im[..., :3], rest * parts['wingR'])
# 5) crop all layers to one shared box
al = np.maximum.reduce([body[..., 3], ant[..., 3], wl[..., 3], wr[..., 3]])
ys, xs = np.where(al > 8)
pad = 24
x0, y0, x1, y1 = 99, 195, 1153, 1044              # fixed: NixFly in Scenery.tsx uses this box
box = dict(x=int(x0), y=int(y0), w=int(x1 - x0), h=int(y1 - y0))
scale = 640 / box['w']
for name, L in [('body', body), ('antenna', ant), ('wing-l', wl), ('wing-r', wr)]:
    c = L[y0:y1, x0:x1]
    c = cv2.resize(c, (640, round(box['h'] * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(f'{out}/{name}.png', c)
# avatar: the face, square, from the original
cx, cy, r = 626, 742, 300
av = im[cy - r:cy + r, cx - r:cx + r].copy(); av[..., 3] *= (keep[cy - r:cy + r, cx - r:cx + r] > 0)
cv2.imwrite(f'{out}/avatar.png', cv2.resize(av.clip(0, 255).astype(np.uint8), (256, 256), interpolation=cv2.INTER_AREA))

print(json.dumps(box), scale)
