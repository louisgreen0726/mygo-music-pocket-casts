$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dist = Join-Path $root "dist"
$zip = Join-Path $dist "plugin.zip"
$staging = Join-Path ([IO.Path]::GetTempPath()) ("mygo-source-starter-" + [Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $dist | Out-Null
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
  Copy-Item -LiteralPath (Join-Path $root "plugin.json") -Destination $staging -Force
  Copy-Item -LiteralPath (Join-Path $root "index.js") -Destination $staging -Force
  Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $staging -Force
  Copy-Item -LiteralPath (Join-Path $root "locales") -Destination $staging -Recurse -Force

  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
}
finally {
  $resolvedStaging = [IO.Path]::GetFullPath($staging)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if ($resolvedStaging.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}

Write-Host "Packaged $zip"
