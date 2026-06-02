// <copyright file="LspFeatureComputers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.LanguageServer.Protocol;
using LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer;

public static class HoverComputer
{
    public static Hover ComputeHover(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);

        var model = symbol != null
            ? BuildHoverModel(symbol, compilation)
            : BuildImportedClrModel(content.SyntaxTree, compilation, token);

        if (model == null)
        {
            return null;
        }

        return new Hover
        {
            Contents = new MarkedStringsOrMarkupContent(new MarkupContent
            {
                Kind = MarkupKind.Markdown,
                Value = RenderHover(model),
            }),
            Range = SemanticLookup.ToRange(token),
        };
    }

    /// <summary>
    /// Renders a symbol's compact signature label for signature help and completion
    /// detail. Hover uses the richer <see cref="SymbolDisplayFormat.Hover"/> form via
    /// <see cref="ComputeHover"/>.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <returns>The compact signature label.</returns>
    public static string FormatSymbol(Symbol symbol)
    {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature);
    }

    /// <summary>
    /// Renders a symbol's compact signature label, using <paramref name="compilation"/>
    /// to recover a variable's exact declaring keyword.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <param name="compilation">The compilation providing declaration syntax.</param>
    /// <returns>The compact signature label.</returns>
    public static string FormatSymbol(Symbol symbol, Compilation compilation)
    {
        return SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature, compilation);
    }

    private static HoverModel BuildHoverModel(Symbol symbol, Compilation compilation)
    {
        var signature = SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Hover, compilation);
        var overloadCount = symbol is FunctionSymbol function ? CountOverloads(compilation, function) : 1;
        return new HoverModel(signature, BuildDocumentation(symbol), overloadCount);
    }

    private static HoverModel BuildImportedClrModel(SyntaxTree tree, Compilation compilation, SyntaxToken token)
    {
        if (token == null || token.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var clrType = SemanticLookup.ResolveImportedClrType(tree, compilation, token.Text);
        if (clrType == null)
        {
            return null;
        }

        var signature = SymbolDisplay.ToDisplayString(clrType, SymbolDisplayFormat.Hover);
        var documentation = HoverDocumentationRenderer.Render(
            GSharp.Core.CodeAnalysis.Documentation.AssemblyDocumentationProvider.Resolve(clrType));
        return new HoverModel(signature, documentation, OverloadCount: 1);
    }

    private static string RenderHover(HoverModel model)
    {
        var sb = new StringBuilder();
        sb.Append("```gsharp\n").Append(model.Signature).Append("\n```");

        if (model.OverloadCount > 1)
        {
            var others = model.OverloadCount - 1;
            sb.Append("\n\n*(+ ").Append(others).Append(others == 1 ? " overload)*" : " overloads)*");
        }

        foreach (var section in model.Documentation)
        {
            sb.Append("\n\n");
            if (!string.IsNullOrEmpty(section.Heading))
            {
                sb.Append("**").Append(section.Heading).Append("**\n\n");
            }

            sb.Append(section.Body);
        }

        return sb.ToString();
    }

    private static int CountOverloads(Compilation compilation, FunctionSymbol function)
    {
        if (function.StaticOwnerType is StructSymbol staticOwner)
        {
            return staticOwner.StaticMethods.Count(m => m.Name == function.Name);
        }

        if (function.ReceiverType is StructSymbol owner)
        {
            return owner.Methods.Count(m => m.Name == function.Name);
        }

        return compilation.GlobalScope.Functions.Count(f => f.Name == function.Name);
    }

    // Surfaces ingested CLR documentation (ADR-0057 §6): imported symbols resolve their
    // companion .xml on demand via GetDocumentation(); authored G# docs (P2) flow through
    // the same path once attached. Symbols with no documentation render just the signature.
    private static IReadOnlyList<HoverDocSection> BuildDocumentation(Symbol symbol)
    {
        return HoverDocumentationRenderer.Render(symbol.GetDocumentation());
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }

    private sealed record HoverModel(string Signature, IReadOnlyList<HoverDocSection> Documentation, int OverloadCount);
}

/// <summary>A rendered hover documentation section: an optional bold heading and a Markdown body.</summary>
/// <param name="Heading">The section heading, or null for the lead (summary) section.</param>
/// <param name="Body">The Markdown body.</param>
internal sealed record HoverDocSection(string Heading, string Body);

