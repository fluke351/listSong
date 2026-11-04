// listSong.exe — single-file installer + launcher, with no console window.
// The app files (server.js, public\, setup.ps1 ...) are embedded as app.zip. On every start they are
// unpacked to %LOCALAPPDATA%\listSong (queue, cache and downloaded tools there are kept), then
// setup.ps1 prepares the machine and node runs the server in the background.
// Everything they print goes to data\listSong.log; if something fails, a message box says so.
// Built by build.ps1 with the C# 5 compiler that ships with Windows (.NET Framework 4.x).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("คิวเพลง")]
[assembly: AssemblyDescription("คิวเพลง YouTube สำหรับวง LAN (ไม่มีโฆษณา)")]
[assembly: AssemblyProduct("listSong")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Launcher
{
    static StreamWriter log;
    static readonly object logLock = new object();
    static readonly Queue<string> lastLines = new Queue<string>(); // shown in the error box

    [STAThread]
    static int Main(string[] args)
    {
        string home = Environment.GetEnvironmentVariable("LISTSONG_HOME"); // override for testing
        if (string.IsNullOrEmpty(home))
            home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "listSong");
        string logFile = Path.Combine(home, "data", "listSong.log");

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));
            OpenLog(logFile);
            ExtractApp(home);

            string self = Assembly.GetExecutingAssembly().Location;
            string installedExe = Path.Combine(home, "listSong.exe");
            // setup.ps1 also closes an older copy that is still running
            string setupArgs = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(home, "setup.ps1") + "\"";
            if (args.Length > 0) setupArgs += " " + string.Join(" ", args);
            int code = Run("powershell.exe", setupArgs, home, installedExe);
            if (code != 0) return Fail("เตรียมโปรแกรมไม่สำเร็จ", logFile, code);

            // keep a copy of this exe next to the app, so the desktop shortcut still works after the download is deleted.
            // Done after setup: the old copy's file is locked until it has been closed, and a shortcut left on the
            // old exe would unpack the old version again next time.
            if (!SamePath(self, installedExe))
            {
                for (int i = 0; ; i++)
                {
                    try { File.Copy(self, installedExe, true); break; }
                    catch (IOException) { if (i >= 10) break; System.Threading.Thread.Sleep(300); }
                }
            }

            string node = FindOnPath("node.exe") ?? Path.Combine(home, "bin", "node.exe");
            code = Run(node, "server.js", home, installedExe);
            // 0 = closed on purpose (the close button, or another copy was already running).
            // Stopped while a newer copy now answers on the port = replaced by an update, not a crash.
            if (code == 0 || AnotherCopyRunning()) return 0;
            return Fail("โปรแกรมคิวเพลงหยุดทำงาน", logFile, code);
        }
        catch (Exception e)
        {
            Write("เกิดข้อผิดพลาด: " + e.Message);
            return Fail("เกิดข้อผิดพลาด: " + e.Message, logFile, 1);
        }
    }

    static void OpenLog(string file)
    {
        try { if (File.Exists(file)) File.Copy(file, file + ".old", true); } catch (IOException) { }
        try { log = new StreamWriter(file, false, new UTF8Encoding(false)); log.AutoFlush = true; }
        catch (IOException) { log = null; } // an older copy still holds it; carry on without a log
    }

    static void Write(string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            lastLines.Enqueue(line);
            while (lastLines.Count > 12) lastLines.Dequeue();
            if (log != null) try { log.WriteLine(line); } catch (IOException) { }
        }
    }

    static void ExtractApp(string home)
    {
        string root = Path.GetFullPath(home) + Path.DirectorySeparatorChar;
        using (Stream zipStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))
        using (ZipArchive zip = new ZipArchive(zipStream, ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string name = entry.FullName.Replace('\\', '/');
                if (name.EndsWith("/")) continue;
                string dest = Path.GetFullPath(Path.Combine(home, name.Replace('/', Path.DirectorySeparatorChar)));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                using (Stream src = entry.Open())
                using (FileStream dst = File.Create(dest))
                {
                    src.CopyTo(dst);
                }
            }
        }
    }

    // runs hidden; its output goes to the log
    static int Run(string file, string arguments, string workDir, string launcher)
    {
        ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.WorkingDirectory = workDir;
        psi.EnvironmentVariables["LISTSONG_LAUNCHER"] = launcher;
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPEN_BROWSER")))
            psi.EnvironmentVariables["OPEN_BROWSER"] = "1";
        using (Process p = new Process())
        {
            p.StartInfo = psi;
            p.OutputDataReceived += (s, e) => Write(e.Data);
            p.ErrorDataReceived += (s, e) => Write(e.Data);
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    static bool AnotherCopyRunning()
    {
        string port = Environment.GetEnvironmentVariable("PORT");
        if (string.IsNullOrEmpty(port)) port = "3100";
        for (int i = 0; i < 10; i++) // the new copy may still be starting
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/info");
                req.Proxy = null;
                req.Timeout = 2000;
                using (WebResponse res = req.GetResponse()) return true;
            }
            catch (WebException) { System.Threading.Thread.Sleep(1000); }
        }
        return false;
    }

    static string FindOnPath(string exe)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(Path.PathSeparator))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim().Trim('"'), exe);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* malformed PATH entry */ }
        }
        return null;
    }

    static bool SamePath(string a, string b)
    {
        return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }

    static int Fail(string title, string logFile, int code)
    {
        string tail;
        lock (logLock) tail = string.Join("\n", lastLines.ToArray());
        MessageBox.Show(title + "\n\n" + tail + "\n\nรายละเอียดทั้งหมดอยู่ที่\n" + logFile,
            "คิวเพลง", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return code;
    }
}
