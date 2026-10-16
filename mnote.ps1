<#
.SYNOPSIS
  Export Microsoft OneNote pages to .mnote files, and open .mnote files.

.DESCRIPTION
  One .mnote file holds one OneNote page. It is a ZIP container:

    mimetype          "application/vnd.mnote+zip" (always the first entry)
    manifest.json     title, notebook / section path, dates, list of files
    page.html         the page, readable in any browser (images come from images/)
    page.txt          plain text of the page, for search and quick reading
    page.onexml       OneNote's own XML for the page, images included (lossless)
    images/...        images on the page
    attachments/...   files that were embedded in the page
    annotations.json  optional: highlights, notes and bookmark added in the reader

  The export folder also gets library.json, which keeps OneNote's notebook and
  section order for the reader.

  Exporting needs the OneNote desktop app (Microsoft 365 / OneNote 2016) with
  the notebooks open in it. Reading needs nothing but a browser: 'read' starts a
  small private server on this PC and opens mnote-reader.html.

.EXAMPLE
  .\mnote.ps1 list
  .\mnote.ps1 export -OutDir "$HOME\Documents\OneNote Export"
  .\mnote.ps1 export -Notebook "My Notebook"
  .\mnote.ps1 read "$HOME\Documents\OneNote Export"
  .\mnote.ps1 read ".\OneNote Export\My Notebook\Section\01 Page.mnote"
  .\mnote.ps1 view ".\OneNote Export\My Notebook\Section\01 Page.mnote"
  .\mnote.ps1 info ".\OneNote Export\My Notebook\Section\01 Page.mnote"
  .\mnote.ps1 install "$HOME\Documents\OneNote Export"   # double-click opening + Start menu
  .\mnote.ps1 uninstall
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('list', 'export', 'read', 'view', 'info', 'pack', 'unpack', 'install', 'uninstall')]
    [string]$Command,

    # The .mnote or .mnotebook file for 'view' and 'info'; a .mnote / .mnotebook file or the
    # export folder for 'read'; a notebook folder for 'pack'; a .mnotebook file for 'unpack';
    # the export folder the Start menu shortcut opens, for 'install'.
    [Parameter(Position = 1)]
    [string]$Path,

    # 'read' only: start the reader without opening a window.
    [switch]$NoBrowser,

    # 'read' only: serve on exactly this port, as a separate instance (for a dev preview).
    # It never takes over an already running reader and is not used for double-clicked files.
    [int]$Port = 0,

    # Only these notebooks (by the name shown in OneNote). Default: all open notebooks.
    [string[]]$Notebook,

    # Where 'export' writes. Keep it short: Windows limits full paths to 260 characters.
    [string]$OutDir = 'OneNote Export',

    # Also export pages from OneNote's Notebook Recycle Bin.
    [switch]$IncludeRecycleBin,

    # 'pack' only: after the notebook file is written and checked, move the folder to the Recycle Bin.
    [switch]$RemoveFolder,

    # 'install' only: the browser the reader opens in. Firefox gets its own app-style window
    # (a separate Firefox profile with no tabs or address bar). Default: keep the current choice.
    [ValidateSet('edge', 'firefox')]
    [string]$Browser
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$MimeType = 'application/vnd.mnote+zip'
$NotebookMimeType = 'application/vnd.mnotebook+zip'
$FormatVersion = 1
$OneNs = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Invariant = [Globalization.CultureInfo]::InvariantCulture
# Tag names that mean a checkbox: "To Do" and the Russian "Zadacha".
$TodoPattern = '(?i)to ?do|\u0437\u0430\u0434\u0430\u0447'

# OneNote COM enums
$HsPages = 4          # HierarchyScope.hsPages
# PageInfo.piFileType. Binary data is fetched per object instead (see Resolve-BinaryData):
# asking for it inline makes OneNote silently drop images it has not downloaded yet.
$PiFileType = 4
$Xs2013 = 2           # XMLSchema.xs2013

# ---------------------------------------------------------------- helpers

function Enc([string]$s) { [System.Net.WebUtility]::HtmlEncode($s) }

function New-NsManager([System.Xml.XmlDocument]$doc) {
    $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('one', $OneNs)
    # The manager is enumerable; the comma stops PowerShell unrolling it.
    , $ns
}

function Get-SafeName([string]$name, [int]$max = 60) {
    $n = ($name -replace '[\\/:*?"<>|\x00-\x1f]', '_').Trim().TrimEnd('.')
    if (-not $n) { $n = 'Untitled' }
    if ($n.Length -gt $max) { $n = $n.Substring(0, $max).TrimEnd().TrimEnd('.') }
    if ($n -match '^(CON|PRN|AUX|NUL|COM\d|LPT\d)$') { $n = "_$n" }
    $n
}

function Format-Date([string]$iso) {
    if (-not $iso) { return '' }
    [DateTimeOffset]::Parse($iso, $Invariant).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
}

function ConvertTo-PlainText([string]$fragment) {
    $t = $fragment -replace '(?i)<br\s*/?>', "`n"
    $t = $t -replace '<[^>]+>', ''
    [System.Net.WebUtility]::HtmlDecode($t)
}

# OneNote text runs are small HTML fragments. Keep the formatting, drop anything executable.
function Get-SafeFragment([string]$fragment) {
    $f = $fragment -replace '(?is)<(script|style)\b.*?</\1\s*>', ''
    $f = $f -replace '(?i)\son\w+\s*=\s*("[^"]*"|''[^'']*''|[^\s>]+)', ''
    $f -replace '(?i)(href|src)\s*=\s*(["'']?)\s*javascript:', '$1=$2#'
}

function Get-PlainText($ctx, $node) {
    $parts = foreach ($t in $node.SelectNodes('.//one:T', $ctx.Ns)) { ConvertTo-PlainText $t.InnerText }
    ((@($parts) -join ' ') -replace '\s*\n\s*', ' ').Trim()
}

function Add-TextLine($ctx, [int]$depth, [string]$text) {
    if ($ctx.NoText -gt 0) { return }
    $indent = '    ' * $depth
    foreach ($l in ($text -split "`n")) { [void]$ctx.Text.Append($indent + $l.TrimEnd() + "`r`n") }
}

# ---------------------------------------------------------------- OneNote hierarchy

function Get-OneNote {
    try { New-Object -ComObject OneNote.Application }
    catch { throw 'Could not start OneNote. Exporting needs the OneNote desktop app (Microsoft 365 or OneNote 2016).' }
}

function Get-PageList($on) {
    [string]$xml = ''
    $on.GetHierarchy('', $HsPages, [ref]$xml)
    $doc = New-Object System.Xml.XmlDocument
    $doc.LoadXml($xml)
    $ns = New-NsManager $doc

    $result = New-Object System.Collections.Generic.List[object]
    foreach ($nb in $doc.DocumentElement.SelectNodes('one:Notebook', $ns)) {
        $nbName = $nb.GetAttribute('nickname')
        if (-not $nbName) { $nbName = $nb.GetAttribute('name') }
        if ($Notebook -and -not ($Notebook -contains $nbName -or $Notebook -contains $nb.GetAttribute('name'))) { continue }
        $info = [pscustomobject]@{ Name = $nbName; Id = $nb.GetAttribute('ID'); Path = $nb.GetAttribute('path') }
        Add-SectionPages $info $nb @() $ns $result
    }
    , $result
}

function Add-SectionPages($nb, $node, [string[]]$groups, $ns, $result) {
    foreach ($child in $node.ChildNodes) {
        if ($child.LocalName -eq 'SectionGroup') {
            if ($child.GetAttribute('isRecycleBin') -eq 'true' -and -not $IncludeRecycleBin) { continue }
            Add-SectionPages $nb $child ($groups + $child.GetAttribute('name')) $ns $result
        }
        elseif ($child.LocalName -eq 'Section') {
            $where = (@($nb.Name) + $groups + $child.GetAttribute('name')) -join ' / '
            if ($child.GetAttribute('locked') -eq 'true') {
                Write-Warning "Skipped password-protected section '$where'. Unlock it in OneNote and run again."
                continue
            }
            $pages = @($child.SelectNodes('one:Page', $ns) | Where-Object {
                    $IncludeRecycleBin -or $_.GetAttribute('isInRecycleBin') -ne 'true' })
            $i = 0
            foreach ($p in $pages) {
                $i++
                $result.Add([pscustomobject]@{
                        Notebook   = $nb
                        Groups     = $groups
                        Section    = $child.GetAttribute('name')
                        Location   = ($groups + $child.GetAttribute('name')) -join ' / '
                        Page       = $p
                        Title      = $p.GetAttribute('name')
                        Index      = $i
                        Count      = $pages.Count
                    })
            }
        }
    }
}

# ---------------------------------------------------------------- page -> html + text

function Write-Image($ctx, $img) {
    $b64 = $null
    $data = $img.SelectSingleNode('one:Data', $ctx.Ns)
    if ($data) { $b64 = $data.InnerText }
    if (-not $b64) { return @{ Html = '<span class="muted">[image not available]</span>'; Text = '[image not available]' } }

    $ext = $img.GetAttribute('format').ToLowerInvariant()
    if ($ext -eq 'jpeg') { $ext = 'jpg' } elseif (-not $ext) { $ext = 'png' }
    $name = 'images/{0:D3}.{1}' -f ($ctx.Images.Count + 1), $ext
    $ctx.Images.Add([pscustomobject]@{ Name = $name; Bytes = [Convert]::FromBase64String($b64) })

    $style = ''
    $size = $img.SelectSingleNode('one:Size', $ctx.Ns)
    if ($size) {
        $px = [math]::Round([double]::Parse($size.GetAttribute('width'), $Invariant) * 96 / 72)
        $style = " style=""width:${px}px"""
    }
    @{ Html = "<img src=""$name"" alt=""$(Enc $img.GetAttribute('alt'))""$style>"; Text = "[image: $name]" }
}

