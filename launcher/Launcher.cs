// listSong.exe — single-file installer + launcher.
// The app files (server.js, public\, setup.ps1 ...) are embedded as app.zip. On every start they are
// unpacked to %LOCALAPPDATA%\listSong (queue, cache and downloaded tools there are kept), then
// setup.ps1 prepares the machine and node runs the server in this console window.
// Built by build.ps1 with the C# 5 compiler that ships with Windows (.NET Framework 4.x).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

[assembly: AssemblyTitle("คิวเพลง")]
[assembly: AssemblyDescription("คิวเพลง YouTube สำหรับวง LAN (ไม่มีโฆษณา)")]
[assembly: AssemblyProduct("listSong")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Launcher
{
    [DllImport("kernel32.dll")] static extern bool SetConsoleOutputCP(uint codePage);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCP(uint codePage);

    static int Main(string[] args)
    {
        // node and PowerShell inherit this console; UTF-8 keeps the Thai text readable
        SetConsoleOutputCP(65001);
        SetConsoleCP(65001);
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Title = "คิวเพลง";

        try
        {
            string home = Environment.GetEnvironmentVariable("LISTSONG_HOME"); // override for testing
            if (string.IsNullOrEmpty(home))
                home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "listSong");
            Directory.CreateDirectory(home);
            ExtractApp(home);

            string self = Assembly.GetExecutingAssembly().Location;
            string installedExe = Path.Combine(home, "listSong.exe");
            // setup.ps1 also closes an older copy that is still running
            string setupArgs = "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(home, "setup.ps1") + "\"";
            if (args.Length > 0) setupArgs += " " + string.Join(" ", args);
            int code = Run("powershell.exe", setupArgs, home, installedExe);
            if (code != 0) return Pause(code);

            // keep a copy of this exe next to the app, so the desktop shortcut still works after the download is deleted.
            // Done after setup: the old copy's file is locked until its window is closed, and a shortcut left on the
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
            return code == 0 ? 0 : Pause(code);
        }
        catch (Exception e)
        {
            Console.WriteLine();
            Console.WriteLine("  เกิดข้อผิดพลาด: " + e.Message);
            return Pause(1);
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

    static int Run(string file, string arguments, string workDir, string launcher)
    {
        ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
        psi.UseShellExecute = false; // share this console window
        psi.WorkingDirectory = workDir;
        psi.EnvironmentVariables["LISTSONG_LAUNCHER"] = launcher;
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPEN_BROWSER")))
            psi.EnvironmentVariables["OPEN_BROWSER"] = "1";
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
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

    static int Pause(int code)
    {
        Console.WriteLine();
        Console.WriteLine("  กด Enter เพื่อปิดหน้าต่างนี้");
        Console.ReadLine();
        return code;
    }
}
