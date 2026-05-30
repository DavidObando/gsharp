// <copyright file="FoldingHandler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function folding range computer that the language server and tests can both use
/// without needing an LSP transport.
/// </summary>
internal static class FoldingComputer
{
    public static IEnumerable<FoldingRange> ComputeFoldings(DocumentContent content)
    {
        // TODO: Functions are only at the root for the moment
        foreach (FunctionDeclarationSyntax function in content.SyntaxTree.Root.Members.OfType<FunctionDeclarationSyntax>())
        {
            int startLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.Start);
            int endLine = content.Lines.Count(charNumber => charNumber < function.Body.Span.End);
            yield return new FoldingRange
            {
                StartLine = startLine,
                EndLine = endLine,
                Kind = FoldingRangeKind.Region,
                EndCharacter = 0,
                StartCharacter = 0,
            };
        }
    }
}
