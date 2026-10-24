# Assets

| File | Use |
| --- | --- |
| `icon.svg` | Source artwork (original, 512×512 viewBox, bright theme). Edit this, then regenerate the PNGs. |
| `icon.png` | 512×512 PNG. Referenced by `plugin.json` `interface.logo` and `interface.composerIcon` (square, ≥48×48, ≤4096×4096, <5 MiB per OpenAI's plugin docs). |
| `icon-1024.png` | 1024×1024 PNG for listings that want a larger image. |

Site copies live in `public/` (`icon.svg`, `icon.png`, `apple-touch-icon.png` 180×180, `favicon-32.png`).

Regenerate: `python3 -c "import cairosvg; cairosvg.svg2png(url='icon.svg', write_to='icon.png', output_width=512, output_height=512)"` (repeat for 1024 and the `public/` sizes).

Screenshots are not bundled. If added for submission, OpenAI requires one per starter prompt, exactly 706 px wide and 400–860 px tall.
