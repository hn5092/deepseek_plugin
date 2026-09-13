#!/usr/bin/env bash
#
# Install (or remove) the OpenCode Go route set in a DSH settings.yaml.
#
# POSIX port of scripts/Install-OpenCodeGo.ps1 for macOS and Linux, where
# PowerShell is not part of the base system. Behaviour matches the PowerShell
# script, and both recognize each other's managed blocks:
#
#   - a managed block (written by either script) is replaced in place;
#   - an existing unmanaged llm-pi-ai section is REPLACED as well, after a
#     backup, because that is the replay path - pass --dry-run to see the
#     provider ids that would be dropped;
#   - no section: the block is appended.
#
# The API key itself is never written: each route references a credential name,
# and the keys stay in the DSH credential store (or the matching environment
# variables).
set -eu

ROUTES_BEGIN="# >>> dsh-opencode-go routes"
ROUTES_END="# <<< dsh-opencode-go routes"
DEFAULT_BEGIN="# >>> dsh-opencode-go default model"
DEFAULT_END="# <<< dsh-opencode-go default model"

DEFAULT_REFS='OPENCODE_API_KEY_1
OPENCODE_API_KEY_2
OPENCODE_API_KEY_3
OPENCODE_API_KEY_4
OPENCODE_API_KEY_5'

DSH_HOME=""
CLIENT="dsh-opencode-go"
REFS="$DEFAULT_REFS"
REFS_OVERRIDDEN=0
DEFAULT_ROUTE="opencode-go-2"
DEFAULT_MODEL="deepseek-v4.1-flash"
EFFORT="max"
DRY_RUN=0
UNINSTALL=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEMPLATE="$(dirname "$SCRIPT_DIR")/provider/opencode-go/settings.llm-pi-ai.yml"
DEFAULT_TEMPLATE="$(dirname "$SCRIPT_DIR")/provider/opencode-go/settings.agent-default-model.yml"

usage() {
    cat <<'USAGE'
Install (or remove) the OpenCode Go route set in a DSH settings.yaml.
POSIX port of scripts/Install-OpenCodeGo.ps1 for macOS and Linux.

Options:
  --dsh-home <dir>        DSH home (default: $HOME/.dsh)
  --client <tag>          x-opencode-session / user-agent tag, replaces
                          __CLIENT__ in the template (default: dsh-opencode-go).
                          Keep the same value across replays so prompt caching
                          stays stable.
  --ref <a,b,c,d,e>       credential references, one per route, in route order
                          (default: OPENCODE_API_KEY_1..5). Repeatable.
  --default-route <name>  agent-default-model.provider (default: opencode-go-2)
  --default-model <id>    agent-default-model.model (default: deepseek-v4.1-flash)
  --effort <low|high|max> agent-default-model.reasoningEffort (default: max)
  --dry-run               report what would change, write nothing
  --uninstall             remove the route set
  -h, --help              this help

Examples:
  scripts/Install-OpenCodeGo.sh
  scripts/Install-OpenCodeGo.sh --client dsh-desktop-mybox --ref KEY_A,KEY_B,KEY_C,KEY_D,KEY_E
  scripts/Install-OpenCodeGo.sh --uninstall
USAGE
    exit "${1:-0}"
}

die() { echo "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dsh-home) [ $# -ge 2 ] || die "--dsh-home needs a value"; DSH_HOME="$2"; shift 2 ;;
        --dsh-home=*) DSH_HOME="${1#*=}"; shift ;;
        --client) [ $# -ge 2 ] || die "--client needs a value"; CLIENT="$2"; shift 2 ;;
        --client=*) CLIENT="${1#*=}"; shift ;;
        --ref)
            [ $# -ge 2 ] || die "--ref needs a value"
            if [ "$REFS_OVERRIDDEN" -eq 0 ]; then REFS=""; REFS_OVERRIDDEN=1; fi
            extra=$(printf '%s' "$2" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true)
            if [ -n "$extra" ]; then
                if [ -n "$REFS" ]; then REFS="$REFS
$extra"; else REFS="$extra"; fi
            fi
            shift 2 ;;
        --ref=*)
            if [ "$REFS_OVERRIDDEN" -eq 0 ]; then REFS=""; REFS_OVERRIDDEN=1; fi
            extra=$(printf '%s' "${1#*=}" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true)
            if [ -n "$extra" ]; then
                if [ -n "$REFS" ]; then REFS="$REFS
