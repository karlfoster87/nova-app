# Nova's bridge to classic Outlook over COM (server/email/outlook.js runs it, one request each time).
# It reads one JSON request from stdin and writes one JSON answer to stdout, in UTF-8.
#
# It attaches to the Outlook that is already running and never starts one: when Outlook isn't open
# it says so. Listing and reading change nothing. 'draft' saves a reply in Drafts and opens it in
# Outlook for the user to check; nothing here ever sends mail.
#
# Requests: { action: 'list', limit }, { action: 'read', entryId, storeId },
#           { action: 'draft', entryId, storeId, body, replyAll },
#           { action: 'folders' | 'delete', entryId, storeId }, { action: 'move', entryId, storeId, folderId, folderStoreId },
#           { action: 'flag', entryId, storeId, on }
# Since v0.15.1 the Home card can also delete, move and flag an item, each only when the user
# chooses it there (delete after a confirmation). Delete goes to Deleted Items, as in Outlook.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

function Send($o) { [Console]::Out.Write(($o | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
function Ms($d) {
  if ($null -eq $d) { return $null }
  if ($d.Year -ge 4000) { return $null } # Outlook writes 4501-01-01 for "none"
  return [DateTimeOffset]::new([DateTime]::SpecifyKind($d, 'Local')).ToUnixTimeMilliseconds()
}
function Clip($s, $n) { if ($null -eq $s) { return '' }; $s = [string]$s; if ($s.Length -gt $n) { return $s.Substring(0, $n) }; return $s }
function Preview($s) { return (Clip (((Clip $s 600) -replace '\s+', ' ').Trim()) 180) }

# Mail is class 43; meeting requests, responses and cancellations 53 to 57; tasks 48.
$MEETING = @(53, 54, 55, 56, 57)
function KindOf($i) { $c = [int]$i.Class; if ($c -eq 43) { 'mail' } elseif ($c -eq 48) { 'task' } elseif ($MEETING -contains $c) { 'meeting' } else { $null } }

function Shape($i, $kind) {
  $store = $null; try { $store = $i.Parent.StoreID } catch {}
  $folder = $null; $folderId = $null; try { $p = $i.Parent; $folder = $p.Name; $folderId = $p.EntryID } catch {}
  $o = [ordered]@{ entryId = $i.EntryID; storeId = $store; kind = $kind; subject = (Clip $i.Subject 300); folder = $folder; folderId = $folderId }
  if ($kind -eq 'task') {
    $o.due = Ms $i.DueDate; $o.from = ''; $o.received = Ms $i.CreationTime; $o.unread = $false; $o.flagged = $true
    $o.preview = Preview $i.Body
  } else {
    $o.from = (Clip $i.SenderName 200); $o.received = Ms $i.ReceivedTime; $o.unread = [bool]$i.UnRead
    $o.flagged = ($kind -eq 'mail' -and [int]$i.FlagStatus -eq 2)
    $o.due = $null; try { if ($o.flagged) { $o.due = Ms $i.TaskDueDate } } catch {}
    $o.preview = Preview $i.Body
  }
  return $o
}

# The sender's SMTP address: Exchange senders carry an internal address, so ask the directory.
function SenderAddress($i) {
  try {
    if ($i.SenderEmailType -eq 'EX') { $u = $i.Sender.GetExchangeUser(); if ($u) { return $u.PrimarySmtpAddress } }
    return $i.SenderEmailAddress
  } catch { return '' }
}

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { Send @{ error = 'not-running' } }
  $ns = $ol.GetNamespace('MAPI')

  if ($req.action -eq 'list') {
    $limit = [Math]::Max(1, [Math]::Min(200, [int]$req.limit))
    $inboxFolder = $ns.GetDefaultFolder(6)
    $items = $inboxFolder.Items
    $items.Sort('[ReceivedTime]', $true)
    $inbox = @(); $i = $items.GetFirst()
    while ($null -ne $i -and $inbox.Count -lt $limit) {
      $k = KindOf $i
      if ($k -and $k -ne 'task') { $inbox += Shape $i $k }
      $i = $items.GetNext()
    }
    # The To-Do List folder gathers flagged mail from every folder, and tasks. Finished ones stay out.
    $todo = @()
    foreach ($t in $ns.GetDefaultFolder(28).Items) {
      if ($todo.Count -ge $limit) { break }
      $k = KindOf $t
      if ($k -eq 'task') { if (-not $t.Complete) { $todo += Shape $t 'task' } }
      elseif ($k -eq 'mail') { if ([int]$t.FlagStatus -eq 2) { $todo += Shape $t 'mail' } }
    }
    Send ([ordered]@{ inbox = $inbox; todo = $todo; unread = $inboxFolder.UnReadItemCount; total = $items.Count })
  }

  # The mail folders of one mailbox, as a tree in order, for "Move to folder": the item's own
  # mailbox, or the default one when no item is given (Nova fetches that ahead, to cache it).
  # Walking folders over COM is slow (seconds for a large mailbox), so every property read counts:
  # the mailbox's id is read once, not per folder.
  if ($req.action -eq 'folders') {
    if ($req.entryId) {
      try { $store = $ns.GetItemFromID([string]$req.entryId, [string]$req.storeId).Parent.Store } catch { Send @{ error = 'gone' } }
    } else { $store = $ns.DefaultStore }
    $storeId = $store.StoreID
    $out = New-Object System.Collections.ArrayList
    # Never offered: the Outbox (mail there is sent) and Outlook's Sync Issues housekeeping.
    $skip = @(); foreach ($n in 4, 20) { try { $skip += $ns.GetDefaultFolder($n).EntryID } catch {} }
    function Walk($f, $path, $depth) {
      foreach ($c in $f.Folders) {
        if ($out.Count -ge 500) { return }
        if ([int]$c.DefaultItemType -ne 0) { continue } # mail folders only
        $id = $c.EntryID; $name = $c.Name
        if ($skip -contains $id -or $name -eq 'Outbox') { continue }
        $p = if ($path) { "$path/$name" } else { $name }
        [void]$out.Add([ordered]@{ entryId = $id; name = $name; path = $p; depth = $depth })
        if ($depth -lt 8) { Walk $c $p ($depth + 1) }
      }
    }
    Walk $store.GetRootFolder() '' 0
    Send ([ordered]@{ storeId = $storeId; folders = @($out) })
  }

  if (@('read', 'draft', 'move', 'delete', 'flag') -contains $req.action) {
    try { $item = $ns.GetItemFromID([string]$req.entryId, [string]$req.storeId) } catch { Send @{ error = 'gone' } }
    $kind = KindOf $item

    if ($req.action -eq 'move') {
      try { $dest = $ns.GetFolderFromID([string]$req.folderId, [string]$req.folderStoreId) } catch { Send @{ error = 'no-folder' } }
      [void]$item.Move($dest)
      Send ([ordered]@{ ok = $true; folder = $dest.Name })
    }
    # Delete moves it to Deleted Items, as pressing Delete in Outlook does.
    if ($req.action -eq 'delete') { $item.Delete(); Send @{ ok = $true } }
    # Follow up: flagged for today (olMarkToday = 0), or the flag cleared.
    if ($req.action -eq 'flag') {
      if ($kind -eq 'task') { Send @{ error = 'not-mail' } }
      if ($req.on) { $item.MarkAsTask(0) } else { $item.ClearTaskFlag() }
      $item.Save()
      Send ([ordered]@{ ok = $true; flagged = [bool]$req.on })
    }

    if ($req.action -eq 'read') {
      $o = Shape $item $kind
      $o.body = Clip $item.Body 60000
      if ($kind -ne 'task') {
        $o.fromAddress = SenderAddress $item
        $o.to = Clip $item.To 2000; $o.cc = Clip $item.CC 2000
        $o.attachments = @(); try { foreach ($a in $item.Attachments) { $o.attachments += [string]$a.FileName } } catch {}
        $o.messageId = ''; try { $o.messageId = $item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x1035001F') } catch {}
      }
      Send $o
    }
    if ($kind -ne 'mail' -and $kind -ne 'meeting') { Send @{ error = 'not-mail' } }
    $reply = if ($req.replyAll) { $item.ReplyAll() } else { $item.Reply() }
    # Shown first, so Outlook lays the reply out as it would for the user: their reply signature and
    # stationery. The text then goes at the top of Outlook's own body section, above the signature,
    # as MsoNormal paragraphs, so it takes the reply font set in Outlook's stationery, not one of ours.
    $shown = $true; try { $reply.Display($false) } catch { $shown = $false }
    $paras = ([string]$req.body -replace "`r", '') -split "`n" | ForEach-Object {
      $line = [Net.WebUtility]::HtmlEncode($_)
      if ($line.Trim()) { "<p class=MsoNormal>$line</p>" } else { '<p class=MsoNormal>&nbsp;</p>' }
    }
    $block = ($paras -join "`r`n") + "`r`n<p class=MsoNormal>&nbsp;</p>`r`n"
    $html = [string]$reply.HTMLBody
    $m = [regex]::Match($html, '<div class=["'']?WordSection1["'']?[^>]*>', 'IgnoreCase')
    if (-not $m.Success) { $m = [regex]::Match($html, '<body[^>]*>', 'IgnoreCase') }
    $reply.HTMLBody = if ($m.Success) { $html.Insert($m.Index + $m.Length, $block) } else { $block + $html }
    $reply.Save()
    Send ([ordered]@{ ok = $true; subject = $reply.Subject; to = $reply.To; shown = $shown })
  }

  Send @{ error = 'failed'; message = 'Unknown request.' }
} catch {
  Send @{ error = 'failed'; message = $_.Exception.Message }
}
