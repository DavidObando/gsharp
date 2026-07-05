// <copyright file="ReplScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.Repl.Engine;
using GSharp.Repl.Shell;
using GSharp.Repl.Themes;
using GSharp.Repl.Widgets;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Screens;

/// <summary>OpenCode-style single conversation view: scrolling transcript plus a pinned input box.</summary>
public sealed class ReplScreen : ITabScreen, IDisposable
{
    private const int MaxPopup = 7;

    private readonly SessionEngine engine;
    private readonly MultilineEditor editor = new();
    private readonly ScrollState scroll = new();
    private IAppShellNavigator? navigator;
    private List<CompletionItem> completions = new();
    private int completionIndex;
    private int completionTop;
    private string? hover;
    private CancellationTokenSource? evalCts;
    private Task<Cell>? pendingEval;
    private int evalFrame;
    private bool cancelRequested;

    public ReplScreen(SessionEngine engine)
    {
        this.engine = engine;
        engine.CaptureConsole = true;
        engine.InputProvider = InlinePrompt.ReadLine;
    }

    public string Title => "REPL";

    public char NumberKey => '1';

    public bool IsBusy => pendingEval is not null;

    public IEnumerable<KeyValuePair<string, string?>> Hints => new[]
    {
        new KeyValuePair<string, string?>("Enter", "run"),
        new KeyValuePair<string, string?>("Ctrl+Space", "complete"),
        new KeyValuePair<string, string?>("Ctrl+K", "hover"),
        new KeyValuePair<string, string?>("/", "cmds"),
    };

    public IRenderable? FooterOverride
    {
        get
        {
            if (pendingEval is null)
            {
                return null;
            }

            var brand = Tokens.Tokens.Brand.Value;
            var brandMarkup = brand.ToMarkup();
            var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();

            // Themed on every read (not cached) so a theme switch mid-evaluation is picked up;
            // the spinner itself is cheap (a handful of Color structs) to rebuild per frame.
            var spinner = new KnightRiderAnimation(
                width: 6,
                style: KnightRiderStyle.Blocks,
                holdStart: 6,
                holdEnd: 3,
                colors: KnightRiderAnimation.DeriveTrailColors(brand),
                defaultColor: KnightRiderAnimation.DeriveInactiveColor(brand, factor: 0.6),
                minAlpha: 0.3);

            var glyphs = spinner.RenderMarkup(evalFrame, Tokens.Tokens.Canvas);

            // Cancellation can't interrupt a running evaluation (no cooperative cancellation in
            // the interpreter, see SessionEngine.EvaluateAsync), so give immediate feedback that
            // Esc registered instead of leaving the hint unchanged until the eval happens to finish.
            var hint = cancelRequested
                ? $"[{tertiary}]cancelling…[/]"
                : $"[{brandMarkup}]Esc[/] [{tertiary}]interrupt[/]";
            return new Markup($"{glyphs}  {hint}");
        }
    }

    public string Status
    {
        get
        {
            var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();
            var diag = engine.Cells.SelectMany(c => c.Diagnostics).Count(d => d.IsError);
            return diag == 0
                ? $"[{Tokens.Tokens.StatusSuccess.Value.ToMarkup()}]●[/] gsharp [{tertiary}]· ready[/]"
                : $"[{Tokens.Tokens.StatusError.Value.ToMarkup()}]●[/] gsharp [{tertiary}]· {diag} error(s)[/]";
        }
    }

    public void OnActivated(IAppShellNavigator nav) => navigator = nav;

    public void Dispose() => evalCts?.Dispose();

    public bool HandleScroll(ScrollDirection direction, int lines)
    {
        if (direction == ScrollDirection.Up)
        {
            scroll.ScrollUp(lines);
        }
        else
        {
            scroll.ScrollDown(lines);
        }

        return true;
    }

