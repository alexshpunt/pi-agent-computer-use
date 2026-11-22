// Pi session tile host: shows the windows of agents' isolated sessions as live tiles on the desktop layer, under the
// icons and above the wallpaper, and on a hotkey in a topmost click-through layer over all windows.
//
// Built on the machine that shows the tiles with the .NET Framework 4.8 compiler (C# 5) against the WebView2 SDK; see
// src/tile-host.ts. The tiles themselves are the page in page/: it connects to each session's stream hub
// (docs/session-streams.md) and decodes H.264 with WebCodecs. This program only places the window, keeps it in place,
// finds the sessions and tells the page about them.
//
// Desktop layer on Windows 11 24H2 and later: Progman holds SHELLDLL_DefView (the icons) and a WorkerW (the wallpaper).
// A layered child of Progman directly under DefView shows above the wallpaper and under every normal window; only
// DirectComposition content is composited there, which is why the tiles are a WebView2 page.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("Pi session tile host")]

namespace PiComputerUse.TileHost
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Options options;
            try { options = Options.Parse(args); }
            catch (ArgumentException error) { Console.Error.WriteLine(error.Message); return 2; }
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            using (var instance = new Instance())
            {
                if (!instance.TryTake()) return 0;
                Log.Open(options.LogFile);
                Log.Write("start pid " + Process.GetCurrentProcess().Id + ", sessions " + options.SessionsDirectory);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var host = new Host(options, instance);
                Application.Run(host);
                Log.Write("exit");
                return 0;
            }
        }
    }

    /// <summary>
    /// One host per user session shows every session of every Pi process: the running host owns this mutex. Pi's start
    /// script (src/tile-host.ts) starts a host only when nobody owns it; a leaving host releases it before its last look
    /// for sessions, so a session that opens while the host leaves is never left without tiles.
    /// </summary>
    sealed class Instance : IDisposable
    {
        public const string Name = @"Local\PiComputerUse.TileHost";
        readonly Mutex mutex = new Mutex(false, Name);
        public bool Owned { get; private set; }

        public bool TryTake()
        {
            if (Owned) return true;
            try { Owned = mutex.WaitOne(0); }
            // A host that ended without releasing it left it to the next one.
            catch (AbandonedMutexException) { Owned = true; }
            return Owned;
        }

        public void Release()
        {
            if (!Owned) return;
            mutex.ReleaseMutex();
            Owned = false;
        }

        public void Dispose() { Release(); mutex.Dispose(); }
    }

    sealed class Options
    {
        public string SessionsDirectory;
        public string PageDirectory;
        public string DataDirectory;
        public string LogFile;
        /// <summary>Raises the tiles over all windows and puts them back.</summary>
        public Hotkey Overlay = Hotkey.Parse("Ctrl+Alt+Space");
        /// <summary>Show the next or previous layer of tiles. Not Ctrl+Alt+arrows: Intel graphics drivers rotate the screen on them.</summary>
        public Hotkey NextLayer = Hotkey.Parse("Ctrl+Alt+PageDown");
        public Hotkey PreviousLayer = Hotkey.Parse("Ctrl+Alt+PageUp");
        public int IdleExitSeconds = 20;
        /// <summary>Chromium switches for the tile page: no network or component work a local page never needs.</summary>
        public string BrowserArguments = "--disable-background-networking --disable-component-update --no-pings --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,SpareRendererForSitePerProcess --autoplay-policy=no-user-gesture-required";

        public static Options Parse(string[] args)
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var root = Path.Combine(local, "PiComputerUse");
            var exeDirectory = Path.GetDirectoryName(Application.ExecutablePath);
            var options = new Options
            {
                SessionsDirectory = Path.Combine(root, "sessions"),
                PageDirectory = Path.Combine(exeDirectory, "page"),
                DataDirectory = Path.Combine(root, "tile-host", "webview2-data"),
                LogFile = Path.Combine(root, "tile-host", "host.log"),
            };
            for (var i = 0; i < args.Length; i++)
            {
                var name = args[i];
                if (i + 1 >= args.Length) throw new ArgumentException(name + " needs a value.");
                var value = args[++i];
                if (name == "--sessions") options.SessionsDirectory = value;
                else if (name == "--page") options.PageDirectory = value;
                else if (name == "--data") options.DataDirectory = value;
                else if (name == "--log") options.LogFile = value;
                else if (name == "--idle-exit")
                {
                    if (!int.TryParse(value, out options.IdleExitSeconds) || options.IdleExitSeconds < 0) throw new ArgumentException("--idle-exit needs a number of seconds: " + value + ".");
                }
                else if (name == "--hotkey") options.Overlay = Hotkey.Parse(value);
                else if (name == "--next-layer-hotkey") options.NextLayer = Hotkey.Parse(value);
                else if (name == "--previous-layer-hotkey") options.PreviousLayer = Hotkey.Parse(value);
                else if (name == "--browser-args") options.BrowserArguments = value;
                else throw new ArgumentException("Unknown option " + name + ".");
            }
            return options;
        }
    }

    /// <summary>A global hotkey such as "Ctrl+Alt+Space" or "Win+Shift+F12"; "none" turns it off.</summary>
    sealed class Hotkey
    {
        public uint Modifiers;
        public Keys Key;
        public string Text;
        public bool Off { get { return Key == Keys.None; } }

        public static Hotkey Parse(string text)
        {
            if (text.Equals("none", StringComparison.OrdinalIgnoreCase)) return new Hotkey { Key = Keys.None, Text = "none" };
            uint modifiers = 0;
            var key = Keys.None;
            foreach (var part in text.Split('+'))
            {
                var token = part.Trim();
                if (token.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) || token.Equals("Control", StringComparison.OrdinalIgnoreCase)) modifiers |= Native.MOD_CONTROL;
                else if (token.Equals("Alt", StringComparison.OrdinalIgnoreCase)) modifiers |= Native.MOD_ALT;
                else if (token.Equals("Shift", StringComparison.OrdinalIgnoreCase)) modifiers |= Native.MOD_SHIFT;
                else if (token.Equals("Win", StringComparison.OrdinalIgnoreCase)) modifiers |= Native.MOD_WIN;
                else if (key == Keys.None && Enum.TryParse(token, true, out key)) { }
                else throw new ArgumentException("Invalid hotkey " + text + ".");
            }
            if (key == Keys.None || modifiers == 0) throw new ArgumentException("A hotkey needs at least one modifier and one key: " + text + ".");
            return new Hotkey { Modifiers = modifiers, Key = key, Text = text };
        }
    }

    static class Log
    {
        static readonly object Gate = new object();
        static string file;

        public static void Open(string path)
        {
            file = path;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 1024 * 1024) File.Delete(path);
            }
            catch (Exception) { file = null; }
        }

        public static void Write(string message)
        {
            if (file == null) return;
            lock (Gate)
            {
                try { File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine); }
                catch (IOException) { }
            }
        }
    }

    /// <summary>A session the page shows: its stream.json, and whether its hub answers.</summary>
    sealed class SessionInfo
    {
        public string session;
        public string url;
        public string token;
        public string agentUser;
        public long created;
        public int port;
    }

    /// <summary>
    /// The program's lifetime and its hidden top-level message window: hotkey, Explorer restarts (TaskbarCreated),
    /// display and work area changes, the session scan and the exit when no session is left.
    /// </summary>
    sealed class Host : ApplicationContext
    {
        readonly Options options;
        readonly Instance instance;
        readonly MessageWindow messages;
        readonly System.Windows.Forms.Timer scanTimer;
        readonly FileSystemWatcher watcher;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        TileWindow tiles;
        List<SessionInfo> sessions = new List<SessionInfo>();
        DateTime lastSession = DateTime.UtcNow;
        DateTime lastPageRestart = DateTime.MinValue;
        bool scanning;
        bool overlay;
        /// <summary>The hotkeys by their RegisterHotKey id (index + 1), and whether each is registered.</summary>
        readonly Hotkey[] hotkeys;
        readonly bool[] registered;
        const int OverlayHotkey = 1, NextLayerHotkey = 2, PreviousLayerHotkey = 3;
        IntPtr reorderHook;
        Native.WinEventProc reorderCallback;
        readonly List<IntPtr> windowHooks = new List<IntPtr>();
        Native.WinEventProc windowCallback;
        readonly System.Windows.Forms.Timer coverCheck;

        public Host(Options options, Instance instance)
        {
            this.options = options;
            this.instance = instance;
            messages = new MessageWindow(this);
            hotkeys = new[] { options.Overlay, options.NextLayer, options.PreviousLayer };
            registered = new bool[hotkeys.Length];
            for (var i = 0; i < hotkeys.Length; i++)
            {
                if (hotkeys[i].Off) continue;
                registered[i] = Native.RegisterHotKey(messages.Handle, i + 1, hotkeys[i].Modifiers | Native.MOD_NOREPEAT, (uint)hotkeys[i].Key);
                Log.Write("hotkey " + hotkeys[i].Text + (registered[i] ? "" : " is taken by another program"));
            }
            // The tiles stay right under the icons when another program, such as a wallpaper app, reorders Progman's children.
            reorderCallback = OnReorder;
            reorderHook = Native.SetWinEventHook(Native.EVENT_OBJECT_REORDER, Native.EVENT_OBJECT_REORDER, IntPtr.Zero, reorderCallback, 0, 0, Native.WINEVENT_OUTOFCONTEXT);
            // While windows cover the whole desktop nobody sees the tiles: the page then stops its streams. Window
            // events (foreground, minimize, move, show, cloak) trigger one check shortly after they settle.
            coverCheck = new System.Windows.Forms.Timer { Interval = 200 };
            coverCheck.Tick += (sender, e) => { coverCheck.Stop(); CheckCovered(); };
            windowCallback = OnWindowEvent;
            foreach (var range in new[] { new[] { Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND }, new[] { Native.EVENT_SYSTEM_MOVESIZEEND, Native.EVENT_SYSTEM_MOVESIZEEND },
                new[] { Native.EVENT_SYSTEM_MINIMIZESTART, Native.EVENT_SYSTEM_MINIMIZEEND }, new[] { Native.EVENT_OBJECT_SHOW, Native.EVENT_OBJECT_HIDE },
                new[] { Native.EVENT_OBJECT_LOCATIONCHANGE, Native.EVENT_OBJECT_LOCATIONCHANGE }, new[] { Native.EVENT_OBJECT_CLOAKED, Native.EVENT_OBJECT_UNCLOAKED } })
                windowHooks.Add(Native.SetWinEventHook(range[0], range[1], IntPtr.Zero, windowCallback, 0, 0, Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS));
            Directory.CreateDirectory(options.SessionsDirectory);
            watcher = new FileSystemWatcher(options.SessionsDirectory, "stream.json") { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite };
            FileSystemEventHandler changed = (sender, e) => messages.BeginInvoke(new Action(Scan));
            watcher.Created += changed;
            watcher.Deleted += changed;
            watcher.Changed += changed;
            watcher.Renamed += (sender, e) => messages.BeginInvoke(new Action(Scan));
            watcher.EnableRaisingEvents = true;
            // The file watcher reports sessions at once; the timer finds hubs that stopped answering and ends the host.
            scanTimer = new System.Windows.Forms.Timer { Interval = 2000 };
            scanTimer.Tick += (sender, e) => Scan();
            scanTimer.Start();
            CreateTiles();
            Scan();
            CheckCovered();
        }

        void CreateTiles()
        {
            if (tiles != null) { tiles.Destroy(); tiles = null; }
            tiles = new TileWindow(options, this);
            if (!tiles.Attach()) Log.Write("no desktop layer yet; waiting for Explorer");
        }

        /// <summary>A new tile window: Explorer restarted and took Progman and the tiles with it, or the page's process ended.</summary>
        internal void Recreate(string reason)
        {
            Log.Write(reason);
            CreateTiles();
            if (overlay) tiles.ShowOverlay();
            CheckCovered();
        }

        /// <summary>The page's process ended: a new tile window, unless the page also failed right after the last restart.</summary>
        internal void PageFailed()
        {
            if ((DateTime.UtcNow - lastPageRestart).TotalSeconds < 60) { Log.Write("the tile page failed again within a minute; exiting"); ExitThread(); return; }
            lastPageRestart = DateTime.UtcNow;
            Recreate("the tile page restarts");
        }

        internal void OnHotkey(int id)
        {
            if (tiles == null) return;
            if (id == NextLayerHotkey || id == PreviousLayerHotkey)
            {
                tiles.Post(json.Serialize(new Dictionary<string, object> { { "type", "layer" }, { "step", id == NextLayerHotkey ? 1 : -1 } }));
                return;
            }
            if (id != OverlayHotkey) return;
            overlay = !overlay;
            Log.Write(overlay ? "overlay on" : "overlay off");
            if (overlay) tiles.ShowOverlay(); else tiles.Attach();
            CheckCovered();
        }

        internal void OnDisplayChange()
        {
            if (tiles == null) return;
            if (overlay) tiles.ShowOverlay(); else tiles.Attach();
        }

        void OnWindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            if (idObject != Native.OBJID_WINDOW || idChild != 0 || hwnd == IntPtr.Zero) return;
            if (eventType >= Native.EVENT_OBJECT_SHOW && Native.GetAncestor(hwnd, Native.GA_ROOT) != hwnd) return;
            if (!coverCheck.Enabled) coverCheck.Start();
        }

        void CheckCovered()
        {
            if (tiles == null) return;
            var covered = !overlay && Native.DesktopCovered(tiles.Progman, Screen.PrimaryScreen.WorkingArea);
            tiles.SetShown(!covered);
        }

        void OnReorder(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            if (tiles != null && !overlay && hwnd == tiles.Progman) tiles.KeepUnderIcons();
        }

        /// <summary>Read every session's stream.json and check that its hub answers; off the UI thread.</summary>
        void Scan()
        {
            if (scanning) return;
            scanning = true;
            var directory = options.SessionsDirectory;
            Task.Run(() => ReadSessions(directory)).ContinueWith(task =>
            {
                scanning = false;
                if (task.IsFaulted) { Log.Write("scan failed: " + task.Exception.GetBaseException().Message); return; }
                Apply(task.Result);
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        static List<SessionInfo> ReadSessions(string directory)
        {
            // Its own serializer: this runs on a pool thread while the UI thread serializes page messages.
            var json = new JavaScriptSerializer();
            var found = new List<SessionInfo>();
            if (!Directory.Exists(directory)) return found;
            foreach (var folder in Directory.GetDirectories(directory))
            {
                var file = Path.Combine(folder, "stream.json");
                SessionInfo info;
                try
                {
                    if (!File.Exists(file)) continue;
                    var data = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                    info = new SessionInfo
                    {
                        session = data["session"] as string,
                        url = data["url"] as string,
                        token = data["token"] as string,
                        agentUser = data.ContainsKey("agentUser") ? data["agentUser"] as string : null,
                        // When the session opened: the page orders the sessions' tiles by it.
                        created = (long)(File.GetCreationTimeUtc(file) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds,
                    };
                    Uri uri;
                    if (info.session == null || info.token == null || !Uri.TryCreate(info.url, UriKind.Absolute, out uri) || uri.Host != "127.0.0.1") continue;
                    info.port = uri.Port;
                }
                catch (Exception) { continue; }
                // A file whose hub does not answer belongs to a Pi process that ended without closing its session.
                if (Answers(info.port)) found.Add(info);
            }
            return found.OrderBy(s => s.created).ThenBy(s => s.session, StringComparer.Ordinal).ToList();
        }

        static bool Answers(int port)
        {
            using (var client = new TcpClient())
            {
                try { return client.ConnectAsync("127.0.0.1", port).Wait(500) && client.Connected; }
                catch (Exception) { return false; }
            }
        }

        void Apply(List<SessionInfo> found)
        {
            if (tiles != null && !overlay) tiles.KeepUnderIcons();
            if (found.Count > 0) lastSession = DateTime.UtcNow;
            else if ((DateTime.UtcNow - lastSession).TotalSeconds >= options.IdleExitSeconds)
            {
                // A start that found the instance taken wrote its stream.json before, so this last look finds it; a start
                // that found it free starts a new host, and whichever takes the instance stays.
                instance.Release();
                found = ReadSessions(options.SessionsDirectory);
                if (found.Count == 0 || !instance.TryTake()) { ExitThread(); return; }
                Log.Write("a session opened while the host was leaving; staying");
                lastSession = DateTime.UtcNow;
            }
            var before = string.Join("|", sessions.Select(s => s.session + "@" + s.url));
            var after = string.Join("|", found.Select(s => s.session + "@" + s.url));
            sessions = found;
            if (before != after) { Log.Write("sessions: " + (after.Length > 0 ? after : "none")); PostState(); }
        }

        internal void PostState()
        {
            if (tiles == null) return;
            tiles.Post(json.Serialize(new Dictionary<string, object>
            {
                { "type", "sessions" },
                { "sessions", sessions.Select(s => new Dictionary<string, object> { { "session", s.session }, { "url", s.url }, { "token", s.token }, { "agentUser", s.agentUser }, { "created", s.created } }).ToList() },
                // The page names only the hotkeys that work.
                { "hotkeys", new Dictionary<string, object>
                {
                    { "overlay", registered[OverlayHotkey - 1] ? hotkeys[OverlayHotkey - 1].Text : null },
                    { "nextLayer", registered[NextLayerHotkey - 1] ? hotkeys[NextLayerHotkey - 1].Text : null },
                    { "previousLayer", registered[PreviousLayerHotkey - 1] ? hotkeys[PreviousLayerHotkey - 1].Text : null },
                } },
            }));
        }

        protected override void ExitThreadCore()
        {
            scanTimer.Stop();
            watcher.Dispose();
            if (reorderHook != IntPtr.Zero) Native.UnhookWinEvent(reorderHook);
            foreach (var hook in windowHooks) if (hook != IntPtr.Zero) Native.UnhookWinEvent(hook);
            coverCheck.Stop();
            for (var i = 0; i < registered.Length; i++) if (registered[i]) Native.UnregisterHotKey(messages.Handle, i + 1);
            if (tiles != null) tiles.Destroy();
            messages.DestroyHandle();
            base.ExitThreadCore();
        }

        internal void Shutdown() { ExitThread(); }
    }

    /// <summary>A hidden top-level window: it gets broadcasts (TaskbarCreated, display changes) and the hotkeys.</summary>
    sealed class MessageWindow : NativeWindow
    {
        static readonly uint TaskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
        readonly Host host;
        readonly Control invoker = new Control();

        public MessageWindow(Host host)
        {
            this.host = host;
            invoker.CreateControl();
            CreateHandle(new CreateParams { Caption = "Pi session tile host", ExStyle = Native.WS_EX_TOOLWINDOW });
        }

        public void BeginInvoke(Action action) { if (invoker.IsHandleCreated) invoker.BeginInvoke(action); }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY) host.OnHotkey(m.WParam.ToInt32());
            else if (TaskbarCreated != 0 && m.Msg == (int)TaskbarCreated) host.Recreate("Explorer restarted");
            else if (m.Msg == Native.WM_DISPLAYCHANGE || (m.Msg == Native.WM_SETTINGCHANGE && m.WParam.ToInt32() == Native.SPI_SETWORKAREA)) host.OnDisplayChange();
            else if (m.Msg == Native.WM_ENDSESSION && m.WParam != IntPtr.Zero) host.Shutdown();
            base.WndProc(ref m);
        }
    }

    /// <summary>The window with the tile page: a child of Progman under the icons, or a topmost click-through popup.</summary>
    sealed class TileWindow : Form
    {
        readonly Options options;
        readonly Host host;
        readonly WebView2 view;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        bool ready;
        string pending;
        string mode = "desktop";
        public IntPtr Progman { get; private set; }
        IntPtr defView;

        public TileWindow(Options options, Host host)
        {
            this.options = options;
            this.host = host;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Text = "Pi session tiles";
            view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Transparent };
            Controls.Add(view);
            Bounds = new Rectangle(-32000, -32000, 1, 1);
            CreateHandle();
            // Alpha before reparenting, as for any layered child under the icons.
            Native.SetLayeredWindowAttributes(Handle, 0, 255, Native.LWA_ALPHA);
            // Shown off screen first: WebView2 renders only while its control counts as visible.
            Show();
            InitializeView();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var parameters = base.CreateParams;
                // No redirection bitmap: the window shows only the page's DirectComposition content, so the wallpaper
                // shows through wherever the page is transparent.
                parameters.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOREDIRECTIONBITMAP;
                return parameters;
            }
        }

        async void InitializeView()
        {
            try
            {
                Directory.CreateDirectory(options.DataDirectory);
                var environment = await CoreWebView2Environment.CreateAsync(null, options.DataDirectory,
                    new CoreWebView2EnvironmentOptions(options.BrowserArguments));
                await view.EnsureCoreWebView2Async(environment);
                var core = view.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.SetVirtualHostNameToFolderMapping("tiles.pi-computer-use", options.PageDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
                core.WebMessageReceived += OnPageMessage;
                core.NewWindowRequested += (sender, e) => { e.Handled = true; };
                core.ProcessFailed += (sender, e) =>
                {
                    Log.Write("WebView2 process failed: " + e.ProcessFailedKind + ", " + e.Reason);
                    if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                        BeginInvoke(new Action(host.PageFailed));
                };
                core.Navigate("https://tiles.pi-computer-use/index.html");
            }
            catch (Exception error)
            {
                Log.Write("WebView2 failed: " + error.Message);
                host.Shutdown();
            }
        }

        void OnPageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> message;
            try { message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (Exception) { return; }
            object type;
            if (!message.TryGetValue("type", out type)) return;
            if ((string)type == "ready")
            {
                ready = true;
                PostLayout();
                host.PostState();
                if (pending != null) { view.CoreWebView2.PostWebMessageAsJson(pending); pending = null; }
            }
            else if ((string)type == "log")
            {
                object text;
                if (message.TryGetValue("message", out text)) Log.Write("page: " + Convert.ToString(text));
            }
        }

        public void Post(string message)
        {
            if (ready && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson(message);
            else pending = message;
        }

        /// <summary>Where the tiles go, in this window's client pixels: the primary display's work area.</summary>
        void PostLayout()
        {
            if (!ready || view.CoreWebView2 == null) return;
            var area = Screen.PrimaryScreen.WorkingArea;
            var origin = new Native.POINT();
            Native.ClientToScreen(Handle, ref origin);
            view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new Dictionary<string, object>
            {
                { "type", "layout" },
                { "mode", mode },
                { "workArea", new Dictionary<string, object> { { "x", area.X - origin.X }, { "y", area.Y - origin.Y }, { "width", area.Width }, { "height", area.Height } } },
            }));
        }

        /// <summary>Put the window into Progman directly under the icon view. False when the desktop is not there.</summary>
        public bool Attach()
        {
            Progman = Native.FindWindow("Progman", null);
            if (Progman == IntPtr.Zero) return false;
            IntPtr result;
            // Asks Explorer to raise the desktop so a wallpaper layer exists (the message wallpaper apps send).
            Native.SendMessageTimeout(Progman, 0x052C, new IntPtr(0xD), new IntPtr(1), Native.SMTO_NORMAL, 1000, out result);
            defView = Native.FindWindowEx(Progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView == IntPtr.Zero)
            {
                Log.Write("SHELLDLL_DefView is not a child of Progman: this Windows build has no raised desktop (needs Windows 11 24H2 or later)");
                return false;
            }
            Native.SetWindowPos(Handle, Native.HWND_NOTOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            SetStyles(Native.WS_CHILD | Native.WS_VISIBLE | Native.WS_CLIPSIBLINGS | Native.WS_CLIPCHILDREN, Native.WS_EX_TOPMOST | Native.WS_EX_TRANSPARENT, 0);
            Native.SetParent(Handle, Progman);
            Native.RECT client;
            Native.GetClientRect(Progman, out client);
            Native.SetWindowPos(Handle, defView, 0, 0, client.Right - client.Left, client.Bottom - client.Top, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW | Native.SWP_FRAMECHANGED);
            mode = "desktop";
            Log.Write("attached under the icons, " + (client.Right - client.Left) + "x" + (client.Bottom - client.Top));
            PostLayout();
            return true;
        }

        /// <summary>The same tiles over every window: topmost, click-through, never activated.</summary>
        public void ShowOverlay()
        {
            Native.SetParent(Handle, IntPtr.Zero);
            SetStyles(Native.WS_POPUP | Native.WS_VISIBLE | Native.WS_CLIPCHILDREN, 0, Native.WS_EX_TOPMOST | Native.WS_EX_TRANSPARENT);
            var screen = SystemInformation.VirtualScreen;
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, screen.X, screen.Y, screen.Width, screen.Height, Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW | Native.SWP_FRAMECHANGED);
            mode = "overlay";
            PostLayout();
        }

        void SetStyles(int style, int clearExStyle, int setExStyle)
        {
            Native.SetWindowLong(Handle, Native.GWL_STYLE, style);
            var ex = Native.GetWindowLong(Handle, Native.GWL_EXSTYLE);
            Native.SetWindowLong(Handle, Native.GWL_EXSTYLE, ((ex & ~clearExStyle) | setExStyle) | Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOREDIRECTIONBITMAP);
        }

        /// <summary>Hide the page while nobody can see it: WebView2 then stops drawing and the page stops its streams.</summary>
        public void SetShown(bool shown)
        {
            if (view.Visible == shown) return;
            view.Visible = shown;
            Log.Write(shown ? "desktop visible: tiles on" : "desktop covered: tiles paused");
        }

        /// <summary>Back under the icons when another window took the place between the icons and the tiles.</summary>
        public void KeepUnderIcons()
        {
            if (mode != "desktop" || defView == IntPtr.Zero || !Native.IsWindow(defView)) return;
            if (Native.GetParent(Handle) != Progman) return;
            if (Native.GetWindow(defView, Native.GW_HWNDNEXT) == Handle) return;
            Native.SetWindowPos(Handle, defView, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            Log.Write("restored the place under the icons");
        }

        public void Destroy()
        {
            try { view.Dispose(); } catch (Exception) { }
            if (IsHandleCreated && Native.IsWindow(Handle)) DestroyHandle();
            Dispose();
        }
    }

    static class Native
    {
        public const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
        public const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_VISIBLE = 0x10000000, WS_CLIPSIBLINGS = 0x04000000, WS_CLIPCHILDREN = 0x02000000;
        public const int WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000, WS_EX_TOOLWINDOW = 0x80, WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_NOREDIRECTIONBITMAP = 0x200000;
        public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
        public const uint LWA_ALPHA = 0x2, SMTO_NORMAL = 0, GW_HWNDNEXT = 2;
        public const int WM_HOTKEY = 0x312, WM_DISPLAYCHANGE = 0x7E, WM_SETTINGCHANGE = 0x1A, WM_ENDSESSION = 0x16, SPI_SETWORKAREA = 0x2F;
        public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
        public const uint EVENT_OBJECT_REORDER = 0x8004, WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2;
        public const uint EVENT_SYSTEM_FOREGROUND = 0x3, EVENT_SYSTEM_MOVESIZEEND = 0xB, EVENT_SYSTEM_MINIMIZESTART = 0x16, EVENT_SYSTEM_MINIMIZEEND = 0x17;
        public const uint EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003, EVENT_OBJECT_LOCATIONCHANGE = 0x800B, EVENT_OBJECT_CLOAKED = 0x8017, EVENT_OBJECT_UNCLOAKED = 0x8018;
        public const int OBJID_WINDOW = 0;
        public const uint GA_ROOT = 2, GW_HWNDFIRST = 0;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

        /// <summary>
        /// Whether one opaque window covers the whole work area above the desktop: a maximized or full-screen window.
        /// Partly visible desktops count as visible; transparent, layered, cloaked and minimized windows cover nothing.
        /// </summary>
        public static bool DesktopCovered(IntPtr progman, Rectangle area)
        {
            uint self = (uint)Process.GetCurrentProcess().Id;
            for (var h = GetWindow(GetDesktopWindowChild(), GW_HWNDFIRST); h != IntPtr.Zero; h = GetWindow(h, GW_HWNDNEXT))
            {
                if (h == progman) return false;
                if (!IsWindowVisible(h) || IsIconic(h)) continue;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == self) continue;
                var ex = GetWindowLong(h, GWL_EXSTYLE);
                if ((ex & (WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP)) != 0) continue;
                int cloaked;
                if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
                RECT r;
                if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0 && !GetWindowRect(h, out r)) continue;
                if (r.Left <= area.Left && r.Top <= area.Top && r.Right >= area.Right && r.Bottom >= area.Bottom) return true;
            }
            return false;
        }

        static IntPtr GetDesktopWindowChild() { return GetWindow(GetDesktopWindow(), 5); }
        [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        public delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
        [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
        [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
    }
}