public static class ReferencesComputer
{
    public static IReadOnlyList<Location> ComputeReferences(DocumentUri uri, DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (target == null)
        {
            return Array.Empty<Location>();
        }

        return SemanticLookup.FindReferences(compilation, target)
            .Where(t => includeDeclaration || !IsDeclaration(compilation, t, target))
            .Select(t => new Location { Uri = GetDocumentUri(t, uri), Range = SemanticLookup.ToRange(t) })
            .ToList();
    }

    public static IReadOnlyList<SyntaxToken> ComputeReferenceTokens(DocumentContent content, Position position, bool includeDeclaration)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
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

            var containingTree = compilation.SyntaxTrees.FirstOrDefault(t => t.Text == token.SyntaxTree?.Text) ?? compilation.SyntaxTrees[0];
            var parentDeclaration = FindSmallestContainingDeclaration(containingTree.Root, token);
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

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
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

public static class RenameComputer
{
    public static WorkspaceEdit ComputeRename(DocumentUri uri, DocumentContent content, Position position, string newName)
    {
        if (!SemanticLookup.IsValidIdentifier(newName))
        {
            return null;
        }

        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var target = SemanticLookup.ResolveSymbol(compilation, token);
        if (!SemanticLookup.CanRename(target))
        {
            return null;
        }

        var references = SemanticLookup.FindReferences(compilation, target).ToList();
        if (references.Count == 0)
        {
            return null;
        }

        // Group edits by document URI for cross-file rename support
        var editsByUri = new Dictionary<DocumentUri, List<TextEdit>>();
        foreach (var refToken in references)
        {
            var docUri = GetDocumentUri(refToken, uri);
            if (!editsByUri.TryGetValue(docUri, out var edits))
            {
                edits = new List<TextEdit>();
                editsByUri[docUri] = edits;
            }

            edits.Add(new TextEdit { Range = SemanticLookup.ToRange(refToken), NewText = newName });
        }

        return new WorkspaceEdit
        {
            Changes = editsByUri.ToDictionary(kv => kv.Key, kv => (IEnumerable<TextEdit>)kv.Value),
        };
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
    }
}

public static class CodeActionComputer
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

public static class DefinitionComputer
{
    public static Location ComputeDefinition(DocumentUri uri, DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);
        var token = SemanticLookup.FindTokenAt(content.SyntaxTree, offset);
        var symbol = SemanticLookup.ResolveSymbol(compilation, token);
        if (symbol == null)
        {
            return null;
        }

        var declarationToken = FindDeclarationToken(compilation, symbol);
        if (declarationToken == null)
        {
            return null;
        }

        var targetUri = GetDocumentUri(declarationToken, uri);
        return new Location { Uri = targetUri, Range = SemanticLookup.ToRange(declarationToken) };
    }

    private static DocumentUri GetDocumentUri(SyntaxToken token, DocumentUri fallback)
    {
        if (!string.IsNullOrEmpty(token.SyntaxTree?.Text?.FileName))
        {
            return DocumentUri.FromFileSystemPath(token.SyntaxTree.Text.FileName);
        }

        return fallback;
    }

    private static SyntaxToken FindDeclarationToken(Compilation compilation, Symbol symbol)
    {
        return symbol switch
        {
            FunctionSymbol f when f.Declaration != null => f.Declaration.Identifier,
            StructSymbol s when s.Declaration != null => s.Declaration.Identifier,
            EnumSymbol e when e.Declaration != null => e.Declaration.Identifier,
            EnumMemberSymbol m => FindEnumMemberToken(m),
            FieldSymbol field => FindFieldToken(compilation, field),
            VariableSymbol variable => FindVariableToken(compilation, variable),
            _ => null,
        };
    }

    private static SyntaxToken FindEnumMemberToken(EnumMemberSymbol member)
    {
        if (member.EnumType?.Declaration == null)
        {
            return null;
        }

        return member.EnumType.Declaration.Members
            .Select(m => m.Identifier)
            .FirstOrDefault(id => id.Text == member.Name);
    }

    private static SyntaxToken FindFieldToken(Compilation compilation, FieldSymbol field)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var structDecl in FindNodes<StructDeclarationSyntax>(tree.Root))
            {
                foreach (var fieldDecl in structDecl.Fields)
                {
                    if (fieldDecl.Identifier.Text == field.Name)
                    {
                        return fieldDecl.Identifier;
                    }
                }
            }
        }

        return null;
    }

    private static SyntaxToken FindVariableToken(Compilation compilation, VariableSymbol variable)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var varDecl in FindNodes<VariableDeclarationSyntax>(tree.Root))
            {
                if (varDecl.Identifier.Text == variable.Name)
                {
                    return varDecl.Identifier;
                }
            }

            foreach (var funcDecl in FindNodes<FunctionDeclarationSyntax>(tree.Root))
            {
                foreach (var param in funcDecl.Parameters)
                {
                    if (param.Identifier.Text == variable.Name)
                    {
                        return param.Identifier;
                    }
                }
            }
        }

        return null;
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

