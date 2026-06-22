#!/usr/bin/env bash
# One-command Wove release: build → (Gradle auto-signs) → publish GitHub release → update latest.json.
#
#   1. Bump APP_VERSION in src/lib/changelog.ts (+ package.json / src-tauri/tauri.conf.json) and add a
#      CHANGELOG entry.
#   2. Run:  scripts/release.sh            (version read from changelog.ts)
#      or:   scripts/release.sh 0.2.0 "Faster scrolling, fixes"
#
# Needs: the dedicated keystore wired via gen/android/keystore.properties, and `gh` logged in as SettDEF.
set -euo pipefail
cd "$(dirname "$0")/.."                                  # → wavr-play

VER="${1:-$(grep -oP 'APP_VERSION\s*=\s*"\K[^"]+' src/lib/changelog.ts)}"
NOTES="${2:-See the in-app “What’s new”.}"
RELEASES_REPO="SettDEF/Wove-releases"
TAG="v${VER}"
APK="Wove-${VER}.apk"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$HOME"/Android/Sdk/ndk/* 2>/dev/null | tail -1)}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"

echo "▶ Building signed release v$VER (target aarch64)…"
npx tauri android build --apk --target aarch64

SIGNED="$(ls -t src-tauri/gen/android/app/build/outputs/apk/*/release/*release.apk 2>/dev/null | grep -v unsigned | head -1 || true)"
[ -n "$SIGNED" ] && [ -f "$SIGNED" ] || { echo "✗ Signed APK not found — is gen/android/keystore.properties set up?"; exit 1; }
cp "$SIGNED" "/tmp/$APK"
echo "▶ Verifying signature…"; "$APKSIGNER" verify "/tmp/$APK" >/dev/null && echo "  ✓ signed"

echo "▶ Publishing $TAG → $RELEASES_REPO…"
if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "/tmp/$APK" --repo "$RELEASES_REPO" --clobber
else
  gh release create "$TAG" "/tmp/$APK" --repo "$RELEASES_REPO" --title "Wove $VER" --notes "$NOTES"
fi

echo "▶ Updating latest.json…"
TMP="$(mktemp -d)"; git clone -q "https://github.com/$RELEASES_REPO.git" "$TMP/r"
printf '{\n  "version": "%s",\n  "notes": "%s",\n  "url": "https://github.com/%s/releases/download/%s/%s"\n}\n' \
  "$VER" "$NOTES" "$RELEASES_REPO" "$TAG" "$APK" > "$TMP/r/latest.json"
git -C "$TMP/r" add latest.json
git -C "$TMP/r" -c user.name="SettDEF" -c user.email="hei.s.fue@gmail.com" commit -q -m "latest.json → v$VER" 2>/dev/null || true
git -C "$TMP/r" push -q origin HEAD
rm -rf "$TMP"

echo "✅ Released Wove $VER"
echo "   https://github.com/$RELEASES_REPO/releases/tag/$TAG"
