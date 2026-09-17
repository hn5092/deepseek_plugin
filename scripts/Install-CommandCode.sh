#!/usr/bin/env bash
#
# Install (or remove) the CommandCode route in a DSH settings.yaml.
#
# Sibling of scripts/Install-OpenCodeGo.sh, and deliberately compatible with it:
#
#   - OpenCode Go owns the `llm-pi-ai` section and rewrites it on replay. This
#     script never rewrites that section: it only inserts or replaces its own
#     `# >>> dsh-commandcode route` / `# <<< dsh-commandcode route` block inside
#     the existing `providers:` mapping, so both route sets coexist.
#   - The block is wrapped in markers, so a replay replaces it in place and never
#     duplicates the route.
#   - No section yet: the script appends `llm-pi-ai:` plus `providers:` itself.
#
# The API key is never written: the route references a credential name, and the
# key stays in the DSH credential store (or the matching environment variable).
#
# Exit codes: 0 ok, 1 error, 3 nothing to do / refused, 4 validation failed.
set -eu

ROUTE_BEGIN="# >>> dsh-commandcode route"
ROUTE_END="# <<< dsh-commandcode route"
ROUTE_ID="commandcode"
DEFAULT_REF="COMMANDCODE_API_KEY"
TEMPLATE_REF="__REF__"

# Honour an inherited DSH_HOME; --dsh-home still overrides it.
DSH_HOME="${DSH_HOME:-}"
REF="$DEFAULT_REF"
SET_DEFAULT=0
DEFAULT_EFFORT="max"
DRY_RUN=0
UNINSTALL=0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEMPLATE="$(dirname "$SCRIPT_DIR")/provider/commandcode/settings.llm-pi-ai.yml"

usage() {
    cat <<'USAGE'
Install (or remove) the CommandCode route in a DSH settings.yaml.

Options:
  --dsh-home <dir>   DSH home (default: $HOME/.dsh)
  --ref <name>       credential reference the route points at
                     (default: COMMANDCODE_API_KEY)
  --set-default      also point agent-default-model at this route
  --effort <level>   reasoningEffort used by --set-default (default: max)
  --dry-run          report what would change, write nothing
  --uninstall        remove the managed route block
  -h, --help         this help

Examples:
  scripts/Install-CommandCode.sh
  scripts/Install-CommandCode.sh --ref MY_CMD_KEY
  scripts/Install-CommandCode.sh --set-default --effort high
  scripts/Install-CommandCode.sh --dry-run
  scripts/Install-CommandCode.sh --uninstall

The key is never written by this script. Put it in the DSH credential store
under the reference name, or export it as that environment variable:

  ~/.dsh/.credentials.yaml
  refs:
    COMMANDCODE_API_KEY: user_...
USAGE
    exit "${1:-0}"
}

die() { echo "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dsh-home) [ $# -ge 2 ] || die "--dsh-home needs a value"; DSH_HOME="$2"; shift 2 ;;
        --dsh-home=*) DSH_HOME="${1#*=}"; shift ;;
        --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
        --ref=*) REF="${1#*=}"; shift ;;
        --set-default) SET_DEFAULT=1; shift ;;
        --effort) [ $# -ge 2 ] || die "--effort needs a value"; DEFAULT_EFFORT="$2"; shift 2 ;;
        --effort=*) DEFAULT_EFFORT="${1#*=}"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) usage 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

case "$REF" in
    ''|*[!A-Za-z0-9_]*) die "--ref must be a POSIX shell identifier (got: $REF)" ;;
esac
case "$DEFAULT_EFFORT" in
    low|medium|high|max) ;;
    *) die "--effort must be low, medium, high or max (got: $DEFAULT_EFFORT)" ;;
esac

if [ -z "$DSH_HOME" ]; then
    # DSH Desktop on macOS and the CLI harness on POSIX systems both keep their
    # state in $HOME/.dsh; only Windows relocates it under %APPDATA%.
    DSH_HOME="$HOME/.dsh"
fi

SETTINGS="$DSH_HOME/settings.yaml"
[ -f "$SETTINGS" ] || die "settings.yaml not found: $SETTINGS"