function Write-EmbeddedFile($ctx, $node) {
    $name = $node.GetAttribute('preferredName')
    if (-not $name -and $node.GetAttribute('pathSource')) { $name = [IO.Path]::GetFileName($node.GetAttribute('pathSource')) }
    if (-not $name) { $name = 'file' }
    $bytes = $null
    $cache = $node.GetAttribute('pathCache')
    if ($cache -and [IO.File]::Exists($cache)) { $bytes = [IO.File]::ReadAllBytes($cache) }
    else {
        $cb = $node.SelectSingleNode('one:CallbackID', $ctx.Ns)
        if ($cb -and $ctx.Binary.ContainsKey($cb.GetAttribute('callbackID'))) { $bytes = [Convert]::FromBase64String($ctx.Binary[$cb.GetAttribute('callbackID')]) }
    }
    if ($bytes) {
        $leaf = '{0:D2} {1}' -f ($ctx.Attachments.Count + 1), (Get-SafeName $name 80)
        $entry = "attachments/$leaf"
        $ctx.Attachments.Add([pscustomobject]@{ Name = $name; Path = $entry; Bytes = $bytes })
        $href = 'attachments/' + [Uri]::EscapeDataString($leaf)
        return @{ Html = "<a class=""file"" href=""$href"">&#x1F4CE; $(Enc $name)</a>"; Text = "[file: $entry]" }
    }
    @{ Html = "<span class=""file"">&#x1F4CE; $(Enc $name) <span class=""muted"">(not available)</span></span>"; Text = "[file: $name, not available]" }
}