$extra"; else REFS="$extra"; fi
            fi
            shift ;;
        --default-route) [ $# -ge 2 ] || die "--default-route needs a value"; DEFAULT_ROUTE="$2"; shift 2 ;;
        --default-route=*) DEFAULT_ROUTE="${1#*=}"; shift ;;
        --default-model) [ $# -ge 2 ] || die "--default-model needs a value"; DEFAULT_MODEL="$2"; shift 2 ;;
        --default-model=*) DEFAULT_MODEL="${1#*=}"; shift ;;
        --effort) [ $# -ge 2 ] || die "--effort needs a value"; EFFORT="$2"; shift 2 ;;
        --effort=*) EFFORT="${1#*=}"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) usage 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

case "$EFFORT" in
    low|high|max) ;;
    *) die "--effort must be low, high or max (got: $EFFORT)" ;;
esac

if [ -z "$DSH_HOME" ]; then
    # DSH Desktop on macOS and the CLI harness on POSIX systems both keep their
    # state in $HOME/.dsh; only Windows relocates it under %APPDATA%.
    DSH_HOME="$HOME/.dsh"
fi

SETTINGS="$DSH_HOME/settings.yaml"
[ -f "$SETTINGS" ] || die "settings.yaml not found: $SETTINGS"

ref_count=$(printf '%s\n' "$REFS" | grep -c . || true)

# --- YAML text helpers -------------------------------------------------------
# A top-level key runs from its own line to the line before the next column-0
# key: the same assumption the PowerShell script's regexes make.

has_section() { grep -q "^$1:" "$SETTINGS"; }
has_managed() { grep -q -F "$1" "$SETTINGS"; }
file_has_marker() { grep -q -F "$2" "$1"; }

section_providers() { # print provider ids nested inside llm-pi-ai.providers
    awk '
        /^llm-pi-ai:/ { inb = 1; next }
        inb && /^[a-z][a-z0-9-]*:/ { exit }
        inb && /^    [A-Za-z0-9_.-]+:/ {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            sub(/:.*/, "", line)
            print line
        }
    ' "$SETTINGS"
}

replace_section() { # infile key replacement-file -> stdout
    awk -v key="$2" -v repl="$3" '
        /^[a-z][a-z0-9-]*:/ {
            if (inb) inb = 0
            if (!done && $0 == key ":") {
                inb = 1; done = 1
                while ((getline line < repl) > 0) print line
                close(repl)
                next
            }
        }
        !inb { print }
    ' "$1"
}

strip_section() { # infile key -> stdout without that section
    awk -v key="$2" '
        /^[a-z][a-z0-9-]*:/ {
            if (inb) inb = 0
            if ($0 == key ":") { inb = 1; next }
        }
        !inb { print }
    ' "$1"
}

