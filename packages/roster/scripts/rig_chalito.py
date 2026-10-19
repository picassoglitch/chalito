#!/usr/bin/env python3
"""Cuts the default Chalito card into rig parts (no new art, no paid generation).

Every part is a full-card canvas (566x952, transparent outside the part) so renderers place it
exactly like the drawing and only need the pivot. Run from the repo root:

    python3 packages/roster/scripts/rig_chalito.py

Needs Pillow only. Writes assets/chalito/rig-*.webp and the "rig" block of card.json.
"""
import json
import math
import os

from PIL import Image, ImageDraw, ImageFilter

DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "chalito")
W, H = 566, 952

# Hand-picked from the neutral drawing (card pixels).
ARM_L = [(140, 505), (178, 500), (178, 545), (168, 600), (160, 650), (152, 700), (152, 745), (135, 762),
         (98, 762), (82, 730), (82, 690), (88, 640), (104, 580), (124, 530)]
ARM_R = [(345, 500), (390, 505), (430, 560), (458, 620), (464, 665), (454, 720), (452, 745), (430, 764),
         (393, 760), (388, 725), (378, 700), (358, 662), (341, 620), (334, 570), (339, 530)]
PIVOT_L = (168, 520)
PIVOT_R = (352, 520)
# The head is everything above the jaw line, plus the hair that falls past it on the right.
HEAD_CUT_Y = 455
HAIR_RIGHT = [(360, 400), (470, 400), (470, 480), (360, 470)]
NECK = (283, 455)
# Eyes (ellipses that cover lashes and whites) and where the closed lid line runs.
EYES = [
    {"box": (134, 292, 206, 370), "line": [(141, 338), (171, 349), (202, 337)]},
    {"box": (274, 289, 360, 368), "line": [(281, 335), (318, 348), (356, 333)]},
]
MOUTH = {"c": (243, 400), "r": (19, 12)}
HEADS = ["neutral", "happy", "sad", "tired"]  # surprised holds its face with both hands: not cut
# Below this line only the chin and neck belong to the head (happy raises its fists up there).
HEAD_SIDES_Y = 420
CHIN_X = (150, 420)
OVERLAP = 25  # the body keeps this band under the head so a tilt never shows a gap
# The sad drawing has pointed ears; its head takes the round ones (and the hair around them) from
# the tired drawing, which lines up with it.
HEAD_PATCHES = {
    "sad": [
        ("tired", [(58, 345), (128, 345), (128, 418), (58, 418)]),
        ("tired", [(372, 326), (486, 326), (486, 402), (372, 402)]),
    ],
}


def load(name):
    return Image.open(os.path.join(DIR, f"layer-{name}.webp")).convert("RGBA")


def poly_mask(points, blur=0):
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur)) if blur else m


def head_mask(name):
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    d.rectangle([0, 0, W, HEAD_SIDES_Y], fill=255)
    d.rectangle([CHIN_X[0], HEAD_SIDES_Y, CHIN_X[1], HEAD_CUT_Y], fill=255)
    if name != "happy":
        d.polygon(HAIR_RIGHT, fill=255)
    return m


