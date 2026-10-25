#!/usr/bin/env python3
"""
Unified App Store screenshot generator — the playbook for all apps.

Generates optimized marketing screenshots explaining functionality,
following the proven ProTune/OMR pattern:

- 4-5 frames, hero value proposition first
- Large ExtraBold hero text at top of every frame (≤5 words per line)
- Sub-text explaining the functionality
- Brand-consistent colors and styling
- Output: iphone-69 (1320x2868) + ipad-13 (2064x2752), RGB PNG, no alpha

Usage:
    python3 make_screenshots.py --config <app-config.json>

Config JSON format:
{
    "app_name": "My App",
    "output_dir": "docs/asc/screenshots/en-US",
    "source_dir": "docs/asc/screenshots/en-US/source",
    "brand": {
        "bg": [17, 17, 17],
        "accent": [224, 168, 18],
        "ink": [245, 245, 247],
        "muted": [168, 168, 172],
        "card": [26, 26, 29]
    },
    "shots": [
        {
            "slug": "01-hero",
            "hero": "Hero value\\nprop here.",
            "sub": "Supporting explanation text",
            "source": "hero-mockup.png"
        }
    ]
}
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SIZES = {"iphone-69": (1320, 2868), "iphone-65": (1284, 2778)}

_fonts: dict[tuple[int, str], ImageFont.FreeTypeFont] = {}


def font(size: int, weight: str = "ExtraBold") -> ImageFont.FreeTypeFont:
    key = (size, weight)
    if key not in _fonts:
        for path in [
            Path(__file__).parent / "fonts" / f"Inter-{weight}.ttf",
            Path("/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf"),
        ]:
            if path.exists():
                f = ImageFont.truetype(str(path), size)
                if path.suffix == ".ttf" and "Variable" in path.name:
                    try:
                        f.set_variation_by_name(weight)
                    except Exception:
                        pass
                _fonts[key] = f
                return f
        raise FileNotFoundError(f"No font found for {weight}")
    return _fonts[key]


def make_frame(config: dict, shot: dict, device: str, brand: dict) -> Image.Image:
    W, H = SIZES[device]
    bg = tuple(brand["bg"])
    ink = tuple(brand["ink"])
    muted = tuple(brand["muted"])
    accent = tuple(brand["accent"])
    card = tuple(brand["card"])

    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    hero_lines = shot["hero"].split("\\n")
    y = int(H * 0.08)
    for line in hero_lines:
        f = font(int(W * 0.075))
        bbox = d.textbbox((0, 0), line, font=f)
        tw = bbox[2] - bbox[0]
        d.text(((W - tw) // 2, y), line, font=f, fill=ink)
        y += int(W * 0.095)

    if shot.get("sub"):
        f = font(int(W * 0.038), "SemiBold")
        bbox = d.textbbox((0, 0), shot["sub"], font=f)
        tw = bbox[2] - bbox[0]
        d.text(((W - tw) // 2, y + 10), shot["sub"], font=f, fill=muted)
        y += int(W * 0.07)

    src_path = Path(config["source_dir"]) / shot.get("source", "")
    if src_path.exists():
        src = Image.open(src_path).convert("RGB")
        max_w = int(W * 0.85)
        max_h = int(H * 0.55)
        r = min(max_w / src.width, max_h / src.height)
        src = src.resize((int(src.width * r), int(src.height * r)), Image.LANCZOS)
        sx = (W - src.width) // 2
        sy = int(H * 0.32)
        pad = 20
        d.rounded_rectangle(
            [sx - pad, sy - pad, sx + src.width + pad, sy + src.height + pad],
            radius=30, fill=card,
        )
        img.paste(src, (sx, sy))

    bar_h = 8
    d.rectangle([0, H - bar_h, W, H], fill=accent)

    return img


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate App Store screenshots from config")
    ap.add_argument("--config", required=True, help="Path to app config JSON")
    args = ap.parse_args()

    config = json.loads(Path(args.config).read_text())
    brand = config["brand"]
    out_dir = Path(config["output_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    for device in SIZES:
        for shot in config["shots"]:
            frame = make_frame(config, shot, device, brand)
            out_path = out_dir / f"{device}-{shot['slug']}.png"
            frame.save(out_path, optimize=True)
            print(f"  {out_path.name} ({frame.size[0]}x{frame.size[1]})")

    print(f"\nDone: {len(config['shots'])} shots x 2 devices")
    return 0


if __name__ == "__main__":
    sys.exit(main())
