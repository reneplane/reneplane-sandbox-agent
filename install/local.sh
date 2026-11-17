#!/bin/sh
# Reneplane Local installer for macOS and Linux. Served by get.reneplane.com with your one-time token:
#   curl -fsSL "https://get.reneplane.com/local?t=<token>" | sh
# Installs into ~/.reneplane (no sudo), pairs with your browser, starts at login.
set -eu

TOKEN='__RENEPLANE_TOKEN__'
GET_URL='__RENEPLANE_GET_URL__'
RELEASE='__RENEPLANE_RELEASE_URL__'

fail() {
  printf '\nReneplane Local could not be installed: %s\n' "$1" >&2
  printf 'Copy a fresh command from the workspace and try again.\n' >&2
  exit 1
}

echo 'Installing Reneplane Local...'
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "$(uname -s) is not supported yet." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "$(uname -m) processors are not supported yet." ;;
esac
if [ "$os" = linux ] && [ "$arch" = arm64 ]; then fail 'Linux on Arm is not supported yet.'; fi

asset="reneplane-local-$os-$arch.tar.gz"
home_dir="${HOME}/.reneplane"
bin="$home_dir/bin"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT

echo '  Downloading...'
curl -fsSL "$RELEASE/$asset" -o "$temp/$asset" || fail 'the download failed. Check your internet connection.'
curl -fsSL "$RELEASE/SHA256SUMS" -o "$temp/SHA256SUMS" || fail 'the checksum download failed.'
expected="$(grep " $asset\$" "$temp/SHA256SUMS" | awk '{print $1}')"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$temp/$asset" | awk '{print $1}')"
else actual="$(shasum -a 256 "$temp/$asset" | awk '{print $1}')"; fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail 'the download did not match its checksum.'

echo '  Unpacking...'
mkdir -p "$temp/release"
tar -xzf "$temp/$asset" -C "$temp/release"
version="$(tr -d '[:space:]' < "$temp/release/app/VERSION")"

# An older Reneplane Local may be running: stop it so its files can be replaced
if [ -x "$bin/node" ] && [ -f "$bin/launch.mjs" ]; then "$bin/node" "$bin/launch.mjs" stop >/dev/null 2>&1 || true; fi

mkdir -p "$bin"
cp "$temp/release/node" "$bin/node.new" && mv -f "$bin/node.new" "$bin/node"
chmod +x "$bin/node"
cp "$temp/release/launch.mjs" "$bin/launch.mjs"
rm -rf "$bin/app-$version"
cp -R "$temp/release/app" "$bin/app-$version"
printf '{"version":"%s"}' "$version" > "$bin/current.json"

echo "  Pairing with your browser and starting Reneplane Local $version..."
"$bin/node" "$bin/launch.mjs" setup --token "$TOKEN" --get "$GET_URL" || fail 'setup did not finish.'
printf '\nGo back to the workspace tab and click Allow if your browser asks.\n'
