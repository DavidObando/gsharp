// <copyright file="MultilineEditor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using Spectre.Console;

namespace GSharp.Repl;

/// <summary>
/// An in-memory multiline text editor with cursor tracking and GSharp syntax
/// highlighting. Produces Spectre.Console markup lines (<see cref="RenderLines"/>)
/// for the input box, drawing a visible block cursor at the caret.
/// </summary>
internal sealed class MultilineEditor
{
    private readonly List<string> lines = new() { string.Empty };

    /// <summary>Gets the zero-based caret line.</summary>
    public int CursorLine { get; private set; }

    /// <summary>Gets the zero-based caret column.</summary>
    public int CursorColumn { get; private set; }

    /// <summary>Gets the number of lines in the buffer.</summary>
    public int LineCount => lines.Count;

    /// <summary>Gets a value indicating whether the buffer is empty.</summary>
    public bool IsEmpty => lines.Count == 1 && lines[0].Length == 0;

    /// <summary>Gets the editor contents joined by newlines.</summary>
    public string Text => string.Join("\n", lines);

    /// <summary>Inserts a single character at the caret.</summary>
    /// <param name="c">The character to insert.</param>
    public void Insert(char c)
    {
        lines[CursorLine] = lines[CursorLine].Insert(CursorColumn, c.ToString());
        CursorColumn++;
    }

    /// <summary>Inserts text (which may contain newlines) at the caret.</summary>
    /// <param name="text">The text to insert.</param>
    public void InsertText(string text)
    {
        foreach (var c in text)
        {
            if (c == '\n')
            {
                NewLine();
            }
            else if (c != '\r')
            {
                Insert(c);
            }
        }
    }

    /// <summary>Splits the current line at the caret, creating a new line.</summary>
    public void NewLine()
    {
        var remainder = lines[CursorLine].Substring(CursorColumn);
        lines[CursorLine] = lines[CursorLine].Substring(0, CursorColumn);
        lines.Insert(CursorLine + 1, remainder);
        CursorLine++;
        CursorColumn = 0;
    }

    /// <summary>Deletes the character before the caret (or merges lines).</summary>
    public void Backspace()
    {
        if (CursorColumn > 0)
        {
            var line = lines[CursorLine];
            lines[CursorLine] = line.Remove(CursorColumn - 1, 1);
            CursorColumn--;
        }
        else if (CursorLine > 0)
        {
            var prevLen = lines[CursorLine - 1].Length;
            lines[CursorLine - 1] += lines[CursorLine];
            lines.RemoveAt(CursorLine);
            CursorLine--;
            CursorColumn = prevLen;
        }
    }

    /// <summary>Deletes the character at the caret (or merges the next line).</summary>
    public void Delete()
    {
        var line = lines[CursorLine];
        if (CursorColumn < line.Length)
        {
            lines[CursorLine] = line.Remove(CursorColumn, 1);
        }
        else if (CursorLine < lines.Count - 1)
        {
            lines[CursorLine] += lines[CursorLine + 1];
            lines.RemoveAt(CursorLine + 1);
        }
    }

    /// <summary>Moves the caret left, wrapping to the previous line.</summary>
    public void MoveLeft()
    {
        if (CursorColumn > 0)
        {
            CursorColumn--;
        }
        else if (CursorLine > 0)
        {
            CursorLine--;
            CursorColumn = lines[CursorLine].Length;
        }
    }

    /// <summary>Moves the caret right, wrapping to the next line.</summary>
    public void MoveRight()
    {
        if (CursorColumn < lines[CursorLine].Length)
        {
            CursorColumn++;
        }
        else if (CursorLine < lines.Count - 1)
        {
            CursorLine++;
            CursorColumn = 0;
        }
    }

    /// <summary>Moves the caret up one line.</summary>
    public void MoveUp()
    {
        if (CursorLine > 0)
        {
            CursorLine--;
            CursorColumn = Math.Min(CursorColumn, lines[CursorLine].Length);
        }
    }

    /// <summary>Moves the caret down one line.</summary>
    public void MoveDown()
    {
        if (CursorLine < lines.Count - 1)
        {
            CursorLine++;
            CursorColumn = Math.Min(CursorColumn, lines[CursorLine].Length);
        }
    }

    /// <summary>Moves the caret to the start of the current line.</summary>
    public void MoveHome() => CursorColumn = 0;

    /// <summary>Moves the caret to the end of the current line.</summary>
    public void MoveEnd() => CursorColumn = lines[CursorLine].Length;

    /// <summary>Replaces the entire buffer with the given text.</summary>
    /// <param name="text">The replacement text.</param>
    public void SetText(string text)
    {
        lines.Clear();
        var parts = (text ?? string.Empty).Replace("\r\n", "\n").Split('\n');
        foreach (var p in parts)
        {
            lines.Add(p);
        }

        if (lines.Count == 0)
        {
            lines.Add(string.Empty);
        }

        CursorLine = lines.Count - 1;
        CursorColumn = lines[CursorLine].Length;
    }

    /// <summary>Clears the buffer.</summary>
    public void Clear()
    {
        lines.Clear();
        lines.Add(string.Empty);
        CursorLine = 0;
        CursorColumn = 0;
    }

    /// <summary>
    /// Renders the buffer to Spectre.Console markup lines, drawing a visible block
    /// cursor at the caret on the active line when <paramref name="showCursor"/> is set.
    /// </summary>
    /// <param name="showCursor">Whether to draw the block cursor.</param>
    /// <returns>One markup string per buffer line.</returns>
    public IReadOnlyList<string> RenderLines(bool showCursor = true)
    {
        var result = new List<string>(lines.Count);
        for (var row = 0; row < lines.Count; row++)
        {
            var drawCursor = showCursor && row == CursorLine;
            result.Add(RenderLine(lines[row], drawCursor ? CursorColumn : -1));
        }

        return result;
    }

    private static string RenderLine(string line, int cursorColumn)
    {
        var builder = new StringBuilder();
        var tokens = SyntaxTree.ParseTokens(line);
        var rendered = 0;
        foreach (var token in tokens)
        {
            var text = token.Text;
            if (string.IsNullOrEmpty(text))
            {
                continue;
            }

            var color = ColorFor(token.Kind);
            AppendSpan(builder, text, token.Position, color, cursorColumn);
            rendered = token.Position + text.Length;
        }

        if (cursorColumn >= rendered)
        {
            // Caret at end of line: draw a trailing block cell.
            builder.Append("[invert] [/]");
        }

        return builder.ToString();
    }

    private static void AppendSpan(StringBuilder builder, string text, int start, string color, int cursorColumn)
    {
        for (var i = 0; i < text.Length; i++)
        {
            var col = start + i;
            var ch = Markup.Escape(text[i].ToString());
            if (col == cursorColumn)
            {
                builder.Append("[invert]").Append(ch).Append("[/]");
            }
            else
            {
                builder.Append('[').Append(color).Append(']').Append(ch).Append("[/]");
            }
        }
    }

    private static string ColorFor(SyntaxKind kind)
    {
        if (kind.ToString().EndsWith("Keyword", StringComparison.Ordinal))
        {
            return "deepskyblue1";
        }

        return kind switch
        {
            SyntaxKind.IdentifierToken => "gold1",
            SyntaxKind.NumberToken => "aqua",
            SyntaxKind.StringToken => "fuchsia",
            SyntaxKind.CommentToken => "green",
            _ => "grey",
        };
    }
}
