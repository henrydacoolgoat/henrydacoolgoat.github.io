param(
  [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root)
$indexPath = Join-Path $rootPath 'index.html'
$coverDirectory = Join-Path $rootPath 'freeperiod-covers'
$manifestPath = Join-Path $rootPath 'freeperiod-cover-manifest.json'

if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
  throw "Asteroid OS index.html was not found at $indexPath"
}

$resolvedRoot = (Resolve-Path -LiteralPath $rootPath).Path
if (-not (Test-Path -LiteralPath $coverDirectory)) {
  New-Item -ItemType Directory -Path $coverDirectory | Out-Null
}
$resolvedCoverDirectory = (Resolve-Path -LiteralPath $coverDirectory).Path
if (-not $resolvedCoverDirectory.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The FreePeriod cover directory is outside the Asteroid OS repository.'
}

function Normalize-GameName([string]$Value) {
  $name = [IO.Path]::GetFileNameWithoutExtension([string]$Value).ToLowerInvariant()
  return [regex]::Replace($name, '[^a-z0-9]', '')
}

function Get-SafeCoverName([string]$Value) {
  $name = [IO.Path]::GetFileNameWithoutExtension([string]$Value).ToLowerInvariant()
  $name = [regex]::Replace($name, '[^a-z0-9]+', '-')
  $name = $name.Trim('-')
  if (-not $name) { return 'game' }
  return $name
}

function Get-ImageExtension([string]$Path) {
  $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($extension -eq '.jpeg') { return '.jpg' }
  if ($extension -notin @('.jpg', '.png', '.webp')) { throw "Unsupported cover extension: $extension" }
  return $extension
}

$indexSource = [IO.File]::ReadAllText($indexPath)
$payloadMatch = [regex]::Match($indexSource, "const FREE_PERIOD_HTML_BASE64='([A-Za-z0-9+/=]+)';")
if (-not $payloadMatch.Success) { throw 'The embedded FreePeriod payload was not found.' }
$freePeriodSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadMatch.Groups[1].Value))
$gameMatch = [regex]::Match($freePeriodSource, 'const FREE_PERIOD_GAME_NAMES = Object\.freeze\((\[[^;]+\])\);')
if (-not $gameMatch.Success) { throw 'The 300-game FreePeriod manifest was not found.' }
$games = @($gameMatch.Groups[1].Value | ConvertFrom-Json)
if ($games.Count -ne 300) { throw "Expected 300 FreePeriod games, found $($games.Count)." }

$repositories = [ordered]@{
  'retrobowlubg/retrobowlubg.github.io' = 'main'
  'unblokedgames/unblokedgames.github.io' = 'main'
}
$trees = @{}
foreach ($repository in $repositories.Keys) {
  $branch = $repositories[$repository]
  $treeUrl = "https://api.github.com/repos/$repository/git/trees/$branch`?recursive=1"
  $trees[$repository] = @((Invoke-RestMethod -Uri $treeUrl -Headers @{ 'User-Agent' = 'Asteroid-OS-FreePeriod-cover-sync' } -TimeoutSec 90).tree)
}

$retroRepository = 'retrobowlubg/retrobowlubg.github.io'
$projectRepository = 'unblokedgames/unblokedgames.github.io'

