# Silent auto-update (GitHub Releases)

The kiosk checks **GitHub Releases** on the `gostationery/gostationary_kiosk_electron` repo and installs updates in the background (no AppImage).

## Supported installs

| Device / OS | Install package | Architecture |
|-------------|-----------------|--------------|
| Ubuntu (desktop/server) | `.deb` | `amd64` (x64) |
| Fedora | `.rpm` | `x86_64` (x64) |
| Raspberry Pi 4 (64-bit OS) | `.deb` | `arm64` |
| Raspberry Pi 3 (64-bit OS) | `.deb` | `arm64` |

**Raspberry Pi 3/4 must use a 64-bit OS** (Raspberry Pi OS 64-bit or Ubuntu 64-bit). Electron does not ship 32-bit ARM (`armhf`) builds.

## First install (manual)

Download the matching asset from the latest [GitHub Release](https://github.com/gostationery/gostationary_kiosk_electron/releases):

```bash
# Ubuntu / Pi (64-bit) — pick the arm64 or amd64 .deb from the release page
sudo dpkg -i "GoStationary Kiosk_1.0.0_amd64.deb"
sudo apt-get install -f -y

# Fedora — pick x86_64 or aarch64 .rpm
sudo dnf install ./GoStationary\ Kiosk-1.0.0.x86_64.rpm
```

After that, the app updates itself from GitHub when a newer tag is published.

## Publishing a release

1. Bump `version` in `package.json`.
2. Commit and push a tag: `git tag v1.0.1 && git push origin v1.0.1`
3. GitHub Actions builds `deb` + `rpm` for **x64** and **arm64** on Ubuntu runners and publishes one release with all assets plus `latest-linux*.yml` metadata.

Requires `contents: write` on `GITHUB_TOKEN` (default for Actions).

Requires **electron-builder ≥ 26** (bundles `fpm` 1.17+, compatible with Fedora’s `rpmbuild` 6.x). On older electron-builder versions, `npm run build:linux:rpm` fails on Fedora 41+ with empty BUILDROOT errors.

## Silent install without prompts (kiosk deployments)

`.deb` updates run `dpkg` and may ask for a password via PolicyKit. For unattended kiosks:

1. Run the app under a dedicated user (e.g. `kiosk`).
2. Optionally install the sudoers snippet (edit the username first):

   ```bash
   sudo install -m 440 packaging/sudoers.d/gostationary-kiosk-updater /etc/sudoers.d/gostationary-kiosk-updater
   sudo visudo -c
   ```

3. Updater logs: `~/.config/gostationary-kiosk/logs/updater.log` (path may vary slightly by distro).

## Local testing

```bash
npm install
# dev-app-update.yml points at GitHub; force updater in dev:
# in auto-updater.js temporarily set autoUpdater.forceDevUpdateConfig = true
```

Production updates only run when the app is **installed from a built** `.deb` / `.rpm`, not `npm start`.
