$ErrorActionPreference = 'Stop'

$qualification = $PSScriptRoot
$reasoner = (Resolve-Path (Join-Path $qualification '..')).Path
$repository = (Resolve-Path (Join-Path $reasoner '..')).Path
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("erden-binary-repro-" + [Guid]::NewGuid().ToString('N'))
$qualificationBaseCommit = 'a7a44865ede35d6e5aaba29c0ad114cd993456a6'
$sourceDateEpoch = '1785703783'
$linuxImage = 'rust@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc'
& git -C $repository cat-file -e "$qualificationBaseCommit`^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Qualification source commit $qualificationBaseCommit is unavailable. In a shallow clone, fetch that exact commit before rerunning qualification."
}
$adapterChanges = @(& git -C $repository diff --name-only $qualificationBaseCommit -- reasoner/erden-reasoner)
$adapterUntracked = @(& git -C $repository ls-files --others --exclude-standard -- reasoner/erden-reasoner)
if ($adapterChanges.Count -ne 0 -or $adapterUntracked.Count -ne 0) {
    throw 'The working adapter crate differs from the accepted qualification source. Commit a new source batch before requalification.'
}
$reasonerCommitTree = (& git -C $repository rev-parse "$qualificationBaseCommit`:reasoner").Trim()
if ($LASTEXITCODE -ne 0 -or $reasonerCommitTree -notmatch '^[0-9a-f]{40}$') {
    throw "Cannot resolve reasoner tree at qualification base commit $qualificationBaseCommit"
}
$adapterCrateSourceTree = (& git -C $repository rev-parse "$qualificationBaseCommit`:reasoner/erden-reasoner").Trim()
if ($LASTEXITCODE -ne 0 -or $adapterCrateSourceTree -notmatch '^[0-9a-f]{40}$') {
    throw "Cannot resolve adapter crate tree at qualification base commit $qualificationBaseCommit"
}

function Get-ArtifactRecord([string]$Path, [string]$Label, [string]$SourcePathLabel) {
    $item = Get-Item -LiteralPath $Path
    return [ordered]@{
        label = $Label
        sourcePath = $SourcePathLabel
        bytes = $item.Length
        sha256 = 'sha256:' + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

# Refuses an export whose files are not exactly the commit's reasoner blobs: same paths, same raw bytes. This catches
# line-ending conversion and eol, export-ignore or export-subst attributes, which change what git archive writes.
function Assert-ExportMatchesCommit([string]$ExportRoot, [string]$Label) {
    $expected = @{}
    $listing = @(& git -C $repository ls-tree -r --full-tree $qualificationBaseCommit -- reasoner)
    if ($LASTEXITCODE -ne 0 -or $listing.Count -eq 0) { throw "Cannot list the reasoner tree of $qualificationBaseCommit" }
    foreach ($entry in $listing) {
        $meta, $path = $entry -split "`t", 2
        $mode, $type, $id = $meta -split ' '
        if ($type -ne 'blob' -or $mode -eq '120000' -or $path.StartsWith('"')) {
            throw "Cannot verify the export of $path ($mode $type)"
        }
        $expected[$path] = $id
    }
    $root = (Resolve-Path -LiteralPath $ExportRoot).Path
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File | Sort-Object FullName)
    $paths = @($files | ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') })
    $ids = @($files | ForEach-Object { $_.FullName } | & git -C $repository hash-object --no-filters --stdin-paths)
    if ($LASTEXITCODE -ne 0 -or $ids.Count -ne $paths.Count) { throw "Cannot hash the exported source $Label" }
    $problems = @()
    for ($index = 0; $index -lt $paths.Count; $index++) {
        if ($expected[$paths[$index]] -ne $ids[$index].Trim()) { $problems += "differs: $($paths[$index])" }
    }
    foreach ($path in $expected.Keys) {
        if ($paths -notcontains $path) { $problems += "missing: $path" }
    }
    if ($problems.Count -ne 0) {
        throw "Exported source $Label is not byte-identical to $qualificationBaseCommit (line-ending conversion or export attributes?):`n$($problems -join "`n")"
    }
}

function Export-ReasonerSource([string]$Label) {
    $exportRoot = Join-Path $temporaryRoot $Label
    $archive = Join-Path $temporaryRoot "$Label.tar"
    New-Item -ItemType Directory -Path $exportRoot | Out-Null
    # git archive writes files as a checkout would: core.autocrlf=true, the Git for Windows default, makes them CRLF.
    & git -c core.autocrlf=false -c core.eol=lf -C $repository archive --format=tar --output=$archive $qualificationBaseCommit reasoner
    if ($LASTEXITCODE -ne 0) { throw "Git archive failed for $Label`: $LASTEXITCODE" }
    & tar -xf $archive -C $exportRoot
    if ($LASTEXITCODE -ne 0) { throw "Source extraction failed for $Label`: $LASTEXITCODE" }
    $source = Join-Path $exportRoot 'reasoner'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'Cargo.lock') -PathType Leaf)) {
        throw "Exported source $Label is incomplete"
    }
    Assert-ExportMatchesCommit $exportRoot $Label
    return $source
}

