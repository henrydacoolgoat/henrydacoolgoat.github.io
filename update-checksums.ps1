$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$browserDirectory = Join-Path $projectDirectory 'asteroid-browser'
$browserOutputPath = Join-Path $browserDirectory 'SHA256SUMS.txt'

if (Test-Path -LiteralPath $browserDirectory) {
  $browserLines = Get-ChildItem -LiteralPath $browserDirectory -Recurse -File |
    Where-Object { $_.FullName -ne $browserOutputPath } |
    Sort-Object FullName |
    ForEach-Object {
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $relativePath = [System.IO.Path]::GetRelativePath($browserDirectory, $_.FullName).Replace('\', '/')
      "$hash  $relativePath"
    }

  $browserText = if ($browserLines.Count) { [string]::Join("`n", $browserLines) + "`n" } else { '' }
  [System.IO.File]::WriteAllText($browserOutputPath, $browserText, $utf8WithoutBom)
}

$outputPath = Join-Path $projectDirectory 'SHA256SUMS.txt'
$lines = Get-ChildItem -LiteralPath $projectDirectory -Recurse -File |
  Where-Object { $_.FullName -ne $outputPath } |
  Sort-Object FullName |
  ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relativePath = [System.IO.Path]::GetRelativePath($projectDirectory, $_.FullName).Replace('\\', '/')
    "$hash  $relativePath"
  }

$outputText = if ($lines.Count) { [string]::Join("`n", $lines) + "`n" } else { '' }
[System.IO.File]::WriteAllText($outputPath, $outputText, $utf8WithoutBom)
Write-Output "Updated $outputPath"