def fill_hole(img, hole, keep_band):
    """Fills `hole` pixels by diffusing the surrounding opaque colours in, then keeps them opaque
    only within `keep_band` (the part of the hole that lies over the torso), with an outline."""
    px = img.load()
    hm = hole.load()
    band = keep_band.load()
    todo = [(x, y) for y in range(H) for x in range(W) if hm[x, y] > 127]
    known = {}
    for x, y in todo:
        px[x, y] = (0, 0, 0, 0)
    for _ in range(60):
        nxt = {}
        for x, y in todo:
            if (x, y) in known:
                continue
            acc = [0, 0, 0]
            n = 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                qx, qy = x + dx, y + dy
                if 0 <= qx < W and 0 <= qy < H:
                    c = known.get((qx, qy))
                    if c is None and hm[qx, qy] <= 127:
                        q = px[qx, qy]
                        c = q[:3] if q[3] > 200 and sum(q[:3]) > 300 else None
                    if c is not None:
                        acc = [acc[i] + c[i] for i in range(3)]
                        n += 1
            if n:
                nxt[(x, y)] = tuple(v // n for v in acc)
        if not nxt:
            break
        known.update(nxt)
    for (x, y), c in known.items():
        if band[x, y] > 127:
            px[x, y] = (*c, 255)
    # A dark edge where the filled torso meets the transparent area.
    edge = Image.new("L", (W, H), 0)
    ep = edge.load()
    for x, y in todo:
        if band[x, y] > 127 and px[x, y][3] == 255:
            for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
                qx, qy = x + dx, y + dy
                if 0 <= qx < W and 0 <= qy < H and px[qx, qy][3] == 0:
                    ep[x, y] = 255
    edge = edge.filter(ImageFilter.MaxFilter(3))
    dark = Image.new("RGBA", (W, H), (61, 26, 20, 255))
    img.paste(dark, (0, 0), edge)
    return img


def cut(src, mask):
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(src, (0, 0), mask)
    # The source's own alpha still applies inside the mask.
    a = Image.composite(src.getchannel("A"), Image.new("L", (W, H), 0), mask)
    out.putalpha(a)
    return out


def torso_band(arm, toward_x):
    """The slice of an arm's hole that covers the torso: within ~24px of the arm's inner edge."""
    m = Image.new("L", (W, H), 0)
    xs = [p[0] for p in arm]
    inner = max(xs) if toward_x > sum(xs) / len(xs) else min(xs)
    d = ImageDraw.Draw(m)
    if toward_x > inner:
        d.rectangle([inner - 26, 0, W, H], fill=255)
    else:
        d.rectangle([0, 0, inner + 26, H], fill=255)
    return m


def is_skin(c):
    r, g, b, a = c
    return a > 200 and r > 235 and 185 < g < 225 and 150 < b < 200


def lids(neutral):
    """Closed eyes: each eye's box painted over with the face's own skin (per row, from the pixels
    just left and right of it) and a closed lash line drawn across."""
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = neutral.load()
    for eye in EYES:
        x0, y0, x1, y1 = eye["box"]

        def near(y):
            got = [px[x, y] for x in list(range(x0 - 8, x0)) + list(range(x1 + 1, x1 + 9))]
            return [c for c in got if c[3] > 200 and sum(c[:3]) / 3 > 170 and c[1] < 245]

        rows = {y: near(y) for y in range(y0 - 6, y1 + 7)}
        allc = [c for v in rows.values() for c in v] or [(253, 208, 175, 255)]
        avg = lambda cs: tuple(sum(c[i] for c in cs) // len(cs) for i in range(3))
        base = avg(allc)
        skin = Image.new("RGBA", (W, H), (*base, 0))
        sp = skin.load()
        for y in range(y0 - 6, y1 + 7):
            # Each row blends its left and right neighbours, so the patch follows the shading.
            left = [c for c in rows[y] if True][: max(1, len(rows[y]) // 2)] or allc
            right = rows[y][len(rows[y]) // 2 :] or allc
            a, b = avg(left), avg(right)
            for x in range(x0 - 6, x1 + 7):
                t = (x - x0 + 6) / max(1, x1 - x0 + 12)
                sp[x, y] = (*(int(a[i] * (1 - t) + b[i] * t) for i in range(3)), 255)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x1, y1], radius=18, fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(3))
        skin.putalpha(mask)
        out = Image.alpha_composite(out, skin)
        d = ImageDraw.Draw(out)
        d.line(eye["line"], fill=(61, 26, 20, 255), width=5, joint="curve")
    # Transparent pixels keep the skin colour, so filtering at the edges never darkens them.
    return out


def mouth():
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(out)
    (cx, cy), (rx, ry) = MOUTH["c"], MOUTH["r"]
    d.ellipse([cx - rx - 2, cy - ry - 2, cx + rx + 2, cy + ry + 2], fill=(61, 26, 20, 255))
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(122, 40, 36, 255))
    d.ellipse([cx - rx * 0.6, cy, cx + rx * 0.6, cy + ry], fill=(226, 120, 112, 255))
    return out


def main():
    neutral = load("neutral")
    files = {}

    arm_l = cut(neutral, poly_mask(ARM_L))
    arm_r = cut(neutral, poly_mask(ARM_R))
    files["rig-arm-l.webp"] = arm_l
    files["rig-arm-r.webp"] = arm_r

    body = neutral.copy()
    hole = Image.new("L", (W, H), 0)
    hole.paste(255, (0, 0), poly_mask(ARM_L))
    hole.paste(255, (0, 0), poly_mask(ARM_R))
    band = Image.new("L", (W, H), 0)
    band.paste(255, (0, 0), Image.composite(torso_band(ARM_L, 283), Image.new("L", (W, H), 0), poly_mask(ARM_L)))
    band.paste(255, (0, 0), Image.composite(torso_band(ARM_R, 283), Image.new("L", (W, H), 0), poly_mask(ARM_R)))
    body = fill_hole(body, hole, band)
    # The body keeps only a band under the head line (the head covers it).
    keep = Image.new("L", (W, H), 255)
    ImageDraw.Draw(keep).rectangle([0, 0, W, HEAD_CUT_Y - OVERLAP], fill=0)
    body.putalpha(Image.composite(body.getchannel("A"), Image.new("L", (W, H), 0), keep))
    files["rig-body.webp"] = body

    for name in HEADS:
        src = load(name)
        for other, poly in HEAD_PATCHES.get(name, []):
            src.paste(load(other), (0, 0), poly_mask(poly, blur=1.5))
        files[f"rig-head-{name}.webp"] = cut(src, head_mask(name))
    files["rig-lids.webp"] = lids(neutral)
    files["rig-mouth.webp"] = mouth()

    for name, img in files.items():
        img.save(os.path.join(DIR, name), "WEBP", quality=90, method=6)

    p = lambda xy: [round(xy[0] / W, 4), round(xy[1] / H, 4)]
    rig = {
        "v": 1,
        "parts": [
            {"id": "body", "src": "rig-body.webp", "pivot": [0.5, 0.97], "z": 0},
            {"id": "armL", "src": "rig-arm-l.webp", "pivot": p(PIVOT_L), "z": 1},
            {"id": "armR", "src": "rig-arm-r.webp", "pivot": p(PIVOT_R), "z": 1},
            {
                "id": "head",
                "src": {n: f"rig-head-{n}.webp" for n in HEADS},
                "pivot": p(NECK),
                "z": 2,
            },
            {"id": "lids", "src": "rig-lids.webp", "parent": "head", "pivot": p(NECK), "z": 3, "only": ["neutral"]},
            {
                "id": "mouth",
                "src": "rig-mouth.webp",
                "parent": "head",
                "pivot": p(MOUTH["c"]),
                "z": 3,
                "only": ["neutral"],
            },
        ],
    }
    card_path = os.path.join(DIR, "card.json")
    with open(card_path) as f:
        card = json.load(f)
    card["rig"] = rig
    with open(card_path, "w") as f:
        json.dump(card, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", ", ".join(sorted(files)))


if __name__ == "__main__":
    main()
