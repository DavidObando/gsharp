// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer;
using GSharp.LanguageServer.Protocol;

namespace GSharp.Repl;

/// <summary>
/// Adapts the GSharp <c>LanguageServer</c> analysis services for in-process,
/// single-file REPL use. Builds a transient <see cref="DocumentContent"/> from raw
/// buffer text and forwards to the same completion/hover computers the editor uses.
/// </summary>
internal sealed class AnalysisBridge
{
    /// <summary>
    /// Computes completions at the given caret position.
    /// </summary>
    /// <param name="source">The full editor buffer text.</param>
    /// <param name="line">Zero-based caret line.</param>
    /// <param name="character">Zero-based caret column.</param>
    /// <returns>Completion candidates; empty when analysis fails.</returns>
    public IReadOnlyList<CompletionEntry> GetCompletions(string source, int line, int character)
    {
        try
        {
            var content = BuildContent(source);
            var items = CompletionComputer.ComputeCompletions(content, new Position(line, character));
            return items
                .Select(i => new CompletionEntry(i.Label, i.Detail ?? string.Empty, KindTag(i.Kind)))
                .ToList();
        }
        catch (Exception)
        {
            return Array.Empty<CompletionEntry>();
        }
    }

    /// <summary>
    /// Computes hover documentation at the given caret position.
    /// </summary>
    /// <param name="source">The full editor buffer text.</param>
    /// <param name="line">Zero-based caret line.</param>
    /// <param name="character">Zero-based caret column.</param>
    /// <returns>Hover markdown, or null when nothing is available.</returns>
    public string GetHover(string source, int line, int character)
    {
        try
        {
            var content = BuildContent(source);
            var hover = HoverComputer.ComputeHover(content, new Position(line, character));
            return hover?.Contents?.ToString();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static DocumentContent BuildContent(string source)
    {
        source ??= string.Empty;
        var lines = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lines.Add(i);
            }
        }

        return new DocumentContent(SyntaxTree.Parse(source), lines);
    }

    private static string KindTag(CompletionItemKind kind) => kind switch
    {
        CompletionItemKind.Keyword => "kw",
        CompletionItemKind.Function => "func",
        CompletionItemKind.Method => "func",
        CompletionItemKind.Variable => "var",
        CompletionItemKind.Field => "field",
        CompletionItemKind.Property => "prop",
        CompletionItemKind.Struct => "struct",
        CompletionItemKind.Class => "class",
        CompletionItemKind.Interface => "iface",
        CompletionItemKind.Enum => "enum",
        CompletionItemKind.EnumMember => "enum",
        _ => "id",
    };
}

/// <summary>
/// Describes a single completion candidate surfaced to the REPL.
/// </summary>
/// <param name="Label">The candidate label.</param>
/// <param name="Detail">Optional detail text (signature, type).</param>
/// <param name="Kind">A short kind tag such as "func" or "var".</param>
internal sealed record CompletionEntry(string Label, string Detail, string Kind);
