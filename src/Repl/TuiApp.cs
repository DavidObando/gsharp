// <copyright file="TuiApp.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using GSharp.Interpreter;
using Spectre.Console;

namespace GSharp.Repl;

/// <summary>
/// OpenCode/Copilot-CLI style terminal UI for the GSharp interpreter: a single
/// scrolling transcript, a brand-bordered input box with a block cursor, a status
/// line, and a thin keybar. Eval, render, and dispatch are all guarded so the REPL
/// never crashes on user input.
/// </summary>
internal sealed class TuiApp
{
    private const string Version = "v1.0";

    private readonly GSharpRepl repl;
    private readonly AnalysisBridge analysis = new();
    private readonly MultilineEditor editor = new();
    private readonly List<TranscriptCell> transcript = new();
    private readonly string session = Guid.NewGuid().ToString("N").Substring(0, 6);

    private ReplTheme theme = ReplTheme.Default;
    private CompletionPopup popup;
    private string hover;
    private string status = "ready";
    private int errorCount;
    private bool running = true;

    /// <summary>
    /// Initializes a new instance of the <see cref="TuiApp"/> class.
    /// </summary>
    /// <param name="repl">The eval engine.</param>
    public TuiApp(GSharpRepl repl)
    {
        this.repl = repl;
    }

    private enum CellKind
    {
        User,
        Result,
        Error,
        Info,
    }

    /// <summary>Runs the interactive loop until the user exits.</summary>
    public void Run()
    {
        AddInfo("welcome to gsharp — type code and press Enter, '/' for commands, Ctrl+Space to complete, Ctrl+K to hover, Ctrl+D to quit");
        SafeRender();
        while (running)
        {
            ConsoleKeyInfo key;
            try
            {
                key = Console.ReadKey(intercept: true);
            }
            catch (InvalidOperationException)
            {
                // No interactive console (redirected input / smoke test): stop cleanly.
                break;
            }

            try
            {
                Dispatch(key);
            }
            catch (Exception ex)
            {
                AddError("repl: " + ex.Message);
            }

            SafeRender();
        }
    }

    private void Dispatch(ConsoleKeyInfo key)
    {
        if ((key.Modifiers & ConsoleModifiers.Control) != 0 &&
            (key.Key == ConsoleKey.D || key.Key == ConsoleKey.Q))
        {
            running = false;
            return;
        }

        if ((key.Modifiers & ConsoleModifiers.Control) != 0 && key.Key == ConsoleKey.Spacebar)
        {
            ShowCompletions();
            return;
        }

        if (((key.Modifiers & ConsoleModifiers.Control) != 0 && key.Key == ConsoleKey.K) || key.Key == ConsoleKey.F1)
        {
            ShowHover();
            return;
        }

        if (popup != null)
        {
            if (DispatchPopup(key))
            {
                return;
            }
        }

        switch (key.Key)
        {
            case ConsoleKey.Escape:
                hover = null;
                editor.Clear();
                break;
            case ConsoleKey.Enter when (key.Modifiers & (ConsoleModifiers.Control | ConsoleModifiers.Shift)) != 0:
                editor.NewLine();
                break;
            case ConsoleKey.Enter:
                Submit();
                break;
            case ConsoleKey.Backspace:
                editor.Backspace();
                break;
            case ConsoleKey.Delete:
                editor.Delete();
                break;
            case ConsoleKey.LeftArrow:
                editor.MoveLeft();
                break;
            case ConsoleKey.RightArrow:
                editor.MoveRight();
                break;
            case ConsoleKey.UpArrow:
                editor.MoveUp();
                break;
            case ConsoleKey.DownArrow:
                editor.MoveDown();
                break;
            case ConsoleKey.Home:
                editor.MoveHome();
                break;
            case ConsoleKey.End:
                editor.MoveEnd();
                break;
            case ConsoleKey.Tab:
                editor.InsertText("    ");
                break;
            default:
                if (!char.IsControl(key.KeyChar))
                {
                    editor.Insert(key.KeyChar);
                    hover = null;
                }

                break;
        }
    }

    private bool DispatchPopup(ConsoleKeyInfo key)
    {
        switch (key.Key)
        {
            case ConsoleKey.DownArrow:
                popup.Next();
                return true;
            case ConsoleKey.UpArrow:
                popup.Previous();
                return true;
            case ConsoleKey.Escape:
                popup = null;
                return true;
            case ConsoleKey.Enter:
            case ConsoleKey.Tab:
                AcceptCompletion();
                return true;
            default:
                return false;
        }
    }

    private void AcceptCompletion()
    {
        var entry = popup?.Current;
        popup = null;
        if (entry == null)
        {
            return;
        }

        // Replace the partial identifier under the caret with the chosen label.
        var line = editor.Text.Split('\n')[editor.CursorLine];
        var col = editor.CursorColumn;
        var startBack = 0;
        while (col - startBack - 1 >= 0 && (char.IsLetterOrDigit(line[col - startBack - 1]) || line[col - startBack - 1] == '_'))
        {
            startBack++;
        }

        for (var i = 0; i < startBack; i++)
        {
            editor.Backspace();
        }

        editor.InsertText(entry.Label);
    }

    private void ShowCompletions()
    {
        var items = analysis.GetCompletions(editor.Text, editor.CursorLine, editor.CursorColumn);
        popup = new CompletionPopup(items);
        if (items.Count == 0)
        {
            status = "no completions";
        }
    }

    private void ShowHover()
    {
        hover = analysis.GetHover(editor.Text, editor.CursorLine, editor.CursorColumn)
            ?? "no symbol information";
    }

