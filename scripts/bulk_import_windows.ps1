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
  [string]$ImagesDirectory = "./images"
)

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

if (-not $loginResponse.token) {
  Write-Log "Authentication failed: $($loginResponse | ConvertTo-Json -Depth 5)"
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

Write-Log "Authenticated as $ServerUsername. Starting bulk upload via VisionSuit API."

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

  if ($otherImages.Count -gt 10) {
    $trimmed = $otherImages.Count - 10
    $otherImages = $otherImages | Select-Object -First 10
    Write-Log "Limiting additional images for '$baseName' to 10 due to API file cap (trimmed $trimmed)."
  }

  $orderedImages = @($preview) + $otherImages

  $form = New-Object System.Net.Http.MultipartFormDataContent
  $form.Add((New-Object System.Net.Http.StringContent('lora')), 'assetType')
  $form.Add((New-Object System.Net.Http.StringContent('asset')), 'context')
  $form.Add((New-Object System.Net.Http.StringContent($baseName)), 'title')
  $form.Add((New-Object System.Net.Http.StringContent('private')), 'visibility')
  $form.Add((New-Object System.Net.Http.StringContent('new')), 'galleryMode')
  $form.Add((New-Object System.Net.Http.StringContent("$baseName Collection")), 'targetGallery')
  $form.Add((New-Object System.Net.Http.StringContent($baseName)), 'trigger')

  $disposables = @()

  try {
    $modelStream = [System.IO.File]::OpenRead($loraFile.FullName)
    $disposables += $modelStream
    $modelContent = New-Object System.Net.Http.StreamContent($modelStream)
    $modelContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
    $form.Add($modelContent, 'files', $loraFile.Name)

    foreach ($image in $orderedImages) {
      $imageStream = [System.IO.File]::OpenRead($image.FullName)
      $disposables += $imageStream
      $imageContent = New-Object System.Net.Http.StreamContent($imageStream)
      $mime = Get-MimeType -Path $image.FullName
      $imageContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mime)
      $form.Add($imageContent, 'files', $image.Name)
    }

    $response = $httpClient.PostAsync($uploadUri, $form).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if ($response.IsSuccessStatusCode) {
      Write-Log "Uploaded '$baseName' with preview '$($preview.Name)'."
      $uploadCount++
    }
    else {
      Write-Log "Upload failed for '$baseName' (HTTP $($response.StatusCode)): $body"
      $skipCount++
    }
  }
  catch {
    Write-Log "Upload request failed for '$baseName': $($_.Exception.Message)"
    $skipCount++
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
}

if ($httpClient) {
  $httpClient.Dispose()
}

if ($handler) {
  $handler.Dispose()
}

Write-Log "Completed import run: $uploadCount uploaded, $skipCount skipped."
