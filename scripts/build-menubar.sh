#!/bin/zsh
# Builds the native Swift menu-bar app: release/cadSlop Menu.app
set -euo pipefail
cd "$(dirname "$0")/.."
APP="release/cadSlop Menu.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macos13.0" -framework AppKit menubar/CadSlopMenu.swift -o "$APP/Contents/MacOS/cadSlop Menu"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>cadSlop Menu</string>
  <key>CFBundleDisplayName</key><string>cadSlop Menu</string>
  <key>CFBundleIdentifier</key><string>com.cadslop.menu</string>
  <key>CFBundleExecutable</key><string>cadSlop Menu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built: $APP"
