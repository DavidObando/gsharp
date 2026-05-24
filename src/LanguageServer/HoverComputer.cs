// <copyright file="LspFeatureComputers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using OmniSharp.Extensions.LanguageServer.Protocol;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using Range = OmniSharp.Extensions.LanguageServer.Protocol.Models.Range;

namespace GSharp.LanguageServer;

internal static class HoverComputer
{
    public static Hover ComputeHover(DocumentContent content, Position position)
    {
        var compilation = new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (symbol == null)
        {
            return null;
        }

        var signature = FormatSymbol(symbol);
        return new Hover
        {
            Contents = new MarkedStringsOrMarkupContent(new MarkupContent
            {
                Kind = MarkupKind.Markdown,
                Value = $"```gsharp\n{signature}\n```",
            }),
            Range = SemanticLookup.ToRange(token),
        };
    }

    internal static string FormatSymbol(Symbol symbol)
    {
        return symbol switch
        {
            VariableSymbol variable => $"let {variable.Name}: {FormatType(variable.Type)}",
            FunctionSymbol function => FormatFunction(function),
            StructSymbol aggregate => FormatAggregate(aggregate),
            EnumSymbol enumSymbol => FormatEnum(enumSymbol),
            EnumMemberSymbol member => $"enum member {member.EnumType.Name}.{member.Name}: {FormatType(member.EnumType)}",
            FieldSymbol field => $"field {field.Name}: {FormatType(field.Type)}",
            TypeSymbol type => $"type {FormatType(type)}",
            _ => $"{symbol.Kind.ToString().ToLowerInvariant()} {symbol.Name}",
        };
    }

    private static string FormatFunction(FunctionSymbol function)
    {
        var parameters = string.Join(", ", function.Parameters.Select(p => $"{p.Name} {FormatType(p.Type)}"));
        var returnType = ReferenceEquals(function.Type, TypeSymbol.Void) ? string.Empty : $" {FormatType(function.Type)}";
        return $"func {function.Name}({parameters}){returnType}";
    }

    private static string FormatAggregate(StructSymbol aggregate)
    {
        var keyword = aggregate.IsClass ? "class" : "struct";
        var fields = string.Join("; ", aggregate.Fields.Select(f => $"{f.Name} {FormatType(f.Type)}"));
        return $"{keyword} {aggregate.Name} {{ {fields} }}";
    }

    private static string FormatEnum(EnumSymbol enumSymbol)
    {
        var members = string.Join(", ", enumSymbol.Members.Select(m => m.Name));
        return $"enum {enumSymbol.Name} {{ {members} }}";
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }
}

internal static class ReferencesComputer
{
    public static IReadOnlyList<Location> ComputeReferences(DocumentUri uri, DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (target == null)
        {
            return Array.Empty<Location>();
        }

        // Phase 7.5 intentionally limits references to the currently tracked document; cross-file package awareness is future LSP work.
        return SemanticLookup.FindReferences(compilation, target)
            .Where(t => includeDeclaration || !IsDeclaration(compilation, t, target))
            .Select(t => new Location { Uri = uri, Range = SemanticLookup.ToRange(t) })
            .ToList();
    }

    public static IReadOnlyList<SyntaxToken> ComputeReferenceTokens(DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (target == null)
        {
            return Array.Empty<SyntaxToken>();
        }

        return SemanticLookup.FindReferences(compilation, target)
            .Where(t => includeDeclaration || !IsDeclaration(compilation, t, target))
            .ToList();
    }

    private static bool IsDeclaration(Compilation compilation, SyntaxToken token, Symbol target)
    {
        foreach (var declaration in SemanticLookup.FindReferences(compilation, target))
        {
            if (!ReferenceEquals(declaration, token) || declaration.Span.Start != token.Span.Start)
            {
                continue;
            }

            var parentDeclaration = FindSmallestContainingDeclaration(compilation.SyntaxTrees[0].Root, token);
            return parentDeclaration switch
            {
                VariableDeclarationSyntax v => ReferenceEquals(v.Identifier, token),
                FunctionDeclarationSyntax f => ReferenceEquals(f.Identifier, token),
                ParameterSyntax p => ReferenceEquals(p.Identifier, token),
                StructDeclarationSyntax s => ReferenceEquals(s.Identifier, token),
                FieldDeclarationSyntax f => ReferenceEquals(f.Identifier, token),
                EnumDeclarationSyntax e => ReferenceEquals(e.Identifier, token),
                EnumMemberSyntax e => ReferenceEquals(e.Identifier, token),
                _ => false,
            };
        }

        return false;
    }

