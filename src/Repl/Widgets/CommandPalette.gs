// <copyright file="CommandPalette.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import GSharp.Repl.Shell
import GSharp.Repl.Tokens
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Linq

/// The vim-style `:` command palette. Fuzzy-filters verbs; Enter runs.
class CommandPalette : IModal {
    private let verbs IReadOnlyList[(Verb string, Help string)]
    private let run(string) -> void
    private var query string = string.Empty
    private var cursor int32

    init(verbs IReadOnlyList[(Verb string, Help string)], run(string) -> void) {
        this.verbs = verbs
        this.run = run
    }

    prop IsComplete bool {
        get;
        private set;
    }

    private prop Filtered List[(Verb string, Help string)] -> verbs.Where(
        (v(Verb string, Help string)) -> v.Verb.Contains(query, StringComparison.OrdinalIgnoreCase)
    )
        .ToList()

    func HandleKey(key ConsoleKeyInfo) {
        let matches = Filtered
        switch key.Key {
            case ConsoleKey.Enter {
                let chosen = if matches.Count > 0 {
                    matches[Math.Clamp(cursor, 0, matches.Count - 1)].Verb
                } else {
                    query
                }
                if !string.IsNullOrWhiteSpace(chosen) {
                    run(chosen.Trim())
                }
                IsComplete = true
                return
            }
            case ConsoleKey.UpArrow {
                cursor = Math.Max(0, cursor - 1)
                return
            }
            case ConsoleKey.DownArrow {
                cursor = Math.Min(Math.Max(0, matches.Count - 1), cursor + 1)
                return
            }
            case ConsoleKey.Tab {
                if matches.Count > 0 {
                    query = matches[0].Verb
                }
                return
            }
            case ConsoleKey.Backspace {
                if query.Length > 0 {
                    query = query[.. ^1]
                }
                cursor = 0
                return
            }
            default {
                if key.KeyChar >= ' ' && !char.IsControl(key.KeyChar) {
                    query += key.KeyChar.ToString()
                    cursor = 0
                }
                return
            }
        }
    }

    func Render(width int32, height int32) IRenderable {
        let brand = Tokens.Brand.Value.ToMarkup()
        let primary = Tokens.TextPrimary.Value.ToMarkup()
        let secondary = Tokens.TextSecondary.Value.ToMarkup()
        let tertiary = Tokens.TextTertiary.Value.ToMarkup()
        let selectedBg = Tokens.CellBackground.Value.ToMarkup()
        let innerWidth = Math.Max(10, width - 4)
        let rows = List[IRenderable]{
            Markup(Pad("[$brand]Commands[/]", "[$tertiary]esc[/]", innerWidth)),
            Markup("[$brand]:[/] [$primary]${Markup.Escape(query)}[/][$tertiary]▏[/]"),
            Markup(string.Empty)
        }
        let matches = Filtered
        if matches.Count == 0 {
            rows.Add(Markup("  [$tertiary]No matching commands[/]"))
        }
        for var i = 0; i < matches.Count; i++ {
            let selected = i == cursor
            let caret = if selected {
                "[$brand]❯[/] "
            } else {
                "  "
            }
            let name = if selected {
                "[$primary on $selectedBg]"
            } else {
                "[$primary]"
            }
            let help = if selected {
                "[$secondary on $selectedBg]"
            } else {
                "[$tertiary]"
            }
            rows.Add(
                Markup("$caret$name${Markup.Escape(matches[i].Verb)}[/]  $help${Markup.Escape(matches[i].Help)}[/]")
            )
        }
        rows.Add(Markup(string.Empty))
        rows.Add(Markup("[$tertiary]↑↓ navigate · Tab complete · Enter run · Esc cancel[/]"))
        // OpenCode-style floating surface: a filled background with a themed left accent
        // bar, matching the input box, rather than an enclosed rounded box.
        return Backdrop(
            Rows(rows),
            Tokens.InputBackground.Value,
            accent: Tokens.Brand.Value,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1
        )
    }

    shared {
        private func Pad(left string, right string, width int32) string {
            let used = Markup.Remove(left).Length + Markup.Remove(right).Length
            let gap = Math.Max(1, width - used)
            return "$left${String(' ', gap)}$right"
        }
    }
}
