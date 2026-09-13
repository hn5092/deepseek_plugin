#!/usr/bin/env bash
#
# Install (or remove) a DSH plugin package from this repository into a DSH profile.
#
# POSIX port of scripts/Install-DshPlugin.ps1 for macOS and Linux, where
# PowerShell is not part of the base system. It copies <PluginDir> into
# <DshHome>/profiles/node_modules/<package name> and writes one managed row into
# <DshHome>/profiles/<ProfileName>/cordis.patch.yml, which is what makes the DSH
# Loader load the plugin and the Web client pick up its browser half.
#
# The patch file is backed up before every write and the result is parsed with
# the harness's own YAML parser; a failed parse restores the backup. Re-running
# the script updates the managed row in place instead of appending a second one.
# A pre-existing row for the same package that this script did not write is
# refused, so a stale copy must be removed first (--uninstall, or by hand).
#
# Both this script and the PowerShell one recognize each other's managed rows.
set -eu

DSH_HOME=""
PROFILE_NAME=""
PLUGIN_DIR=""
REFS=""
REFS_SET=0
UNINSTALL=0
DRY_RUN=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(dirname "$SCRIPT_DIR")

usage() {
    cat <<'USAGE'
Install (or remove) a DSH plugin package from this repository into a DSH profile.
POSIX port of scripts/Install-DshPlugin.ps1 for macOS and Linux.

Options:
  --dsh-home <dir>     DSH home (default: $HOME/.dsh, which is where DSH Desktop
                       on macOS and the CLI harness keep their state)
  --profile <name>     profile to patch (default: web when it exists, else
                       desktop, else the only profile under <dsh-home>/profiles)
  --plugin-dir <dir>   plugin package directory
                       (default: dsh-opencode-go-usage at this repository's root)
  --ref <a,b>          credential references to sample, one per account row of
                       the usage plugin. Omitted, the plugin's own defaults apply.
  --dry-run            report what would change, write nothing
  --uninstall          remove the managed row and the installed copy
  -h, --help           this help

Examples:
  scripts/Install-DshPlugin.sh
  scripts/Install-DshPlugin.sh --ref OPENCODE_API_KEY_1,OPENCODE_API_KEY_2
  scripts/Install-DshPlugin.sh --uninstall
USAGE
    exit "${1:-0}"
}

die() { echo "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dsh-home) [ $# -ge 2 ] || die "--dsh-home needs a value"; DSH_HOME="$2"; shift 2 ;;
        --dsh-home=*) DSH_HOME="${1#*=}"; shift ;;
        --profile) [ $# -ge 2 ] || die "--profile needs a value"; PROFILE_NAME="$2"; shift 2 ;;
        --profile=*) PROFILE_NAME="${1#*=}"; shift ;;
        --plugin-dir) [ $# -ge 2 ] || die "--plugin-dir needs a value"; PLUGIN_DIR="$2"; shift 2 ;;
        --plugin-dir=*) PLUGIN_DIR="${1#*=}"; shift ;;
        --ref)
            [ $# -ge 2 ] || die "--ref needs a value"
            if [ "$REFS_SET" -eq 0 ]; then REFS=""; REFS_SET=1; fi
            extra=$(printf '%s' "$2" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true)
            if [ -n "$extra" ]; then
                if [ -n "$REFS" ]; then REFS="$REFS
$extra"; else REFS="$extra"; fi
            fi
            shift 2 ;;
        --ref=*)
            if [ "$REFS_SET" -eq 0 ]; then REFS=""; REFS_SET=1; fi
            extra=$(printf '%s' "${1#*=}" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true)
            if [ -n "$extra" ]; then
                if [ -n "$REFS" ]; then REFS="$REFS
$extra"; else REFS="$extra"; fi
            fi
            shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) usage 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

if [ -z "$DSH_HOME" ]; then
    DSH_HOME="$HOME/.dsh"
fi

if [ -z "$PLUGIN_DIR" ]; then
    PLUGIN_DIR="$REPO_ROOT/dsh-opencode-go-usage"
fi
[ -d "$PLUGIN_DIR" ] || die "plugin directory not found: $PLUGIN_DIR"
MANIFEST="$PLUGIN_DIR/package.json"
[ -f "$MANIFEST" ] || die "package.json not found in: $PLUGIN_DIR"

