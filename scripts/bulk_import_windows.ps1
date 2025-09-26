#!/usr/bin/env pwsh
<#!
.SYNOPSIS
  VisionSuit bulk import helper for Windows clients.
.DESCRIPTION
  Uploads LoRA safetensors and matching preview images to the VisionSuit API.
  Configure the connection variables below before running the script.
#>

param(
  [string]$ServerIp = "192.168.1.10",
  [string]$ServerUsername = "admin@example.com",
  [int]$ServerPort = 4000,
  [string]$LorasDirectory = "./loras",
  [string]$ImagesDirectory = "./images",
  [string]$DefaultVisibility,
  [string]$DefaultGalleryMode,
  [string]$DefaultCategory,
  [string]$DefaultDescription,
  [string[]]$DefaultTags = @(),
  [string]$DefaultTargetGallery,
  [string]$DefaultTrigger
)

if (-not $PSBoundParameters.ContainsKey('DefaultVisibility') -and $env:VISIONSUIT_VISIBILITY) {
  $DefaultVisibility = $env:VISIONSUIT_VISIBILITY
}
if (-not $DefaultVisibility) {
  $DefaultVisibility = 'private'
}

if (-not $PSBoundParameters.ContainsKey('DefaultGalleryMode') -and $env:VISIONSUIT_GALLERY_MODE) {
  $DefaultGalleryMode = $env:VISIONSUIT_GALLERY_MODE
}
if (-not $DefaultGalleryMode) {
  $DefaultGalleryMode = 'new'
}

if (-not $PSBoundParameters.ContainsKey('DefaultCategory') -and $env:VISIONSUIT_CATEGORY) {
  $DefaultCategory = $env:VISIONSUIT_CATEGORY
}

if (-not $PSBoundParameters.ContainsKey('DefaultDescription') -and $env:VISIONSUIT_DESCRIPTION) {
  $DefaultDescription = $env:VISIONSUIT_DESCRIPTION
}

if (-not $PSBoundParameters.ContainsKey('DefaultTags') -and $env:VISIONSUIT_TAGS) {
  $DefaultTags = $env:VISIONSUIT_TAGS -split ','
}

if ($DefaultTags) {
  $DefaultTags = $DefaultTags | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

if (-not $PSBoundParameters.ContainsKey('DefaultTargetGallery') -and $env:VISIONSUIT_TARGET_GALLERY) {
  $DefaultTargetGallery = $env:VISIONSUIT_TARGET_GALLERY
}

if (-not $PSBoundParameters.ContainsKey('DefaultTrigger') -and $env:VISIONSUIT_TRIGGER) {
  $DefaultTrigger = $env:VISIONSUIT_TRIGGER
}

function Write-Log {
  param([string]$Message)
  $timestamp = (Get-Date).ToUniversalTime().ToString("s") + "Z"
  Write-Host "[$timestamp] $Message"
}

function Get-PlainPassword {
  param(
    [string]$Prompt
  )

  if ($env:VISIONSUIT_PASSWORD) {
    return $env:VISIONSUIT_PASSWORD
  }

  $secure = Read-Host -Prompt $Prompt -AsSecureString
  if (-not $secure) {
    return $null
  }

  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Get-MimeType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.png' { return 'image/png' }
    '.jpg' { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.webp' { return 'image/webp' }
    '.bmp' { return 'image/bmp' }
    default { return 'application/octet-stream' }
  }
}

function Resolve-ImageFolder {
  param(
    [string]$BaseName,
    [string]$ImagesRoot,
    [string]$LoraDirectory
  )

  $candidates = @()

  if ($ImagesRoot) {
    $candidates += (Join-Path -Path $ImagesRoot -ChildPath $BaseName)
  }

  if ($LoraDirectory) {
    $candidates += (Join-Path -Path $LoraDirectory -ChildPath $BaseName)
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-Path -Path $candidate -PathType Container) {
      return $candidate
    }
  }

  return $null
}

