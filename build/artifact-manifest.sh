#!/usr/bin/env bash
# Write and verify SHA-256 + byte-size manifests for CI artifact handoffs (#6181).
set -euo pipefail

MANIFEST_NAME="artifact-manifest.sha256"
RIDS="linux-x64 linux-arm64 win-x64 win-arm64 osx-x64 osx-arm64"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

sha256_file() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    else
        shasum -a 256 "$file" | awk '{print $1}'
    fi
}

size_file() {
    wc -c < "$1" | tr -d ' \r\n'
}

list_dir_entries() {
    local dir="$1"
    (
        shopt -s nullglob dotglob
        for entry in "$dir"/*; do
            name="${entry##*/}"
            if [[ "$name" == "$MANIFEST_NAME" ]]; then
                continue
            fi
            printf '%s\n' "$name"
        done
    ) | LC_ALL=C sort
}

check_r2r_packages() {
    local dir="$1"
    local entries name sdk_ver="" sdk_count=0 rid pkg missing=""
    local pat='^Gsharp\.NET\.Sdk\.([0-9]+\.[0-9]+\.[0-9]+.*)\.nupkg$'
    entries="$(list_dir_entries "$dir")"
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        if [[ "$name" =~ $pat ]]; then
            sdk_ver="${BASH_REMATCH[1]}"
            sdk_count=$((sdk_count + 1))
        fi
    done <<EOF
$entries
EOF
    if [[ "$sdk_count" -ne 1 ]]; then
        echo "expected exactly one Gsharp.NET.Sdk.<version>.nupkg in '$dir', found $sdk_count"
        return 1
    fi
    for rid in $RIDS; do
        pkg="Gsharp.NET.Sdk.Compiler.${rid}.${sdk_ver}.nupkg"
        if [[ ! -f "$dir/$pkg" ]]; then
            missing="${missing:+$missing, }$pkg"
        fi
    done
    if [[ -n "$missing" ]]; then
        echo "missing ReadyToRun compiler package(s) for $sdk_ver: $missing"
        return 1
    fi
    return 0
}

