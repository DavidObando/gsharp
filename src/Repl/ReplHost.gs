// <copyright file="ReplHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl

import GSharp.Repl.Engine
import GSharp.Repl.Screens
import GSharp.Repl.Shell
import Spectre.Console
import System
import System.Collections.Generic
import System.Reflection
import System.Text

/// Owns the alt-screen lifecycle and the AppShell. Restores the terminal on exit.
shared class ReplHost {
    /// Runs the interactive TUI over the default engine — the emitted
    /// submission-chaining (cref:EmittedSessionEngine) (ADR-0156
    /// Phase 3a).
    /// @returns The process exit code.
    func Run() int32 -> Run(EmittedSessionEngine())

    /// Runs the interactive TUI over the given evaluation engine (ADR-0156:
    /// the emitted (cref:EmittedSessionEngine), or any test double
    /// implementing (cref:ISessionEngine)).
    /// @param engine The evaluation engine driving the session.
    /// @returns The process exit code.
    func Run(engine ISessionEngine) int32 {
        // The TUI renders Unicode glyphs (box-drawing rules, status dots, prompt
        // chevrons, ellipses). On Windows the console defaults to a legacy OEM code
        // page that lacks these, rendering them as '?'. Force UTF-8 before any output.
        try {
            Console.OutputEncoding = Encoding.UTF8
        } catch {
            // Output is redirected or the encoding can't be changed; ignore.

        }
        let tabs = List[ITabScreen]{ReplScreen(engine)}
        let shell = AppShell(AnsiConsole.Console, tabs)
        var prevCtrlC = false
        try {
            try {
                prevCtrlC = Console.TreatControlCAsInput
                Console.TreatControlCAsInput = true
            } catch {
                // ignore

            }
            AltScreen.Enter()
            using let input = ConsoleInputReader()
            return shell.Run(input)
        } finally {
            AltScreen.Leave()
            try {
                Console.TreatControlCAsInput = prevCtrlC
            } catch {
                // ignore

            }
            (engine as IDisposable)?.Dispose()
        }
    }

    /// Resolves the build version from the assembly's informational version (set by Nerdbank
    /// GitVersioning).
    internal func GetVersion() string {
        let info = Assembly
            .GetExecutingAssembly()
            .GetCustomAttribute[AssemblyInformationalVersionAttribute]()
            ?.InformationalVersion
        if string.IsNullOrEmpty(info) {
            return "1.0"
        }
        let plus = info.IndexOf('+')
        return if plus >= 0 {
            info.Substring(0, plus)
        } else {
            info
        }
    }
}
