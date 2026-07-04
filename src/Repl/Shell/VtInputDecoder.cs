// <copyright file="VtInputDecoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Text;

namespace GSharp.Repl.Shell;

/// <summary>
/// Decodes a raw terminal byte stream (as produced by a Unix terminal in raw mode with SGR
/// mouse reporting enabled) into <see cref="InputEvent"/> values. Handles printable UTF-8
/// text, control keys, xterm CSI/SS3 escape sequences for the keys the REPL uses, and both
/// SGR (<c>ESC [ &lt; b ; x ; y M</c>) and legacy (<c>ESC [ M ...</c>) mouse-wheel reports.
/// The OS-specific byte plumbing is injected so the decoder is fully unit-testable.
/// </summary>
public sealed class VtInputDecoder
{
    private const int EscTimeoutMs = 40;

    private readonly Func<int> readByte;
    private readonly Func<int, bool> hasInput;

    /// <summary>Initializes a new instance of the <see cref="VtInputDecoder"/> class.</summary>
    /// <param name="readByte">Blocking read of one byte; returns -1 at end of input.</param>
    /// <param name="hasInput">Returns true if a byte is available within the given timeout (ms).</param>
    public VtInputDecoder(Func<int> readByte, Func<int, bool> hasInput)
    {
        this.readByte = readByte ?? throw new ArgumentNullException(nameof(readByte));
        this.hasInput = hasInput ?? throw new ArgumentNullException(nameof(hasInput));
    }

    /// <summary>Reads and decodes the next input event, or <c>null</c> at end of input.</summary>
    public InputEvent? Next()
    {
        while (true)
        {
            var b = this.readByte();
            if (b < 0)
            {
                return null;
            }

            switch (b)
            {
                case 0x1b:
                    var esc = this.DecodeEscape(out var ignore);
                    if (ignore)
                    {
                        continue;
                    }

                    return esc;
                case 0x0d:
                case 0x0a:
                    return Key('\r', ConsoleKey.Enter);
                case 0x09:
                    return Key('\t', ConsoleKey.Tab);
                case 0x7f:
                case 0x08:
                    return Key('\b', ConsoleKey.Backspace);
                default:
                    if (b < 0x20)
                    {
                        return ControlChar(b);
                    }

                    return this.Printable(b);
            }
        }
    }

    private static InputEvent Key(char keyChar, ConsoleKey key, bool shift = false, bool alt = false, bool control = false)
        => InputEvent.FromKey(new ConsoleKeyInfo(keyChar, key, shift, alt, control));

    private static InputEvent ControlChar(int b)
    {
        // Ctrl+@ / Ctrl+Space arrives as NUL.
        if (b == 0)
        {
            return Key('\0', ConsoleKey.Spacebar, control: true);
        }

        // Ctrl+A..Ctrl+Z (Tab/Enter/Backspace are handled earlier).
        if (b >= 1 && b <= 26)
        {
            var key = (ConsoleKey)('A' + (b - 1));
            return Key((char)b, key, control: true);
        }

        return Key((char)b, ConsoleKey.None, control: true);
    }

    private static (bool Shift, bool Alt, bool Control) Modifiers(int code)
    {
        if (code < 2)
        {
            return (false, false, false);
        }

        var bits = code - 1;
        return ((bits & 1) != 0, (bits & 2) != 0, (bits & 4) != 0);
    }

    private static InputEvent? DecodeArrowOrEdit(char final, int modCode)
    {
        var (shift, alt, control) = Modifiers(modCode);
        var key = final switch
        {
            'A' => ConsoleKey.UpArrow,
            'B' => ConsoleKey.DownArrow,
            'C' => ConsoleKey.RightArrow,
            'D' => ConsoleKey.LeftArrow,
            'H' => ConsoleKey.Home,
            'F' => ConsoleKey.End,
            'Z' => ConsoleKey.Tab,
            _ => ConsoleKey.None,
        };

        if (key == ConsoleKey.None)
        {
            return null;
        }

        // ESC [ Z is Shift+Tab.
        if (final == 'Z')
        {
            shift = true;
        }

        return Key('\0', key, shift, alt, control);
    }

    private static InputEvent? DecodeTilde(int number, int modCode)
    {
        var (shift, alt, control) = Modifiers(modCode);
        var key = number switch
        {
            1 or 7 => ConsoleKey.Home,
            2 => ConsoleKey.Insert,
            3 => ConsoleKey.Delete,
            4 or 8 => ConsoleKey.End,
            5 => ConsoleKey.PageUp,
            6 => ConsoleKey.PageDown,
            11 => ConsoleKey.F1,
            12 => ConsoleKey.F2,
            13 => ConsoleKey.F3,
            14 => ConsoleKey.F4,
            15 => ConsoleKey.F5,
            17 => ConsoleKey.F6,
            18 => ConsoleKey.F7,
            19 => ConsoleKey.F8,
            20 => ConsoleKey.F9,
            21 => ConsoleKey.F10,
            23 => ConsoleKey.F11,
            24 => ConsoleKey.F12,
            _ => ConsoleKey.None,
        };

        return key == ConsoleKey.None ? null : Key('\0', key, shift, alt, control);
    }

