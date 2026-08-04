#!/usr/bin/env bash
#
# Build pi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   packages/coding-agent/binaries/
#     pi-darwin-arm64.tar.gz
#     pi-darwin-x64.tar.gz
#     pi-linux-x64.tar.gz
#     pi-linux-arm64.tar.gz
#     pi-windows-x64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64"
            exit 1
            ;;
    esac
fi

echo "==> Installing dependencies..."
npm ci

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    # npm ci only installs optional deps for the current platform
    # We need all platform bindings for bun cross-compilation
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    # Install all in one command to avoid npm removing packages from previous installs
    npm install --no-save --force \
        @mariozechner/clipboard-darwin-arm64@0.3.0 \
        @mariozechner/clipboard-darwin-x64@0.3.0 \
        @mariozechner/clipboard-linux-x64-gnu@0.3.0 \
        @mariozechner/clipboard-linux-arm64-gnu@0.3.0 \
        @mariozechner/clipboard-win32-x64-msvc@0.3.0 \
        @img/sharp-darwin-arm64@0.34.5 \
        @img/sharp-darwin-x64@0.34.5 \
        @img/sharp-linux-x64@0.34.5 \
        @img/sharp-linux-arm64@0.34.5 \
        @img/sharp-win32-x64@0.34.5 \
        @img/sharp-libvips-darwin-arm64@1.2.4 \
        @img/sharp-libvips-darwin-x64@1.2.4 \
        @img/sharp-libvips-linux-x64@1.2.4 \
        @img/sharp-libvips-linux-arm64@1.2.4
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

echo "==> Building all packages..."
npm run build

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Externalize koffi to avoid embedding all 18 platform .node files (~74MB)
    # into every binary. Koffi is only used on Windows for VT input and the
    # call site has a try/catch fallback. For Windows builds, we copy the
    # appropriate .node file alongside the binary below.
    if [[ "$platform" == "windows-x64" ]]; then
        bun build --compile --external koffi --external playwright-core --external chromium-bidi --target=bun-$platform ./dist/cli.js --outfile binaries/$platform/pi.exe
    else
        bun build --compile --external koffi --external playwright-core --external chromium-bidi --target=bun-$platform ./dist/cli.js --outfile binaries/$platform/pi
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    cp -r dist/core/export-html binaries/$platform/
    cp -r docs binaries/$platform/
    cp -r examples binaries/$platform/

    # Playwright's package-root lookup needs its package metadata at runtime;
    # keep browser machinery external and ship the exact locked packages.
    mkdir -p binaries/$platform/node_modules
    cp -r ../../node_modules/playwright-core binaries/$platform/node_modules/
    cp -r ../../node_modules/chromium-bidi binaries/$platform/node_modules/

    # Copy koffi native module for Windows (needed for VT input support)
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p binaries/$platform/node_modules/koffi/build/koffi/win32_x64
        cp ../../node_modules/koffi/index.js binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/package.json binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/build/koffi/win32_x64/koffi.node binaries/$platform/node_modules/koffi/build/koffi/win32_x64/
    fi
done

# Create archives
cd binaries

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip)
        echo "Creating pi-$platform.zip..."
        node ../../../scripts/create-zip.mjs --source "$platform" --output "pi-$platform.zip"
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating pi-$platform.tar.gz..."
        mv $platform pi && tar -czf pi-$platform.tar.gz pi && mv pi $platform
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p "$platform" && node ../../../scripts/extract-zip.mjs --archive "pi-$platform.zip" --destination "$platform"
    else
        tar -xzf pi-$platform.tar.gz && mv pi $platform
    fi
done

# Validate every extracted executable before packaging release metadata.
echo "==> Running binary smoke tests..."
HOST_PLATFORM=""
case "$(uname -s)" in
    Linux)
        case "$(uname -m)" in
            x86_64) HOST_PLATFORM="linux-x64" ;;
            aarch64|arm64) HOST_PLATFORM="linux-arm64" ;;
        esac
        ;;
    Darwin)
        case "$(uname -m)" in
            x86_64) HOST_PLATFORM="darwin-x64" ;;
            arm64|aarch64) HOST_PLATFORM="darwin-arm64" ;;
        esac
        ;;
    MINGW*|MSYS*|CYGWIN*) HOST_PLATFORM="windows-x64" ;;
esac
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" != "$HOST_PLATFORM" ]]; then
        if [[ "$platform" == "windows-x64" ]]; then
            test -f "$platform/pi.exe"
        else
            test -f "$platform/pi"
        fi
        echo "Skipping $platform execution on $(uname -s)/$(uname -m); host smoke target is $HOST_PLATFORM."
        continue
    fi
    if [[ "$platform" == "windows-x64" ]]; then
        executable="$platform/pi.exe"
    else
        executable="$platform/pi"
    fi
    (cd "$platform" && "./$(basename "$executable")" --version)
    (cd "$platform" && "./$(basename "$executable")" --help >/dev/null)
    (cd "$platform" && "./$(basename "$executable")" eval packs --json >/dev/null)
    (cd "$platform" && "./$(basename "$executable")" eval validate --json >/dev/null)
    # REAL SANDBOX CANDIDATE EVALUATION — not just a --version smoke. The
    # trusted launcher must be able to spawn a sandboxed candidate and the
    # artifact verdict must be pass with process exit 0. Failure here aborts
    # the build BEFORE any asset is packaged or uploaded.
    sandbox_json="$platform/sandbox.json"
    sandbox_rc=0
    if ! (cd "$platform" && "./$(basename "$executable")" eval run release-acceptance --mode sandbox --json > sandbox.json 2>&1); then
        sandbox_rc=$?
    fi
    verdict="$(node -e 'const fs=require("node:fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const ok=d.artifacts&&d.artifacts.length>0&&d.artifacts.every((a)=>a.verdict==="pass");process.stdout.write(ok?"pass":"not-pass");}catch{process.stdout.write("parse-error")}' "$sandbox_json" 2>/dev/null || echo parse-error)"
    if [[ "$sandbox_rc" != "0" || "$verdict" != "pass" ]]; then
        echo "SANDBOX ACCEPTANCE FAILED for $executable (exit=$sandbox_rc verdict=$verdict) — refusing to package/upload" >&2
        cat "$sandbox_json" >&2 || true
        exit 1
    fi
    rm -f "$sandbox_json"
    (cd "$platform" && "./$(basename "$executable")" doctor eval --json >/dev/null)
done

node ../../../scripts/create-binary-manifest.mjs \
    --directory . \
    --output binary-manifest.json \
    --version "$(node -p 'require("../package.json").version')" \
    --commit "${JENSEN_BINARY_COMMIT:-$(git rev-parse HEAD)}"
CHECKSUM_FILES=()
for archive in *.tar.gz *.zip; do
    if [[ -f "$archive" ]]; then
        CHECKSUM_FILES+=("$archive")
    fi
done
sha256sum "${CHECKSUM_FILES[@]}" > SHA256SUMS

echo ""
echo "==> Build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    echo "  binaries/$platform/pi"
done
