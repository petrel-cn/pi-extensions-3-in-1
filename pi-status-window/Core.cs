// pi-status-window —— Pi 悬浮状态窗口
// Pi Floating Status Window — shows Pi's runtime status in an always-on-top
// frameless window. Polls %TEMP%/pi-status.json (pi-status extension) and
// %TEMP%/pi-balance.json (balance extension).
//
// Compiled with the .NET Framework 4.x csc.exe (C# 5), so this file must
// stay compatible with C# 5: no string interpolation, no null-conditional
// operators, no expression-bodied members.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PiStatusWindow
{
    // ------------------------------------------------------------------
    // Native interop (user32)
    // ------------------------------------------------------------------
    internal static class Native
    {
        public const int HWND_TOPMOST = -1;
        public const int HWND_NOTOPMOST = -2;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        public const int WM_NCHITTEST = 0x0084;
        public const int HTCLIENT = 1;
        public const int HTLEFT = 10;
        public const int HTRIGHT = 11;
        public const int HTTOP = 12;
        public const int HTTOPLEFT = 13;
        public const int HTTOPRIGHT = 14;
        public const int HTBOTTOM = 15;
        public const int HTBOTTOMLEFT = 16;
        public const int HTBOTTOMRIGHT = 17;
        public const int HT_CAPTION = 2;

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, int hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOPMOST = 0x00000008;

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        public const int SW_RESTORE = 9;

        // --- fullscreen detection (exclusive fullscreen) ---
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        public const uint MONITOR_DEFAULTTOPRIMARY = 1;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public uint cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }
    }

    // ------------------------------------------------------------------
    // Status model (mirrors pi-status.json)
    // ------------------------------------------------------------------
    internal class StatusModel
    {
        public string status = "idle";        // idle|thinking|working|asking|approval|done
        public string language = "en";        // en|zh
        public SummaryModel summary;          // nullable
        public double? cacheHitRate;          // percent, nullable
        public double? contextPercent;        // percent, nullable
        public long ts = 0;

        public bool HasSummary { get { return summary != null; } }
    }

    internal class SummaryModel
    {
        public string action = "";            // idle|thinking|tool|file|output|asking|approval|done
        public string name;                   // nullable
    }

    // ------------------------------------------------------------------
    // Balance model (mirrors pi-balance.json)
    // ------------------------------------------------------------------
    internal class BalanceModel
    {
        public string balance = "";           // rendered text like "💰 ￥110.00"
        public string kind = "unsupported";   // ok|unsupported|error
        public long ts = 0;
    }

    // ------------------------------------------------------------------
    // Localized strings (en / zh)
    // ------------------------------------------------------------------
    internal class Strings
    {
        public string TitleIdle;
        public string TitleThinking;
        public string TitleWorking;
        public string TitleAsking;
        public string TitleApproval;
        public string TitleDone;
        public string TitleClosed;
        public string BodyIdle;
        public string BodyThinking;
        public string BodyAsking;
        public string BodyApproval;
        public string BodyDone;
        public string BodyWorkingTool;   // {0} = name
        public string BodyWorkingFile;   // {0} = name
        public string BodyWorkingOutput;
        public string BodyClosed;        // Pi not running / offline
        public string LabelCache;
        public string LabelContext;
        public string LabelBalance;
        public string BalanceUnavailable;
        public string BalanceUnsupported;
        public string TrayShow;
        public string TrayExit;
        public string Tooltip;
        public string StatusUnknown;

        public static Strings For(string lang)
        {
            if (lang == "zh") return Zh();
            return En();
        }

        private static Strings En()
        {
            Strings s = new Strings();
            s.TitleIdle = "Pi idle";
            s.TitleThinking = "Pi thinking";
            s.TitleWorking = "Pi working";
            s.TitleAsking = "Pi asks you";
            s.TitleApproval = "Pi needs approval";
            s.TitleDone = "Pi done";
            s.TitleClosed = "Pi closed";
            s.BodyIdle = "Pi is waiting for your instruction";
            s.BodyThinking = "Pi is thinking…";
            s.BodyAsking = "Pi paused: a question needs your confirmation";
            s.BodyApproval = "Pi is waiting for your approval";
            s.BodyDone = "Pi's work is complete — awaiting your review!";
            s.BodyWorkingTool = "Tool: {0}";
            s.BodyWorkingFile = "File: {0}";
            s.BodyWorkingOutput = "Outputting…";
            s.BodyClosed = "Pi Agent is currently closed";
            s.LabelCache = "Cache hit rate";
            s.LabelContext = "Context";
            s.LabelBalance = "Balance";
            s.BalanceUnavailable = "Balance unavailable";
            s.BalanceUnsupported = "N/A";
            s.TrayShow = "Show window";
            s.TrayExit = "Exit";
            s.Tooltip = "Pi status";
            s.StatusUnknown = "…";
            return s;
        }

        private static Strings Zh()
        {
            Strings s = new Strings();
            s.TitleIdle = "正在待命";
            s.TitleThinking = "思考中";
            s.TitleWorking = "工作中";
            s.TitleAsking = "向您询问";
            s.TitleApproval = "需要审批";
            s.TitleDone = "工作完成";
            s.TitleClosed = "已关闭";
            s.BodyIdle = "Pi正在等待您的指令";
            s.BodyThinking = "Pi正在进行思考……";
            s.BodyAsking = "Pi当前已暂停工作，有问题需要您的确认";
            s.BodyApproval = "Pi正在等待您的审批";
            s.BodyDone = "Pi的工作已经全部完成，等待您的验收！";
            s.BodyWorkingTool = "工具：{0}";
            s.BodyWorkingFile = "文件：{0}";
            s.BodyWorkingOutput = "正在输出……";
            s.BodyClosed = "当前 Pi Agent 已经关闭";
            s.LabelCache = "缓存命中率";
            s.LabelContext = "上下文";
            s.LabelBalance = "余额";
            s.BalanceUnavailable = "余额不可用";
            s.BalanceUnsupported = "N/A";
            s.TrayShow = "显示窗口";
            s.TrayExit = "退出";
            s.Tooltip = "Pi 状态";
            s.StatusUnknown = "…";
            return s;
        }
    }

    // ------------------------------------------------------------------
    // Config persistence (window size / position / pin state)
    // ------------------------------------------------------------------
    internal class AppConfig
    {
        public int Width = 300;
        public int Height = 250;
        public int X = -1;   // -1 = unset
        public int Y = -1;
        public bool Pinned = true;

        private static string ConfigPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "pi-status-window");
            return Path.Combine(dir, "config.json");
        }

        public static AppConfig Load()
        {
            AppConfig c = new AppConfig();
            try
            {
                string path = ConfigPath();
                if (File.Exists(path))
                {
                    string json = File.ReadAllText(path);
                    JavaScriptParse p = new JavaScriptParse(json);
                    p.TryGetInt("width", ref c.Width);
                    p.TryGetInt("height", ref c.Height);
                    p.TryGetInt("x", ref c.X);
                    p.TryGetInt("y", ref c.Y);
                    p.TryGetBool("pinned", ref c.Pinned);
                }
            }
            catch (Exception) { /* fall back to defaults */ }
            return c;
        }

        public void Save()
        {
            try
            {
                string dir = Path.GetDirectoryName(ConfigPath());
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"width\":").Append(Width)
                  .Append(",\"height\":").Append(Height)
                  .Append(",\"x\":").Append(X)
                  .Append(",\"y\":").Append(Y)
                  .Append(",\"pinned\":").Append(Pinned ? "true" : "false")
                  .Append("}");
                File.WriteAllText(ConfigPath(), sb.ToString());
            }
            catch (Exception) { /* best effort */ }
        }
    }

    // ------------------------------------------------------------------
    // Tiny JSON parser (C# 5 friendly) — enough for our flat objects
    // ------------------------------------------------------------------
    internal class JavaScriptParse
    {
        private string _s;
        private int _i;

        public JavaScriptParse(string s)
        {
            _s = s == null ? "" : s;
            _i = 0;
        }

        private void SkipWs()
        {
            while (_i < _s.Length && char.IsWhiteSpace(_s[_i])) _i++;
        }

        private string ReadKey()
        {
            SkipWs();
            if (_i >= _s.Length || _s[_i] != '"') return null;
            _i++;
            StringBuilder sb = new StringBuilder();
            while (_i < _s.Length && _s[_i] != '"')
            {
                if (_s[_i] == '\\' && _i + 1 < _s.Length)
                {
                    _i++;
                    char c = _s[_i];
                    switch (c)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        default: sb.Append(c); break;
                    }
                }
                else sb.Append(_s[_i]);
                _i++;
            }
            _i++; // closing quote
            return sb.ToString();
        }

        /// <summary>Find the value of a top-level key. Returns null when missing.</summary>
        public string Get(string key)
        {
            _i = 0;
            while (true)
            {
                SkipWs();
                if (_i >= _s.Length) return null;
                if (_s[_i] == '{' || _s[_i] == '}' || _s[_i] == ',') { _i++; continue; }
                string k = ReadKey();
                SkipWs();
                if (_i < _s.Length && _s[_i] == ':') _i++;
                SkipWs();
                if (k != null && k == key)
                {
                    return ReadValue();
                }
                // skip this value and continue scanning
                SkipValue();
            }
        }

        private string ReadValue()
        {
            SkipWs();
            if (_i >= _s.Length) return null;
            char c = _s[_i];
            if (c == '"')
            {
                return ReadKey(); // reuse string reader
            }
            int start = _i;
            int depth = 0;
            while (_i < _s.Length)
            {
                char ch = _s[_i];
                if (ch == '{' || ch == '[') depth++;
                else if (ch == '}' || ch == ']')
                {
                    if (depth == 0) break;
                    depth--;
                }
                else if (ch == ',' && depth == 0) break;
                _i++;
            }
            return _s.Substring(start, _i - start).Trim();
        }

        private void SkipValue()
        {
            SkipWs();
            if (_i >= _s.Length) return;
            char c = _s[_i];
            if (c == '"')
            {
                ReadKey();
                return;
            }
            int depth = 0;
            while (_i < _s.Length)
            {
                char ch = _s[_i];
                if (ch == '{' || ch == '[') depth++;
                else if (ch == '}' || ch == ']')
                {
                    if (depth == 0) return;
                    depth--;
                }
                else if (ch == ',' && depth == 0) return;
                _i++;
            }
        }

        public void TryGetInt(string key, ref int dest)
        {
            string v = Get(key);
            if (v == null) return;
            int parsed;
            if (int.TryParse(v.Trim('"'), out parsed)) dest = parsed;
        }

        public void TryGetBool(string key, ref bool dest)
        {
            string v = Get(key);
            if (v == null) return;
            string t = v.Trim().ToLowerInvariant();
            if (t == "true") dest = true;
            else if (t == "false") dest = false;
        }

        public string GetString(string key)
        {
            string v = Get(key);
            if (v == null) return null;
            return v.Trim('"');
        }

        public double? GetDouble(string key)
        {
            string v = Get(key);
            if (v == null) return null;
            double d;
            if (double.TryParse(v.Trim('"'), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
            return null;
        }
    }
}