    private static SyntaxNode FindSmallestContainingDeclaration(SyntaxNode node, SyntaxToken token)
    {
        SyntaxNode best = null;
        Visit(node);
        return best;

        void Visit(SyntaxNode current)
        {
            if (current.Span.Start <= token.Span.Start && token.Span.End <= current.Span.End)
            {
                if (current is VariableDeclarationSyntax or FunctionDeclarationSyntax or ParameterSyntax or StructDeclarationSyntax or FieldDeclarationSyntax or EnumDeclarationSyntax or EnumMemberSyntax)
                {
                    if (best == null || current.Span.Length < best.Span.Length)
                    {
                        best = current;
                    }
                }

                foreach (var child in current.GetChildren())
                {
                    Visit(child);
                }
            }
        }
    }
}

internal static class RenameComputer
{
    public static WorkspaceEdit ComputeRename(DocumentUri uri, DocumentContent content, Position position, string newName)
    {
        if (!SemanticLookup.IsValidIdentifier(newName))
        {
            return null;
        }

        var compilation = new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (!SemanticLookup.CanRename(target))
        {
            return null;
        }

        var edits = SemanticLookup.FindReferences(compilation, target)
            .Select(t => new TextEdit { Range = SemanticLookup.ToRange(t), NewText = newName })
            .ToList();
        if (edits.Count == 0)
        {
            return null;
        }

        return new WorkspaceEdit
        {
            Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
            {
                [uri] = edits,
            },
        };
    }
}

internal static class CodeActionComputer
{
    public static CommandOrCodeActionContainer ComputeCodeActions(DocumentUri uri, DocumentContent content, Range range)
    {
        var actions = new List<CommandOrCodeAction>();
        var sortImports = TryCreateSortImports(uri, content);
        if (sortImports != null)
        {
            actions.Add(new CommandOrCodeAction(sortImports));
        }

        return new CommandOrCodeActionContainer(actions);
    }

    private static CodeAction TryCreateSortImports(DocumentUri uri, DocumentContent content)
    {
        var imports = content.SyntaxTree.Root.Members.OfType<ImportSyntax>().ToList();
        if (imports.Count < 2)
        {
            return null;
        }

        var source = content.SyntaxTree.Text.ToString();
        var importTexts = imports.Select(i => source.Substring(i.Span.Start, i.Span.Length).TrimEnd()).ToList();
        var sorted = importTexts.OrderBy(t => t, StringComparer.Ordinal).ToList();
        if (importTexts.SequenceEqual(sorted))
        {
            return null;
        }

        var start = imports.First().Span.Start;
        var end = imports.Last().Span.End;
        while (end < source.Length && (source[end] == '\r' || source[end] == '\n'))
        {
            end++;
            if (end <= source.Length && source[end - 1] == '\r' && end < source.Length && source[end] == '\n')
            {
                end++;
            }

            break;
        }

        var newText = string.Join(Environment.NewLine, sorted) + Environment.NewLine;
        return new CodeAction
        {
            Title = "Sort imports",
            Kind = CodeActionKind.RefactorRewrite,
            Edit = new WorkspaceEdit
            {
                Changes = new Dictionary<DocumentUri, IEnumerable<TextEdit>>
                {
                    [uri] = new[]
                    {
                        new TextEdit
                        {
                            Range = SemanticLookup.ToRange(content.SyntaxTree.Text, TextSpan.FromBounds(start, end)),
                            NewText = newText,
                        },
                    },
                },
            },
        };
    }
}