strip_managed() { # infile begin end -> stdout without the managed block
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

replace_managed_inplace() { # infile begin end replacement-file -> stdout, block replaced where it was
    awk -v b="$2" -v e="$3" -v repl="$4" '
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (skip) { if (index(line, e) == 1) skip = 0; next }
            if (index(line, b) == 1) {
                skip = 1
                while ((getline l < repl) > 0) print l
                close(repl)
                next
            }
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

append_block() { # infile replacement-file -> stdout
    trim_trailing_blanks "$1" > "$1.trimmed"
    printf '\n' >> "$1.trimmed"
    cat "$2" >> "$1.trimmed"
    mv "$1.trimmed" "$1"
}

escape_sed() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

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

# Validate with the harness YAML parser when one is available: five routes, each
# on its own reference, plus the expected default effort. The PowerShell script
# degrades the same way (warning, backup kept) when the parser is missing.
validate() {
    yaml_module="$DSH_HOME/profiles/node_modules/yaml"
    if [ ! -d "$yaml_module" ]; then
        echo "warning: yaml parser not found at $yaml_module; skipped the post-write validation" >&2
        return 0
    fi
    if ! node_exe=$(node_bin); then
        echo "warning: node was not found; skipped the post-write validation" >&2
        return 0
    fi
    probe=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go-verify.XXXXXX.cjs")
    refs_file=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go-refs.XXXXXX.txt")
    cat > "$probe" <<'PROBE'
const fs = require("node:fs");
const yaml = require(process.argv[2]);
const doc = yaml.parse(fs.readFileSync(process.argv[3], "utf8"));
const providers = doc && doc["llm-pi-ai"] && doc["llm-pi-ai"].providers;
if (!providers) { console.error("settings has no llm-pi-ai.providers"); process.exit(2); }
const routes = ["opencode-go-1", "opencode-go-2", "opencode-go-3", "opencode-go-4", "opencode-go-5"];
const refs = fs.readFileSync(process.argv[4], "utf8").split(/\r?\n/).filter(Boolean);
if (refs.length !== routes.length) { console.error("expected " + routes.length + " credential references, got " + refs.length); process.exit(2); }
for (let i = 0; i < routes.length; i++) {
    const route = providers[routes[i]];
    if (!route) { console.error("missing route " + routes[i]); process.exit(2); }
    if (route.apiKeyEnv !== refs[i]) { console.error("route " + routes[i] + " references " + route.apiKeyEnv + " instead of " + refs[i]); process.exit(3); }
}
const d = doc["agent-default-model"];
if (!d || d.reasoningEffort !== process.argv[5]) {
    console.error("agent-default-model.reasoningEffort is " + (d && d.reasoningEffort) + ", expected " + process.argv[5]);
    process.exit(4);
}
console.log("validated default effort:", d.reasoningEffort);
console.log("validated routes:", routes.join(", "));
PROBE
    printf '%s\n' "$REFS" > "$refs_file"
    set +e
    "$node_exe" "$probe" "$yaml_module" "$SETTINGS" "$refs_file" "$EFFORT"
    code=$?
    set -e
    rm -f "$probe" "$refs_file"
    return $code
}

# --- uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
    work=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go.XXXXXX")
    if has_managed "$ROUTES_BEGIN"; then
        strip_managed "$SETTINGS" "$ROUTES_BEGIN" "$ROUTES_END" \
            | strip_managed - "$DEFAULT_BEGIN" "$DEFAULT_END" > "$work"
    else
        other=$(section_providers | grep -v '^opencode-go-' || true)
        if [ -n "$other" ]; then
            rm -f "$work"
            die "nothing to remove: settings.yaml has no managed route set, and its llm-pi-ai section holds providers this script did not create"
        fi
        # Mirrors the PowerShell script: an unmanaged section loses the route set
        # only; agent-default-model is left as the user wrote it.
        strip_section "$SETTINGS" "llm-pi-ai" > "$work"
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry run] would remove the route set"
        rm -f "$work"
        exit 0
    fi
    stamp=$(date +%Y%m%d-%H%M%S)
    cp -p "$SETTINGS" "$SETTINGS.bak-$stamp"
    trim_trailing_blanks "$work" > "$work.trimmed"
    mv "$work.trimmed" "$SETTINGS"
    rm -f "$work"
    echo "removed the OpenCode Go route set (backup: settings.yaml.bak-$stamp)"
    exit 0
fi

# --- install -----------------------------------------------------------------
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"
[ -f "$DEFAULT_TEMPLATE" ] || die "template not found: $DEFAULT_TEMPLATE"
if [ "$ref_count" -ne 5 ]; then
    die "exactly 5 credential references are required (one per route); got $ref_count"
fi

if has_section "llm-pi-ai"; then
    echo "llm-pi-ai providers found before the write: $(section_providers | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
fi

client_escaped=$(escape_sed "$CLIENT")
refs_file=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go-refs.XXXXXX.txt")
printf '%s\n' "$REFS" > "$refs_file"
block_body=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go-block.XXXXXX")
sed "s|__CLIENT__|$client_escaped|g" "$TEMPLATE" \
    | awk -v reffile="$refs_file" '
        BEGIN {
            slots = 0
            while ((getline line < reffile) > 0) {
                if (line == "") continue
                slots++
                ref[slots] = line
            }
            close(reffile)
        }
        /^      apiKeyEnv: / {
            used++
            if (used > slots) {
                print "template declares more credential slots than the " slots " references provided" > "/dev/stderr"
                exit 3
            }
            print "      apiKeyEnv: " ref[used]
            next
        }
        { print }
        END {
            if (used != 5) {
                print "template declared " used + 0 " credential slots; expected 5" > "/dev/stderr"
                exit 3
            }
        }
    ' > "$block_body" || { rm -f "$block_body" "$refs_file"; die "could not build the route block"; }
rm -f "$refs_file"
{
    printf '%s (managed by scripts/Install-OpenCodeGo.sh)\n' "$ROUTES_BEGIN"
    cat "$block_body"
    printf '%s\n' "$ROUTES_END"
} > "$block_body.wrapped"
mv "$block_body.wrapped" "$block_body"

work=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go.XXXXXX")
if has_managed "$ROUTES_BEGIN"; then
    replace_managed_inplace "$SETTINGS" "$ROUTES_BEGIN" "$ROUTES_END" "$block_body" > "$work"
elif has_section "llm-pi-ai"; then
    replace_section "$SETTINGS" "llm-pi-ai" "$block_body" > "$work"
else
    cp "$SETTINGS" "$work"
    append_block "$work" "$block_body"
fi

# Default model block: replace that section (managed or not) so a replay restores
# the reasoning effort this deployment expects.
default_body=$(mktemp "${TMPDIR:-/tmp}/dsh-opencode-go-default.XXXXXX")
sed -e "s|__DEFAULT_ROUTE__|$(escape_sed "$DEFAULT_ROUTE")|g" \
    -e "s|__DEFAULT_MODEL__|$(escape_sed "$DEFAULT_MODEL")|g" \
    -e "s|__EFFORT__|$(escape_sed "$EFFORT")|g" "$DEFAULT_TEMPLATE" > "$default_body"
{
    printf '%s (managed by scripts/Install-OpenCodeGo.sh)\n' "$DEFAULT_BEGIN"
    cat "$default_body"
    printf '\n%s\n' "$DEFAULT_END"
} > "$default_body.wrapped"
mv "$default_body.wrapped" "$default_body"

# Replacing a managed default-model block where it already sits keeps replays
# stable; stripping it first would drop the section and push the block to the end
# of the file on every second run.
if file_has_marker "$work" "$DEFAULT_BEGIN"; then
    replace_managed_inplace "$work" "$DEFAULT_BEGIN" "$DEFAULT_END" "$default_body" > "$work.next"
    mv "$work.next" "$work"
elif grep -q "^agent-default-model:" "$work"; then
    replace_section "$work" "agent-default-model" "$default_body" > "$work.next"
    mv "$work.next" "$work"
else
    append_block "$work" "$default_body"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry run] would write the route set ($(printf '%s' "$REFS" | tr '\n' ' '))"
    echo "[dry run] default model: $DEFAULT_ROUTE / $DEFAULT_MODEL / $EFFORT"
    echo "[dry run] diff against $SETTINGS:"
    diff -u "$SETTINGS" "$work" || true
    rm -f "$work" "$block_body" "$default_body"
    exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
cp -p "$SETTINGS" "$SETTINGS.bak-$stamp"
trim_trailing_blanks "$work" > "$work.trimmed"
mv "$work.trimmed" "$SETTINGS"
rm -f "$work" "$block_body" "$default_body"

if ! validate; then
    cp -p "$SETTINGS.bak-$stamp" "$SETTINGS"
    die "the written settings.yaml did not validate; the backup was restored"
fi

echo "wrote the OpenCode Go route set into $SETTINGS (backup: settings.yaml.bak-$stamp)"
echo "Each route needs its own key in the DSH credential store under the references above; a route without one fails with MISSING_CREDENTIAL."
