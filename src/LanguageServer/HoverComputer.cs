// <copyright file="LspFeatureComputers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using OmniSharp.Extensions.LanguageServer.Protocol;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using LspSymbolKind = OmniSharp.Extensions.LanguageServer.Protocol.Models.SymbolKind;
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

internal static class DefinitionComputer
{
    public static Location ComputeDefinition(DocumentUri uri, DocumentContent content, Position position)
    {
        var compilation = new Compilation(content.SyntaxTree);
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

        return new Location { Uri = uri, Range = SemanticLookup.ToRange(declarationToken) };
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

internal static class DocumentSymbolComputer
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
                        Children = new Container<DocumentSymbol>(children),
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
                        Children = new Container<DocumentSymbol>(enumChildren),
                    }));
                    break;
            }
        }

        return result;
    }
}

internal static class SignatureHelpComputer
{
    public static SignatureHelp ComputeSignatureHelp(DocumentContent content, Position position)
    {
        var compilation = new Compilation(content.SyntaxTree);
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
                Label = new ParameterInformationLabel($"{p.Name} {FormatType(p.Type)}"),
            })
            .ToList();

        var signature = new SignatureInformation
        {
            Label = HoverComputer.FormatSymbol(function),
            Parameters = new Container<ParameterInformation>(parameters),
        };

        return new SignatureHelp
        {
            Signatures = new Container<SignatureInformation>(signature),
            ActiveSignature = 0,
            ActiveParameter = Math.Min(activeParameter, Math.Max(0, parameters.Count - 1)),
        };
    }

    private static string FormatType(TypeSymbol type)
    {
        return type?.Name ?? "void";
    }
}

internal static class CompletionComputer
{
    public static IReadOnlyList<CompletionItem> ComputeCompletions(DocumentContent content, Position position)
    {
        var compilation = new Compilation(content.SyntaxTree);
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
        var offset = SemanticLookup.ToOffset(content, position);
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
