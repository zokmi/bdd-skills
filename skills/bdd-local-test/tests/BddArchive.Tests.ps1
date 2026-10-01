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
}

Describe 'archive-bdd.ps1' {
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }

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
        # 每個測試各用獨立目錄，避免 .git 唯讀檔清不掉而讓測試互相影響
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
    }

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
