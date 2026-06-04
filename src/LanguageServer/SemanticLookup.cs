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

public static class SemanticLookup
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
                if (best == null)
                {
                    best = token;
                    continue;
                }

                // At a boundary the position is both the end of one token and the
                // start of the next. Editors bind the caret to the token that starts
                // there (right-biased, like Roslyn's FindToken), so prefer it; only
                // then fall back to the smallest enclosing token.
                var tokenStartsHere = token.Span.Start == position;
                var bestStartsHere = best.Span.Start == position;
                if (tokenStartsHere && !bestStartsHere)
                {
                    best = token;
                }
                else if (tokenStartsHere == bestStartsHere && token.Span.Length < best.Span.Length)
                {
                    best = token;
                }
            }
        }

        return best;
    }

    public static Symbol ResolveSymbol(Compilation compilation, SyntaxToken identifierToken)
    {
        if (identifierToken == null || identifierToken.IsMissing || identifierToken.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var model = BuildModel(compilation);
        return model.Resolve(identifierToken);
    }

    /// <summary>
    /// Computes the binding context for an expression at <paramref name="offset"/>:
    /// the enclosing function (or <c>null</c> at top level) and the
    /// locals/parameters in scope there. Used to speculatively infer receiver
    /// types for member completions on arbitrary expressions.
    /// </summary>
    /// <param name="compilation">The compilation to inspect.</param>
    /// <param name="offset">The source offset of the expression.</param>
    /// <returns>The enclosing function symbol and the in-scope local symbols.</returns>
    public static (FunctionSymbol Function, IReadOnlyList<VariableSymbol> Locals) GetExpressionBindingContext(Compilation compilation, int offset)
    {
        var funcDecl = FindNodes<FunctionDeclarationSyntax>(compilation.SyntaxTrees.Select(t => t.Root))
            .Where(f => f.Span.Start <= offset && offset <= f.Span.End)
            .OrderBy(f => f.Span.Length)
            .FirstOrDefault();

        if (funcDecl == null)
        {
            // Top-level statements: globals are reachable through the parent scope.
            return (null, Array.Empty<VariableSymbol>());
        }

        var function = FindFunctionSymbol(compilation, funcDecl);
        var locals = BuildModel(compilation).GetLocals(funcDecl);
        return (function, locals);
    }

    /// <summary>
    /// Resolves a bare type name (e.g. <c>Console</c>) to a CLR <see cref="Type"/>
    /// reachable through the document's <c>import</c> declarations, the implicit
    /// <c>System</c> namespace, or a fully-qualified name.
    /// </summary>
    /// <param name="tree">The syntax tree providing import context.</param>
    /// <param name="compilation">The compilation supplying the reference resolver.</param>
    /// <param name="name">The simple or aliased type name to resolve.</param>
    /// <returns>The resolved CLR type, or <c>null</c> when no match is found.</returns>
    public static Type ResolveImportedClrType(SyntaxTree tree, Compilation compilation, string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        var resolver = compilation.References ?? ReferenceResolver.Default();
        foreach (var candidate in GetCandidateTypeNames(tree, name))
        {
            if (resolver.TryResolveType(candidate, out var type))
            {
                return type;
            }
        }

        return null;
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
                if (token.IsMissing)
                {
                    continue;
                }

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

    public static int ToOffset(DocumentContent content, GSharp.LanguageServer.Protocol.Position position)
    {
        if (position.Line < 0 || position.Line >= content.SyntaxTree.Text.Lines.Length)
        {
            return content.SyntaxTree.Text.Length;
        }

        return Math.Min(content.SyntaxTree.Text.Lines[position.Line].Start + position.Character, content.SyntaxTree.Text.Length);
    }

    public static GSharp.LanguageServer.Protocol.Range ToRange(SyntaxToken token)
    {
        return ToRange(token.SyntaxTree.Text, token.Span);
    }

    public static GSharp.LanguageServer.Protocol.Range ToRange(SourceText text, TextSpan span)
    {
        var startLine = text.GetLineIndex(span.Start);
        var endPosition = Math.Max(span.Start, span.End);
        var endLine = text.GetLineIndex(Math.Min(endPosition, Math.Max(0, text.Length - 1)));
        if (span.End == text.Length && text.Length > 0 && text[text.Length - 1] == '\n')
        {
            endLine = text.Lines.Length - 1;
        }

        return new GSharp.LanguageServer.Protocol.Range(
            new GSharp.LanguageServer.Protocol.Position(startLine, span.Start - text.Lines[startLine].Start),
            new GSharp.LanguageServer.Protocol.Position(endLine, span.End - text.Lines[endLine].Start));
    }

    private static FunctionSymbol FindFunctionSymbol(Compilation compilation, FunctionDeclarationSyntax declaration)
    {
        foreach (var function in compilation.GlobalScope.Functions)
        {
            if (ReferenceEquals(function.Declaration, declaration))
            {
                return function;
            }
        }

        foreach (var structSym in compilation.GlobalScope.Structs)
        {
            foreach (var method in structSym.Methods)
            {
                if (ReferenceEquals(method.Declaration, declaration))
                {
                    return method;
                }
            }

            foreach (var method in structSym.StaticMethods)
            {
                if (ReferenceEquals(method.Declaration, declaration))
                {
                    return method;
                }
            }
        }

        return null;
    }

    private static IEnumerable<string> GetCandidateTypeNames(SyntaxTree tree, string name)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var import in tree.Root.Members.OfType<ImportSyntax>())
        {
            // `import alias = System.Console` makes `alias` refer to the dotted path.
            if (import.AliasIdentifier != null && import.AliasIdentifier.Text == name)
            {
                var aliased = string.Join(".", import.Identifiers.Select(i => i.Text));
                if (!string.IsNullOrEmpty(aliased) && seen.Add(aliased))
                {
                    yield return aliased;
                }

                continue;
            }

            // `import System` makes namespace `System` types reachable by simple name.
            var ns = string.Join(".", import.Identifiers.Select(i => i.Text));
            if (!string.IsNullOrEmpty(ns))
            {
                var qualified = ns + "." + name;
                if (seen.Add(qualified))
                {
                    yield return qualified;
                }
            }
        }

        // Implicit System import and fully-qualified fallbacks.
        foreach (var candidate in new[] { "System." + name, name })
        {
            if (seen.Add(candidate))
            {
                yield return candidate;
            }
        }
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

                var allPropertyIdentifiers = aggregate.Declaration.Properties.Select(p => p.Identifier);
                var allEventIdentifiers = aggregate.Declaration.Events.Select(e => e.Identifier);
                var allMethodIdentifiers = aggregate.Declaration.Methods.Select(m => m.Identifier);

                if (aggregate.Declaration.SharedBlock != null)
                {
                    allPropertyIdentifiers = allPropertyIdentifiers.Concat(aggregate.Declaration.SharedBlock.Properties.Select(p => p.Identifier));
                    allEventIdentifiers = allEventIdentifiers.Concat(aggregate.Declaration.SharedBlock.Events.Select(e => e.Identifier));
                    allMethodIdentifiers = allMethodIdentifiers.Concat(aggregate.Declaration.SharedBlock.Methods.Select(m => m.Identifier));

                    if (!aggregate.StaticFields.IsDefaultOrEmpty)
                    {
                        for (var si = 0; si < aggregate.Declaration.SharedBlock.Fields.Length && si < aggregate.StaticFields.Length; si++)
                        {
                            var fieldId = aggregate.Declaration.SharedBlock.Fields[si].Identifier;
                            if (fieldId != null)
                            {
                                declarations[fieldId] = aggregate.StaticFields[si];
                            }
                        }
                    }
                }

                MapMembersByName(
                    declarations,
                    allPropertyIdentifiers,
                    aggregate.Properties.Concat(aggregate.StaticProperties));

                MapMembersByName(
                    declarations,
                    allEventIdentifiers,
                    aggregate.Events.Concat(aggregate.StaticEvents));

                MapMembersByName(
                    declarations,
                    allMethodIdentifiers,
                    aggregate.Methods.Concat(aggregate.StaticMethods));

                // Register parameters and implicit 'this' for struct/class methods
                // so that hover, go-to-definition, etc. work inside method bodies.
                foreach (var method in aggregate.Methods.Concat(aggregate.StaticMethods))
                {
                    if (method.Declaration != null)
                    {
                        MapParameters(method.Declaration, method.Parameters, declarations, localDeclarations);
                        if (method.ThisParameter != null)
                        {
                            GetLocals(localDeclarations, method.Declaration)[method.ThisParameter.Name] = method.ThisParameter;
                        }
                    }
                }
            }
        }

        foreach (var iface in compilation.GlobalScope.Interfaces)
        {
            globals[iface.Name] = iface;
            if (iface.Declaration != null)
            {
                declarations[iface.Declaration.Identifier] = iface;

                MapMembersByName(
                    declarations,
                    iface.Declaration.Methods.Select(m => m.Identifier),
                    iface.Methods);

                MapMembersByName(
                    declarations,
                    iface.Declaration.Properties.Select(p => p.Identifier),
                    iface.Properties);

                MapMembersByName(
                    declarations,
                    iface.Declaration.Events.Select(e => e.Identifier),
                    iface.Events);
            }
        }

        foreach (var import in compilation.GlobalScope.Imports)
        {
            if (import.Declaration?.AliasIdentifier is { } aliasIdentifier)
            {
                declarations[aliasIdentifier] = import;
            }
        }

        foreach (var package in compilation.GlobalScope.Packages)
        {
            if (package.Declaration == null)
            {
                continue;
            }

            foreach (var identifier in package.Declaration.Identifiers)
            {
                declarations[identifier] = package;
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

        // Register type alias declaration identifiers so code lenses can resolve them.
        foreach (var typeAliasSyntax in FindNodes<TypeAliasDeclarationSyntax>(compilation.SyntaxTrees.Select(t => t.Root)))
        {
            var aliasId = typeAliasSyntax.Identifier;
            if (aliasId != null && aliasId.Text != null
                && compilation.GlobalScope.TypeAliases.TryGetValue(aliasId.Text, out var aliasedType))
            {
                declarations[aliasId] = aliasedType;
            }
        }

        MapLocalVariables(compilation, declarations, localDeclarations);
        return new SemanticModel(compilation, declarations, globals, localDeclarations);
    }

    private static void MapMembersByName(
        Dictionary<SyntaxToken, Symbol> declarations,
        IEnumerable<SyntaxToken> identifiers,
        IEnumerable<Symbol> symbols)
    {
        var byName = new Dictionary<string, Symbol>(StringComparer.Ordinal);
        foreach (var symbol in symbols)
        {
            if (symbol?.Name != null)
            {
                byName[symbol.Name] = symbol;
            }
        }

        foreach (var identifier in identifiers)
        {
            if (identifier != null && identifier.Text != null && byName.TryGetValue(identifier.Text, out var symbol))
            {
                declarations[identifier] = symbol;
            }
        }
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
                if (IsDefaultImmutableArray(value))
                {
                    continue;
                }

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

    private static bool IsDefaultImmutableArray(object value)
    {
        var type = value.GetType();
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(System.Collections.Immutable.ImmutableArray<>))
        {
            var isDefault = type.GetProperty("IsDefault");
            return isDefault != null && (bool)isDefault.GetValue(value)!;
        }

        return false;
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
        private readonly Dictionary<(string FileName, int SpanStart, int SpanEnd), Symbol> declarationsBySpan;
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

            // Build a (file, span) → Symbol index in parallel with the reference-equality map.
            // When a caller passes a SyntaxToken from a tree the compilation no longer holds
            // (e.g. the project has since been reparsed by a diagnostic pull while a cached
            // DocumentContent still references the prior tree), token identity diverges but
            // the file path and span are stable across re-parses of identical source — so a
            // span-based fallback recovers the correct symbol.
            this.declarationsBySpan = new Dictionary<(string, int, int), Symbol>(declarations.Count);
            foreach (var pair in declarations)
            {
                var key = SpanKey(pair.Key);
                if (key.HasValue)
                {
                    this.declarationsBySpan[key.Value] = pair.Value;
                }
            }
        }

        public Symbol Resolve(SyntaxToken token)
        {
            if (this.declarations.TryGetValue(token, out var declared))
            {
                return declared;
            }

            var spanKey = SpanKey(token);
            if (spanKey.HasValue && this.declarationsBySpan.TryGetValue(spanKey.Value, out var bySpan))
            {
                return bySpan;
            }

            if (token.Text == null)
            {
                return null;
            }

            var function = this.FindContainingFunction(token);
            if (function != null && this.localDeclarations.TryGetValue(function, out var locals) && locals.TryGetValue(token.Text, out var local))
            {
                return local;
            }

            // Implicit-this member access: inside a class/struct method body, a bare identifier
            // like `Name` is bound by the binder as `this.Name` (see Binder + ImplicitProperty/
            // FieldVariableSymbol). Mirror that here so FindReferences, go-to-definition, rename,
            // and the CodeLens reference count include the implicit-this use sites — not just
            // explicit `this.Name` accesses.
            var implicitThis = this.ResolveImplicitThisMember(token);
            if (implicitThis != null)
            {
                return implicitThis;
            }

            return this.globals.TryGetValue(token.Text, out var global) ? global : ResolvePrimitiveOrImportedType(token.Text);
        }

        public IReadOnlyList<VariableSymbol> GetLocals(FunctionDeclarationSyntax declaration)
        {
            if (declaration != null && this.localDeclarations.TryGetValue(declaration, out var locals))
            {
                return locals.Values.OfType<VariableSymbol>().ToList();
            }

            return Array.Empty<VariableSymbol>();
        }

        private static (string FileName, int SpanStart, int SpanEnd)? SpanKey(SyntaxToken token)
        {
            if (token == null || token.SyntaxTree?.Text == null)
            {
                return null;
            }

            return (token.SyntaxTree.Text.FileName ?? string.Empty, token.Span.Start, token.Span.End);
        }

        private static Symbol LookupMember(StructSymbol structSymbol, string memberName)
        {
            for (var current = structSymbol; current != null; current = current.BaseClass)
            {
                var property = current.Properties.Concat(current.StaticProperties).FirstOrDefault(p => p.Name == memberName);
                if (property != null)
                {
                    return property;
                }

                var field = current.Fields.Concat(current.StaticFields).FirstOrDefault(f => f.Name == memberName);
                if (field != null)
                {
                    return field;
                }

                var evt = current.Events.Concat(current.StaticEvents).FirstOrDefault(e => e.Name == memberName);
                if (evt != null)
                {
                    return evt;
                }

                var method = current.Methods.Concat(current.StaticMethods).FirstOrDefault(m => m.Name == memberName);
                if (method != null)
                {
                    return method;
                }
            }

            return null;
        }

        private Symbol ResolveImplicitThisMember(SyntaxToken token)
        {
            // Walk all struct declarations in any tree; pick the innermost one whose span
            // contains the token AND which has a method body that also contains the token.
            // (Tokens inside a struct's *own declarations*, like field/property declarators,
            // are already mapped via the declarations dictionary and must not be re-resolved
            // as implicit-this member references.)
            StructDeclarationSyntax enclosing = null;
            foreach (var decl in FindNodes<StructDeclarationSyntax>(this.compilation.SyntaxTrees.Select(t => t.Root)))
            {
                if (decl.Span.Start > token.Span.Start || token.Span.End > decl.Span.End)
                {
                    continue;
                }

                var insideMethod = false;
                foreach (var method in decl.Methods)
                {
                    if (method.Body != null
                        && method.Body.Span.Start <= token.Span.Start
                        && token.Span.End <= method.Body.Span.End)
                    {
                        insideMethod = true;
                        break;
                    }
                }

                if (!insideMethod)
                {
                    continue;
                }

                if (enclosing == null || decl.Span.Length < enclosing.Span.Length)
                {
                    enclosing = decl;
                }
            }

            if (enclosing == null)
            {
                return null;
            }

            // Resolve the struct declaration to its symbol (this goes through the same
            // declarations/declarationsBySpan/globals chain, so it survives tree-reparse desyncs).
            if (!(this.Resolve(enclosing.Identifier) is StructSymbol structSymbol))
            {
                return null;
            }

            return LookupMember(structSymbol, token.Text);
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
