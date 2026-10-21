# Mnote: OneNote notes as files, with a reader

**Website and download:** https://swiftkeyc.github.io/mnote-reader/

Mnote exports your Microsoft OneNote notebooks into ordinary files that you own. It also gives
you a reader app to read, search, highlight, annotate and edit them.

- **`.mnote`**: one OneNote page as one file. It's a ZIP archive holding the page as HTML and as
  text, its images, and OneNote's original XML for the page.
- **`.mnotebook`**: a whole notebook in one file.
- **Mnote Reader**: reads them like a PDF. It has a contents sidebar, search, highlights,
  notes, bookmarks and a page editor, and it opens in its own Firefox or Edge window.
- **Mnote MCP server** (optional): lets AI assistants such as Alexa+, Claude or VS Code search
  and read your notes, add notes to them, and quiz you on your own highlights. See
  [Study with an AI assistant](#study-with-an-ai-assistant-the-mcp-server).

Everything runs on your own PC. There are no cloud services and no accounts, and there's
nothing to download besides these files.

## Requirements

- Windows 10 or 11, with Windows PowerShell 5.1 (it comes with Windows)
- The OneNote desktop app (Microsoft 365 or OneNote 2016), but only for exporting
- Firefox (including the Microsoft Store version) or Microsoft Edge, for the reader

## Download

| Download | For |
|----------|-----|
| [Mnote-Setup-x64.exe](https://swiftkeyc.github.io/mnote-reader/downloads/Mnote-Setup-x64.exe) | Installer for 64-bit Windows: most PCs, and Windows 11 on ARM |
| [Mnote-Setup-x86.exe](https://swiftkeyc.github.io/mnote-reader/downloads/Mnote-Setup-x86.exe) | Installer for 32-bit Windows, and Windows 10 on ARM |
| [Mnote-portable.zip](https://swiftkeyc.github.io/mnote-reader/downloads/Mnote-portable.zip) | No installer: unzip it, then use the `.cmd` files inside |

[SHA256SUMS.txt](https://swiftkeyc.github.io/mnote-reader/downloads/SHA256SUMS.txt) has the
checksums. Every download holds the same Mnote. Mnote is PowerShell and HTML, so only the setup
program differs between 64-bit and 32-bit.

## Get started

1. Run the installer. It installs Mnote for your Windows account, with no administrator rights,
   in `%LOCALAPPDATA%\Programs\Mnote`. It asks where your notes go, and whether the reader
   opens in Edge or Firefox.
2. Export your notebooks. Open the OneNote desktop app with your notebooks open, then choose
   **Export OneNote to Mnote** in the Start menu. It writes everything to
   `Documents\OneNote Export`. For more options, see [Export from OneNote](#export-from-onenote).
3. Open **Mnote Reader** from the Start menu, or double-click any `.mnote` or `.mnotebook` file.

To uninstall, go to Settings > Apps > Installed apps > Mnote Reader. Your notes aren't touched.

### Without the installer

1. Unzip `Mnote-portable.zip` into a folder you'll keep, for example `Documents\Mnote`. You can
   also use this repository: **Code > Download ZIP**, or `git clone`.
2. Open the OneNote desktop app with your notebooks open, then double-click
   **`Export OneNote.cmd`**.
3. Double-click **`Install Mnote Reader.cmd`**. This makes `.mnote` and `.mnotebook` files open
   in the reader, and adds Mnote Reader and Export OneNote to Mnote to the Start menu. To choose
   Firefox instead of Edge, or another notes folder, run this instead:

   ```
   powershell -ExecutionPolicy Bypass -File .\mnote.ps1 install "$HOME\Documents\OneNote Export" -Browser firefox
   ```

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

## Study with an AI assistant: the MCP server

`mcp\` is a [Model Context Protocol](https://modelcontextprotocol.io) server for your Mnote
library. It runs on your own PC, implements MCP 2025-11-25 over Streamable HTTP, and is built
with the official MCP TypeScript SDK. Any MCP client can connect to it: Alexa+, Claude, VS Code,
the MCP Inspector, and others.

| Tool | What it does |
|------|--------------|
| `list_notebooks` | Notebooks, sections and pages, with how many highlights, notes and bookmarks each has |
| `search_notes` | Searches page text, titles, highlights and notes, like the reader's search box |
| `read_page` | One page's text with its highlights and notes. Pages can be named loosely ("the pricing page") or by page number |
| `list_highlights_and_notes` | Everything you marked, by notebook, section, page or colour |
| `add_note` | Saves a note on a page, or on a passage, which becomes a highlight. It goes in the page's `annotations.json`, just as if you'd made it in Mnote Reader |
| `quiz_me` | **Study coach.** A fill-in-the-blank question made from one of your highlights |
| `answer_quiz` | Checks your answer, typed or spoken, and asks the next question |
| `study_progress` | Your score today, your day streak, what's due, and the passages you miss most |

The study coach uses spaced repetition: a question you get wrong comes back a few minutes
later, and one you get right comes back after 1, 2, 4, 8 and then 16 days. Answer checking
allows for capitals, plurals, small typos and speech-recognition slips. Your progress is saved
in `mnote-study.json` next to your notebooks, so it carries over between conversations and
devices. Two prompts, `study_session` and `review_my_mistakes`, start a session in clients that
show prompts. When a page name in `add_note` fits more than one page, clients that support MCP
elicitation ask you which page you mean.

### The flashcard on screens (MCP Apps)

On a screen, `quiz_me` and `answer_quiz` also show an interactive flashcard. It's an
[MCP App](https://github.com/modelcontextprotocol/ext-apps) (the `io.modelcontextprotocol/ui`
extension), so hosts that support MCP Apps, such as Alexa+ on Echo Show and the MCP Inspector,
draw it in the conversation. It shows:

- the question with its blank, a **Hint** button, an answer box, and **I don't know**
- whether you were right, the answer, and the whole highlighted passage, marked as in the
  reader, with your note
- when the question comes back, and a **Next question** button

An answer typed on the card goes to `answer_quiz` through the host, so it counts just like a
spoken one. The card also tells the assistant which question is on screen, so you can switch
between talking and tapping. The card is one self-contained page, `mcp\src\flashcard.html`,
served as `ui://mnote/flashcard-<hash>.html`. It loads nothing from the internet and has no
network access. Its text is sized for Alexa's 768x480 base canvas and grows with the screen, so
you can read it from across a room, and it follows the host's light or dark theme. Clients
without MCP Apps get the same text and data as before. To see the card without a host, open
`mcp\src\flashcard.html` in a browser: it shows a sample question.

### Try it on an Alexa-like screen (simulator)

Amazon's own testing tools for Alexa+ add-ons, including the Local Inspector, are only available
to developers in the Alexa+ private preview. `mcp\sim\` is a stand-in you can run on any PC. It's
a simulated Alexa+ host, not Amazon software. It shows the flashcard on an Echo Show-sized screen
and lets you talk to "Alexa" by typing, with buttons, or with your microphone.

```
powershell -ExecutionPolicy Bypass -File .\mcp\sample\make-sample-library.ps1
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 mcp "$env:TEMP\mnote-demo"
```

Then, in a second window:

```
cd mcp
npm install
npm run sim
```

Open `http://127.0.0.1:47890/` and say "Quiz me". Answer by touching the card or by saying the
answer, and switch between the two as you like.

What's real and what's simulated:

- **Real:** the Mnote MCP server and its tools, and the flashcard. The card is run through the
  official MCP Apps host bridge (`AppBridge` from `@modelcontextprotocol/ext-apps`), the way
  Amazon's docs say Alexa+ runs it: in a sandboxed iframe with no access to the page around it,
  with the card's content security policy enforced, on a touch screen, in a fixed device canvas.
  Like Alexa+, the host takes the card's `ui/update-model-context` messages, so a spoken answer
  goes to the question on screen. The **What the card told Alexa** and **MCP traffic** panels
  show these messages.
- **Simulated:** Alexa's language model. A few phrases ("quiz me", "quiz me on economics",
  "give me a hint", "how am I doing?", "stop") are matched by simple rules, and anything else
  counts as your answer. Speech uses your browser's speech features: the **Mic** button uses its
  speech recognition, which may send your voice to the browser maker's speech service. The device
  sizes follow Amazon's Alexa+ design guide: a 768x480 canvas scaled 1.667 times for Echo Show 8
  and 15, plus Echo Show 5, a phone, and the web.

`npm run sim -- --port 48001 --server http://127.0.0.1:48000/mcp` uses other ports. The simulator
only listens on this PC.

### Run it

You need [Node.js](https://nodejs.org) 20 or later, and this repository: **Code > Download
ZIP**, or `git clone`. The MCP server isn't in the installers or the portable ZIP.

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 mcp "$HOME\Documents\OneNote Export"
```

The first run installs the server's packages, which takes a minute. After that, the server
starts in a second and prints its address:

```
Mnote MCP server 1.0.0 (MCP 2025-11-25, Streamable HTTP)
  Library:  C:\Users\you\Documents\OneNote Export
            3 notebook(s), 214 page(s)
  Endpoint: http://127.0.0.1:47880/mcp
```

Press Ctrl+C to stop it. Add `-Port 48000` to use another port. Without `mnote.ps1`:

```
cd mcp
npm install
npm start -- --library "$HOME\Documents\OneNote Export"
```

`--library` takes your export folder or a single `.mnotebook` file. Run
`node src\server.js --help` to see every option.

To try it without your own notes, make the fictional sample library. It has two notebooks and
16 highlights, and is written to `%TEMP%\mnote-demo`:

```
powershell -ExecutionPolicy Bypass -File .\mcp\sample\make-sample-library.ps1
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 mcp "$env:TEMP\mnote-demo"
```

### Connect an assistant on this PC

- **MCP Inspector:** run `npx @modelcontextprotocol/inspector` and open the address it prints.
  Choose **Add Servers > Add manually**, pick the **streamable-http** transport, enter
  `http://127.0.0.1:47880/mcp`, add it, and switch it on. The **Tools** tab then lists the
  tools. The **Apps** tab shows the flashcard: pick **Quiz me**, then **Open App**. Or call a
  tool from the command line (`--method tools/list --app-info` shows which tools have the card):

  ```
  npx @modelcontextprotocol/inspector --cli http://127.0.0.1:47880/mcp --method tools/call --tool-name quiz_me
  ```

- **Claude Code:** `claude mcp add --transport http mnote http://127.0.0.1:47880/mcp`
- **VS Code:** add this to `.vscode/mcp.json`:

  ```json
  { "servers": { "mnote": { "type": "http", "url": "http://127.0.0.1:47880/mcp" } } }
  ```

Then ask something like "What did I highlight about availability zones?", "Add a note to my
pricing page: spot instances can be taken back", or "Quiz me on my study notebook".

### Connect Alexa+

Alexa+ connects to MCP servers from the internet, over HTTPS, with OAuth 2.1 account linking.
The server includes everything this needs:

1. Give your PC a public HTTPS address with a tunnel, for example
   `cloudflared tunnel --url http://127.0.0.1:47880`. It prints an address like
   `https://example-words.trycloudflare.com`.
2. Start the server with that address:

   ```
   cd mcp
   node src\server.js --library "$HOME\Documents\OneNote Export" --public-url https://example-words.trycloudflare.com
   ```

   This turns on sign-in. The server prints the OAuth authorization and token addresses, a
   client ID and secret, and a passphrase. They're saved in
   `%LOCALAPPDATA%\Mnote\mcp-oauth.json`, so they stay the same next time. Requests without a
   valid token get `401 Unauthorized`.
3. Create and deploy the add-on with Amazon's Alexa AI CLI, giving it your MCP address:
   `alexa-ai new mcp --name "Mnote" --locale en-US --mcp-server-url https://example-words.trycloudflare.com/mcp`,
   then `alexa-ai deploy`. For account linking, give it the authorization and token addresses,
   client ID and client secret that the server printed. See Amazon's
   [Alexa+ MCP add-on guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)
   and its [authentication page](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html).
4. When you link the add-on, the server shows a consent page. Type your passphrase there to
   allow it. Then try it in the Alexa+ web simulator: "Quiz me on my notes."

The server provides what Amazon's guide asks for: Streamable HTTP, protocol 2025-11-25 (it also
accepts the older versions clients may ask for), OAuth discovery documents at
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
authorization code with PKCE (S256), client credentials, and refresh tokens. Tools answer in a
few milliseconds, well under Alexa's 500 ms limit. Clients that send each request on its own,
without an MCP session, are answered too.

For other remote clients that can send a header, `--token <secret>` (or `MNOTE_MCP_TOKEN`)
also works: they send `Authorization: Bearer <secret>`.

### What it keeps safe

- It listens on `127.0.0.1` only, so nothing else on your network can connect, unless you give
  it `--host`. Listening on another address needs a token or OAuth, and it makes up a token if
  you give neither. Through a tunnel with `--public-url`, every request needs an OAuth token.
- Web pages from other sites are refused (`Origin` check). Without sign-in, requests addressed
  to any host name other than this PC are refused too (DNS rebinding).
- It only reads your library folder. The only things it writes are `annotations.json` inside a
  page (the same format, and the same safe save, as the reader), `mnote-study.json` next to
  your notebooks, and its sign-in file.
- If Mnote Reader has a page open when a note is added to it, reload the reader (F5) before
  you change that page's notes there. Otherwise the reader saves its older copy over the new
  note.

### Tests

`npm test` in `mcp\` builds the sample library, starts the server, and checks every tool through
the official MCP client. It also checks the study coach across restarts, sessionless requests,
the security checks, the OAuth flow, and that the flashcard is listed, linked from the quiz tools,
and a well-formed page with nothing loaded from outside, and that the simulator builds. Run
`npm install` first (not `npm ci --omit=dev`), because the simulator's build tool is a
development package. The tests need Windows, because the sample library is packed by
`mnote.ps1`.

## Install and uninstall

The installers do all of this for you. They also add Mnote Reader to Settings > Apps, and run
without a window too:

```
Mnote-Setup-x64.exe /quiet
Mnote-Setup-x64.exe /uninstall /quiet
```

`/quiet` uses the notes folder and browser from an earlier install. If there isn't one, it uses
`Documents\OneNote Export` and Edge.

Without the installer, keep `mnote.ps1` and `mnote-reader.html` together in one folder, then run:

```
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 install "$HOME\Documents\OneNote Export" -Browser firefox
powershell -ExecutionPolicy Bypass -File .\mnote.ps1 uninstall
```

`-Browser firefox` or `-Browser edge` picks the window the reader opens in. It's remembered in
`mnote.config.json`. Leave it out to keep the current choice.

`install` sets things up for your Windows account only, and needs no administrator rights. It:

- makes `.mnote` files ("OneNote page (Mnote)") and `.mnotebook` files ("OneNote notebook
  (Mnote)") open in the reader, each type with its own icon
- adds a **Mnote Reader** shortcut to the Start menu, which opens the folder you give it. It
  creates the folder if it isn't there yet.
- adds **Export OneNote to Mnote** to the Start menu, which exports to that folder

`uninstall` removes all of these. It doesn't touch your notes or these files. If you move this
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

- Without `-OutDir`, the export goes to `Documents\OneNote Export`. `Export OneNote.cmd` does
  the same with a double-click.
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

## Build the downloads

`installer\build.ps1` builds everything in the Download table into `docs\downloads`, together
with `SHA256SUMS.txt` and `release.json`. The website reads `release.json` for the version and
sizes:

```
powershell -ExecutionPolicy Bypass -File .\installer\build.ps1 -Version 1.0.1
```

The installers are compiled from `installer\setup.cs` with the C# compiler that comes with
Windows, so there's nothing to install first. The website is `docs\`, published on the
`gh-pages` branch:

```
git subtree push --prefix docs origin gh-pages
```

## Known limits

- Password-protected sections are skipped. Unlock them in OneNote first.
- Windows limits full paths to 260 characters. Keep `-OutDir` short.
- Pages in OneNote's Notebook Recycle Bin are skipped unless you add `-IncludeRecycleBin`.
- Handwriting (ink) shows only as a `[handwriting]` placeholder. It is still in `page.onexml`.
- Exporting needs OneNote for Windows (desktop). OneNote for the web and for Mac can't be
  exported directly, but you can open the same notebooks in the desktop app.