function Write-Table($ctx, $table) {
    $cls = if ($table.GetAttribute('bordersVisible') -eq 'true') { ' class="bordered"' } else { '' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("<table$cls>")
    $lines = New-Object System.Collections.Generic.List[string]
    $saved = $ctx.Html
    $ctx.NoText = $ctx.NoText + 1
    try {
        foreach ($row in $table.SelectNodes('one:Row', $ctx.Ns)) {
            [void]$sb.Append('<tr>')
            $cells = New-Object System.Collections.Generic.List[string]
            foreach ($cell in $row.SelectNodes('one:Cell', $ctx.Ns)) {
                $ctx.Html = New-Object System.Text.StringBuilder
                $kids = $cell.SelectSingleNode('one:OEChildren', $ctx.Ns)
                if ($kids) { Write-OEChildren $ctx $kids 0 }
                $shade = $cell.GetAttribute('shadingColor')
                $style = if ($shade -match '^#[0-9A-Fa-f]{6}$') { " style=""background:$shade""" } else { '' }
                [void]$sb.Append("<td$style>" + $ctx.Html.ToString() + '</td>')
                $cells.Add((Get-PlainText $ctx $cell))
            }
            [void]$sb.Append('</tr>')
            $lines.Add('| ' + ($cells -join ' | ') + ' |')
        }
    }
    finally {
        $ctx.Html = $saved
        $ctx.NoText = $ctx.NoText - 1
    }
    [void]$sb.Append('</table>')
    @{ Html = $sb.ToString(); Lines = $lines }
}

function Write-OEChildren($ctx, $node, [int]$depth) {
    foreach ($oe in $node.SelectNodes('one:OE', $ctx.Ns)) { Write-OE $ctx $oe $depth }
}

function Write-OE($ctx, $oe, [int]$depth) {
    $marker = ''
    $num = $oe.SelectSingleNode('one:List/one:Number', $ctx.Ns)
    if ($num) { $marker = $num.GetAttribute('text') }
    elseif ($oe.SelectSingleNode('one:List/one:Bullet', $ctx.Ns)) { $marker = [string][char]0x2022 }

    $lineHtml = New-Object System.Text.StringBuilder
    $lineText = New-Object System.Collections.Generic.List[string]
    $blockHtml = New-Object System.Text.StringBuilder
    $blockText = New-Object System.Collections.Generic.List[string]
    if ($marker) { [void]$lineHtml.Append("<span class=""marker"">$(Enc $marker)</span>"); $lineText.Add($marker) }

    foreach ($tag in $oe.SelectNodes('one:Tag', $ctx.Ns)) {
        $def = $ctx.Tags[$tag.GetAttribute('index')]
        if ($tag.GetAttribute('completed') -eq 'true') {
            [void]$lineHtml.Append('<span class="check">&#x2611;</span>'); $lineText.Add('[x]')
        }
        elseif ($def -and $def.IsTodo) {
            [void]$lineHtml.Append('<span class="check">&#x2610;</span>'); $lineText.Add('[ ]')
        }
        else {
            $tagName = if ($def -and $def.Name) { $def.Name } else { 'Tag' }
            [void]$lineHtml.Append("<span class=""tag"">$(Enc $tagName)</span>"); $lineText.Add("[$tagName]")
        }
    }

    foreach ($child in $oe.ChildNodes) {
        switch -Wildcard ($child.LocalName) {
            'T' {
                [void]$lineHtml.Append((Get-SafeFragment $child.InnerText))
                $lineText.Add((ConvertTo-PlainText $child.InnerText))
            }
            'Image' {
                $r = Write-Image $ctx $child
                [void]$lineHtml.Append($r.Html); $lineText.Add($r.Text)
            }
            'Table' {
                $r = Write-Table $ctx $child
                [void]$blockHtml.Append($r.Html); $blockText.AddRange($r.Lines)
            }
            'InsertedFile' { $r = Write-EmbeddedFile $ctx $child; [void]$lineHtml.Append($r.Html); $lineText.Add($r.Text) }
            'MediaFile' { $r = Write-EmbeddedFile $ctx $child; [void]$lineHtml.Append($r.Html); $lineText.Add($r.Text) }
            'Ink*' { [void]$lineHtml.Append('<span class="muted">[handwriting]</span>'); $lineText.Add('[handwriting]') }
        }
    }

    $plain = ($lineText | Where-Object { $_ }) -join ' '
    if ($plain -or $blockText.Count -eq 0) { Add-TextLine $ctx $depth $plain }
    foreach ($l in $blockText) { Add-TextLine $ctx $depth $l }

    [void]$ctx.Html.Append('<div class="oe">')
    if ($lineHtml.Length -gt 0) { [void]$ctx.Html.Append('<div class="line">' + $lineHtml.ToString() + '</div>') }
    elseif ($blockHtml.Length -eq 0) { [void]$ctx.Html.Append('<div class="line"><br></div>') }
    [void]$ctx.Html.Append($blockHtml.ToString())
    $kids = $oe.SelectSingleNode('one:OEChildren', $ctx.Ns)
    if ($kids) {
        [void]$ctx.Html.Append('<div class="kids">')
        Write-OEChildren $ctx $kids ($depth + 1)
        [void]$ctx.Html.Append('</div>')
    }
    [void]$ctx.Html.Append('</div>')
}

function Write-PageBody($ctx, $page) {
    foreach ($child in $page.ChildNodes) {
        $r = $null
        switch -Wildcard ($child.LocalName) {
            'Outline' {
                $kids = $child.SelectSingleNode('one:OEChildren', $ctx.Ns)
                if ($kids) {
                    [void]$ctx.Html.Append('<section class="outline">')
                    Write-OEChildren $ctx $kids 0
                    [void]$ctx.Html.Append('</section>')
                    Add-TextLine $ctx 0 ''
                }
            }
            'Image' { $r = Write-Image $ctx $child }
            'InsertedFile' { $r = Write-EmbeddedFile $ctx $child }
            'MediaFile' { $r = Write-EmbeddedFile $ctx $child }
            'Ink*' { $r = @{ Html = '<span class="muted">[handwriting]</span>'; Text = '[handwriting]' } }
        }
        if ($r) {
            [void]$ctx.Html.Append('<section class="outline">' + $r.Html + '</section>')
            Add-TextLine $ctx 0 $r.Text
            Add-TextLine $ctx 0 ''
        }
    }
}

function Get-PageHtml([string]$title, [string[]]$crumbs, [string]$created, [string]$modified, [string]$body) {
    $crumbHtml = ($crumbs | ForEach-Object { Enc $_ }) -join ' &rsaquo; '
    @"
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="mnote $FormatVersion">
<title>$(Enc $title)</title>
<style>
  :root { --bg: #ffffff; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e1dfdd; --accent: #7719aa; --tag-bg: #f3e8fa; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Segoe UI", Calibri, Arial, sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
  .crumbs { color: var(--muted); font-size: 13px; }
  h1 { font-size: 26px; font-weight: 600; margin: 6px 0 4px; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 20px; }
  .outline + .outline { margin-top: 24px; }
  .line { min-height: 1.5em; overflow-wrap: anywhere; }
  .kids { margin-left: 1.6em; }
  .marker { display: inline-block; min-width: 1.4em; color: var(--muted); }
  .check { margin-right: .35em; }
  .tag { background: var(--tag-bg); color: var(--accent); border-radius: 4px; font-size: 11px; padding: 1px 6px; margin-right: .4em; }
  .muted { color: var(--muted); font-style: italic; }
  table { border-collapse: collapse; margin: 6px 0; max-width: 100%; }
  td { padding: 4px 8px; vertical-align: top; }
  table.bordered td { border: 1px solid var(--line); }
  img { max-width: 100%; height: auto; }
  a { color: var(--accent); }
  .file { display: inline-block; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; text-decoration: none; }
</style>
</head>
<body>
<main>
<div class="crumbs">$crumbHtml</div>
<h1>$(Enc $title)</h1>
<div class="meta">Created $(Format-Date $created) &middot; Modified $(Format-Date $modified)</div>
$body
</main>
</body>
</html>
"@
}

# ---------------------------------------------------------------- .mnote read / write

# $entries: list of @{ Name; Bytes; Store } written in order.
function Write-ZipEntries([IO.Stream]$stream, $entries) {
    $zip = New-Object System.IO.Compression.ZipArchive -ArgumentList $stream, ([System.IO.Compression.ZipArchiveMode]::Create), $true
    try {
        foreach ($e in $entries) {
            $level = if ($e.Store) { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
            $s = $zip.CreateEntry($e.Name, $level).Open()
            try { $s.Write($e.Bytes, 0, $e.Bytes.Length) } finally { $s.Dispose() }
        }
    }
    finally { $zip.Dispose() }
}

function Write-MnoteFile([string]$file, $entries) {
    if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
    $fs = [IO.File]::Open($file, [IO.FileMode]::CreateNew)
    try { Write-ZipEntries $fs $entries } finally { $fs.Dispose() }
}

function Get-ZipBytes($entries) {
    $ms = New-Object System.IO.MemoryStream
    Write-ZipEntries $ms $entries
    , $ms.ToArray()
}

function Read-EntryBytes($entry) {
    $ms = New-Object System.IO.MemoryStream
    $s = $entry.Open()
    try { $s.CopyTo($ms) } finally { $s.Dispose() }
    , $ms.ToArray()
}

# Already-compressed content (images, whole pages inside a notebook file) is not compressed again.
function Test-StoreEntry([string]$name) { $name -eq 'mimetype' -or $name -like 'images/*' -or $name -like '*.mnote' }

# Every entry of $zip in order, with $changes (name -> bytes, or $null to drop) applied;
# new names go at the end.
function Get-RebuiltEntries($zip, [hashtable]$changes) {
    $out = New-Object System.Collections.Generic.List[object]
    $done = @{}
    foreach ($e in $zip.Entries) {
        $name = $e.FullName
        # Plain assignments: "$x = if (...) { $bytes }" would unroll the byte array.
        if ($changes.ContainsKey($name)) { $done[$name] = $true; $bytes = $changes[$name] } else { $bytes = Read-EntryBytes $e }
        if ($null -ne $bytes) { $out.Add(@{ Name = $name; Bytes = $bytes; Store = (Test-StoreEntry $name) }) }
    }
    foreach ($k in $changes.Keys) {
        if (-not $done[$k] -and $null -ne $changes[$k]) { $out.Add(@{ Name = $k; Bytes = $changes[$k]; Store = (Test-StoreEntry $k) }) }
    }
    , $out
}

# Writes a temporary copy, then swaps it in, so a crash or power cut mid-save can never leave a
# half-written file behind. The file keeps its modified date (the page's own date).
function Save-ZipFile([string]$file, $entries) {
    $stamp = [IO.File]::GetLastWriteTimeUtc($file)
    $tmp = "$file.saving"
    try {
        Write-MnoteFile $tmp $entries
        # [NullString]: PowerShell would pass $null as "" (an illegal backup path).
        [IO.File]::Replace($tmp, $file, [NullString]::Value)
    }
    finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
    [IO.File]::SetLastWriteTimeUtc($file, $stamp)
}

function Read-ZipText($zip, [string]$name) {
    $e = $zip.GetEntry($name)
    if (-not $e) { return $null }
    $r = New-Object System.IO.StreamReader($e.Open(), $Utf8)
    try { $r.ReadToEnd() } finally { $r.Dispose() }
}

function Open-Mnote([string]$file) {
    if (-not $file) { throw "Give the .mnote file, e.g.  .\mnote.ps1 $Command "".\My Page.mnote""" }
    $full = (Resolve-Path -LiteralPath $file).ProviderPath
    try { $zip = [System.IO.Compression.ZipFile]::OpenRead($full) }
    catch { throw "'$file' is not an .mnote file." }
    if ((Read-ZipText $zip 'mimetype') -ne $MimeType) { $zip.Dispose(); throw "'$file' is not an .mnote file." }
    @{ Zip = $zip; Path = $full }
}

# A .mnotebook file holds a whole notebook: every page as its original .mnote file under
# pages/<section>/, and notebook.json with the notebook name and section / page order.
function Open-Notebook([string]$file) {
    if (-not $file) { throw "Give the .mnotebook file, e.g.  .\mnote.ps1 $Command "".\My Notebook.mnotebook""" }
    $full = (Resolve-Path -LiteralPath $file).ProviderPath
    try { $zip = [System.IO.Compression.ZipFile]::OpenRead($full) }
    catch { throw "'$file' is not an .mnotebook file." }
    if ((Read-ZipText $zip 'mimetype') -ne $NotebookMimeType) { $zip.Dispose(); throw "'$file' is not an .mnotebook file." }
    $info = $null
    try { $info = (Read-ZipText $zip 'notebook.json') | ConvertFrom-Json } catch { }
    @{ Zip = $zip; Path = $full; Info = $info }
}

# ---------------------------------------------------------------- export

function Get-Binary($on, [string]$pageId, [string]$callbackId) {
    [string]$b64 = ''
    try { $on.GetBinaryPageContent($pageId, $callbackId, [ref]$b64) } catch { }
    $b64
}

# Fetches every image / file the page refers to by callback ID. Images are written back into
# the XML as one:Data so page.onexml stays self-contained; files go to $binary.
# Returns how many objects could not be fetched.
function Resolve-BinaryData($on, [string]$pageId, $doc, $ns, $binary) {
    $pending = New-Object System.Collections.Generic.List[object]
    foreach ($cb in @($doc.SelectNodes('//one:CallbackID', $ns))) { $pending.Add($cb) }
    $shown = $false
    for ($try = 0; $pending.Count -gt 0 -and $try -le 15; $try++) {
        if ($try -gt 0) {
            if (-not $shown) {
                # Cloud notebooks download images only when the page is shown in OneNote.
                try { $on.NavigateTo($pageId, '', $false) } catch { }
                $shown = $true
            }
            Start-Sleep -Seconds 2
        }
        foreach ($cb in $pending.ToArray()) {
            $id = $cb.GetAttribute('callbackID')
            $b64 = Get-Binary $on $pageId $id
            if (-not $b64) { continue }
            if ($cb.ParentNode.LocalName -eq 'Image') {
                $data = $doc.CreateElement('one', 'Data', $OneNs)
                $data.InnerText = $b64
                [void]$cb.ParentNode.ReplaceChild($data, $cb)
            }
            else { $binary[$id] = $b64 }
            [void]$pending.Remove($cb)
        }
    }
    $pending.Count
}

function Export-Page($on, $item, [string]$outRoot, [string]$appVersion, $used) {
    $pageId = $item.Page.GetAttribute('ID')
    [string]$xml = ''
    try { $on.GetPageContent($pageId, [ref]$xml, $PiFileType, $Xs2013) }
    catch {
        # Cloud pages may still be downloading; give OneNote a moment and retry once.
        Start-Sleep -Seconds 3
        $on.GetPageContent($pageId, [ref]$xml, $PiFileType, $Xs2013)
    }
    $doc = New-Object System.Xml.XmlDocument
    $doc.LoadXml($xml)
    $ns = New-NsManager $doc
    $binary = @{}
    $missing = Resolve-BinaryData $on $pageId $doc $ns $binary

    $tags = @{}
    foreach ($d in $doc.DocumentElement.SelectNodes('one:TagDef', $ns)) {
        $tags[$d.GetAttribute('index')] = @{
            Name   = $d.GetAttribute('name')
            IsTodo = ($d.GetAttribute('symbol') -eq '3' -or $d.GetAttribute('name') -match $TodoPattern)
        }
    }
    $ctx = @{
        Ns = $ns; Tags = $tags; Binary = $binary; NoText = 0
        Html = New-Object System.Text.StringBuilder
        Text = New-Object System.Text.StringBuilder
        Images = New-Object System.Collections.Generic.List[object]
        Attachments = New-Object System.Collections.Generic.List[object]
    }
    Write-PageBody $ctx $doc.DocumentElement

    $title = $item.Title
    if (-not $title) { $title = 'Untitled' }
    $crumbs = @($item.Notebook.Name) + $item.Groups + @($item.Section)
    $created = $item.Page.GetAttribute('dateTime')
    $modified = $item.Page.GetAttribute('lastModifiedTime')

    $html = Get-PageHtml $title $crumbs $created $modified $ctx.Html.ToString()
    $text = "$title`r`n$($crumbs -join ' > ')`r`nCreated $(Format-Date $created)  Modified $(Format-Date $modified)`r`n" +
        ('-' * 60) + "`r`n`r`n" + $ctx.Text.ToString().TrimEnd() + "`r`n"

    $manifest = [ordered]@{
        format        = 'mnote'
        formatVersion = $FormatVersion
        title         = $title
        notebook      = $item.Notebook.Name
        sectionGroups = @($item.Groups)
        section       = $item.Section
        pageLevel     = [int]$item.Page.GetAttribute('pageLevel')
        created       = $created
        modified      = $modified
        exported      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        files         = [ordered]@{ html = 'page.html'; text = 'page.txt'; native = 'page.onexml' }
        images        = @($ctx.Images | ForEach-Object { $_.Name })
        attachments   = @($ctx.Attachments | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.Path } })
        source        = [ordered]@{
            app          = 'Microsoft OneNote'
            appVersion   = $appVersion
            pageId       = $pageId
            notebookPath = $item.Notebook.Path
        }
    }

    $entries = New-Object System.Collections.Generic.List[object]
    $entries.Add(@{ Name = 'mimetype'; Bytes = $Utf8.GetBytes($MimeType); Store = $true })
    $entries.Add(@{ Name = 'manifest.json'; Bytes = $Utf8.GetBytes(($manifest | ConvertTo-Json -Depth 6)) })
    $entries.Add(@{ Name = 'page.html'; Bytes = $Utf8.GetBytes($html) })
    $entries.Add(@{ Name = 'page.txt'; Bytes = $Utf8.GetBytes($text) })
    $entries.Add(@{ Name = 'page.onexml'; Bytes = $Utf8.GetBytes($doc.OuterXml) })
    foreach ($i in $ctx.Images) { $entries.Add(@{ Name = $i.Name; Bytes = $i.Bytes; Store = $true }) }
    foreach ($a in $ctx.Attachments) { $entries.Add(@{ Name = $a.Path; Bytes = $a.Bytes }) }

    # <out>\<notebook>\<section groups...>\<section>\NN <title>.mnote
    $dir = $outRoot
    foreach ($c in $crumbs) { $dir = Join-Path $dir (Get-SafeName $c) }
    [void][IO.Directory]::CreateDirectory($dir)
    $width = if ($item.Count -ge 100) { 3 } else { 2 }
    $prefix = $item.Index.ToString().PadLeft($width, '0') + ' '
    $room = 250 - $dir.Length - 1 - $prefix.Length - '.mnote'.Length - 4
    if ($room -lt 8) { throw "The output path is too long for Windows. Use a shorter -OutDir, e.g. C:\OneNoteExport." }
    $base = $prefix + (Get-SafeName $title ([math]::Min(60, $room)))
    $file = Join-Path $dir "$base.mnote"
    $k = 2
    while ($used.ContainsKey($file.ToLowerInvariant())) { $file = Join-Path $dir "$base ($k).mnote"; $k++ }
    $used[$file.ToLowerInvariant()] = $true

    # Keep highlights and notes made in the reader when a page is exported again; a page whose
    # text was edited in the reader is not replaced at all.
    if ([IO.File]::Exists($file)) {
        try {
            $oldMan = Get-ZipEntryBytes $file 'manifest.json'
            if ($oldMan -and ($Utf8.GetString($oldMan) | ConvertFrom-Json).editedInReader) {
                return [pscustomobject]@{ File = $file; Missing = 0; KeptEdited = $true }
            }
            $old = Get-ZipEntryBytes $file 'annotations.json'
            if ($old) { $entries.Add(@{ Name = 'annotations.json'; Bytes = $old }) }
        }
        catch { }
    }
    Write-MnoteFile $file $entries
    if ($modified) { [IO.File]::SetLastWriteTimeUtc($file, [DateTimeOffset]::Parse($modified, $Invariant).UtcDateTime) }
    [pscustomobject]@{ File = $file; Missing = $missing; KeptEdited = $false }
}

$NoNotebooksHelp = @'
OneNote has no notebooks open, so there is nothing to export.
  1. Start OneNote (the desktop app) and sign in with the Microsoft account that owns your notebooks.
  2. File > Open, and open each notebook you want to export.
  3. Wait until OneNote finishes syncing, then run this again.
'@

# library.json: notebook and section order for the reader. An order that is already there
# (set by hand, or kept from an earlier export) wins; new sections are added at the end.
function Save-LibraryOrder([string]$outRoot, $items) {
    $file = Join-Path $outRoot 'library.json'
    $order = [ordered]@{}
    if ([IO.File]::Exists($file)) {
        try { foreach ($nb in ([IO.File]::ReadAllText($file, $Utf8) | ConvertFrom-Json).notebooks) { $order[[string]$nb.name] = @($nb.sections) } } catch { }
    }
    foreach ($g in ($items | Group-Object { $_.Notebook.Name })) {
        $fresh = @($g.Group | ForEach-Object { $_.Location } | Select-Object -Unique)
        $old = @($order[$g.Name] | Where-Object { $_ })
        $order[$g.Name] = @($old | Where-Object { $fresh -contains $_ }) + @($fresh | Where-Object { $old -notcontains $_ })
    }
    $doc = [ordered]@{
        format    = 'mnote-library'
        version   = 1
        notebooks = @($order.Keys | ForEach-Object { [ordered]@{ name = $_; sections = @($order[$_]) } })
    }
    [IO.File]::WriteAllText($file, ($doc | ConvertTo-Json -Depth 5), $Utf8)
}

function Invoke-Export {
    $on = Get-OneNote
    $items = Get-PageList $on
    if ($items.Count -eq 0) {
        if ($Notebook) { Write-Host "No pages found in notebook(s): $($Notebook -join ', '). Run '.\mnote.ps1 list' to see names." }
        else { Write-Host $NoNotebooksHelp }
        return
    }

    $outRoot = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location).ProviderPath, $OutDir))
    $appVersion = ''
    try { $appVersion = (Get-Process ONENOTE -ErrorAction Stop | Select-Object -First 1).FileVersion } catch { }

    $used = @{}
    $failed = New-Object System.Collections.Generic.List[string]
    $incomplete = New-Object System.Collections.Generic.List[string]
    $keptEdited = New-Object System.Collections.Generic.List[string]
    $n = 0
    foreach ($item in $items) {
        $n++
        Write-Progress -Activity 'Exporting OneNote pages' -Status "$n of $($items.Count): $($item.Title)" -PercentComplete (100 * $n / $items.Count)
        try {
            $r = Export-Page $on $item $outRoot $appVersion $used
            if ($r.Missing) { $incomplete.Add("$($item.Notebook.Name) / $($item.Location) / $($item.Title): $($r.Missing) image(s) or file(s)") }
            if ($r.KeptEdited) { $keptEdited.Add("$($item.Notebook.Name) / $($item.Location) / $($item.Title)") }
        }
        catch { $failed.Add("$($item.Notebook.Name) / $($item.Location) / $($item.Title): $($_.Exception.Message) (mnote.ps1 line $($_.InvocationInfo.ScriptLineNumber))") }
    }
    Write-Progress -Activity 'Exporting OneNote pages' -Completed
    Save-LibraryOrder $outRoot $items

    $notebooks = @($items | ForEach-Object { $_.Notebook.Name } | Select-Object -Unique)
    Write-Host ("Exported {0} of {1} pages from {2} notebook(s) to:" -f ($items.Count - $failed.Count), $items.Count, $notebooks.Count)
    Write-Host "  $outRoot"
    if ($failed.Count) {
        Write-Warning "$($failed.Count) page(s) failed:"
        $failed | ForEach-Object { Write-Host "  $_" }
    }
    if ($keptEdited.Count) {
        Write-Host "$($keptEdited.Count) page(s) you edited in Mnote Reader were kept as they are (not replaced by OneNote's version):"
        $keptEdited | ForEach-Object { Write-Host "  $_" }
    }
    if ($incomplete.Count) {
        Write-Warning "$($incomplete.Count) page(s) were exported without some images or files that OneNote has not downloaded yet. Open those pages in OneNote, wait for them to load, then export again:"
        $incomplete | ForEach-Object { Write-Host "  $_" }
    }
}