$explicit = @{}
$retroAliases = [ordered]@{
  badicecream = 'bad-ice-cream-2'
  baldisbasics = 'baldi'
  bitlife = 'bitlife-life-simulator'
  bobtherobber = 'bob-the-robber-2'
  bobtherobber5 = 'bob-the-robber-5-temple-adventure'
  cardrawing = 'car-drawing-game'
  chess = 'master-chess'
  ducklife = 'ducklife-4'
  fireboyandwatergirl = 'fireboy-and-watergirl-1'
  fnaf2 = 'fnaf'
  funnybattle = 'funny-battle-simulator'
  geometrydashlite = 'geometry-dash'
  hillclimbracinglite = 'hill-climb-racing'
  motox3m = 'motox3m-2'
  redball4vol1 = 'red-ball-4'
  redball4vol2 = 'red-ball-4'
  redball4vol3 = 'red-ball-4'
  slope = 'slope3'
  snowrider = 'snow-rider-3d'
  superhot = 'superhot-prototype'
  thereisnog = 'there-is-no-game'
  timeshooter3 = 'time-shooter-3-swat'
  tunnelrush = 'tunnel-rush-2'
  wheely8 = 'wheely-8-1'
}
foreach ($key in $retroAliases.Keys) {
  $stem = $retroAliases[$key]
  $entry = $trees[$retroRepository] | Where-Object {
    $_.type -eq 'blob' -and $_.path -match "^img/jpg/$([regex]::Escape($stem))\.(webp|png|jpe?g)$"
  } | Select-Object -First 1
  if ($entry) { $explicit[$key] = [pscustomobject]@{ Repository = $retroRepository; Branch = 'main'; Path = $entry.path; Kind = 'published-thumbnail' } }
}

$projectAliases = [ordered]@{
  '2048' = 'projects/2048/thumb.png'
  agesofconflict = 'projects/ages-of-conflict/splash.jpg'
  baldisbasics = 'projects/baldis-basics/baldis-basics.png'
  bitlife = 'projects/bitlife/logo.png'
  crazycattle3d = 'projects/crazy-cattle-3d/CrazyCattle3D.png'
  fnaf2 = 'projects/fnaf-2/fnaf-2.jpg'
  fruitninja = 'projects/fruit-ninja/thumb.png'
  minesweeper = 'projects/minesweeper/img/minesweeper.png'
  motox3m = 'projects/moto-x3m/Teaser.jpg'
  motox3mpoolparty = 'projects/moto-x3m-pool-party/moto-x3m-pool-party.png'
  motox3mwinter = 'projects/moto-x3m-winter/moto-x3m-winter.jpg'
  ovo2 = 'projects/ovo-2/icons/icon-256.png'
  pacman = 'projects/pacman/thumbnail.png'
  slope = 'projects/slope/slope4.jpeg'
  stack = 'projects/stack/icon.png'
  subwaysurferssanfrancisco = 'projects/subway-surfers-san-francisco/img/splash.png'
}
foreach ($key in $projectAliases.Keys) {
  $path = $projectAliases[$key]
  if ($trees[$projectRepository] | Where-Object { $_.type -eq 'blob' -and $_.path -eq $path } | Select-Object -First 1) {
    $explicit[$key] = [pscustomobject]@{ Repository = $projectRepository; Branch = 'main'; Path = $path; Kind = 'published-project-art' }
  }
}

$minecraftCover = 'projects/minecraft/thumb.png'
foreach ($key in @('112', '15', '18', 'alpha126', 'beta13', 'indev')) {
  $explicit[$key] = [pscustomobject]@{ Repository = $projectRepository; Branch = 'main'; Path = $minecraftCover; Kind = 'published-project-art' }
}
$bloonsCover = 'flash/bloons-td/bloonstd.jpg'
foreach ($key in @('bloonstd', 'bloonstd2', 'bloonstd3', 'bloonstd4', 'bloonstd5')) {
  $explicit[$key] = [pscustomobject]@{ Repository = $projectRepository; Branch = 'main'; Path = $bloonsCover; Kind = 'published-project-art' }
}

