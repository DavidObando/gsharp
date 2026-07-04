// <copyright file="ConsoleInputReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GSharp.Repl.Shell;

/// <summary>
/// Reads keyboard and mouse-wheel input from the console. On Windows it uses the native
/// <c>ReadConsoleInput</c> API so wheel notches surface as scroll events. On macOS/Linux it
/// puts the terminal into raw mode (via <c>stty</c>), enables SGR mouse reporting, and decodes
/// the raw byte stream with <see cref="VtInputDecoder"/>. When neither path is available (input
/// redirected, or setup fails) it falls back to <see cref="Console.ReadKey(bool)"/> for keys only.
/// </summary>
internal sealed class ConsoleInputReader : IInputReader, IDisposable
{
    private readonly bool useWindowsNative;
    private readonly VtInputDecoder? decoder;

    private IntPtr stdInHandle = IntPtr.Zero;
    private uint originalMode;
    private bool windowsModeChanged;

    private bool unixActive;
    private string? savedStty;

    private bool restored;

    /// <summary>Initializes a new instance of the <see cref="ConsoleInputReader"/> class.</summary>
    public ConsoleInputReader()
    {
        if (Console.IsInputRedirected)
        {
            return;
        }

        if (OperatingSystem.IsWindows())
        {
            this.useWindowsNative = this.TrySetupWindows();
            return;
        }

        // The Unix raw-mode + mouse path is opt-in: enabling raw mode and reading stdin
        // directly can conflict with the terminal's line discipline on some hosts and mangle
        // keyboard input. Until it is verified broadly, default to the safe Console.ReadKey
        // fallback (keyboard only) and let users opt in explicitly to try mouse scrolling.
        if (UnixMouseOptIn() && this.TrySetupUnix())
        {
            this.decoder = new VtInputDecoder(this.ReadByteUnix, this.HasInputUnix);
            this.unixActive = true;
        }
    }

    private static bool UnixMouseOptIn()
    {
        var value = Environment.GetEnvironmentVariable("GSI_MOUSE");
        if (string.IsNullOrEmpty(value))
        {
            return false;
        }

        return value is "1" or "true" or "yes" or "on"
            || value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase)
            || value.Equals("on", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Finalizes an instance of the <see cref="ConsoleInputReader"/> class.</summary>
    ~ConsoleInputReader()
    {
        this.Restore();
    }

    /// <inheritdoc/>
    public InputEvent? Read()
    {
        if (this.unixActive && this.decoder is not null)
        {
            return this.decoder.Next();
        }

        if (this.useWindowsNative)
        {
            return this.ReadWindowsNative();
        }

        return ReadFallback();
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        this.Restore();
        GC.SuppressFinalize(this);
    }

    private static InputEvent? ReadFallback()
    {
        var key = Console.ReadKey(intercept: true);
        return InputEvent.FromKey(key);
    }

    private static bool IsModifierKey(ushort vk) => vk switch
    {
        0x10 or 0x11 or 0x12 => true, // Shift, Control, Alt
        0x14 => true, // CapsLock
        0x90 or 0x91 => true, // NumLock, ScrollLock
        0x5b or 0x5c => true, // Left/Right Win
        _ => false,
    };

    private bool TrySetupWindows()
    {
        try
        {
            this.stdInHandle = NativeMethods.GetStdHandle(NativeMethods.STD_INPUT_HANDLE);
            if (this.stdInHandle == IntPtr.Zero || this.stdInHandle == NativeMethods.INVALID_HANDLE_VALUE)
            {
                return false;
            }

            if (!NativeMethods.GetConsoleMode(this.stdInHandle, out this.originalMode))
            {
                return false;
            }

            var mode = this.originalMode;
            mode |= NativeMethods.ENABLE_MOUSE_INPUT | NativeMethods.ENABLE_EXTENDED_FLAGS;
            mode &= ~NativeMethods.ENABLE_QUICK_EDIT_MODE;
            mode &= ~NativeMethods.ENABLE_VIRTUAL_TERMINAL_INPUT;
            if (!NativeMethods.SetConsoleMode(this.stdInHandle, mode))
            {
                return false;
            }

            this.windowsModeChanged = true;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private InputEvent? ReadWindowsNative()
    {
        while (true)
        {
            var records = new NativeMethods.InputRecord[1];
            if (!NativeMethods.ReadConsoleInput(this.stdInHandle, records, 1, out var read) || read == 0)
            {
                return ReadFallback();
            }

            var record = records[0];
            if (record.EventType == NativeMethods.KEY_EVENT)
            {
                var ke = record.Key;
                if (ke.KeyDown == 0)
                {
                    continue;
                }

                var vk = ke.VirtualKeyCode;
                if (IsModifierKey(vk))
                {
                    continue;
                }

                var state = ke.ControlKeyState;
                var shift = (state & NativeMethods.SHIFT_PRESSED) != 0;
                var alt = (state & (NativeMethods.LEFT_ALT_PRESSED | NativeMethods.RIGHT_ALT_PRESSED)) != 0;
                var control = (state & (NativeMethods.LEFT_CTRL_PRESSED | NativeMethods.RIGHT_CTRL_PRESSED)) != 0;
                var info = new ConsoleKeyInfo((char)ke.UnicodeChar, (ConsoleKey)vk, shift, alt, control);
                return InputEvent.FromKey(info);
            }

            if (record.EventType == NativeMethods.MOUSE_EVENT)
            {
                var me = record.Mouse;
                if (me.EventFlags == NativeMethods.MOUSE_WHEELED)
                {
                    var delta = (short)((me.ButtonState >> 16) & 0xffff);
                    return InputEvent.FromScroll(delta > 0 ? ScrollDirection.Up : ScrollDirection.Down);
                }
            }
        }
    }

    private bool TrySetupUnix()
    {
        if (Console.IsOutputRedirected)
        {
            return false;
        }

        try
        {
            this.savedStty = RunStty("-g", capture: true);
            if (string.IsNullOrWhiteSpace(this.savedStty))
            {
                return false;
            }

            if (RunStty("-echo -icanon -isig -ixon min 1 time 0", capture: false) is null)
            {
                return false;
            }

            // Enable X10 + SGR mouse reporting.
            Console.Out.Write("\u001b[?1000h\u001b[?1006h");
            Console.Out.Flush();
            return true;
        }
        catch
        {
            if (this.savedStty is not null)
            {
                try
                {
                    RunStty(this.savedStty, capture: false);
                }
                catch
                {
                    // Best effort.
                }
            }

            return false;
        }
    }

    private static string? RunStty(string arguments, bool capture)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "stty",
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = capture,
            RedirectStandardInput = false,
            RedirectStandardError = true,
        };

        using var process = Process.Start(psi);
        if (process is null)
        {
            return null;
        }

        var output = capture ? process.StandardOutput.ReadToEnd() : string.Empty;
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            return null;
        }

        return capture ? output.Trim() : string.Empty;
    }

