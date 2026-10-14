// <copyright file="AltScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import System
import System.IO

/// Tiny ANSI helper that toggles the alt-screen buffer and synchronized updates.
/// Bypasses Spectre so Enter/Leave work even if the shell crashes mid-render.
shared class AltScreen {
    const EnterSequence string = "\u001B[?1049h\u001B[?25l"
    const LeaveSequence string = "\u001B[?25h\u001B[?1049l"
    const ClearSequence string = "\u001B[H\u001B[2J"
    const SyncStartSequence string = "\u001B[?2026h"
    const SyncEndSequence string = "\u001B[?2026l"

    func InjectEraseBeforeNewlines(raw string) string {
        if string.IsNullOrEmpty(raw) {
            return raw ?? string.Empty
        }
        return raw.Replace("\r\n", "\n").Replace("\r", string.Empty).Replace("\n", "\u001B[K\n")
    }

    func Enter(writer TextWriter? = nil) -> Emit(EnterSequence, writer)

    func Leave(writer TextWriter? = nil) -> Emit(LeaveSequence, writer)

    func Clear(writer TextWriter? = nil) -> Emit(ClearSequence, writer)

    private func Emit(seq string, writer TextWriter?) {
        let w = writer ?? Console.Out
        try {
            w.Write(seq)
            w.Flush()
        } catch {
            // Best effort.

        }
    }
}
