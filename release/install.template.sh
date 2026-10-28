#!/bin/sh
# Installs the Erden CLI @@VERSION@@ for this user, with no administrator rights: the archive for this platform goes
# to ~/.local/share/erden/@@VERSION@@/ and `erden` is linked into ~/.local/bin. The archive is checked against the
# SHA-256 digest this script carries before anything is extracted, so a swapped or partial download is refused.
#
#   sh install.sh                      download the archive from the GitHub release
#   sh install.sh --archive <file>     install a local archive, with no network request
#
# Written by release/write-install-scripts.mjs from release/pins/@@VERSION@@.json. Do not edit by hand.
set -eu

version='@@VERSION@@'
release_url="https://github.com/cbnsndwch/erden/releases/download/v$version"
@@ARCHIVES@@

fail() {
    printf 'erden install: %s\n' "$1" >&2
    exit 1
}

archive=''
while [ "$#" -gt 0 ]; do
    case $1 in
        --archive)
            [ "$#" -ge 2 ] || fail '--archive needs a file'
            archive=$2
            shift 2
            ;;
        -h | --help)
            sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) fail "unknown argument: $1" ;;
    esac
done

case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported platform: $(uname -s) $(uname -m); Erden supports linux-x64, linux-arm64, darwin-arm64 and win32-x64" ;;
esac
case $(uname -m) in
    x86_64 | amd64) cpu=x64 ;;
    aarch64 | arm64) cpu=arm64 ;;
    *) cpu=$(uname -m) ;;
esac
platform="$os-$cpu"
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "unsupported platform: $platform with musl; the engines need glibc"
fi
case $platform in
    linux-x64) file=$linux_x64_file sha=$linux_x64_sha256 bytes=$linux_x64_bytes ;;
    linux-arm64) file=$linux_arm64_file sha=$linux_arm64_sha256 bytes=$linux_arm64_bytes ;;
    darwin-arm64) file=$darwin_arm64_file sha=$darwin_arm64_sha256 bytes=$darwin_arm64_bytes ;;
    *) fail "unsupported platform: $platform; Erden supports linux-x64, linux-arm64, darwin-arm64 and win32-x64" ;;
esac
[ -n "$file" ] || fail "Erden $version has no archive for $platform"

digest() {
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif command -v shasum > /dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        fail 'neither sha256sum nor shasum is available to check the archive'
    fi
}

home=${HOME:?HOME is not set}
data="$home/.local/share/erden"
target="$data/$version"
mkdir -p "$data"
work=$(mktemp -d "$data/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

if [ -n "$archive" ]; then
    [ -f "$archive" ] || fail "no such archive: $archive"
    cp "$archive" "$work/$file"
else
    url="$release_url/$file"
    if command -v curl > /dev/null 2>&1; then
        curl -fsSL --proto '=https' -A 'erden-install/1' -o "$work/$file" "$url" || fail "could not download $url"
    elif command -v wget > /dev/null 2>&1; then
        wget -q -U 'erden-install/1' -O "$work/$file" "$url" || fail "could not download $url"
    else
        fail 'neither curl nor wget is available; download the archive and run with --archive <file>'
    fi
fi

size=$(wc -c < "$work/$file" | tr -d ' ')
[ "$size" = "$bytes" ] || fail "the archive is $size bytes, not the $bytes bytes of $file (a partial or different download); nothing was installed"
[ "$(digest "$work/$file")" = "$sha" ] || fail "the archive's SHA-256 is not the one $file was released with; nothing was installed"

mkdir "$work/extract"
(cd "$work/extract" && gzip -dc "../$file" | tar -xf -) || fail "could not extract $file; nothing was installed"
unpacked="$work/extract/erden-$version-$platform"
[ -x "$unpacked/bin/erden" ] || fail "$file does not hold bin/erden; nothing was installed"
[ -x "$unpacked/bin/den" ] || fail "$file does not hold bin/den; nothing was installed"

rm -rf "$target"
mv "$unpacked" "$target"
mkdir -p "$home/.local/bin"
ln -sf "$target/bin/erden" "$home/.local/bin/erden"
ln -sf "$target/bin/den" "$home/.local/bin/den"

printf 'Installed Erden %s to %s\n' "$version" "$target"
case ":${PATH:-}:" in
    *":$home/.local/bin:"*) ;;
    *) printf 'Add %s to your PATH to run erden.\n' "$home/.local/bin" ;;
esac