function Invoke-WindowsBuild([string]$TargetDirectory, [string]$SourceDirectory) {
    $savedTarget = $env:CARGO_TARGET_DIR
    $savedIncremental = $env:CARGO_INCREMENTAL
    $savedEpoch = $env:SOURCE_DATE_EPOCH
    $savedFlags = $env:RUSTFLAGS
    try {
        $cargoDirectory = (Resolve-Path (Join-Path $env:USERPROFILE '.cargo')).Path
        $env:CARGO_TARGET_DIR = $TargetDirectory
        $env:CARGO_INCREMENTAL = '0'
        $env:SOURCE_DATE_EPOCH = $sourceDateEpoch
        $env:RUSTFLAGS = "-C link-arg=/Brepro --remap-path-prefix=$SourceDirectory=/erden-reasoner --remap-path-prefix=$cargoDirectory=/cargo"
        & rustup run 1.96.0 cargo build --release --locked --target x86_64-pc-windows-msvc --bin erden-reasoner --manifest-path (Join-Path $SourceDirectory 'Cargo.toml')
        if ($LASTEXITCODE -ne 0) { throw "Windows Cargo build failed: $LASTEXITCODE" }
    } finally {
        $env:CARGO_TARGET_DIR = $savedTarget
        $env:CARGO_INCREMENTAL = $savedIncremental
        $env:SOURCE_DATE_EPOCH = $savedEpoch
        $env:RUSTFLAGS = $savedFlags
    }
    return Join-Path $TargetDirectory 'x86_64-pc-windows-msvc\release\erden-reasoner.exe'
}

function Invoke-LinuxBuild([string]$TargetDirectory, [string]$SourceDirectory) {
    New-Item -ItemType Directory -Path $TargetDirectory | Out-Null
    $mountSource = "type=bind,source=$SourceDirectory,target=/work,readonly"
    $mountTarget = "type=bind,source=$TargetDirectory,target=/target"
    $command = 'export CARGO_TARGET_DIR=/target CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=1785703783; export RUSTFLAGS="-C link-arg=-Wl,--build-id=none --remap-path-prefix=/work=/erden-reasoner --remap-path-prefix=/usr/local/cargo=/cargo"; cargo build --release --locked --target x86_64-unknown-linux-gnu --bin erden-reasoner'
    & docker run --rm --mount $mountSource --mount $mountTarget --workdir /work $linuxImage sh -c $command
    if ($LASTEXITCODE -ne 0) { throw "Linux Docker build failed: $LASTEXITCODE" }
    return Join-Path $TargetDirectory 'x86_64-unknown-linux-gnu\release\erden-reasoner'
}

function Assert-Reproducible([System.Collections.IDictionary]$First, [System.Collections.IDictionary]$Second, [string]$Platform) {
    if ($First.sha256 -ne $Second.sha256 -or $First.bytes -ne $Second.bytes) {
        throw "$Platform release executable is not byte reproducible"
    }
}

function Install-VerifiedPackageBinary(
    [string]$BuiltPath,
    [string]$PackagePath,
    [System.Collections.IDictionary]$First,
    [System.Collections.IDictionary]$Second,
    [string]$Platform,
    [string]$RepositoryPath
) {
    $temporaryPackagePath = "$PackagePath.qualification-new"
    Copy-Item -LiteralPath $BuiltPath -Destination $temporaryPackagePath -Force
    Move-Item -LiteralPath $temporaryPackagePath -Destination $PackagePath -Force
    $package = Get-ArtifactRecord $PackagePath 'checked-package-binary' $RepositoryPath
    if ($package.sha256 -ne $First.sha256 -or $package.bytes -ne $First.bytes -or
        $package.sha256 -ne $Second.sha256 -or $package.bytes -ne $Second.bytes) {
        throw "$Platform checked package binary does not match both reproducible build runs"
    }
    $package.matchesAllRecordedRuns = $true
    return $package
}

