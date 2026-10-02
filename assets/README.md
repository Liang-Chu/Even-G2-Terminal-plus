# Shared pixel-arrow icon

`icon-grid.txt` is the approved 12×12 source grid. Each cell becomes one 2×2 block in the 24×24 Even Hub icon. The mark is a single northeast arrow; it contains no π glyph.

Run `node scripts/build-icons.mjs` to generate:

- `assets/icon.svg`: shared manager/Hub artwork, rendered without interpolation.
- `assets/icon-24.png`: 24×24, 1-bit black/white PNG for the Hub icon workflow.
- `apps/windows/desktop/assets/Even-PIlot.ico`: 16, 20, 24, 32, 40, 48, 64 and 256 px Windows images.

The Windows build regenerates and embeds the ICO both as the executable's shell icon and as the tray resource. Windows frames add equal black padding on all four sides. The 16, 20 and 24 px frames align the arrow to whole pixels; larger frames use integer multiples so the diagonal retains even steps. The Hub artwork keeps its full-bleed 12×12 grid, while the web styles add their own padding around the SVG. No runtime image library is needed.

Hub requirements: [official store-icon guidelines](https://hub.evenrealities.com/docs/build/design-guidelines#the-store-icon), checked 2026-09-28. Uploading/drawing the store icon in the Developer Portal is separate from the application's bundled artwork.
