// Mnote Reader setup. It installs Mnote for the current Windows account, without administrator
// rights:
//   - the app files go to %LOCALAPPDATA%\Programs\Mnote
//   - "mnote.ps1 install" sets up the file types and the Start menu, just as Install Mnote
//     Reader.cmd does
//   - Mnote Reader is added to Settings > Apps, so it can be uninstalled from there.
//
// build.ps1 compiles this file with the C# compiler that comes with Windows, once for x64 and
// once for x86. The app files are embedded as the resource "payload.zip".
//
//   Mnote-Setup-x64.exe                    install, with a window
//   Mnote-Setup-x64.exe /quiet             install with the defaults, without a window
//   Mnote-Setup-x64.exe /uninstall         remove Mnote Reader (Settings > Apps runs this)
//   Mnote-Setup-x64.exe /uninstall /quiet  remove it without asking
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Mnote Reader Setup")]
[assembly: AssemblyProduct("Mnote Reader")]
[assembly: AssemblyCompany("Nurdaulet Askar")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Nurdaulet Askar. MIT license.")]
[assembly: AssemblyVersion(BuildInfo.Version + ".0")]
[assembly: AssemblyFileVersion(BuildInfo.Version + ".0")]
[assembly: AssemblyInformationalVersion(BuildInfo.Version)]
[assembly: TargetFramework(".NETFramework,Version=v4.7.2")]

sealed class SetupException : Exception
{
    public readonly string Output;
    public SetupException(string message, string output) : base(message) { Output = output; }
}

static class Setup
{
    const string AppsKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MnoteReader";
    // Files that mnote.ps1 writes next to itself; removed on uninstall with the app files.
    static readonly string[] Generated = { "mnote.config.json", "mnote.ico", "mnotebook.ico" };
    static readonly string LogFile = Path.Combine(Path.GetTempPath(), "Mnote-Setup.log");

    public static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mnote");
    public static readonly string DefaultNotes = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "OneNote Export");

    [STAThread]
    static int Main(string[] args)
    {
        bool quiet = false, uninstall = false;
        foreach (string a in args)
        {
            string x = a.TrimStart('/', '-').ToLowerInvariant();
            if (x == "quiet" || x == "silent" || x == "q" || x == "s") quiet = true;
            else if (x == "uninstall" || x == "u") uninstall = true;
            else { ShowHelp(); return x == "?" || x == "h" || x == "help" ? 0 : 87; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (uninstall) return RunUninstall(quiet);
            if (quiet) { Install(PreviousNotes() ?? DefaultNotes, ConfiguredBrowser() ?? "edge"); return 0; }
            SetupForm form = new SetupForm();
            Application.Run(form);
            return form.Result;
        }
        catch (Exception ex)
        {
            if (quiet) Log("error: " + ex);
            else ShowError(null, uninstall ? "Mnote Reader could not be removed." : "Mnote Reader Setup failed.", ex);
            return 1;
        }
    }

    static void ShowHelp()
    {
        MessageBox.Show(
            "Mnote Reader Setup " + BuildInfo.Version + " (" + BuildInfo.Arch + ")\n\n" +
            "(no options)\tInstall, with a window.\n" +
            "/quiet\t\tInstall without a window. It uses the notes folder and browser from an earlier install, or Documents\\OneNote Export and Microsoft Edge.\n" +
            "/uninstall\tRemove Mnote Reader. Your notes are not touched.\n" +
            "/uninstall /quiet\tRemove it without asking.\n\n" +
            "Log: " + LogFile,
            "Mnote Reader Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    // ------------------------------------------------------------------ install

    // Returns what mnote.ps1 printed, which may include warnings for the user.
    public static string Install(string notes, string browser)
    {
        notes = Path.GetFullPath(notes);
        Log("install " + BuildInfo.Version + " (" + BuildInfo.Arch + ") to " + InstallDir + "; notes: " + notes + "; browser: " + browser);
        Directory.CreateDirectory(notes);
        Directory.CreateDirectory(InstallDir);
        using (ZipArchive zip = OpenPayload())
        {
            foreach (ZipArchiveEntry e in zip.Entries)
                if (e.Name.Length > 0 && e.Name == e.FullName) e.ExtractToFile(Path.Combine(InstallDir, e.Name), true);
        }
        // This program stays as the uninstaller, for Settings > Apps.
        string uninstaller = Path.Combine(InstallDir, "uninstall.exe");
        if (!SamePath(Application.ExecutablePath, uninstaller)) File.Copy(Application.ExecutablePath, uninstaller, true);

        string output;
        int code = RunMnote("install " + Quote(notes) + " -Browser " + browser, out output);
        if (code != 0) throw new SetupException("mnote.ps1 install stopped with exit code " + code + ".", output);

        long bytes = 0;
        foreach (string f in Directory.GetFiles(InstallDir)) bytes += new FileInfo(f).Length;
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(AppsKey))
        {
            k.SetValue("DisplayName", "Mnote Reader");
            k.SetValue("DisplayVersion", BuildInfo.Version);
            k.SetValue("Publisher", "Nurdaulet Askar");
            k.SetValue("DisplayIcon", Path.Combine(InstallDir, "mnote.ico"));
            k.SetValue("InstallLocation", InstallDir);
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("UninstallString", Quote(uninstaller) + " /uninstall");
            k.SetValue("QuietUninstallString", Quote(uninstaller) + " /uninstall /quiet");
            k.SetValue("URLInfoAbout", "https://swiftkeyc.github.io/mnote-reader/");
            k.SetValue("HelpLink", "https://github.com/SwiftkeyC/mnote-reader");
            k.SetValue("EstimatedSize", (int)((bytes + 1023) / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("NotesFolder", notes);
        }
        return output;
    }

    static ZipArchive OpenPayload()
    {
        return new ZipArchive(typeof(Setup).Assembly.GetManifestResourceStream("payload.zip"), ZipArchiveMode.Read);
    }

    // Runs mnote.ps1 from the install folder, without a window.
    static int RunMnote(string args, out string output)
    {
        // A 32-bit setup on 64-bit Windows still runs the 64-bit PowerShell.
        string dir = Environment.Is64BitOperatingSystem && !Environment.Is64BitProcess ? "Sysnative" : "System32";
        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), dir, @"WindowsPowerShell\v1.0\powershell.exe");
        ProcessStartInfo psi = new ProcessStartInfo(ps,
            "-NoProfile -ExecutionPolicy Bypass -File " + Quote(Path.Combine(InstallDir, "mnote.ps1")) + " " + args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = InstallDir;
        StringBuilder sb = new StringBuilder();
        DataReceivedEventHandler add = (o, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
        using (Process p = new Process())
        {
            p.StartInfo = psi;
            p.OutputDataReceived += add;
            p.ErrorDataReceived += add;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            lock (sb) output = sb.ToString().Trim();
            Log("mnote.ps1 " + args + " -> exit code " + p.ExitCode + Environment.NewLine + output);
            return p.ExitCode;
        }
    }

    // ------------------------------------------------------------------ uninstall

    static int RunUninstall(bool quiet)
    {
        if (!quiet)
        {
            string notes = PreviousNotes();
            string text = "Remove Mnote Reader from this PC?\n\nYour notes" + (notes != null ? " in " + notes : "") + " are not touched.";
            if (MessageBox.Show(text, "Uninstall Mnote Reader", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 1602;
        }
        Uninstall();
        if (!quiet) MessageBox.Show("Mnote Reader was removed.", "Uninstall Mnote Reader", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    // Removes the file types, Start menu shortcuts and Settings > Apps entry, then the files this
    // setup installed (by name; nothing else in the folder) and the folder once it is empty.
    static void Uninstall()
    {
        Log("uninstall from " + InstallDir);
        if (File.Exists(Path.Combine(InstallDir, "mnote.ps1")))
        {
            string output;
            int code = RunMnote("uninstall", out output);
            if (code != 0) throw new SetupException("mnote.ps1 uninstall stopped with exit code " + code + ".", output);
        }
        Registry.CurrentUser.DeleteSubKeyTree(AppsKey, false);

        List<string> names = new List<string>(Generated);
        using (ZipArchive zip = OpenPayload())
        {
            foreach (ZipArchiveEntry e in zip.Entries) if (e.Name.Length > 0) names.Add(e.Name);
        }
        foreach (string n in names)
        {
            try { File.Delete(Path.Combine(InstallDir, n)); } catch (Exception ex) { Log("could not delete " + n + ": " + ex.Message); }
        }

        string uninstaller = Path.Combine(InstallDir, "uninstall.exe");
        if (SamePath(Application.ExecutablePath, uninstaller))
        {
            // A running program can't delete itself, so cmd does it once this one has exited.
            // rmdir without /s only removes the folder if it is empty.
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c ping -n 3 127.0.0.1 >nul & del /f /q " + Quote(uninstaller) + " & rmdir " + Quote(InstallDir));
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
        else
        {
            try { File.Delete(uninstaller); Directory.Delete(InstallDir); } catch (Exception ex) { Log("could not remove " + InstallDir + ": " + ex.Message); }
        }
    }

    // ------------------------------------------------------------------ helpers

    public static string InstalledVersion() { return AppsValue("DisplayVersion"); }
    public static string PreviousNotes() { return AppsValue("NotesFolder"); }

    static string AppsValue(string name)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(AppsKey))
        {
            string v = k == null ? null : k.GetValue(name) as string;
            return string.IsNullOrEmpty(v) ? null : v;
        }
    }

    // The browser an earlier install chose (mnote.config.json), if any.
    public static string ConfiguredBrowser()
    {
        try
        {
            Match m = Regex.Match(File.ReadAllText(Path.Combine(InstallDir, "mnote.config.json")), "\"browser\"\\s*:\\s*\"(edge|firefox)\"", RegexOptions.IgnoreCase);
            if (m.Success) return m.Groups[1].Value.ToLowerInvariant();
        }
        catch { }
        return null;
    }

    // The same places mnote.ps1 looks: the Microsoft Store alias, App Paths, the usual folders.
    public static bool FirefoxInstalled()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (File.Exists(Path.Combine(local, @"Microsoft\WindowsApps\firefox.exe"))) return true;
        RegistryView view = Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Default;
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey k = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"))
                {
                    string p = k == null ? null : k.GetValue("") as string;
                    if (!string.IsNullOrEmpty(p) && File.Exists(p.Trim('"'))) return true;
                }
            }
            catch { }
        }
        foreach (string dir in new[] { Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("ProgramFiles"), local })
        {
            if (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, @"Mozilla Firefox\firefox.exe"))) return true;
        }
        return false;
    }

    public static void OpenReader()
    {
        string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Mnote Reader.lnk");
        try { if (File.Exists(lnk)) Process.Start(new ProcessStartInfo(lnk) { UseShellExecute = true }); }
        catch (Exception ex) { Log("could not open the reader: " + ex.Message); }
    }

    public static Image Logo()
    {
        using (Stream s = typeof(Setup).Assembly.GetManifestResourceStream("logo.png"))
        {
            MemoryStream ms = new MemoryStream();
            s.CopyTo(ms);
            return new Bitmap(ms);
        }
    }

    // The "WARNING: ..." lines mnote.ps1 printed, as paragraphs.
    public static string Warnings(string output)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string line in (output ?? "").Split('\n'))
        {
            string l = line.Trim();
            if (l.StartsWith("WARNING:")) sb.Append("\n\n").Append(l.Substring(8).Trim());
        }
        return sb.ToString();
    }

    public static void ShowError(IWin32Window owner, string what, Exception ex)
    {
        Log("error: " + ex);
        string details = ex.Message;
        SetupException se = ex as SetupException;
        if (se != null && !string.IsNullOrEmpty(se.Output))
            details += "\n\n" + (se.Output.Length > 1500 ? "\u2026" + se.Output.Substring(se.Output.Length - 1500) : se.Output);
        MessageBox.Show(owner, what + "\n\n" + details + "\n\nThe full log is in " + LogFile, "Mnote Reader Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    public static void Log(string text)
    {
        try { File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine); }
        catch { }
    }

    static string Quote(string path)
    {
        string p = path.TrimEnd('\\');
        if (p.EndsWith(":")) p += @"\.";   // "C:\" would end in \" and escape the quote
        return "\"" + p + "\"";
    }

    static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }
}