$candidates = @()
foreach ($repository in $repositories.Keys) {
  foreach ($entry in $trees[$repository]) {
    if ($entry.type -ne 'blob' -or $entry.path -notmatch '(?i)\.(webp|png|jpe?g)$') { continue }
    $parts = @($entry.path -split '/')
    $baseName = [IO.Path]::GetFileNameWithoutExtension($entry.path)
    $priority = $null
    $kind = $null
    if ($repository -eq $retroRepository -and $entry.path -match '^img/jpg/') {
      $priority = 10
      $kind = 'published-thumbnail'
    } elseif ($baseName -match '(?i)^(cover|thumb|thumbnail|logo|splash|icon|teaser)$') {
      $priority = 20
      $kind = 'published-project-art'
    } elseif ($baseName -match '(?i)(cover|thumb|thumbnail|logo|splash|icon|teaser)') {
      $priority = 30
      $kind = 'published-project-art'
    }
    if ($null -eq $priority -or [int64]$entry.size -lt 900) { continue }
    $normalizedSegments = @($parts | ForEach-Object { Normalize-GameName $_ } | Where-Object { $_ })
    $candidates += [pscustomobject]@{
      Repository = $repository
      Branch = $repositories[$repository]
      Path = $entry.path
      Size = [int64]$entry.size
      Priority = $priority
      Kind = $kind
      BaseNorm = Normalize-GameName $baseName
      SegmentNorms = $normalizedSegments
    }
  }
}

$manifestGames = [ordered]@{}
$publishedCount = 0
$titleCardCount = 0
$downloadFailures = @()

foreach ($game in $games) {
  $key = Normalize-GameName $game
  $sourceAsset = $explicit[$key]
  if (-not $sourceAsset) {
    $sourceAsset = $candidates |
      Where-Object { $_.BaseNorm -eq $key -or $_.SegmentNorms -contains $key } |
      Sort-Object Priority, @{ Expression = 'Size'; Descending = $true }, Path |
      Select-Object -First 1
  }

  if ($sourceAsset) {
    $extension = Get-ImageExtension $sourceAsset.Path
    $localName = (Get-SafeCoverName $game) + $extension
    $destination = Join-Path $coverDirectory $localName
    $rawSegments = @($sourceAsset.Path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) })
    $sourceUrl = "https://raw.githubusercontent.com/$($sourceAsset.Repository)/$($sourceAsset.Branch)/$($rawSegments -join '/')"
    $temporary = "$destination.download"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $temporary -TimeoutSec 60
      $download = Get-Item -LiteralPath $temporary
      if ($download.Length -lt 900) { throw "Downloaded asset is unexpectedly small ($($download.Length) bytes)." }
      Move-Item -LiteralPath $temporary -Destination $destination -Force
      $publishedCount++
      $manifestGames[$game] = [ordered]@{
        type = $sourceAsset.Kind
        file = "freeperiod-covers/$localName"
        source = $sourceUrl
      }
      continue
    } catch {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
      $downloadFailures += [pscustomobject]@{ Game = $game; Source = $sourceUrl; Error = $_.Exception.Message }
    }
  }

  $titleCardCount++
  $manifestGames[$game] = [ordered]@{
    type = 'freeperiod-title-card'
    file = $null
    source = $null
  }
}

$manifest = [ordered]@{
  version = 'freeperiod-published-art-and-title-cards-2026-08-09'
  policy = 'Never use screenshots captured from a running game. Prefer published GitHub logo/thumbnail art and use a deterministic FreePeriod title card when no source artwork is available.'
  game_source = 'https://github.com/CoolDude2349/Offline-HTML-Games-Pack'
  original_canvas_archive = [ordered]@{
    url = 'https://canvas.instructure.com/files/325055662/download'
    status = 'unavailable-after-free-for-teacher-discontinuation'
  }
  games_total = $games.Count
  published_art = $publishedCount
  title_cards = $titleCardCount
  games = $manifestGames
}

$json = $manifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  Games = $games.Count
  PublishedArt = $publishedCount
  TitleCards = $titleCardCount
  DownloadFailures = $downloadFailures.Count
  Manifest = $manifestPath
} | ConvertTo-Json -Compress

if ($downloadFailures.Count) {
  $downloadFailures | Format-Table -AutoSize | Out-String -Width 240 | Write-Warning
}
