// <copyright file="SemanticLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.LanguageServer;

internal static class SemanticLookup
{
    public static SyntaxToken FindTokenAt(SyntaxTree tree, int position)
    {
        SyntaxToken best = null;
        foreach (var token in EnumerateTokens(tree.Root))
        {
            if (token.IsMissing)
            {
                continue;
            }

            if (token.Span.Start <= position && position <= token.Span.End)
            {
                if (best == null || token.Span.Length <= best.Span.Length)
                {
                    best = token;
                }
            }
        }

        return best;
    }

    public static Symbol ResolveSymbol(Compilation compilation, SyntaxToken identifierToken)
    {
        if (identifierToken == null || identifierToken.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var model = BuildModel(compilation);
        return model.Resolve(identifierToken);
    }

    public static IEnumerable<SyntaxToken> FindReferences(Compilation compilation, Symbol target)
    {
        if (target == null)
        {
            yield break;
        }

        var model = BuildModel(compilation);
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var token in EnumerateTokens(tree.Root))
            {
                if (token.Kind == SyntaxKind.IdentifierToken && ReferenceEquals(model.Resolve(token), target))
                {
                    yield return token;
                }
            }
        }
    }

    public static bool IsValidIdentifier(string text)
    {
        if (string.IsNullOrEmpty(text) || SyntaxFacts.GetKeywordKind(text) != SyntaxKind.IdentifierToken)
        {
            return false;
        }

        if (!IsIdentifierStart(text[0]))
        {
            return false;
        }

        for (var i = 1; i < text.Length; i++)
        {
            if (!IsIdentifierPart(text[i]))
            {
                return false;
            }
        }

        return true;
    }

    public static bool CanRename(Symbol symbol)
    {
        return symbol is not null and not ImportedTypeSymbol and not ImportedClassSymbol and not ImportedFunctionSymbol
            && !ReferenceEquals(symbol, TypeSymbol.Bool)
            && !ReferenceEquals(symbol, TypeSymbol.Int32)
            && !ReferenceEquals(symbol, TypeSymbol.String)
            && !ReferenceEquals(symbol, TypeSymbol.Void)
            && !ReferenceEquals(symbol, TypeSymbol.Null);
    }

    public static IEnumerable<SyntaxToken> EnumerateIdentifierTokens(SyntaxTree tree)
    {
        return EnumerateTokens(tree.Root).Where(t => t.Kind == SyntaxKind.IdentifierToken);
    }

    public static int ToOffset(DocumentContent content, OmniSharp.Extensions.LanguageServer.Protocol.Models.Position position)
    {
        if (position.Line < 0 || position.Line >= content.SyntaxTree.Text.Lines.Length)
        {
            return content.SyntaxTree.Text.Length;
        }

        return Math.Min(content.SyntaxTree.Text.Lines[position.Line].Start + position.Character, content.SyntaxTree.Text.Length);
    }

    public static OmniSharp.Extensions.LanguageServer.Protocol.Models.Range ToRange(SyntaxToken token)
    {
        return ToRange(token.SyntaxTree.Text, token.Span);
    }

    public static OmniSharp.Extensions.LanguageServer.Protocol.Models.Range ToRange(SourceText text, TextSpan span)
    {
        var startLine = text.GetLineIndex(span.Start);
        var endPosition = Math.Max(span.Start, span.End);
        var endLine = text.GetLineIndex(Math.Min(endPosition, Math.Max(0, text.Length - 1)));
        if (span.End == text.Length && text.Length > 0 && text[text.Length - 1] == '\n')
        {
            endLine = text.Lines.Length - 1;
        }

        return new OmniSharp.Extensions.LanguageServer.Protocol.Models.Range(
            new OmniSharp.Extensions.LanguageServer.Protocol.Models.Position(startLine, span.Start - text.Lines[startLine].Start),
            new OmniSharp.Extensions.LanguageServer.Protocol.Models.Position(endLine, span.End - text.Lines[endLine].Start));
    }

    private static SemanticModel BuildModel(Compilation compilation)
    {
        var declarations = new Dictionary<SyntaxToken, Symbol>();
        var globals = new Dictionary<string, Symbol>(StringComparer.Ordinal);
        var localDeclarations = new Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>>();

        foreach (var variable in compilation.GlobalScope.Variables)
        {
            globals[variable.Name] = variable;
        }

        foreach (var function in compilation.GlobalScope.Functions)
        {
            globals[function.Name] = function;
            if (function.Declaration != null)
            {
                declarations[function.Declaration.Identifier] = function;
                MapParameters(function.Declaration, function.Parameters, declarations, localDeclarations);
                if (function.ExplicitReceiverParameter != null && function.Declaration.Receiver != null)
                {
                    declarations[function.Declaration.Receiver.Identifier] = function.ExplicitReceiverParameter;
                    GetLocals(localDeclarations, function.Declaration)[function.ExplicitReceiverParameter.Name] = function.ExplicitReceiverParameter;
                }
            }
        }

        foreach (var variable in compilation.GlobalScope.Variables)
        {
            foreach (var declaration in FindNodes<VariableDeclarationSyntax>(compilation.SyntaxTrees.Select(t => t.Root)).Where(v => v.Identifier.Text == variable.Name))
            {
                declarations[declaration.Identifier] = variable;
            }
        }

        foreach (var aggregate in compilation.GlobalScope.Structs)
        {
            globals[aggregate.Name] = aggregate;
            if (aggregate.Declaration != null)
            {
                declarations[aggregate.Declaration.Identifier] = aggregate;
                for (var i = 0; i < aggregate.Declaration.Fields.Length && i < aggregate.Fields.Length; i++)
                {
                    declarations[aggregate.Declaration.Fields[i].Identifier] = aggregate.Fields[i];
                }
            }
        }

        foreach (var pair in compilation.GlobalScope.TypeAliases)
        {
            globals[pair.Key] = pair.Value;
            if (pair.Value is EnumSymbol enumSymbol)
            {
                declarations[enumSymbol.Declaration.Identifier] = enumSymbol;
                var members = enumSymbol.Declaration.Members.ToArray();
                for (var i = 0; i < members.Length && i < enumSymbol.Members.Length; i++)
                {
                    declarations[members[i].Identifier] = enumSymbol.Members[i];
                    globals[members[i].Identifier.Text] = enumSymbol.Members[i];
                }
            }
        }

        MapLocalVariables(compilation, declarations, localDeclarations);
        return new SemanticModel(compilation, declarations, globals, localDeclarations);
    }

    private static void MapParameters(
        FunctionDeclarationSyntax declaration,
        ImmutableArray<ParameterSymbol> parameters,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> localDeclarations)
    {
        var syntaxParameters = declaration.Parameters.ToArray();
        var symbolIndex = parameters.Length - syntaxParameters.Length;
        for (var i = 0; i < syntaxParameters.Length && symbolIndex + i < parameters.Length; i++)
        {
            var symbol = parameters[symbolIndex + i];
            declarations[syntaxParameters[i].Identifier] = symbol;
            GetLocals(localDeclarations, declaration)[symbol.Name] = symbol;
        }
    }

    private static void MapLocalVariables(
        Compilation compilation,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> localDeclarations)
    {
        BoundProgram program;
        try
        {
            program = Binder.BindProgram(compilation.GlobalScope);
        }
        catch (InvalidOperationException)
        {
            return;
        }

        foreach (var pair in program.Functions)
        {
            var declaration = pair.Key.Declaration;
            if (declaration == null)
            {
                continue;
            }

            var syntaxDeclarations = FindNodes<VariableDeclarationSyntax>(new[] { declaration.Body }).ToList();
            var boundDeclarations = FindBoundNodes<BoundVariableDeclaration>(pair.Value).Where(d => !d.Variable.Name.StartsWith("<", StringComparison.Ordinal)).ToList();
            var used = new HashSet<int>();
            foreach (var syntax in syntaxDeclarations)
            {
                for (var i = 0; i < boundDeclarations.Count; i++)
                {
                    if (used.Contains(i) || boundDeclarations[i].Variable.Name != syntax.Identifier.Text)
                    {
                        continue;
                    }

                    used.Add(i);
                    declarations[syntax.Identifier] = boundDeclarations[i].Variable;
                    GetLocals(localDeclarations, declaration)[boundDeclarations[i].Variable.Name] = boundDeclarations[i].Variable;
                    break;
                }
            }
        }
    }

    private static Dictionary<string, Symbol> GetLocals(
        Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> locals,
        FunctionDeclarationSyntax declaration)
    {
        if (!locals.TryGetValue(declaration, out var functionLocals))
        {
            functionLocals = new Dictionary<string, Symbol>(StringComparer.Ordinal);
            locals[declaration] = functionLocals;
        }

        return functionLocals;
    }

    private static IEnumerable<SyntaxToken> EnumerateTokens(SyntaxNode node)
    {
        if (node is SyntaxToken token)
        {
            yield return token;
            yield break;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var childToken in EnumerateTokens(child))
            {
                yield return childToken;
            }
        }
    }

    private static IEnumerable<T> FindNodes<T>(IEnumerable<SyntaxNode> roots)
        where T : SyntaxNode
    {
        foreach (var root in roots)
        {
            foreach (var node in FindNodes<T>(root))
            {
                yield return node;
            }
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

    private static IEnumerable<T> FindBoundNodes<T>(BoundNode root)
        where T : BoundNode
    {
        if (root is T matched)
        {
            yield return matched;
        }

        foreach (var property in root.GetType().GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            var value = property.GetValue(root);
            if (value is BoundNode child)
            {
                foreach (var descendant in FindBoundNodes<T>(child))
                {
                    yield return descendant;
                }
            }
            else if (value is System.Collections.IEnumerable sequence and not string)
            {
                foreach (var item in sequence)
                {
                    if (item is BoundNode sequenceChild)
                    {
                        foreach (var descendant in FindBoundNodes<T>(sequenceChild))
                        {
                            yield return descendant;
                        }
                    }
                }
            }
        }
    }

    private static bool IsIdentifierStart(char c)
    {
        return c == '_' || char.IsLetter(c);
    }

    private static bool IsIdentifierPart(char c)
    {
        return c == '_' || char.IsLetterOrDigit(c);
    }

    private sealed class SemanticModel
    {
        private readonly Compilation compilation;
        private readonly Dictionary<SyntaxToken, Symbol> declarations;
        private readonly Dictionary<string, Symbol> globals;
        private readonly Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> localDeclarations;

        public SemanticModel(
            Compilation compilation,
            Dictionary<SyntaxToken, Symbol> declarations,
            Dictionary<string, Symbol> globals,
            Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> localDeclarations)
        {
            this.compilation = compilation;
            this.declarations = declarations;
            this.globals = globals;
            this.localDeclarations = localDeclarations;
        }

        public Symbol Resolve(SyntaxToken token)
        {
            if (this.declarations.TryGetValue(token, out var declared))
            {
                return declared;
            }

            var function = this.FindContainingFunction(token);
            if (function != null && this.localDeclarations.TryGetValue(function, out var locals) && locals.TryGetValue(token.Text, out var local))
            {
                return local;
            }

            return this.globals.TryGetValue(token.Text, out var global) ? global : ResolvePrimitiveOrImportedType(token.Text);
        }

        private FunctionDeclarationSyntax FindContainingFunction(SyntaxToken token)
        {
            return FindNodes<FunctionDeclarationSyntax>(this.compilation.SyntaxTrees.Select(t => t.Root))
                .Where(f => f.Span.Start <= token.Span.Start && token.Span.End <= f.Span.End)
                .OrderBy(f => f.Span.Length)
                .FirstOrDefault();
        }

        private Symbol ResolvePrimitiveOrImportedType(string text)
        {
            return text switch
            {
                "bool" => TypeSymbol.Bool,
                "int32" => TypeSymbol.Int32,
                "string" => TypeSymbol.String,
                "void" => TypeSymbol.Void,
                _ => null,
            };
        }
    }
}
