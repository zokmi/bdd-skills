<#
.SYNOPSIS
  模組情境集（.bdd/modules/）的解析與檢查：MODULE.md front matter、.feature 情境標籤、編號規則、異動檔案對應模組。

.DESCRIPTION
  由 bdd-modules.ps1 與 bdd-verification.ps1 匯入。只做讀取與判斷，不改任何檔案。
#>

Set-StrictMode -Version 3.0

<#
.SYNOPSIS
  解析 MODULE.md 開頭以 --- 包住的 front matter。
  支援「鍵: 值」與「鍵:」後接「  - 項目」的清單；回傳 OrderedDictionary。格式錯誤時丟例外。
#>
function Read-ModuleFrontMatter([Parameter(Mandatory)][string]$Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding utf8)
    if (-not $lines.Count -or $lines[0].Trim() -ne '---') { throw "MODULE.md 缺少開頭的 --- front matter：$Path" }
    $data = [ordered]@{}
    $current = $null
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line.Trim() -eq '---') { return $data }
        if ($line -match '^\s+-\s+(.+?)\s*$') {
            if (-not $current) { throw "front matter 第 $($i + 1) 行的清單項目前面缺少鍵名：$Path" }
            $data[$current] = @($data[$current]) + $Matches[1]
            continue
        }
        if ($line -match '^([A-Za-z]+):\s*(.*?)\s*$') {
            $current = $Matches[1]
            $data[$current] = if ($Matches[2]) { $Matches[2] } else { @() }
            continue
        }
        if ($line.Trim()) { throw "無法解析 front matter 第 $($i + 1) 行：$Path" }
    }
    throw "front matter 沒有結尾的 ---：$Path"
}

<#
.SYNOPSIS
  列出 repo 內所有模組（每個含 MODULE.md 的目錄）。
  回傳欄位：name（相對 .bdd/modules，以 / 分隔）、dir、modulePath、prefix、paths、issues、removed（只取編號）、errors（解析錯誤訊息）。
#>
function Get-BddModules([Parameter(Mandatory)][string]$RepoRoot) {
    $modulesRoot = Join-Path $RepoRoot '.bdd/modules'
    if (-not (Test-Path -LiteralPath $modulesRoot -PathType Container)) { return @() }
    @(Get-ChildItem -LiteralPath $modulesRoot -Recurse -File -Filter 'MODULE.md' | Sort-Object FullName | ForEach-Object {
        $errors = @()
        $fm = [ordered]@{}
        try { $fm = Read-ModuleFrontMatter $_.FullName } catch { $errors += $_.Exception.Message }
        [pscustomobject]@{
            name = [IO.Path]::GetRelativePath($modulesRoot, $_.DirectoryName).Replace('\', '/')
            dir = $_.DirectoryName
            modulePath = $_.FullName
            prefix = "$($fm['prefix'])"
            paths = @($fm['paths'] | Where-Object { $_ })
            issues = @($fm['issues'] | Where-Object { $_ })
            removed = @(@($fm['removed']) | Where-Object { $_ } | ForEach-Object { ($_ -split '\s+')[0] })
            errors = $errors
        }
    })
}

<#
.SYNOPSIS
  解析 .feature 檔的情境。標籤取情境標題上方連續的 @ 行；功能層的標籤會在遇到「功能:」時清掉，不算進情境。
  回傳欄位：file、line、title、tags、ids（模組編號，例如 SS-01）、issues（@#單號 的數字）、methods（UI／API／DB）。
#>
function Get-FeatureScenarios([Parameter(Mandatory)][string]$Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding utf8)
    $pending = [Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t.StartsWith('@')) {
            foreach ($tag in $t -split '\s+') { if ($tag.StartsWith('@')) { $pending.Add($tag) } }
            continue
        }
        if ($t -match '^(場景大綱|場景|劇本大綱|劇本|Scenario Outline|Scenario)\s*[:：]\s*(.*)$') {
            $tags = @($pending)
            [pscustomobject]@{
                file = $Path
                line = $i + 1
                title = $Matches[2]
                tags = $tags
                ids = @($tags | Where-Object { $_ -cmatch '^@[A-Z]{2,3}-\d+$' } | ForEach-Object { $_.Substring(1) })
                issues = @($tags | Where-Object { $_ -match '^@#\d+$' } | ForEach-Object { $_.Substring(2) })
                methods = @($tags | Where-Object { $_ -cin '@UI', '@API', '@DB' } | ForEach-Object { $_.Substring(1) })
            }
            $pending.Clear()
            continue
        }
        if ($t -and -not $t.StartsWith('#')) { $pending.Clear() }
    }
}

