// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer;
using GSharp.LanguageServer.Protocol;

namespace GSharp.Repl.Engine;

/// <summary>In-process bridge to the G# language server: completions and hover for editor text.</summary>
public static class AnalysisBridge
{
    public static IReadOnlyList<CompletionItem> Completions(string text, int line, int col)
        => Safe(() => CompletionComputer.ComputeCompletions(Build(text), new Position(line, col)), Array.Empty<CompletionItem>());

    public static string? Hover(string text, int line, int col)
        => Safe(() => HoverComputer.ComputeHover(Build(text), new Position(line, col))?.Contents?.MarkupContent?.Value, null);

    private static DocumentContent Build(string text)
    {
        var lines = new List<int>();
        var i = text.IndexOf('\n');
        while (i >= 0)
        {
            lines.Add(i);
            i = text.IndexOf('\n', i + 1);
        }

        return new DocumentContent(SyntaxTree.Parse(text), lines);
    }

    private static T Safe<T>(Func<T> f, T fallback)
    {
        try
        {
            return f();
        }
        catch
        {
            return fallback;
        }
    }
}