New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    $sourceA = Export-ReasonerSource 'git-archive-a'
    $sourceB = Export-ReasonerSource 'git-archive-b'
    $lockDigestA = 'sha256:' + (Get-FileHash -LiteralPath (Join-Path $sourceA 'Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
    $lockDigestB = 'sha256:' + (Get-FileHash -LiteralPath (Join-Path $sourceB 'Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($lockDigestA -ne $lockDigestB) { throw 'Archived Cargo.lock differs across source exports' }
    $lockDigest = $lockDigestA
    # When this commit carries the accepted lock, the export must hash to the accepted record's digest.
    $accepted = Get-Content -Raw -LiteralPath (Join-Path $qualification 'binary-reproducibility.json') | ConvertFrom-Json
    if ($accepted.cargoLockDigest) {
        $carriesAcceptedLock = $accepted.qualificationSourceCommit -eq $qualificationBaseCommit
        if (-not $carriesAcceptedLock) {
            & git -C $repository cat-file -e "$($accepted.qualificationSourceCommit)`^{commit}" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $carriesAcceptedLock = (& git -C $repository rev-parse "$qualificationBaseCommit`:reasoner/Cargo.lock") -eq
                    (& git -C $repository rev-parse "$($accepted.qualificationSourceCommit)`:reasoner/Cargo.lock")
            }
        }
        if ($carriesAcceptedLock -and $lockDigest -ne $accepted.cargoLockDigest) {
            throw "The exported Cargo.lock is $lockDigest, but the accepted record's digest is $($accepted.cargoLockDigest)"
        }
    }
    $windowsAPath = Invoke-WindowsBuild (Join-Path $temporaryRoot 'windows-a') $sourceA
    $windowsBPath = Invoke-WindowsBuild (Join-Path $temporaryRoot 'windows-b') $sourceB
    $linuxAPath = Invoke-LinuxBuild (Join-Path $temporaryRoot 'linux-a') $sourceA
    $linuxBPath = Invoke-LinuxBuild (Join-Path $temporaryRoot 'linux-b') $sourceB
    $windowsA = Get-ArtifactRecord $windowsAPath 'clean-target-a' 'git-archive-a'
    $windowsB = Get-ArtifactRecord $windowsBPath 'clean-target-b' 'git-archive-b'
    $linuxA = Get-ArtifactRecord $linuxAPath 'clean-target-a' 'git-archive-a'
    $linuxB = Get-ArtifactRecord $linuxBPath 'clean-target-b' 'git-archive-b'
    Assert-Reproducible $windowsA $windowsB 'Windows'
    Assert-Reproducible $linuxA $linuxB 'Linux'

    $windowsPackage = Install-VerifiedPackageBinary $windowsAPath (Join-Path $reasoner 'win32-x64-msvc\bin\erden-reasoner.exe') $windowsA $windowsB 'Windows' 'reasoner/win32-x64-msvc/bin/erden-reasoner.exe'
    $linuxPackage = Install-VerifiedPackageBinary $linuxAPath (Join-Path $reasoner 'linux-x64-gnu\bin\erden-reasoner') $linuxA $linuxB 'Linux' 'reasoner/linux-x64-gnu/bin/erden-reasoner'
    $evidence = [ordered]@{
        schemaVersion = 2
        qualificationBaseCommit = $qualificationBaseCommit
        qualificationSourceCommit = $qualificationBaseCommit
        qualificationReasonerCommitTree = $reasonerCommitTree
        adapterCrateSourceTree = $adapterCrateSourceTree
        cargoLockDigest = $lockDigest
        sourceDateEpoch = [long]$sourceDateEpoch
        toolchain = [ordered]@{
            rustc = '1.96.0'
            commit = 'ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96'
            llvm = '22.1.2'
        }
        source = [ordered]@{
            extraction = 'git-archive'
            adapterCratePath = 'reasoner/erden-reasoner'
            purrdfCrateVersion = '0.12.0'
            purrdfCommit = 'dfb1df73199668720116dfbc737c0585e23afb5e'
        }
        windows = [ordered]@{
            target = 'x86_64-pc-windows-msvc'
            rustflags = '-C link-arg=/Brepro --remap-path-prefix=<reasoner>=/erden-reasoner --remap-path-prefix=<cargo-home>=/cargo'
            runs = @($windowsA, $windowsB)
            package = $windowsPackage
            result = 'byte-identical-and-package-matched'
        }
        linux = [ordered]@{
            target = 'x86_64-unknown-linux-gnu'
            builderImage = $linuxImage
            rustflags = '-C link-arg=-Wl,--build-id=none --remap-path-prefix=/work=/erden-reasoner --remap-path-prefix=/usr/local/cargo=/cargo'
            runs = @($linuxA, $linuxB)
            package = $linuxPackage
            result = 'byte-identical-and-package-matched'
        }
    }
    $json = $evidence | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $qualification 'binary-reproducibility.json'), $json.Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Windows: $($windowsPackage.sha256) ($($windowsPackage.bytes) bytes); package matches both runs"
    Write-Output "Linux: $($linuxPackage.sha256) ($($linuxPackage.bytes) bytes); package matches both runs"
} finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedSystemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemporary.StartsWith($resolvedSystemTemporary, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $resolvedTemporary).StartsWith('erden-binary-repro-', [StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
    }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
