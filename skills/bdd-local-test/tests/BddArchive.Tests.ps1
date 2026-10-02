<#
  BDD 封存腳本的 Pester 測試。執行：
    pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.IO.Compression

    # 產生一張純色 PNG，供去重與遮罩測試使用
    function New-TestPng([string]$Path, [string]$Color = '#336699', [int]$Width = 40, [int]$Height = 20) {
        [IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
        $bmp = [Drawing.Bitmap]::new($Width, $Height)
        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.Clear([Drawing.ColorTranslator]::FromHtml($Color)); $g.Dispose()
        $bmp.Save($Path, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    }

    # 建立含一個 commit 的測試 repo 與 .bdd/1234-demo 輸出資料夾；回傳 repo 與輸出目錄路徑
    function New-TestRepo([string]$Root) {
        $repo = Join-Path $Root 'repo'
        New-Item -ItemType Directory -Path $repo | Out-Null
        git -C $repo init -q -b main
        git -C $repo config user.email t@example.com
        git -C $repo config user.name tester
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'x'
        git -C $repo add . ; git -C $repo commit -q -m init
        $head = (git -C $repo rev-parse HEAD).Trim()
        $bdd = Join-Path $repo '.bdd/1234-demo'
        New-Item -ItemType Directory -Path (Join-Path $bdd 'evidence') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $bdd '01-demo.feature') -Value '功能: 示範' -Encoding utf8
        Set-Content -LiteralPath (Join-Path $bdd 'REPORT.md') -Value '# 報告' -Encoding utf8
        Set-Content -LiteralPath (Join-Path $bdd 'verification.json') -Value (@{ rounds = @(@{ head = $head }) } | ConvertTo-Json -Depth 4) -Encoding utf8
        New-TestPng (Join-Path $bdd 'evidence/R1_DM-01_首頁.png') '#336699'
        Copy-Item (Join-Path $bdd 'evidence/R1_DM-01_首頁.png') (Join-Path $bdd 'evidence/R2_DM-01_首頁.png')
        New-TestPng (Join-Path $bdd 'evidence/R2_DM-02_列表.png') '#993366'
        Set-Content -LiteralPath (Join-Path $bdd 'evidence/DM-03_回應.json') -Value '{"ok":true}' -Encoding utf8
        @{ repo = $repo; bdd = $bdd; head = $head }
    }

    # 寫入 .bdd/config.json
    function Set-BddConfig([string]$Repo, $Data) {
        Set-Content -LiteralPath (Join-Path $Repo '.bdd/config.json') -Value ($Data | ConvertTo-Json -Depth 6) -Encoding utf8
    }

    # 以 exempt 登記全部圖片，讓封存測試聚焦在其他規則
    function Register-AllExempt([string]$Bdd) {
        & "$script:Scripts/mask-evidence.ps1" -Dir $Bdd -Mark -Method exempt -Note '測試用純色圖' | Out-Null
    }

    function Invoke-Archive { param([hashtable]$Arguments) & "$script:Scripts/archive-bdd.ps1" @Arguments | ConvertFrom-Json }

    # 讀取封存檔裡的 manifest
    function Read-Manifest([string]$Zip) {
        $z = [IO.Compression.ZipFile]::OpenRead($Zip)
        try {
            $e = $z.Entries | Where-Object { $_.FullName -like '*/bdd-manifest.json' }
            $r = [IO.StreamReader]::new($e.Open()); try { $r.ReadToEnd() | ConvertFrom-Json } finally { $r.Dispose() }
        } finally { $z.Dispose() }
    }

    # 把 repo 改成模組情境格式：情境移到 .bdd/modules/m/01.feature 並 commit，verification.json 記錄 scenarios；回傳新的 head 與 blob
    function Convert-ToModuleLayout([hashtable]$T, [switch]$KeepIssueFeature) {
        $mod = Join-Path $T.repo '.bdd/modules/m'
        New-Item -ItemType Directory -Path $mod -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mod 'MODULE.md') -Encoding utf8 -Value @('---', 'prefix: DM', 'paths:', '  - src/**', '---')
        Set-Content -LiteralPath (Join-Path $mod '01.feature') -Encoding utf8 -Value "功能: 示範`n  @DM-01 @#1234 @UI`n  場景: 首頁`n    當 a"
        git -C $T.repo add .bdd/modules ; git -C $T.repo commit -q -m scenarios
        if (-not $KeepIssueFeature) { Remove-Item -LiteralPath (Join-Path $T.bdd '01-demo.feature') }
        $head = (git -C $T.repo rev-parse HEAD).Trim()
        $blob = (git -C $T.repo rev-parse 'HEAD:.bdd/modules/m/01.feature').Trim()
        $doc = @{ rounds = @(@{ head = $head; scenarios = @(@{ path = '.bdd/modules/m/01.feature'; blob = $blob; ids = @('DM-01'); role = 'changed' }) }) }
        Set-Content -LiteralPath (Join-Path $T.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        @{ head = $head; blob = $blob }
    }
}

