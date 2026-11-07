$ErrorActionPreference = "Stop"

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$plugins = [IO.Path]::GetFullPath((Join-Path $env:APPDATA "MyGo Music\plugins"))
$target = [IO.Path]::GetFullPath((Join-Path $plugins "pocket-casts"))

if (-not (Test-Path -LiteralPath $plugins)) {
  throw "MyGo Music plugins folder was not found: $plugins"
}

$pluginsPrefix = $plugins.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $target.StartsWith($pluginsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to install outside the MyGo Music plugins folder: $target"
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $root "plugin.json") -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root "index.js") -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root "locales") -Destination $target -Recurse -Force

Write-Host "Installed to $target"
Write-Host "Restart MyGo Music, then choose Pocket Casts in Settings > Plugins."