// The setup window: notes folder and browser, then Install. Sizes are in 96-dpi pixels, and S()
// scales them to the display. WinForms' own AutoScaleMode scaled the wrapping labels twice at
// 125%, which pushed their text past the window edge.
sealed class SetupForm : Form
{
    public int Result = 1602;   // "cancelled", as Windows Installer reports it

    static readonly Color Muted = Color.FromArgb(95, 92, 110);
    readonly Label title = new Label();
    readonly Label subtitle = new Label();
    readonly Panel body = new Panel();
    readonly TextBox notesBox = new TextBox();
    readonly RadioButton edge = new RadioButton();
    readonly RadioButton firefox = new RadioButton();
    readonly Label doneText = new Label();
    readonly CheckBox openNow = new CheckBox();
    readonly Label status = new Label();
    readonly Button main = new Button();
    readonly Button cancel = new Button();
    bool busy, finished;

    static readonly float DpiScale = DisplayScale();
    static float DisplayScale() { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f; }
    static int S(int v) { return (int)Math.Round(v * DpiScale); }
    static Rectangle R(int x, int y, int w, int h) { return new Rectangle(S(x), S(y), S(w), S(h)); }
    static Point P(int x, int y) { return new Point(S(x), S(y)); }

    public SetupForm()
    {
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.None;

        Font = new Font("Segoe UI", 9F);
        Text = "Mnote Reader " + BuildInfo.Version + " Setup";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        ClientSize = new Size(S(520), S(356));

        PictureBox logo = new PictureBox();
        logo.Bounds = R(24, 22, 48, 48);
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        logo.Image = Setup.Logo();

        string installed = Setup.InstalledVersion();
        title.Text = installed == null ? "Install Mnote Reader" : "Update Mnote Reader";
        title.Font = new Font("Segoe UI Semibold", 14F);
        title.AutoSize = true;
        title.Location = P(84, 18);
        subtitle.Text = installed == null
            ? "Version " + BuildInfo.Version + ". Read your OneNote notes like a PDF. It installs for your Windows account only, with no administrator rights."
            : "Version " + installed + " is installed. This replaces it with version " + BuildInfo.Version + ", and keeps your notes, highlights and settings.";
        subtitle.ForeColor = Muted;
        subtitle.Bounds = R(86, 50, 410, 36);

        body.Bounds = R(0, 98, 520, 204);
        notesBox.Bounds = R(24, 46, 380, 25);
        notesBox.Text = Setup.PreviousNotes() ?? Setup.DefaultNotes;
        Button browse = new Button();
        browse.Text = "Browse\u2026";
        browse.Bounds = R(410, 45, 86, 27);
        browse.UseVisualStyleBackColor = true;
        browse.Click += OnBrowse;
        bool hasFirefox = Setup.FirefoxInstalled();
        edge.Text = "Microsoft Edge";
        edge.AutoSize = true;
        edge.Location = P(24, 112);
        firefox.Text = hasFirefox ? "Firefox" : "Firefox (not installed)";
        firefox.Enabled = hasFirefox;
        firefox.AutoSize = true;
        firefox.Location = P(172, 112);
        if (hasFirefox && Setup.ConfiguredBrowser() == "firefox") firefox.Checked = true; else edge.Checked = true;
        body.Controls.AddRange(new Control[] {
            Heading("Notes folder", 24, 2),
            Hint("Exports from OneNote go here, and Mnote Reader opens it.", 24, 22, 472, 20),
            notesBox, browse,
            Heading("Open the reader in", 24, 88),
            edge, firefox,
            Hint("It installs to " + Setup.InstallDir + ". It adds Mnote Reader and Export OneNote to Mnote to the Start menu, and opens .mnote and .mnotebook files.", 24, 146, 472, 52),
        });

        doneText.Bounds = R(24, 104, 472, 150);
        doneText.Visible = false;
        openNow.Text = "Open Mnote Reader now";
        openNow.Checked = true;
        openNow.AutoSize = true;
        openNow.Location = P(24, 262);
        openNow.Visible = false;

        Panel rule = new Panel();
        rule.Bounds = R(0, 307, 520, 1);
        rule.BackColor = Color.FromArgb(226, 224, 233);
        Panel footer = new Panel();
        footer.Bounds = R(0, 308, 520, 48);
        footer.BackColor = Color.FromArgb(244, 243, 248);
        status.Bounds = R(24, 15, 270, 20);
        status.ForeColor = Muted;
        main.Text = installed == null ? "Install" : "Update";
        main.Bounds = R(316, 10, 86, 28);
        main.UseVisualStyleBackColor = true;
        main.Click += OnMain;
        cancel.Text = "Cancel";
        cancel.Bounds = R(410, 10, 86, 28);
        cancel.UseVisualStyleBackColor = true;
        cancel.Click += delegate { Close(); };
        footer.Controls.AddRange(new Control[] { status, main, cancel });
        AcceptButton = main;
        CancelButton = cancel;

        Controls.AddRange(new Control[] { logo, title, subtitle, body, doneText, openNow, rule, footer });
        ResumeLayout(false);
        PerformLayout();
    }