Describe 'archive-bdd.ps1' {
    BeforeEach {
        $env:BDD_WEBP_ENCODER = 'none'   # 這組測試驗證 1.3.0 的去重、攤平、還原規則；WebP 行為見「WebP」Describe
        $env:BDD_ARCHIVE_ROOT = $null
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It '封存時去重、寫入 manifest 與索引，檔名含單號與受測短 SHA' {
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }

        $r.archive | Should -BeLike (Join-Path $archiveRoot "1234\1234-demo-$($t.head.Substring(0,7))-*.zip")
        $r.fileCount | Should -Be 8
        $r.aliasCount | Should -Be 1
        $r.storedFileCount | Should -Be 7
        $r.masked | Should -BeTrue
        $m = Read-Manifest $r.archive
        $m.aliases.'evidence/R2_DM-01_首頁.png' | Should -Be 'evidence/R1_DM-01_首頁.png'
        $m.commit | Should -Be $t.head
        $index = @(Get-Content (Join-Path $archiveRoot 'index.jsonl') | ConvertFrom-Json)
        $index.Count | Should -Be 1
        $index[0].event | Should -Be 'created'
        $index[0].sha256 | Should -Be $r.sha256
    }

    It '封存位置在主 checkout 內時拒絕' {
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = (Join-Path $t.repo '.claude/bdd-archives') } } | Should -Throw '*worktree 內*'
        Test-Path (Join-Path $t.repo '.claude/bdd-archives') | Should -BeFalse
    }

    It '封存位置在同 repo 的其他 worktree 內時拒絕' {
        $wt = Join-Path $base 'wt'
        git -C $t.repo worktree add -q $wt -b other 2>$null
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = (Join-Path $wt 'archives') } } | Should -Throw '*worktree 內*'
    }

    It '預設要求遮罩：圖片未登記就拒絕且不產生封存檔' {
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*沒有有效的遮罩紀錄*'
        Test-Path $archiveRoot | Should -BeFalse
    }

    It '登記後圖片又被改動，視為未遮罩' {
        Register-AllExempt $t.bdd
        New-TestPng (Join-Path $t.bdd 'evidence/R2_DM-02_列表.png') '#000000'
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*R2_DM-02*'
    }

    It 'mask.required = false 時允許封存並在輸出警告' {
        Set-BddConfig $t.repo @{ mask = @{ required = $false } }
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.masked | Should -BeFalse
        ($r.warnings -join ' ') | Should -BeLike '*未登記遮罩*'
    }

    It '-AllowUnmaskedReason 允許未遮罩封存並把理由寫進 manifest；理由空白則拒絕' {
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot; AllowUnmaskedReason = ' ' } } | Should -Throw '*寫明理由*'
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot; AllowUnmaskedReason = '遷移舊證據' }
        $r.masked | Should -BeFalse
        ($r.warnings -join ' ') | Should -BeLike '*不可上傳 issue*'
        $m = Read-Manifest $r.archive
        $m.unmaskedReason | Should -Be '遷移舊證據'
        @($m.unmasked).Count | Should -Be 3
    }

    It '舊 evidence.zip 解回 evidence/ 後一起封存，不再收入 evidence.zip 本身' {
        $old = Join-Path $base 'old'
        New-TestPng (Join-Path $old 'evidence/R0_DM-00_舊圖.png') '#00FF00'
        [IO.Compression.ZipFile]::CreateFromDirectory($old, (Join-Path $t.bdd 'evidence.zip'))
        Register-AllExempt $t.bdd   # 尚未解回的舊圖不在登記內
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*R0_DM-00*'
        Test-Path (Join-Path $t.bdd 'evidence/R0_DM-00_舊圖.png') | Should -BeTrue

        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $m = Read-Manifest $r.archive
        $m.flattenedFrom | Should -Be @('evidence.zip')
        $m.files.PSObject.Properties.Name | Should -Contain 'evidence/R0_DM-00_舊圖.png'
        $m.files.PSObject.Properties.Name | Should -Not -Contain 'evidence.zip'
    }

    It 'evidence.zip 與 evidence/ 同名不同內容時停止' {
        $old = Join-Path $base 'old'
        New-TestPng (Join-Path $old 'evidence/R2_DM-02_列表.png') '#FFFF00'
        [IO.Compression.ZipFile]::CreateFromDirectory($old, (Join-Path $t.bdd 'evidence.zip'))
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*同名但內容不同*'
    }

    It '同主題第二次封存時，舊封存在索引標為 superseded' {
        Register-AllExempt $t.bdd
        $first = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        Start-Sleep -Milliseconds 1100
        $second = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $second.superseded | Should -Be @($first.archive)
        $list = & "$script:Scripts/bdd-archive-index.ps1" -List -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($list.archives | Where-Object archive -eq $first.archive).status | Should -Be 'superseded'
        ($list.archives | Where-Object archive -eq $second.archive).status | Should -Be 'local-only'
    }

    It '超過 maxAttachmentBytes 時標示 exceedsAttachmentLimit' {
        Set-BddConfig $t.repo @{ maxAttachmentBytes = 10 }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.exceedsAttachmentLimit | Should -BeTrue
    }

    It '目的地檔案已存在時不覆蓋' {
        Register-AllExempt $t.bdd
        $dest = Join-Path $archiveRoot 'fixed.zip'
        New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
        Set-Content -LiteralPath $dest -Value 'keep'
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot; Destination = $dest } } | Should -Throw '*已存在*'
        Get-Content $dest | Should -Be 'keep'
    }

    It '封存位置優先序：參數 > 環境變數 > 設定檔' {
        Register-AllExempt $t.bdd
        $fromConfig = Join-Path $base 'from-config'
        $fromEnv = Join-Path $base 'from-env'
        Set-BddConfig $t.repo @{ archiveRoot = $fromConfig }
        (Invoke-Archive @{ Dir = $t.bdd }).archiveRoot | Should -Be $fromConfig
        $env:BDD_ARCHIVE_ROOT = $fromEnv
        (Invoke-Archive @{ Dir = $t.bdd }).archiveRoot | Should -Be $fromEnv
        (Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }).archiveRoot | Should -Be $archiveRoot
        $env:BDD_ARCHIVE_ROOT = $null
    }

    It '缺少 verification.json 時拒絕' {
        Remove-Item (Join-Path $t.bdd 'verification.json')
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*verification.json*'
    }
}

