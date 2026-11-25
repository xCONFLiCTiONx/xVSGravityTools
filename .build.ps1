
# xVSGravityTools Build Script
# Installs dependencies, compiles, packages, and installs the IDE extension.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Building xVSGravityTools Extension (.vsix)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Install Dependencies
Write-Host "`n[1/4] Installing npm dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

# Step 2: Compile TypeScript
Write-Host "`n[2/4] Compiling TypeScript..." -ForegroundColor Yellow
npm run compile
if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed." }

# Step 3: Package VSIX
Write-Host "`n[3/4] Packaging extension into .vsix..." -ForegroundColor Yellow

$manifest = Get-Content ".\package.json" -Raw | ConvertFrom-Json
$vsixName = "$($manifest.name)-$($manifest.version).vsix"
$vsixPath = Join-Path $PSScriptRoot $vsixName

npx @vscode/vsce package --no-dependencies --allow-missing-repository --out $vsixPath
if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }

if (!(Test-Path $vsixPath)) {
    throw "Packaged VSIX not found: $vsixPath"
}

# Step 4: Install Extension
Write-Host "`n[4/4] Installing xVSGravityTools into IDE..." -ForegroundColor Yellow

$ideCli = $null
$candidates = @(
    "antigravity-ide",
    "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd",
    "$env:ProgramFiles\Antigravity IDE\bin\antigravity-ide.cmd",
    "code",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
)
foreach ($candidate in $candidates) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $ideCli = $cmd.Source; break }
    if (Test-Path $candidate) { $ideCli = $candidate; break }
}

if (!$ideCli) {
    throw "No supported IDE CLI ('antigravity-ide' or 'code') was found. The VSIX was packaged at $vsixPath but could not be installed."
}

Write-Host "Using CLI: $ideCli" -ForegroundColor DarkGray
& $ideCli --install-extension $vsixPath --force
if ($LASTEXITCODE -ne 0) { throw "Extension installation failed." }

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Build, packaging, and installation complete!" -ForegroundColor Green
Write-Host "Installed: $vsixName" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
