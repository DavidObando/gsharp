// <copyright file="ConsoleInputReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import System
import System.Runtime.InteropServices
import System.Threading

/// Reads keyboard and mouse-wheel input from the console. On Windows it uses the native
/// `ReadConsoleInput` API so wheel notches surface as scroll events. On macOS/Linux there is
/// no reliable low-level mouse path, so input is read via (cref:Console.ReadKey(bool))
/// (keyboard only); scrolling on Unix is expected to be done via the keyboard (e.g. PageUp/PageDown).
internal open class ConsoleInputReader : IInputReader, IDisposable {
    private let useWindowsNative bool
    private var stdInHandle nint = nint.Zero
    private var originalMode uint32
    private var windowsModeChanged bool
    private var restored bool

    /// Initializes a new instance of the (cref:ConsoleInputReader) class.
    init() {
        if Console.IsInputRedirected {
            return
        }
        if OperatingSystem.IsWindows() {
            this.useWindowsNative = this.TrySetupWindows()
        }
    }

    /// Finalizes an instance of the (cref:ConsoleInputReader) class.
    deinit {
        this.Restore()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Read() InputEvent? {
        if this.useWindowsNative {
            return this.ReadWindowsNative()
        }
        return ReadFallback()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Read(timeout TimeSpan, out timedOut bool) InputEvent? {
        if this.useWindowsNative {
            return this.ReadWindowsNative(timeout, out timedOut)
        }
        return ReadFallback(timeout, out timedOut)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        this.Restore()
        GC.SuppressFinalize(this)
    }

    private func TrySetupWindows() bool {
        try {
            this.stdInHandle = NativeMethods.GetStdHandle(NativeMethods.STD_INPUT_HANDLE)
            if this.stdInHandle == nint.Zero || this.stdInHandle == NativeMethods.INVALID_HANDLE_VALUE {
                return false
            }
            if !NativeMethods.GetConsoleMode(this.stdInHandle, &this.originalMode) {
                return false
            }
            var mode = this.originalMode
            mode |= NativeMethods.ENABLE_EXTENDED_FLAGS
            mode |= NativeMethods.ENABLE_QUICK_EDIT_MODE
            mode &= ~NativeMethods.ENABLE_VIRTUAL_TERMINAL_INPUT
            if !NativeMethods.SetConsoleMode(this.stdInHandle, mode) {
                return false
            }
            this.windowsModeChanged = true
            return true
        } catch {
            return false
        }
    }

    private func ReadWindowsNative() InputEvent? {
        while true {
            if !NativeMethods.ReadConsoleInput(this.stdInHandle, out var record, 1, out var read) || read == uint32(0) {
                return ReadFallback()
            }
            if record.EventType == NativeMethods.KEY_EVENT {
                let ke = record.Key
                if ke.KeyDown == 0 {
                    continue
                }
                let vk = ke.VirtualKeyCode
                if IsModifierKey(vk) {
                    continue
                }
                let state = ke.ControlKeyState
                let shift = (state & NativeMethods.SHIFT_PRESSED) != uint32(0)
                let alt = (state & (NativeMethods.LEFT_ALT_PRESSED | NativeMethods.RIGHT_ALT_PRESSED)) != uint32(0)
                let control = (state & (NativeMethods.LEFT_CTRL_PRESSED | NativeMethods.RIGHT_CTRL_PRESSED)) != uint32(
                    0
                )
                let info = ConsoleKeyInfo(char(ke.UnicodeChar), ConsoleKey(vk), shift, alt, control)
                return InputEvent.FromKey(info)
            }
        }
    }

    private func ReadWindowsNative(timeout TimeSpan, out timedOut bool) InputEvent? {
        let deadline = DateTime.UtcNow + timeout
        while true {
            let remaining = deadline - DateTime.UtcNow
            let waitMs = if remaining <= TimeSpan.Zero {
                uint32(0)
            } else {
                uint32(Math.Min(remaining.TotalMilliseconds, uint32.MaxValue - uint32(1)))
            }
            let waitResult = NativeMethods.WaitForSingleObject(this.stdInHandle, waitMs)
            if waitResult != NativeMethods.WAIT_OBJECT_0 {
                timedOut = true
                return nil
            }
            if !NativeMethods.ReadConsoleInput(this.stdInHandle, out var record, 1, out var read) || read == uint32(0) {
                timedOut = false
                return ReadFallback()
            }
            if record.EventType == NativeMethods.KEY_EVENT {
                let ke = record.Key
                if ke.KeyDown == 0 || IsModifierKey(ke.VirtualKeyCode) {
                    continue
                }
                let state = ke.ControlKeyState
                let shift = (state & NativeMethods.SHIFT_PRESSED) != uint32(0)
                let alt = (state & (NativeMethods.LEFT_ALT_PRESSED | NativeMethods.RIGHT_ALT_PRESSED)) != uint32(0)
                let control = (state & (NativeMethods.LEFT_CTRL_PRESSED | NativeMethods.RIGHT_CTRL_PRESSED)) != uint32(
                    0
                )
                let info = ConsoleKeyInfo(char(ke.UnicodeChar), ConsoleKey(ke.VirtualKeyCode), shift, alt, control)
                timedOut = false
                return InputEvent.FromKey(info)
            }
        }
    }

    private func Restore() {
        if this.restored {
            return
        }
        this.restored = true
        if this.windowsModeChanged {
            try {
                NativeMethods.SetConsoleMode(this.stdInHandle, this.originalMode)
            } catch {
                // Best effort.

            }
        }
    }

    private shared class NativeMethods {
        @StructLayout(LayoutKind.Sequential)
        struct Coord {
            var X int16
            var Y int16
        }

        @StructLayout(LayoutKind.Sequential)
        struct KeyEventRecord {
            var KeyDown int32
            var RepeatCount uint16
            var VirtualKeyCode uint16
            var VirtualScanCode uint16
            var UnicodeChar uint16
            var ControlKeyState uint32
        }

        @StructLayout(LayoutKind.Explicit)
        struct InputRecord {
            @FieldOffset(int32(0))
            var EventType uint16

            @FieldOffset(int32(4))
            var Key KeyEventRecord
        }

        const STD_INPUT_HANDLE int32 = -10
        const ENABLE_QUICK_EDIT_MODE uint32 = uint32(0x0040)
        const ENABLE_EXTENDED_FLAGS uint32 = uint32(0x0080)
        const ENABLE_VIRTUAL_TERMINAL_INPUT uint32 = uint32(0x0200)
        const KEY_EVENT uint16 = uint16(0x0001)
        const SHIFT_PRESSED uint32 = uint32(0x0010)
        const LEFT_ALT_PRESSED uint32 = uint32(0x0002)
        const RIGHT_ALT_PRESSED uint32 = uint32(0x0001)
        const LEFT_CTRL_PRESSED uint32 = uint32(0x0008)
        const RIGHT_CTRL_PRESSED uint32 = uint32(0x0004)
        const WAIT_OBJECT_0 uint32 = uint32(0x00000000)
        let INVALID_HANDLE_VALUE nint = nint(-1)

        @DllImport("kernel32.dll", SetLastError = true)
        func GetStdHandle(nStdHandle int32) nint;

        @DllImport("kernel32.dll", SetLastError = true)
        func GetConsoleMode(hConsoleHandle nint, out lpMode uint32) bool;

        @DllImport("kernel32.dll", SetLastError = true)
        func SetConsoleMode(hConsoleHandle nint, dwMode uint32) bool;

        @DllImport("kernel32.dll", SetLastError = true)
        func WaitForSingleObject(hHandle nint, dwMilliseconds uint32) uint32;

        @DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleInputW")
        func ReadConsoleInput(
            hConsoleInput nint,
            out lpBuffer InputRecord,
            nLength uint32,
            out lpNumberOfEventsRead uint32
        ) bool;
    }

    shared {
        private func ReadFallback() InputEvent? {
            let key = Console.ReadKey(intercept: true)
            return InputEvent.FromKey(key)
        }

        private let PollInterval TimeSpan = TimeSpan.FromMilliseconds(15)

        private func ReadFallback(timeout TimeSpan, out timedOut bool) InputEvent? {
            var available bool
            try {
                available = Console.KeyAvailable
            } catch (InvalidOperationException) {
                // Input is redirected (no console to poll) — fall back to a blocking read.
                timedOut = false
                return ReadFallback()
            }
            let deadline = DateTime.UtcNow + timeout
            while !available && DateTime.UtcNow < deadline {
                Thread.Sleep(PollInterval)
                available = Console.KeyAvailable
            }
            if !available {
                timedOut = true
                return nil
            }
            timedOut = false
            return InputEvent.FromKey(Console.ReadKey(intercept: true))
        }

        private func IsModifierKey(vk uint16) bool -> switch vk {
            case 0x10 or 0x11 or 0x12: true
            case 0x14: true
            case 0x90 or 0x91: true
            case 0x5b or 0x5c: true
            default: false
        }
    }
}