Describe 'BddArchive.psm1' {
    BeforeEach {
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        Import-Module (Join-Path $script:Scripts 'lib/BddArchive.psm1') -Force
    }

    It '預設封存位置以主 checkout 資料夾名命名，即使傳入的輸出目錄不存在' {
        $env:BDD_ARCHIVE_ROOT = $null
        $r = Resolve-ArchiveRoot -BddDir (Join-Path $t.repo '.bdd/_')
        $r.source | Should -Be 'default'
        $r.path | Should -Be (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'bdd-archives\repo')
    }

    It '從不存在的子路徑也能取得 worktree 清單與 repo 頂層' {
        @(Get-RepoWorktrees (Join-Path $t.repo '.bdd/_/x')).Count | Should -Be 1
        Get-RepoTopLevel (Join-Path $t.repo '.bdd/_') | Should -Be (Get-NormalizedPath $t.repo)
    }
}

Describe 'extract-bdd.ps1' {
    BeforeEach {
        $env:BDD_WEBP_ENCODER = 'none'   # 這組測試驗證 1.3.0 的去重、攤平、還原規則；WebP 行為見「WebP」Describe
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It '還原去重的檔案、逐檔驗證，且 manifest 不解出' {
        $to = Join-Path $base 'restore'
        $x = & "$script:Scripts/extract-bdd.ps1" -Archive $r.archive -To $to | ConvertFrom-Json
        $x.restoredAliases | Should -Be 1
        $x.verifiedFiles | Should -Be 8
        $folder = Join-Path $to '1234-demo'
        (Get-FileHash (Join-Path $folder 'evidence/R2_DM-01_首頁.png')).Hash | Should -Be (Get-FileHash (Join-Path $t.bdd 'evidence/R2_DM-01_首頁.png')).Hash
        Test-Path (Join-Path $folder 'bdd-manifest.json') | Should -BeFalse
    }

    It '目的地已有同名不同內容的檔案時停止' {
        $to = Join-Path $base 'restore'
        New-Item -ItemType Directory -Path (Join-Path $to '1234-demo') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $to '1234-demo/REPORT.md') -Value '不同內容'
        { & "$script:Scripts/extract-bdd.ps1" -Archive $r.archive -To $to } | Should -Throw '*不覆蓋*'
    }
}