has_managed() { grep -q -F "$ROUTE_BEGIN" "$SETTINGS"; }
has_section() { grep -q '^llm-pi-ai:' "$SETTINGS"; }

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

strip_managed() { # infile -> stdout without the managed block
    awk -v b="$ROUTE_BEGIN" -v e="$ROUTE_END" '
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

# Validate with the harness YAML parser when one is available; degrade with a
# warning (and keep the backup) when it is not, exactly like the sibling script.
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
    probe=$(mktemp "${TMPDIR:-/tmp}/dsh-commandcode-verify.XXXXXX.cjs")
    cat > "$probe" <<'PROBE'
const fs = require("node:fs");
const yaml = require(process.argv[2]);
const [file, routeId, ref, wantDefault, effort] = process.argv.slice(3);
const doc = yaml.parse(fs.readFileSync(file, "utf8"));
const providers = doc && doc["llm-pi-ai"] && doc["llm-pi-ai"].providers;
if (!providers) { console.error("settings has no llm-pi-ai.providers"); process.exit(2); }
const route = providers[routeId];
if (!route) { console.error("missing route " + routeId); process.exit(2); }
if (route.apiKeyEnv !== ref) {
    console.error("route " + routeId + " references " + route.apiKeyEnv + " instead of " + ref);
    process.exit(3);
}
if (!Array.isArray(route.models) || route.models.length === 0) {
    console.error("route " + routeId + " declares no models");
    process.exit(3);
}
// Sibling route sets must survive: report them rather than assume.
const siblings = Object.keys(providers).filter((id) => id !== routeId);
if (wantDefault === "1") {
    const d = doc["agent-default-model"];
    if (!d || d.provider !== routeId) {
        console.error("agent-default-model.provider is " + (d && d.provider) + ", expected " + routeId);
        process.exit(4);
    }
    if (d.reasoningEffort !== effort) {
        console.error("agent-default-model.reasoningEffort is " + d.reasoningEffort + ", expected " + effort);
        process.exit(4);
    }
}
console.log("validated route " + routeId + " (" + route.models.length + " models, ref " + ref + ")");
console.log("coexisting providers: " + (siblings.length ? siblings.join(", ") : "none"));
PROBE
    set +e
    "$node_exe" "$probe" "$yaml_module" "$SETTINGS" "$ROUTE_ID" "$REF" "$SET_DEFAULT" "$DEFAULT_EFFORT"
    code=$?
    set -e
    rm -f "$probe"
    return $code
}

# --- uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
    if ! has_managed; then
        die "nothing to remove: no $ROUTE_BEGIN block in $SETTINGS"
    fi
    work=$(mktemp "${TMPDIR:-/tmp}/dsh-commandcode.XXXXXX")
    strip_managed "$SETTINGS" > "$work"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry run] would remove the $ROUTE_ID route block"
        diff -u "$SETTINGS" "$work" || true
        rm -f "$work"
        exit 0
    fi
    stamp=$(date +%Y%m%d-%H%M%S)
    cp -p "$SETTINGS" "$SETTINGS.bak-$stamp"
    trim_trailing_blanks "$work" > "$work.trimmed"
    mv "$work.trimmed" "$SETTINGS"
    rm -f "$work"
    echo "removed the $ROUTE_ID route block (backup: settings.yaml.bak-$stamp)"
    exit 0
fi

# --- build the managed block -------------------------------------------------
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"

if has_section "llm-pi-ai"; then
    echo "llm-pi-ai providers found before the write: $(section_providers | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
fi

block_body=$(mktemp "${TMPDIR:-/tmp}/dsh-commandcode-block.XXXXXX")
sed "s|$TEMPLATE_REF|$(escape_sed "$REF")|g" "$TEMPLATE" \
    | trim_trailing_blanks /dev/stdin > "$block_body"

grep -q -F "$TEMPLATE_REF" "$block_body" \
    && { rm -f "$block_body"; die "template still contains $TEMPLATE_REF after substitution"; }

{
    printf '%s (managed by scripts/Install-CommandCode.sh)\n' "$ROUTE_BEGIN"
    cat "$block_body"
    printf '%s\n' "$ROUTE_END"
} > "$block_body.wrapped"
mv "$block_body.wrapped" "$block_body"

