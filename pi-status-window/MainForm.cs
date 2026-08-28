// pi-status-window —— 主窗体
// Main window: frameless three-section floating window.
// C# 5 compatible (compiled with .NET Framework 4.x csc.exe).
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace PiStatusWindow
{
    internal class MainForm : Form
    {
        // ------------------------------------------------------------------
        // Layout constants (px)
        // ------------------------------------------------------------------
        private const int TitleHeight = 34;
        private const int FooterHeight = 30;
        private const int BtnWidth = 34;
        private const int BtnHeight = 26;
        private const int BtnTop = 4;

        // Colors (mirror the reference screenshots)
        private static readonly Color CTitleBar = Color.FromArgb(212, 220, 229);   // #D4DCE5
        private static readonly Color CFooter = Color.FromArgb(212, 220, 229);
        private static readonly Color CContent = Color.White;
        private static readonly Color CText = Color.FromArgb(40, 40, 40);
        private static readonly Color CTextDim = Color.FromArgb(110, 110, 110);
        private static readonly Color CPinActive = Color.FromArgb(59, 74, 90);      // #3B4A5A
        private static readonly Color CPinHover = Color.FromArgb(80, 96, 116);
        private static readonly Color CBtnHover = Color.FromArgb(200, 208, 217);
        private static readonly Color CBtnCloseHover = Color.FromArgb(232, 17, 35);
        private static readonly Color CBorder = Color.FromArgb(160, 170, 182);
        private static readonly Color CDotIdle = Color.FromArgb(255, 193, 7);        // yellow — idle 待命
        private static readonly Color CDotThinking = Color.FromArgb(33, 150, 243);   // blue — thinking 思考
        private static readonly Color CDotWorking = Color.FromArgb(67, 160, 71);     // green — working 工作
        private static readonly Color CDotApproval = Color.FromArgb(229, 57, 53);    // red — approval 审批
        private static readonly Color CDotClosed = Color.FromArgb(158, 158, 158);    // gray — closed 已关闭

        // Icon glyphs (Segoe Fluent Icons / MDL2 codepoints)
        private const char GLYPH_PIN = '\uE718';        // Pin
        private const char GLYPH_MINIMIZE = '\uE921';   // ChromeMinimize
        private const char GLYPH_RESTORE = '\uE923';    // ChromeRestore
        private const char GLYPH_CLOSE = '\uE8BB';      // ChromeClose

        // Status files
        private static readonly string StatusPath = Path.Combine(Path.GetTempPath(), "pi-status.json");
        private static readonly string BalancePath = Path.Combine(Path.GetTempPath(), "pi-balance.json");

        // ------------------------------------------------------------------
        // State
        // ------------------------------------------------------------------
        private AppConfig _config;
        private StatusModel _status = new StatusModel();
        private BalanceModel _balance = new BalanceModel();
        private Strings _str;

        private bool _pinned;
        private bool _collapsed;                 // minimized to title bar only
        private bool _mouseDown;
        private Point _dragStart;
        private bool _dragging;
        private string _hoverBtn;                // "pin" | "min" | "close" | null
        private Timer _pollTimer;
        private NotifyIcon _tray;
        private Font _uiFont;
        private Font _titleFont;
        private Font _iconFont;
        private Font _glyphFont;

        // hit-test resize margin
        private const int ResizeMargin = 6;

        public MainForm()
        {
            _config = AppConfig.Load();
            _pinned = _config.Pinned;
            _str = Strings.For(_status.language);

            Text = "Pi Status";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;

            // restore saved size / position
            Size = new Size(_config.Width, _config.Height);
            if (_config.X >= 0 && _config.Y >= 0)
                Location = new Point(_config.X, _config.Y);
            else
                Location = new Point(
                    Screen.PrimaryScreen.WorkingArea.Right - Width - 20,
                    Screen.PrimaryScreen.WorkingArea.Bottom - Height - 40);

            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

            _uiFont = new Font("Segoe UI", 9f);
            _titleFont = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            _iconFont = new Font("Segoe UI", 9f);
            _glyphFont = PickGlyphFont();

            SetupTray();

            _pollTimer = new Timer();
            _pollTimer.Interval = 300;
            _pollTimer.Tick += OnPollTick;
            _pollTimer.Start();

            ApplyTopMost();
        }

        // ------------------------------------------------------------------
        // Glyph font selection: prefer Segoe Fluent Icons, fall back to MDL2
        // ------------------------------------------------------------------
        private Font PickGlyphFont()
        {
            string[] candidates = new string[] { "Segoe Fluent Icons", "Segoe MDL2 Assets" };
            foreach (string name in candidates)
            {
                try
                {
                    Font f = new Font(name, 11f);
                    // verify the font is real by checking family name
                    if (f.FontFamily.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)
                        return f;
                    f.Dispose();
                }
                catch (Exception) { /* try next */ }
            }
            return new Font("Segoe UI", 11f);
        }

        // ------------------------------------------------------------------
        // Top-most control
        // ------------------------------------------------------------------
        private void ApplyTopMost()
        {
            if (_pinned)
            {
                Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                    Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            }
            else
            {
                Native.SetWindowPos(Handle, Native.HWND_NOTOPMOST, 0, 0, 0, 0,
                    Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            }
            _config.Pinned = _pinned;
            _config.Save();
            Invalidate();
        }

        // ------------------------------------------------------------------
        // Collapse / restore (minimize to title bar)
        // ------------------------------------------------------------------
        private void SetCollapsed(bool collapsed)
        {
            _collapsed = collapsed;
            if (collapsed)
            {
                // shrink to title bar height only
                Height = TitleHeight + 2;
            }
            else
            {
                Height = _config.Height;
            }
            Invalidate();
        }

        private bool IsCollapsed { get { return _collapsed; } }

        // ------------------------------------------------------------------
        // Tray icon
        // ------------------------------------------------------------------
        private void SetupTray()
        {
            _tray = new NotifyIcon();
            _tray.Text = _str.Tooltip;
            _tray.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            _tray.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem showItem = new ToolStripMenuItem(_str.TrayShow);
            showItem.Click += delegate(object s, EventArgs e)
            {
                ShowWindowFromTray();
            };
            ToolStripMenuItem exitItem = new ToolStripMenuItem(_str.TrayExit);
            exitItem.Click += delegate(object s, EventArgs e)
            {
                _pollTimer.Stop();
                _tray.Visible = false;
                Application.Exit();
            };
            menu.Items.Add(showItem);
            menu.Items.Add(exitItem);
            _tray.ContextMenuStrip = menu;

            _tray.DoubleClick += delegate(object s, EventArgs e)
            {
                ShowWindowFromTray();
            };
        }

        private void ShowWindowFromTray()
        {
            if (_collapsed) SetCollapsed(false);
            Native.ShowWindow(Handle, Native.SW_RESTORE);
            Native.SetForegroundWindow(Handle);
        }

        // ------------------------------------------------------------------
        // Polling
        // ------------------------------------------------------------------
        private void OnPollTick(object sender, EventArgs e)
        {
            StatusModel newStatus = ReadStatus();
            BalanceModel newBalance = ReadBalance();
            bool changed = false;

            if (newStatus != null)
            {
                // 心跳超时检测：状态文件 ts 超过 15 秒未更新说明 Pi 进程已退出
                // （扩展每 5 秒心跳一次）。超时则强制显示「已关闭」。
                // Heartbeat timeout: if the status file timestamp is older than
                // 15 s, the Pi process is gone — force the closed state.
                bool heartbeatDead = (DateTime.UtcNow - UnixTime(newStatus.ts)).TotalSeconds > 15;
                if (heartbeatDead && newStatus.status != "closed")
                {
                    newStatus.status = "closed";
                    newStatus.summary = null;
                }

                string oldLang = _status.language;
                if (newStatus.status != _status.status ||
                    newStatus.language != _status.language ||
                    !SameSummary(newStatus.summary, _status.summary) ||
                    newStatus.cacheHitRate != _status.cacheHitRate ||
                    newStatus.contextPercent != _status.contextPercent)
                {
                    changed = true;
                }
                _status = newStatus;
                if (_status.language != oldLang)
                {
                    _str = Strings.For(_status.language);
                    _tray.Text = _str.Tooltip;
                    UpdateTrayMenu();
                }
            }

            if (newBalance != null &&
                (newBalance.balance != _balance.balance || newBalance.kind != _balance.kind))
            {
                changed = true;
                _balance = newBalance;
            }

            if (changed) Invalidate();
        }

        private static DateTime UnixTime(long ts)
        {
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ts);
        }

        private static bool SameSummary(SummaryModel a, SummaryModel b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.action == b.action && a.name == b.name;
        }

        private StatusModel ReadStatus()
        {
            try
            {
                if (!File.Exists(StatusPath)) return null;
                string json = File.ReadAllText(StatusPath);
                JavaScriptParse p = new JavaScriptParse(json);
                StatusModel m = new StatusModel();
                m.status = p.GetString("status");
                if (m.status == null) m.status = "idle";
                m.language = p.GetString("language");
                if (m.language == null) m.language = "en";
                m.cacheHitRate = p.GetDouble("cacheHitRate");
                m.contextPercent = p.GetDouble("contextPercent");
                string summaryJson = p.Get("summary");
                if (summaryJson != null && summaryJson.Trim() != "null")
                {
                    JavaScriptParse sp = new JavaScriptParse(summaryJson);
                    SummaryModel sm = new SummaryModel();
                    sm.action = sp.GetString("action");
                    if (sm.action == null) sm.action = "";
                    sm.name = sp.GetString("name");
                    m.summary = sm;
                }
                long ts;
                string tsStr = p.GetString("ts");
                if (long.TryParse(tsStr, out ts)) m.ts = ts;
                return m;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private BalanceModel ReadBalance()
        {
            try
            {
                if (!File.Exists(BalancePath)) return null;
                string json = File.ReadAllText(BalancePath);
                JavaScriptParse p = new JavaScriptParse(json);
                BalanceModel m = new BalanceModel();
                m.balance = p.GetString("balance");
                if (m.balance == null) m.balance = "";
                m.kind = p.GetString("kind");
                if (m.kind == null) m.kind = "unsupported";
                return m;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ------------------------------------------------------------------
        // Layout helpers
        // ------------------------------------------------------------------
        private Rectangle TitleBarRect { get { return new Rectangle(0, 0, ClientSize.Width, TitleHeight); } }
        private Rectangle FooterRect
        {
            get
            {
                return new Rectangle(0, ClientSize.Height - FooterHeight,
                    ClientSize.Width, FooterHeight);
            }
        }
        private Rectangle ContentRect
        {
            get
            {
                int top = TitleHeight;
                int bottom = ClientSize.Height - FooterHeight;
                return new Rectangle(0, top, ClientSize.Width, Math.Max(0, bottom - top));
            }
        }

        private Rectangle BtnPinRect
        {
            get
            {
                int right = ClientSize.Width - BtnWidth * 3;
                return new Rectangle(right, BtnTop, BtnWidth, BtnHeight);
            }
        }
        private Rectangle BtnMinRect
        {
            get
            {
                int right = ClientSize.Width - BtnWidth * 2;
                return new Rectangle(right, BtnTop, BtnWidth, BtnHeight);
            }
        }
        private Rectangle BtnCloseRect
        {
            get
            {
                int right = ClientSize.Width - BtnWidth;
                return new Rectangle(right, BtnTop, BtnWidth, BtnHeight);
            }
        }

        // ------------------------------------------------------------------
        // Painting
        // ------------------------------------------------------------------
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            // title bar always painted
            Rectangle title = TitleBarRect;
            g.FillRectangle(new SolidBrush(CTitleBar), title);

            // border
            using (Pen pen = new Pen(CBorder))
            {
                g.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
            }

            DrawTitle(g, title);

            // collapsed: title bar only — no content, no footer
            if (!IsCollapsed)
            {
                Rectangle content = ContentRect;
                g.FillRectangle(new SolidBrush(CContent), content);

                Rectangle footer = FooterRect;
                g.FillRectangle(new SolidBrush(CFooter), footer);

                DrawContent(g, content);
                DrawFooter(g, footer);
            }

            base.OnPaint(e);
        }

        private void DrawTitle(Graphics g, Rectangle rect)
        {
            // title text, status dot drawn at the front (leftmost)
            string titleText = GetTitleText();
            Color dotColor = GetTitleDotColor();

            int textLeft = 10;
            int textTop = 8;
            int textHeight = TitleHeight - 6;
            int dotSize = 10;
            int spaceWidth = 8;   // 圆点与文字之间保留一个空格的宽度

            // 文本最大可用宽度：右侧为 3 个按钮预留空间
            int maxTextWidth = rect.Width - BtnWidth * 3 - textLeft - dotSize - spaceWidth;
            if (maxTextWidth < 10) maxTextWidth = 10;

            // 状态圆点：位于标题栏最前方（文字之前），按字体行高垂直居中
            if (dotColor != Color.Empty)
            {
                float fontHeight = _titleFont.GetHeight();
                int dotY = textTop + (int)(fontHeight / 2) - dotSize / 2;
                using (Brush b = new SolidBrush(dotColor))
                {
                    g.FillEllipse(b, textLeft, dotY, dotSize, dotSize);
                }
            }

            // 文字紧随圆点之后（无圆点状态时从左边距开始）
            int textX = textLeft + (dotColor == Color.Empty ? 0 : dotSize + spaceWidth);

            // 测量实际文本宽度；向上取整并留 1px 余量，避免边界差导致意外省略号
            SizeF textSize = g.MeasureString(titleText, _titleFont);
            int textWidth = (int)Math.Ceiling(textSize.Width) + 1;
            if (textWidth > maxTextWidth) textWidth = maxTextWidth;

            using (StringFormat sf = new StringFormat())
            {
                sf.FormatFlags = StringFormatFlags.NoWrap;
                sf.Trimming = StringTrimming.EllipsisCharacter;
                using (Brush b = new SolidBrush(CText))
                {
                    g.DrawString(titleText, _titleFont, b,
                        new RectangleF(textX, textTop, textWidth, textHeight), sf);
                }
            }

            // pin button
            DrawButton(g, BtnPinRect, "pin");
            // minimize / restore button
            DrawButton(g, BtnMinRect, "min");
            // close button
            DrawButton(g, BtnCloseRect, "close");
        }

        /// <summary>Title-bar status dot color, matching the title text mapping
        /// (asking / done both fall back to idle). Returns Color.Empty when the
        /// status has no dot.
        /// 标题栏状态圆点颜色，与标题文字映射一致（asking / done 统一为待命）。
        /// 无对应圆点状态时返回 Color.Empty。</summary>
        private Color GetTitleDotColor()
        {
            if (_status.status == "idle" || _status.status == "asking" || _status.status == "done")
                return CDotIdle;
            if (_status.status == "thinking") return CDotThinking;
            if (_status.status == "working") return CDotWorking;
            if (_status.status == "approval") return CDotApproval;
            if (_status.status == "closed") return CDotClosed;
            return Color.Empty;
        }

        private void DrawButton(Graphics g, Rectangle rect, string kind)
        {
            bool hover = _hoverBtn == kind;
            char glyph;
            bool pinActive = false;

            if (kind == "pin")
            {
                glyph = GLYPH_PIN;
                pinActive = _pinned;
            }
            else if (kind == "min")
            {
                glyph = _collapsed ? GLYPH_RESTORE : GLYPH_MINIMIZE;
            }
            else
            {
                glyph = GLYPH_CLOSE;
            }

            Brush bg = null;
            Color glyphColor = CText;

            if (kind == "pin")
            {
                if (pinActive)
                {
                    bg = new SolidBrush(hover ? CPinHover : CPinActive);
                    glyphColor = Color.White;
                }
                else if (hover)
                {
                    bg = new SolidBrush(CBtnHover);
                }
            }
            else if (kind == "close" && hover)
            {
                bg = new SolidBrush(CBtnCloseHover);
                glyphColor = Color.White;
            }
            else if (hover)
            {
                bg = new SolidBrush(CBtnHover);
            }

            if (bg != null)
            {
                g.FillRectangle(bg, rect);
            }

            TextRenderer.DrawText(g, glyph.ToString(), _glyphFont, rect, glyphColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.NoPadding);
        }

        private string GetTitleText()
        {
            string prefix = _status.language == "zh" ? "Pi：" : "Pi: ";
            // asking / done 不再单独显示，统一为待命中。
            // asking / done are no longer shown separately; both fall back to idle.
            if (_status.status == "idle" || _status.status == "asking" || _status.status == "done")
                return prefix + _str.TitleIdle;
            if (_status.status == "thinking") return prefix + _str.TitleThinking;
            if (_status.status == "working")
            {
                return prefix + GetWorkingTitle();
            }
            if (_status.status == "approval") return prefix + _str.TitleApproval;
            if (_status.status == "closed") return prefix + _str.TitleClosed;
            return "Pi";
        }

        /// <summary>Working-state title: show the action type only (short),
        ///   detailed file/command goes in the body area.
        ///  工作状态标题：只显示动作类型（简短），详细文件/命令在内容区显示。</summary>
        private string GetWorkingTitle()
        {
            if (_status.language == "zh")
            {
                if (_status.summary != null && _status.summary.action == "read") return "正在读文件";
                if (_status.summary != null && _status.summary.action == "write") return "正在写文件";
                if (_status.summary != null && _status.summary.action == "edit") return "正在编辑";
                if (_status.summary != null && _status.summary.action == "search") return "正在搜索";
                if (_status.summary != null && _status.summary.action == "tool") return "正在调用工具";
                return _str.TitleWorking;
            }
            else
            {
                if (_status.summary != null && _status.summary.action == "read") return "Reading";
                if (_status.summary != null && _status.summary.action == "write") return "Writing";
                if (_status.summary != null && _status.summary.action == "edit") return "Editing";
                if (_status.summary != null && _status.summary.action == "search") return "Searching";
                if (_status.summary != null && _status.summary.action == "tool") return "Running tool";
                return _str.TitleWorking;
            }
        }

        private void DrawContent(Graphics g, Rectangle rect)
        {
            if (rect.Height <= 0) return;

            Color dot = GetDotColor();
            if (dot != Color.Empty)
            {
                // measure text so the dot and the first text line share the same
                // vertical center (aligns dot with text baseline area)
                string body = GetBodyText();
                SizeF textSize = g.MeasureString(body, _uiFont, rect.Width - 36 - 10);
                float lineHeight = textSize.Height;
                float textTop = rect.Top + Math.Max(6, (rect.Height - lineHeight) / 2);

                int dotSize = 12;
                int dotX = 14;
                int dotY = (int)(textTop + lineHeight / 2 - dotSize / 2);
                using (Brush b = new SolidBrush(dot))
                {
                    g.FillEllipse(b, dotX, dotY, dotSize, dotSize);
                }

                using (Brush b = new SolidBrush(CText))
                {
                    g.DrawString(body, _uiFont, b,
                        new RectangleF(36, textTop, rect.Width - 36 - 10, rect.Height - 8));
                }
            }
            else
            {
                DrawContentText(g, rect, 14);
            }
        }

        private void DrawContentText(Graphics g, Rectangle rect, int left)
        {
            string body = GetBodyText();
            // 垂直居中、水平左对齐（与有圆点状态一致）。
            // Vertically centered, horizontally left-aligned (same as dot states).
            SizeF textSize = g.MeasureString(body, _uiFont, rect.Width - left - 10);
            float lineHeight = textSize.Height;
            float textTop = rect.Top + Math.Max(6, (rect.Height - lineHeight) / 2);
            using (Brush b = new SolidBrush(CText))
            {
                g.DrawString(body, _uiFont, b,
                    new RectangleF(left, textTop, rect.Width - left - 10, rect.Height - 8));
            }
        }

        private Color GetDotColor()
        {
            // Every status has a colored dot:
            // idle 待命=黄, thinking 思考=蓝, working 工作=绿,
            // approval 审批=红, closed 已关闭=灰.
            if (_status.status == "idle") return CDotIdle;
            if (_status.status == "thinking") return CDotThinking;
            if (_status.status == "working") return CDotWorking;
            if (_status.status == "approval") return CDotApproval;
            if (_status.status == "closed") return CDotClosed;
            return Color.Empty;
        }

        private string GetBodyText()
        {
            // asking / done 不再单独显示，统一为待命文案。
            // asking / done are no longer shown separately; both fall back to idle.
            if (_status.status == "idle" || _status.status == "asking" || _status.status == "done")
                return _str.BodyIdle;
            if (_status.status == "thinking") return _str.BodyThinking;
            if (_status.status == "approval")
            {
                if (_status.HasSummary && !string.IsNullOrEmpty(_status.summary.name))
                    return _str.BodyApproval + " (" + _status.summary.name + ")";
                return _str.BodyApproval;
            }
            if (_status.status == "closed") return _str.BodyClosed;
            if (_status.status == "working")
            {
                if (_status.HasSummary)
                {
                    if ((_status.summary.action == "tool" ||
                         _status.summary.action == "read" ||
                         _status.summary.action == "write" ||
                         _status.summary.action == "edit" ||
                         _status.summary.action == "search") &&
                        _status.summary.name != null)
                        return string.Format(_str.BodyWorkingTool, _status.summary.name);
                    if (_status.summary.action == "output") return _str.BodyWorkingOutput;
                }
                return _str.BodyWorkingOutput;
            }
            return _str.BodyClosed;
        }

        private void DrawFooter(Graphics g, Rectangle rect)
        {
            // Sequential layout: measure each item and advance x like people
            // queuing up, so nothing ever overlaps regardless of text width.
            string cacheText = _str.LabelCache;
            string contextText = _str.LabelContext;
            string balanceText = _str.LabelBalance + ": " + FormatBalance();

            if (_status.cacheHitRate.HasValue)
                cacheText = _str.LabelCache + ": " + _status.cacheHitRate.Value.ToString("0.0") + "%";
            if (_status.contextPercent.HasValue)
                contextText = _str.LabelContext + ": " + _status.contextPercent.Value.ToString("0.0") + "%";

            using (Brush b = new SolidBrush(CTextDim))
            {
                float y = rect.Top + (rect.Height - _iconFont.GetHeight()) / 2;
                float x = 10;
                const float spacing = 8;

                x = DrawFooterItem(g, b, cacheText, x, y) + spacing;
                x = DrawFooterItem(g, b, contextText, x, y) + spacing;
                DrawFooterItem(g, b, balanceText, x, y);
            }
        }

        private float DrawFooterItem(Graphics g, Brush brush, string text, float x, float y)
        {
            if (text == null || text.Length == 0) return x;
            g.DrawString(text, _iconFont, brush, new PointF(x, y));
            SizeF size = g.MeasureString(text, _iconFont);
            return x + size.Width;
        }

        private string FormatBalance()
        {
            if (_balance == null || _balance.balance.Length == 0)
            {
                return _str.BalanceUnavailable;
            }
            // Strip any emoji / non-BMP prefix characters (💰 💵 etc.) — they
            // render as tofu boxes in GDI+. Keep only currency amount text.
            string cleaned = _balance.balance;
            int cut = 0;
            while (cut < cleaned.Length && char.IsSurrogate(cleaned[cut])) cut += 2;
            // also strip emoji that are single BMP chars in the emoji block
            while (cut < cleaned.Length && cleaned[cut] >= '\u2600' && cleaned[cut] <= '\u27BF') cut++;
            cleaned = cleaned.Substring(cut).Trim();
            if (cleaned.Length == 0) return _str.BalanceUnavailable;
            return cleaned;
        }

        // ------------------------------------------------------------------
        // Mouse handling
        // ------------------------------------------------------------------
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left)
            {
                base.OnMouseDown(e);
                return;
            }

            string btn = HitTestButton(e.Location);
            if (btn != null)
            {
                _mouseDown = true;
                return;
            }

            if (TitleBarRect.Contains(e.Location) && !IsCollapsed)
            {
                // window dragging
                _dragging = true;
                _dragStart = e.Location;
            }

            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            string newHover = HitTestButton(e.Location);
            if (newHover != _hoverBtn)
            {
                _hoverBtn = newHover;
                Invalidate();
            }

            if (_dragging)
            {
                Point delta = new Point(e.X - _dragStart.X, e.Y - _dragStart.Y);
                Location = new Point(Location.X + delta.X, Location.Y + delta.Y);
            }

            // resize cursor
            UpdateCursor(e.Location);

            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left)
            {
                base.OnMouseUp(e);
                return;
            }

            string btn = HitTestButton(e.Location);
            if (btn != null && _mouseDown)
            {
                HandleButtonClick(btn);
            }

            _mouseDown = false;
            _dragging = false;
            base.OnMouseUp(e);
        }

        private void HandleButtonClick(string btn)
        {
            if (btn == "pin")
            {
                _pinned = !_pinned;
                ApplyTopMost();
            }
            else if (btn == "min")
            {
                if (_collapsed) SetCollapsed(false);
                else SetCollapsed(true);
            }
            else if (btn == "close")
            {
                CloseWindow();
            }
        }

        private void CloseWindow()
        {
            _config.Save();
            _pollTimer.Stop();
            _tray.Visible = false;
            Application.Exit();
        }

        private string HitTestButton(Point p)
        {
            if (BtnPinRect.Contains(p)) return "pin";
            if (BtnMinRect.Contains(p)) return "min";
            if (BtnCloseRect.Contains(p)) return "close";
            return null;
        }

        private void UpdateCursor(Point p)
        {
            if (IsCollapsed)
            {
                Cursor = Cursors.Default;
                return;
            }
            Rectangle r = ClientRectangle;
            bool left = p.X <= ResizeMargin;
            bool right = p.X >= r.Width - ResizeMargin;
            bool top = p.Y <= ResizeMargin;
            bool bottom = p.Y >= r.Height - ResizeMargin;

            if (left && top) Cursor = Cursors.SizeNWSE;
            else if (right && bottom) Cursor = Cursors.SizeNWSE;
            else if (left && bottom) Cursor = Cursors.SizeNESW;
            else if (right && top) Cursor = Cursors.SizeNESW;
            else if (left || right) Cursor = Cursors.SizeWE;
            else if (top || bottom) Cursor = Cursors.SizeNS;
            else Cursor = Cursors.Default;
        }

        // ------------------------------------------------------------------
        // Resize via WM_NCHITTEST (custom frameless resize)
        // ------------------------------------------------------------------
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_NCHITTEST && !IsCollapsed)
            {
                Point screen = new Point((int)m.LParam & 0xFFFF, (int)((uint)m.LParam >> 16));
                Point client = PointToClient(screen);
                Rectangle r = ClientRectangle;

                // buttons first (they take precedence)
                if (HitTestButton(client) != null)
                {
                    m.Result = (IntPtr)Native.HTCLIENT;
                    return;
                }

                bool left = client.X <= ResizeMargin;
                bool right = client.X >= r.Width - ResizeMargin;
                bool top = client.Y <= ResizeMargin;
                bool bottom = client.Y >= r.Height - ResizeMargin;

                if (left && top) m.Result = (IntPtr)Native.HTTOPLEFT;
                else if (right && bottom) m.Result = (IntPtr)Native.HTBOTTOMRIGHT;
                else if (left && bottom) m.Result = (IntPtr)Native.HTBOTTOMLEFT;
                else if (right && top) m.Result = (IntPtr)Native.HTTOPRIGHT;
                else if (left) m.Result = (IntPtr)Native.HTLEFT;
                else if (right) m.Result = (IntPtr)Native.HTRIGHT;
                else if (top) m.Result = (IntPtr)Native.HTTOP;
                else if (bottom) m.Result = (IntPtr)Native.HTBOTTOM;
                else if (TitleBarRect.Contains(client)) m.Result = (IntPtr)Native.HT_CAPTION;
                else m.Result = (IntPtr)Native.HTCLIENT;
                return;
            }
            base.WndProc(ref m);
        }

        // ------------------------------------------------------------------
        // Lifecycle
        // ------------------------------------------------------------------
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (!IsCollapsed)
            {
                _config.Width = Width;
                _config.Height = Height;
                _config.Save();
            }
            Invalidate();
        }

        protected override void OnMove(EventArgs e)
        {
            base.OnMove(e);
            if (WindowState != FormWindowState.Minimized)
            {
                _config.X = Location.X;
                _config.Y = Location.Y;
                _config.Save();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _config.Save();
            if (_tray != null) _tray.Visible = false;
            base.OnFormClosing(e);
        }

        private void UpdateTrayMenu()
        {
            if (_tray.ContextMenuStrip == null) return;
            ContextMenuStrip menu = _tray.ContextMenuStrip;
            if (menu.Items.Count > 0 && menu.Items[0] is ToolStripMenuItem)
            {
                ((ToolStripMenuItem)menu.Items[0]).Text = _str.TrayShow;
            }
            if (menu.Items.Count > 1 && menu.Items[1] is ToolStripMenuItem)
            {
                ((ToolStripMenuItem)menu.Items[1]).Text = _str.TrayExit;
            }
            _tray.Text = _str.Tooltip;
        }
    }
}
