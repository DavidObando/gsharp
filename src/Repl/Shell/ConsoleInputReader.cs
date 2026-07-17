// <copyright file="ConsoleInputReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.InteropServices;

namespace GSharp.Repl.Shell;

/// <summary>
/// Reads keyboard and mouse-wheel input from the console. On Windows it uses the native
/// <c>ReadConsoleInput</c> API so wheel notches surface as scroll events. On macOS/Linux there is
/// no reliable low-level mouse path, so input is read via <see cref="Console.ReadKey(bool)"/>
/// (keyboard only); scrolling on Unix is expected to be done via the keyboard (e.g. PageUp/PageDown).
/// </summary>
internal sealed class ConsoleInputReader : IInputReader, IDisposable
{
    private readonly bool useWindowsNative;

    private IntPtr stdInHandle = IntPtr.Zero;
    private uint originalMode;
    private bool windowsModeChanged;

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
        }
    }

    /// <summary>Finalizes an instance of the <see cref="ConsoleInputReader"/> class.</summary>
    ~ConsoleInputReader()
    {
        this.Restore();
    }

    /// <inheritdoc/>
    public InputEvent? Read()
    {
        if (this.useWindowsNative)
        {
            return this.ReadWindowsNative();
        }

        return ReadFallback();
    }

    /// <inheritdoc/>
    public InputEvent? Read(TimeSpan timeout, out bool timedOut)
    {
        if (this.useWindowsNative)
        {
            return this.ReadWindowsNative(timeout, out timedOut);
        }

        return ReadFallback(timeout, out timedOut);
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

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(15);

    private static InputEvent? ReadFallback(TimeSpan timeout, out bool timedOut)
    {
        bool available;
        try
        {
            available = Console.KeyAvailable;
        }
        catch (InvalidOperationException)
        {
            // Input is redirected (no console to poll) — fall back to a blocking read.
            timedOut = false;
            return ReadFallback();
        }

        var deadline = DateTime.UtcNow + timeout;
        while (!available && DateTime.UtcNow < deadline)
        {
            System.Threading.Thread.Sleep(PollInterval);
            available = Console.KeyAvailable;
        }

        if (!available)
        {
            timedOut = true;
            return null;
        }

        timedOut = false;
        return InputEvent.FromKey(Console.ReadKey(intercept: true));
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
            mode |= NativeMethods.ENABLE_EXTENDED_FLAGS;
            mode |= NativeMethods.ENABLE_QUICK_EDIT_MODE;
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
        }
    }

    private InputEvent? ReadWindowsNative(TimeSpan timeout, out bool timedOut)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            var remaining = deadline - DateTime.UtcNow;
            var waitMs = remaining <= TimeSpan.Zero ? 0 : (uint)Math.Min(remaining.TotalMilliseconds, uint.MaxValue - 1);
            var waitResult = NativeMethods.WaitForSingleObject(this.stdInHandle, waitMs);
            if (waitResult != NativeMethods.WAIT_OBJECT_0)
            {
                timedOut = true;
                return null;
            }

            var records = new NativeMethods.InputRecord[1];
            if (!NativeMethods.ReadConsoleInput(this.stdInHandle, records, 1, out var read) || read == 0)
            {
                timedOut = false;
                return ReadFallback();
            }

            var record = records[0];
            if (record.EventType == NativeMethods.KEY_EVENT)
            {
                var ke = record.Key;
                if (ke.KeyDown == 0 || IsModifierKey(ke.VirtualKeyCode))
                {
                    continue;
                }

                var state = ke.ControlKeyState;
                var shift = (state & NativeMethods.SHIFT_PRESSED) != 0;
                var alt = (state & (NativeMethods.LEFT_ALT_PRESSED | NativeMethods.RIGHT_ALT_PRESSED)) != 0;
                var control = (state & (NativeMethods.LEFT_CTRL_PRESSED | NativeMethods.RIGHT_CTRL_PRESSED)) != 0;
                var info = new ConsoleKeyInfo((char)ke.UnicodeChar, (ConsoleKey)ke.VirtualKeyCode, shift, alt, control);
                timedOut = false;
                return InputEvent.FromKey(info);
            }
        }
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
    }

    private static class NativeMethods
    {
        public const int STD_INPUT_HANDLE = -10;
        public const uint ENABLE_QUICK_EDIT_MODE = 0x0040;
        public const uint ENABLE_EXTENDED_FLAGS = 0x0080;
        public const uint ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

        public const ushort KEY_EVENT = 0x0001;

        public const uint SHIFT_PRESSED = 0x0010;
        public const uint LEFT_ALT_PRESSED = 0x0002;
        public const uint RIGHT_ALT_PRESSED = 0x0001;
        public const uint LEFT_CTRL_PRESSED = 0x0008;
        public const uint RIGHT_CTRL_PRESSED = 0x0004;

        public const uint WAIT_OBJECT_0 = 0x00000000;

        public static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleInputW")]
        public static extern bool ReadConsoleInput(IntPtr hConsoleInput, [Out] InputRecord[] lpBuffer, uint nLength, out uint lpNumberOfEventsRead);

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

        [StructLayout(LayoutKind.Explicit)]
        public struct InputRecord
        {
            [FieldOffset(0)]
            public ushort EventType;

            [FieldOffset(4)]
            public KeyEventRecord Key;
        }
    }
}