function Invoke-List {
    $on = Get-OneNote
    $items = Get-PageList $on
    if ($items.Count -eq 0) { Write-Host $NoNotebooksHelp; return }
    foreach ($nb in ($items | Group-Object { $_.Notebook.Id })) {
        $first = $nb.Group[0].Notebook
        Write-Host "$($first.Name)  ($($nb.Count) pages)" -ForegroundColor Cyan
        Write-Host "  $($first.Path)" -ForegroundColor DarkGray
        foreach ($sec in ($nb.Group | Group-Object Location)) {
            Write-Host ("  {0,-50} {1,5} pages" -f $sec.Name, $sec.Count)
        }
    }
}

# ---------------------------------------------------------------- view / info

function Invoke-View {
    if ($Path -like '*.mnotebook') { Invoke-Read; return }
    $m = Open-Mnote $Path
    $m.Zip.Dispose()
    $md5 = [Security.Cryptography.MD5]::Create()
    $hash = -join ($md5.ComputeHash($Utf8.GetBytes($m.Path.ToLowerInvariant()))[0..5] | ForEach-Object { $_.ToString('x2') })
    $dest = Join-Path $env:TEMP "mnote-view\$hash"
    if ([IO.Directory]::Exists($dest)) { [IO.Directory]::Delete($dest, $true) }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($m.Path, $dest)
    Start-Process -FilePath (Join-Path $dest 'page.html')
}

function Show-NotebookInfo {
    $nbf = Open-Notebook $Path
    try {
        $info = $nbf.Info
        $pages = @($nbf.Zip.Entries | Where-Object { $_.FullName -like 'pages/*.mnote' })
        $noted = 0
        foreach ($e in $pages) {
            $inner = New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new((Read-EntryBytes $e))), ([System.IO.Compression.ZipArchiveMode]::Read)
            try { if ($inner.GetEntry('annotations.json')) { $noted++ } } finally { $inner.Dispose() }
        }
        Write-Host $info.name -ForegroundColor Cyan
        Write-Host "  Packed:      $(Format-Date $info.packed)"
        Write-Host "  Pages:       $($pages.Count) in $(@($info.sections).Count) sections ($noted with highlights or notes)"
        Write-Host "  Size:        $([math]::Round((Get-Item -LiteralPath $nbf.Path).Length / 1KB)) KB"
        Write-Host ''
        foreach ($s in $info.sections) { Write-Host ("  {0,-50} {1,4} pages" -f $s.location, @($s.pages).Count) }
    }
    finally { $nbf.Zip.Dispose() }
}

function Invoke-Info {
    if ($Path -like '*.mnotebook') { Show-NotebookInfo; return }
    $m = Open-Mnote $Path
    try {
        $man = (Read-ZipText $m.Zip 'manifest.json') | ConvertFrom-Json
        $text = Read-ZipText $m.Zip 'page.txt'
    }
    finally { $m.Zip.Dispose() }
    $where = (@($man.notebook) + @($man.sectionGroups) + @($man.section)) -join ' > '
    Write-Host $man.title -ForegroundColor Cyan
    Write-Host "  Location:    $where"
    Write-Host "  Created:     $(Format-Date $man.created)"
    Write-Host "  Modified:    $(Format-Date $man.modified)"
    Write-Host "  Exported:    $(Format-Date $man.exported)"
    Write-Host "  Images:      $(@($man.images).Count)"
    Write-Host "  Attachments: $(@($man.attachments).Count)"
    Write-Host ''
    $body = ($text -split "`r?`n") | Select-Object -Skip 5 -First 25
    $body | ForEach-Object { Write-Host "  $_" }
}

# ---------------------------------------------------------------- notebook files

function Get-Sha256([byte[]]$bytes) { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) }