public static class DocumentSymbolComputer
{
    public static IReadOnlyList<SymbolInformationOrDocumentSymbol> ComputeDocumentSymbols(DocumentContent content)
    {
        var result = new List<SymbolInformationOrDocumentSymbol>();
        var text = content.SyntaxTree.Text;

        foreach (var member in content.SyntaxTree.Root.Members)
        {
            switch (member)
            {
                case FunctionDeclarationSyntax func:
                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = func.Identifier.Text,
                        Kind = LspSymbolKind.Function,
                        Range = SemanticLookup.ToRange(text, func.Span),
                        SelectionRange = SemanticLookup.ToRange(func.Identifier),
                    }));
                    break;
                case GlobalStatementSyntax { Statement: VariableDeclarationSyntax variable }:
                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = variable.Identifier.Text,
                        Kind = LspSymbolKind.Variable,
                        Range = SemanticLookup.ToRange(text, variable.Span),
                        SelectionRange = SemanticLookup.ToRange(variable.Identifier),
                    }));
                    break;
                case StructDeclarationSyntax structDecl:
                    var children = new List<DocumentSymbol>();
                    foreach (var field in structDecl.Fields)
                    {
                        children.Add(new DocumentSymbol
                        {
                            Name = field.Identifier.Text,
                            Kind = LspSymbolKind.Field,
                            Range = SemanticLookup.ToRange(text, field.Span),
                            SelectionRange = SemanticLookup.ToRange(field.Identifier),
                        });
                    }

                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = structDecl.Identifier.Text,
                        Kind = LspSymbolKind.Struct,
                        Range = SemanticLookup.ToRange(text, structDecl.Span),
                        SelectionRange = SemanticLookup.ToRange(structDecl.Identifier),
                        Children = children,
                    }));
                    break;
                case EnumDeclarationSyntax enumDecl:
                    var enumChildren = new List<DocumentSymbol>();
                    foreach (var enumMember in enumDecl.Members)
                    {
                        enumChildren.Add(new DocumentSymbol
                        {
                            Name = enumMember.Identifier.Text,
                            Kind = LspSymbolKind.EnumMember,
                            Range = SemanticLookup.ToRange(text, enumMember.Span),
                            SelectionRange = SemanticLookup.ToRange(enumMember.Identifier),
                        });
                    }

                    result.Add(new SymbolInformationOrDocumentSymbol(new DocumentSymbol
                    {
                        Name = enumDecl.Identifier.Text,
                        Kind = LspSymbolKind.Enum,
                        Range = SemanticLookup.ToRange(text, enumDecl.Span),
                        SelectionRange = SemanticLookup.ToRange(enumDecl.Identifier),
                        Children = enumChildren,
                    }));
                    break;
            }
        }

        return result;
    }
}

public static class SignatureHelpComputer
{
    public static SignatureHelp ComputeSignatureHelp(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);

        // Walk backwards from cursor to find the function name token before the opening paren
        var source = content.SyntaxTree.Text.ToString();
        var parenDepth = 0;
        var activeParameter = 0;
        int? funcNameEnd = null;

        for (var i = offset - 1; i >= 0; i--)
        {
            var c = source[i];
            if (c == ')')
            {
                parenDepth++;
            }
            else if (c == '(')
            {
                if (parenDepth > 0)
                {
                    parenDepth--;
                }
                else
                {
                    funcNameEnd = i;
                    break;
                }
            }
            else if (c == ',' && parenDepth == 0)
            {
                activeParameter++;
            }
        }

        if (funcNameEnd == null)
        {
            return null;
        }

        // Find the identifier token just before the paren
        var funcToken = SemanticLookup.FindTokenAt(content.SyntaxTree, funcNameEnd.Value - 1);
        var symbol = SemanticLookup.ResolveSymbol(compilation, funcToken);
        if (symbol is not FunctionSymbol function)
        {
            return null;
        }

        var parameters = function.Parameters
            .Select(p => new ParameterInformation
            {
                Label = $"{p.Name} {FormatType(p.Type)}",
            })
            .ToList();