Describe 'bdd-archive-index.ps1 與 prune-bdd.ps1' {
    BeforeEach {
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $index = "$script:Scripts/bdd-archive-index.ps1"
        $prune = "$script:Scripts/prune-bdd.ps1"
    }

    It 'uploaded-verified 沒有附件識別時拒絕' {
        { & $index -Mark -Archive $r.archive -Status uploaded-verified } | Should -Throw '*-Attachment*'
    }

    It '封存檔被改動後拒絕登記狀態' {
        Add-Content -LiteralPath $r.archive -Value 'x'
        { & $index -Mark -Archive $r.archive -Status uploaded-verified -Attachment 99 } | Should -Throw '*SHA-256*'
    }

    It '尚未 uploaded-verified 時不清理' {
        $p = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        $p.items[0].action | Should -Be 'keep'
        $p.items[0].reason | Should -BeLike '*uploaded-verified*'
    }

    It '已上傳並確認：預設只列計畫，-Apply 才刪 evidence/，保留報告與情境' {
        & $index -Mark -Archive $r.archive -Status uploaded-verified -Attachment 99 | Out-Null
        $plan = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        $plan.items[0].action | Should -Be 'prune'
        Test-Path (Join-Path $t.bdd 'evidence') | Should -BeTrue

        $done = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot -Apply | ConvertFrom-Json
        $done.items[0].action | Should -Be 'pruned'
        Test-Path (Join-Path $t.bdd 'evidence') | Should -BeFalse
        Test-Path (Join-Path $t.bdd 'REPORT.md') | Should -BeTrue
        Test-Path (Join-Path $t.bdd '01-demo.feature') | Should -BeTrue
    }

    It '封存後又新增證據時不清理' {
        & $index -Mark -Archive $r.archive -Status uploaded-verified -Attachment 99 | Out-Null
        New-TestPng (Join-Path $t.bdd 'evidence/R3_DM-04_新圖.png') '#ABCDEF'
        $p = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot -Apply | ConvertFrom-Json
        $p.items[0].action | Should -Be 'keep'
        Test-Path (Join-Path $t.bdd 'evidence/R3_DM-04_新圖.png') | Should -BeTrue
    }

    It '-AllowLocalOnly 時，local-only 的封存也可當清理依據' {
        (& $prune -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json).items[0].action | Should -Be 'keep'
        $p = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot -AllowLocalOnly -Apply | ConvertFrom-Json
        $p.items[0].action | Should -Be 'pruned'
        Test-Path (Join-Path $t.bdd 'evidence') | Should -BeFalse
    }

    It '-Import 複製舊封存並登記為 legacy，-Move 才刪除來源，重複匯入拒絕' {
        $legacy = Join-Path $t.repo '.claude/bdd-archives/1234-old.zip'
        New-Item -ItemType Directory -Path (Split-Path $legacy) -Force | Out-Null
        Copy-Item $r.archive $legacy
        $hash = (Get-FileHash $legacy).Hash
        $i = & $index -Import -Archive $legacy -ArchiveRoot $archiveRoot -Repo $t.repo -Issue 1234 -Topic 1234-demo -Commit abc -Move | ConvertFrom-Json
        $i.archive | Should -Be (Join-Path $archiveRoot '1234\legacy\1234-old.zip')
        (Get-FileHash $i.archive).Hash | Should -Be $hash
        Test-Path $legacy | Should -BeFalse
        $list = & $index -List -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($list.archives | Where-Object archive -eq $i.archive).legacy | Should -BeTrue
        Copy-Item $i.archive $legacy
        { & $index -Import -Archive $legacy -ArchiveRoot $archiveRoot -Issue 1234 -Topic 1234-demo } | Should -Throw '*已有*'
    }

    It '證據已被 git 追蹤時不刪除' {
        git -C $t.repo add -f -- '.bdd/1234-demo/evidence/DM-03_回應.json'
        git -C $t.repo commit -q -m evidence
        $p = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot -AllowLocalOnly -Apply | ConvertFrom-Json
        $p.items[0].action | Should -Be 'keep'
        $p.items[0].reason | Should -BeLike '*git 追蹤*'
        Test-Path (Join-Path $t.bdd 'evidence/R1_DM-01_首頁.png') | Should -BeTrue
    }

    It '被取代的封存不算數' {
        & $index -Mark -Archive $r.archive -Status uploaded-verified -Attachment 99 | Out-Null
        Start-Sleep -Milliseconds 1100
        Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } | Out-Null
        $p = & $prune -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        $p.items[0].action | Should -Be 'keep'
    }
}