# Notebook folder -> <folder>.mnotebook. Every page goes in unchanged; the file is read back and
# checked page by page before it replaces anything.
function Invoke-Pack {
    if (-not $Path) { throw 'Give the notebook folder, e.g.  .\mnote.ps1 pack ".\OneNote Export\My Notebook"' }
    $dir = (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\')
    if (-not [IO.Directory]::Exists($dir)) { throw "Not a folder: $dir" }
    $files = @([IO.Directory]::GetFiles($dir, '*.mnote', [IO.SearchOption]::AllDirectories) | Sort-Object)
    if (-not $files.Count) { throw "There are no .mnote files in $dir" }

    $pages = foreach ($f in $files) {
        $m = Open-Mnote $f
        try { $man = (Read-ZipText $m.Zip 'manifest.json') | ConvertFrom-Json } finally { $m.Zip.Dispose() }
        $groups = @($man.sectionGroups | Where-Object { $_ })
        [pscustomobject]@{
            File     = $f
            Inner    = 'pages/' + $f.Substring($dir.Length + 1).Replace('\', '/')
            Notebook = [string]$man.notebook
            Location = (@($groups) + @([string]$man.section)) -join ' / '
            Modified = [string]$man.modified
            Edited   = [bool]$man.editedInReader
        }
    }
    $names = @($pages | ForEach-Object { $_.Notebook } | Select-Object -Unique)
    if ($names.Count -ne 1) { throw "These pages come from more than one notebook: $($names -join ', ')" }
    $name = $names[0]

    # Section order: the export folder's library.json (OneNote's order), then the rest A-Z.
    $known = @()
    $libFile = Join-Path ([IO.Path]::GetDirectoryName($dir)) 'library.json'
    if ([IO.File]::Exists($libFile)) {
        try { foreach ($nb in ([IO.File]::ReadAllText($libFile, $Utf8) | ConvertFrom-Json).notebooks) { if ($nb.name -eq $name) { $known = @($nb.sections) } } } catch { }
    }
    $locs = @($pages | ForEach-Object { $_.Location } | Select-Object -Unique)
    $sorted = @($known | Where-Object { $locs -contains $_ }) + @($locs | Sort-Object | Where-Object { $known -notcontains $_ })

    # Highlights and notes in an earlier notebook file carry over to pages that have none.
    $target = "$dir.mnotebook"
    # Pages whose text was edited in the reader are kept whole from the earlier file.
    $oldAnn = @{}
    $oldEdited = @{}
    if ([IO.File]::Exists($target)) {
        $old = Open-Notebook $target
        try {
            foreach ($e in $old.Zip.Entries) {
                if ($e.FullName -notlike 'pages/*.mnote') { continue }
                $pb = Read-EntryBytes $e
                $inner = New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new($pb)), ([System.IO.Compression.ZipArchiveMode]::Read)
                try {
                    $a = $inner.GetEntry('annotations.json')
                    if ($a) { $oldAnn[$e.FullName] = Read-EntryBytes $a }
                    $mj = Read-ZipText $inner 'manifest.json'
                    if ($mj -and ($mj | ConvertFrom-Json).editedInReader) { $oldEdited[$e.FullName] = $pb }
                }
                finally { $inner.Dispose() }
            }
        }
        finally { $old.Zip.Dispose() }
    }
    $keptEdited = 0

    # @(): with one section, a bare dictionary would be looped over key by key.
    $sections = @(foreach ($loc in $sorted) {
            [ordered]@{ location = $loc; pages = @($pages | Where-Object { $_.Location -eq $loc } | Sort-Object Inner | ForEach-Object { $_.Inner }) }
        })
    $info = [ordered]@{ format = 'mnotebook'; formatVersion = 1; name = $name; packed = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); sections = @($sections) }

    $entries = New-Object System.Collections.Generic.List[object]
    $entries.Add(@{ Name = 'mimetype'; Bytes = $Utf8.GetBytes($NotebookMimeType); Store = $true })
    $entries.Add(@{ Name = 'notebook.json'; Bytes = $Utf8.GetBytes(($info | ConvertTo-Json -Depth 5)) })
    $expected = [ordered]@{}
    $carried = 0
    foreach ($s in $sections) {
        foreach ($innerName in $s.pages) {
            $p = $pages | Where-Object { $_.Inner -eq $innerName } | Select-Object -First 1
            $bytes = [IO.File]::ReadAllBytes($p.File)
            if ($oldEdited.ContainsKey($innerName) -and -not $p.Edited) {
                $bytes = $oldEdited[$innerName]
                $keptEdited++
            }
            elseif ($oldAnn.ContainsKey($innerName)) {
                $z = New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new($bytes)), ([System.IO.Compression.ZipArchiveMode]::Read)
                try {
                    if (-not $z.GetEntry('annotations.json')) {
                        $bytes = Get-ZipBytes (Get-RebuiltEntries $z @{ 'annotations.json' = $oldAnn[$innerName] })
                        $carried++
                    }
                }
                finally { $z.Dispose() }
            }
            $expected[$innerName] = Get-Sha256 $bytes
            $entries.Add(@{ Name = $innerName; Bytes = $bytes; Store = $true })
        }
    }

    $tmp = "$target.packing"
    try {
        Write-MnoteFile $tmp $entries
        # Read every page back and compare it with what went in.
        $check = Open-Notebook $tmp
        try {
            foreach ($k in $expected.Keys) {
                $e = $check.Zip.GetEntry($k)
                if (-not $e -or (Get-Sha256 (Read-EntryBytes $e)) -ne $expected[$k]) { throw "Check failed for $k; nothing was changed." }
            }
        }
        finally { $check.Zip.Dispose() }
        if ([IO.File]::Exists($target)) { [IO.File]::Replace($tmp, $target, [NullString]::Value) } else { [IO.File]::Move($tmp, $target) }
    }
    finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
    $latest = @($pages | Where-Object { $_.Modified } | ForEach-Object { [DateTimeOffset]::Parse($_.Modified, $Invariant).UtcDateTime } | Sort-Object)[-1]
    if ($latest) { [IO.File]::SetLastWriteTimeUtc($target, $latest) }

    Write-Host "Packed $($expected.Count) pages in $($sections.Count) sections into:"
    Write-Host "  $target"
    Write-Host "Every page was read back and matches the original."
    if ($carried) { Write-Host "Carried over highlights and notes for $carried page(s) from the earlier notebook file." }
    if ($keptEdited) { Write-Host "Kept $keptEdited page(s) you edited in Mnote Reader from the earlier notebook file." }
    if ($RemoveFolder) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($dir, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
        Write-Host "Moved the folder to the Recycle Bin: $dir"
    }
}