function Get-BulkUploadProfile {
  param(
    [string]$BaseName,
    [string]$MetadataFile,
    [string]$DefaultVisibility,
    [string]$DefaultGalleryMode,
    [string]$DefaultTargetGallery,
    [string]$DefaultDescription,
    [string]$DefaultCategory,
    [string]$DefaultTrigger,
    [string[]]$DefaultTags
  )

  $metadata = @{}
  $metadataPath = $null

  if ($MetadataFile -and (Test-Path -Path $MetadataFile -PathType Leaf)) {
    try {
      $content = Get-Content -Path $MetadataFile -Raw -Encoding UTF8
      if ($content.Trim().Length -gt 0) {
        $metadata = $content | ConvertFrom-Json -ErrorAction Stop
      }
      else {
        $metadata = @{}
      }
      $metadataPath = (Resolve-Path -Path $MetadataFile -ErrorAction Stop).ProviderPath
    }
    catch {
      throw "Metadata file '$MetadataFile' is not valid JSON: $($_.Exception.Message)"
    }

    if ($metadata -and ($metadata -isnot [System.Collections.IDictionary]) -and ($metadata -isnot [pscustomobject])) {
      throw "Metadata file '$MetadataFile' must contain a JSON object."
    }
  }

  $warnings = New-Object System.Collections.Generic.List[string]

  $title = $BaseName
  if ($metadata -and $metadata.PSObject.Properties['title']) {
    $candidateTitle = [string]$metadata.title
    if (-not [string]::IsNullOrWhiteSpace($candidateTitle)) {
      $title = $candidateTitle.Trim()
    }
  }

  $description = $null
  if ($metadata -and $metadata.PSObject.Properties['description']) {
    $candidateDescription = [string]$metadata.description
    if (-not [string]::IsNullOrWhiteSpace($candidateDescription)) {
      $description = $candidateDescription
    }
  }
  if (-not $description -and $DefaultDescription) {
    $description = $DefaultDescription
  }

  $visibilityCandidate = if ($metadata -and $metadata.PSObject.Properties['visibility']) { [string]$metadata.visibility } elseif ($DefaultVisibility) { $DefaultVisibility } else { 'private' }
  if ([string]::IsNullOrWhiteSpace($visibilityCandidate)) {
    $visibilityCandidate = 'private'
  }
  $visibilityNormalized = $visibilityCandidate.Trim().ToLowerInvariant()
  if ($visibilityNormalized -ne 'public' -and $visibilityNormalized -ne 'private') {
    $warnings.Add("Visibility '$visibilityCandidate' is not supported; falling back to 'private'.") | Out-Null
    $visibilityNormalized = 'private'
  }

  $fallbackGalleryMode = if ([string]::IsNullOrWhiteSpace($DefaultGalleryMode)) { 'new' } else { $DefaultGalleryMode.Trim().ToLowerInvariant() }
  if ($fallbackGalleryMode -ne 'new' -and $fallbackGalleryMode -ne 'existing') {
    $fallbackGalleryMode = 'new'
  }

  $galleryModeCandidate = if ($metadata -and $metadata.PSObject.Properties['galleryMode']) { [string]$metadata.galleryMode } else { $fallbackGalleryMode }
  if ([string]::IsNullOrWhiteSpace($galleryModeCandidate)) {
    $galleryModeCandidate = $fallbackGalleryMode
  }
  $galleryModeNormalized = $galleryModeCandidate.Trim().ToLowerInvariant()
  if ($galleryModeNormalized -ne 'new' -and $galleryModeNormalized -ne 'existing') {
    $warnings.Add("Gallery mode '$galleryModeCandidate' is not supported; falling back to '$fallbackGalleryMode'.") | Out-Null
    $galleryModeNormalized = $fallbackGalleryMode
  }

  $category = $null
  if ($DefaultCategory) {
    $category = $DefaultCategory
  }
  if ($metadata -and $metadata.PSObject.Properties['category']) {
    $candidateCategory = [string]$metadata.category
    if (-not [string]::IsNullOrWhiteSpace($candidateCategory)) {
      $category = $candidateCategory
    }
  }

  $trigger = $BaseName
  if ($DefaultTrigger) {
    $trigger = $DefaultTrigger
  }
  if ($metadata -and $metadata.PSObject.Properties['trigger']) {
    $candidateTrigger = [string]$metadata.trigger
    if (-not [string]::IsNullOrWhiteSpace($candidateTrigger)) {
      $trigger = $candidateTrigger.Trim()
    }
  }
  if ([string]::IsNullOrWhiteSpace($trigger)) {
    $trigger = $BaseName
  }

  $targetGallery = $null
  if ($DefaultTargetGallery) {
    $targetGallery = $DefaultTargetGallery
  }
  if ($metadata -and $metadata.PSObject.Properties['targetGallery']) {
    $candidateTarget = [string]$metadata.targetGallery
    if (-not [string]::IsNullOrWhiteSpace($candidateTarget)) {
      $targetGallery = $candidateTarget
    }
  }
  if ($targetGallery) {
    $targetGallery = $targetGallery.Replace('{title}', $title)
  }

  if ($galleryModeNormalized -eq 'new') {
    if (-not $targetGallery) {
      $targetGallery = "$title Collection"
    }
  }
  elseif (-not $targetGallery) {
    throw "Gallery mode is 'existing', but no target gallery slug or title was provided."
  }

  $tagSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $tags = New-Object System.Collections.Generic.List[string]

  foreach ($tag in $DefaultTags) {
    if ([string]::IsNullOrWhiteSpace($tag)) { continue }
    $trimmed = $tag.Trim()
    if ($trimmed.Length -eq 0) { continue }
    if ($tagSet.Add($trimmed)) { $tags.Add($trimmed) | Out-Null }
  }

  if ($metadata -and $metadata.PSObject.Properties['tags']) {
    $metaTags = $metadata.tags
    if ($metaTags -is [System.Collections.IEnumerable] -and $metaTags -isnot [string]) {
      foreach ($entry in $metaTags) {
        if ($null -eq $entry) { continue }
        $text = [string]$entry
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $trimmed = $text.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($tagSet.Add($trimmed)) { $tags.Add($trimmed) | Out-Null }
      }
    }
    else {
      foreach ($entry in ([string]$metaTags).Split(',', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $trimmed = $entry.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($tagSet.Add($trimmed)) { $tags.Add($trimmed) | Out-Null }
      }
    }
  }

  return [pscustomobject]@{
    Title = $title
    Description = $description
    Visibility = $visibilityNormalized
    GalleryMode = $galleryModeNormalized
    TargetGallery = $targetGallery
    Trigger = $trigger
    Category = $category
    Tags = $tags.ToArray()
    MetadataPath = $metadataPath
    Warnings = $warnings.ToArray()
  }
}

try {
  $lorasRoot = (Resolve-Path -Path $LorasDirectory -ErrorAction Stop).ProviderPath
} catch {
  Write-Log "LoRA directory '$LorasDirectory' was not found."
  exit 1
}

$imagesRoot = $null
$imagesRootExists = $false

if (Test-Path -Path $ImagesDirectory) {
  try {
    $imagesRoot = (Resolve-Path -Path $ImagesDirectory -ErrorAction Stop).ProviderPath
    $imagesRootExists = $true
  } catch {
    $imagesRoot = $null
  }
}
elseif ($PSBoundParameters.ContainsKey('ImagesDirectory')) {
  Write-Log "Image directory '$ImagesDirectory' was not found."
  exit 1
}
else {
  Write-Log "Image directory '$ImagesDirectory' was not found. Looking for folders next to each LoRA file instead."
}

$password = Get-PlainPassword -Prompt "Password for $ServerUsername"
if (-not $password) {
  Write-Log "Password is required to authenticate with VisionSuit."
  exit 1
}

$apiBase = "http://$ServerIp`:$ServerPort/api"
$loginBody = @{ email = $ServerUsername; password = $password } | ConvertTo-Json

try {
  $loginResponse = Invoke-RestMethod -Method Post -Uri "$apiBase/auth/login" -ContentType 'application/json' -Body $loginBody
} catch {
  Write-Log "Login request to VisionSuit API failed: $($_.Exception.Message)"
  exit 1
}

$userRole = $null
if ($loginResponse.user -and $loginResponse.user.PSObject.Properties['role']) {
  $userRole = [string]$loginResponse.user.role
}

$detectedRole = if ($userRole) { $userRole } else { 'unknown' }

if (-not $loginResponse.token) {
  Write-Log "Authentication failed: $($loginResponse | ConvertTo-Json -Depth 5)"
  exit 1
}

if (-not $userRole -or $userRole.ToUpperInvariant() -ne 'ADMIN') {
  Write-Log "Bulk import is restricted to admin accounts. Detected role: '$detectedRole'."
  exit 1
}

$token = $loginResponse.token
$uploadUri = "$apiBase/uploads"

try {
  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
} catch {
  try {
    [void][System.Reflection.Assembly]::LoadWithPartialName('System.Net.Http')
  } catch {
    Write-Log "Unable to load System.Net.Http: $($_.Exception.Message)"
    exit 1
  }
}

$handler = [System.Net.Http.HttpClientHandler]::new()
$httpClient = [System.Net.Http.HttpClient]::new($handler)
$httpClient.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)

