# CT45 Computer Link logo

The Clear logo combines barcode bars, a scan frame, and a chain link in white on teal. The opaque master lets Android apply its launcher mask without transparent gaps. The app headers round their image views without changing the artwork.

![CT45 Computer Link logo](ct45-logo.png)

Created October 1, 2026 with the built-in image-generation tool. The final generation prompt is saved in [prompt.txt](prompt.txt). The source image is [ct45-logo.png](ct45-logo.png); production assets are resized copies:

- `desktop/build/icon.png`: 1024px desktop packaging icon.
- `desktop/ui/logo.png`: 256px window and interface icon.
- `android/app/src/main/res/drawable-nodpi/clear_logo.png`: 432px adaptive-launcher and interface artwork. An 11dp launcher inset keeps the complete barcode/link mark within the 66dp adaptive-icon safe circle.

To regenerate these sizes on macOS from the repository root:

```sh
sips -z 1024 1024 docs/branding/ct45-logo.png --out desktop/build/icon.png
sips -z 256 256 docs/branding/ct45-logo.png --out desktop/ui/logo.png
sips -z 432 432 docs/branding/ct45-logo.png --out android/app/src/main/res/drawable-nodpi/clear_logo.png
```

These operations only resize the generated artwork. Electron Builder creates platform icon formats from the desktop packaging PNG. Android's monochrome notification icon remains a simple barcode so it renders correctly in the status bar.