    public bool HandleKey(ConsoleKeyInfo key)
    {
        if (pendingEval is not null && key.Key == ConsoleKey.Escape)
        {
            if (!cancelRequested)
            {
                cancelRequested = true;
                evalCts?.Cancel();
            }

            return true;
        }

        if (completions.Count > 0)
        {
            switch (key.Key)
            {
                case ConsoleKey.UpArrow: Move(-1); return true;
                case ConsoleKey.DownArrow: Move(1); return true;
                case ConsoleKey.Tab:
                case ConsoleKey.Enter: AcceptCompletion(); return true;
                case ConsoleKey.Escape: completions = new(); return true;
            }
        }

        if (hover is not null && key.Key == ConsoleKey.Escape)
        {
            hover = null;
            return true;
        }

        // Scroll the transcript viewport without disturbing the editor cursor or the pinned
        // input box. Page-sized on PageUp/PageDown, line-sized on Ctrl+Up/Ctrl+Down.
        var ctrl = (key.Modifiers & ConsoleModifiers.Control) != 0;
        switch (key.Key)
        {
            case ConsoleKey.PageUp: scroll.ScrollUp(Math.Max(1, scroll.LastViewportHeight - 1)); return true;
            case ConsoleKey.PageDown: scroll.ScrollDown(Math.Max(1, scroll.LastViewportHeight - 1)); return true;
            case ConsoleKey.UpArrow when ctrl: scroll.ScrollUp(1); return true;
            case ConsoleKey.DownArrow when ctrl: scroll.ScrollDown(1); return true;
        }

        if (key.Key == ConsoleKey.Spacebar && (key.Modifiers & ConsoleModifiers.Control) != 0)
        {
            ShowCompletions();
            return true;
        }

        // Ctrl+K, or F1, toggles hover; F1 works where the terminal eats Ctrl+K.
        if (key.Key == ConsoleKey.F1 || (key.Key == ConsoleKey.K && (key.Modifiers & ConsoleModifiers.Control) != 0))
        {
            hover = AnalysisBridge.Hover(editor.Text, editor.Line, editor.Col) ?? "No symbol information.";
            return true;
        }

        if ((key.KeyChar == '/' || key.KeyChar == ':') && editor.IsEmpty)
        {
            navigator?.ShowModal(new CommandPalette(Palette.Verbs, RunCommand));
            return true;
        }

        switch (key.Key)
        {
            case ConsoleKey.Enter when (key.Modifiers & ConsoleModifiers.Shift) != 0:
                editor.NewLine();
                return true;
            case ConsoleKey.Enter:
                if (pendingEval is not null)
                {
                    return true;
                }

                if (SessionEngine.IsComplete(editor.Text) && !editor.IsEmpty)
                {
                    evalCts = new CancellationTokenSource();
                    pendingEval = engine.EvaluateAsync(editor.Text, evalCts.Token);
                    editor.Clear();
                    hover = null;
                    scroll.ToBottom();
                }
                else if (!editor.IsEmpty)
                {
                    editor.NewLine();
                }

                return true;
            case ConsoleKey.Backspace: editor.Backspace(); completions = new(); return true;
            case ConsoleKey.LeftArrow: editor.Left(); return true;
            case ConsoleKey.RightArrow: editor.Right(); return true;
            case ConsoleKey.UpArrow: editor.Up(); return true;
            case ConsoleKey.DownArrow: editor.Down(); return true;
            default:
                if (key.KeyChar >= ' ' && !char.IsControl(key.KeyChar))
                {
                    editor.Insert(key.KeyChar);
                    if (completions.Count > 0)
                    {
                        ShowCompletions();
                    }

                    return true;
                }

                return false;
        }
    }

