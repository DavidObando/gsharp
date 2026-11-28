// <copyright file="ReplHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl

import GSharp.Repl.Engine
import GSharp.Repl.Screens
import GSharp.Repl.Shell
import SharpTui
import Spectre.Console
import System
import System.Collections.Generic
import System.Reflection
import System.Text

/// Owns the TUI host lifecycle and switches cleanly between SharpTUI and Spectre.Console
/// while preserving the active session engine.
shared class ReplHost {
    /// Runs the interactive TUI over the default engine and default UI (SharpTUI).
    /// @returns The process exit code.
    func Run() int32 -> Run(EmittedSessionEngine(), ReplUiKind.SharpTui)

    /// Runs the interactive TUI over the given evaluation engine using the default UI (SharpTUI).
    /// @param engine The evaluation engine driving the session.
    /// @returns The process exit code.
    func Run(engine ISessionEngine) int32 -> Run(engine, ReplUiKind.SharpTui)

    /// Runs the interactive TUI over the given evaluation engine, starting in the requested UI
    /// backend and allowing live switching between SharpTUI and Spectre.Console.
    /// @param engine The evaluation engine driving the session.
    /// @param initialUi The initial TUI backend to launch.
    /// @returns The process exit code.
    func Run(engine ISessionEngine, initialUi ReplUiKind) int32 {
        // The TUI renders Unicode glyphs (box-drawing rules, status dots, prompt
        // chevrons, ellipses). On Windows the console defaults to a legacy OEM code
        // page that lacks these, rendering them as '?'. Force UTF-8 before any output.
        try {
            Console.OutputEncoding = Encoding.UTF8
        } catch {
            // Output is redirected or the encoding can't be changed; ignore.

        }
        // Snapshot the untouched terminal state in .NET's ConsolePal before SharpTUI
        // enters raw mode and registers PosixSignal handlers. Otherwise libSystem.Native
        // captures raw termios as its baseline and Console.ReadKey skips disabling
        // ICANON/ECHO after switching from SharpTUI to Spectre.
        try {
            let _ = Console.TreatControlCAsInput
        } catch {
            // Input is redirected or unsupported; ignore.

        }
        var activeUi = initialUi
        try {
            while true {
                let nextUi ReplUiKind? = if activeUi == ReplUiKind.SharpTui {
                    RunSharpTui(engine)
                } else {
                    RunSpectre(engine)
                }
                if nextUi == nil {
                    return 0
                }
                activeUi = nextUi
            }
        } finally {
            engine.InputProvider = nil
            (engine as IDisposable)?.Dispose()
        }
    }

    private func RunSharpTui(engine ISessionEngine) ReplUiKind? {
        let root = ReplApp(engine)
        let app = App()
        root.Configure(app)
        try {
            app.Run(root)
            return root.RequestedUi
        } finally {
            root.CancelPendingInput()
            engine.InputProvider = nil
        }
    }

    private func RunSpectre(engine ISessionEngine) ReplUiKind? {
        let screen = ReplScreen(engine)
        let tabs = List[ITabScreen]{screen}
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
            let _ = shell.Run(input)
            return shell.RequestedUi
        } finally {
            AltScreen.Leave()
            try {
                Console.TreatControlCAsInput = prevCtrlC
            } catch {
                // ignore

            }
            screen.Dispose()
            engine.InputProvider = nil
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
