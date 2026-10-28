# Installs the Erden CLI @@VERSION@@ for this user, with no administrator rights: the archive goes to
# %LOCALAPPDATA%\Programs\Erden\@@VERSION@@\ and the script prints the PATH entry to add. The archive is checked against
# the SHA-256 digest this script carries before anything is extracted, so a swapped or partial download is refused.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1                    download from the GitHub release
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Archive <file>    install a local archive, with no network
#
# Written by release/write-install-scripts.mjs from release/pins/@@VERSION@@.json. Do not edit by hand.
param([string]$Archive = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$version = '@@VERSION@@'
$releaseUrl = "https://github.com/cbnsndwch/erden/releases/download/v$version"
@@ARCHIVES@@

function Fail([string]$message) {
    throw "erden install: $message"
}

$work = $null
try {
    $isWindowsHost = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if (-not $isWindowsHost -or $architecture -ne 'X64') {
        Fail "unsupported platform: $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription) $architecture; install.ps1 installs win32-x64 (use install.sh on Linux and macOS)"
    }
    if ($win32X64File -eq '') { Fail "Erden $version has no archive for win32-x64" }

    $localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }
    $programs = Join-Path (Join-Path $localData 'Programs') 'Erden'
    $target = Join-Path $programs $version
    New-Item -ItemType Directory -Force -Path $programs | Out-Null
    $work = Join-Path $programs ('.install.' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null

    $download = Join-Path $work $win32X64File
    if ($Archive -ne '') {
        if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Fail "no such archive: $Archive" }
        Copy-Item -LiteralPath $Archive -Destination $download
    } else {
        $url = "$releaseUrl/$win32X64File"
        try {
            Invoke-WebRequest -UseBasicParsing -UserAgent 'erden-install/1' -Uri $url -OutFile $download
        } catch {
            Fail "could not download ${url}: $($_.Exception.Message)"
        }
    }
    $size = (Get-Item -LiteralPath $download).Length
    if ($size -ne $win32X64Bytes) {
        Fail "the archive is $size bytes, not the $win32X64Bytes bytes of $win32X64File (a partial or different download); nothing was installed"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
    if ($hash -ne $win32X64Sha256) {
        Fail "the archive's SHA-256 is not the one $win32X64File was released with; nothing was installed"
    }
    $extract = Join-Path $work 'extract'
    Expand-Archive -LiteralPath $download -DestinationPath $extract
    $unpacked = Join-Path $extract "erden-$version-win32-x64"
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $unpacked 'bin') 'erden.cmd') -PathType Leaf)) {
        Fail "$win32X64File does not hold bin\erden.cmd; nothing was installed"
    }
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $unpacked 'bin') 'den.cmd') -PathType Leaf)) {
        Fail "$win32X64File does not hold bin\den.cmd; nothing was installed"
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath $unpacked -Destination $target
    Remove-Item -LiteralPath $work -Recurse -Force
} catch {
    if ($null -ne $work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

Write-Output "Installed Erden $version to $target"
Write-Output "Add $(Join-Path $target 'bin') to your PATH to run erden."
