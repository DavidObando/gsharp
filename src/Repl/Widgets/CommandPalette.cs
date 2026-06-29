// <copyright file="CommandPalette.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Repl.Shell;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>The vim-style <c>:</c> command palette. Fuzzy-filters verbs; Enter runs.</summary>
public sealed class CommandPalette : IModal
{
    private readonly IReadOnlyList<(string Verb, string Help)> verbs;
    private readonly Action<string> run;
    private string query = string.Empty;
    private int cursor;

    public CommandPalette(IReadOnlyList<(string Verb, string Help)> verbs, Action<string> run)
    {
        this.verbs = verbs;
        this.run = run;
    }

    public bool IsComplete { get; private set; }

    private List<(string Verb, string Help)> Filtered =>
        verbs.Where(v => v.Verb.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();

    public void HandleKey(ConsoleKeyInfo key)
    {
        var matches = Filtered;
        switch (key.Key)
        {
            case ConsoleKey.Enter:
                var chosen = matches.Count > 0 ? matches[Math.Clamp(cursor, 0, matches.Count - 1)].Verb : query;
                if (!string.IsNullOrWhiteSpace(chosen))
                {
                    run(chosen.Trim());
                }

                IsComplete = true;
                return;
            case ConsoleKey.UpArrow:
                cursor = Math.Max(0, cursor - 1);
                return;
            case ConsoleKey.DownArrow:
                cursor = Math.Min(Math.Max(0, matches.Count - 1), cursor + 1);
                return;
            case ConsoleKey.Tab:
                if (matches.Count > 0)
                {
                    query = matches[0].Verb;
                }

                return;
            case ConsoleKey.Backspace:
                if (query.Length > 0)
                {
                    query = query[..^1];
                }

                cursor = 0;
                return;
            default:
                if (key.KeyChar >= ' ' && !char.IsControl(key.KeyChar))
                {
                    query += key.KeyChar;
                    cursor = 0;
                }

                return;
        }
    }

    public IRenderable Render(int width, int height)
    {
        var brand = Tokens.Tokens.Brand.Value.ToMarkup();
        var primary = Tokens.Tokens.TextPrimary.Value.ToMarkup();
        var tertiary = Tokens.Tokens.TextTertiary.Value.ToMarkup();
        var rows = new List<IRenderable> { new Markup($"[{brand}]:[/] [{primary}]{Markup.Escape(query)}[/]"), new Markup(string.Empty) };
        var matches = Filtered;
        for (var i = 0; i < matches.Count; i++)
        {
            var prefix = i == cursor ? $"[{brand}]❯[/] " : "  ";
            rows.Add(new Markup($"{prefix}[{primary}]{Markup.Escape(matches[i].Verb)}[/]  [{tertiary}]{Markup.Escape(matches[i].Help)}[/]"));
        }

        rows.Add(new Markup(string.Empty));
        rows.Add(new Markup($"[{tertiary}]↑↓ navigate · Tab complete · Enter run · Esc cancel[/]"));
        return new Padder(new Panel(new Rows(rows)) { Border = BoxBorder.Rounded, BorderStyle = new Style(Tokens.Tokens.BorderNeutral) }).Padding(2, 1, 2, 1);
    }
}