Describe 'mask-evidence.ps1' {
    BeforeEach {
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $mask = "$script:Scripts/mask-evidence.ps1"
    }

    It '-Apply 依座標塗色、範圍外不變，並登記 rect' {
        Set-BddConfig $t.repo @{ mask = @{ rects = @(@{ name = 'avatar'; glob = '*DM-02*'; rect = @(30, 0, 999, 10); color = '#FFFFFF' }) } }
        $r = & $mask -Dir $t.bdd -Apply | ConvertFrom-Json
        $r.applied | Should -Be @('evidence/R2_DM-02_列表.png')
        $bytes = [IO.File]::ReadAllBytes((Join-Path $t.bdd 'evidence/R2_DM-02_列表.png'))
        $bmp = [Drawing.Bitmap]::new([IO.MemoryStream]::new($bytes))
        $bmp.GetPixel(35, 5).ToArgb() | Should -Be ([Drawing.Color]::White.ToArgb())
        $bmp.GetPixel(5, 15).ToArgb() | Should -Not -Be ([Drawing.Color]::White.ToArgb())
        $bmp.Dispose()
        $s = & $mask -Dir $t.bdd -Status | ConvertFrom-Json
        ($s.files | Where-Object file -eq 'evidence/R2_DM-02_列表.png').method | Should -Be 'rect'
        $s.unmasked.Count | Should -Be 2
    }

    It '已遮罩的圖片再次 -Apply 時略過' {
        Set-BddConfig $t.repo @{ mask = @{ rects = @(@{ glob = '*DM-02*'; rect = @(0, 0, 5, 5) }) } }
        & $mask -Dir $t.bdd -Apply | Out-Null
        $again = & $mask -Dir $t.bdd -Apply | ConvertFrom-Json
        $again.skippedAlreadyMasked | Should -Be @('evidence/R2_DM-02_列表.png')
    }

    It 'exempt 沒有理由時拒絕' {
        { & $mask -Dir $t.bdd -Mark -Method exempt } | Should -Throw '*-Note*'
    }

    It '沒有 mask.rects 規則時 -Apply 拒絕' {
        { & $mask -Dir $t.bdd -Apply } | Should -Throw '*mask.rects*'
    }
}

Describe 'archive-bdd.ps1 情境快照' {
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $env:BDD_WEBP_ENCODER = 'none'
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It 'issue 資料夾沒有 .feature 時，依 scenarios 收入受測當時的情境' {
        $m = Convert-ToModuleLayout $t
        # 受測之後模組情境又被改過：封存要收的是受測當時那一版
        Add-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/01.feature') -Value '  # 之後的修改'
        git -C $t.repo commit -qam later
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }

        $manifest = Read-Manifest $r.archive
        @($manifest.features) | Should -Be @('.bdd/modules/m/01.feature')
        $manifest.files.'features/m/01.feature'.blob | Should -Be $m.blob
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/features/m/01.feature').Open())
            try { $reader.ReadToEnd() | Should -Not -Match '之後的修改' } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
    }

    It '同一情境檔分列 changed 與 regression 時只收一份快照' {
        Convert-ToModuleLayout $t | Out-Null
        $doc = Get-Content (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
        $original = $doc.rounds[0].scenarios[0]
        $doc.rounds[0].scenarios += @{ path = $original.path; blob = $original.blob; ids = @('SS-02'); role = 'regression' }
        Set-Content (Join-Path $t.bdd 'verification.json') ($doc | ConvertTo-Json -Depth 8)
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try { @($zip.Entries | Where-Object FullName -eq '1234-demo/features/m/01.feature').Count | Should -Be 1 }
        finally { $zip.Dispose() }
    }

    It '受測時情境檔未提交（blob 為 null）時拒絕封存' {
        Convert-ToModuleLayout $t | Out-Null
        $doc = Get-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
        $doc.rounds[0].scenarios[0].blob = $null
        Set-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*尚未提交*'
    }

    It '紀錄的 blob 與受測 commit 不符時拒絕封存' {
        Convert-ToModuleLayout $t | Out-Null
        $doc = Get-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
        $doc.rounds[0].scenarios[0].blob = '0000000000000000000000000000000000000000'
        Set-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*不符*'
    }

    It '沒有 .feature 也沒有 scenarios 時拒絕封存' {
        Remove-Item -LiteralPath (Join-Path $t.bdd '01-demo.feature')
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*情境*'
    }

    It '舊格式（issue 資料夾內有 .feature、沒有 scenarios）照舊封存，features 為空' {
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        @((Read-Manifest $r.archive).features).Count | Should -Be 0
    }
}

