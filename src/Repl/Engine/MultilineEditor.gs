// <copyright file="MultilineEditor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import System
import System.Collections.Generic
import System.Text

/// A minimal multi-line text buffer with cursor; renders themed lines via Highlight.
class MultilineEditor {
    private let lines List[string] = List[string]{string.Empty}
    private var line int32
    private var col int32
    prop Line int32 -> line
    prop Col int32 -> col
    prop IsEmpty bool -> lines.Count == 1 && lines[0].Length == 0
    prop Text string -> string.Join("\n", lines)

    func Clear() {
        lines.Clear()
        lines.Add(string.Empty)
        line = 0
        col = 0
    }

    func Load(text string) {
        lines.Clear()
        for l in(text ?? string.Empty).Split('\n') {
            lines.Add(l)
        }
        if lines.Count == 0 {
            lines.Add(string.Empty)
        }
        line = lines.Count - 1
        col = lines[line].Length
    }

    func Insert(c char) {
        lines[line] = lines[line].Insert(col, c.ToString())
        col++
    }

    func NewLine() {
        let rest = lines[line][col ..]
        lines[line] = lines[line][.. col]
        lines.Insert(line + 1, rest)
        line++
        col = 0
    }

    func Backspace() {
        if col > 0 {
            lines[line] = lines[line].Remove(col - 1, 1)
            col--
        } else if line > 0 {
            col = lines[line - 1].Length
            lines[line - 1] += lines[line]
            lines.RemoveAt(line)
            line--
        }
    }

    func Left() -> col = Math.Max(0, col - 1)

    func Right() -> col = Math.Min(lines[line].Length, col + 1)

    func Up() {
        if line > 0 {
            line--
            col = Math.Min(col, lines[line].Length)
        }
    }

    func Down() {
        if line < lines.Count - 1 {
            line++
            col = Math.Min(col, lines[line].Length)
        }
    }

    prop Lines IReadOnlyList[string] -> lines

    /// Highlighted lines with a reverse-video block cursor at the caret.
    func RenderLines(cursorMarkup string) IReadOnlyList[string] {
        let result = List[string](lines.Count)
        for var i = 0; i < lines.Count; i++ {
            if i != line {
                result.Add(Highlight.Markup(lines[i]))
                continue
            }
            result.Add(Highlight.MarkupWithCursor(lines[i], col, cursorMarkup))
        }
        return result
    }
}
