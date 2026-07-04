// <copyright file="InlinePrompt.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text;

namespace GSharp.Repl.Shell;

/// <summary>
/// Reads a single line of standard input from the user while the alt-screen TUI is active.
/// Evaluation runs synchronously inside the shell's key loop, so when interpreted code calls
/// <c>Console.ReadLine()</c> we pause and draw an inline prompt at the bottom of the screen,
/// echoing keystrokes until Enter. Output is written straight to the real terminal stream so it
/// is unaffected by the per-cell <see cref="Console.Out"/> capture.
/// </summary>
public static class InlinePrompt
{
    private static readonly TextWriter Terminal = CreateTerminalWriter();

    /// <summary>Prompt for and return one line of input, or <see langword="null"/> on Esc/EOF.</summary>
    public static string? ReadLine()
    {
        var sb = new StringBuilder();
        Draw(sb.ToString());
        while (true)
        {
            ConsoleKeyInfo key;
            try
            {
                key = Console.ReadKey(intercept: true);
            }
            catch (InvalidOperationException)
            {
                return sb.Length == 0 ? null : sb.ToString();
            }

            switch (key.Key)
            {
                case ConsoleKey.Enter:
                    return sb.ToString();
                case ConsoleKey.Escape:
                    return null;
                case ConsoleKey.Backspace:
                    if (sb.Length > 0)
                    {
                        sb.Length--;
                    }

                    break;
                default:
                    if (!char.IsControl(key.KeyChar))
                    {
                        sb.Append(key.KeyChar);
                    }

                    break;
            }

            Draw(sb.ToString());
        }
    }

    private static void Draw(string current)
    {
        int row;
        try
        {
            row = Math.Max(1, Console.WindowHeight);
        }
        catch
        {
            row = 24;
        }

        var line = $"stdin \u203a {current}\u2588";
        try
        {
            Terminal.Write($"{AltScreen.SyncStartSequence}\u001b[{row};1H\u001b[2K{line}\u001b[K{AltScreen.SyncEndSequence}");
            Terminal.Flush();
        }
        catch
        {
            // Best effort: the frame re-render after evaluation restores the screen anyway.
        }
    }

    private static TextWriter CreateTerminalWriter()
    {
        try
        {
            // Bind to the raw stdout stream so drawing bypasses any Console.SetOut redirection
            // installed while a cell is being evaluated. leaveOpen keeps stdout usable afterwards.
            return new StreamWriter(Console.OpenStandardOutput(), Console.OutputEncoding, 1024, leaveOpen: true)
            {
                AutoFlush = true,
            };
        }
        catch
        {
            return Console.Out;
        }
    }
}