    static Label Heading(string text, int x, int y)
    {
        Label l = new Label();
        l.Text = text;
        l.AutoSize = true;
        l.Location = P(x, y);
        l.Font = new Font("Segoe UI Semibold", 9F);
        return l;
    }

    static Label Hint(string text, int x, int y, int w, int h)
    {
        Label l = new Label();
        l.Text = text;
        l.Bounds = R(x, y, w, h);
        l.ForeColor = Muted;
        return l;
    }

    void OnBrowse(object sender, EventArgs e)
    {
        using (FolderBrowserDialog d = new FolderBrowserDialog())
        {
            d.Description = "Choose the folder for your exported notes.";
            d.SelectedPath = notesBox.Text;
            if (d.ShowDialog(this) == DialogResult.OK) notesBox.Text = d.SelectedPath;
        }
    }

    void OnMain(object sender, EventArgs e)
    {
        if (finished)
        {
            if (openNow.Checked) Setup.OpenReader();
            Close();
            return;
        }
        string notes = notesBox.Text.Trim();
        if (notes.Length == 0 || !Path.IsPathRooted(notes))
        {
            MessageBox.Show(this, "Type or choose the full path of a folder for your notes, such as " + Setup.DefaultNotes + ".", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        string browser = firefox.Checked ? "firefox" : "edge";
        SetBusy(true);
        Thread worker = new Thread(() =>
        {
            string output = null;
            Exception error = null;
            try { output = Setup.Install(notes, browser); }
            catch (Exception ex) { error = ex; }
            BeginInvoke((Action)(() => Done(Path.GetFullPath(notes), output, error)));
        });
        worker.IsBackground = true;
        worker.Start();
    }

    void Done(string notes, string output, Exception error)
    {
        SetBusy(false);
        if (error != null)
        {
            Setup.ShowError(this, "Mnote Reader could not be installed.", error);
            return;
        }
        finished = true;
        Result = 0;
        title.Text = "Mnote Reader is installed";
        subtitle.Text = "Open it from the Start menu, or double-click any .mnote or .mnotebook file.";
        body.Visible = false;
        doneText.Text = "To export your notes, open the OneNote desktop app with your notebooks, then choose Export OneNote to Mnote in the Start menu. Your notes go to " + notes + "." + Setup.Warnings(output);
        doneText.Visible = true;
        openNow.Visible = true;
        main.Text = "Finish";
        cancel.Visible = false;
        main.Focus();
    }

    void SetBusy(bool on)
    {
        busy = on;
        body.Enabled = main.Enabled = cancel.Enabled = !on;
        status.Text = on ? "Installing\u2026" : "";
        UseWaitCursor = on;
    }

    // Start on the Install button rather than in the folder box. A control can only take focus
    // once the window is visible, so not in the constructor.
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        main.Focus();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (busy) e.Cancel = true;
        base.OnFormClosing(e);
    }
}
