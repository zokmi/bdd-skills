<#
  無損 WebP 轉檔的 Pester 測試。有支援 WebP 的 Python Pillow 才跑實際轉檔；決策邏輯以假編碼器測試，不需 Python。
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'
    Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
    Add-Type -AssemblyName System.Drawing

    $env:BDD_WEBP_ENCODER = $null
    $script:Pillow = Get-WebpEncoder

    # 產生一張 PNG：純色背景，左上角一個完全透明但 RGB 非零的像素
    function New-AlphaPng([string]$Path, [int]$Width = 200, [int]$Height = 100) {
        [IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
        $bmp = [Drawing.Bitmap]::new($Width, $Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::FromArgb(255, 51, 102, 153)); $g.Dispose()
        $bmp.SetPixel(3, 3, [Drawing.Color]::FromArgb(0, 10, 20, 30))
        $bmp.Save($Path, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    }

    # 建立假編碼器：以 pwsh 執行一段腳本，依 Mode 模擬「轉檔結果」
    function New-FakeEncoder([string]$Dir, [ValidateSet('identical-smaller', 'identical-larger', 'different', 'fail')][string]$Mode) {
        $script = Join-Path $Dir "fake-$Mode.ps1"
        $body = switch ($Mode) {
            'identical-smaller' { '[IO.File]::WriteAllBytes($args[2], [byte[]](1,2,3)); ''{"identical": true, "sourceBytes": 0, "webpBytes": 3}''' }
            'identical-larger'  { '[IO.File]::WriteAllBytes($args[2], [byte[]]::new(100000)); ''{"identical": true, "sourceBytes": 0, "webpBytes": 100000}''' }
            'different'         { '[IO.File]::WriteAllBytes($args[2], [byte[]](1,2,3)); ''{"identical": false, "sourceBytes": 0, "webpBytes": 3}''' }
            'fail'              { '''{"error": "boom"}''; exit 1' }
        }
        Set-Content -LiteralPath $script -Value $body -Encoding utf8
        @{ kind = 'pillow'; command = (Get-Process -Id $PID).Path; prefixArgs = @('-NoProfile', '-File'); helper = $script }
    }
}

AfterAll { $env:BDD_WEBP_ENCODER = $null }

Describe 'Get-WebpEncoder' {
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It 'BDD_WEBP_ENCODER=none 時沒有編碼器' {
        $env:BDD_WEBP_ENCODER = 'none'
        (Get-WebpEncoder).kind | Should -BeNullOrEmpty
    }

    It '偵測到的編碼器只會是 pillow 或沒有' {
        $script:Pillow.kind | Should -BeIn @('pillow', $null)
    }
}

Describe 'Convert-ToLosslessWebp（假編碼器）' {
    BeforeEach {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $dir | Out-Null
        $src = Join-Path $dir 'a.png'
        [IO.File]::WriteAllBytes($src, [byte[]]::new(1000))
        $dst = Join-Path $dir 'a.webp'
    }

    It '像素一致且較小時 ok' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'identical-smaller')
        $r.ok | Should -BeTrue
        $r.sourceBytes | Should -Be 1000
        $r.webpBytes | Should -Be 3
        Test-Path -LiteralPath $dst | Should -BeTrue
    }

    It '轉完比原檔大時 not-smaller，且刪除產物' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'identical-larger')
        $r.ok | Should -BeFalse
        $r.reason | Should -Be 'not-smaller'
        Test-Path -LiteralPath $dst | Should -BeFalse
    }

    It '像素不一致時 not-identical，且刪除產物' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'different')
        $r.reason | Should -Be 'not-identical'
        Test-Path -LiteralPath $dst | Should -BeFalse
    }

    It '編碼器失敗時 encoder-failed，來源不變' {
        $before = (Get-FileHash -LiteralPath $src).Hash
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'fail')
        $r.reason | Should -Be 'encoder-failed'
        (Get-FileHash -LiteralPath $src).Hash | Should -Be $before
    }

    It '沒有編碼器時丟出例外' {
        { Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder @{ kind = $null } } | Should -Throw '*WebP*'
    }
}

Describe 'Convert-ToLosslessWebp（Pillow）' {
    It '中文與空白檔名、含透明像素的 PNG 轉成無損 WebP，逐像素一致且較小' {
        if ($script:Pillow.kind -ne 'pillow') { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $dir = Join-Path $TestDrive 'pillow'
        $src = Join-Path $dir 'R1_SS-01_列表 首頁.png'
        New-AlphaPng $src
        $dst = Join-Path $dir 'R1_SS-01_列表 首頁.webp'
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder $script:Pillow
        $r.ok | Should -BeTrue
        $r.encoder | Should -Be 'pillow'
        $r.webpBytes | Should -BeLessThan $r.sourceBytes
        Test-Path -LiteralPath $dst | Should -BeTrue
    }
}