        var signature = new SignatureInformation
        {
            Label = HoverComputer.FormatSymbol(function),
            Parameters = parameters,
        };

        return new SignatureHelp
        {
            Signatures = new[] { signature },
            ActiveSignature = 0,
            ActiveParameter = Math.Min(activeParameter, Math.Max(0, parameters.Count - 1)),
        };
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }
}

public static class CompletionComputer
{
    public static IReadOnlyList<CompletionItem> ComputeCompletions(DocumentContent content, Position position)
    {
        var compilation = content.Project?.GetCompilation() ?? new Compilation(content.SyntaxTree);
        var offset = SemanticLookup.ToOffset(content, position);

        // Member-access context (`receiver.<caret>`): offer the receiver's members
        // instead of the global keyword/symbol list. Returns null only when the
        // caret is not positioned after a member-access dot.
        var memberItems = TryComputeMemberCompletions(content, compilation, offset);
        if (memberItems != null)
        {
            return memberItems;
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // Add keywords
        foreach (var keyword in GetKeywords())
        {
            if (seen.Add(keyword))
            {
                items.Add(new CompletionItem
                {
                    Label = keyword,
                    Kind = CompletionItemKind.Keyword,
                });
            }
        }

        // Add global symbols (functions, variables, types)
        foreach (var function in compilation.GlobalScope.Functions)
        {
            if (seen.Add(function.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = function.Name,
                    Kind = CompletionItemKind.Function,
                    Detail = HoverComputer.FormatSymbol(function),
                });
            }
        }

        foreach (var variable in compilation.GlobalScope.Variables)
        {
            if (seen.Add(variable.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = variable.Name,
                    Kind = CompletionItemKind.Variable,
                    Detail = HoverComputer.FormatSymbol(variable),
                });
            }
        }

        foreach (var structSymbol in compilation.GlobalScope.Structs)
        {
            if (seen.Add(structSymbol.Name))
            {
                items.Add(new CompletionItem
                {
                    Label = structSymbol.Name,
                    Kind = CompletionItemKind.Struct,
                    Detail = HoverComputer.FormatSymbol(structSymbol),
                });
            }
        }

        foreach (var pair in compilation.GlobalScope.TypeAliases)
        {
            if (seen.Add(pair.Key))
            {
                items.Add(new CompletionItem
                {
                    Label = pair.Key,
                    Kind = pair.Value is EnumSymbol ? CompletionItemKind.Enum : CompletionItemKind.Class,
                    Detail = HoverComputer.FormatSymbol(pair.Value),
                });
            }
        }

        // Add local symbols from the containing function
        var containingFunction = FindContainingFunction(content.SyntaxTree, offset);
        if (containingFunction != null)
        {
            foreach (var param in containingFunction.Parameters)
            {
                if (seen.Add(param.Identifier.Text))
                {
                    items.Add(new CompletionItem
                    {
                        Label = param.Identifier.Text,
                        Kind = CompletionItemKind.Variable,
                    });
                }
            }
        }

        // Add primitive types
        foreach (var type in new[] { "bool", "int32", "string", "void" })
        {
            if (seen.Add(type))
            {
                items.Add(new CompletionItem
                {
                    Label = type,
                    Kind = CompletionItemKind.TypeParameter,
                });
            }
        }

