// <copyright file="ReplHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Repl.Engine;
using GSharp.Repl.Screens;
using GSharp.Repl.Shell;
using Spectre.Console;

namespace GSharp.Repl;

/// <summary>Owns the alt-screen lifecycle and the AppShell. Restores the terminal on exit.</summary>
public static class ReplHost
{
    public static int Run(string version = "1.0")
    {
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
}
