#!/usr/bin/env pwsh
<#
.SYNOPSIS
  VisionSuit bulk import helper for Windows clients.
.DESCRIPTION
  Securely uploads LoRA safetensors and gallery images to the VisionSuit API using
  the same workflow as the admin upload wizard. The script authenticates against
  the configured VisionSuit instance, verifies service health via /api/meta/status,
  and then processes every LoRA file found in the supplied directory tree. For
  each LoRA the script uploads the model file plus one random preview image
  together, followed by batched uploads of the remaining gallery images.

  The directory layout mirrors the Linux helper:
    ./loras/<lora-name>.safetensors
    ./images/<lora-name>/*.png

  Optional metadata overrides can live next to the safetensors file
  (<lora-name>.json), in the root LoRA directory, or inside the image folder as
  metadata.json. Defaults can also be supplied via VISIONSUIT_* environment
  variables (see parameters below).
#>

[CmdletBinding()]
param(
  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$ServerBaseUrl = "https://visionsuit.local",

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$ServerUsername = "admin@example.com",

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$LorasDirectory = "./loras",

  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$ImagesDirectory = "./images",

  [Parameter()]
  [string]$DefaultVisibility,

  [Parameter()]
  [string]$DefaultGalleryMode,

  [Parameter()]
  [string]$DefaultCategory,

  [Parameter()]
  [string]$DefaultDescription,

  [Parameter()]
  [string[]]$DefaultTags = @(),

  [Parameter()]
  [string]$DefaultTargetGallery,

  [Parameter()]
  [string]$DefaultTrigger,

  [Parameter()]
  [int]$ImageBatchSize = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string]$Message)
  $timestamp = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  Write-Host "[$timestamp] $Message"
}

function ConvertTo-ObjectArray {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [System.Array]) {
    return $Value
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    return @($Value)
  }

  return @($Value)
}

function Get-ObjectCount {
  param($Value)

  if ($null -eq $Value) {
    return 0
  }

  if ($Value -is [System.Collections.ICollection]) {
    return $Value.Count
  }

  if ($Value -is [string]) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
      return 0
    }
    return 1
  }

  $enumerable = $Value -as [System.Collections.IEnumerable]
  if ($enumerable -and -not ($Value -is [string])) {
    $count = 0
    foreach ($item in $enumerable) {
      $count++
    }
    return $count
  }

  return 1
}

function Resolve-ExistingDirectory {
  param([string]$Path, [string]$Description)
  $resolved = Resolve-Path -Path $Path -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "${Description} directory '${Path}' was not found."
  }
  return $resolved.ProviderPath
}

function Get-PropertyValue {
  param(
    $Object,
    [string]$PropertyName
  )

  if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($PropertyName)) {
    return $null
  }

  $property = $Object.PSObject.Properties[$PropertyName]
  if ($property) {
    return $property.Value
  }

  return $null
}

function Get-MimeType {
  param([string]$Path)
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.png' { return 'image/png' }
    '.jpg' { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.webp' { return 'image/webp' }
    '.bmp' { return 'image/bmp' }
    '.gif' { return 'image/gif' }
    default { return 'application/octet-stream' }
  }
}

function ConvertTo-AbsoluteUri {
  param([Uri]$BaseUri, [string]$RelativePath)

  if ([string]::IsNullOrWhiteSpace($RelativePath)) {
    return $BaseUri
  }

  $absolute = $null
  if ([Uri]::TryCreate($RelativePath, [System.UriKind]::Absolute, [ref]$absolute)) {
    return $absolute
  }

  $builder = [System.UriBuilder]::new($BaseUri)

  $baseSegments = @()
  if ($builder.Path -and $builder.Path -ne '/') {
    $baseSegments = $builder.Path.Trim('/') -split '/', [System.StringSplitOptions]::RemoveEmptyEntries
  }

  $relativeSegments = $RelativePath.Trim('/') -split '/', [System.StringSplitOptions]::RemoveEmptyEntries

  if ($baseSegments.Length -gt 0 -and $relativeSegments.Length -gt 0) {
    $lastBase = $baseSegments[$baseSegments.Length - 1]
    $firstRelative = $relativeSegments[0]
    if ($lastBase.Equals($firstRelative, [System.StringComparison]::OrdinalIgnoreCase)) {
      if ($relativeSegments.Length -gt 1) {
        $relativeSegments = $relativeSegments[1..($relativeSegments.Length - 1)]
      }
      else {
        $relativeSegments = @()
      }
    }
  }

  $allSegments = New-Object System.Collections.Generic.List[string]
  foreach ($segment in $baseSegments) {
    if ($segment) { [void]$allSegments.Add($segment) }
  }
  foreach ($segment in $relativeSegments) {
    if ($segment) { [void]$allSegments.Add($segment) }
  }

  if ($allSegments.Count -eq 0) {
    $builder.Path = '/'
  }
  else {
    $builder.Path = '/' + ($allSegments -join '/')
  }

  return $builder.Uri
}

function Read-MetadataFile {
  param([string]$Path)
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if (-not $raw) {
      return @{}
    }
    $json = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($json -is [System.Collections.IDictionary]) {
      return @{} + $json
    }
    Write-Log "Metadata file '$Path' must contain a JSON object. Skipping overrides."
    return @{}
  }
  catch {
    Write-Log "Metadata file '$Path' is not valid JSON: $($_.Exception.Message)."
    return $null
  }
}

function Normalize-String {
  param($Value)
  if ($null -eq $Value) {
    return ''
  }
  if ($Value -is [string]) {
    return $Value.Trim()
  }
  return ($Value.ToString()).Trim()
}

function Build-ModelNameKey {
  param([string]$Value)

  $normalized = Normalize-String -Value $Value
  if (-not $normalized) {
    return $null
  }

  return $normalized.ToLowerInvariant()
}

function Get-ExistingModelIndex {
  param(
    [System.Net.Http.HttpClient]$Client,
    [Uri]$BaseUri
  )

  $modelsUri = ConvertTo-AbsoluteUri -BaseUri $BaseUri -RelativePath '/api/assets/models'
  Write-Log "Fetching existing models from $($modelsUri.AbsoluteUri) to detect duplicates."

  $response = $null
  try {
    $response = $Client.GetAsync($modelsUri).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      throw "Failed to query existing models (HTTP $($response.StatusCode)): $body"
    }

    $index = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not $body) {
      Write-Log 'No existing models returned by the API. Proceeding with an empty catalog.'
      return $index
    }

    try {
      $parsed = $body | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      throw "Existing models response was not valid JSON: $($_.Exception.Message)"
    }

    $collection = @()
    if ($parsed -is [System.Collections.IEnumerable]) {
      $collection = @($parsed)
    }
    elseif ($null -ne $parsed) {
      $collection = @($parsed)
    }

    foreach ($model in $collection) {
      if (-not $model) { continue }

      $titleValue = Get-PropertyValue -Object $model -PropertyName 'title'
      $slugValue = Get-PropertyValue -Object $model -PropertyName 'slug'

      $entry = [pscustomobject]@{
        Title = $titleValue
        Slug = $slugValue
        Source = 'remote'
      }

      $titleKey = $null
      if ($titleValue) {
        $titleKey = Build-ModelNameKey -Value $titleValue
      }
      if ($titleKey) {
        $index[$titleKey] = $entry
      }

      $slugKey = $null
      if ($slugValue) {
        $slugKey = Build-ModelNameKey -Value $slugValue
      }
      if ($slugKey) {
        $index[$slugKey] = $entry
      }
    }

    Write-Log "Loaded $($index.Count) unique model name(s) for duplicate detection."
    return $index
  }
  finally {
    if ($response) { $response.Dispose() }
  }
}

function Normalize-Visibility {
  param([string]$Visibility, [System.Collections.Generic.List[string]]$Warnings)
  $normalized = (Normalize-String -Value $Visibility).ToLowerInvariant()
  if (-not $normalized) {
    $normalized = 'private'
  }
  if ($normalized -ne 'public' -and $normalized -ne 'private') {
    $Warnings.Add("Visibility '$Visibility' is not supported; falling back to 'private'.")
    return 'private'
  }
  return $normalized
}

function Normalize-GalleryMode {
  param([string]$Mode, [string]$Fallback, [System.Collections.Generic.List[string]]$Warnings)
  $normalized = (Normalize-String -Value $Mode).ToLowerInvariant()
  if (-not $normalized) {
    $normalized = $Fallback
  }
  if ($normalized -ne 'new' -and $normalized -ne 'existing') {
    $Warnings.Add("Gallery mode '$Mode' is not supported; falling back to '$Fallback'.")
    return $Fallback
  }
  return $normalized
}

function Collect-Tags {
  param(
    [string[]]$DefaultTags,
    $MetadataValue
  )
  $collected = New-Object System.Collections.Generic.List[string]
  foreach ($entry in ($DefaultTags | Where-Object { $_ })) {
    $collected.Add(($entry.ToString()).Trim())
  }
  function Append-FromMetadata {
    param($Value)
    if ($null -eq $Value) { return }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
      foreach ($item in $Value) {
        Append-FromMetadata -Value $item
      }
      return
    }
    $text = Normalize-String -Value $Value
    if (-not $text) { return }
    if ($text.Contains(',')) {
      foreach ($segment in $text.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        Append-FromMetadata -Value $segment
      }
      return
    }
    $collected.Add($text)
  }
  Append-FromMetadata -Value $MetadataValue

  $seen = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $collected) {
    $trimmed = ($entry ?? '').Trim()
    if (-not $trimmed) { continue }
    if ($seen.Add($trimmed)) {
      $result.Add($trimmed)
    }
  }
  return $result.ToArray()
}

function Get-MetadataValue {
  param(
    $Metadata,
    [string]$Key
  )

  if ($null -eq $Metadata -or -not $Key) {
    return $null
  }

  if ($Metadata -is [System.Collections.IDictionary]) {
    try {
      if ($Metadata.Contains($Key)) {
        return $Metadata[$Key]
      }
    }
    catch {
      # Some IDictionary implementations (e.g., Hashtable) throw on Contains with null keys.
    }

    foreach ($dictKey in $Metadata.Keys) {
      if (($dictKey -is [string]) -and $dictKey.Equals($Key, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Metadata[$dictKey]
      }
    }

    return $null
  }

  $property = $Metadata.PSObject.Properties |
    Where-Object { $_.Name.Equals($Key, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1

  if ($property) {
    return $property.Value
  }

  return $null
}

function Build-UploadProfile {
  param(
    [string]$BaseName,
    [string]$DefaultVisibility,
    [string]$DefaultGalleryMode,
    [string]$DefaultTargetGallery,
    [string]$DefaultDescription,
    [string]$DefaultCategory,
    [string]$DefaultTrigger,
    [string[]]$DefaultTags,
    [string]$MetadataPath
  )

  $metadata = @{}
  if ($MetadataPath) {
    $loaded = Read-MetadataFile -Path $MetadataPath
    if ($null -eq $loaded) {
      return $null
    }
    $metadata = $loaded
  }

  $warnings = New-Object System.Collections.Generic.List[string]

  $title = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'title')
  if (-not $title) { $title = $BaseName }

  $description = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'description')
  if (-not $description) { $description = Normalize-String -Value $DefaultDescription }

  $visibilitySource = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'visibility')
  if (-not $visibilitySource) { $visibilitySource = Normalize-String -Value $DefaultVisibility }
  $visibility = Normalize-Visibility -Visibility $visibilitySource -Warnings $warnings

  $fallbackGalleryMode = 'new'
  if ($DefaultGalleryMode) {
    $fallbackGalleryMode = (Normalize-String -Value $DefaultGalleryMode).ToLowerInvariant()
    if ($fallbackGalleryMode -ne 'new' -and $fallbackGalleryMode -ne 'existing') {
      $fallbackGalleryMode = 'new'
    }
  }
  $galleryModeSource = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'galleryMode')
  if (-not $galleryModeSource) { $galleryModeSource = $fallbackGalleryMode }
  $galleryMode = Normalize-GalleryMode -Mode $galleryModeSource -Fallback $fallbackGalleryMode -Warnings $warnings

  $category = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'category')
  if (-not $category) { $category = Normalize-String -Value $DefaultCategory }

  $trigger = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'trigger')
  if (-not $trigger) { $trigger = Normalize-String -Value $DefaultTrigger }
  if (-not $trigger) { $trigger = $BaseName }

  $targetGalleryRaw = Normalize-String -Value (Get-MetadataValue -Metadata $metadata -Key 'targetGallery')
  if (-not $targetGalleryRaw) { $targetGalleryRaw = Normalize-String -Value $DefaultTargetGallery }
  if ($targetGalleryRaw -and $targetGalleryRaw.Contains('{title}')) {
    $targetGalleryRaw = $targetGalleryRaw.Replace('{title}', $title)
  }

  if ($galleryMode -eq 'new') {
    if (-not $targetGalleryRaw) {
      $targetGalleryRaw = "$title Collection"
    }
  } elseif (-not $targetGalleryRaw) {
    $warnings.Add("Gallery mode is 'existing' but no targetGallery was provided.")
  }

  $tags = Collect-Tags -DefaultTags $DefaultTags -MetadataValue (Get-MetadataValue -Metadata $metadata -Key 'tags')

  return [pscustomobject]@{
    Title = $title
    Description = $description
    Visibility = $visibility
    GalleryMode = $galleryMode
    TargetGallery = $targetGalleryRaw
    Trigger = $trigger
    Category = $category
    Tags = $tags
    MetadataPath = $MetadataPath
    Warnings = $warnings
  }
}

function Get-DeepExceptionMessage {
  param([System.Exception]$Exception)

  if (-not $Exception) { return '' }

  $messages = New-Object System.Collections.Generic.List[string]
  $current = $Exception
  while ($current) {
    if ($current.Message -and -not $messages.Contains($current.Message)) {
      $messages.Add($current.Message)
    }
    $current = $current.InnerException
  }

  return ($messages -join ' | ')
}

function New-MultipartForm {
  param(
    [hashtable]$Fields,
    [System.Collections.Generic.List[object]]$FileParts
  )

  $content = [System.Net.Http.MultipartFormDataContent]::new()
  $disposables = New-Object System.Collections.Generic.List[System.IDisposable]

  foreach ($key in $Fields.Keys) {
    $value = $Fields[$key]
    if ($null -eq $value -or $value -eq '') { continue }
    $stringContent = [System.Net.Http.StringContent]::new([string]$value, [System.Text.Encoding]::UTF8)
    $content.Add($stringContent, $key)
  }

  foreach ($filePart in $FileParts) {
    try {
      $fileInfo = Get-Item -LiteralPath $filePart.Path -ErrorAction Stop
    }
    catch {
      throw "Unable to prepare file '${filePart.Path}' for upload: $($_.Exception.Message)"
    }

    try {
      $stream = [System.IO.FileStream]::new(
        $fileInfo.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
      )
    }
    catch {
      throw "Unable to open file '${filePart.Path}' for upload: $($_.Exception.Message)"
    }

    $disposables.Add($stream)

    try {
      $streamContent = [System.Net.Http.StreamContent]::new($stream)
    }
    catch {
      $stream.Dispose()
      throw "Unable to stream file '${filePart.Path}' during upload preparation: $($_.Exception.Message)"
    }

    if ($filePart.MimeType) {
      $streamContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($filePart.MimeType)
    }

    if ($fileInfo.Length -ge 0) {
      $streamContent.Headers.ContentLength = $fileInfo.Length
    }

    $content.Add($streamContent, 'files', $fileInfo.Name)
    $disposables.Add($streamContent)
  }

  return [pscustomobject]@{
    Content = $content
    Disposables = $disposables
  }
}

function Invoke-HttpPost {
  param(
    [System.Net.Http.HttpClient]$Client,
    [Uri]$Uri,
    [System.Net.Http.HttpContent]$Content,
    [string]$Context
  )

  try {
    return $Client.PostAsync($Uri, $Content).GetAwaiter().GetResult()
  }
  catch {
    $message = Get-DeepExceptionMessage -Exception $_.Exception
    if (-not $message) { $message = $_.Exception.Message }
    throw "HTTP POST failed for ${Context}: ${message}"
  }
}

if (-not $PSBoundParameters.ContainsKey('DefaultVisibility') -and $env:VISIONSUIT_VISIBILITY) {
  $DefaultVisibility = $env:VISIONSUIT_VISIBILITY
}
if (-not $DefaultVisibility) { $DefaultVisibility = 'private' }

if (-not $PSBoundParameters.ContainsKey('DefaultGalleryMode') -and $env:VISIONSUIT_GALLERY_MODE) {
  $DefaultGalleryMode = $env:VISIONSUIT_GALLERY_MODE
}
if (-not $DefaultGalleryMode) { $DefaultGalleryMode = 'new' }

if (-not $PSBoundParameters.ContainsKey('DefaultCategory') -and $env:VISIONSUIT_CATEGORY) {
  $DefaultCategory = $env:VISIONSUIT_CATEGORY
}

if (-not $PSBoundParameters.ContainsKey('DefaultDescription') -and $env:VISIONSUIT_DESCRIPTION) {
  $DefaultDescription = $env:VISIONSUIT_DESCRIPTION
}

if (-not $PSBoundParameters.ContainsKey('DefaultTags') -and $env:VISIONSUIT_TAGS) {
  $DefaultTags = @(
    ($env:VISIONSUIT_TAGS -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  )
}

if (-not $PSBoundParameters.ContainsKey('DefaultTargetGallery') -and $env:VISIONSUIT_TARGET_GALLERY) {
  $DefaultTargetGallery = $env:VISIONSUIT_TARGET_GALLERY
}

if (-not $PSBoundParameters.ContainsKey('DefaultTrigger') -and $env:VISIONSUIT_TRIGGER) {
  $DefaultTrigger = $env:VISIONSUIT_TRIGGER
}

if ($ImageBatchSize -lt 1) {
  throw 'ImageBatchSize must be at least 1.'
}

try {
  $baseUri = [Uri]::new($ServerBaseUrl)
}
catch {
  throw "ServerBaseUrl '$ServerBaseUrl' is not a valid absolute URI."
}

if (-not $baseUri.IsAbsoluteUri) {
  throw "ServerBaseUrl '$ServerBaseUrl' must be an absolute URI."
}

$lorasRoot = Resolve-ExistingDirectory -Path $LorasDirectory -Description 'LoRA'
$imagesRoot = Resolve-ExistingDirectory -Path $ImagesDirectory -Description 'Image'

$password = $env:VISIONSUIT_PASSWORD
if (-not $password) {
  $secure = Read-Host -Prompt "Password for $ServerUsername" -AsSecureString
  if (-not $secure) {
    throw 'Password is required to authenticate with VisionSuit.'
  }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

if (-not $password) {
  throw 'Password is required to authenticate with VisionSuit.'
}

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $true
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$client = [System.Net.Http.HttpClient]::new($handler)
$client.BaseAddress = $baseUri
$client.Timeout = [TimeSpan]::FromMinutes(10)
$client.DefaultRequestHeaders.ExpectContinue = $false
$client.DefaultRequestHeaders.Accept.Clear()
$client.DefaultRequestHeaders.Accept.Add([System.Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new('application/json'))

try {
  $statusUri = ConvertTo-AbsoluteUri -BaseUri $baseUri -RelativePath '/api/meta/status'
  Write-Log "Checking VisionSuit service health at $($statusUri.AbsoluteUri)"
  $statusResponse = $client.GetAsync($statusUri).GetAwaiter().GetResult()
  try {
    if (-not $statusResponse.IsSuccessStatusCode) {
      $statusBody = $statusResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "Service status check failed (HTTP $($statusResponse.StatusCode)): $statusBody"
    }
    $statusJson = $statusResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if ($statusJson.services) {
      foreach ($serviceName in $statusJson.services.PSObject.Properties.Name) {
        $service = $statusJson.services.$serviceName
        Write-Log "Service '$serviceName' status: $($service.status) – $($service.message)"
      }
    }
    else {
      Write-Log 'VisionSuit status endpoint responded without service breakdown.'
    }
  }
  finally {
    $statusResponse.Dispose()
  }

  $loginUri = ConvertTo-AbsoluteUri -BaseUri $baseUri -RelativePath '/api/auth/login'
  $loginPayload = @{ email = $ServerUsername; password = $password } | ConvertTo-Json -Compress
  $loginContent = New-Object System.Net.Http.StringContent($loginPayload, [System.Text.Encoding]::UTF8, 'application/json')
  Write-Log "Authenticating as $ServerUsername at $($loginUri.AbsoluteUri)"
  try {
    $loginResponse = $client.PostAsync($loginUri, $loginContent).GetAwaiter().GetResult()
    if (-not $loginResponse.IsSuccessStatusCode) {
      $loginBody = $loginResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "Authentication failed (HTTP $($loginResponse.StatusCode)): $loginBody"
    }
    $loginJson = $loginResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    $token = $loginJson.token
    $role = $loginJson.user.role
    if (-not $token) {
      throw 'No access token returned by VisionSuit.'
    }
    if ($role -ne 'ADMIN') {
      throw "Bulk import is restricted to admin accounts. Detected role: '${role}'"
    }
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
    Write-Log "Authenticated successfully as $ServerUsername (role: $role)."
  }
  finally {
    if ($loginResponse) { $loginResponse.Dispose() }
    $loginContent.Dispose()
  }

  $uploadUri = ConvertTo-AbsoluteUri -BaseUri $baseUri -RelativePath '/api/uploads'

  $loraFiles = ConvertTo-ObjectArray -Value (
    Get-ChildItem -LiteralPath $lorasRoot -Filter '*.safetensors' -Recurse -File | Sort-Object FullName
  )
  if ((Get-ObjectCount -Value $loraFiles) -eq 0) {
    Write-Log "No LoRA safetensors found beneath '$lorasRoot'."
    return
  }

  $existingModels = Get-ExistingModelIndex -Client $client -BaseUri $baseUri

  $uploaded = 0
  $skipped = 0

  foreach ($lora in $loraFiles) {
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($lora.Name)
    $modelKey = Build-ModelNameKey -Value $baseName

    if ($modelKey -and $existingModels.ContainsKey($modelKey)) {
      $known = $existingModels[$modelKey]
      $knownTitle = if ($known.Title) { $known.Title } else { $baseName }
      $knownSlug = if ($known.Slug) { $known.Slug } else { 'unknown' }
      Write-Log "Skipping '$baseName' because model '$knownTitle' (slug: $knownSlug) already exists in VisionSuit."
      $skipped++
      continue
    }

    $imageFolder = Join-Path -Path $imagesRoot -ChildPath $baseName
    if (-not (Test-Path -LiteralPath $imageFolder -PathType Container)) {
      Write-Log "Skipping '$baseName' because matching image folder '$imageFolder' is missing."
      $skipped++
      continue
    }

    $allowedExtensions = @('.png', '.jpg', '.jpeg', '.webp', '.bmp')
    $images = ConvertTo-ObjectArray -Value (
      Get-ChildItem -LiteralPath $imageFolder -File | Where-Object {
        $allowedExtensions -contains ([System.IO.Path]::GetExtension($_.Name).ToLowerInvariant())
      } | Sort-Object Name
    )
    if ((Get-ObjectCount -Value $images) -eq 0) {
      Write-Log "Skipping '$baseName' because no preview-ready images were found."
      $skipped++
      continue
    }

    $preview = Get-Random -InputObject $images
    $otherImages = ConvertTo-ObjectArray -Value ($images | Where-Object { $_.FullName -ne $preview.FullName })

    $candidateMetadata = @(
      (Join-Path -Path $lora.DirectoryName -ChildPath "$baseName.json")
      (Join-Path -Path $lorasRoot -ChildPath "$baseName.json")
      (Join-Path -Path $imageFolder -ChildPath 'metadata.json')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    $metadataPath = $null
    foreach ($candidate in $candidateMetadata) {
      $metadataPath = $candidate
      break
    }

    $profile = Build-UploadProfile -BaseName $baseName -DefaultVisibility $DefaultVisibility -DefaultGalleryMode $DefaultGalleryMode -DefaultTargetGallery $DefaultTargetGallery -DefaultDescription $DefaultDescription -DefaultCategory $DefaultCategory -DefaultTrigger $DefaultTrigger -DefaultTags $DefaultTags -MetadataPath $metadataPath
    if ($null -eq $profile) {
      Write-Log "Skipping '$baseName' because metadata parsing failed."
      $skipped++
      continue
    }

    if ($profile.MetadataPath) {
      Write-Log "Loaded metadata overrides from $($profile.MetadataPath)"
    }
    foreach ($warning in $profile.Warnings) {
      Write-Log "Metadata warning for '$baseName': $warning"
    }

    if ($profile.GalleryMode -eq 'existing' -and -not $profile.TargetGallery) {
      Write-Log "Skipping '$baseName' because gallery mode is 'existing' without target gallery."
      $skipped++
      continue
    }

    $fields = @{
      'assetType'    = 'lora'
      'context'      = 'asset'
      'title'        = $profile.Title
      'visibility'   = $profile.Visibility
      'galleryMode'  = $profile.GalleryMode
      'targetGallery'= $profile.TargetGallery
      'trigger'      = $profile.Trigger
    }
    if ($profile.Description) { $fields['description'] = $profile.Description }
    if ($profile.Category) { $fields['category'] = $profile.Category }

    $fileParts = New-Object System.Collections.Generic.List[object]
    $fileParts.Add(@{ Path = $lora.FullName; MimeType = 'application/octet-stream' })
    $fileParts.Add(@{ Path = $preview.FullName; MimeType = Get-MimeType -Path $preview.FullName })

    $multipart = New-MultipartForm -Fields $fields -FileParts $fileParts
    $response = $null
    try {
      foreach ($tag in $profile.Tags) {
        $tagContent = [System.Net.Http.StringContent]::new($tag, [System.Text.Encoding]::UTF8)
        $multipart.Content.Add($tagContent, 'tags')
      }

      Write-Log "Uploading '$($profile.Title)' with preview '$(Split-Path -Leaf $preview.FullName)'."
      try {
        $response = Invoke-HttpPost -Client $client -Uri $uploadUri -Content $multipart.Content -Context "model '$($profile.Title)'"
      }
      catch {
        Write-Log "Upload request failed for '$($profile.Title)': $($_.Exception.Message)"
        $skipped++
        continue
      }
      $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $response.IsSuccessStatusCode) {
        Write-Log "Upload failed for '$($profile.Title)' (HTTP $($response.StatusCode)): $bodyText"
        $skipped++
        continue
      }
      $uploadResult = $bodyText | ConvertFrom-Json
      $assetSlug = $uploadResult.assetSlug
      $gallerySlug = $uploadResult.gallerySlug
      if (-not $assetSlug) {
        Write-Log "Upload succeeded for '$($profile.Title)' but asset slug was missing."
        $skipped++
        continue
      }
      if (-not $gallerySlug) {
        Write-Log "Upload succeeded for '$($profile.Title)' but gallery slug was missing."
        $skipped++
        continue
      }
      Write-Log "Model upload complete for '$($profile.Title)'. Asset slug: $assetSlug. Gallery slug: $gallerySlug."

      if ($modelKey) {
        $existingModels[$modelKey] = [pscustomobject]@{
          Title = $profile.Title
          Slug = $assetSlug
          Source = 'session'
        }
      }

      $otherImageCount = Get-ObjectCount -Value $otherImages
      if ($otherImageCount -gt 0) {
        $batchIndex = 0
        $galleryFields = @{
          'assetType'    = 'image'
          'context'      = 'gallery'
          'title'        = $profile.Title
          'visibility'   = $profile.Visibility
          'galleryMode'  = 'existing'
          'targetGallery'= $gallerySlug
        }
        if ($profile.Description) { $galleryFields['description'] = $profile.Description }
        if ($profile.Category) { $galleryFields['category'] = $profile.Category }

        $otherImageArray = ConvertTo-ObjectArray -Value $otherImages
        $batchFailed = $false
        for ($start = 0; $start -lt $otherImageCount; $start += $ImageBatchSize) {
          $endIndex = [Math]::Min($start + $ImageBatchSize - 1, $otherImageCount - 1)
          if ($endIndex -lt $start) {
            continue
          }
          $chunk = if ($start -eq $endIndex) {
            @($otherImageArray[$start])
          } else {
            @($otherImageArray[$start..$endIndex])
          }
          $chunkCount = Get-ObjectCount -Value $chunk

          $batchParts = New-Object System.Collections.Generic.List[object]
          foreach ($img in $chunk) {
            $batchParts.Add(@{ Path = $img.FullName; MimeType = Get-MimeType -Path $img.FullName })
          }

          $batchContent = New-MultipartForm -Fields $galleryFields -FileParts $batchParts
          $batchResponse = $null
          try {
            foreach ($tag in $profile.Tags) {
              $tagContent = [System.Net.Http.StringContent]::new($tag, [System.Text.Encoding]::UTF8)
              $batchContent.Content.Add($tagContent, 'tags')
            }

            $batchIndex++
            try {
              $batchResponse = Invoke-HttpPost -Client $client -Uri $uploadUri -Content $batchContent.Content -Context "gallery batch for '$($profile.Title)'"
            }
            catch {
              Write-Log "Upload request failed for image batch $batchIndex of '$($profile.Title)': $($_.Exception.Message)"
              $skipped++
              $batchFailed = $true
              break
            }
            $batchBody = $batchResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if (-not $batchResponse.IsSuccessStatusCode) {
              Write-Log "Image batch $batchIndex failed for '$($profile.Title)' (HTTP $($batchResponse.StatusCode)): $batchBody"
              $skipped++
              $batchFailed = $true
              break
            }
            Write-Log "Uploaded image batch $batchIndex for '$($profile.Title)' ($chunkCount image(s))."
          }
          finally {
            $batchContent.Content.Dispose()
            foreach ($item in $batchContent.Disposables) { $item.Dispose() }
            if ($batchResponse) { $batchResponse.Dispose() }
          }

          if ($batchFailed) {
            break
          }
        }

        if ($batchFailed) {
          continue
        }
      }

      $uploaded++
    }
    finally {
      if ($response) { $response.Dispose() }
      $multipart.Content.Dispose()
      foreach ($item in $multipart.Disposables) { $item.Dispose() }
    }
  }

  Write-Log "Bulk upload finished. Uploaded: $uploaded. Skipped: $skipped."
}
finally {
  if ($client) { $client.Dispose() }
}
