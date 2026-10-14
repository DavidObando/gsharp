// <copyright file="InlinePrompt.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import System
import System.IO
import System.Text

/// Reads a single line of standard input from the user while the alt-screen TUI is active.
/// Evaluation runs synchronously inside the shell's key loop, so when interpreted code calls
/// `Console.ReadLine()` we pause and draw an inline prompt at the bottom of the screen,
/// echoing keystrokes until Enter. Output is written straight to the real terminal stream so it
/// is unaffected by the per-cell (cref:Console.Out) capture.
shared class InlinePrompt {
    private let Terminal TextWriter = CreateTerminalWriter()

    /// Prompt for and return one line of input, or `null` on Esc/EOF.
    func ReadLine() string? {
        let sb = StringBuilder()
        Draw(sb.ToString())
        while true {
            var key ConsoleKeyInfo
            try {
                key = Console.ReadKey(intercept: true)
            } catch (InvalidOperationException) {
                return if sb.Length == 0 {
                    default(string?)
                } else {
                    sb.ToString()
                }
            }
            switch key.Key {
                case ConsoleKey.Enter {
                    return sb.ToString()
                }
                case ConsoleKey.Escape {
                    return nil
                }
                case ConsoleKey.Backspace {
                    if sb.Length > 0 {
                        sb.Length--
                    }
                }
                default {
                    if !char.IsControl(key.KeyChar) {
                        sb.Append(key.KeyChar)
                    }
                }
            }
            Draw(sb.ToString())
        }
    }

    private func Draw(current string) {
        var row int32
        try {
            row = Math.Max(1, Console.WindowHeight)
        } catch {
            row = 24
        }
        let line = "stdin › $current█"
        try {
            Terminal.Write(
                "${AltScreen.SyncStartSequence}\u001B[$row;1H\u001B[2K$line\u001B[K${AltScreen.SyncEndSequence}"
            )
            Terminal.Flush()
        } catch {
            // Best effort: the frame re-render after evaluation restores the screen anyway.

        }
    }

    private func CreateTerminalWriter() TextWriter {
        try {
            // Bind to the raw stdout stream so drawing bypasses any Console.SetOut redirection
            // installed while a cell is being evaluated. leaveOpen keeps stdout usable afterwards.
            return StreamWriter(Console.OpenStandardOutput(), Console.OutputEncoding, 1024, leaveOpen: true){
                AutoFlush = true
            }
        } catch {
            return Console.Out
        }
    }
}