Write-Log "Authenticated as $ServerUsername (role: $userRole). Starting bulk upload via VisionSuit API."

$uploadCount = 0
$skipCount = 0

Get-ChildItem -Path $lorasRoot -Filter *.safetensors -File | ForEach-Object {
  $loraFile = $_
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($loraFile.Name)
  $imageFolder = Resolve-ImageFolder -BaseName $baseName -ImagesRoot $imagesRoot -LoraDirectory $loraFile.DirectoryName

  if (-not $imageFolder) {
    if ($imagesRootExists) {
      Write-Log "Skipping '$baseName' because no matching image folder was found under '$imagesRoot'."
    }
    else {
      Write-Log "Skipping '$baseName' because matching image folder '$baseName' was not found next to the LoRA file."
    }
    $skipCount++
    return
  }

  $imageFiles = Get-ChildItem -Path $imageFolder -File |
    Where-Object { '.png', '.jpg', '.jpeg', '.webp', '.bmp' -contains [System.IO.Path]::GetExtension($_.Name).ToLowerInvariant() } |
    Sort-Object FullName
  if (-not $imageFiles) {
    Write-Log "Skipping '$baseName' because no preview-ready images were found."
    $skipCount++
    return
  }

  $preview = Get-Random -InputObject $imageFiles
  $otherImages = $imageFiles | Where-Object { $_.FullName -ne $preview.FullName }

  $metadataCandidates = @()
  $candidateFromFile = Join-Path -Path $loraFile.DirectoryName -ChildPath "$baseName.json"
  $metadataCandidates += $candidateFromFile
  $candidateFromRoot = Join-Path -Path $lorasRoot -ChildPath "$baseName.json"
  if ($candidateFromRoot -ne $candidateFromFile) {
    $metadataCandidates += $candidateFromRoot
  }
  $imagesMetadata = Join-Path -Path $imageFolder -ChildPath 'metadata.json'
  $metadataCandidates += $imagesMetadata

  $metadataFile = $metadataCandidates | Where-Object { Test-Path -Path $_ -PathType Leaf } | Select-Object -First 1

  try {
    $profile = Get-BulkUploadProfile -BaseName $baseName -MetadataFile $metadataFile -DefaultVisibility $DefaultVisibility -DefaultGalleryMode $DefaultGalleryMode -DefaultTargetGallery $DefaultTargetGallery -DefaultDescription $DefaultDescription -DefaultCategory $DefaultCategory -DefaultTrigger $DefaultTrigger -DefaultTags $DefaultTags
  }
  catch {
    Write-Log "Skipping '$baseName' because $($_.Exception.Message)"
    $skipCount++
    return
  }

  if ($profile.MetadataPath) {
    Write-Log "Loaded metadata overrides from $($profile.MetadataPath)."
  }

  if ($profile.Warnings) {
    foreach ($warning in $profile.Warnings) {
      if ($warning) {
        Write-Log "Metadata warning for '$baseName': $warning"
      }
    }
  }

  Write-Log "Uploading '$($profile.Title)' (source '$baseName') with preview '$($preview.Name)'."

  $form = New-Object System.Net.Http.MultipartFormDataContent
  $form.Add((New-Object System.Net.Http.StringContent('lora')), 'assetType')
  $form.Add((New-Object System.Net.Http.StringContent('asset')), 'context')
  $form.Add((New-Object System.Net.Http.StringContent($profile.Title)), 'title')
  $form.Add((New-Object System.Net.Http.StringContent($profile.Visibility)), 'visibility')
  $form.Add((New-Object System.Net.Http.StringContent($profile.GalleryMode)), 'galleryMode')
  $form.Add((New-Object System.Net.Http.StringContent($profile.TargetGallery)), 'targetGallery')
  $form.Add((New-Object System.Net.Http.StringContent($profile.Trigger)), 'trigger')

  if ($profile.Description) {
    $form.Add((New-Object System.Net.Http.StringContent($profile.Description)), 'description')
  }

  if ($profile.Category) {
    $form.Add((New-Object System.Net.Http.StringContent($profile.Category)), 'category')
  }

  if ($profile.Tags) {
    foreach ($tag in $profile.Tags) {
      if ($tag) {
        $form.Add((New-Object System.Net.Http.StringContent($tag)), 'tags')
      }
    }
  }

  $disposables = @()
  $gallerySlug = $null

  try {
    $modelStream = [System.IO.File]::OpenRead($loraFile.FullName)
    $disposables += $modelStream
    $modelContent = New-Object System.Net.Http.StreamContent($modelStream)
    $modelContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
    $form.Add($modelContent, 'files', $loraFile.Name)

    $previewStream = [System.IO.File]::OpenRead($preview.FullName)
    $disposables += $previewStream
    $previewContent = New-Object System.Net.Http.StreamContent($previewStream)
    $previewMime = Get-MimeType -Path $preview.FullName
    $previewContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($previewMime)
    $form.Add($previewContent, 'files', $preview.Name)

    $response = $httpClient.PostAsync($uploadUri, $form).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if ($response.IsSuccessStatusCode) {
      try {
        $parsed = $body | ConvertFrom-Json
      }
      catch {
        Write-Log "Model upload succeeded for '$($profile.Title)' but response parsing failed: $($_.Exception.Message)"
        $skipCount++
        return
      }

      $gallerySlug = $parsed.gallerySlug
      if (-not $gallerySlug) {
        Write-Log "Model upload succeeded for '$($profile.Title)' but gallery information was missing."
        $skipCount++
        return
      }

      Write-Log "Model upload complete for '$($profile.Title)'. Gallery slug: $gallerySlug."
    }
    else {
      Write-Log "Upload failed for '$($profile.Title)' (HTTP $($response.StatusCode)): $body"
      $skipCount++
      return
    }
  }
  catch {
    Write-Log "Upload request failed for '$($profile.Title)': $($_.Exception.Message)"
    $skipCount++
    return
  }
  finally {
    foreach ($item in $disposables) {
      if ($item -is [System.IDisposable]) {
        $item.Dispose()
      }
    }

    if ($form -is [System.IDisposable]) {
      $form.Dispose()
    }
  }

  if ($otherImages.Count -eq 0) {
    $uploadCount++
    Write-Log "No additional images found for '$($profile.Title)'; only the preview was uploaded."
    return
  }

  $maxBatch = 12
  $totalImages = $otherImages.Count
  $processedImages = 0
  $batchFailed = $false
  $batchIndex = 1

  for ($start = 0; $start -lt $totalImages; $start += $maxBatch) {
    $end = [Math]::Min($start + $maxBatch - 1, $totalImages - 1)
    if ($end -lt $start) {
      break
    }

    $chunk = $otherImages[$start..$end]
    if ($chunk -isnot [System.Array]) {
      $chunk = @($chunk)
    }

    $chunkForm = New-Object System.Net.Http.MultipartFormDataContent
    $chunkForm.Add((New-Object System.Net.Http.StringContent('image')), 'assetType')
    $chunkForm.Add((New-Object System.Net.Http.StringContent('gallery')), 'context')
    $chunkForm.Add((New-Object System.Net.Http.StringContent($profile.Title)), 'title')
    $chunkForm.Add((New-Object System.Net.Http.StringContent($profile.Visibility)), 'visibility')
    $chunkForm.Add((New-Object System.Net.Http.StringContent('existing')), 'galleryMode')
    $chunkForm.Add((New-Object System.Net.Http.StringContent($gallerySlug)), 'targetGallery')

    if ($profile.Description) {
      $chunkForm.Add((New-Object System.Net.Http.StringContent($profile.Description)), 'description')
    }

    if ($profile.Category) {
      $chunkForm.Add((New-Object System.Net.Http.StringContent($profile.Category)), 'category')
    }

    if ($profile.Tags) {
      foreach ($tag in $profile.Tags) {
        if ($tag) {
          $chunkForm.Add((New-Object System.Net.Http.StringContent($tag)), 'tags')
        }
      }
    }

    $chunkDisposables = @()

    try {
      foreach ($image in $chunk) {
        $imageStream = [System.IO.File]::OpenRead($image.FullName)
        $chunkDisposables += $imageStream
        $imageContent = New-Object System.Net.Http.StreamContent($imageStream)
        $mime = Get-MimeType -Path $image.FullName
        $imageContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mime)
        $chunkForm.Add($imageContent, 'files', $image.Name)
      }

      $chunkResponse = $httpClient.PostAsync($uploadUri, $chunkForm).GetAwaiter().GetResult()
      $chunkBody = $chunkResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()

      if ($chunkResponse.IsSuccessStatusCode) {
        $processedImages += $chunk.Count
        Write-Log "Uploaded image batch $batchIndex for '$($profile.Title)' ($($chunk.Count) image(s))."
      }
      else {
        Write-Log "Image batch $batchIndex failed for '$($profile.Title)' (HTTP $($chunkResponse.StatusCode)): $chunkBody"
        $skipCount++
        $batchFailed = $true
        break
      }
    }
    catch {
      Write-Log "Image batch $batchIndex failed for '$($profile.Title)': $($_.Exception.Message)"
      $skipCount++
      $batchFailed = $true
      break
    }
    finally {
      foreach ($item in $chunkDisposables) {
        if ($item -is [System.IDisposable]) {
          $item.Dispose()
        }
      }

      if ($chunkForm -is [System.IDisposable]) {
        $chunkForm.Dispose()
      }
    }

    $batchIndex++
  }

  if ($batchFailed) {
    return
  }

  $uploadCount++
  Write-Log "Completed '$($profile.Title)': uploaded model plus $processedImages additional image(s) across $($batchIndex - 1) batch(es)."
}

if ($httpClient) {
  $httpClient.Dispose()
}

if ($handler) {
  $handler.Dispose()
}

Write-Log "Completed import run: $uploadCount uploaded, $skipCount skipped."
