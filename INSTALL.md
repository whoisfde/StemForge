# Installing StemForge

StemForge has two parts you need to install: the desktop companion app (does the actual audio processing) and the Premiere Pro plugin (the panel you use inside Premiere). Install both, in either order, but start the companion app at least once before using the plugin.

## 1. Install the desktop companion app

StemForge isn't yet signed with an Apple Developer certificate, so macOS Gatekeeper will warn you the first time you open it. This is expected — here's how to get past it:

1. Download and double-click the StemForge app.
2. macOS will show a dialog saying it can't verify the app is free of malware, with only "Done" or "Move to Trash" as options. Click **Done** (don't trash it).
3. Open **System Settings → Privacy & Security**.
4. Scroll down — you'll see a message that StemForge was blocked, with an **Open Anyway** button. Click it.
5. Confirm with your Mac password or Touch ID.
6. StemForge will launch and appear as an icon in your menu bar. On first launch it downloads its audio-separation model (~80MB, takes a few seconds to a minute depending on your connection) — the menu bar icon shows its status while this happens.

StemForge is set to start automatically when you log in, so you normally only do this once.

## 2. Install the Premiere Pro plugin

1. Download the `.ccx` plugin file. **Don't leave it on your Desktop** — move it to your Downloads folder first, or double-clicking it can fail with an extraction error. (Anywhere except Desktop works fine.)
2. Double-click the `.ccx` file. Creative Cloud Desktop will open automatically and show "Install a non-marketplace plugin."
3. Click **Install**.
4. Click **OK** on the permissions notice.
5. Enter your Mac admin password when prompted.
6. You'll see a confirmation: "StemForge is now installed. Find it under the Plugins Menu in Premiere."

## 3. Open the plugin in Premiere Pro

1. Open Premiere Pro.
2. Go to **Window → UXP Plugins → StemForge**. (Not "Extensions" — that menu is for older-style plugins; StemForge lives under UXP Plugins.)
3. The panel opens. If the status dot is red/offline, make sure the StemForge companion app is running (check your menu bar) — it should already be running from step 1.

## Troubleshooting

- **".ccx won't open, error code -3"** — the file is likely still on your Desktop. Move it to Downloads (or anywhere else) and double-click it from there.
- **Plugin panel shows "offline"** — the companion app isn't running. Check the menu bar for the StemForge icon; if it's missing, relaunch the app (you may need to repeat the Gatekeeper steps above once more).
- **Gatekeeper won't let you open the app at all** — make sure you're clicking Open Anyway in System Settings → Privacy & Security within a few minutes of the first blocked attempt; the option disappears after a while and you'll need to try opening the app again to make it reappear.