cmd_write() {
    local dir="$1"
    local require_r2r="$2"
    [[ -d "$dir" ]] || fail "artifact directory '$dir' does not exist"

    local entries name path sha sz count=0
    entries="$(list_dir_entries "$dir")"
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        path="$dir/$name"
        [[ -f "$path" && ! -d "$path" ]] || fail "unexpected non-file entry in '$dir': $name"
        count=$((count + 1))
    done <<EOF
$entries
EOF
    [[ "$count" -gt 0 ]] || fail "refusing to write empty artifact manifest for '$dir'"

    if [[ "$require_r2r" == "true" ]]; then
        local r2r_err=""
        if ! r2r_err="$(check_r2r_packages "$dir")"; then
            fail "$r2r_err"
        fi
    fi

    local manifest="$dir/$MANIFEST_NAME"
    local tmp="$dir/.$MANIFEST_NAME.tmp.$$"
    : > "$tmp"
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        path="$dir/$name"
        sha="$(sha256_file "$path")"
        [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { rm -f "$tmp"; fail "invalid SHA-256 '$sha' for $name"; }
        sz="$(size_file "$path")"
        printf '%s %s %s\n' "$sha" "$sz" "$name" >> "$tmp"
    done <<EOF
$entries
EOF
    printf '# end count=%s\n' "$count" >> "$tmp"
    mv "$tmp" "$manifest"
    echo "PASS: wrote artifact manifest ($count files) at $manifest"
}

cmd_verify() {
    local dir="$1"
    local require_r2r="$2"
    [[ -d "$dir" ]] || fail "artifact directory '$dir' does not exist (incomplete artifact download/extraction)"

    local manifest="$dir/$MANIFEST_NAME"
    [[ -f "$manifest" && -s "$manifest" ]] || fail "artifact manifest missing or empty at '$manifest' (incomplete artifact download/extraction)"

    local errors=()
    local seen_names=""
    local ended=0
    local declared_count=0
    local count=0
    local line_pat='^([0-9a-f]{64}) ([0-9]+) ([^/]+)$'
    local end_pat='^# end count=([0-9]+)$'
    local line expected_sha expected_sz fname path actual_sz actual_sha

    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ "$ended" -eq 1 ]]; then
            errors+=("unexpected trailing content after manifest end marker")
            break
        fi
        if [[ "$line" =~ $end_pat ]]; then
            declared_count="${BASH_REMATCH[1]}"
            ended=1
            continue
        fi
        if ! [[ "$line" =~ $line_pat ]]; then
            errors+=("malformed manifest line: $line")
            continue
        fi
        expected_sha="${BASH_REMATCH[1]}"
        expected_sz="${BASH_REMATCH[2]}"
        fname="${BASH_REMATCH[3]}"
        if [[ "$fname" == "." || "$fname" == ".." || "$fname" == "$MANIFEST_NAME" ]]; then
            errors+=("invalid filename in manifest: $fname")
            continue
        fi
        case "$seen_names" in
            *$'\n'"$fname"$'\n'*)
                errors+=("duplicate entry in manifest: $fname")
                continue
                ;;
        esac
        seen_names="${seen_names}"$'\n'"$fname"$'\n'
        count=$((count + 1))

        path="$dir/$fname"
        if [[ ! -f "$path" || -d "$path" ]]; then
            errors+=("missing file from artifact: $fname")
            continue
        fi
        actual_sz="$(size_file "$path")"
        if [[ "$actual_sz" != "$expected_sz" ]]; then
            errors+=("size mismatch for $fname: expected $expected_sz bytes, got $actual_sz bytes")
            continue
        fi
        actual_sha="$(sha256_file "$path")"
        if [[ "$actual_sha" != "$expected_sha" ]]; then
            errors+=("checksum mismatch for $fname: expected $expected_sha, got $actual_sha")
            continue
        fi
    done < "$manifest"

    if [[ "$ended" -ne 1 ]]; then
        errors+=("truncated artifact manifest: missing '# end count=<N>' marker")
    elif [[ "$count" -eq 0 ]]; then
        errors+=("artifact manifest lists zero files")
    elif [[ "$count" -ne "$declared_count" ]]; then
        errors+=("manifest count mismatch: declared $declared_count, found $count")
    fi

    local entries name
    entries="$(list_dir_entries "$dir")"
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        case "$seen_names" in
            *$'\n'"$name"$'\n'*) ;;
            *) errors+=("unexpected file in artifact directory '$dir': $name") ;;
        esac
    done <<EOF
$entries
EOF

    if [[ "$require_r2r" == "true" ]]; then
        local r2r_err=""
        if ! r2r_err="$(check_r2r_packages "$dir")"; then
            errors+=("$r2r_err")
        fi
    fi

    if [[ "${#errors[@]}" -gt 0 ]]; then
        echo "FAIL: incomplete or corrupted artifact in '$dir' (${#errors[@]} error(s)):" >&2
        local err
        for err in "${errors[@]}"; do
            echo "  - $err" >&2
        done
        exit 1
    fi

    echo "PASS: verified $count artifact file(s) in $dir"
}

usage() {
    fail "usage: $0 {write|verify} <dir> [--require-r2r-packages]"
}

[[ $# -ge 2 ]] || usage
CMD="$1"
DIR="$2"
shift 2
REQUIRE_R2R="false"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --require-r2r-packages) REQUIRE_R2R="true" ;;
        *) usage ;;
    esac
    shift
done

case "$CMD" in
    write) cmd_write "$DIR" "$REQUIRE_R2R" ;;
    verify) cmd_verify "$DIR" "$REQUIRE_R2R" ;;
    *) usage ;;
esac
