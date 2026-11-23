// Shared Windows Sandbox screen zones: each agent works in its own rectangle of the guest screen.
// Compiled together with guest-lease.cs by Windows PowerShell's Add-Type, so it stays within C# 5.
//
// Up to MaxSeats agents join; the work area is split by how many there are: one gets all of it, two the left and right
// halves, three or four the quarters (top left, top right, bottom left, bottom right), in the order they joined. When an
// agent joins or leaves, the zones are laid out again and every window moves into its agent's new zone.
//
// A window belongs to an agent when its process, or an ancestor process, was claimed by that agent. An out-of-context
// WinEvent hook sees every top-level window that is shown or moved, and puts it back into its agent's zone:
// moved inside, shrunk when larger, and a maximized window restored and sized to the zone instead. A window the user
// drags is left alone until the drag ends. Windows of unclaimed processes (the taskbar, the desktop) are never touched.
// The hook runs on its own thread with per-monitor DPI awareness, so every rectangle is in physical pixels.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PiZones
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
        /// Whether r lies inside, give or take slack pixels: a DPI-unaware window sizes in steps of its scale, such as
        /// 1.5 px at 150 %, so it can end a pixel past the size it was given.
        public bool Contains(Rect r, int slack) { return r.Left >= Left - slack && r.Top >= Top - slack && r.Right <= Right + slack && r.Bottom <= Bottom + slack; }
        public bool Same(Rect r) { return r.Left == Left && r.Top == Top && r.Right == Right && r.Bottom == Bottom; }
    }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr Hwnd; public uint Message; public IntPtr W, L; public uint Time; public Point Pt; }
    [StructLayout(LayoutKind.Sequential)]
    struct GuiThreadInfo { public int Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Exe;
    }
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern int GetMessage(out Msg msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Msg msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr proc);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out Rect rect, uint ini);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public const int MaxSeats = 4;
    /// How long a seat waits for its agent after a connection ends without leave: a cancelled wait for the input closes
    /// the connection, and the agent connects again at its next request.
    const int GraceMs = 10000;
    /// Pixels a window may end past its zone before it is placed again; see Rect.Contains.
    const int Slack = 2;
    const uint WmTimer = 0x0113, WmPlace = 0x8001;
    // SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS: never block on a hung app, never change focus or order.
    const uint Place = 0x0004 | 0x0010 | 0x4000, NoSize = 0x0001;
    const uint EventDestroy = 0x8001;
    /// The shell's own windows; a claimed Explorer must not drag the taskbar or the desktop into a zone.
    static readonly HashSet<string> ShellClasses = new HashSet<string> { "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW" };
    /// Processes whose children are the user's own, never an agent's: an agent that claims Explorer does not get
    /// everything started from the desktop.
    static readonly HashSet<string> SharedParents = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe" };

    /// Owner is the connection that holds the seat, or null while the agent reconnects; then Dropped tells since when.
    class Seat { public string Name; public object Owner; public long Dropped; public Rect Zone; public Rect Before; public bool Moved; }
    class Claim { public string Name; public object Owner; }
    class Budget { public long Since; public int Count; }

    static readonly object Gate = new object();
    static readonly List<Seat> Seats = new List<Seat>();
    static readonly Dictionary<uint, Claim> Claims = new Dictionary<uint, Claim>();
    /// The seat name of each process seen so far, or null when no agent owns it; cleared whenever the claims change.
    static readonly Dictionary<uint, string> Owners = new Dictionary<uint, string>();
    static Rect work;
    // Touched only by the hook thread.
    static readonly HashSet<IntPtr> Filled = new HashSet<IntPtr>();
    static readonly Dictionary<IntPtr, Budget> Budgets = new Dictionary<IntPtr, Budget>();
    static readonly WinEventProc Hook = OnEvent;
    static uint hookThread;

    /// Start the hook thread; returns once it watches and knows the work area.
    public static void Start()
    {
        ManualResetEvent ready = new ManualResetEvent(false);
        Thread thread = new Thread(() =>
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: physical pixels for every rectangle read or set here.
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            Msg msg;
            PeekMessage(out msg, IntPtr.Zero, 0, 0, 0);
            hookThread = GetCurrentThreadId();
            lock (Gate) work = WorkArea();
            // EVENT_SYSTEM_FOREGROUND .. EVENT_OBJECT_LOCATIONCHANGE, out of context, skipping this process.
            SetWinEventHook(0x0003, 0x800B, IntPtr.Zero, Hook, 0, 0, 0x0000 | 0x0002);
            SetTimer(IntPtr.Zero, IntPtr.Zero, 1000, IntPtr.Zero);
            ready.Set();
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                try
                {
                    if (msg.Message == WmTimer) Tick();
                    else if (msg.Message == WmPlace) PlaceAll();
                }
                catch (Exception error) { Console.Error.WriteLine("zones: " + error.Message); }
            }
        });
        thread.IsBackground = true;
        thread.Start();
        ready.WaitOne();
    }

    /// Give an agent a zone, or null when every seat is taken. An agent that joins again under its name keeps its seat.
    public static string Join(string name, object owner)
    {
        lock (Gate)
        {
            Seat seat = Find(name);
            if (seat != null) { seat.Owner = owner; return Describe(seat); }
            if (Seats.Count >= MaxSeats) return null;
            Seats.Add(new Seat { Name = name, Owner = owner });
            Layout();
            return Describe(Find(name));
        }
    }

    /// The agent's current zone line, or null when it has no seat.
    public static string ZoneOf(string name)
    {
        lock (Gate) { Seat seat = Find(name); return seat == null ? null : Describe(seat); }
    }

    public static int Seated { get { lock (Gate) return Seats.Count; } }

    public static void Claimed(int pid, string name, object owner)
    {
        lock (Gate) { Claims[(uint)pid] = new Claim { Name = name, Owner = owner }; Owners.Clear(); }
        Post();
    }

    /// A connection ended: its claims go. Its seat goes at once when the agent left, or after GraceMs when the connection
    /// just closed and the agent does not join again; a newer connection of the same agent may hold it already.
    public static void Leave(string name, object owner, bool left)
    {
        lock (Gate)
        {
            List<uint> mine = new List<uint>();
            foreach (KeyValuePair<uint, Claim> claim in Claims) if (claim.Value.Owner == owner) mine.Add(claim.Key);
            foreach (uint pid in mine) Claims.Remove(pid);
            Owners.Clear();
            Seat seat = Find(name);
            if (seat == null || seat.Owner != owner) return;
            if (left) { Seats.Remove(seat); Layout(); }
            else { seat.Owner = null; seat.Dropped = Environment.TickCount; }
        }
    }

    static Seat Find(string name)
    {
        foreach (Seat seat in Seats) if (seat.Name == name) return seat;
        return null;
    }

    static string Describe(Seat seat)
    {
        Rect z = seat.Zone;
        return "zone " + z.Left + " " + z.Top + " " + z.Width + " " + z.Height + " " + Seats.IndexOf(seat) + " " + Seats.Count + " " + work.Width + " " + work.Height;
    }

    /// The zones of `count` agents in a work area: the whole, two halves, or four quarters.
    public static Rect[] Tiles(Rect area, int count)
    {
        int midX = area.Left + area.Width / 2, midY = area.Top + area.Height / 2;
        if (count <= 1) return new Rect[] { area };
        if (count == 2) return new Rect[] { R(area.Left, area.Top, midX, area.Bottom), R(midX, area.Top, area.Right, area.Bottom) };
        return new Rect[] { R(area.Left, area.Top, midX, midY), R(midX, area.Top, area.Right, midY), R(area.Left, midY, midX, area.Bottom), R(midX, midY, area.Right, area.Bottom) };
    }
    static Rect R(int left, int top, int right, int bottom) { return new Rect { Left = left, Top = top, Right = right, Bottom = bottom }; }

    /// Lay the seats out again and have the hook thread move every window into its new zone. Called under Gate.
    static void Layout()
    {
        Rect[] tiles = Tiles(work, Seats.Count);
        for (int i = 0; i < Seats.Count; i++)
        {
            Seat seat = Seats[i];
            if (seat.Zone.Same(tiles[i])) continue;
            if (!seat.Moved) { seat.Before = seat.Zone; seat.Moved = true; }
            seat.Zone = tiles[i];
        }
        Post();
    }

    static void Post() { if (hookThread != 0) PostThreadMessage(hookThread, WmPlace, IntPtr.Zero, IntPtr.Zero); }

    static Rect WorkArea()
    {
        Rect area;
        // SPI_GETWORKAREA: the primary screen without the taskbar.
        SystemParametersInfo(0x0030, 0, out area, 0);
        return area;
    }

    /// Once a second: follow a changed screen size, free the seats of agents that did not come back, and forget windows
    /// that are gone.
    static void Tick()
    {
        Rect area = WorkArea();
        lock (Gate)
        {
            bool changed = Seats.RemoveAll(seat => seat.Owner == null && Environment.TickCount - seat.Dropped > GraceMs) > 0;
            if (!area.Same(work) && area.Width > 0 && area.Height > 0) { work = area; changed = true; }
            if (changed) Layout();
        }
        List<IntPtr> gone = new List<IntPtr>();
        foreach (IntPtr hwnd in Budgets.Keys) if (!IsWindow(hwnd)) gone.Add(hwnd);
        foreach (IntPtr hwnd in gone) Budgets.Remove(hwnd);
        Filled.RemoveWhere(hwnd => !IsWindow(hwnd));
    }

    /// The zone of the agent that owns this process, directly or through an ancestor; null for no agent.
    static bool ZoneFor(uint pid, out Rect zone, out Rect before, out bool moved)
    {
        zone = before = new Rect(); moved = false;
        lock (Gate)
        {
            if (Seats.Count == 0) return false;
            string name;
            if (!Owners.TryGetValue(pid, out name)) { name = OwnerOf(pid); Owners[pid] = name; }
            Seat seat = name == null ? null : Find(name);
            if (seat == null) return false;
            zone = seat.Zone; before = seat.Before; moved = seat.Moved;
            return true;
        }
    }

    /// Walk the parent chain up to a claimed process. Called under Gate.
    static string OwnerOf(uint pid)
    {
        Claim claim;
        if (Claims.TryGetValue(pid, out claim)) return claim.Name;
        Dictionary<uint, ProcessEntry> processes = Processes();
        uint current = pid;
        for (int depth = 0; depth < 16; depth++)
        {
            ProcessEntry entry;
            if (!processes.TryGetValue(current, out entry) || entry.Parent == 0 || entry.Parent == current) return null;
            ProcessEntry parent;
            if (!processes.TryGetValue(entry.Parent, out parent) || SharedParents.Contains(parent.Exe)) return null;
            if (Claims.TryGetValue(entry.Parent, out claim)) return claim.Name;
            current = entry.Parent;
        }
        return null;
    }

    static Dictionary<uint, ProcessEntry> Processes()
    {
        Dictionary<uint, ProcessEntry> map = new Dictionary<uint, ProcessEntry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(0x2, 0);
        if (snapshot == new IntPtr(-1)) return map;
        try
        {
            ProcessEntry entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32First(snapshot, ref entry)) do { map[entry.Pid] = entry; } while (Process32Next(snapshot, ref entry));
        }
        finally { CloseHandle(snapshot); }
        return map;
    }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time)
    {
        try
        {
            if (obj != 0 || child != 0 || hwnd == IntPtr.Zero) return;
            if (ev == EventDestroy) { Filled.Remove(hwnd); Budgets.Remove(hwnd); return; }
            // Only a shown window is placed. At EVENT_OBJECT_CREATE a menu still sits at 0,0 until Windows positions it,
            // and an asynchronous move sent then would land after that and drag the menu away from its item.
            if (GetAncestor(hwnd, 2) != hwnd || !IsWindowVisible(hwnd)) return;
            Enforce(hwnd, false);
        }
        catch (Exception error) { Console.Error.WriteLine("zones: " + error.Message); }
    }

    /// After a layout change or a new claim: put every agent window into its zone.
    static void PlaceAll()
    {
        Dictionary<string, Rect> placed = new Dictionary<string, Rect>();
        lock (Gate) foreach (Seat seat in Seats) placed[seat.Name] = seat.Zone;
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows((hwnd, data) => { if (IsWindowVisible(hwnd)) windows.Add(hwnd); return true; }, IntPtr.Zero);
        foreach (IntPtr hwnd in windows) Enforce(hwnd, true);
        // A layout that changed meanwhile posted another pass, which still needs the zones its windows came from.
        lock (Gate) foreach (Seat seat in Seats)
        {
            Rect zone;
            if (placed.TryGetValue(seat.Name, out zone) && zone.Same(seat.Zone)) { seat.Before = seat.Zone; seat.Moved = false; }
        }
    }

    static void Enforce(IntPtr hwnd, bool relayout)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(hwnd, out pid);
        Rect zone, before; bool moved;
        if (thread == 0 || !ZoneFor(pid, out zone, out before, out moved) || zone.Width <= 0 || IsIconic(hwnd)) return;
        StringBuilder name = new StringBuilder(64);
        GetClassName(hwnd, name, 64);
        if (ShellClasses.Contains(name.ToString())) return;
        Rect outer;
        if (!GetWindowRect(hwnd, out outer) || outer.Width <= 0 || outer.Height <= 0) return;
        // A window being dragged or sized is placed when the drag ends (EVENT_SYSTEM_MOVESIZEEND).
        GuiThreadInfo info = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (GetGUIThreadInfo(thread, ref info) && ((info.Flags & 0x2) != 0 || info.MoveSize == hwnd)) return;
        Rect visible = Visible(hwnd, outer);
        // The invisible resize borders around the visible frame.
        int left = visible.Left - outer.Left, top = visible.Top - outer.Top, right = outer.Right - visible.Right, bottom = outer.Bottom - visible.Bottom;
        if (IsZoomed(hwnd))
        {
            // Maximized would cover every zone: show it restored at the zone's size instead.
            if (!Spend(hwnd)) return;
            // SW_SHOWNOACTIVATE restores it without taking the focus.
            ShowWindowAsync(hwnd, 4);
            Filled.Add(hwnd);
            Fill(hwnd, zone);
            return;
        }
        if (relayout && Filled.Contains(hwnd))
        {
            if (Spend(hwnd)) Fill(hwnd, zone);
            return;
        }
        int width = visible.Width, height = visible.Height;
        int x = visible.Left, y = visible.Top;
        // On a new layout a window keeps its place relative to its zone.
        if (relayout && moved && before.Width > 0) { x = zone.Left + (visible.Left - before.Left); y = zone.Top + (visible.Top - before.Top); }
        Rect target = R(x, y, x + width, y + height);
        if (zone.Contains(target, Slack) && target.Same(visible)) return;
        int newWidth = Math.Min(width, zone.Width), newHeight = Math.Min(height, zone.Height);
        x = Math.Max(zone.Left, Math.Min(x, zone.Right - newWidth));
        y = Math.Max(zone.Top, Math.Min(y, zone.Bottom - newHeight));
        if (!Spend(hwnd)) return;
        SetWindowPos(hwnd, IntPtr.Zero, x - left, y - top, newWidth + left + right, newHeight + top + bottom,
            Place | (newWidth == width && newHeight == height ? NoSize : 0u));
    }

    /// Size the window's visible frame to the whole zone.
    static void Fill(IntPtr hwnd, Rect zone)
    {
        Rect outer;
        if (!GetWindowRect(hwnd, out outer)) return;
        Rect visible = Visible(hwnd, outer);
        int left = visible.Left - outer.Left, top = visible.Top - outer.Top, right = outer.Right - visible.Right, bottom = outer.Bottom - visible.Bottom;
        SetWindowPos(hwnd, IntPtr.Zero, zone.Left - left, zone.Top - top, zone.Width + left + right, zone.Height + top + bottom, Place);
    }

    /// The visible frame (DWM extended frame bounds), without the invisible resize borders of GetWindowRect.
    static Rect Visible(IntPtr hwnd, Rect outer)
    {
        Rect frame;
        return DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(Rect))) == 0 && frame.Width > 0 ? frame : outer;
    }

    /// At most 30 moves of one window in 2 s: an app that keeps moving itself back is left alone for the rest of them.
    static bool Spend(IntPtr hwnd)
    {
        long now = Environment.TickCount;
        Budget budget;
        if (!Budgets.TryGetValue(hwnd, out budget) || now - budget.Since > 2000) { budget = new Budget { Since = now }; Budgets[hwnd] = budget; }
        return ++budget.Count <= 30;
    }
}