# --- place the block ---------------------------------------------------------
work=$(mktemp "${TMPDIR:-/tmp}/dsh-commandcode.XXXXXX")

if has_managed; then
    # Replay: replace the block where it already sits.
    awk -v b="$ROUTE_BEGIN" -v e="$ROUTE_END" -v repl="$block_body" '
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
    ' "$SETTINGS" > "$work"
elif has_section "llm-pi-ai"; then
    # Insert inside the existing providers mapping: find the last line that
    # belongs to it, i.e. just before the next column-0 key, skipping back over
    # the comments and blank lines that belong to that next section.
    providers_line=$(awk '
        /^llm-pi-ai:/ { inb = 1; next }
        inb && /^[A-Za-z_][A-Za-z0-9_-]*:/ { exit }
        inb && /^  providers:[[:space:]]*$/ { print NR; exit }
    ' "$SETTINGS")
    [ -n "$providers_line" ] || { rm -f "$work" "$block_body"; die "llm-pi-ai section has no providers: mapping"; }

    total=$(wc -l < "$SETTINGS" | tr -d ' ')
    next_key=$(awk -v start="$providers_line" '
        NR > start && /^[A-Za-z_][A-Za-z0-9_-]*:/ { print NR; exit }
    ' "$SETTINGS")
    [ -n "$next_key" ] || next_key=$((total + 1))

    ins=$((next_key - 1))
    while [ "$ins" -gt "$providers_line" ]; do
        line=$(sed -n "${ins}p" "$SETTINGS")
        case "$line" in
            ''|'#'*) ins=$((ins - 1)) ;;
            *) break ;;
        esac
    done
    ins=$((ins + 1))

    {
        [ "$ins" -gt 1 ] && sed -n "1,$((ins - 1))p" "$SETTINGS"
        cat "$block_body"
        [ "$ins" -le "$total" ] && sed -n "${ins},\$p" "$SETTINGS"
    } > "$work"
else
    # No llm-pi-ai section at all: create it.
    cp "$SETTINGS" "$work"
    trim_trailing_blanks "$work" > "$work.trimmed"
    {
        cat "$work.trimmed"
        printf '\nllm-pi-ai:\n  providers:\n'
        cat "$block_body"
    } > "$work.next"
    mv "$work.next" "$work"
    rm -f "$work.trimmed"
fi

# --- optionally repoint the default model ------------------------------------
if [ "$SET_DEFAULT" -eq 1 ]; then
    awk -v route="$ROUTE_ID" -v effort="$DEFAULT_EFFORT" '
        /^agent-default-model:/ { inb = 1; print; next }
        inb && /^[A-Za-z_][A-Za-z0-9_-]*:/ { inb = 0 }
        inb && /^  provider:/ { print "  provider: " route; next }
        inb && /^  model:/ { print "  model: deepseek/deepseek-v4.1-flash"; next }
        inb && /^  reasoningEffort:/ { print "  reasoningEffort: " effort; next }
        { print }
    ' "$work" > "$work.next"
    mv "$work.next" "$work"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry run] would write the $ROUTE_ID route (ref: $REF)"
    [ "$SET_DEFAULT" -eq 1 ] && echo "[dry run] default model: $ROUTE_ID / deepseek/deepseek-v4.1-flash / $DEFAULT_EFFORT"
    echo "[dry run] diff against $SETTINGS:"
    diff -u "$SETTINGS" "$work" || true
    rm -f "$work" "$block_body"
    exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
cp -p "$SETTINGS" "$SETTINGS.bak-$stamp"
trim_trailing_blanks "$work" > "$work.trimmed"
mv "$work.trimmed" "$SETTINGS"
rm -f "$work" "$block_body"

if ! validate; then
    cp -p "$SETTINGS.bak-$stamp" "$SETTINGS"
    die "the written settings.yaml did not validate; the backup was restored"
fi

echo "wrote the $ROUTE_ID route into $SETTINGS (backup: settings.yaml.bak-$stamp)"
echo "It needs a key in the DSH credential store under $REF; without one the route fails with MISSING_CREDENTIAL."
echo "Settings are re-read per request: no restart is needed."