<#
.SYNOPSIS
  檢查模組情境集，回傳問題清單（rule、module、file、line、message）。沒有問題時回傳空陣列。
#>
function Test-BddModules([Parameter(Mandatory)][string]$RepoRoot) {
    $problems = [Collections.Generic.List[object]]::new()
    $add = {
        param($Rule, $Module, $File, $Line, $Message)
        $problems.Add([pscustomobject]@{ rule = $Rule; module = $Module; file = $File; line = $Line; message = $Message })
    }
    $modulesRoot = Join-Path $RepoRoot '.bdd/modules'
    $modules = @(Get-BddModules $RepoRoot)

    foreach ($m in $modules) {
        foreach ($e in $m.errors) { & $add 'module-format' $m.name $m.modulePath $null $e }
        if ($m.errors.Count) { continue }
        if ($m.prefix -cnotmatch '^[A-Z]{2,3}$') { & $add 'module-format' $m.name $m.modulePath $null "前綴必須是 2–3 個大寫英文字母：'$($m.prefix)'" }
        if (-not $m.paths.Count) { & $add 'module-format' $m.name $m.modulePath $null '缺少 paths（對應程式路徑）' }
    }

    foreach ($g in @($modules | Where-Object { $_.prefix } | Group-Object prefix -CaseSensitive | Where-Object Count -gt 1)) {
        & $add 'duplicate-prefix' (($g.Group | ForEach-Object name) -join '、') $null $null "前綴 $($g.Name) 被多個模組使用"
    }

    if (Test-Path -LiteralPath $modulesRoot -PathType Container) {
        $moduleDirs = @($modules | ForEach-Object dir)
        foreach ($f in Get-ChildItem -LiteralPath $modulesRoot -Recurse -File -Filter '*.feature') {
            if ($f.DirectoryName -notin $moduleDirs) {
                & $add 'orphan-feature' $null ([IO.Path]::GetRelativePath($RepoRoot, $f.FullName).Replace('\', '/')) $null '情境檔所在目錄沒有 MODULE.md'
            }
        }
    }

    foreach ($m in $modules) {
        $seen = @{}
        foreach ($f in Get-ChildItem -LiteralPath $m.dir -File -Filter '*.feature' | Sort-Object Name) {
            $rel = [IO.Path]::GetRelativePath($RepoRoot, $f.FullName).Replace('\', '/')
            foreach ($s in @(Get-FeatureScenarios $f.FullName)) {
                if ($s.ids.Count -ne 1) { & $add 'scenario-id' $m.name $rel $s.line "情境必須剛好有一個編號標籤：$($s.title)"; continue }
                $id = $s.ids[0]
                if ($id.Split('-')[0] -cne $m.prefix) { & $add 'unknown-prefix' $m.name $rel $s.line "編號 $id 的前綴不是本模組登記的 $($m.prefix)" }
                if ($seen.ContainsKey($id)) { & $add 'duplicate-id' $m.name $rel $s.line "編號 $id 重複（另見 $($seen[$id])）" }
                else { $seen[$id] = "${rel}:$($s.line)" }
                if ($id -in $m.removed) { & $add 'reused-id' $m.name $rel $s.line "編號 $id 已在 MODULE.md 記為移除，不可再用" }
                if (-not $s.issues.Count) { & $add 'missing-issue-tag' $m.name $rel $s.line "情境缺少單號標籤（例如 @#5349）：$($s.title)" }
                if (-not $s.methods.Count) { & $add 'missing-method-tag' $m.name $rel $s.line "情境缺少 @UI／@API／@DB：$($s.title)" }
            }
        }
    }
    @($problems)
}

<#
.SYNOPSIS
  回傳模組的下一個可用編號：現有與已移除編號的最大號加一，至少兩位數（例如 SS-08）。
#>
function Get-NextScenarioId([Parameter(Mandatory)]$Module) {
    $existing = @(Get-ChildItem -LiteralPath $Module.dir -File -Filter '*.feature' | ForEach-Object { Get-FeatureScenarios $_.FullName } | ForEach-Object { $_.ids })
    $numbers = @(@($existing) + @($Module.removed) | Where-Object { $_ -cmatch "^$([regex]::Escape($Module.prefix))-(\d+)$" } | ForEach-Object { [int]($_ -replace '^.*-', '') })
    $next = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    '{0}-{1:D2}' -f $Module.prefix, [int]$next
}

<#
.SYNOPSIS
  把 glob（支援 **、*、?）轉成比對 repo 相對路徑（以 / 分隔）的正規表示式字串。
#>
function ConvertTo-GlobRegex([Parameter(Mandatory)][string]$Glob) {
    $g = $Glob.Replace('\', '/')
    $sb = [Text.StringBuilder]::new('^')
    for ($i = 0; $i -lt $g.Length; $i++) {
        $c = $g[$i]
        if ($c -eq '*' -and $i + 1 -lt $g.Length -and $g[$i + 1] -eq '*') {
            $i++
            if ($i + 1 -lt $g.Length -and $g[$i + 1] -eq '/') { $i++; [void]$sb.Append('(?:.*/)?') }
            else { [void]$sb.Append('.*') }
        } elseif ($c -eq '*') { [void]$sb.Append('[^/]*') }
        elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
        else { [void]$sb.Append([regex]::Escape([string]$c)) }
    }
    [void]$sb.Append('$')
    $sb.ToString()
}

<#
.SYNOPSIS
  依各 MODULE.md 的 paths 找出異動檔案所屬的模組。.bdd/ 底下的檔案略過。
  回傳 modules（name、files）與 unmatched（沒有任何模組對應的檔案）。
#>
function Find-ModulesForPaths([Parameter(Mandatory)][string]$RepoRoot, [string[]]$Paths = @()) {
    $rules = @(foreach ($m in @(Get-BddModules $RepoRoot | Where-Object { -not $_.errors.Count })) {
        foreach ($glob in $m.paths) { [pscustomobject]@{ module = $m.name; regex = [regex]::new((ConvertTo-GlobRegex $glob), 'IgnoreCase') } }
    })
    $hits = [ordered]@{}
    $unmatched = [Collections.Generic.List[string]]::new()
    foreach ($p in @($Paths | ForEach-Object { $_.Replace('\', '/') -replace '^\./', '' } | Where-Object { $_ } | Sort-Object -Unique)) {
        if ($p.StartsWith('.bdd/')) { continue }
        $matched = @($rules | Where-Object { $_.regex.IsMatch($p) } | ForEach-Object module | Sort-Object -Unique)
        if (-not $matched.Count) { $unmatched.Add($p); continue }
        foreach ($name in $matched) {
            if (-not $hits.Contains($name)) { $hits[$name] = [Collections.Generic.List[string]]::new() }
            $hits[$name].Add($p)
        }
    }
    [pscustomobject]@{
        modules = @($hits.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ name = $_; files = @($hits[$_]) } })
        unmatched = @($unmatched)
    }
}

Export-ModuleMember -Function *
