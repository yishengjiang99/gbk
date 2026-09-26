#!/usr/bin/env python3
"""Generate synthetic OMR fixtures: MEI -> Verovio SVG -> PNG -> 1280x256 staff crop.

For each fixture the PAGE (input.png) and the GT (expected.notes.csv) come from
the same authored MEI. Oracle tokens come from Python homr's Staff2Score on the
crop. Tier assignment happens afterwards via the omr-test CLI (writer output vs
GT); this script only stages candidates with tier "tbd".
"""
import json
import os
import sys

import cairosvg
import numpy as np
from PIL import Image

sys.path.insert(0, "/home/hatch/workspace/homr-research/homr")
import verovio  # noqa: E402
from homr.transformer.configs import Config  # noqa: E402
from homr.transformer.staff2score import Staff2Score  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures")

MEI_HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
<meiHead><fileDesc><titleStmt><title>{title}</title></titleStmt><pubStmt/></fileDesc></meiHead>
<music><body><mdiv><score>
<scoreDef meter.count="4" meter.unit="4">
<staffGrp{grp_attrs}>
{staff_defs}
</staffGrp>
</scoreDef>
<section>
{measures}
</section>
</score></mdiv></body></music>
</mei>
"""

def note(pname, octv, dur, dots=0, accid=None):
    a = f' accid="{accid}"' if accid else ""
    d = f' dots="{dots}"' if dots else ""
    return f'<note dur="{dur}"{d} pname="{pname}" oct="{octv}"{a}/>'

def rest(dur, dots=0):
    d = f' dots="{dots}"' if dots else ""
    return f'<rest dur="{dur}"{d}/>'

def chord(notes, dur):
    inner = "".join(f'<note pname="{p}" oct="{o}"/>' for p, o in notes)
    return f"<chord dur=\"{dur}\">{inner}</chord>"

def measure(n, *staves):
    inner = "".join(f'<staff n="{i+1}"><layer n="1">{"".join(s)}</layer></staff>' for i, s in enumerate(staves))
    return f"<measure n=\"{n}\">{inner}</measure>"

def mei(title, staff_defs, measures, grp_attrs=""):
    return MEI_HEAD.format(title=title, grp_attrs=grp_attrs, staff_defs=staff_defs,
                           measures="\n".join(measures))

G = '<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>'
F = '<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>'

# (id, title, mei, gt-notes[(tick,pitch,dur,staff)], page_level)
FIXTURES = [
    ("mono.sharps_flats", "Sharps and flats", mei(
        "sharps_flats", G,
        [measure(1, [note("c",4,"4"), note("d",4,"4"), note("e",4,"4"), note("f",4,"4",accid="s")]),
         measure(2, [note("g",4,"4"), note("a",4,"4",accid="f"), note("b",4,"4"), note("c",5,"4")])]),
     [(0,60,480,0),(480,62,480,0),(960,64,480,0),(1440,66,480,0),
      (1920,67,480,0),(2400,68,480,0),(2880,71,480,0),(3360,72,480,0)], False),
    ("mono.rhythms", "Rhythms", mei(
        "rhythms", G,
        [measure(1, [note("c",4,"1")]),
         measure(2, [note("d",4,"2"), note("e",4,"4"), note("f",4,"8"), note("g",4,"16")]),
         measure(3, [note("a",4,"4",dots=1), note("b",4,"8",dots=1), rest("4")])]),
     [(0,60,1920,0),(1920,62,960,0),(2880,64,480,0),(3360,65,240,0),
      (3600,67,120,0),(3720,69,720,0),(4440,71,360,0)], False),
    ("mono.rests", "Rests", mei(
        "rests", G,
        [measure(1, [note("c",4,"4"), rest("4"), note("d",4,"4"), rest("4")]),
         measure(2, [note("e",4,"2"), rest("2")])]),
     [(0,60,480,0),(960,62,480,0),(1920,64,960,0)], False),
    ("poly.chord", "Chords", mei(
        "chord", G,
        [measure(1, [chord([("c",4),("e",4),("g",4)],"4"), chord([("f",4),("a",4),("c",5)],"4"),
                        chord([("g",4),("b",4),("d",5)],"2")])]),
     [(0,60,480,0),(0,64,480,0),(0,67,480,0),
      (480,65,480,0),(480,69,480,0),(480,72,480,0),
      (960,67,960,0),(960,71,960,0),(960,74,960,0)], False),
    ("clefs.bass", "Bass clef scale", mei(
        "bass", G.replace('n="1"', 'n="1"').replace('clef.shape="G" clef.line="2"', 'clef.shape="F" clef.line="4"'),
        [measure(1, [note("c",3,"4"), note("d",3,"4"), note("e",3,"4"), note("f",3,"4")]),
         measure(2, [note("g",3,"4"), note("a",3,"4"), note("b",3,"4"), note("c",4,"4")])]),
     [(0,48,480,0),(480,50,480,0),(960,52,480,0),(1440,53,480,0),
      (1920,55,480,0),(2400,57,480,0),(2880,59,480,0),(3360,60,480,0)], False),
    ("piano.grand", "Grand staff", mei(
        "grand", G + "\n" + F,
        [measure(1, [note("c",4,"4"), note("d",4,"4"), note("e",4,"4"), note("f",4,"4")],
                       [note("c",3,"4"), note("g",2,"4"), note("a",2,"4"), note("e",3,"4")]),
         measure(2, [note("g",4,"4"), note("a",4,"4"), note("b",4,"4"), note("c",5,"4")],
                       [note("f",2,"4"), note("g",2,"4"), note("c",3,"4"), note("c",3,"4")])],
        grp_attrs=' symbol="brace"'),
     [(0,60,480,0),(480,62,480,0),(960,64,480,0),(1440,65,480,0),
      (1920,67,480,0),(2400,69,480,0),(2880,71,480,0),(3360,72,480,0),
      (0,48,480,1),(480,43,480,1),(960,45,480,1),(1440,52,480,1),
      (1920,41,480,1),(2400,43,480,1),(2880,48,480,1),(3360,48,480,1)], True),
]

def render_png(mei_text, page_level):
    tk = verovio.toolkit()
    if page_level:
        tk.setOptions({"pageWidth": 1800, "pageHeight": 1200, "scale": 55})
    else:
        tk.setOptions({"pageWidth": 2600, "pageHeight": 700, "scale": 55, "adjustPageHeight": True})
    tk.loadData(mei_text)
    return cairosvg.svg2png(bytestring=tk.renderToSVG(1).encode("utf-8"))

def staff_crop(png_bytes):
    rgba = Image.open(__import__("io").BytesIO(png_bytes)).convert("RGBA")
    # cairosvg renders a transparent background; composite onto white first
    # (a naive .convert("L") would turn transparency into black).
    img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("L")
    arr = np.array(img)
    ys, xs = np.where(arr < 200)
    pad = 30
    x0, x1 = max(0, xs.min()-pad), min(img.width, xs.max()+pad)
    y0, y1 = max(0, ys.min()-pad), min(img.height, ys.max()+pad)
    crop = img.crop((x0, y0, x1, y1))
    scale = 1280 / crop.width
    nh = int(crop.height * scale)
    if nh > 256:  # unusually tall: fit height instead
        scale = 256 / crop.height
        nw = int(crop.width * scale)
        resized = crop.resize((nw, 256), Image.LANCZOS)
        canvas = Image.new("L", (1280, 256), 255)
        canvas.paste(resized, ((1280-nw)//2, 0))
    else:
        resized = crop.resize((1280, nh), Image.LANCZOS)
        canvas = Image.new("L", (1280, 256), 255)
        canvas.paste(resized, (0, (256-nh)//2))
    return canvas

def main():
    os.makedirs(OUT, exist_ok=True)
    model = Staff2Score(Config())
    for fid, title, mei_text, gt, page_level in FIXTURES:
        d = os.path.join(OUT, fid)
        os.makedirs(d, exist_ok=True)
        png = render_png(mei_text, page_level)
        if page_level:
            rgba = Image.open(__import__("io").BytesIO(png)).convert("RGBA")
            page = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("L")
            page.save(os.path.join(d, "input.png"))
            oracle = None
        else:
            crop = staff_crop(png)
            crop.save(os.path.join(d, "input.png"))
            syms = model.predict(np.array(crop))
            oracle = [{"rhythm": s.rhythm, "pitch": s.pitch, "lift": s.lift,
                       "articulation": s.articulation, "slur": s.slur,
                       "position": s.position} for s in syms]
            with open(os.path.join(d, "oracle.tokens.json"), "w") as f:
                json.dump(oracle, f, indent=1)
        with open(os.path.join(d, "expected.notes.csv"), "w") as f:
            f.write("tick,pitch,duration,staff\n")
            for t, p, dur, s in gt:
                f.write(f"{t},{p},{dur},{s}\n")
        meta = {
            "id": fid, "description": title, "source": "verovio MEI (authored for this fixture)",
            "license": "CC0",
            "match_tier": "tbd",
            "input": "full page PNG (grayscale)" if page_level else "staff crop PNG 1280x256 grayscale (encoder input)",
        }
        with open(os.path.join(d, "meta.yaml"), "w") as f:
            for k, v in meta.items():
                f.write(f"{k}: {v}\n")
        n = len(oracle) if oracle else -1
        print(f"{fid}: input.png written, oracle symbols={n}, gt notes={len(gt)}")
        if oracle:
            print("   rhythms:", [s["rhythm"] for s in oracle][:12])

if __name__ == "__main__":
    main()
