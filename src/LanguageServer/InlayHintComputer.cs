#nullable disable

// <copyright file="InlayHintHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function inlay hint computer usable by both the handler and tests.
/// </summary>
public static class InlayHintComputer
{
    public static IReadOnlyList<InlayHint> ComputeHints(DocumentContent content)
    {
        var tree = content.SyntaxTree;
        var text = tree.Text;
        var hints = new List<InlayHint>();

        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation;
        try
        {
            compilation = content.Project?.GetCompilation()
                ?? new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        }
        catch
        {
            return hints;
        }

        foreach (var call in FindNodes<CallExpressionSyntax>(tree.Root))
        {
            AddParameterHints(hints, call, compilation, text);
        }

        return hints;
    }

    private static void AddParameterHints(
        List<InlayHint> hints,
        CallExpressionSyntax call,
        GSharp.Core.CodeAnalysis.Compilation.Compilation compilation,
        GSharp.Core.CodeAnalysis.Text.SourceText text)
    {
        var symbol = SemanticLookup.ResolveSymbol(compilation, call.Identifier);
        if (symbol is not FunctionSymbol func)
        {
            return;
        }

        var args = call.Arguments.ToArray();
        var parameters = func.Parameters;

        // Skip receiver parameter for method calls
        var paramOffset = func.ExplicitReceiverParameter != null ? 1 : 0;

        for (var i = 0; i < args.Length && i + paramOffset < parameters.Length; i++)
        {
            var param = parameters[i + paramOffset];
            var arg = args[i];

            // Don't show hint if the argument is already a simple identifier matching the parameter name
            if (arg is NameExpressionSyntax nameExpr && string.Equals(nameExpr.IdentifierToken.Text, param.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var argStart = arg.Span.Start;
            var line = text.GetLineIndex(argStart);
            var character = argStart - text.Lines[line].Start;

            hints.Add(new InlayHint
            {
                Position = new Position(line, character),
                Label = new StringOrInlayHintLabelParts($"{param.Name}:"),
                Kind = InlayHintKind.Parameter,
                PaddingRight = true,
            });
        }
    }

    private static IEnumerable<T> FindNodes<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T matched)
        {
            yield return matched;
        }

        foreach (var child in root.GetChildren())
        {
            foreach (var descendant in FindNodes<T>(child))
            {
                yield return descendant;
            }
        }
    }
}