# .mnotebook -> a folder of .mnote files next to it (the notebook file is kept).
function Invoke-Unpack {
    $nbf = Open-Notebook $Path
    try {
        $out = Join-Path ([IO.Path]::GetDirectoryName($nbf.Path)) ([IO.Path]::GetFileNameWithoutExtension($nbf.Path))
        if ([IO.Directory]::Exists($out)) { throw "A folder with that name already exists: $out" }
        $n = 0
        foreach ($e in $nbf.Zip.Entries) {
            if ($e.FullName -notlike 'pages/*.mnote') { continue }
            $dest = [IO.Path]::GetFullPath((Join-Path $out ($e.FullName.Substring(6).Replace('/', '\'))))
            if (-not $dest.StartsWith($out + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe page path in the notebook file: $($e.FullName)" }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
            $bytes = Read-EntryBytes $e
            [IO.File]::WriteAllBytes($dest, $bytes)
            $z = New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new($bytes)), ([System.IO.Compression.ZipArchiveMode]::Read)
            try { $mod = ((Read-ZipText $z 'manifest.json') | ConvertFrom-Json).modified } finally { $z.Dispose() }
            if ($mod) { [IO.File]::SetLastWriteTimeUtc($dest, [DateTimeOffset]::Parse($mod, $Invariant).UtcDateTime) }
            $n++
        }
    }
    finally { $nbf.Zip.Dispose() }
    Write-Host "Unpacked $n pages to: $out (the .mnotebook file was kept)"
}

# ---------------------------------------------------------------- reader
# 'read' serves mnote-reader.html and the library on http://localhost, only to callers that
# know a random per-run token, and saves highlights and notes into each file's annotations.json.

$ReaderLock = Join-Path $env:TEMP 'mnote-reader.json'
$ReaderEntries = '^(page\.(html|txt)|manifest\.json|annotations\.json|(images|attachments)/[^/\\]+)$'

function Get-ZipEntryBytes([string]$file, [string]$name) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($file)
    try {
        $e = $zip.GetEntry($name)
        if (-not $e) { return $null }
        $ms = New-Object System.IO.MemoryStream
        $s = $e.Open()
        try { $s.CopyTo($ms) } finally { $s.Dispose() }
        , $ms.ToArray()
    }
    finally { $zip.Dispose() }
}

# A page is either its own .mnote file (Inner = $null) or a .mnote inside a .mnotebook file
# (Inner = "pages/<section>/<page>.mnote").
function Open-PageZip($ref) {
    if (-not $ref.Inner) { return [System.IO.Compression.ZipFile]::OpenRead($ref.File) }
    $bytes = Get-ZipEntryBytes $ref.File $ref.Inner
    if ($null -eq $bytes) { throw "Page not found: $($ref.Inner)" }
    New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new($bytes)), ([System.IO.Compression.ZipArchiveMode]::Read)
}

# Replaces entries of one page ($changes: name -> bytes), in its own file or inside a notebook file.
function Update-Page($ref, [hashtable]$changes) {
    if (-not $ref.Inner) {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($ref.File)
        try { $entries = Get-RebuiltEntries $zip $changes } finally { $zip.Dispose() }
        Save-ZipFile $ref.File $entries
        return
    }
    # Rebuild the page, then the notebook file around it.
    $page = Open-PageZip $ref
    try { $pageBytes = Get-ZipBytes (Get-RebuiltEntries $page $changes) } finally { $page.Dispose() }
    $outer = @{}
    $outer[$ref.Inner] = $pageBytes
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ref.File)
    try { $entries = Get-RebuiltEntries $zip $outer } finally { $zip.Dispose() }
    Save-ZipFile $ref.File $entries
}

function Write-Annotations($ref, [string]$json) {
    Update-Page $ref @{ 'annotations.json' = $Utf8.GetBytes($json) }
}

# Text edited in the reader: new page.html, page.txt and title. page.onexml stays OneNote's
# original, and manifest.editedInReader marks the page so a new export won't overwrite it.
function Write-PageEdit($ref, [string]$title, [string]$bodyHtml, [string]$text) {
    $zip = Open-PageZip $ref
    try { $man = (Read-ZipText $zip 'manifest.json') | ConvertFrom-Json } finally { $zip.Dispose() }
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $title = $title.Trim()
    if (-not $title) { $title = 'Untitled' }
    $man.title = $title
    $man.modified = $now
    $man | Add-Member -NotePropertyName editedInReader -NotePropertyValue $now -Force
    $crumbs = @([string]$man.notebook) + @($man.sectionGroups | Where-Object { $_ }) + @([string]$man.section)
    $html = Get-PageHtml $title $crumbs $man.created $man.modified $bodyHtml
    $txt = "$title`r`n$($crumbs -join ' > ')`r`nCreated $(Format-Date $man.created)  Modified $(Format-Date $man.modified)`r`n" +
        ('-' * 60) + "`r`n`r`n" + ($text -replace "`r?`n", "`r`n").TrimEnd() + "`r`n"
    Update-Page $ref @{
        'manifest.json' = $Utf8.GetBytes(($man | ConvertTo-Json -Depth 6))
        'page.html'     = $Utf8.GetBytes($html)
        'page.txt'      = $Utf8.GetBytes($txt)
    }
    $man
}

# What 'read' should show: a .mnotebook file on its own, or the folder holding the notebooks
# (found from a .mnote file inside it, or given directly).
function Resolve-Library([string]$p) {
    if (-not $p) { $p = [IO.Path]::Combine((Get-Location).ProviderPath, $OutDir) }
    $full = (Resolve-Path -LiteralPath $p).ProviderPath.TrimEnd('\')
    if (-not [IO.File]::Exists($full)) { return @{ Root = $full; Only = $null; Open = $null; Key = $full } }
    if ($full -like '*.mnotebook') {
        $b = Open-Notebook $full
        $b.Zip.Dispose()
        return @{ Root = [IO.Path]::GetDirectoryName($full).TrimEnd('\'); Only = $full; Open = $null; Key = $full }
    }
    $m = Open-Mnote $full
    try { $man = (Read-ZipText $m.Zip 'manifest.json') | ConvertFrom-Json } finally { $m.Zip.Dispose() }
    # <root>\<notebook>\<section groups...>\<section>\<page>.mnote
    $dir = [IO.Path]::GetDirectoryName($full)
    $up = @($man.sectionGroups | Where-Object { $_ }).Count + 2
    for ($i = 0; $i -lt $up -and [IO.Path]::GetDirectoryName($dir); $i++) { $dir = [IO.Path]::GetDirectoryName($dir) }
    $dir = $dir.TrimEnd('\')
    @{ Root = $dir; Only = $null; Open = $full; Key = $dir }
}

function Add-LibraryPage($pages, $zip, [string]$path, [string]$leaf) {
    if ((Read-ZipText $zip 'mimetype') -ne $MimeType) { return }
    $man = (Read-ZipText $zip 'manifest.json') | ConvertFrom-Json
    $groups = @($man.sectionGroups | Where-Object { $_ })
    $pages.Add([pscustomobject]@{
            Notebook = [string]$man.notebook
            Section  = [string]$man.section
            Location = (@($groups) + @([string]$man.section)) -join ' / '
            Leaf     = $leaf
            Page     = [ordered]@{
                path     = $path
                id       = [string]$man.source.pageId
                title    = [string]$man.title
                created  = [string]$man.created
                modified = [string]$man.modified
                level    = [int]$man.pageLevel
                images   = @($man.images | Where-Object { $_ }).Count
                edited   = [string]$man.editedInReader
                ann      = (Read-ZipText $zip 'annotations.json')
            }
        })
}

function Get-LibraryJson([string]$root, [string]$only) {
    $order = @{}
    $nbOrder = New-Object System.Collections.Generic.List[string]
    $orderFile = Join-Path $root 'library.json'
    if (-not $only -and [IO.File]::Exists($orderFile)) {
        try {
            foreach ($nb in ([IO.File]::ReadAllText($orderFile, $Utf8) | ConvertFrom-Json).notebooks) {
                $nbOrder.Add([string]$nb.name); $order[[string]$nb.name] = @($nb.sections)
            }
        }
        catch { }
    }

    $pages = New-Object System.Collections.Generic.List[object]
    $loose = if ($only) { @() } else { [IO.Directory]::GetFiles($root, '*.mnote', [IO.SearchOption]::AllDirectories) }
    foreach ($f in $loose) {
        $rel = $f.Substring($root.Length + 1).Replace('\', '/')
        try {
            $zip = [System.IO.Compression.ZipFile]::OpenRead($f)
            try { Add-LibraryPage $pages $zip $rel ([IO.Path]::GetFileName($f)) }
            finally { $zip.Dispose() }
        }
        catch { }
    }

    # Notebook files: their pages are addressed as "<file>::pages/<section>/<page>.mnote",
    # and their own notebook.json gives the section order.
    $bundles = if ($only) { @($only) } else { [IO.Directory]::GetFiles($root, '*.mnotebook', [IO.SearchOption]::AllDirectories) }
    foreach ($b in $bundles) {
        try {
            $nbf = Open-Notebook $b
            try {
                $rel = $b.Substring($root.Length + 1).Replace('\', '/')
                if ($nbf.Info.name -and $nbf.Info.sections) { $order[[string]$nbf.Info.name] = @($nbf.Info.sections | ForEach-Object { $_.location }) }
                foreach ($e in $nbf.Zip.Entries) {
                    if ($e.FullName -notlike 'pages/*.mnote') { continue }
                    $inner = New-Object System.IO.Compression.ZipArchive -ArgumentList ([System.IO.MemoryStream]::new((Read-EntryBytes $e))), ([System.IO.Compression.ZipArchiveMode]::Read)
                    try { Add-LibraryPage $pages $inner ($rel + '::' + $e.FullName) $e.FullName } finally { $inner.Dispose() }
                }
            }
            finally { $nbf.Zip.Dispose() }
        }
        catch { }
    }

    $names = @($pages | ForEach-Object { $_.Notebook } | Select-Object -Unique)
    $nbNames = @($nbOrder | Where-Object { $names -contains $_ }) + @($names | Sort-Object | Where-Object { $nbOrder -notcontains $_ })
    $notebooks = foreach ($nb in $nbNames) {
        $mine = @($pages | Where-Object { $_.Notebook -eq $nb })
        $locs = @($mine | ForEach-Object { $_.Location } | Select-Object -Unique)
        $known = @($order[$nb] | Where-Object { $_ })
        $sorted = @($known | Where-Object { $locs -contains $_ }) + @($locs | Sort-Object | Where-Object { $known -notcontains $_ })
        $sections = foreach ($loc in $sorted) {
            $sp = @($mine | Where-Object { $_.Location -eq $loc } | Sort-Object Leaf)
            [ordered]@{ name = $sp[0].Section; location = $loc; pages = @($sp | ForEach-Object { $_.Page }) }
        }
        [ordered]@{ name = $nb; sections = @($sections) }
    }
    [ordered]@{ format = 'mnote-library'; root = $root; notebooks = @($notebooks) } | ConvertTo-Json -Depth 8 -Compress
}

function Send-Bytes($ctx, [int]$status, [byte[]]$bytes, [string]$type, [string]$cache = 'no-store') {
    $r = $ctx.Response
    $r.StatusCode = $status
    $r.ContentType = $type
    $r.Headers['Cache-Control'] = $cache
    $r.Headers['X-Content-Type-Options'] = 'nosniff'
    $r.ContentLength64 = $bytes.Length
    $r.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Text($ctx, [int]$status, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
    Send-Bytes $ctx $status $Utf8.GetBytes($text) $type
}

function Get-Query([Uri]$url) {
    $q = @{}
    foreach ($pair in $url.Query.TrimStart('?').Split('&')) {
        if (-not $pair) { continue }
        $kv = $pair.Split(@('='), 2, [StringSplitOptions]::None)
        $value = if ($kv.Count -gt 1) { [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) } else { '' }
        $q[[Uri]::UnescapeDataString($kv[0])] = $value
    }
    $q
}

# A library-relative path from the browser -> page reference inside the library, or $null.
# "Notebook/Section/01 Page.mnote" is a file; "Notebook.mnotebook::pages/Section/01 Page.mnote"
# is a page inside a notebook file.
function Resolve-PagePath($state, [string]$rel) {
    if (-not $rel) { return $null }
    $inner = $null
    $cut = $rel.IndexOf('::')
    if ($cut -ge 0) {
        $inner = $rel.Substring($cut + 2)
        $rel = $rel.Substring(0, $cut)
        if ($inner -notmatch '^pages/[^\\]+\.mnote$' -or $inner -match '(^|/)\.\.(/|$)') { return $null }
    }
    try { $full = [IO.Path]::GetFullPath([IO.Path]::Combine($state.Root, $rel.Replace('/', '\'))) } catch { return $null }
    if (-not $full.StartsWith($state.Root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $ext = if ($inner) { '.mnotebook' } else { '.mnote' }
    if (-not $full.EndsWith($ext, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($full)) { return $null }
    if ($state.Only -and $full -ne $state.Only) { return $null }
    @{ File = $full; Inner = $inner }
}

function Get-PageEntryBytes($ref, [string]$name) {
    try { $zip = Open-PageZip $ref } catch { return $null }
    try {
        $e = $zip.GetEntry($name)
        if (-not $e) { return $null }
        , (Read-EntryBytes $e)
    }
    finally { $zip.Dispose() }
}

function Get-ContentType([string]$name) {
    switch -Regex ([IO.Path]::GetExtension($name).ToLowerInvariant()) {
        '^\.png$' { return 'image/png' }
        '^\.jpe?g$' { return 'image/jpeg' }
        '^\.gif$' { return 'image/gif' }
        '^\.bmp$' { return 'image/bmp' }
        '^\.html?$' { return 'text/html; charset=utf-8' }
        '^\.txt$' { return 'text/plain; charset=utf-8' }
        '^\.json$' { return 'application/json; charset=utf-8' }
        '^\.pdf$' { return 'application/pdf' }
    }
    'application/octet-stream'
}

function Invoke-ReaderRequest($ctx, $state) {
    $req = $ctx.Request
    # Only answer requests addressed to this machine by name (defends against DNS rebinding).
    if (@('localhost', '127.0.0.1') -notcontains $req.Url.Host) { Send-Text $ctx 403 'Forbidden'; return }
    $route = $req.Url.AbsolutePath
    if ($route -eq '/' -or $route -eq '/index.html') {
        # The page gets this run's token, so a plain http://localhost:<port>/ works. Other
        # websites cannot read this response (no CORS) or frame it, and the Host check above
        # stops DNS rebinding, so only this machine's reader window ever sees the token.
        $html = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mnote-reader.html'), $Utf8).Replace('__MNOTE_TOKEN__', $state.Token)
        $ctx.Response.Headers['X-Frame-Options'] = 'DENY'
        $ctx.Response.Headers['Content-Security-Policy'] = "frame-ancestors 'none'"
        Send-Bytes $ctx 200 $Utf8.GetBytes($html) 'text/html; charset=utf-8'
        return
    }

    $q = Get-Query $req.Url
    $token = $req.Headers['X-Mnote-Token']
    if (-not $token) { $token = $q['t'] }
    if ($token -ne $state.Token) { Send-Text $ctx 401 'Unauthorized'; return }

    switch ($route) {
        '/api/ping' { Send-Text $ctx 200 'ok' }
        '/api/library' { Send-Text $ctx 200 (Get-LibraryJson $state.Root $state.Only) 'application/json; charset=utf-8' }
        '/api/entry' {
            $ref = Resolve-PagePath $state $q['path']
            $name = [string]$q['name']
            if (-not $ref -or $name -notmatch $ReaderEntries) { Send-Text $ctx 404 'Not found'; return }
            $bytes = Get-PageEntryBytes $ref $name
            if ($null -eq $bytes) { Send-Text $ctx 404 'Not found'; return }
            # Images never change once exported; caching them stops pages flickering on redraw.
            $cache = if ($name -like 'images/*') { 'private, max-age=86400' } else { 'no-store' }
            Send-Bytes $ctx 200 $bytes (Get-ContentType $name) $cache
        }
        '/api/annotations' {
            if ($req.HttpMethod -ne 'PUT') { Send-Text $ctx 405 'Use PUT'; return }
            $ref = Resolve-PagePath $state $q['path']
            if (-not $ref) { Send-Text $ctx 404 'Not found'; return }
            $reader = New-Object System.IO.StreamReader($req.InputStream, $Utf8)
            try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($json.Length -gt 2MB) { Send-Text $ctx 413 'Too large'; return }
            try { $parsed = $json | ConvertFrom-Json } catch { $parsed = $null }
            if (-not $parsed -or $parsed.format -ne 'mnote-annotations') { Send-Text $ctx 400 'Not mnote annotations'; return }
            Write-Annotations $ref $json
            Send-Text $ctx 200 'saved'
        }
        '/api/page' {
            if ($req.HttpMethod -ne 'PUT') { Send-Text $ctx 405 'Use PUT'; return }
            $ref = Resolve-PagePath $state $q['path']
            if (-not $ref) { Send-Text $ctx 404 'Not found'; return }
            $reader = New-Object System.IO.StreamReader($req.InputStream, $Utf8)
            try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($json.Length -gt 8MB) { Send-Text $ctx 413 'Too large'; return }
            try { $edit = $json | ConvertFrom-Json } catch { $edit = $null }
            if (-not $edit -or $edit.format -ne 'mnote-page-edit' -or $null -eq $edit.html) { Send-Text $ctx 400 'Not an mnote page edit'; return }
            $man = Write-PageEdit $ref ([string]$edit.title) ([string]$edit.html) ([string]$edit.text)
            Send-Text $ctx 200 (@{ title = $man.title; modified = $man.modified } | ConvertTo-Json -Compress) 'application/json; charset=utf-8'
        }
        default { Send-Text $ctx 404 'Not found' }
    }
}

# mnote.config.json (next to this script) remembers which browser the reader opens in.
function Get-ReaderConfig {
    $file = Join-Path $PSScriptRoot 'mnote.config.json'
    if ([IO.File]::Exists($file)) { try { return [IO.File]::ReadAllText($file, $Utf8) | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ browser = 'edge' }
}

function Find-Firefox {
    # Microsoft Store Firefox: its launcher alias keeps working across updates, unlike the
    # versioned package path that App Paths points to.
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\firefox.exe'
    if ([IO.File]::Exists($alias)) { return $alias }
    foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe') {
        try { $p = ([string](Get-Item $k -ErrorAction Stop).GetValue('')).Trim('"'); if ($p -and [IO.File]::Exists($p)) { return $p } } catch { }
    }
    foreach ($p in "$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe", "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe") {
        if ([IO.File]::Exists($p)) { return $p }
    }
    $null
}

$FirefoxProfile = Join-Path $env:LOCALAPPDATA 'Mnote\firefox-profile'

# A Firefox profile just for the reader, kept apart from normal browsing: no tabs, no address
# bar (userChrome.css), the normal Windows title bar, no first-run pages or default-browser
# prompts, and its own taskbar group.
function Initialize-FirefoxProfile {
    [void][IO.Directory]::CreateDirectory((Join-Path $FirefoxProfile 'chrome'))
    $prefs = [ordered]@{
        'toolkit.legacyUserProfileCustomizations.stylesheets' = 'true'
        'browser.tabs.inTitlebar'                             = '0'
        'browser.shell.checkDefaultBrowser'                   = 'false'
        'browser.aboutwelcome.enabled'                        = 'false'
        'browser.startup.homepage_override.mstone'            = '"ignore"'
        'startup.homepage_welcome_url'                        = '""'
        'startup.homepage_welcome_url.additional'             = '""'
        'startup.homepage_override_url'                       = '""'
        'browser.startup.page'                                = '0'
        'browser.newtabpage.enabled'                          = 'false'
        'datareporting.policy.dataSubmissionPolicyBypassNotification' = 'true'
        'datareporting.policy.firstRunURL'                    = '""'
        'toolkit.telemetry.reportingpolicy.firstRun'          = 'false'
        'browser.sessionstore.resume_from_crash'              = 'false'
        'browser.tabs.warnOnClose'                            = 'false'
        'browser.warnOnQuit'                                  = 'false'
        'browser.tabs.closeWindowWithLastTab'                 = 'true'
        'browser.toolbars.bookmarks.visibility'               = '"never"'
        'taskbar.grouping.useprofile'                         = 'true'
        'sidebar.revamp'                                      = 'false'
        'sidebar.verticalTabs'                                = 'false'
        'signon.rememberSignons'                              = 'false'
        'extensions.pocket.enabled'                           = 'false'
        'browser.translations.automaticallyPopup'             = 'false'
        'app.normandy.enabled'                                = 'false'
    }
    $userJs = "// Mnote Reader window. Written by mnote.ps1 install; edits here are overwritten.`r`n" +
        (($prefs.GetEnumerator() | ForEach-Object { "user_pref(`"$($_.Key)`", $($_.Value));" }) -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText((Join-Path $FirefoxProfile 'user.js'), $userJs, $Utf8)
    $css = @'
/* Mnote Reader window: just the reader, no tabs, address bar or bookmarks bar. */
#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-main { visibility: collapse !important; }
'@
    [IO.File]::WriteAllText((Join-Path $FirefoxProfile 'chrome\userChrome.css'), $css, $Utf8)
    # Open maximized the first time; after that Firefox remembers the window size.
    $xul = Join-Path $FirefoxProfile 'xulstore.json'
    if (-not [IO.File]::Exists($xul)) {
        [IO.File]::WriteAllText($xul, '{"chrome://browser/content/browser.xhtml":{"main-window":{"sizemode":"maximized"}}}', $Utf8)
    }
}

function Open-ReaderWindow([string]$url) {
    if ($NoBrowser) { return }
    if ((Get-ReaderConfig).browser -eq 'firefox') {
        $ff = Find-Firefox
        if ($ff) {
            if (-not [IO.File]::Exists((Join-Path $FirefoxProfile 'user.js'))) { Initialize-FirefoxProfile }
            # A running reader window with this profile receives the new window; otherwise it starts.
            Start-Process -FilePath $ff -ArgumentList '-profile', "`"$FirefoxProfile`"", '-new-window', "`"$url`""
            return
        }
    }
    # Edge's app mode gives the reader its own window, without tabs or an address bar.
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
    if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$url" }
    else { Start-Process $url }
}

function Invoke-Read {
    $lib = Resolve-Library $Path
    $root = $lib.Root
    if (-not [IO.Directory]::Exists($root)) { throw "Folder not found: $root" }
    $hash = ''
    if ($lib.Open) { $hash = '#open=' + [Uri]::EscapeDataString($lib.Open.Substring($root.Length + 1).Replace('\', '/')) }

    # A reader that is already running for this library just gets a new window.
    if (-not $Port -and [IO.File]::Exists($ReaderLock)) {
        try {
            $lock = [IO.File]::ReadAllText($ReaderLock, $Utf8) | ConvertFrom-Json
            if ($lock.root -eq $lib.Key) {
                $wc = New-Object System.Net.WebClient
                $wc.Headers['X-Mnote-Token'] = $lock.token
                if ($wc.DownloadString("http://localhost:$($lock.port)/api/ping") -eq 'ok') {
                    $url = "http://localhost:$($lock.port)/?t=$($lock.token)$hash"
                    Write-Host "Mnote Reader is already running: $url"
                    Open-ReaderWindow $url
                    return
                }
            }
        }
        catch { }
    }

    $listener = $null
    # Not $port: PowerShell names are case-insensitive, so that would hide the -Port parameter.
    $boundPort = 0
    $ports = if ($Port) { @($Port) } else { 47821..47860 }
    foreach ($p in $ports) {
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add("http://localhost:$p/")
        try { $l.Start(); $listener = $l; $boundPort = $p; break } catch { $l.Close() }
    }
    if (-not $listener) {
        if ($Port) { throw "Could not start the reader: port $Port is in use." }
        throw 'Could not start the reader: no free local port between 47821 and 47860.'
    }

    $token = [Guid]::NewGuid().ToString('N')
    $state = @{ Root = $root; Only = $lib.Only; Token = $token }
    # Only the shared instance is advertised to double-clicked files; a -Port instance stays private.
    if (-not $Port) {
        [IO.File]::WriteAllText($ReaderLock, (@{ port = $boundPort; token = $token; root = $lib.Key; pid = $PID } | ConvertTo-Json), $Utf8)
    }
    $url = "http://localhost:$boundPort/?t=$token$hash"
    Write-Host "Mnote Reader is running for: $($lib.Key)"
    Write-Host "  $url"
    Write-Host 'It stops by itself a few minutes after the reader window is closed.'
    Open-ReaderWindow $url

    try {
        $last = Get-Date
        $seen = $false
        while ($true) {
            $task = $listener.GetContextAsync()
            $stop = $false
            while (-not $task.Wait(1000)) {
                # The reader pings every 20 seconds while it is open.
                $limit = if ($seen) { 180 } else { 120 }
                if (((Get-Date) - $last).TotalSeconds -gt $limit) { $stop = $true; break }
            }
            if ($stop) { break }
            $ctx = $task.Result
            $last = Get-Date
            $seen = $true
            try { Invoke-ReaderRequest $ctx $state }
            catch { try { Send-Text $ctx 500 $_.Exception.Message } catch { } }
            finally { try { $ctx.Response.Close() } catch { } }
        }
    }
    finally {
        $listener.Close()
        try {
            $cur = [IO.File]::ReadAllText($ReaderLock, $Utf8) | ConvertFrom-Json
            if ($cur.token -eq $token) { [IO.File]::Delete($ReaderLock) }
        }
        catch { }
    }
}

# ---------------------------------------------------------------- install
# Per-user only (HKCU and the user's Start menu): no admin rights needed, nothing machine-wide.

$ClassesKey = 'HKCU:\Software\Classes'
$FileTypes = @(
    @{ Ext = '.mnote'; ProgId = 'Mnote.Page'; Name = 'OneNote page (Mnote)'; Mime = $MimeType; Icon = 'mnote.ico'; Stack = $false }
    @{ Ext = '.mnotebook'; ProgId = 'Mnote.Notebook'; Name = 'OneNote notebook (Mnote)'; Mime = $NotebookMimeType; Icon = 'mnotebook.ico'; Stack = $true }
)

function New-RoundRect([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90); $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
    $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90); $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $p.CloseFigure()
    $p
}

# A small icon (purple page with lines; with -Stack, a page with another behind it for a whole
# notebook) as a multi-size .ico built from PNG images.
function New-MnoteIcon([string]$file, [switch]$Stack) {
    Add-Type -AssemblyName System.Drawing
    $images = foreach ($s in 16, 24, 32, 48, 256) {
        $bmp = New-Object System.Drawing.Bitmap $s, $s
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::Transparent)
        $k = $s / 32.0
        $x = 5 * $k; $y = 2 * $k; $w = 22 * $k; $h = 28 * $k; $r = 4 * $k
        if ($Stack) {
            $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(186, 160, 235))), (New-RoundRect ($x + 4 * $k) $y ($w - 4 * $k) ($h - 4 * $k) $r))
            $x -= 1 * $k; $y += 4 * $k; $w -= 4 * $k; $h -= 4 * $k
        }
        $p = New-RoundRect $x $y $w $h $r
        $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(109, 63, 192))), $p)
        if ($Stack) { $k *= 0.86; $g.TranslateTransform(-1.5 * $s / 32.0, 4.5 * $s / 32.0) }
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([math]::Max(1.2, 2.6 * $k))
        $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawLine($pen, 10 * $k, 10 * $k, 22 * $k, 10 * $k)
        $g.DrawLine($pen, 10 * $k, 16 * $k, 22 * $k, 16 * $k)
        $g.DrawLine($pen, 10 * $k, 22 * $k, 17 * $k, 22 * $k)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
        [pscustomobject]@{ Size = $s; Bytes = $ms.ToArray() }
    }
    $out = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $out
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($i in $images) {
        $dim = if ($i.Size -ge 256) { 0 } else { $i.Size }
        $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$i.Bytes.Length); $bw.Write([uint32]$offset)
        $offset += $i.Bytes.Length
    }
    foreach ($i in $images) { $bw.Write($i.Bytes) }
    $bw.Flush()
    [IO.File]::WriteAllBytes($file, $out.ToArray())
}

function Send-AssocChanged {
    if (-not ('Mnote.Shell' -as [type])) {
        Add-Type -Namespace Mnote -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
    }
    [Mnote.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)   # SHCNE_ASSOCCHANGED
}

function Get-ShortcutPath { Join-Path ([Environment]::GetFolderPath('Programs')) 'Mnote Reader.lnk' }

function Invoke-Install {
    $script = Join-Path $PSScriptRoot 'mnote.ps1'
    if (-not [IO.File]::Exists((Join-Path $PSScriptRoot 'mnote-reader.html'))) { throw "mnote-reader.html must be next to mnote.ps1 in $PSScriptRoot" }
    $library = if ($Path) { (Resolve-Path -LiteralPath $Path).ProviderPath.TrimEnd('\') } else { [IO.Path]::Combine([Environment]::GetFolderPath('MyDocuments'), 'OneNote Export') }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    $cfg = Get-ReaderConfig
    if ($Browser) { $cfg.browser = $Browser }
    if ($cfg.browser -eq 'firefox') {
        if (-not (Find-Firefox)) { throw 'Firefox is not installed. Install it, or run install with -Browser edge.' }
        Initialize-FirefoxProfile
    }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'mnote.config.json'), ($cfg | ConvertTo-Json), $Utf8)

    # .mnote -> Mnote.Page, .mnotebook -> Mnote.Notebook; both open with "mnote.ps1 read <file>".
    foreach ($t in $FileTypes) {
        $icon = Join-Path $PSScriptRoot $t.Icon
        New-MnoteIcon $icon -Stack:$t.Stack

        $ext = "$ClassesKey\$($t.Ext)"
        New-Item -Path $ext -Force | Out-Null
        Set-Item -Path $ext -Value $t.ProgId
        Set-ItemProperty -Path $ext -Name 'Content Type' -Value $t.Mime
        New-Item -Path "$ext\OpenWithProgids" -Force | Out-Null
        New-ItemProperty -Path "$ext\OpenWithProgids" -Name $t.ProgId -Value '' -PropertyType String -Force | Out-Null

        $cls = "$ClassesKey\$($t.ProgId)"
        New-Item -Path "$cls\DefaultIcon" -Force | Out-Null
        New-Item -Path "$cls\shell\open\command" -Force | Out-Null
        Set-Item -Path $cls -Value $t.Name
        Set-ItemProperty -Path $cls -Name 'FriendlyTypeName' -Value $t.Name
        Set-Item -Path "$cls\DefaultIcon" -Value "`"$icon`",0"
        Set-Item -Path "$cls\shell\open" -Value 'Open in Mnote Reader'
        Set-ItemProperty -Path "$cls\shell\open" -Name 'FriendlyAppName' -Value 'Mnote Reader'
        Set-Item -Path "$cls\shell\open\command" -Value "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" read `"%1`""
    }
    Send-AssocChanged
    $icon = Join-Path $PSScriptRoot 'mnote.ico'

    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut((Get-ShortcutPath))
    $lnk.TargetPath = $ps
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" read `"$library`""
    $lnk.WorkingDirectory = $PSScriptRoot
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = 'Read your OneNote export with highlights and notes'
    $lnk.WindowStyle = 7
    $lnk.Save()

    Write-Host 'Mnote Reader is installed for your Windows account:'
    Write-Host '  - Double-clicking a .mnote page or a .mnotebook notebook opens it in the reader.'
    Write-Host "  - Start menu: 'Mnote Reader' opens $library"
    if ($cfg.browser -eq 'firefox') { Write-Host "  - It opens in its own Firefox window (separate profile: $FirefoxProfile)." }
    else { Write-Host '  - It opens in its own Microsoft Edge app window.' }
    foreach ($t in $FileTypes) {
        $choice = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$($t.Ext)\UserChoice"
        if (Test-Path $choice) {
            Write-Warning "Windows remembers another app you picked for $($t.Ext) files. Right-click one > Open with > Choose another app > Mnote Reader > Always."
        }
    }
}

function Invoke-Uninstall {
    foreach ($t in $FileTypes) {
        $ext = "$ClassesKey\$($t.Ext)"
        if ((Test-Path $ext) -and (Get-Item $ext).GetValue('') -eq $t.ProgId) { Remove-Item -Path $ext -Recurse -Force }
        if (Test-Path "$ClassesKey\$($t.ProgId)") { Remove-Item -Path "$ClassesKey\$($t.ProgId)" -Recurse -Force }
    }
    if ([IO.File]::Exists((Get-ShortcutPath))) { [IO.File]::Delete((Get-ShortcutPath)) }
    Send-AssocChanged
    Write-Host 'Removed the .mnote and .mnotebook file types and the Start menu shortcut. Your notes and these files were not touched.'
}

switch ($Command) {
    'list' { Invoke-List }
    'export' { Invoke-Export }
    'read' {
        try { Invoke-Read }
        catch {
            # Started by double-click there is no console, so say what went wrong in a dialog.
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show("Mnote Reader could not start:`n`n$($_.Exception.Message)", 'Mnote Reader', 'OK', 'Error')
            throw
        }
    }
    'view' { Invoke-View }
    'info' { Invoke-Info }
    'pack' { Invoke-Pack }
    'unpack' { Invoke-Unpack }
    'install' { Invoke-Install }
    'uninstall' { Invoke-Uninstall }
}