node_bin() {
    if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
    for candidate in \
        "$HOME/Library/Application Support/io.github.hairyf.deepseek-harness-desktop/runtime/bin/node" \
        "/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/node/bin/node"
    do
        if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
    done
    return 1
}

PACKAGE_NAME=""
if node_exe=$(node_bin); then
    PACKAGE_NAME=$("$node_exe" -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.name??""))' "$MANIFEST")
fi
if [ -z "$PACKAGE_NAME" ]; then
    # Fall back to a manifest scan so the install still works without node.
    PACKAGE_NAME=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
fi
[ -n "$PACKAGE_NAME" ] || die "package.json has no name: $MANIFEST"

PROFILES_DIR="$DSH_HOME/profiles"

# Profile default: 'web' is the profile the Windows Desktop build boots; the
# macOS Desktop build boots 'desktop', so either may be the right one here.
if [ -z "$PROFILE_NAME" ]; then
    for candidate in web desktop; do
        if [ -d "$PROFILES_DIR/$candidate" ]; then PROFILE_NAME="$candidate"; break; fi
    done
fi
if [ -z "$PROFILE_NAME" ] && [ -d "$PROFILES_DIR" ]; then
    candidates=$(find "$PROFILES_DIR" -maxdepth 1 -mindepth 1 -type d ! -name node_modules -exec basename {} \; 2>/dev/null || true)
    count=$(printf '%s\n' "$candidates" | grep -c . || true)
    if [ "$count" -eq 1 ]; then PROFILE_NAME=$(printf '%s\n' "$candidates" | head -1); fi
fi
[ -n "$PROFILE_NAME" ] || die "cannot pick a profile under $PROFILES_DIR; pass --profile"
echo "profile: $PROFILE_NAME"

TARGET="$PROFILES_DIR/node_modules/$PACKAGE_NAME"
PATCH="$PROFILES_DIR/$PROFILE_NAME/cordis.patch.yml"
BEGIN_MARKER="# >>> dsh-plugin: $PACKAGE_NAME"
END_MARKER="# <<< dsh-plugin: $PACKAGE_NAME"

[ -d "$PROFILES_DIR/$PROFILE_NAME" ] || die "profile not found: $PROFILES_DIR/$PROFILE_NAME (pass --dsh-home / --profile)"

strip_managed() { # infile begin end -> stdout without the managed row
    awk -v b="$2" -v e="$3" '
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (skip) { if (index(line, e) == 1) skip = 0; next }
            if (index(line, b) == 1) { skip = 1; next }
            print
        }
    ' "$1"
}

trim_trailing_blanks() { # infile -> stdout
    awk '
        { lines[NR] = $0 }
        END {
            last = NR
            while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
            for (i = 1; i <= last; i++) print lines[i]
        }
    ' "$1"
}

# The patch layer is a top-level YAML array. A profile that ships the default
# '[]' placeholder (DSH Desktop writes one) must have that placeholder replaced,
# not appended after: '[]' followed by a sequence item is not valid YAML.
write_patch() { # replacement-file
    stamp=$(date +%Y%m%d-%H%M%S)
    [ -f "$PATCH" ] && cp -p "$PATCH" "$PATCH.bak-$stamp"
    tmp=$(mktemp "${TMPDIR:-/tmp}/dsh-plugin-patch.XXXXXX")
    if [ -f "$PATCH" ]; then
        effective=$(sed 's/#.*$//' "$PATCH" | tr -d '[:space:]')
        if [ "$effective" = "[]" ] || [ -z "$effective" ]; then
            # Keep the comment header, drop the empty-list placeholder.
            grep -v '^[[:space:]]*\[[[:space:]]*\][[:space:]]*$' "$PATCH" > "$tmp"
        else
            cp "$PATCH" "$tmp"
        fi
    else
        : > "$tmp"
    fi
    if has_marker "$tmp" "$BEGIN_MARKER"; then
        strip_managed "$tmp" "$BEGIN_MARKER" "$END_MARKER" > "$tmp.next"
        mv "$tmp.next" "$tmp"
    fi
    trim_trailing_blanks "$tmp" > "$tmp.trimmed"
    printf '\n' >> "$tmp.trimmed"
    cat "$1" >> "$tmp.trimmed"
    printf '\n' >> "$tmp.trimmed"
    mv "$tmp.trimmed" "$PATCH"
    rm -f "$tmp"

    validate_patch "$stamp"
    echo "patched $PATCH (backup: cordis.patch.yml.bak-$stamp)"
}

