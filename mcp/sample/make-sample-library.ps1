# Builds a fictional sample library for trying out the MCP server and for demos, in the same
# .mnote format the exporter writes (mimetype first, manifest.json, page.html, page.txt,
# page.onexml), with highlights, notes and a bookmark in annotations.json the way Mnote Reader
# saves them. Each notebook is then packed into a .mnotebook by mnote.ps1 itself.
# No real notes are used. It goes to %TEMP%\mnote-demo unless you pass -Out.
# Line syntax: "- " bullet, "1. " numbered, "[x] " / "[ ] " to-do, "> " indented, else plain.
param(
    [string]$Out = (Join-Path $env:TEMP 'mnote-demo'),
    [string]$Mnote = (Join-Path $PSScriptRoot '..\..\mnote.ps1')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$utf8 = New-Object Text.UTF8Encoding($false)
$bullet = [string][char]0x2022; $done = [string][char]0x2611; $todo = [string][char]0x2610

$books = [ordered]@{
  'Study notebook' = [ordered]@{
    'Getting started' = [ordered]@{
      'Welcome to the module' = @('This notebook collects my notes for the Cloud Foundations module.', '- Lectures on Monday, labs on Thursday', '- Weekly quiz opens every Friday', '- Final exam in week 12', '[x] Set up a free-tier account', '[x] Join the course forum', '[ ] Read chapter 1 before the first lab')
      'Course plan' = @('1. What the cloud is, and why it matters', '2. Pricing and the free tier', '3. Regions and availability zones', '4. Identity and access', '5. Networking basics', '6. Storage and databases', '7. Revision week')
      'Study tips' = @('Write one summary line per lecture.', '- Highlight definitions while reading', '- Turn every highlight into a question', '- Review the notes panel before each quiz')
    }
    'Cloud basics' = [ordered]@{
      'What is cloud computing?' = @('Cloud computing is the on-demand delivery of IT resources over the internet with pay-as-you-go pricing.', '- No up-front hardware to buy', '- Scale up or down in minutes', '- Go global in a few clicks', 'Three models: IaaS, PaaS and SaaS. Each one hands more of the stack to the provider.', '> IaaS: you rent servers, storage and networks', '> PaaS: you bring the code, the platform runs it', '> SaaS: you just use the finished software', 'Example: a results website that gets busy for one afternoon can add servers for those hours, then give them back.')
      'Cloud benefits' = @('Six advantages from the lecture:', '1. Trade fixed costs for variable costs', '2. Benefit from massive economies of scale', '3. Stop guessing capacity', '4. Increase speed and agility', '5. Stop running data centres', '6. Go global in minutes', 'Variable costs come from pay-as-you-go pricing.')
      'Pricing models' = @('Four pricing models to know for the quiz:', '- On-demand: pay by the second, no commitment', '- Reserved: commit for 1 or 3 years, pay less', '- Spot: spare capacity at a big discount, can be taken back', '- Savings plans: flexible pricing for steady use', 'Pricing calculator: estimate a monthly bill before building.')
      'Regions and zones' = @('A region is a geographic area with several availability zones.', '- Each zone is one or more separate data centres', '- Spread an app over two zones to survive an outage', 'Pick the region closest to your users.')
      'Shared responsibility' = @('The provider secures the cloud. You secure what you put in it.', '- Provider: buildings, hardware, network', '- You: data, accounts, settings, updates')
    }
    'Security' = [ordered]@{
      'Identity and access' = @('Give every person and app only the access it needs.', '- Users, groups and roles', '- Turn on multi-factor sign-in', '- Never share the root account')
      'Encryption basics' = @('Encrypt data at rest and in transit.', '- At rest: stored disks and backups', '- In transit: TLS between services')
    }
    'Revision' = [ordered]@{
      'Key terms' = @('Elasticity: growing and shrinking with demand.', 'On-demand pricing: pay only while it runs.', 'Availability zone: one or more separate data centres in a region.')
      'Exam checklist' = @('[x] Pricing models and when to use each', '[ ] Shared responsibility examples', '[ ] Draw a two-zone network from memory')
    }
  }
  'Economics' = [ordered]@{
    'Markets' = [ordered]@{
      'Pricing strategies' = @('Common pricing strategies:', '- Penetration pricing: start low to win customers', '- Skimming: start high, lower over time', '- Dynamic pricing: prices follow demand')
      'Supply and demand' = @('When demand rises and supply stays the same, prices go up.', '- Shortage: demand above supply', '- Surplus: supply above demand')
    }
  }
}

# Highlights made "in the reader": page title -> @(quote, colour, note). Quotes are exact words
# from the page; the study coach turns them into quiz questions.
$highlights = @{
  'What is cloud computing?' = @(
    @('on-demand delivery of IT resources over the internet with pay-as-you-go pricing', 'yellow', 'The definition. Learn it word for word.'),
    @('IaaS', 'green', ''),
    @('PaaS', 'green', ''))
  'Cloud benefits' = @(
    @('Trade fixed costs for variable costs', 'yellow', 'Benefit number 1, always comes up.'),
    @('Benefit from massive economies of scale', 'blue', ''))
  'Pricing models' = @(
    @('Spot', 'pink', 'Cheapest, but it can be taken back.'),
    @('commit for 1 or 3 years, pay less', 'yellow', 'Reserved'))
  'Regions and zones' = @(
    @('A region is a geographic area with several availability zones.', 'yellow', ''),
    @('Spread an app over two zones to survive an outage', 'pink', 'Exam favourite'))
  'Shared responsibility' = @(
    , @('The provider secures the cloud. You secure what you put in it.', 'yellow', ''))
  'Identity and access' = @(
    , @('Give every person and app only the access it needs.', 'yellow', 'This is called least privilege.'))
  'Encryption basics' = @(
    , @('TLS', 'blue', ''))
  'Key terms' = @(
    @('Elasticity', 'green', ''),
    @('Availability zone', 'green', ''))
  'Pricing strategies' = @(
    , @('Skimming', 'yellow', 'Like new phones at launch.'))
  'Supply and demand' = @(
    , @('When demand rises and supply stays the same, prices go up.', 'yellow', ''))
}
$pageNotes = @{ 'Study tips' = 'Ask the study coach to quiz me every evening.' }
$bookmarks = @('Exam checklist')

function Enc([string]$s) { [Net.WebUtility]::HtmlEncode($s) }

function Get-Annotations([string]$title, [string]$text, [datetime]$when) {
    # One-highlight pages are written @(, @(...)) so PowerShell keeps the list a list.
    # (A plain assignment: "$x = if ..." would unroll the list again.)
    $list = @()
    if ($highlights.ContainsKey($title)) { $list = $highlights[$title] }
    if ($list.Count -eq 0 -and -not $pageNotes[$title] -and $bookmarks -notcontains $title) { return $null }
    $stamp = $when.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $hs = foreach ($h in $list) {
        # Offsets count into the page body's text, as the reader sees it (see readerText).
        $start = $text.IndexOf($h[0], [StringComparison]::Ordinal)
        if ($start -lt 0) { throw "Highlight not found on '$title': $($h[0])" }
        $end = $start + $h[0].Length
        [ordered]@{
            id = 'h' + [guid]::NewGuid().ToString('N').Substring(0, 12); color = $h[1]; start = $start; end = $end; quote = $h[0]
            prefix = $text.Substring([math]::Max(0, $start - 32), $start - [math]::Max(0, $start - 32))
            suffix = $text.Substring($end, [math]::Min(32, $text.Length - $end))
            note = $h[2]; created = $stamp; updated = $stamp
        }
    }
    $doc = [ordered]@{ format = 'mnote-annotations'; version = 1; updated = $stamp; bookmark = ($bookmarks -contains $title); pageNote = [string]$pageNotes[$title]; highlights = @($hs) }
    $doc | ConvertTo-Json -Depth 5 -Compress
}

function New-Page([string]$dir, [int]$index, [string]$nb, [string]$sec, [string]$title, [string[]]$lines, [datetime]$created) {
    $html = New-Object Text.StringBuilder
    $text = New-Object Text.StringBuilder
    $body = New-Object Text.StringBuilder   # what the reader's page body shows as text
    [void]$html.Append('<section class="outline">')
    $inKids = $false
    foreach ($l in $lines) {
        $indent = $l.StartsWith('> ')
        if ($indent) { $l = $l.Substring(2) }
        if ($indent -and -not $inKids) { [void]$html.Append('<div class="kids">'); $inKids = $true }
        if (-not $indent -and $inKids) { [void]$html.Append('</div>'); $inKids = $false }
        if ($l.StartsWith('- ')) { $mark = $bullet; $rest = $l.Substring(2); $inner = "<span class=""marker"">$bullet</span>" + (Enc $rest); $plain = "$bullet " + $rest }
        elseif ($l -match '^(\d+)\. (.*)$') { $mark = "$($Matches[1])."; $rest = $Matches[2]; $inner = "<span class=""marker"">$mark</span>" + (Enc $rest); $plain = $l }
        elseif ($l.StartsWith('[x] ')) { $mark = $done; $rest = $l.Substring(4); $inner = "<span class=""check"">$done</span>" + (Enc $rest); $plain = '[x] ' + $rest }
        elseif ($l.StartsWith('[ ] ')) { $mark = $todo; $rest = $l.Substring(4); $inner = "<span class=""check"">$todo</span>" + (Enc $rest); $plain = '[ ] ' + $rest }
        else { $mark = ''; $rest = $l; $inner = Enc $l; $plain = $l }
        [void]$html.Append("<div class=""oe""><div class=""line"">$inner</div></div>")
        [void]$text.Append(('  ' * [int]$indent) + $plain + "`r`n")
        [void]$body.Append($mark + $rest)
    }
    if ($inKids) { [void]$html.Append('</div>') }
    [void]$html.Append('</section>')

    $c = $created.ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $m = $created.AddDays(2).ToString('yyyy-MM-ddTHH:mm:ss.000Z')
    $page = "<!DOCTYPE html>`n<html>`n<head>`n<meta charset=""utf-8"">`n<meta name=""generator"" content=""mnote 1"">`n<title>$(Enc $title)</title>`n</head>`n<body>`n<main>`n<div class=""crumbs"">$(Enc $nb) &rsaquo; $(Enc $sec)</div>`n<h1>$(Enc $title)</h1>`n<div class=""meta"">Created $($created.ToString('d MMM yyyy'))</div>`n$($html.ToString())`n</main>`n</body>`n</html>`n"
    $txt = "$title`r`n$nb > $sec`r`nCreated $($created.ToString('d MMM yyyy'))`r`n" + ('-' * 60) + "`r`n`r`n" + $text.ToString()
    $manifest = [ordered]@{
        format = 'mnote'; formatVersion = 1; title = $title; notebook = $nb; sectionGroups = @(); section = $sec; pageLevel = 1
        created = $c; modified = $m; exported = $m
        files = [ordered]@{ html = 'page.html'; text = 'page.txt'; native = 'page.onexml' }; images = @(); attachments = @()
        source = [ordered]@{ app = 'Microsoft OneNote'; appVersion = ''; pageId = "{sample-$nb-$sec-$index}"; notebookPath = '' }
    }
    $entries = @(
        @('mimetype', 'application/vnd.mnote+zip', $true), @('manifest.json', ($manifest | ConvertTo-Json -Depth 5), $false),
        @('page.html', $page, $false), @('page.txt', $txt, $false),
        @('page.onexml', "<one:Page xmlns:one=""http://schemas.microsoft.com/office/onenote/2013/onenote"" name=""$(Enc $title)""/>", $false))
    $ann = Get-Annotations $title $body.ToString() $created.AddDays(3)
    if ($ann) { $entries += , @('annotations.json', $ann, $false) }
    $file = Join-Path $dir ('{0:00} {1}.mnote' -f $index, ($title -replace '[\\/:*?"<>|]', ''))
    $zip = [IO.Compression.ZipFile]::Open($file, 'Create')
    try {
        foreach ($e in $entries) {
            $level = if ($e[2]) { 'NoCompression' } else { 'Optimal' }
            $s = $zip.CreateEntry($e[0], $level).Open(); $b = $utf8.GetBytes($e[1])
            try { $s.Write($b, 0, $b.Length) } finally { $s.Dispose() }
        }
    }
    finally { $zip.Dispose() }
}

if ([IO.Directory]::Exists($Out)) { [IO.Directory]::Delete($Out, $true) }
[void][IO.Directory]::CreateDirectory($Out)
# The export writes OneNote's notebook and section order here; pack and the reader both use it.
$lib = [ordered]@{ format = 'mnote-library'; version = 1; notebooks = @($books.Keys | ForEach-Object { [ordered]@{ name = $_; sections = @($books[$_].Keys) } }) }
[IO.File]::WriteAllText((Join-Path $Out 'library.json'), ($lib | ConvertTo-Json -Depth 4), $utf8)
$day = [datetime]'2026-09-28T09:00:00'
foreach ($nb in $books.Keys) {
    foreach ($sec in $books[$nb].Keys) {
        $dir = Join-Path (Join-Path $Out $nb) $sec
        [void][IO.Directory]::CreateDirectory($dir)
        $i = 0
        foreach ($title in $books[$nb][$sec].Keys) { $i++; $day = $day.AddDays(1); New-Page $dir $i $nb $sec $title $books[$nb][$sec][$title] $day }
    }
    # A whole notebook in one file, packed by Mnote itself; then the folder is no longer needed.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Mnote pack (Join-Path $Out $nb) | Out-Null
    if (-not [IO.File]::Exists((Join-Path $Out "$nb.mnotebook"))) { throw "pack failed for $nb" }
    [IO.Directory]::Delete((Join-Path $Out $nb), $true)
}
Write-Host "Sample library (fictional notes) written to: $Out"
Get-ChildItem $Out | ForEach-Object { Write-Host ("  {0}  {1:N0} KB" -f $_.Name, ($_.Length / 1KB)) }
