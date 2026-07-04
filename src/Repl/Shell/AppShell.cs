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
    private readonly IAnsiConsole console;
    private readonly IReadOnlyList<ITabScreen> tabs;
    private readonly CtrlCState ctrlC = new();
    private readonly string version;

    private int activeTab;
    private IModal? activeModal;
    private string? toast;
    private bool exitRequested;

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

    public void RequestExit() => exitRequested = true;

    public int Run(IInputReader inputReader)
    {
        ArgumentNullException.ThrowIfNull(inputReader);
        tabs[activeTab].OnActivated(this);
        Render();
        while (true)
        {
            var input = inputReader.Read();
            if (input is null)
            {
                return 0;
            }

            var action = ShellAction.Continue;
            try
            {
                if (input.Value.Key is { } key)
                {
                    action = Dispatch(key);
                }
                else if (input.Value.Scroll is { } scroll)
                {
                    DispatchScroll(scroll);
                }
            }
            catch (Exception ex)
            {
                toast = $"Internal error: {ex.Message}";
            }

            if (action == ShellAction.Exit || exitRequested)
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

    /// <summary>Routes a mouse-wheel scroll to the active tab (three lines per notch).</summary>
    public void DispatchScroll(ScrollDirection direction)
    {
        if (activeModal is not null)
        {
            return;
        }

        tabs[activeTab].HandleScroll(direction, 3);
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

        // Chrome is exactly four lines: header, a rule, a rule, and the footer. The body
        // fills the rest so the whole frame is exactly the terminal height (no scrolling,
        // so the header/sidebar/footer never scroll off).
        var bodyHeight = Math.Max(3, height - 4);
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

        var ruleColor = Tokens.Tokens.BorderNeutral.Value.ToMarkup();
        var rule = $"[{ruleColor}]{new string('─', Math.Max(1, width))}[/]";
        IRenderable footer = toast is not null
            ? new Markup($"[{Tokens.Tokens.StatusWarning.Value.ToMarkup()}] ! {Markup.Escape(toast)}[/]")
            : BuildHintBar(screen).Render();

        // A single frame renderable whose line breaks fall only BETWEEN rows, so the total
        // line count is deterministic: 1 + 1 + bodyHeight + 1 + 1 == height.
        IRenderable frame = new Rows(
            new Markup(BuildHeader()),
            new Markup(rule),
            screen.Render(width, bodyHeight),
            new Markup(rule),
            footer);

        // The command palette floats as a centered modal over the frame; the surrounding
        // chrome stays visible behind it rather than being replaced.
        if (activeModal is not null)
        {
            var modalWidth = Math.Clamp(width - 8, 24, 72);
            frame = new Overlay(frame, activeModal.Render(modalWidth, bodyHeight), modalWidth);
        }

        // Clamp to exactly the terminal height and strip any trailing line break so the
        // whole frame fits without scrolling (which would push the header off-screen).
        target.Write(new FixedHeight(frame, height));

        if (useBuffer && sw is not null)
        {
            var frameText = AltScreen.InjectEraseBeforeNewlines(sw.ToString());
            Console.Out.Write($"{AltScreen.SyncStartSequence}\u001b[H{frameText}\u001b[K\u001b[J{AltScreen.SyncEndSequence}");
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
}

public enum ShellAction
{
    Continue,
    Exit,
}