    private void Submit()
    {
        var text = editor.Text;
        if (string.IsNullOrWhiteSpace(text))
        {
            editor.Clear();
            return;
        }

        var trimmed = text.Trim();
        if (trimmed.StartsWith('/') || trimmed.StartsWith(':'))
        {
            RunCommand(trimmed.Substring(1));
            editor.Clear();
            return;
        }

        AddUser(text);
        repl.RememberSubmission(text);
        var result = repl.EvaluateForRepl(text);
        foreach (var d in result.Diagnostics)
        {
            var prefix = d.IsError ? "error" : "warn";
            AddCell(d.IsError ? CellKind.Error : CellKind.Info, $"{prefix} {d.Id}: {d.Message}");
        }

        if (result.Success)
        {
            if (result.Value != null)
            {
                AddCell(CellKind.Result, FormatValue(result.Value));
            }

            status = "ready";
            errorCount = 0;
        }
        else
        {
            errorCount = result.Diagnostics.Count(d => d.IsError);
            status = "error";
        }

        editor.Clear();
    }

    private void RunCommand(string command)
    {
        var parts = command.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var name = parts.Length > 0 ? parts[0].ToLowerInvariant() : string.Empty;
        var argument = parts.Length > 1 ? parts[1] : string.Empty;
        switch (name)
        {
            case "reset":
                repl.Reset();
                transcript.Clear();
                errorCount = 0;
                AddInfo("session reset");
                break;
            case "clear":
                transcript.Clear();
                break;
            case "theme":
                theme = ReplTheme.Next(theme.Name);
                AddInfo("theme → " + theme.Name);
                break;
            case "load":
                LoadFile(argument);
                break;
            case "quit":
            case "exit":
                running = false;
                break;
            default:
                AddError("unknown command: " + name + " (reset · clear · theme · load · quit)");
                break;
        }
    }

    private void LoadFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            AddError("load: file not found: " + path);
            return;
        }

        var text = File.ReadAllText(path);
        AddUser(text);
        var result = repl.EvaluateForRepl(text);
        if (result.Success && result.Value != null)
        {
            AddCell(CellKind.Result, FormatValue(result.Value));
        }
        else if (!result.Success)
        {
            errorCount = result.Diagnostics.Count(d => d.IsError);
            foreach (var d in result.Diagnostics.Where(d => d.IsError))
            {
                AddError(d.Id + ": " + d.Message);
            }
        }
    }

    private static string FormatValue(object value) => Markup.Escape(value?.ToString() ?? "null");

    private void AddUser(string text) => AddCell(CellKind.User, Markup.Escape(text));

    private void AddInfo(string text) => AddCell(CellKind.Info, Markup.Escape(text));

    private void AddError(string text) => AddCell(CellKind.Error, Markup.Escape(text));

    private void AddCell(CellKind kind, string markup) => transcript.Add(new TranscriptCell(kind, markup));

    private void SafeRender()
    {
        try
        {
            Render();
        }
        catch (Exception)
        {
            // Rendering must never crash the loop.
        }
    }

    private void Render()
    {
        AnsiConsole.Clear();
        AnsiConsole.MarkupLine($"[{theme.Brand}]gsharp[/] [{theme.Muted}]|[/] [{theme.Accent}]{session}[/] [{theme.Muted}]·[/] {theme.Name} [{theme.Muted}]·[/] {Version}");
        AnsiConsole.Write(new Rule().RuleStyle(theme.Muted));

        foreach (var cell in transcript.TakeLast(Math.Max(4, Console.WindowHeight - 12)))
        {
            AnsiConsole.MarkupLine(cell.Render(theme));
        }

        var lines = editor.RenderLines();
        var body = string.Join("\n", lines.Select((l, i) => i == 0 ? $"[{theme.Brand}]›[/] {l}" : "  " + l));
        var input = new Panel(body)
        {
            Border = BoxBorder.Rounded,
            BorderStyle = new Style(foreground: NamedColor(theme.Brand)),
            Expand = true,
        };
        AnsiConsole.Write(input);

        if (popup != null)
        {
            AnsiConsole.MarkupLine($"[{theme.Muted}]completions:[/]");
            foreach (var l in popup.RenderLines(theme.Accent))
            {
                AnsiConsole.MarkupLine(l);
            }
        }

        if (hover != null)
        {
            AnsiConsole.Write(new Panel(Markup.Escape(hover)) { Header = new PanelHeader(" hover "), Border = BoxBorder.Square });
        }

        var dot = errorCount > 0 ? "[red]●[/]" : $"[{theme.Accent}]●[/]";
        var stat = errorCount > 0 ? $"{errorCount} error(s)" : status;
        AnsiConsole.MarkupLine($"{dot} [{theme.Brand}]gsharp[/] [{theme.Muted}]·[/] {stat}");
        AnsiConsole.MarkupLine($"[{theme.Muted}]Enter run · Ctrl+Enter newline · Ctrl+Space complete · Ctrl+K hover · / commands · Ctrl+D quit[/]");
    }

    private static Color NamedColor(string name) => name switch
    {
        "mediumpurple2" => Color.MediumPurple2,
        "deepskyblue1" => Color.DeepSkyBlue1,
        "blue" => Color.Blue,
        "orange1" => Color.Orange1,
        _ => Color.MediumPurple2,
    };

    private sealed record TranscriptCell(CellKind Kind, string Markup)
    {
        public string Render(ReplTheme theme) => Kind switch
        {
            CellKind.User => $"[{theme.Accent}]»[/] {Markup}",
            CellKind.Result => $"[white]{Markup}[/]",
            CellKind.Error => $"[red]✗ {Markup}[/]",
            _ => $"[{theme.Muted}]{Markup}[/]",
        };
    }
}