Describe 'archive-bdd.ps1 WebP' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'
    }
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $env:BDD_WEBP_ENCODER = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It '截圖轉成無損 WebP：manifest 記錄原檔，同內容仍去重，ZIP 內沒有 PNG' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpEncoder | Should -Be 'pillow'
        $r.webpConverted | Should -Be 3
        $manifest = Read-Manifest $r.archive
        $manifest.schema | Should -Be 2
        $rec = $manifest.files.'evidence/R1_DM-01_首頁.webp'
        $rec.originalName | Should -Be 'evidence/R1_DM-01_首頁.png'
        $rec.originalSha256 | Should -Be (Get-FileHash -LiteralPath (Join-Path $t.bdd 'evidence/R1_DM-01_首頁.png') -Algorithm SHA256).Hash
        $rec.lossless | Should -BeTrue
        $manifest.aliases.'evidence/R2_DM-01_首頁.webp' | Should -Be 'evidence/R1_DM-01_首頁.webp'
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try { @($zip.Entries.FullName | Where-Object { $_ -like '*.png' }).Count | Should -Be 0 } finally { $zip.Dispose() }
        # 工作區原檔不動
        Test-Path -LiteralPath (Join-Path $t.bdd 'evidence/R1_DM-01_首頁.png') | Should -BeTrue
    }

    It '封存內的 masking.json 改以 WebP 為鍵並保留 derivedFrom' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/masking.json').Open())
            try { $ledger = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
        $rec = $ledger.files.'evidence/R2_DM-02_列表.webp'
        $rec.method | Should -Be 'exempt'
        $rec.sha256 | Should -Be (Read-Manifest $r.archive).files.'evidence/R2_DM-02_列表.webp'.sha256
        $rec.derivedFrom.name | Should -Be 'evidence/R2_DM-02_列表.png'
        $ledger.files.PSObject.Properties.Name | Should -Not -Contain 'evidence/R2_DM-02_列表.png'
    }

    It 'REPORT.md 的連結（含 URL 編碼的中文檔名）改寫成 .webp' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $encoded = 'evidence/' + [Uri]::EscapeDataString('R2_DM-02_列表.png')
        Set-Content -LiteralPath (Join-Path $t.bdd 'REPORT.md') -Encoding utf8 -Value "# 報告`n![](evidence/R1_DM-01_首頁.png)`n![]($encoded)"
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/REPORT.md').Open())
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
        $text | Should -Match ([regex]::Escape('evidence/R1_DM-01_首頁.webp'))
        $text | Should -Match ([regex]::Escape('evidence/' + [Uri]::EscapeDataString('R2_DM-02_列表.webp')))
        $text | Should -Not -Match '\.png'
        (Read-Manifest $r.archive).rewrittenLinks.'REPORT.md' | Should -Be 2
        # 工作區報告不動
        Get-Content -LiteralPath (Join-Path $t.bdd 'REPORT.md') -Raw | Should -Match '\.png'
    }

    It '同名不同副檔名時，第二個保留原格式並記錄 name-conflict' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        # 用未壓縮的 BMP：轉 WebP 一定變小，且檔名排序在 .png 之前，先取得 .webp 名稱
        $other = Join-Path $t.bdd 'evidence/R2_DM-02_列表.bmp'
        $bmp = [Drawing.Bitmap]::new(40, 20); $g = [Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::Olive); $g.Dispose()
        $bmp.Save($other, [Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $manifest = Read-Manifest $r.archive
        @($manifest.webp.skipped | Where-Object reason -eq 'name-conflict').Count | Should -Be 1
        $names = @($manifest.files.PSObject.Properties.Name)
        $names | Should -Contain 'evidence/R2_DM-02_列表.webp'
        (@($names | Where-Object { $_ -like 'evidence/R2_DM-02_列表.*' })).Count | Should -Be 2
    }

    It '沒有編碼器時保留原格式並警告 webpUnavailable' {
        $env:BDD_WEBP_ENCODER = 'none'
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpConverted | Should -Be 0
        @($r.warnings) -join ' ' | Should -Match 'webpUnavailable'
        (Read-Manifest $r.archive).files.PSObject.Properties.Name | Should -Contain 'evidence/R1_DM-01_首頁.png'
        $created = Get-Content -LiteralPath (Join-Path $archiveRoot 'index.jsonl') | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -eq 'created'
        $created.webp | Should -BeFalse
    }

    It '.bdd/config.json 設 webp = off 時不轉檔也不警告' {
        Set-BddConfig $t.repo @{ webp = 'off' }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpConverted | Should -Be 0
        @($r.warnings) -join ' ' | Should -Not -Match 'webpUnavailable'
    }

    It '.bdd/config.json 的 webp 值不合法時拒絕' {
        Set-BddConfig $t.repo @{ webp = 'lossy' }
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*webp*'
    }
}

Describe 'WebP 封存的清理與還原' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'
    }
    BeforeEach {
        $env:BDD_WEBP_ENCODER = $null
        $env:BDD_ARCHIVE_ROOT = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }

    It 'prune-bdd.ps1 以原檔雜湊確認 PNG 證據已收在 WebP 封存裡' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $r.archive -Status uploaded-verified -Attachment 1 -ArchiveRoot $archiveRoot | Out-Null
        $plan = & "$script:Scripts/prune-bdd.ps1" -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($plan.items | Where-Object topic -eq '1234-demo').action | Should -Be 'prune'
    }

    It '還原 WebP 封存後加入新一輪 PNG 證據，可以再封存' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Convert-ToModuleLayout $t | Out-Null
        Register-AllExempt $t.bdd
        $first = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }

        $restoreRoot = Join-Path $base 'restore/.bdd'
        & "$script:Scripts/extract-bdd.ps1" -Archive $first.archive -To $restoreRoot | Out-Null
        $restored = Join-Path $restoreRoot '1234-demo'
        Test-Path -LiteralPath (Join-Path $restored 'features/m/01.feature') | Should -BeTrue
        New-TestPng (Join-Path $restored 'evidence/R3_DM-04_新畫面.png') '#123456'
        & "$script:Scripts/mask-evidence.ps1" -Dir $restored -Mark -Pattern 'R3_*' -Method exempt -Note '測試用純色圖' | Out-Null

        # 還原出來的資料夾不在 git 內：複製回 repo 的 .bdd 底下再封存，受測 commit 仍取 verification.json
        $again = Join-Path $t.repo '.bdd/1234-demo-r3'
        Copy-Item -LiteralPath $restored -Destination $again -Recurse
        $second = Invoke-Archive @{ Dir = $again; ArchiveRoot = $archiveRoot }
        $manifest = Read-Manifest $second.archive
        $names = @($manifest.files.PSObject.Properties.Name)
        $names | Should -Contain 'evidence/R3_DM-04_新畫面.webp'
        $names | Should -Contain 'evidence/R1_DM-01_首頁.webp'
        @($names | Where-Object { $_ -like 'features/*' }) | Should -Be @('features/m/01.feature')
    }
}

