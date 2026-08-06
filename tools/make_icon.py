#!/usr/bin/env python3
"""Generate the Thinking Break marketplace icon.

Draws the same crosshair-on-gradient mark as assets/favicon.svg, but as a PNG,
because VS Code extension manifests require a raster icon. Dependency-free
(zlib + struct only) so it runs anywhere Python 3 does.

Usage:  python3 tools/make_icon.py
"""

import math
import os
import struct
import zlib

SIZE = 256
OUT = os.path.join(os.path.dirname(__file__), "..", "extensions", "claude", "icon.png")

# Brand gradient endpoints (--accent → --accent-hi).
C0 = (0x3D, 0x52, 0xF0)
C1 = (0x66, 0x78, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF)
CORNER_RADIUS = SIZE * 15 / 64  # matches the favicon's rx


def lerp(a, b, t):
    return a + (b - a) * t


def blend(dst, src, alpha):
    return tuple(int(round(lerp(dst[i], src[i], alpha))) for i in range(3))


def coverage(distance, edge, softness=1.0):
    """Antialiased coverage for a signed distance to an edge."""
    return max(0.0, min(1.0, 0.5 - (distance - edge) / (2.0 * softness)))


def rounded_rect_alpha(x, y):
    """Alpha of a rounded square covering the whole canvas."""
    r = CORNER_RADIUS
    cx = min(max(x, r), SIZE - r)
    cy = min(max(y, r), SIZE - r)
    d = math.hypot(x - cx, y - cy)
    return coverage(d, r)


def build_rows():
    center = SIZE / 2.0
    ring_radius = SIZE * 15 / 64.0
    ring_width = SIZE * 3.5 / 64.0 / 2
    dot_radius = SIZE * 4 / 64.0
    tick_half = SIZE * 1.75 / 64.0
    tick_inner = SIZE * 9 / 64.0
    tick_outer = SIZE * 27 / 64.0

    rows = []
    for py in range(SIZE):
        row = bytearray()
        y = py + 0.5
        for px in range(SIZE):
            x = px + 0.5

            base = blend(C0, C1, (x / SIZE + y / SIZE) / 2.0)
            color = base

            dx, dy = x - center, y - center
            dist = math.hypot(dx, dy)

            # Ring.
            ring_alpha = coverage(abs(dist - ring_radius), ring_width)
            if ring_alpha > 0:
                color = blend(color, WHITE, ring_alpha * 0.95)

            # Four ticks.
            for adx, ady in ((abs(dx), abs(dy)), (abs(dy), abs(dx))):
                if ady <= tick_half and tick_inner <= adx <= tick_outer:
                    edge = min(tick_half - ady, adx - tick_inner, tick_outer - adx)
                    color = blend(color, WHITE, min(1.0, edge + 0.5))

            # Centre dot.
            dot_alpha = coverage(dist, dot_radius)
            if dot_alpha > 0:
                color = blend(color, WHITE, dot_alpha)

            a = int(round(255 * rounded_rect_alpha(x, y)))
            row += bytes((color[0], color[1], color[2], a))
        rows.append(bytes(row))
    return rows


def write_png(path, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    target = os.path.normpath(OUT)
    write_png(target, build_rows())
    print(f"wrote {target} ({SIZE}x{SIZE})")
