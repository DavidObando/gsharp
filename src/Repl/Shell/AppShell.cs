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
/// overlay, and a flicker-free synchronized render loop.
/// </summary>
public sealed class AppShell : IAppShellNavigator
{
    private readonly IAnsiConsole console;
    private readonly IReadOnlyList<ITabScreen> tabs;

    // Captured once, up front: a cell evaluation can run on a background thread while the
    // busy spinner keeps this render loop going on the main thread, and SessionEngine
    // temporarily swaps the *global* Console.Out/Error to capture that cell's stdout. Writing
    // frames through the live Console.Out property would race with that swap and corrupt the
    // screen; writing through this captured reference to the real terminal writer never does.
    private readonly TextWriter realOut = Console.Out;

    private int activeTab;
    private IModal? activeModal;
    private string? toast;
    private bool exitRequested;

    public AppShell(IAnsiConsole console, IReadOnlyList<ITabScreen> tabs)
    {
        this.console = console ?? throw new ArgumentNullException(nameof(console));
        this.tabs = tabs is { Count: > 0 } ? tabs : throw new ArgumentException("At least one tab required.", nameof(tabs));
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

    private static readonly TimeSpan BusyPollInterval = TimeSpan.FromMilliseconds(80);

    public int Run(IInputReader inputReader)
    {
        ArgumentNullException.ThrowIfNull(inputReader);
        tabs[activeTab].OnActivated(this);
        Render();
        while (true)
        {
            InputEvent? input;
            if (tabs[activeTab].IsBusy)
            {
                // Poll instead of blocking indefinitely so the busy spinner keeps animating
                // while an evaluation runs, without spinning the CPU when idle.
                input = inputReader.Read(BusyPollInterval, out var timedOut);
                if (timedOut)
                {
                    try
                    {
                        Render();
                    }
                    catch (Exception ex)
                    {
                        toast = $"Render error: {ex.Message}";
                    }

                    continue;
                }
            }
            else
            {
                input = inputReader.Read();
            }

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
        toast = null;

        if (activeModal is not null)
        {
            activeModal.HandleKey(key);
            if (activeModal.IsComplete || key.Key == ConsoleKey.Escape)
            {
                DismissModal();
            }

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

        // Chrome is exactly two lines: a rule above the footer, and the footer itself.
        // The body fills the rest so the whole frame is exactly the terminal height (no
        // scrolling, so the body/sidebar/footer never scroll off).
        var bodyHeight = Math.Max(3, height - 2);
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

        // Header/rule/footer carry no background of their own, so paint them with the
        // theme's canvas color; otherwise they fall through to the terminal's own
        // background (usually black), clashing with the themed body underneath.
        var canvas = Tokens.Tokens.Canvas;
        IRenderable Chrome(IRenderable line) => new Backdrop(line, canvas, padLeft: 0, padRight: 0);

        // Render the body first: it pumps any pending evaluation to completion (see
        // ReplScreen.PumpPendingEvaluation), which can flip IsBusy/FooterOverride for this
        // very frame. Reading those *after* the body render (not before) is what lets the
        // footer catch up in the same frame the evaluation finishes, instead of one frame late.
        var body = screen.Render(width, bodyHeight);

        IRenderable footer;
        if (toast is not null)
        {
            footer = new Markup($"[{Tokens.Tokens.StatusWarning.Value.ToMarkup()}] ! {Markup.Escape(toast)}[/]");
        }
        else
        {
            var hintBar = screen.FooterOverride ?? BuildHintBar(screen).Render();
            var status = screen.Status;
            if (status is null)
            {
                footer = hintBar;
            }
            else
            {
                // Right-align the status against the plain (tag-stripped) length of its markup.
                var statusWidth = Math.Min(width - 4, Math.Max(1, StripMarkupTags(status).Length));
                var hintWidth = Math.Max(1, width - statusWidth - 2);
                footer = new SideBySide(hintBar, hintWidth, 2, new Markup(status), statusWidth, canvas);
            }
        }

        // A single frame renderable whose line breaks fall only BETWEEN rows, so the total
        // line count is deterministic: bodyHeight + 1 + 1 == height.
        IRenderable frame = new Rows(
            body,
            Chrome(new Markup(rule)),
            Chrome(footer));

        // The command palette floats as a centered modal over the frame; the surrounding
        // chrome stays visible behind it rather than being replaced.
        if (activeModal is not null)
        {
            var modalWidth = Math.Clamp(width - 8, 24, 72);
            frame = new Overlay(frame, activeModal.Render(modalWidth, bodyHeight), modalWidth);
        }

        // Clamp to exactly the terminal height and strip any trailing line break so the
        // whole frame fits without scrolling (which would push the header off-screen).
        target.Write(new FixedHeight(frame, height, new Style(background: canvas)));

        if (useBuffer && sw is not null)
        {
            var frameText = AltScreen.InjectEraseBeforeNewlines(sw.ToString());
            realOut.Write($"{AltScreen.SyncStartSequence}\u001b[H{frameText}\u001b[K\u001b[J{AltScreen.SyncEndSequence}");
            realOut.Flush();
        }
    }

    private static string StripMarkupTags(string markup)
        => System.Text.RegularExpressions.Regex.Replace(markup, "\\[[^\\]]*\\]", string.Empty);

    private HintBar BuildHintBar(ITabScreen screen)
    {
        return new HintBar()
            .Add("/", "commands")
            .Add("Ctrl+Space", "complete")
            .Add("Ctrl+K", "hover")
            .Add("/exit", "quit");
    }
}

public enum ShellAction
{
    Continue,
    Exit,
}