    private void PumpPendingEvaluation()
    {
        if (pendingEval is null)
        {
            return;
        }

        if (!pendingEval.IsCompleted)
        {
            evalFrame++;
            return;
        }

        if (pendingEval.IsFaulted)
        {
            // Observe the exception so it isn't reported as unobserved later; EvaluateCore
            // already funnels evaluation errors into the Cell's diagnostics, so a faulted
            // task here only happens for cancellation/engine bugs, not G# runtime errors.
            _ = pendingEval.Exception;
        }

        // The interpreter can't be interrupted mid-run (see SessionEngine.EvaluateAsync), so a
        // cancelled submission finishes normally and is just discarded with no result cell. Tell
        // the user it actually happened instead of leaving them wondering why nothing appeared.
        // (If Esc lost the race and the eval committed anyway, IsCompletedSuccessfully is true
        // and no toast is shown — there's a real result on screen instead.)
        if (cancelRequested && !pendingEval.IsCompletedSuccessfully)
        {
            navigator?.ShowToast("Evaluation cancelled.");
        }

        pendingEval = null;
        evalCts?.Dispose();
        evalCts = null;
        evalFrame = 0;
        cancelRequested = false;
    }

    public IRenderable Render(int width, int height)
    {
        PumpPendingEvaluation();

        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var primary = Tokens.Tokens.TextPrimary.Value.ToMarkup();
        var secondary = Tokens.Tokens.TextSecondary.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();

        // Reserve a right-hand column for the state sidebar on wide enough terminals.
        var sidebarWidth = width >= 76 ? Math.Clamp(width / 4, 26, 42) : 0;
        var leftWidth = sidebarWidth > 0 ? width - sidebarWidth - 2 : width - 1;

        var cellBg = Tokens.Tokens.CellBackground.Value;
        var transcript = new List<IRenderable>();

        // The full history is handed to the Dock, which windows it into the scrollable
        // region; older cells scroll off the top rather than being dropped up front.
        for (var ci = 0; ci < engine.Cells.Count; ci++)
        {
            var cell = engine.Cells[ci];
            var cellRows = new List<IRenderable>
            {
                new Markup($"[{tertiary}]{cell.Index}[/] [{brand}]›[/] {Highlight.Markup(cell.Input.Replace("\n", " "))}"),
            };

            foreach (var d in cell.Diagnostics)
            {
                var c = (d.IsError ? Tokens.Tokens.StatusError : Tokens.Tokens.StatusWarning).Value.ToMarkup();
                cellRows.Add(new Markup($"    [{c}]● {Markup.Escape(d.Id)} {Markup.Escape(d.Message)}[/]"));
            }

            foreach (var line in SplitOutput(cell.Output))
            {
                cellRows.Add(new Markup($"    [{secondary}]{Markup.Escape(line)}[/]"));
            }

            foreach (var line in SplitOutput(cell.StandardError))
            {
                var c = Tokens.Tokens.StatusError.Value.ToMarkup();
                cellRows.Add(new Markup($"    [{c}]{Markup.Escape(line)}[/]"));
            }

            if (!cell.HasError && cell.Value is not null)
            {
                cellRows.Add(new Markup($"    [{primary}]{Markup.Escape(cell.Value.ToString() ?? string.Empty)}[/]"));
            }

            transcript.Add(new Backdrop(new Rows(cellRows), cellBg));
            if (ci < engine.Cells.Count - 1)
            {
                transcript.Add(new Text(string.Empty));
            }
        }

        var canvasColor = Tokens.Tokens.Canvas;
        var scrollable = new Backdrop(new Rows(transcript), canvasColor, padLeft: 1, padRight: 1);

        // Everything below the scrollable transcript stays pinned to the bottom, just above
        // the footer chrome, and grows upward as the input box gains lines. The Dock measures
        // this footer at render time and shrinks the transcript viewport to match.
        var footerRows = new List<IRenderable>();
        if (completions.Count > 0)
        {
            footerRows.Add(CompletionPanel());
        }

        if (hover is not null)
        {
            footerRows.Add(new Panel(new Markup($"[{secondary}]{Markup.Escape(hover)}[/]"))
            {
                Header = new PanelHeader($"[{tertiary}] hover · Esc [/]"),
                Border = BoxBorder.Rounded,
                BorderStyle = new Style(Tokens.Tokens.BorderNeutral),
                Expand = true,
            });
        }

        footerRows.Add(new Backdrop(InputBox(brand, tertiary), canvasColor, padLeft: 1, padRight: 1));

        // Any blank fill (an empty transcript, the row under the input box, the sidebar
        // gap) is painted with the theme's canvas color instead of being left unstyled,
        // which would otherwise show through as the terminal's own (often black) background.
        var canvas = new Style(background: canvasColor);
        var main = (IRenderable)new Dock(scrollable, new Rows(footerRows), height, scroll, canvas);
        if (sidebarWidth == 0)
        {
            return main;
        }

        return new SideBySide(main, leftWidth, 2, new FixedHeight(StateSidebar(height), height, canvas), sidebarWidth, canvas);
    }

