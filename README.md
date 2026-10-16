# Mnote: OneNote notes as files, with a reader

Mnote exports your Microsoft OneNote notebooks into ordinary files that you own. It also gives
you a reader app to read, search, highlight, annotate and edit them.

- **`.mnote`**: one OneNote page as one file. It's a ZIP archive holding the page as HTML and as
  text, its images, and OneNote's original XML for the page.
- **`.mnotebook`**: a whole notebook in one file.
- **Mnote Reader**: reads them like a PDF. It has a contents sidebar, search, highlights,
  notes, bookmarks and a page editor, and it opens in its own Firefox or Edge window.

Everything runs on your own PC. There are no servers and no accounts, and there's nothing to
download besides these files.

## Requirements

- Windows 10 or 11, with Windows PowerShell 5.1 (it comes with Windows)
- The OneNote desktop app (Microsoft 365 or OneNote 2016), but only for exporting
- Firefox (including the Microsoft Store version) or Microsoft Edge, for the reader

## Get started

1. Put this repository in a folder you'll keep, for example `Documents\Mnote`. Either use
   **Code > Download ZIP** and unzip it, or run `git clone`.
2. Export your notebooks from OneNote (see [Export from OneNote](#export-from-onenote)):

   ```
   powershell -ExecutionPolicy Bypass -File .\mnote.ps1 export -OutDir "$HOME\Documents\OneNote Export"
   ```

3. Install the reader for your Windows account by double-clicking **`Install Mnote Reader.cmd`**.
   This makes `.mnote` and `.mnotebook` files open in it, and adds it to the Start menu. To
   choose Firefox instead of Edge, or another notes folder, run this instead:

   ```
   powershell -ExecutionPolicy Bypass -File .\mnote.ps1 install "$HOME\Documents\OneNote Export" -Browser firefox
   ```

4. Open **Mnote Reader** from the Start menu, or double-click any `.mnote` or `.mnotebook` file.

## Read your notes

- Double-click any `.mnote` file. The reader opens on that page.
- Double-click a `.mnotebook` file. The reader opens that whole notebook.
- Start menu > **Mnote Reader** opens your whole export folder.

From PowerShell:

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 read "$HOME\Documents\OneNote Export"
```

You can also give it a single `.mnote` or `.mnotebook` file, and the reader opens on that.

The reader opens in its own window: Firefox or Microsoft Edge, whichever you chose at install.

- **Firefox:** the window uses a separate Firefox profile just for the reader
  (`%LOCALAPPDATA%\Mnote\firefox-profile`). It has no tabs, address bar or bookmarks bar, and
  is kept apart from your normal browsing.
- **Edge:** it uses Edge's app mode.

Behind the window, the reader runs a small private server on your PC (`localhost`) that only
that window can use. The server stops by itself a few minutes after you close the window.

| Area | What it does |
|------|--------------|
| Top bar | Page number and jump to page, previous and next, zoom, the highlighter, reading settings (theme, font, size, spacing, width), print or save as PDF, and the notes panel |
| Left sidebar | **Contents** shows notebooks, then sections (chapters), then pages. **Bookmarks** lists bookmarked pages. **Search** searches the text, titles and your notes in every notebook |
| Pages | Each notebook reads as one document, with its sections as chapters. Every page is a sheet with its section, title and dates |
| Select text | Choose a highlight colour, add a note, or copy |
| Click a highlight | Change its colour, edit its note, copy it, or remove it |
| Notes panel | Shows highlights and notes for this page or the whole notebook. Click a quote to jump to it, or download them all as Markdown |
| Page corner | Edit the page, bookmark it, or add a note about the whole page |

### Edit a page

To edit a page, click the pencil at the top right of the page, or press **E**. The page and its
title become editable, and a formatting bar stays at the top while you scroll:

- bold, italic, underline and strikethrough
- headings, bulleted and numbered lists, and to-do checkboxes (click a box to tick it)
- undo, redo, and clear formatting

**Save** (or Ctrl+S) writes the page back into its `.mnote` or `.mnotebook` file, and the page
then shows "Edited in Mnote". **Cancel** throws your changes away. Starting to edit another page
saves the one you were on, and the window warns you before closing with unsaved changes.

Editing only changes the readable copies of the page (`page.html` and `page.txt`) and its title.
OneNote's own copy of the page (`page.onexml`) stays exactly as exported. Re-exporting from
OneNote won't replace pages you've edited. It lists them instead. Re-packing a notebook keeps
your edited version of a page.

### Keyboard shortcuts

- ← and → turn the page.
- E edits the page, and Ctrl+S saves it.
- H turns the highlighter on or off. While it's on, any text you select is highlighted straight away.
- N opens the notes panel.
- B bookmarks the page.
- Ctrl+F searches.
- Ctrl and + / − zooms.
- Ctrl+P prints.

## A whole notebook in one file: .mnotebook

`pack` turns a notebook folder into a single `.mnotebook` file. You can double-click it to
read the whole notebook, with its sections as chapters. Highlights, notes and edits are saved
inside it.

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 pack "$HOME\Documents\OneNote Export\My Notebook" -RemoveFolder
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 info "$HOME\Documents\OneNote Export\My Notebook.mnotebook"
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 unpack "$HOME\Documents\OneNote Export\My Notebook.mnotebook"
```

- `pack` writes `<folder>.mnotebook`, then reads every page back and checks it matches the
  original. Only after that, and only with `-RemoveFolder`, does it move the folder to the
  Recycle Bin.
- Packing again, for example after a fresh export, keeps the highlights, notes and edited pages
  from the earlier notebook file.
- `unpack` recreates the folder next to the file. The `.mnotebook` file is kept.
- The reader's library (the Start menu shortcut) shows `.mnotebook` files and notebook folders
  side by side.

Inside, a `.mnotebook` is a ZIP archive:

| Entry           | Contents                                                          |
|-----------------|-------------------------------------------------------------------|
| `mimetype`      | `application/vnd.mnotebook+zip`. Always the first entry.          |
| `notebook.json` | Notebook name, when it was packed, and the section and page order |
| `pages/<section>/<NN title>.mnote` | Each page, as its complete original `.mnote` file |

## Install and uninstall

Keep `mnote.ps1` and `mnote-reader.html` together in one folder, then run:

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 install "$HOME\Documents\OneNote Export" -Browser firefox
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 uninstall
```

`-Browser firefox` or `-Browser edge` picks the window the reader opens in. It's remembered in
`mnote.config.json`. Leave it out to keep the current choice.

`install` sets things up for your Windows account only, and needs no administrator rights. It:

- makes `.mnote` files ("OneNote page (Mnote)") and `.mnotebook` files ("OneNote notebook
  (Mnote)") open in the reader, each type with its own icon
- adds a **Mnote Reader** shortcut to the Start menu, which opens the folder you give it

`uninstall` removes both. It doesn't touch your notes or these files. If you move this
folder, run `install` again. `Install Mnote Reader.cmd` and `Uninstall Mnote Reader.cmd` do the
same with a double-click.

Run the installer yourself, from File Explorer or your own PowerShell window. Sandboxed tools,
including AI coding agents, may write the file types into a private copy of the registry that
Windows itself never sees.

## Export from OneNote

Before you export, open the OneNote desktop app, sign in, and open your notebooks there
(File > Open). Then run:

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 list
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 export -OutDir "$HOME\Documents\OneNote Export"
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 export -Notebook "My Notebook"
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 info "...\01 Page title.mnote"
```

The export keeps OneNote's structure:

```
OneNote Export\<Notebook>\<Section group>\<Section>\01 <Page title>.mnote
OneNote Export\library.json        notebook and section order, used by the reader
```

- The number in front of each file name keeps the page order from OneNote.
- Each file also keeps the page's last-modified date.
- Running the export again refreshes the pages but keeps your highlights and notes. Pages you
  edited in the reader are not replaced. If a page's title changed in OneNote, it gets a new
  file, and its notes stay in the old one.
- `library.json` keeps any section order that is already in it, and adds new sections at the end.
- Images that OneNote hasn't downloaded yet (common with cloud notebooks) are fetched by
  showing their page in OneNote. Any that still can't be fetched are listed at the end.

## What is inside a .mnote file

A `.mnote` file is a ZIP archive. To look inside, rename it to `.zip`.

| Entry              | Contents                                                           |
|--------------------|--------------------------------------------------------------------|
| `mimetype`         | `application/vnd.mnote+zip`. Always the first entry.               |
| `manifest.json`    | Title, notebook, section groups, section, created and modified dates |
| `page.html`        | The page, readable in any browser                                  |
| `page.txt`         | Plain text, for search and quick reading                           |
| `page.onexml`      | OneNote's own XML for the page, with images. Nothing is lost.      |
| `images/`          | Images on the page                                                 |
| `attachments/`     | Files that were embedded in the page                               |
| `annotations.json` | Optional, written by the reader. It holds your highlights (with colour, quoted text and note), the page note, and the bookmark |

Each highlight records where it sits in the page's text, plus the quoted words and a little of
the text around them. So it still finds its place if the page text shifts slightly.

## Known limits

- Password-protected sections are skipped. Unlock them in OneNote first.
- Windows limits full paths to 260 characters. Keep `-OutDir` short.
- Pages in OneNote's Notebook Recycle Bin are skipped unless you add `-IncludeRecycleBin`.
- Handwriting (ink) shows only as a `[handwriting]` placeholder. It is still in `page.onexml`.
- Exporting needs OneNote for Windows (desktop). OneNote for the web and for Mac can't be
  exported directly, but you can open the same notebooks in the desktop app.
