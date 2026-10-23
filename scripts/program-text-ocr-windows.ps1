param([string]$ImagePath, [string]$ProtectDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ProtectDirectory) {
  if ($ImagePath) { throw 'ambiguous_operation' }
  $item = Get-Item -LiteralPath $ProtectDirectory
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid_temporary_directory' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
  $check = Get-Acl -LiteralPath $item.FullName
  if (-not $check.AreAccessRulesProtected -or $check.Access.Count -ne 1 -or
      $check.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'temporary_directory_acl_failed' }
  [Console]::Out.Write('private')
  exit 0
}
if (-not $ImagePath) { throw 'image_required' }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
  $task = $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (-not $task.Wait(20000)) { throw 'ocr_operation_timeout' }
  $task.GetAwaiter().GetResult()
}
$item = Get-Item -LiteralPath $ImagePath
if ($item.PSIsContainer -or $item.Length -gt 20971520 -or $item.Length -lt 24 -or $item.Extension -ne '.png' -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid_image_input' }
$imageHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$enginePath = Join-Path $env:SystemRoot 'System32/Windows.Media.Ocr.dll'
$engineFile = Get-Item -LiteralPath $enginePath
$engineHash = (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
$language = New-Object Windows.Globalization.Language 'en-US'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw 'english_ocr_unavailable' }
$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($item.FullName)) ([Windows.Storage.StorageFile])
$stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$bitmap = $null
try {
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $width = [int]$decoder.PixelWidth; $height = [int]$decoder.PixelHeight
  if ($width -lt 1 -or $height -lt 1 -or $width -gt 2200 -or $height -gt 2200 -or
      $width -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $height -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'image_dimensions_exceeded' }
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @(); $characters = 0
  foreach ($line in $result.Lines) {
    $characters += $line.Text.Length
    if ($characters -gt 100000 -or $lines.Count -ge 15000) { throw 'ocr_text_limit' }
    $lines += [string]$line.Text
  }
  if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $imageHash -or
      (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $engineHash) { throw 'ocr_input_changed' }
  $receipt = [ordered]@{schema='awardping.program-text-windows-ocr.v1';engine='Windows.Media.Ocr';
    image_sha256=$imageHash;text=($lines -join "`n");confidence=$null;reading_order_verified=$false;
    engine_version=$engineFile.VersionInfo.FileVersion;engine_sha256=$engineHash}
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::Out.WriteLine(($receipt | ConvertTo-Json -Depth 5 -Compress))
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  $stream.Dispose()
}
