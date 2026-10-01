<#
.SYNOPSIS
  BDD 證據截圖的無損 WebP 轉檔：偵測 Pillow、轉檔並逐像素驗證。

.DESCRIPTION
  轉檔與驗證都在 bdd_webp.py（Python Pillow）內完成。沒有 Pillow 時 Get-WebpEncoder 回傳 kind = $null，
  呼叫端應保留原檔並提出警告，不可讓封存失敗。
#>

Set-StrictMode -Version 3.0

<#
.SYNOPSIS
  封存時會嘗試轉成無損 WebP 的副檔名（GIF 可能是動畫，不轉）。
#>
$script:WebpConvertibleExtensions = @('.png', '.jpg', '.jpeg', '.bmp')

# Get-WebpEncoder 的快取：同一個行程內環境變數沒變就不重新偵測
$script:EncoderCache = @{}

<#
.SYNOPSIS
  找出可用的無損 WebP 編碼器（只支援 Python Pillow）。
  環境變數 BDD_WEBP_ENCODER：auto（預設，找不到就回傳 kind = $null）／pillow（找不到就丟例外）／none（不轉檔）。
  回傳 hashtable：kind（'pillow' 或 $null）、command（python 執行檔）、prefixArgs（例如 py 的 -3）、helper（bdd_webp.py）。
#>
function Get-WebpEncoder {
    $want = if ($env:BDD_WEBP_ENCODER) { $env:BDD_WEBP_ENCODER.ToLowerInvariant() } else { 'auto' }
    if ($script:EncoderCache.ContainsKey($want)) { return $script:EncoderCache[$want] }
    $result = @{ kind = $null }
    if ($want -ne 'none') {
        $helper = Join-Path $PSScriptRoot 'bdd_webp.py'
        foreach ($candidate in @(@('python'), @('python3'), @('py', '-3'))) {
            $cmd = Get-Command $candidate[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { continue }
            $prefix = @($candidate | Select-Object -Skip 1)
            $out = & $cmd.Source @prefix $helper check 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
            try { $ok = (($out | Select-Object -Last 1) | ConvertFrom-Json).ok } catch { continue }
            if ($ok) { $result = @{ kind = 'pillow'; command = $cmd.Source; prefixArgs = $prefix; helper = $helper }; break }
        }
        if ($want -eq 'pillow' -and -not $result.kind) { throw 'BDD_WEBP_ENCODER=pillow，但找不到支援 WebP 的 Python Pillow' }
    }
    $script:EncoderCache[$want] = $result
    $result
}

<#
.SYNOPSIS
  把一張圖片轉成無損 WebP 並逐像素驗證；不改動來源檔。
  回傳 hashtable：ok、reason（$null／encoder-failed／not-identical／not-smaller）、encoder、sourceBytes、webpBytes。
  ok 為 false 時刪除 Destination，不留下產物。
#>
function Convert-ToLosslessWebp {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)]$Encoder)
    if ($Encoder.kind -ne 'pillow') { throw '沒有可用的 WebP 編碼器（需要支援 WebP 的 Python Pillow）' }
    $sourceBytes = (Get-Item -LiteralPath $Source).Length
    $prefix = @($Encoder.prefixArgs)
    $out = & $Encoder.command @prefix $Encoder.helper convert $Source $Destination 2>$null
    $exit = $LASTEXITCODE
    $result = @{ ok = $false; reason = 'encoder-failed'; encoder = 'pillow'; sourceBytes = $sourceBytes; webpBytes = $null }
    if ($exit -eq 0 -and $out -and (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        $report = $null
        try { $report = ($out | Select-Object -Last 1) | ConvertFrom-Json } catch { $report = $null }
        if ($report -and $report.PSObject.Properties['identical']) {
            $result.webpBytes = (Get-Item -LiteralPath $Destination).Length
            if (-not $report.identical) { $result.reason = 'not-identical' }
            elseif ($result.webpBytes -ge $sourceBytes) { $result.reason = 'not-smaller' }
            else { $result.ok = $true; $result.reason = $null }
        }
    }
    if (-not $result.ok -and (Test-Path -LiteralPath $Destination)) { Remove-Item -LiteralPath $Destination -Force }
    $result
}

Export-ModuleMember -Function * -Variable WebpConvertibleExtensions
