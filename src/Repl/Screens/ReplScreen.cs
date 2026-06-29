// <copyright file="ReplScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.LanguageServer.Protocol;
using GSharp.Repl.Engine;
using GSharp.Repl.Shell;
using GSharp.Repl.Themes;
using GSharp.Repl.Widgets;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Screens;

/// <summary>OpenCode-style single conversation view: scrolling transcript plus a pinned input box.</summary>
public sealed class ReplScreen : ITabScreen
{
    private const int MaxPopup = 7;
    private readonly SessionEngine engine;
    private readonly MultilineEditor editor = new();
    private IAppShellNavigator? navigator;
    private List<CompletionItem> completions = new();
    private int completionIndex;
    private int completionTop;
    private string? hover;

    public ReplScreen(SessionEngine engine) => this.engine = engine;

    public string Title => "REPL";

    public char NumberKey => '1';

    public IEnumerable<KeyValuePair<string, string?>> Hints => new[]
    {
        new KeyValuePair<string, string?>("Enter", "run"),
        new KeyValuePair<string, string?>("Ctrl+Space", "complete"),
        new KeyValuePair<string, string?>("Ctrl+K", "hover"),
        new KeyValuePair<string, string?>("/", "cmds"),
    };

    public void OnActivated(IAppShellNavigator nav) => navigator = nav;

    public bool HandleKey(ConsoleKeyInfo key)
    {
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
                if (SessionEngine.IsComplete(editor.Text) && !editor.IsEmpty)
                {
                    engine.Evaluate(editor.Text);
                    editor.Clear();
                    hover = null;
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

    public IRenderable Render(int width, int height)
    {
        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var primary = Tokens.Tokens.TextPrimary.Value.ToMarkup();
        var secondary = Tokens.Tokens.TextSecondary.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();

        var inputLines = editor.Lines.Count;
        var transcriptHeight = Math.Max(3, height - inputLines - 4);
        var rows = new List<IRenderable>();

        if (engine.Cells.Count == 0)
        {
            rows.Add(new Markup($"[{tertiary}]Type a G# expression and press Enter. [{brand}]/[/] commands · [{brand}]Ctrl+Space[/] complete · [{brand}]Ctrl+K[/] hover.[/]"));
        }

        foreach (var cell in engine.Cells.TakeLast(transcriptHeight))
        {
            rows.Add(new Markup($"[{tertiary}]{cell.Index}[/] [{brand}]›[/] {Highlight.Markup(cell.Input.Replace("\n", " "))}"));
            foreach (var d in cell.Diagnostics)
            {
                var c = (d.IsError ? Tokens.Tokens.StatusError : Tokens.Tokens.StatusWarning).Value.ToMarkup();
                rows.Add(new Markup($"    [{c}]● {Markup.Escape(d.Id)} {Markup.Escape(d.Message)}[/]"));
            }

            if (!cell.HasError && cell.Value is not null)
            {
                rows.Add(new Markup($"    [{primary}]{Markup.Escape(cell.Value.ToString() ?? string.Empty)}[/]"));
            }
        }

        var body = new List<IRenderable> { new Padder(new Rows(rows)).Padding(1, 0, 1, 0) };

        if (completions.Count > 0)
        {
            body.Add(CompletionPanel());
        }

        if (hover is not null)
        {
            body.Add(new Panel(new Markup($"[{secondary}]{Markup.Escape(hover)}[/]"))
            {
                Header = new PanelHeader($"[{tertiary}] hover · Esc [/]"),
                Border = BoxBorder.Rounded,
                BorderStyle = new Style(Tokens.Tokens.BorderNeutral),
                Expand = true,
            });
        }

        body.Add(InputBox(brand, tertiary));
        var diag = engine.Cells.SelectMany(c => c.Diagnostics).Count(d => d.IsError);
        var status = diag == 0 ? $"[{Tokens.Tokens.StatusSuccess.Value.ToMarkup()}]●[/] gsharp [{tertiary}]· ready[/]"
            : $"[{Tokens.Tokens.StatusError.Value.ToMarkup()}]●[/] gsharp [{tertiary}]· {diag} error(s)[/]";
        body.Add(new Padder(new Markup(status)).Padding(1, 0, 0, 0));
        return new Rows(body);
    }

    private IRenderable InputBox(string brand, string tertiary)
    {
        var cursor = $"{Tokens.Tokens.TextPrimary.Value.ToMarkup()} invert";
        var lines = editor.RenderLines(cursor);
        var rendered = lines.Select((l, i) =>
            (IRenderable)new Markup($"[{(i == 0 ? brand : tertiary)}]{(i == 0 ? "›" : "·")}[/] {l}")).ToList();
        return new Panel(new Rows(rendered))
        {
            Border = BoxBorder.Rounded,
            BorderStyle = new Style(Tokens.Tokens.Brand),
            Padding = new Padding(1, 0, 1, 0),
            Expand = true,
        };
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

    private void Move(int delta)
    {
        completionIndex = Math.Clamp(completionIndex + delta, 0, completions.Count - 1);
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
                    Theme.Use(string.IsNullOrEmpty(arg) ? "Default" : arg);
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
        ("theme", "switch theme: Default|Mono|HighContrast"),
        ("load", "run a .gs file into session"),
    };
}
