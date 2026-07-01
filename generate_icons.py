"""Generate PWA icons (192px and 512px) — snake S-curve with head, eyes, and food."""
import struct
import zlib
import os


def png_chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xffffffff
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)


class Canvas:
    def __init__(self, size, bg):
        self.size = size
        self.buf = [list(bg) for _ in range(size * size)]

    def _set(self, x, y, color):
        if 0 <= x < self.size and 0 <= y < self.size:
            self.buf[y * self.size + x] = list(color)

    def fill_rect(self, x, y, w, h, color, radius=0):
        for py in range(y, y + h):
            for px in range(x, x + w):
                if radius > 0:
                    # Skip outside rounded corners
                    dx = min(px - x, x + w - 1 - px)
                    dy = min(py - y, y + h - 1 - py)
                    if dx < radius and dy < radius:
                        if (radius - dx) ** 2 + (radius - dy) ** 2 > radius ** 2:
                            continue
                self._set(px, py, color)

    def fill_circle(self, cx, cy, r, color):
        r2 = r * r
        for py in range(cy - r, cy + r + 1):
            for px in range(cx - r, cx + r + 1):
                if (px - cx) ** 2 + (py - cy) ** 2 <= r2:
                    self._set(px, py, color)

    def to_png(self):
        rows = []
        for y in range(self.size):
            row = bytearray()
            for x in range(self.size):
                row.extend(self.buf[y * self.size + x])
            rows.append(bytes(row))
        raw = b''.join(b'\x00' + r for r in rows)
        ihdr = struct.pack('>IIBBBBB', self.size, self.size, 8, 2, 0, 0, 0)
        return (
            b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(raw, 6))
            + png_chunk(b'IEND', b'')
        )


def draw_icon(size):
    c = Canvas(size, (17, 17, 17))

    # 10×10 conceptual grid
    GRID = 10
    cell = size / GRID
    seg  = int(cell * 0.76)
    pad  = (cell - seg) / 2
    rad  = max(1, int(seg * 0.22))  # corner radius

    def cx(gx): return int(gx * cell + pad)
    def cy(gy): return int(gy * cell + pad)
    def center(gx, gy): return int((gx + 0.5) * cell), int((gy + 0.5) * cell)

    # Snake path — head at (7,2) facing right, S-curve body
    # Visualization (10×10):
    #   col: 0 1 2 3 4 5 6 7 8 9
    #   row2: . . S S S S S H . F
    #   row3: . . S . . . . S . .
    #   row4: . . S . . . . S . .
    #   row5: . . S S S S S S . .
    segments = [
        (7, 2),                          # head (index 0)
        (6, 2), (5, 2), (4, 2), (3, 2), (2, 2),  # top bar
        (2, 3), (2, 4), (2, 5),          # left side down
        (3, 5), (4, 5), (5, 5), (6, 5), (7, 5),  # bottom bar
        (7, 4), (7, 3),                  # right side up (toward head)
    ]
    food_pos = (9, 2)
    n = len(segments)

    # Draw body tail→neck (so head draws on top)
    for i in range(n - 1, 0, -1):
        t = 1 - (i / n) * 0.52
        g = int(t * 185 + 45)
        c.fill_rect(cx(segments[i][0]), cy(segments[i][1]), seg, seg, (12, g, 12), rad)

    # Head — bright green
    c.fill_rect(cx(segments[0][0]), cy(segments[0][1]), seg, seg, (68, 255, 68), rad)

    # Eyes (head faces right: eyes at upper-right and lower-right of head cell)
    hcx, hcy = center(segments[0][0], segments[0][1])
    eo = int(cell * 0.20)
    er = max(2, int(cell * 0.085))
    c.fill_circle(hcx + eo, hcy - eo, er, (0, 30, 0))
    c.fill_circle(hcx + eo, hcy + eo, er, (0, 30, 0))

    # Food — red circle with shine
    fcx, fcy = center(food_pos[0], food_pos[1])
    fr = int(cell * 0.36)
    c.fill_circle(fcx, fcy, fr, (220, 45, 45))
    shine_r = max(1, fr // 3)
    c.fill_circle(fcx - fr // 3, fcy - fr // 3, shine_r, (255, 185, 185))

    return c.to_png()


if __name__ == '__main__':
    os.makedirs('public/icons', exist_ok=True)
    for size in (192, 512):
        data = draw_icon(size)
        path = f'public/icons/icon-{size}.png'
        with open(path, 'wb') as f:
            f.write(data)
        print(f'  Generated {path} ({len(data):,} bytes)')
    print('  Icons done.')