Describe 'recompress-bdd.ps1' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        Import-Module (Join-Path $script:Scripts 'lib/BddArchive.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'

        # 手工組一個沒有 manifest 的舊版封存並登記進索引；WithFolder 為 $false 時項目直接放在 ZIP 根目錄
        function New-LegacyZip([string]$Zip, [string]$Root, [bool]$WithFolder, [bool]$EvidenceOnly = $false) {
            $png = Join-Path $Root 'legacy.png'
            New-TestPng $png '#aa5522'
            [IO.Directory]::CreateDirectory((Split-Path $Zip -Parent)) | Out-Null
            $p = if ($WithFolder) { 'legacy-topic/' } else { '' }
            $fs = [IO.File]::Create($Zip)
            $za = [IO.Compression.ZipArchive]::new($fs, [IO.Compression.ZipArchiveMode]::Create)
            try {
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $png, "${p}evidence/R1_舊版.png")
                if (-not $EvidenceOnly) { $e = $za.CreateEntry("${p}REPORT.md"); $w = [IO.StreamWriter]::new($e.Open()); $w.Write('# 舊報告'); $w.Dispose() }
            } finally { $za.Dispose(); $fs.Dispose() }
            Add-ArchiveIndexEvent $archiveRoot ([ordered]@{
                event = 'created'; archive = $Zip; name = (Split-Path $Zip -Leaf); issue = '1234'; topic = 'legacy-topic'; commit = 'abc1234'
                sha256 = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash; bytes = (Get-Item -LiteralPath $Zip).Length
                repo = $null; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); legacy = $true
            })
        }
        # 列出封存內所有項目名稱
        function Get-ZipNames([string]$Zip) {
            $z = [IO.Compression.ZipFile]::OpenRead($Zip)
            try { @($z.Entries | ForEach-Object FullName) } finally { $z.Dispose() }
        }
    }
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
        # 先以「沒有編碼器」產生一份 PNG 版封存，模擬 1.3.0 留下的舊封存
        $env:BDD_WEBP_ENCODER = 'none'
        Register-AllExempt $t.bdd
        $old = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $env:BDD_WEBP_ENCODER = $null
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It '重新壓縮後路徑不變、改成 WebP、索引記錄 recompressed 且狀態繼承' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $old.archive -Status uploaded-verified -Attachment 99 -ArchiveRoot $archiveRoot | Out-Null
        $r = & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | ConvertFrom-Json
        $r.changed | Should -BeTrue
        $r.archive | Should -Be $old.archive
        $r.converted | Should -Be 3
        $r.sha256 | Should -Be (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash
        (Read-Manifest $old.archive).files.PSObject.Properties.Name | Should -Contain 'evidence/R1_DM-01_首頁.webp'
        (Read-Manifest $old.archive).recompressedFrom.sha256 | Should -Be $old.sha256

        $state = Get-ArchiveStates $archiveRoot | Where-Object archive -eq $old.archive
        $state.status | Should -Be 'uploaded-verified'
        $state.recompressed | Should -BeTrue
        $state.issueCopySha256 | Should -Be $old.sha256
        $state.sha256 | Should -Be $r.sha256
        Test-Path -LiteralPath "$($old.archive).bak" | Should -BeFalse
    }

    It '重新壓縮後 prune-bdd.ps1 仍可據以清理' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $old.archive -Status uploaded-verified -Attachment 99 -ArchiveRoot $archiveRoot | Out-Null
        & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | Out-Null
        $plan = & "$script:Scripts/prune-bdd.ps1" -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($plan.items | Where-Object topic -eq '1234-demo').action | Should -Be 'prune'
    }

    It '已是 WebP 的封存再跑一次時 changed = false，檔案不動' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | Out-Null
        $hash = (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash
        $again = & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | ConvertFrom-Json
        $again.changed | Should -BeFalse
        (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash | Should -Be $hash
    }

    It '封存檔與索引記錄的 SHA-256 不同時拒絕' {
        [IO.File]::AppendAllText($old.archive, 'x')
        { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*SHA-256*'
    }

    It '沒有編碼器時拒絕' {
        $env:BDD_WEBP_ENCODER = 'none'
        try { { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*Pillow*' }
        finally { $env:BDD_WEBP_ENCODER = $null }
    }

    It '舊版只有 evidence 資料夾時仍可重新壓縮' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有 Pillow'; return }
        $zip = Join-Path $archiveRoot '1234/legacy/evidence-only.zip'
        New-LegacyZip $zip $base $false $true
        $r = & "$script:Scripts/recompress-bdd.ps1" -Archive $zip | ConvertFrom-Json
        $r.changed | Should -BeTrue
        (Get-ZipNames $zip) | Should -Contain 'legacy-topic/evidence/R1_舊版.webp'
    }

    It '舊版沒有 manifest 的封存（有第一層資料夾）可轉檔並補上 legacy manifest' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $zip = Join-Path $archiveRoot '1234/legacy/old-folder.zip'
        New-LegacyZip $zip $base $true
        $r = & "$script:Scripts/recompress-bdd.ps1" -Archive $zip | ConvertFrom-Json
        $r.changed | Should -BeTrue
        $r.converted | Should -Be 1
        $m = Read-Manifest $zip
        $m.legacy | Should -BeTrue
        $m.topic | Should -Be 'legacy-topic'
        $m.recompressedFrom | Should -Not -BeNullOrEmpty
        $names = Get-ZipNames $zip
        $names | Should -Contain 'legacy-topic/evidence/R1_舊版.webp'
        $names | Should -Not -Contain 'legacy-topic/evidence/R1_舊版.png'
    }

    It '舊版封存項目直接在 ZIP 根目錄時，輸出前綴為 topic 資料夾' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $zip = Join-Path $archiveRoot '1234/legacy/old-flat.zip'
        New-LegacyZip $zip $base $false
        $r = & "$script:Scripts/recompress-bdd.ps1" -Archive $zip | ConvertFrom-Json
        $r.changed | Should -BeTrue
        $names = Get-ZipNames $zip
        @($names | Where-Object { $_ -notlike 'legacy-topic/*' }) | Should -BeNullOrEmpty
        $names | Should -Contain 'legacy-topic/evidence/R1_舊版.webp'
        $names | Should -Contain 'legacy-topic/bdd-manifest.json'
        (Read-Manifest $zip).legacy | Should -BeTrue
    }

    It '殘留 .bak 時拒絕，且不外洩暫存目錄、不動封存檔' {
        Set-Content -LiteralPath "$($old.archive).bak" -Value 'leftover'
        $tmp = [IO.Path]::GetTempPath()
        $before = @(Get-ChildItem -LiteralPath $tmp -Directory -Filter 'bdd-recompress-*' | ForEach-Object Name)
        { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*備份*'
        $after = @(Get-ChildItem -LiteralPath $tmp -Directory -Filter 'bdd-recompress-*' | ForEach-Object Name)
        @($after | Where-Object { $_ -notin $before }) | Should -BeNullOrEmpty
        (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash | Should -Be $old.sha256
    }

    It '殘留 .recompress.zip 時拒絕，且不外洩暫存目錄' {
        Set-Content -LiteralPath "$($old.archive).recompress.zip" -Value 'leftover'
        $tmp = [IO.Path]::GetTempPath()
        $before = @(Get-ChildItem -LiteralPath $tmp -Directory -Filter 'bdd-recompress-*' | ForEach-Object Name)
        { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*暫存檔*'
        $after = @(Get-ChildItem -LiteralPath $tmp -Directory -Filter 'bdd-recompress-*' | ForEach-Object Name)
        @($after | Where-Object { $_ -notin $before }) | Should -BeNullOrEmpty
    }

    It '新檔搬入後寫索引失敗時，舊檔回到原路徑且不殘留 .bak 與暫存檔' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $index = Join-Path $archiveRoot 'index.jsonl'
        (Get-Item -LiteralPath $index).IsReadOnly = $true
        try {
            { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw
        } finally { (Get-Item -LiteralPath $index).IsReadOnly = $false }
        Test-Path -LiteralPath $old.archive | Should -BeTrue
        (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash | Should -Be $old.sha256
        Test-Path -LiteralPath "$($old.archive).bak" | Should -BeFalse
        Test-Path -LiteralPath "$($old.archive).recompress.zip" | Should -BeFalse
        (Get-ArchiveStates $archiveRoot | Where-Object archive -eq $old.archive).recompressed | Should -BeFalse
    }
}