    private int ReadByteUnix()
    {
        var buffer = new byte[1];
        var n = NativeMethods.read(0, buffer, 1);
        return n == 1 ? buffer[0] : -1;
    }

    private bool HasInputUnix(int timeoutMs)
    {
        var fds = new NativeMethods.PollFd[1];
        fds[0].Fd = 0;
        fds[0].Events = NativeMethods.POLLIN;
        var result = NativeMethods.poll(fds, 1, timeoutMs);
        return result > 0 && (fds[0].Revents & NativeMethods.POLLIN) != 0;
    }

    private void Restore()
    {
        if (this.restored)
        {
            return;
        }

        this.restored = true;

        if (this.windowsModeChanged)
        {
            try
            {
                NativeMethods.SetConsoleMode(this.stdInHandle, this.originalMode);
            }
            catch
            {
                // Best effort.
            }
        }

        if (this.unixActive)
        {
            this.unixActive = false;
            try
            {
                Console.Out.Write("\u001b[?1006l\u001b[?1000l");
                Console.Out.Flush();
            }
            catch
            {
                // Best effort.
            }

            if (this.savedStty is not null)
            {
                try
                {
                    RunStty(this.savedStty, capture: false);
                }
                catch
                {
                    // Best effort.
                }
            }
        }
    }

    private static class NativeMethods
    {
        public const int STD_INPUT_HANDLE = -10;
        public const uint ENABLE_MOUSE_INPUT = 0x0010;
        public const uint ENABLE_QUICK_EDIT_MODE = 0x0040;
        public const uint ENABLE_EXTENDED_FLAGS = 0x0080;
        public const uint ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

        public const ushort KEY_EVENT = 0x0001;
        public const ushort MOUSE_EVENT = 0x0002;
        public const uint MOUSE_WHEELED = 0x0004;

        public const uint SHIFT_PRESSED = 0x0010;
        public const uint LEFT_ALT_PRESSED = 0x0002;
        public const uint RIGHT_ALT_PRESSED = 0x0001;
        public const uint LEFT_CTRL_PRESSED = 0x0008;
        public const uint RIGHT_CTRL_PRESSED = 0x0004;

        public const short POLLIN = 0x001;

        public static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleInputW")]
        public static extern bool ReadConsoleInput(IntPtr hConsoleInput, [Out] InputRecord[] lpBuffer, uint nLength, out uint lpNumberOfEventsRead);

        [DllImport("libc", SetLastError = true)]
        public static extern nint read(int fd, [Out] byte[] buffer, nint count);

        [DllImport("libc", SetLastError = true)]
        public static extern int poll([In, Out] PollFd[] fds, uint nfds, int timeout);

        [StructLayout(LayoutKind.Sequential)]
        public struct PollFd
        {
            public int Fd;
            public short Events;
            public short Revents;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Coord
        {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KeyEventRecord
        {
            public int KeyDown;
            public ushort RepeatCount;
            public ushort VirtualKeyCode;
            public ushort VirtualScanCode;
            public ushort UnicodeChar;
            public uint ControlKeyState;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MouseEventRecord
        {
            public Coord MousePosition;
            public uint ButtonState;
            public uint ControlKeyState;
            public uint EventFlags;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputRecord
        {
            [FieldOffset(0)]
            public ushort EventType;

            [FieldOffset(4)]
            public KeyEventRecord Key;

            [FieldOffset(4)]
            public MouseEventRecord Mouse;
        }
    }
}