    private IRenderable InputBox(string brand, string tertiary)
    {
        var cursor = $"{Tokens.Tokens.TextPrimary.Value.ToMarkup()} invert";
        List<IRenderable> rendered;
        if (editor.IsEmpty)
        {
            rendered = new List<IRenderable>
            {
                new Markup($"[{brand}]›[/] [{cursor}] [/] [{tertiary}]Type a G# expression — Enter to run · Shift+Enter for newline[/]"),
            };
        }
        else
        {
            var lines = editor.RenderLines(cursor);
            rendered = lines.Select((l, i) =>
                (IRenderable)new Markup($"[{(i == 0 ? brand : tertiary)}]{(i == 0 ? "›" : "·")}[/] {l}")).ToList();
        }

        // OpenCode/Copilot-CLI style: a filled input surface with a themed accent bar
        // down the left edge (the colour previously used for the wrap-around border).
        return new Backdrop(
            new Rows(rendered),
            Tokens.Tokens.InputBackground.Value,
            accent: Tokens.Tokens.Brand.Value,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1);
    }

    private IRenderable StateSidebar(int minHeight)
    {
        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var primary = Tokens.Tokens.TextPrimary.Value.ToMarkup();
        var secondary = Tokens.Tokens.TextSecondary.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();
        var state = engine.Snapshot();

        var rows = new List<IRenderable>
        {
            new Markup($"[{brand}]STATE[/]"),
            new Markup($"[{tertiary}]cells[/] [{primary}]{engine.Cells.Count}[/]"),
        };

        AddSection(rows, "imports", state.Imports, brand, secondary, tertiary);
        AddSection(rows, "functions", state.Functions, brand, primary, tertiary);
        AddSection(rows, "variables", state.Variables, brand, primary, tertiary);
        AddSection(rows, "types", state.Types, brand, primary, tertiary);

        if (state.IsEmpty)
        {
            rows.Add(new Text(string.Empty));
            rows.Add(new Markup($"[{tertiary}]No symbols defined yet.[/]"));
        }

        // Pin a footer line (version + theme) to the very bottom of the sidebar by
        // padding with blank rows up to the fixed height, then appending it last.
        var footer = new Markup($"[{tertiary}]gsharp[/] [{primary}]{Markup.Escape(ReplHost.GetVersion())}[/] [{tertiary}]| theme[/] [{primary}]{Markup.Escape(Theme.Current.Name)}[/]");
        var filler = minHeight - 2 - rows.Count - 1;
        for (var i = 0; i < filler; i++)
        {
            rows.Add(new Text(string.Empty));
        }

        rows.Add(footer);

        // Same treatment as the input box: a filled surface with a themed left accent
        // bar, rather than an enclosed box.
        return new Backdrop(
            new Rows(rows),
            Tokens.Tokens.InputBackground.Value,
            accent: Tokens.Tokens.Brand.Value,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1,
            minHeight: minHeight);
    }

    private static void AddSection(List<IRenderable> rows, string title, IReadOnlyList<ReplSymbol> items, string headColor, string nameColor, string detailColor)
    {
        if (items.Count == 0)
        {
            return;
        }

        rows.Add(new Text(string.Empty));
        rows.Add(new Markup($"[{headColor}]{title.ToUpperInvariant()}[/] [{detailColor}]{items.Count}[/]"));
        foreach (var item in items.Take(12))
        {
            rows.Add(new Markup($"[{nameColor}]{Markup.Escape(item.Display)}[/]"));
        }

        if (items.Count > 12)
        {
            rows.Add(new Markup($"[{detailColor}]… +{items.Count - 12} more[/]"));
        }
    }

