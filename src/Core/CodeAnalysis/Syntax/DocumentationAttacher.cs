#nullable disable

// <copyright file="DocumentationAttacher.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Implements the position-based documentation attachment pass (ADR-0057 §7).
/// Groups consecutive <see cref="SyntaxKind.DocumentationCommentToken"/>s into blocks
/// by line-adjacency, then attaches each block to the nearest documentable declaration
/// whose start follows immediately after.
/// </summary>
internal static class DocumentationAttacher
{
    /// <summary>
    /// Runs the attachment algorithm over a parsed syntax tree, returning a table
    /// that maps declaration nodes to their joined documentation block text.
    /// </summary>
    /// <param name="tree">The fully-parsed syntax tree.</param>
    /// <returns>A dictionary from declaration node to documentation text.</returns>
    internal static Dictionary<SyntaxNode, string> Attach(SyntaxTree tree)
    {
        var result = new Dictionary<SyntaxNode, string>();
        var blocks = GetBlocks(tree);
        if (blocks.IsDefaultOrEmpty)
        {
            return result;
        }

        var sourceText = tree.Text;

        // Collect all documentable declarations sorted by source position.
        var declarations = GetDocumentableDeclarations(tree);

        var declIndex = 0;
        foreach (var block in blocks)
        {
            // Advance past declarations that start before the block end.
            while (declIndex < declarations.Count &&
                   declarations[declIndex].Span.Start < block.EndPosition)
            {
                declIndex++;
            }

            if (declIndex >= declarations.Count)
            {
                break;
            }

            var candidate = declarations[declIndex];

            // The declaration must start on the line immediately following the block's last line.
            var candidateLine = sourceText.GetLineIndex(candidate.Span.Start);
            if (candidateLine == block.LastLine + 1)
            {
                result[candidate] = block.Text;
            }
        }

        return result;
    }

    internal static ImmutableArray<DocBlock> GetBlocks(SyntaxTree tree)
    {
        var docTokens = tree.DocumentationTokens;
        if (docTokens.IsDefaultOrEmpty)
        {
            return ImmutableArray<DocBlock>.Empty;
        }

        return GroupIntoBlocks(docTokens, tree.Text).ToImmutableArray();
    }

    internal static List<SyntaxNode> GetDocumentableDeclarations(SyntaxTree tree)
    {
        var declarations = CollectDocumentableDeclarations(tree.Root);
        declarations.Sort((a, b) => a.Span.Start.CompareTo(b.Span.Start));
        return declarations;
    }

    private static List<DocBlock> GroupIntoBlocks(ImmutableArray<SyntaxToken> docTokens, SourceText sourceText)
    {
        var blocks = new List<DocBlock>();
        var currentLines = new List<string>();
        var currentFirstLine = -1;
        var currentLastLine = -1;
        var currentEndPosition = 0;
        TextLocation currentLocation = default;

        foreach (var token in docTokens)
        {
            var tokenLine = sourceText.GetLineIndex(token.Span.Start);

            if (currentLines.Count > 0 && tokenLine != currentLastLine + 1)
            {
                // Gap: finalize current block.
                blocks.Add(new DocBlock(currentFirstLine, currentLastLine, currentEndPosition, currentLocation, JoinBlock(currentLines)));
                currentLines.Clear();
            }

            if (currentLines.Count == 0)
            {
                currentFirstLine = tokenLine;
                currentLocation = token.Location;
            }

            currentLastLine = tokenLine;
            currentEndPosition = token.Span.End;
            currentLines.Add((string)token.Value ?? string.Empty);
        }

        if (currentLines.Count > 0)
        {
            blocks.Add(new DocBlock(currentFirstLine, currentLastLine, currentEndPosition, currentLocation, JoinBlock(currentLines)));
        }

        return blocks;
    }

    private static string JoinBlock(List<string> lines)
    {
        return string.Join("\n", lines);
    }

    private static List<SyntaxNode> CollectDocumentableDeclarations(CompilationUnitSyntax root)
    {
        var result = new List<SyntaxNode>();

        foreach (var member in root.Members)
        {
            CollectFromMember(member, result);
        }

        return result;
    }

    private static void CollectFromMember(SyntaxNode node, List<SyntaxNode> result)
    {
        switch (node)
        {
            case PackageSyntax pkg:
                result.Add(pkg);
                break;

            case ImportSyntax imp:
                result.Add(imp);
                break;

            case FunctionDeclarationSyntax func:
                result.Add(func);
                break;

            case ConstructorDeclarationSyntax ctor:
                result.Add(ctor);
                break;

            case TypeAliasDeclarationSyntax alias:
                result.Add(alias);
                break;

            case StructDeclarationSyntax structDecl:
                result.Add(structDecl);
                CollectFromStructBody(structDecl, result);
                break;

            case EnumDeclarationSyntax enumDecl:
                result.Add(enumDecl);
                CollectFromEnumBody(enumDecl, result);
                break;

            case InterfaceDeclarationSyntax ifaceDecl:
                result.Add(ifaceDecl);
                CollectFromInterfaceBody(ifaceDecl, result);
                break;

            case GlobalStatementSyntax global:
                // Top-level variable declarations are documentable.
                if (global.Statement is VariableDeclarationSyntax)
                {
                    result.Add(global);
                }

                break;
        }
    }

    private static void CollectFromStructBody(StructDeclarationSyntax structDecl, List<SyntaxNode> result)
    {
        foreach (var field in structDecl.Fields)
        {
            result.Add(field);
        }

        foreach (var prop in structDecl.Properties)
        {
            result.Add(prop);
        }

        foreach (var evt in structDecl.Events)
        {
            result.Add(evt);
        }

        foreach (var method in structDecl.Methods)
        {
            result.Add(method);
        }

        if (structDecl.Constructors != null)
        {
            foreach (var ctor in structDecl.Constructors)
            {
                result.Add(ctor);
            }
        }

        // ADR-0053: members declared inside a `shared { … }` block are still
        // documentable. The block itself is not a documentable declaration,
        // but each contained field/property/event/method is.
        if (structDecl.SharedBlock != null)
        {
            foreach (var field in structDecl.SharedBlock.Fields)
            {
                result.Add(field);
            }

            foreach (var prop in structDecl.SharedBlock.Properties)
            {
                result.Add(prop);
            }

            foreach (var evt in structDecl.SharedBlock.Events)
            {
                result.Add(evt);
            }

            foreach (var method in structDecl.SharedBlock.Methods)
            {
                result.Add(method);
            }
        }
    }

    private static void CollectFromEnumBody(EnumDeclarationSyntax enumDecl, List<SyntaxNode> result)
    {
        foreach (var member in enumDecl.Members)
        {
            result.Add(member);
        }
    }

    private static void CollectFromInterfaceBody(InterfaceDeclarationSyntax interfaceDecl, List<SyntaxNode> result)
    {
        foreach (var prop in interfaceDecl.Properties)
        {
            result.Add(prop);
        }

        foreach (var evt in interfaceDecl.Events)
        {
            result.Add(evt);
        }

        foreach (var method in interfaceDecl.Methods)
        {
            result.Add(method);
        }
    }

    internal readonly struct DocBlock
    {
        public DocBlock(int firstLine, int lastLine, int endPosition, TextLocation location, string text)
        {
            FirstLine = firstLine;
            LastLine = lastLine;
            EndPosition = endPosition;
            Location = location;
            Text = text;
        }

        public int FirstLine { get; }

        public int LastLine { get; }

        public int EndPosition { get; }

        public TextLocation Location { get; }

        public string Text { get; }
    }
}
