// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
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

    public static EditorAnalysis Analyze(string text)
        => Safe(() => AnalyzeCore(text), EditorAnalysis.Empty);

    public static string Format(string text)
        => Safe(() => FormattingEngine.Format(text), text);

    public static string SyntaxTree(string text)
        => Safe(() => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(text).Root.ToString(), string.Empty);

    public static EditorCompletionEdit CompletionEdit(CompletionItem item, int line, int character, int fallbackStart)
    {
        var startLine = line;
        var startCharacter = fallbackStart;
        var endLine = line;
        var endCharacter = character;
        var text = item.InsertText ?? item.Label ?? string.Empty;
        if (item.TextEdit is not null)
        {
            startLine = item.TextEdit.Range.Start.Line;
            startCharacter = item.TextEdit.Range.Start.Character;
            endLine = item.TextEdit.Range.End.Line;
            endCharacter = item.TextEdit.Range.End.Character;
            text = item.TextEdit.NewText;
        }

        if (item.InsertTextFormat == InsertTextFormat.Snippet)
        {
            text = Regex.Replace(text, @"\$\{\d+:([^}]*)\}", "$1");
            text = Regex.Replace(text, @"\$\{\d+\}", string.Empty);
            text = Regex.Replace(text, @"\$\d+", string.Empty);
        }

        return new EditorCompletionEdit(startLine, startCharacter, endLine, endCharacter, text);
    }

    private static EditorAnalysis AnalyzeCore(string text)
    {
        var result = DocumentSyncHandler.ComputeDiagnostics(text, skipBinding: false);
        var document = new SemanticTokensDocument(SemanticTokensHandler.Legend);
        var builder = document.Create();
        SemanticTokensComputer.Tokenize(builder, result.Content);
        builder.Commit();

        var data = document.GetSemanticTokens().Data;
        var tokens = new List<EditorToken>(data.Length / 5);
        var line = 0;
        var character = 0;
        for (var i = 0; i + 4 < data.Length; i += 5)
        {
            line += data[i];
            character = data[i] == 0 ? character + data[i + 1] : data[i + 1];
            tokens.Add(new EditorToken(line, character, data[i + 2], data[i + 3]));
        }

        var diagnostics = result.Diagnostics.Select(d => new EditorDiagnostic(
            d.Range.Start.Line,
            d.Range.Start.Character,
            d.Range.End.Line,
            d.Range.End.Character,
            d.Code?.Value ?? string.Empty,
            d.Message,
            (int)d.Severity)).ToArray();
        return new EditorAnalysis(tokens, diagnostics);
    }

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

public sealed record EditorToken(int Line, int StartCharacter, int Length, int Kind);

public sealed record EditorDiagnostic(
    int StartLine,
    int StartCharacter,
    int EndLine,
    int EndCharacter,
    string Code,
    string Message,
    int Severity);

public sealed record EditorAnalysis(
    IReadOnlyList<EditorToken> Tokens,
    IReadOnlyList<EditorDiagnostic> Diagnostics)
{
    public static EditorAnalysis Empty { get; } = new(Array.Empty<EditorToken>(), Array.Empty<EditorDiagnostic>());
}

public sealed record EditorCompletionEdit(
    int StartLine,
    int StartCharacter,
    int EndLine,
    int EndCharacter,
    string NewText);