        return items;
    }

    private static FunctionDeclarationSyntax FindContainingFunction(SyntaxTree tree, int offset)
    {
        FunctionDeclarationSyntax best = null;
        foreach (var func in tree.Root.Members.OfType<FunctionDeclarationSyntax>())
        {
            if (func.Span.Start <= offset && offset <= func.Span.End)
            {
                if (best == null || func.Span.Length < best.Span.Length)
                {
                    best = func;
                }
            }
        }

        return best;
    }

    private static IReadOnlyList<CompletionItem> TryComputeMemberCompletions(DocumentContent content, Compilation compilation, int offset)
    {
        var accessor = FindReceiverAccessor(content.SyntaxTree.Root, offset);
        if (accessor == null)
        {
            // Not a member-access context — caller falls back to the global list.
            return null;
        }

        var items = new List<CompletionItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        var chainRoot = FindChainRoot(content.SyntaxTree.Root, accessor);
        var isSimpleNameReceiver = ReferenceEquals(chainRoot, accessor)
            && accessor.LeftPart is NameExpressionSyntax simpleName
            && !simpleName.IdentifierToken.IsMissing;

        if (!isSimpleNameReceiver)
        {
            // Complex or chained receivers — `(a + b).`, `foo().`, `arr[0].`,
            // `a.b.`, etc. Reconstruct the full receiver expression (chains parse
            // right-nested, so the trailing accessor's LeftPart is only the last
            // segment) and speculatively bind it to infer the member type.
            var receiverExpression = ReconstructReceiverExpression(content, chainRoot, accessor);
            if (receiverExpression != null)
            {
                var (function, locals) = SemanticLookup.GetExpressionBindingContext(compilation, offset);
                var receiverType = GSharp.Core.CodeAnalysis.Binding.Binder.TryInferExpressionType(
                    compilation.GlobalScope,
                    compilation.References,
                    function,
                    locals,
                    receiverExpression);
                if (receiverType != null)
                {
                    AddInstanceTypeMembers(items, seen, receiverType);
                }
            }

            // Whether or not inference succeeded, suppress the global keyword list
            // since the caret sits in a member-access position.
            return items;
        }

        var leftName = (NameExpressionSyntax)accessor.LeftPart;
        var receiver = SemanticLookup.ResolveSymbol(compilation, leftName.IdentifierToken);
        switch (receiver)
        {
            case VariableSymbol variable:
                AddInstanceTypeMembers(items, seen, variable.Type);
                break;
            case EnumSymbol enumSymbol:
                AddEnumMembers(items, seen, enumSymbol);
                break;
            case StructSymbol structType:
                AddStructStaticMembers(items, seen, structType);
                break;
            case TypeSymbol typeSymbol:
                AddClrMembers(items, seen, typeSymbol.ClrType, staticMembers: true);
                break;
            case null:
                // An imported CLR type referenced by name (e.g. `Console`).
                AddClrMembers(items, seen, SemanticLookup.ResolveImportedClrType(content.SyntaxTree, compilation, leftName.IdentifierToken.Text), staticMembers: true);
                break;
        }

        return items;
    }

    /// <summary>
    /// Finds the outermost postfix expression (member access or index) that ends
    /// at the same position as <paramref name="accessor"/> — i.e. the root of the
    /// receiver chain. Member-access chains parse right-nested, so the trailing
    /// dot's accessor covers only the final segment; the chain root spans the whole
    /// receiver.
    /// </summary>
    private static ExpressionSyntax FindChainRoot(SyntaxNode root, AccessorExpressionSyntax accessor)
    {
        ExpressionSyntax best = accessor;
        foreach (var node in EnumerateNodes(root))
        {
            if (node is not (AccessorExpressionSyntax or IndexExpressionSyntax))
            {
                continue;
            }

            var candidate = (ExpressionSyntax)node;
            if (candidate.Span.End == accessor.Span.End
                && candidate.Span.Start <= best.Span.Start
                && candidate.Span.Start <= accessor.Span.Start)
            {
                best = candidate;
            }
        }

        return best;
    }

    /// <summary>
    /// Reconstructs the receiver expression to the left of the trailing dot. When
    /// the receiver is the accessor's own (non-chained) left part it is returned
    /// directly; for chained receivers the source text between the chain root and
    /// the trailing dot is re-parsed into a standalone expression.
    /// </summary>
    private static ExpressionSyntax ReconstructReceiverExpression(DocumentContent content, ExpressionSyntax chainRoot, AccessorExpressionSyntax accessor)
    {
        if (ReferenceEquals(chainRoot, accessor))
        {
            return accessor.LeftPart;
        }

        var dotStart = accessor.DotToken.Span.Start;
        var start = chainRoot.Span.Start;
        if (dotStart <= start)
        {
            return null;
        }

        var text = content.SyntaxTree.Text.ToString(start, dotStart - start);
        var tree = SyntaxTree.Parse(text);
        return EnumerateNodes(tree.Root).OfType<ExpressionSyntax>().FirstOrDefault();
    }

    private static IEnumerable<SyntaxNode> EnumerateNodes(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is SyntaxToken)
            {
                continue;
            }

            foreach (var descendant in EnumerateNodes(child))
            {
                yield return descendant;
            }
        }
    }

    private static AccessorExpressionSyntax FindReceiverAccessor(SyntaxNode node, int offset)
    {
        AccessorExpressionSyntax best = null;
        foreach (var accessor in FindAccessors(node))
        {
            var dot = accessor.DotToken;
            if (dot == null || dot.IsMissing)
            {
                continue;
            }

            // Caret must sit after the dot and within the accessor expression.
            if (dot.Span.End <= offset && offset <= accessor.Span.End)
            {
                if (best == null || dot.Span.End > best.DotToken.Span.End)
                {
                    best = accessor;
                }
            }
        }

        return best;
    }

    private static IEnumerable<AccessorExpressionSyntax> FindAccessors(SyntaxNode node)
    {
        if (node is AccessorExpressionSyntax accessor)
        {
            yield return accessor;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in FindAccessors(child))
            {
                yield return descendant;
            }
        }
    }

    private static void AddInstanceTypeMembers(List<CompletionItem> items, HashSet<string> seen, TypeSymbol type)
    {
        if (type is StructSymbol structType)
        {
            AddStructInstanceMembers(items, seen, structType);
            return;
        }

        AddClrMembers(items, seen, type?.ClrType, staticMembers: false);
    }

    private static void AddStructInstanceMembers(List<CompletionItem> items, HashSet<string> seen, StructSymbol structType)
    {
        for (var current = structType; current != null; current = current.BaseClass)
        {
            foreach (var field in current.Fields)
            {
                AddItem(items, seen, field.Name, CompletionItemKind.Field, HoverComputer.FormatSymbol(field));
            }

            foreach (var property in current.Properties)
            {
                AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.Type?.Name}");
            }

            foreach (var method in current.Methods)
            {
                AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method));
            }
        }
    }

    private static void AddStructStaticMembers(List<CompletionItem> items, HashSet<string> seen, StructSymbol structType)
    {
        foreach (var field in structType.StaticFields)
        {
            AddItem(items, seen, field.Name, CompletionItemKind.Field, HoverComputer.FormatSymbol(field));
        }

        foreach (var property in structType.StaticProperties)
        {
            AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.Type?.Name}");
        }

        foreach (var method in structType.StaticMethods)
        {
            AddItem(items, seen, method.Name, CompletionItemKind.Method, HoverComputer.FormatSymbol(method));
        }
    }

    private static void AddEnumMembers(List<CompletionItem> items, HashSet<string> seen, EnumSymbol enumSymbol)
    {
        foreach (var member in enumSymbol.Members)
        {
            AddItem(items, seen, member.Name, CompletionItemKind.EnumMember, $"{enumSymbol.Name}.{member.Name}");
        }
    }

    private static void AddClrMembers(List<CompletionItem> items, HashSet<string> seen, Type clrType, bool staticMembers)
    {
        if (clrType == null)
        {
            return;
        }

        var flags = BindingFlags.Public | (staticMembers ? BindingFlags.Static : BindingFlags.Instance);

        foreach (var property in ClrTypeUtilities.SafeGetProperties(clrType, flags))
        {
            if (property.GetIndexParameters().Length == 0)
            {
                AddItem(items, seen, property.Name, CompletionItemKind.Property, $"{property.Name}: {property.PropertyType.Name}");
            }
        }

        foreach (var field in ClrTypeUtilities.SafeGetFields(clrType, flags))
        {
            var kind = field.IsLiteral ? CompletionItemKind.Constant : CompletionItemKind.Field;
            AddItem(items, seen, field.Name, kind, $"{field.Name}: {field.FieldType.Name}");
        }

        foreach (var method in ClrTypeUtilities.SafeGetMethods(clrType, flags))
        {
            if (method.IsSpecialName)
            {
                continue;
            }

            AddItem(items, seen, method.Name, CompletionItemKind.Method, $"{method.Name}(...): {method.ReturnType.Name}");
        }

        foreach (var evt in ClrTypeUtilities.SafeGetEvents(clrType, flags))
        {
            AddItem(items, seen, evt.Name, CompletionItemKind.Event, evt.Name);
        }
    }

    private static void AddItem(List<CompletionItem> items, HashSet<string> seen, string label, CompletionItemKind kind, string detail)
    {
        if (string.IsNullOrEmpty(label) || !seen.Add(label))
        {
            return;
        }

        items.Add(new CompletionItem { Label = label, Kind = kind, Detail = detail });
    }

    private static IEnumerable<string> GetKeywords()
    {
        yield return "let";
        yield return "func";
        yield return "if";
        yield return "else";
        yield return "while";
        yield return "for";
        yield return "in";
        yield return "return";
        yield return "break";
        yield return "continue";
        yield return "true";
        yield return "false";
        yield return "type";
        yield return "struct";
        yield return "class";
        yield return "enum";
        yield return "import";
        yield return "switch";
        yield return "case";
        yield return "default";
        yield return "go";
        yield return "select";
        yield return "try";
        yield return "catch";
        yield return "throw";
        yield return "async";
        yield return "await";
    }
}