has_marker() { grep -q -F "$2" "$1"; }

validate_patch() { # backup stamp
    yaml_module="$PROFILES_DIR/node_modules/yaml"
    if [ ! -d "$yaml_module" ]; then
        echo "warning: yaml parser not found at $yaml_module; skipped the post-write validation" >&2
        return 0
    fi
    if ! node_exe=$(node_bin); then
        echo "warning: node was not found; skipped the post-write validation. The backup is kept next to the patch file." >&2
        return 0
    fi
    probe=$(mktemp "${TMPDIR:-/tmp}/dsh-plugin-patch-verify.XXXXXX.cjs")
    cat > "$probe" <<'PROBE'
const fs = require("node:fs");
const yaml = require(process.argv[2]);
const document = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));
if (document !== null && document !== undefined && !Array.isArray(document)) {
    console.error("patch file is not a YAML list");
    process.exit(2);
}
console.log("patch rows:", document === null || document === undefined ? 0 : document.length);
PROBE
    set +e
    "$node_exe" "$probe" "$yaml_module" "$PATCH"
    code=$?
    set -e
    rm -f "$probe"
    if [ "$code" -ne 0 ]; then
        if [ -n "${1:-}" ] && [ -f "$PATCH.bak-$1" ]; then
            cp -p "$PATCH.bak-$1" "$PATCH"
            die "the patched profile file did not parse; the backup was restored"
        fi
        die "the patched profile file did not parse"
    fi
}

if [ "$UNINSTALL" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry run] would remove $TARGET and the managed row in $PATCH"
        exit 0
    fi
    rm -rf "$TARGET"
    if [ -f "$PATCH" ] && has_marker "$PATCH" "$BEGIN_MARKER"; then
        tmp=$(mktemp "${TMPDIR:-/tmp}/dsh-plugin-patch.XXXXXX")
        strip_managed "$PATCH" "$BEGIN_MARKER" "$END_MARKER" > "$tmp"
        stamp=$(date +%Y%m%d-%H%M%S)
        cp -p "$PATCH" "$PATCH.bak-$stamp"
        trim_trailing_blanks "$tmp" > "$tmp.trimmed"
        mv "$tmp.trimmed" "$PATCH"
        rm -f "$tmp"
        validate_patch "$stamp"
    else
        echo "warning: no managed row for $PACKAGE_NAME in $PATCH; only the installed copy was removed" >&2
    fi
    echo "uninstalled $PACKAGE_NAME"
    exit 0
fi

# Refuse an unmanaged row for the same package: two rows would load the plugin twice.
if [ -f "$PATCH" ] && ! has_marker "$PATCH" "$BEGIN_MARKER"; then
    if grep -q "^[[:space:]]*name:[[:space:]]*'$PACKAGE_NAME'[[:space:]]*$" "$PATCH"; then
        die "an unmanaged row for $PACKAGE_NAME already exists in $PATCH; remove it (or run the installer that wrote it with --uninstall) before installing from this repository"
    fi
fi

file_count=$(find "$PLUGIN_DIR" -type f | wc -l | tr -d ' ')

row=$(mktemp "${TMPDIR:-/tmp}/dsh-plugin-row.XXXXXX")
{
    printf '%s (managed by scripts/Install-DshPlugin.sh)\n' "$BEGIN_MARKER"
    printf -- '- insert:\n'
    printf "    - id: %s\n" "$PACKAGE_NAME"
    printf "      name: '%s'\n" "$PACKAGE_NAME"
    if [ -n "$REFS" ]; then
        printf '      config:\n'
        printf '        refs:\n'
        printf '%s\n' "$REFS" | while IFS= read -r ref; do
            [ -n "$ref" ] && printf '          - %s\n' "$ref"
        done
    fi
    printf '%s\n' "$END_MARKER"
} > "$row"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry run] would install $PACKAGE_NAME -> $TARGET ($file_count files)"
    echo "[dry run] would write into $PATCH:"
    cat "$row"
    rm -f "$row"
    exit 0
fi

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
cp -R "$PLUGIN_DIR" "$TARGET"
echo "installed $PACKAGE_NAME -> $TARGET ($file_count files)"

write_patch "$row"
rm -f "$row"

echo 'Reload the DSH window (or restart the app) if the plugin surface does not appear; profile patches usually reload live.'
