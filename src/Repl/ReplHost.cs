// <copyright file="ReplHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection;
using GSharp.Repl.Engine;
using GSharp.Repl.Screens;
using GSharp.Repl.Shell;
using Spectre.Console;

namespace GSharp.Repl;

/// <summary>Owns the alt-screen lifecycle and the AppShell. Restores the terminal on exit.</summary>
public static class ReplHost
{
    /// <summary>
    /// Runs the interactive TUI over the default engine — the emitted
    /// submission-chaining <see cref="EmittedSessionEngine"/> (ADR-0156
    /// Phase 3a).
    /// </summary>
    /// <returns>The process exit code.</returns>
    public static int Run() => Run(new EmittedSessionEngine());

    /// <summary>
    /// Runs the interactive TUI over the given evaluation engine (ADR-0156
    /// Phase 2: the tree-walking <see cref="SessionEngine"/> or the emitted
    /// <see cref="EmittedSessionEngine"/>).
    /// </summary>
    /// <param name="engine">The evaluation engine driving the session.</param>
    /// <returns>The process exit code.</returns>
    public static int Run(ISessionEngine engine)
    {
        // The TUI renders Unicode glyphs (box-drawing rules, status dots, prompt
        // chevrons, ellipses). On Windows the console defaults to a legacy OEM code
        // page that lacks these, rendering them as '?'. Force UTF-8 before any output.
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
        }
        catch
        {
            // Output is redirected or the encoding can't be changed; ignore.
        }

        var tabs = new List<ITabScreen>
        {
            new ReplScreen(engine),
        };

        var shell = new AppShell(AnsiConsole.Console, tabs);
        var prevCtrlC = false;
        try
        {
            try
            {
                prevCtrlC = Console.TreatControlCAsInput;
                Console.TreatControlCAsInput = true;
            }
            catch
            {
                // ignore
            }

            AltScreen.Enter();
            using var input = new ConsoleInputReader();
            return shell.Run(input);
        }
        finally
        {
            AltScreen.Leave();
            try
            {
                Console.TreatControlCAsInput = prevCtrlC;
            }
            catch
            {
                // ignore
            }

            (engine as IDisposable)?.Dispose();
        }
    }

    /// <summary>Resolves the build version from the assembly's informational version (set by Nerdbank GitVersioning).</summary>
    internal static string GetVersion()
    {
        var info = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(info))
        {
            return "1.0";
        }

        var plus = info.IndexOf('+');
        return plus >= 0 ? info.Substring(0, plus) : info;
    }
}
