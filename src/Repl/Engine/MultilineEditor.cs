// <copyright file="MultilineEditor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;

namespace GSharp.Repl.Engine;

/// <summary>A minimal multi-line text buffer with cursor; renders themed lines via Highlight.</summary>
public sealed class MultilineEditor
{
    private readonly List<string> lines = new() { string.Empty };
    private int line;
    private int col;

    public int Line => line;

    public int Col => col;

    public bool IsEmpty => lines.Count == 1 && lines[0].Length == 0;

    public string Text => string.Join("\n", lines);

    public void Clear()
    {
        lines.Clear();
        lines.Add(string.Empty);
        line = 0;
        col = 0;
    }

    public void Load(string text)
    {
        lines.Clear();
        foreach (var l in (text ?? string.Empty).Split('\n'))
        {
            lines.Add(l);
        }

        if (lines.Count == 0)
        {
            lines.Add(string.Empty);
        }

        line = lines.Count - 1;
        col = lines[line].Length;
    }

    public void Insert(char c)
    {
        lines[line] = lines[line].Insert(col, c.ToString());
        col++;
    }

    public void NewLine()
    {
        var rest = lines[line][col..];
        lines[line] = lines[line][..col];
        lines.Insert(line + 1, rest);
        line++;
        col = 0;
    }

    public void Backspace()
    {
        if (col > 0)
        {
            lines[line] = lines[line].Remove(col - 1, 1);
            col--;
        }
        else if (line > 0)
        {
            col = lines[line - 1].Length;
            lines[line - 1] += lines[line];
            lines.RemoveAt(line);
            line--;
        }
    }

    public void Left() => col = Math.Max(0, col - 1);

    public void Right() => col = Math.Min(lines[line].Length, col + 1);

    public void Up()
    {
        if (line > 0)
        {
            line--;
            col = Math.Min(col, lines[line].Length);
        }
    }

    public void Down()
    {
        if (line < lines.Count - 1)
        {
            line++;
            col = Math.Min(col, lines[line].Length);
        }
    }

    public IReadOnlyList<string> Lines => lines;

    /// <summary>Highlighted lines with a reverse-video block cursor at the caret.</summary>
    public IReadOnlyList<string> RenderLines(string cursorMarkup)
    {
        var result = new List<string>(lines.Count);
        for (var i = 0; i < lines.Count; i++)
        {
            if (i != line)
            {
                result.Add(Highlight.Markup(lines[i]));
                continue;
            }

            result.Add(Highlight.MarkupWithCursor(lines[i], col, cursorMarkup));
        }

        return result;
    }
}
