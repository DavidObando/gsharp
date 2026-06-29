// <copyright file="AppShell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Repl.Widgets;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Shell;

/// <summary>
/// Top-level TUI controller: header + tab strip + body + pinned hint bar, a modal
/// overlay, progressive Ctrl+C, and a flicker-free synchronized render loop.
/// </summary>
public sealed class AppShell : IAppShellNavigator
{
    public interface IKeyReader
    {
        ConsoleKeyInfo? ReadKey();
    }

    private readonly IAnsiConsole console;
    private readonly IReadOnlyList<ITabScreen> tabs;
    private readonly CtrlCState ctrlC = new();
    private readonly string version;

    private int activeTab;
    private IModal? activeModal;
    private string? toast;

    public AppShell(IAnsiConsole console, IReadOnlyList<ITabScreen> tabs, string version)
    {
        this.console = console ?? throw new ArgumentNullException(nameof(console));
        this.tabs = tabs is { Count: > 0 } ? tabs : throw new ArgumentException("At least one tab required.", nameof(tabs));
        this.version = version ?? string.Empty;
    }

    public int ActiveTab => activeTab;

    public void SwitchToTab(char numberKey)
    {
        for (var i = 0; i < tabs.Count; i++)
        {
            if (tabs[i].NumberKey == numberKey && i != activeTab)
            {
                activeTab = i;
                tabs[i].OnActivated(this);
                return;
            }
        }
    }

    public void ShowModal(IModal modal) => activeModal = modal ?? throw new ArgumentNullException(nameof(modal));

    public void DismissModal() => activeModal = null;

    public void ShowToast(string message) => toast = message ?? string.Empty;

    public int Run(IKeyReader keyReader)
    {
        ArgumentNullException.ThrowIfNull(keyReader);
        tabs[activeTab].OnActivated(this);
        Render();
        while (true)
        {
            var key = keyReader.ReadKey();
            if (key is null)
            {
                return 0;
            }

            var action = ShellAction.Continue;
            try
            {
                action = Dispatch(key.Value);
            }
            catch (Exception ex)
            {
                toast = $"Internal error: {ex.Message}";
            }

            if (action == ShellAction.Exit)
            {
                return 0;
            }

            try
            {
                Render();
            }
            catch (Exception ex)
            {
                toast = $"Render error: {ex.Message}";
            }
        }
    }

    public ShellAction Dispatch(ConsoleKeyInfo key)
    {
        if (!ctrlC.ToastActive)
        {
            toast = null;
        }

        if (key.Key == ConsoleKey.C && (key.Modifiers & ConsoleModifiers.Control) != 0)
        {
            if (activeModal is not null)
            {
                DismissModal();
                ctrlC.Reset();
                return ShellAction.Continue;
            }

            if (ctrlC.OnPress() == CtrlCAction.Exit)
            {
                return ShellAction.Exit;
            }

            toast = "Press Ctrl+C again to quit · Esc to stay";
            return ShellAction.Continue;
        }

        if (activeModal is not null)
        {
            activeModal.HandleKey(key);
            if (activeModal.IsComplete || key.Key == ConsoleKey.Escape)
            {
                DismissModal();
            }

            return ShellAction.Continue;
        }

        if (key.Key == ConsoleKey.Escape && toast is not null)
        {
            toast = null;
            ctrlC.Reset();
            return ShellAction.Continue;
        }

        if (tabs[activeTab].HandleKey(key))
        {
            return ShellAction.Continue;
        }

        if (key.KeyChar >= '1' && key.KeyChar <= '9')
        {
            var idx = key.KeyChar - '1';
            if (idx < tabs.Count)
            {
                activeTab = idx;
                tabs[idx].OnActivated(this);
            }

            return ShellAction.Continue;
        }

        switch (key.Key)
        {
            case ConsoleKey.Tab when (key.Modifiers & ConsoleModifiers.Shift) != 0:
                activeTab = (activeTab - 1 + tabs.Count) % tabs.Count;
                tabs[activeTab].OnActivated(this);
                break;
            case ConsoleKey.Tab:
                activeTab = (activeTab + 1) % tabs.Count;
                tabs[activeTab].OnActivated(this);
                break;
            case ConsoleKey.Q when (key.Modifiers & ConsoleModifiers.Shift) != 0:
                return ShellAction.Exit;
        }

        return ShellAction.Continue;
    }

    public void Render()
    {
        var width = console.Profile.Width;
        var height = Math.Max(10, console.Profile.Height);
        var bodyHeight = Math.Max(5, height - 6);
        var screen = tabs[activeTab];

        var useBuffer = !Console.IsOutputRedirected;
        StringWriter? sw = null;
        IAnsiConsole target;
        if (useBuffer)
        {
            sw = new StringWriter { NewLine = "\n" };
            target = AnsiConsole.Create(new AnsiConsoleSettings
            {
                Ansi = AnsiSupport.Yes,
                ColorSystem = ColorSystemSupport.TrueColor,
                Out = new AnsiConsoleOutput(sw),
                Interactive = InteractionSupport.No,
            });
            target.Profile.Width = width;
        }
        else
        {
            target = console;
        }

        target.Write(new Markup(BuildHeader()));
        target.WriteLine();
        target.Write(new Rule { Style = new Style(Tokens.Tokens.BorderNeutral) });

        target.Write(activeModal is not null ? activeModal.Render(width, bodyHeight) : screen.Render(width, bodyHeight + 2));

        target.WriteLine();
        target.Write(new Rule { Style = new Style(Tokens.Tokens.BorderNeutral) });
        if (toast is not null)
        {
            target.Write(new Markup($"[{Tokens.Tokens.StatusWarning.Value.ToMarkup()}] ! {Markup.Escape(toast)}[/]"));
        }
        else
        {
            target.Write(BuildHintBar(screen).Render());
        }

        if (useBuffer && sw is not null)
        {
            var frame = AltScreen.InjectEraseBeforeNewlines(sw.ToString());
            Console.Out.Write($"{AltScreen.SyncStartSequence}\u001b[H{frame}\u001b[K\u001b[J{AltScreen.SyncEndSequence}");
            Console.Out.Flush();
        }
    }

    private string BuildHeader()
    {
        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();
        var v = string.IsNullOrEmpty(version) ? string.Empty : $"v{version}";
        var theme = Themes.Theme.Current.Name;
        return $"[{brand} bold]gsharp[/] [{tertiary}]| session[/]   [{tertiary}]{theme} · {Markup.Escape(v)}[/]";
    }

    private HintBar BuildHintBar(ITabScreen screen)
    {
        return new HintBar()
            .Add("/", "commands")
            .Add("Ctrl+Space", "complete")
            .Add("Ctrl+K", "hover")
            .Add("Ctrl+C", "quit");
    }

    public sealed class ConsoleKeyReader : IKeyReader
    {
        public ConsoleKeyInfo? ReadKey()
        {
            try
            {
                return Console.ReadKey(intercept: true);
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }
    }
}

public enum ShellAction
{
    Continue,
    Exit,
}
