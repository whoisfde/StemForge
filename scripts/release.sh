#!/usr/bin/env bash
# Build StemForge v1.0.3 (license activation gate + a fixed code signature
# that was showing "damaged" to every downloader) and publish a single
# one-click download release on GitHub.
#
# Run this yourself in Terminal, from anywhere:
#   bash ~/Developer/StemForge/scripts/release.sh
#
# It will ask for your updater signing key password interactively — that
# password is never sent anywhere, it stays on this machine.

set -euo pipefail

REPO_DIR="$HOME/Developer/StemForge"
VERSION="1.0.3"
TAG="v${VERSION}"

cd "$REPO_DIR/desktop-app"

echo "== Signing key =="
if [ ! -f "$HOME/.tauri/stemforge-updater.key" ]; then
  echo "ERROR: signing key not found at ~/.tauri/stemforge-updater.key"
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/stemforge-updater.key")"
read -s -p "Updater signing key password: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
echo
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "== Building StemForge ${VERSION} =="
npm run tauri build

BUNDLE_DIR="src-tauri/target/release/bundle/macos"
APP_PATH=$(find "$BUNDLE_DIR" -maxdepth 1 -name "StemForge.app" | head -1)
if [ -z "$APP_PATH" ]; then
  echo "ERROR: no StemForge.app bundle found in $BUNDLE_DIR"
  echo "(if you see a stale desktop-app.app in there too, delete it before re-running --"
  echo " a leftover pre-rebrand bundle can get picked up by mistake)"
  exit 1
fi
echo "Found app bundle: $APP_PATH"

# Tauri's macOS bundler copies bundle.resources (the companion-server dir)
# into Contents/Resources AFTER its own ad-hoc signing pass, which leaves
# the app's CodeResources seal missing/stale. Gatekeeper then treats it as
# a broken signature ("is damaged and can't be opened") instead of merely
# unnotarized, with NO "Open Anyway" override at all. Re-sign after the
# resources are in place so the seal matches what's actually shipped.
echo "== Re-signing app bundle (resources were added after Tauri's own signing pass) =="
codesign --force --deep -s - "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# Tauri's own updater artifacts (from createUpdaterArtifacts: true) -- these
# are what the in-app "Check for Updates" flow actually fetches. Separate
# from the human-facing zip below.
UPDATER_TARBALL=$(find "$BUNDLE_DIR" -maxdepth 1 -name "*.app.tar.gz" | head -1)
UPDATER_SIG=$(find "$BUNDLE_DIR" -maxdepth 1 -name "*.app.tar.gz.sig" | head -1)
if [ -z "$UPDATER_TARBALL" ] || [ -z "$UPDATER_SIG" ]; then
  echo "ERROR: updater artifacts (.app.tar.gz / .sig) not found in $BUNDLE_DIR"
  echo "createUpdaterArtifacts is enabled in tauri.conf.json -- these should"
  echo "always be produced alongside the .app. Check the build log above."
  exit 1
fi
echo "Found updater artifacts: $UPDATER_TARBALL, $UPDATER_SIG"

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SIGNATURE=$(cat "$UPDATER_SIG")
LATEST_JSON="$BUNDLE_DIR/latest.json"
cat > "$LATEST_JSON" << JSONEOF
{
  "version": "${VERSION}",
  "notes": "See https://github.com/whoisfde/StemForge/releases/tag/${TAG}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/whoisfde/StemForge/releases/download/${TAG}/StemForge.app.tar.gz"
    }
  }
}
JSONEOF
echo "Wrote $LATEST_JSON"

WORKDIR=$(mktemp -d)
echo "== Packaging in $WORKDIR =="

# App-only zip (kept as its own asset for the in-app auto-updater)
ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$WORKDIR/StemForge-Desktop-macOS.zip"

# Locate the Premiere plugin .ccx. Check common local spots first; fall back
# to the one already published on the v1.0.0 release if not found locally.
CCX_PATH=""
for candidate in "$HOME/Desktop/171ba11c_premierepro.ccx" "$HOME/Downloads/171ba11c_premierepro.ccx"; do
  if [ -f "$candidate" ]; then
    CCX_PATH="$candidate"
    break
  fi
done
if [ -z "$CCX_PATH" ]; then
  echo "Local .ccx not found — downloading the existing one from the v1.0.0 release..."
  curl -sL -o "$WORKDIR/StemForge-PremierePlugin.ccx" \
    "https://github.com/whoisfde/StemForge/releases/download/v1.0.0/171ba11c_premierepro.ccx"
  CCX_PATH="$WORKDIR/StemForge-PremierePlugin.ccx"
else
  cp "$CCX_PATH" "$WORKDIR/StemForge-PremierePlugin.ccx"
  CCX_PATH="$WORKDIR/StemForge-PremierePlugin.ccx"
fi

# Combined one-click download: app + plugin + a short instructions file,
# all sitting together in one folder once unzipped.
COMBINED_DIR="$WORKDIR/StemForge-${VERSION}"
mkdir -p "$COMBINED_DIR"
cp -R "$APP_PATH" "$COMBINED_DIR/"
cp "$CCX_PATH" "$COMBINED_DIR/StemForge-PremierePlugin.ccx"

cat > "$COMBINED_DIR/READ ME FIRST.txt" << 'EOF'
StemForge — what's in this folder
==================================

Two files, two installs. Do both, either order.

1) StemForge Desktop.app
   The companion app that does the actual audio separation. Drag it to
   Applications and open it. macOS will warn you it can't verify the app
   (it's not yet Apple-notarized) — go to System Settings > Privacy &
   Security, scroll down, and click "Open Anyway". StemForge then runs
   quietly in your menu bar.

2) StemForge-PremierePlugin.ccx
   The panel that shows up inside Premiere Pro. Move this file off your
   Desktop first (Downloads is fine), then double-click it — Creative
   Cloud Desktop installs it automatically. In Premiere: Window > UXP
   Plugins > StemForge.

Full step-by-step instructions (with screenshots of the Gatekeeper
dialogs) are on GitHub:
https://github.com/whoisfde/StemForge/blob/main/INSTALL.md
EOF

OUT_ZIP="$HOME/Desktop/StemForge-${VERSION}.zip"
rm -f "$OUT_ZIP"
ditto -c -k --sequesterRsrc --keepParent "$COMBINED_DIR" "$OUT_ZIP"
echo "Combined download ready: $OUT_ZIP"

echo "== Creating GitHub release ${TAG} =="
cd "$REPO_DIR"
git add desktop-app/package.json desktop-app/src-tauri/tauri.conf.json desktop-app/src-tauri/Cargo.toml
git commit -m "Bump version to ${VERSION}" || true
git tag "$TAG"
git push origin main
git push origin "$TAG"

gh release create "$TAG" \
  "$OUT_ZIP" \
  "$WORKDIR/StemForge-Desktop-macOS.zip" \
  "$UPDATER_TARBALL" \
  "$UPDATER_SIG" \
  "$LATEST_JSON" \
  --title "StemForge ${VERSION}" \
  --notes "License activation gate: the app now requires a valid license key to run, checked on launch and periodically while running, so a revoked purchase actually stops an installed copy. Also fixes a broken code signature that made every download show 'is damaged and can't be opened' instead of the normal Gatekeeper prompt. See INSTALL.md for setup."

echo
echo "Done. One-click download asset:"
echo "https://github.com/whoisfde/StemForge/releases/download/${TAG}/StemForge-${VERSION}.zip"