    private IRenderable CompletionPanel()
    {
        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var primary = Tokens.Tokens.TextPrimary.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();
        var popup = new List<IRenderable>();
        for (var i = completionTop; i < Math.Min(completions.Count, completionTop + MaxPopup); i++)
        {
            var item = completions[i];
            var caret = i == completionIndex ? $"[{brand}]❯[/] " : "  ";
            var detail = string.IsNullOrEmpty(item.Detail) ? string.Empty : $"  [{tertiary}]{Markup.Escape(item.Detail)}[/]";
            popup.Add(new Markup($"{caret}[{primary}]{Markup.Escape(item.Label)}[/]{detail}"));
        }

        var header = $"[{tertiary}] completions {completionIndex + 1}/{completions.Count} [/]";
        return new Panel(new Rows(popup))
        {
            Header = new PanelHeader(header),
            Border = BoxBorder.Rounded,
            BorderStyle = new Style(Tokens.Tokens.BorderNeutral),
            Expand = true,
        };
    }

    private static IEnumerable<string> SplitOutput(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            yield break;
        }

        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n');
        if (normalized.Length == 0)
        {
            yield break;
        }

        foreach (var line in normalized.Split('\n'))
        {
            yield return line;
        }
    }

    private void Move(int delta)
    {
        var n = completions.Count;
        completionIndex = (((completionIndex + delta) % n) + n) % n;
        if (completionIndex < completionTop)
        {
            completionTop = completionIndex;
        }
        else if (completionIndex >= completionTop + MaxPopup)
        {
            completionTop = completionIndex - MaxPopup + 1;
        }
    }

    private void ShowCompletions()
    {
        completions = AnalysisBridge.Completions(editor.Text, editor.Line, editor.Col)
            .OrderBy(c => c.SortText ?? c.Label, StringComparer.Ordinal).ToList();
        completionIndex = 0;
        completionTop = 0;
    }

    private void AcceptCompletion()
    {
        if (completionIndex >= 0 && completionIndex < completions.Count)
        {
            var insert = completions[completionIndex].InsertText ?? completions[completionIndex].Label;
            foreach (var ch in insert)
            {
                editor.Insert(ch);
            }
        }

        completions = new();
    }

    private void RunCommand(string cmd)
    {
        var parts = cmd.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        var verb = parts.Length > 0 ? parts[0] : string.Empty;
        var arg = parts.Length > 1 ? parts[1].Trim() : string.Empty;
        switch (verb)
        {
            case "reset":
                engine.Reset();
                editor.Clear();
                navigator?.ShowToast("Session reset.");
                break;
            case "clear":
                editor.Clear();
                break;
            case "theme":
                try
                {
                    if (string.IsNullOrEmpty(arg))
                    {
                        Theme.Cycle();
                    }
                    else
                    {
                        Theme.Use(arg);
                    }

                    navigator?.ShowToast($"Theme: {Theme.Current.Name}");
                }
                catch (ArgumentException ex)
                {
                    navigator?.ShowToast(ex.Message);
                }

                break;
            case "load":
                if (File.Exists(arg))
                {
                    engine.Evaluate(File.ReadAllText(arg));
                    navigator?.ShowToast($"Loaded {arg}");
                }
                else
                {
                    navigator?.ShowToast($"File not found: {arg}");
                }

                break;
            case "exit":
            case "quit":
                navigator?.RequestExit();
                break;
            default:
                navigator?.ShowToast($"Unknown command: {verb}");
                break;
        }
    }
}

internal static class Palette
{
    public static readonly (string, string)[] Verbs =
    {
        ("reset", "clear session state"),
        ("clear", "clear the editor"),
        ("theme", $"switch theme: {string.Join("|", Theme.AvailableNames())}"),
        ("load", "run a .gs file into session"),
        ("exit", "quit the REPL"),
    };
}
