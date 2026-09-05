// <copyright file="Doc.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;

namespace GSharp.Formatting;

/// <summary>
/// Small Wadler/Oppen document algebra used by the canonical formatter.
/// </summary>
internal abstract class Doc
{
    private enum RenderMode
    {
        Flat,
        Break,
    }

    public static Doc Empty { get; } = new TextDoc(string.Empty);

    public static Doc Line { get; } = new LineDoc(" ");

    public static Doc SoftLine { get; } = new LineDoc(string.Empty);

    public static Doc HardLine { get; } = new HardLineDoc();

    public static Doc Text(string text) => string.IsNullOrEmpty(text) ? Empty : new TextDoc(text);

    public static Doc Concat(IEnumerable<Doc> documents)
    {
        var result = Empty;
        foreach (Doc document in documents)
        {
            if (!ReferenceEquals(document, Empty))
            {
                result = ReferenceEquals(result, Empty)
                    ? document
                    : new ConcatDoc(result, document);
            }
        }

        return result;
    }

    public static Doc Concat(params Doc[] documents) => Concat((IEnumerable<Doc>)documents);

    public static Doc Nest(int indentation, Doc document) =>
        indentation == 0 ? document : new NestDoc(indentation, document);

    public static Doc Group(Doc document) => new GroupDoc(document);

    public static string Render(Doc document, int width)
    {
        var builder = new StringBuilder();
        var pending = new Stack<RenderItem>();
        pending.Push(new RenderItem(0, RenderMode.Break, document));
        var column = 0;
        var pendingIndentation = -1;

        while (pending.Count > 0)
        {
            RenderItem item = pending.Pop();
            switch (item.Document)
            {
                case TextDoc text:
                    if (text.Value.Length > 0 && pendingIndentation >= 0)
                    {
                        builder.Append(' ', pendingIndentation);
                        pendingIndentation = -1;
                    }

                    builder.Append(text.Value);
                    int lastNewline = text.Value.LastIndexOf('\n');
                    column = lastNewline < 0
                        ? column + text.Value.Length
                        : text.Value.Length - lastNewline - 1;
                    break;
                case LineDoc line:
                    if (item.Mode == RenderMode.Flat)
                    {
                        if (line.FlatText.Length > 0 && pendingIndentation >= 0)
                        {
                            builder.Append(' ', pendingIndentation);
                            pendingIndentation = -1;
                        }

                        builder.Append(line.FlatText);
                        column += line.FlatText.Length;
                    }
                    else
                    {
                        builder.Append('\n');
                        pendingIndentation = item.Indentation;
                        column = item.Indentation;
                    }

                    break;
                case HardLineDoc:
                    builder.Append('\n');
                    pendingIndentation = item.Indentation;
                    column = item.Indentation;
                    break;
                case ConcatDoc concat:
                    pending.Push(new RenderItem(item.Indentation, item.Mode, concat.Right));
                    pending.Push(new RenderItem(item.Indentation, item.Mode, concat.Left));
                    break;
                case NestDoc nest:
                    pending.Push(new RenderItem(
                        item.Indentation + nest.Indentation,
                        item.Mode,
                        nest.Document));
                    break;
                case GroupDoc group:
                    var flat = new RenderItem(item.Indentation, RenderMode.Flat, group.Document);
                    pending.Push(Fits(width - column, flat, pending)
                        ? flat
                        : new RenderItem(item.Indentation, RenderMode.Break, group.Document));
                    break;
                default:
                    throw new InvalidOperationException("Unknown document node.");
            }
        }

        return builder.ToString();
    }

    private static bool Fits(int remaining, RenderItem first, Stack<RenderItem> rest)
    {
        var pending = new Stack<RenderItem>();
        RenderItem[] remainingItems = rest.ToArray();
        for (int i = remainingItems.Length - 1; i >= 0; i--)
        {
            pending.Push(remainingItems[i]);
        }

        pending.Push(first);
        while (remaining >= 0 && pending.Count > 0)
        {
            RenderItem item = pending.Pop();
            switch (item.Document)
            {
                case TextDoc text:
                    int newline = text.Value.IndexOf('\n');
                    if (newline >= 0)
                    {
                        return true;
                    }

                    remaining -= text.Value.Length;
                    break;
                case LineDoc line:
                    if (item.Mode == RenderMode.Flat)
                    {
                        remaining -= line.FlatText.Length;
                    }
                    else
                    {
                        return true;
                    }

                    break;
                case HardLineDoc:
                    return item.Mode != RenderMode.Flat;
                case ConcatDoc concat:
                    pending.Push(new RenderItem(item.Indentation, item.Mode, concat.Right));
                    pending.Push(new RenderItem(item.Indentation, item.Mode, concat.Left));
                    break;
                case NestDoc nest:
                    pending.Push(new RenderItem(
                        item.Indentation + nest.Indentation,
                        item.Mode,
                        nest.Document));
                    break;
                case GroupDoc group:
                    pending.Push(new RenderItem(item.Indentation, RenderMode.Flat, group.Document));
                    break;
            }
        }

        return remaining >= 0;
    }

    private readonly record struct RenderItem(int Indentation, RenderMode Mode, Doc Document);

    private sealed class TextDoc : Doc
    {
        public TextDoc(string text) => Value = text;

        public string Value { get; }
    }

    private sealed class LineDoc : Doc
    {
        public LineDoc(string flatText) => FlatText = flatText;

        public string FlatText { get; }
    }

    private sealed class HardLineDoc : Doc
    {
    }

    private sealed class ConcatDoc : Doc
    {
        public ConcatDoc(Doc left, Doc right)
        {
            Left = left;
            Right = right;
        }

        public Doc Left { get; }

        public Doc Right { get; }
    }

    private sealed class NestDoc : Doc
    {
        public NestDoc(int indentation, Doc document)
        {
            Indentation = indentation;
            Document = document;
        }

        public int Indentation { get; }

        public Doc Document { get; }
    }

    private sealed class GroupDoc : Doc
    {
        public GroupDoc(Doc document) => Document = document;

        public Doc Document { get; }
    }
}