    private static InputEvent? WheelFromButton(int button)
    {
        // Wheel events set bit 6 (64). Even button => up, odd => down.
        if ((button & 0x40) == 0)
        {
            return null;
        }

        return InputEvent.FromScroll((button & 1) == 0 ? ScrollDirection.Up : ScrollDirection.Down);
    }

    private InputEvent? DecodeEscape(out bool ignore)
    {
        ignore = false;
        if (!this.hasInput(EscTimeoutMs))
        {
            return Key('\x1b', ConsoleKey.Escape);
        }

        var b1 = this.readByte();
        return b1 switch
        {
            '[' => this.DecodeCsi(out ignore),
            'O' => this.DecodeSs3(),
            < 0 => Key('\x1b', ConsoleKey.Escape),

            // ESC followed by another byte: treat as Alt+<byte> (best effort).
            _ => this.DecodeAlt(b1),
        };
    }

    private InputEvent? DecodeAlt(int b)
    {
        if (b >= 0x20 && b < 0x7f)
        {
            var c = (char)b;
            var key = LetterOrDigitKey(c, out var shift);
            return Key(c, key, shift, alt: true);
        }

        return Key('\x1b', ConsoleKey.Escape);
    }

    private InputEvent? DecodeSs3()
    {
        // SS3 function keys: ESC O P..S => F1..F4.
        var b = this.readByte();
        var key = b switch
        {
            'P' => ConsoleKey.F1,
            'Q' => ConsoleKey.F2,
            'R' => ConsoleKey.F3,
            'S' => ConsoleKey.F4,
            'H' => ConsoleKey.Home,
            'F' => ConsoleKey.End,
            _ => ConsoleKey.None,
        };

        return key == ConsoleKey.None ? null : Key('\0', key);
    }

    private InputEvent? DecodeCsi(out bool ignore)
    {
        ignore = false;
        var sb = new StringBuilder();
        int final;
        while (true)
        {
            var b = this.readByte();
            if (b < 0)
            {
                ignore = true;
                return null;
            }

            if (b >= 0x40 && b <= 0x7e)
            {
                final = b;
                break;
            }

            sb.Append((char)b);
        }

        var param = sb.ToString();

        // Mouse reports.
        if (param.StartsWith('<'))
        {
            var sgr = this.DecodeSgrMouse(param, (char)final);
            ignore = sgr is null;
            return sgr;
        }

        if (final == 'M' && param.Length == 0)
        {
            var legacy = this.DecodeLegacyMouse();
            ignore = legacy is null;
            return legacy;
        }

        // Modifier is the second ';'-separated parameter, if any.
        var parts = param.Split(';');
        var modCode = parts.Length > 1 && int.TryParse(parts[1], out var m) ? m : 0;

        if (final == '~')
        {
            var number = int.TryParse(parts[0], out var n) ? n : 0;
            var tilde = DecodeTilde(number, modCode);
            ignore = tilde is null;
            return tilde;
        }

        var arrow = DecodeArrowOrEdit((char)final, modCode);
        ignore = arrow is null;
        return arrow;
    }

    private InputEvent? DecodeSgrMouse(string param, char final)
    {
        // param is like "<64;12;3"; a wheel event only registers on press ('M').
        if (final != 'M')
        {
            return null;
        }

        var parts = param.TrimStart('<').Split(';');
        if (parts.Length >= 1 && int.TryParse(parts[0], out var button))
        {
            return WheelFromButton(button);
        }

        return null;
    }

    private InputEvent? DecodeLegacyMouse()
    {
        // ESC [ M followed by three bytes, each offset by 32.
        var button = this.readByte();
        this.readByte();
        this.readByte();
        return button < 0 ? null : WheelFromButton(button - 32);
    }

    private InputEvent? Printable(int b)
    {
        if (b < 0x80)
        {
            var c = (char)b;
            var key = LetterOrDigitKey(c, out var shift);
            return Key(c, key, shift);
        }

        // Decode a UTF-8 multi-byte sequence.
        var extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1;
        Span<byte> bytes = stackalloc byte[4];
        bytes[0] = (byte)b;
        var count = 1;
        for (var i = 0; i < extra; i++)
        {
            var cont = this.readByte();
            if (cont < 0)
            {
                break;
            }

            bytes[count++] = (byte)cont;
        }

        var text = Encoding.UTF8.GetString(bytes[..count]);
        var ch = text.Length > 0 ? text[0] : '\0';
        return Key(ch, ConsoleKey.None);
    }

    private static ConsoleKey LetterOrDigitKey(char c, out bool shift)
    {
        shift = false;
        if (c >= 'A' && c <= 'Z')
        {
            shift = true;
            return (ConsoleKey)c;
        }

        if (c >= 'a' && c <= 'z')
        {
            return (ConsoleKey)(c - 32);
        }

        if (c >= '0' && c <= '9')
        {
            return (ConsoleKey)c;
        }

        return ConsoleKey.None;
    }
}
