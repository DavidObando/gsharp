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
    public static int Run(string? version = null)
    {
        version ??= GetVersion();
        var engine = new SessionEngine();
        var tabs = new List<ITabScreen>
        {
            new ReplScreen(engine),
        };

        var shell = new AppShell(AnsiConsole.Console, tabs, version);
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
            return shell.Run(new AppShell.ConsoleKeyReader());
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
        }
    }

    /// <summary>Resolves the build version from the assembly's informational version (set by Nerdbank GitVersioning).</summary>
    private static string GetVersion()
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
