using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const uint RIDEV_INPUTSINK = 0x00000100;
    private const uint RID_INPUT = 0x10000003;
    private const uint RIDI_PREPARSEDDATA = 0x20000005;
    private const uint RIDI_DEVICENAME = 0x20000007;
    private const uint WM_INPUT = 0x00FF;
    private const uint RIM_TYPEHID = 2;
    private const int HIDP_STATUS_SUCCESS = 0x00110000;
    private static readonly WndProc Proc = WindowProc;
    private static readonly Dictionary<nint, DeviceInfo> DeviceCache = new();
    private static readonly string DeviceFilter = Environment.GetEnvironmentVariable("DSH_TOUCHPAD_DEVICE_FILTER")?.Trim() is { Length: > 0 } filter
        ? filter : "BLTP785";

    private sealed record DeviceInfo(bool IsTouchpad, nint PreparsedData);

    private static int Main()
    {
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8)
        {
            Console.Error.WriteLine("Windows x64 is required.");
            return 1;
        }

        var className = "DshTouchpadCollector_" + Environment.ProcessId;
        var windowClass = new WNDCLASS { lpszClassName = className, lpfnWndProc = Proc };
        if (RegisterClass(ref windowClass) == 0)
        {
            Console.Error.WriteLine("RegisterClass failed: " + Marshal.GetLastWin32Error());
            return 1;
        }

        var window = CreateWindowEx(0, className, className, 0, 0, 0, 0, 0,
            0, 0, 0, 0);
        if (window == 0)
        {
            Console.Error.WriteLine("CreateWindowEx failed: " + Marshal.GetLastWin32Error());
            return 1;
        }

        var device = new RAWINPUTDEVICE
        {
            usUsagePage = 0x0D,
            usUsage = 0x05,
            dwFlags = RIDEV_INPUTSINK,
            hwndTarget = window
        };
        if (!RegisterRawInputDevices([device], 1, (uint)Marshal.SizeOf<RAWINPUTDEVICE>()))
        {
            Console.Error.WriteLine("Digitizer registration failed: " + Marshal.GetLastWin32Error());
            return 1;
        }

        Emit(new { type = "ready", source = "hid-digitizer", usagePage = 13, usage = 5,
            deviceFilter = DeviceFilter });
        while (GetMessage(out var message, 0, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        foreach (var info in DeviceCache.Values)
            if (info.PreparsedData != 0) Marshal.FreeHGlobal(info.PreparsedData);
        return 0;
    }

    private static nint WindowProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        if (message == WM_INPUT) ReadInput(lParam);
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private static void ReadInput(nint handle)
    {
        uint size = 0;
        uint headerSize = (uint)Marshal.SizeOf<RAWINPUTHEADER>();
        if (GetRawInputData(handle, RID_INPUT, 0, ref size, headerSize) != 0 || size < 33) return;
        nint buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (GetRawInputData(handle, RID_INPUT, buffer, ref size, headerSize) != size) return;
            if ((uint)Marshal.ReadInt32(buffer) != RIM_TYPEHID) return;
            nint device = Marshal.ReadIntPtr(buffer, 8);
            var info = GetDevice(device);
            if (!info.IsTouchpad) return;

            uint reportSize = (uint)Marshal.ReadInt32(buffer, 24);
            uint reportCount = (uint)Marshal.ReadInt32(buffer, 28);
            if (reportSize == 0 || reportSize > 4096 || reportCount == 0 || reportCount > 64
                || 32UL + (ulong)reportSize * reportCount > size) return;

            for (uint i = 0; i < reportCount; i++)
            {
                byte[] report = new byte[reportSize];
                Marshal.Copy(buffer + 32 + (int)(i * reportSize), report, 0, report.Length);
                long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (TryUsage(info, report, 0x0D, 0x54, out uint contacts))
                {
                    uint? x = TryUsage(info, report, 0x01, 0x30, out uint rawX) ? rawX : null;
                    uint? y = TryUsage(info, report, 0x01, 0x31, out uint rawY) ? rawY : null;
                    Emit(new { type = "contact", at, contactCount = contacts, x, y });
                }
                else
                {
                    Emit(new { type = "digitizer_activity", at });
                }
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static DeviceInfo GetDevice(nint device)
    {
        if (device == 0) return new DeviceInfo(false, 0);
        if (DeviceCache.TryGetValue(device, out var known)) return known;
        uint length = 0;
        GetRawInputDeviceInfoName(device, RIDI_DEVICENAME, null, ref length);
        if (length == 0) return DeviceCache[device] = new DeviceInfo(false, 0);
        var name = new StringBuilder((int)length);
        if (GetRawInputDeviceInfoName(device, RIDI_DEVICENAME, name, ref length) == uint.MaxValue
            || (DeviceFilter != "*" && !name.ToString().Contains(DeviceFilter, StringComparison.OrdinalIgnoreCase)))
            return DeviceCache[device] = new DeviceInfo(false, 0);

        uint bytes = 0;
        GetRawInputDeviceInfoData(device, RIDI_PREPARSEDDATA, 0, ref bytes);
        if (bytes == 0) return DeviceCache[device] = new DeviceInfo(true, 0);
        nint preparsed = Marshal.AllocHGlobal((int)bytes);
        if (GetRawInputDeviceInfoData(device, RIDI_PREPARSEDDATA, preparsed, ref bytes) == uint.MaxValue)
        {
            Marshal.FreeHGlobal(preparsed);
            preparsed = 0;
        }
        return DeviceCache[device] = new DeviceInfo(true, preparsed);
    }

    private static bool TryUsage(DeviceInfo device, byte[] report, ushort page, ushort usage, out uint value)
    {
        value = 0;
        return device.PreparsedData != 0 && HidP_GetUsageValue(0, page, 0, usage,
            out value, device.PreparsedData, report, (uint)report.Length) == HIDP_STATUS_SUCCESS;
    }

    private static void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));

    private delegate nint WndProc(nint hwnd, uint message, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS
    {
        public uint style;
        public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public nint hInstance;
        public nint hIcon;
        public nint hCursor;
        public nint hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICE
    {
        public ushort usUsagePage;
        public ushort usUsage;
        public uint dwFlags;
        public nint hwndTarget;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTHEADER
    {
        public uint dwType;
        public uint dwSize;
        public nint hDevice;
        public nint wParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam;
        public nint lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClass(ref WNDCLASS lpWndClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowEx(uint exStyle, string className, string windowName,
        uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterRawInputDevices([In] RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(nint rawInput, uint command, nint data, ref uint size, uint headerSize);
    [DllImport("user32.dll", EntryPoint = "GetRawInputDeviceInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetRawInputDeviceInfoName(nint device, uint command, StringBuilder? data, ref uint size);
    [DllImport("user32.dll", EntryPoint = "GetRawInputDeviceInfoW", SetLastError = true)]
    private static extern uint GetRawInputDeviceInfoData(nint device, uint command, nint data, ref uint size);
    [DllImport("hid.dll")]
    private static extern int HidP_GetUsageValue(int reportType, ushort usagePage, ushort linkCollection,
        ushort usage, out uint value, nint preparsedData, byte[] report, uint reportLength);
    [DllImport("user32.dll")]
    private static extern nint DefWindowProc(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern nint DispatchMessage(ref MSG message);
}
