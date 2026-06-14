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
    // Cache the SemanticModel per Compilation. BuildModel iterates every global
    // symbol and re-binds every function/method body (via Compilation.BoundProgram),
    // which is expensive — hundreds of milliseconds on projects with large reference
    // graphs. Every LSP request that needs symbol info (hover, definition, references,
    // semantic tokens, code lens, inlay hints) routes through here, so without this
    // cache the user pays that cost per request. The cache key is the Compilation
    // itself; because each file edit constructs a fresh Compilation (see
    // ProjectState.GetCompilation), invalidation is automatic and the old entry
    // becomes unreachable so the ConditionalWeakTable frees it.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, SemanticModel> ModelCache = new();

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
    /// Pre-builds the per-compilation <c>SemanticModel</c> and its references
    /// index. Intended for the workspace warm-up path so that the first
    /// user-facing CodeLens / hover / definition request returns from cache
    /// instead of paying the SemanticModel build cost.
    /// </summary>
    /// <param name="compilation">The compilation to warm up.</param>
    public static void WarmUp(Compilation compilation)
    {
        if (compilation == null)
        {
            return;
        }

        var model = BuildModel(compilation);

        // Force the references index to be built. We don't care about the
        // result, only the side effect of populating the cache. Use a sentinel
        // global symbol so the call short-circuits on Symbol.null without
        // walking trees needlessly when the index is already built.
        foreach (var function in compilation.GlobalScope.Functions)
        {
            _ = model.GetReferences(function);
            break;
        }

        // If the project has no functions at all, fall back to any struct so
        // the index gets built. (BuildReferencesIndex is invoked on the first
        // GetReferences call regardless of which symbol is queried.)
        if (compilation.GlobalScope.Functions.Length == 0)
        {
            foreach (var s in compilation.GlobalScope.Structs)
            {
                _ = model.GetReferences(s);
                break;
            }
        }
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
    /// <param name="includeAttributeSuffixFallback">
    /// When <see langword="true"/>, also tries the C#-style
    /// <c>&lt;name&gt;Attribute</c> fallback (used for annotation hover, e.g. <c>@Obsolete</c>).
    /// </param>
    /// <returns>The resolved CLR type, or <c>null</c> when no match is found.</returns>
    public static Type ResolveImportedClrType(
        SyntaxTree tree,
        Compilation compilation,
        string name,
        bool includeAttributeSuffixFallback = false)
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

        if (includeAttributeSuffixFallback && !name.EndsWith("Attribute", StringComparison.Ordinal))
        {
            foreach (var candidate in GetCandidateTypeNames(tree, name + "Attribute"))
            {
                if (resolver.TryResolveType(candidate, out var type))
                {
                    return type;
                }
            }
        }

        return null;
    }

    public static IEnumerable<SyntaxToken> FindReferences(Compilation compilation, Symbol target)
    {
        if (target == null)
        {
            return Array.Empty<SyntaxToken>();
        }

        // FindReferences is called once per member by CodeLensComputer. Without a
        // cache, every call walks every token in every syntax tree and re-resolves
        // each one — and each Resolve for a non-declaration token re-walks the
        // entire compilation looking for the containing function / enclosing
        // struct method (see SemanticModel.FindContainingFunction and
        // ResolveImplicitThisMember). On a small project with a handful of files
        // this still adds up to many seconds. Caching the reverse index on the
        // SemanticModel collapses N FindReferences calls into one walk.
        return BuildModel(compilation).GetReferences(target);
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
        return ModelCache.GetValue(compilation, BuildModelUncached);
    }

    private static SemanticModel BuildModelUncached(Compilation compilation)
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
            program = compilation.BoundProgram;
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

            var syntaxLocalIdentifiers = FindNodes<VariableDeclarationSyntax>(new[] { declaration.Body })
                .Select(v => v.Identifier)
                .Concat(FindNodes<ForRangeStatementSyntax>(new[] { declaration.Body }).SelectMany(f => EnumerateForRangeIdentifiers(f)))
                .Concat(FindNodes<AwaitForRangeStatementSyntax>(new[] { declaration.Body }).Select(f => f.Identifier));

            MapSyntaxLocals(pair.Value, syntaxLocalIdentifiers, declarations, localDeclarations, declaration);
        }

        if (program.Statement != null)
        {
            // Top-level statements have no containing function entry in localDeclarations.
            // We still need loop-variable declaration mappings for for-range hover/reference
            // support in scripts.
            var topLevelLoopIdentifiers =
                FindNodes<ForRangeStatementSyntax>(compilation.SyntaxTrees.Select(t => t.Root)).SelectMany(f => EnumerateForRangeIdentifiers(f))
                .Concat(FindNodes<AwaitForRangeStatementSyntax>(compilation.SyntaxTrees.Select(t => t.Root)).Select(f => f.Identifier));
            MapSyntaxLocals(program.Statement, topLevelLoopIdentifiers, declarations, localDeclarations, declaration: null);
        }
    }

    private static IEnumerable<SyntaxToken> EnumerateForRangeIdentifiers(ForRangeStatementSyntax syntax)
    {
        if (syntax.FirstIdentifier != null)
        {
            yield return syntax.FirstIdentifier;
        }

        if (syntax.SecondIdentifier != null)
        {
            yield return syntax.SecondIdentifier;
        }
    }

    private static void MapSyntaxLocals(
        BoundNode boundRoot,
        IEnumerable<SyntaxToken> syntaxLocalIdentifiers,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<FunctionDeclarationSyntax, Dictionary<string, Symbol>> localDeclarations,
        FunctionDeclarationSyntax declaration)
    {
        var boundDeclarations = FindBoundNodes<BoundVariableDeclaration>(boundRoot)
            .Where(d => !d.Variable.Name.StartsWith("<", StringComparison.Ordinal))
            .ToList();
        var used = new HashSet<int>();
        foreach (var syntaxIdentifier in syntaxLocalIdentifiers
                     .Where(id => id != null)
                     .OrderBy(id => id.Span.Start))
        {
            for (var i = 0; i < boundDeclarations.Count; i++)
            {
                if (used.Contains(i) || boundDeclarations[i].Variable.Name != syntaxIdentifier.Text)
                {
                    continue;
                }

                used.Add(i);
                declarations[syntaxIdentifier] = boundDeclarations[i].Variable;
                if (declaration != null)
                {
                    GetLocals(localDeclarations, declaration)[boundDeclarations[i].Variable.Name] = boundDeclarations[i].Variable;
                }

                break;
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
        if (type.IsGenericType && type.GetGenericTypeDefinition().IsSameAs(typeof(System.Collections.Immutable.ImmutableArray<>)))
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
        private readonly object referencesLock = new object();
        private Dictionary<Symbol, List<SyntaxToken>> referencesIndex;

        // Cached tree-walk results. Resolve's fallback path used to call
        // FindNodes<FunctionDeclarationSyntax> and FindNodes<StructDeclarationSyntax>
        // for *every* unresolved token, re-walking every tree on each call. With
        // many tokens (and FindReferences calling Resolve per token, per member,
        // per CodeLens request) this dominated request latency. Precomputing the
        // per-tree node lists in BuildModelUncached makes those fallback paths
        // O(number of decls), not O(number of nodes across the workspace).
        private FunctionDeclarationSyntax[] cachedFunctionDeclarations;
        private StructDeclarationSyntax[] cachedStructDeclarations;
        private Dictionary<SyntaxTree, AccessorExpressionSyntax[]> cachedAccessorsByTree;
        private Dictionary<SyntaxTree, FieldAssignmentExpressionSyntax[]> cachedFieldAssignmentsByTree;
        private Dictionary<SyntaxTree, ForRangeStatementSyntax[]> cachedForRangesByTree;
        private Dictionary<SyntaxTree, AwaitForRangeStatementSyntax[]> cachedAwaitForRangesByTree;

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

            // Precompute per-compilation node lists once so the Resolve fallback
            // chain doesn't re-walk every tree on every token. See the field
            // declarations above for the motivation.
            var trees = this.compilation.SyntaxTrees;
            this.cachedFunctionDeclarations = FindNodes<FunctionDeclarationSyntax>(trees.Select(t => t.Root)).ToArray();
            this.cachedStructDeclarations = FindNodes<StructDeclarationSyntax>(trees.Select(t => t.Root)).ToArray();
            this.cachedAccessorsByTree = trees.ToDictionary(t => t, t => FindNodes<AccessorExpressionSyntax>(t.Root).ToArray());
            this.cachedFieldAssignmentsByTree = trees.ToDictionary(t => t, t => FindNodes<FieldAssignmentExpressionSyntax>(t.Root).ToArray());
            this.cachedForRangesByTree = trees.ToDictionary(t => t, t => FindNodes<ForRangeStatementSyntax>(t.Root).ToArray());
            this.cachedAwaitForRangesByTree = trees.ToDictionary(t => t, t => FindNodes<AwaitForRangeStatementSyntax>(t.Root).ToArray());
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

            // Instance/static member access: when the token is the member identifier on the right
            // side of `receiver.Member` (AccessorExpressionSyntax) or the field identifier of
            // `receiver.Field = value` (FieldAssignmentExpressionSyntax), resolve the receiver's
            // type and look the member up on it. This runs *before* the by-name local/global
            // fallbacks so a member access never accidentally binds to a same-named local or
            // global (e.g. `person.Name` must never resolve to a top-level `Name`).
            var asMember = this.ResolveAsMemberAccess(token);
            if (asMember != null)
            {
                return asMember;
            }

            if (IsRightOfMemberAccess(token))
            {
                // Token is clearly a member name; do not fall through to by-name lookups.
                return null;
            }

            var function = this.FindContainingFunction(token);
            if (function != null && this.localDeclarations.TryGetValue(function, out var locals) && locals.TryGetValue(token.Text, out var local))
            {
                return local;
            }

            var loopLocal = this.ResolveForRangeLoopLocal(token);
            if (loopLocal != null)
            {
                return loopLocal;
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

        public IReadOnlyList<SyntaxToken> GetReferences(Symbol target)
        {
            if (target == null)
            {
                return Array.Empty<SyntaxToken>();
            }

            // Build the reverse `Symbol → List<SyntaxToken>` index lazily, on the
            // first call. Walking every identifier in every syntax tree (and
            // invoking the multi-tree-walk Resolve fallback chain on each) is
            // expensive; doing it once per compilation amortizes that cost across
            // every member's FindReferences call from CodeLensComputer.
            var index = this.referencesIndex;
            if (index == null)
            {
                lock (this.referencesLock)
                {
                    if (this.referencesIndex == null)
                    {
                        this.referencesIndex = this.BuildReferencesIndex();
                    }

                    index = this.referencesIndex;
                }
            }

            return index.TryGetValue(target, out var tokens) ? tokens : (IReadOnlyList<SyntaxToken>)Array.Empty<SyntaxToken>();
        }

        private Dictionary<Symbol, List<SyntaxToken>> BuildReferencesIndex()
        {
            var index = new Dictionary<Symbol, List<SyntaxToken>>();
            foreach (var tree in this.compilation.SyntaxTrees)
            {
                foreach (var token in EnumerateTokens(tree.Root))
                {
                    if (token.IsMissing || token.Kind != SyntaxKind.IdentifierToken)
                    {
                        continue;
                    }

                    var symbol = this.Resolve(token);
                    if (symbol == null)
                    {
                        continue;
                    }

                    if (!index.TryGetValue(symbol, out var list))
                    {
                        list = new List<SyntaxToken>();
                        index[symbol] = list;
                    }

                    list.Add(token);
                }
            }

            return index;
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
            // Find the innermost struct method body that contains the token. We deliberately do
            // NOT pre-filter by StructDeclarationSyntax.Span: the parser sometimes reports a
            // struct's span as ending at an internal closing brace (e.g. the `}` of a `shared {}`
            // block) rather than the type's own `}`, so a span-containment check would wrongly
            // skip methods that live below that point. The method body span is what actually
            // matters for "is this token inside an instance method of a class".
            //
            // Shared-block methods are intentionally excluded — they're static and have no
            // implicit `this` receiver.
            StructDeclarationSyntax enclosing = null;
            var enclosingBodyLength = int.MaxValue;
            foreach (var decl in this.cachedStructDeclarations)
            {
                foreach (var method in decl.Methods)
                {
                    if (method.Body == null)
                    {
                        continue;
                    }

                    if (method.Body.Span.Start <= token.Span.Start
                        && token.Span.End <= method.Body.Span.End
                        && method.Body.Span.Length < enclosingBodyLength)
                    {
                        enclosing = decl;
                        enclosingBodyLength = method.Body.Span.Length;
                    }
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

        private static bool TokenMatches(SyntaxToken candidate, SyntaxToken token)
        {
            if (ReferenceEquals(candidate, token))
            {
                return true;
            }

            return candidate != null
                && token != null
                && candidate.Span.Start == token.Span.Start
                && candidate.Span.End == token.Span.End
                && string.Equals(candidate.Text, token.Text, StringComparison.Ordinal);
        }

        private bool IsRightOfMemberAccess(SyntaxToken token)
        {
            // Cheap text-free check used to suppress fallback lookups. A token whose tree
            // contains an AccessorExpressionSyntax or FieldAssignmentExpressionSyntax at this
            // span is treated as a member name, and must not be resolved by name as a local
            // or global.
            if (token?.SyntaxTree == null)
            {
                return false;
            }

            if (this.cachedAccessorsByTree.TryGetValue(token.SyntaxTree, out var accessors))
            {
                foreach (var accessor in accessors)
                {
                    if (accessor.RightPart.Span.Start <= token.Span.Start
                        && token.Span.End <= accessor.RightPart.Span.End
                        && AccessorRightContainsMemberToken(accessor.RightPart, token))
                    {
                        return true;
                    }
                }
            }

            if (this.cachedFieldAssignmentsByTree.TryGetValue(token.SyntaxTree, out var assignments))
            {
                foreach (var assign in assignments)
                {
                    if (TokenMatches(assign.FieldIdentifier, token))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool AccessorRightContainsMemberToken(ExpressionSyntax rightPart, SyntaxToken token)
        {
            switch (rightPart)
            {
                case NameExpressionSyntax name:
                    return TokenMatches(name.IdentifierToken, token);
                case CallExpressionSyntax call:
                    return TokenMatches(call.Identifier, token);
                case AccessorExpressionSyntax nested:
                    return AccessorRightContainsMemberToken(nested.LeftPart, token)
                        || AccessorRightContainsMemberToken(nested.RightPart, token);
                default:
                    return false;
            }
        }

        private Symbol ResolveAsMemberAccess(SyntaxToken token)
        {
            if (token == null || token.Kind != SyntaxKind.IdentifierToken)
            {
                return null;
            }

            // Walk the token's own tree first (covers the common case and works even when
            // the compilation does not contain this tree — e.g. a stale DocumentContent).
            // Then walk every compilation tree to support cross-file resolution.
            var trees = new HashSet<SyntaxTree>();
            if (token.SyntaxTree != null)
            {
                trees.Add(token.SyntaxTree);
            }

            foreach (var t in this.compilation.SyntaxTrees)
            {
                trees.Add(t);
            }

            foreach (var tree in trees)
            {
                var accessors = this.GetAccessorsForTree(tree);
                foreach (var accessor in accessors
                             .Where(a => a.RightPart.Span.Start <= token.Span.Start && token.Span.End <= a.RightPart.Span.End)
                             .OrderBy(a => a.Span.Length))
                {
                    if (TryDriveAccessorTarget(tree, accessor.RightPart, accessor.LeftPart, token, out var receiverExpr, out var memberName))
                    {
                        var receiverType = this.ResolveReceiverTypeSymbol(tree, receiverExpr);
                        var member = LookupTypeMember(receiverType, memberName);
                        if (member != null)
                        {
                            return member;
                        }
                    }
                }

                foreach (var assign in this.GetFieldAssignmentsForTree(tree))
                {
                    if (!TokenMatches(assign.FieldIdentifier, token))
                    {
                        continue;
                    }

                    var receiverType = AsTypeSymbol(this.Resolve(assign.Receiver));
                    var member = LookupTypeMember(receiverType, assign.FieldIdentifier.Text);
                    if (member != null)
                    {
                        return member;
                    }
                }
            }

            return null;
        }

        private AccessorExpressionSyntax[] GetAccessorsForTree(SyntaxTree tree)
        {
            // The cache covers every tree currently in the compilation; trees that arrive
            // here from outside the compilation (a stale DocumentContent) fall back to a
            // one-off walk.
            return this.cachedAccessorsByTree.TryGetValue(tree, out var cached)
                ? cached
                : FindNodes<AccessorExpressionSyntax>(tree.Root).ToArray();
        }

        private FieldAssignmentExpressionSyntax[] GetFieldAssignmentsForTree(SyntaxTree tree)
        {
            return this.cachedFieldAssignmentsByTree.TryGetValue(tree, out var cached)
                ? cached
                : FindNodes<FieldAssignmentExpressionSyntax>(tree.Root).ToArray();
        }

        private static bool TryDriveAccessorTarget(
            SyntaxTree tree,
            ExpressionSyntax expression,
            ExpressionSyntax receiver,
            SyntaxToken token,
            out ExpressionSyntax receiverExpression,
            out string memberName)
        {
            receiverExpression = null;
            memberName = null;

            switch (expression)
            {
                case NameExpressionSyntax name when TokenMatches(name.IdentifierToken, token):
                    receiverExpression = receiver;
                    memberName = name.IdentifierToken.Text;
                    return true;
                case CallExpressionSyntax call when TokenMatches(call.Identifier, token):
                    receiverExpression = receiver;
                    memberName = call.Identifier.Text;
                    return true;
                case AccessorExpressionSyntax nested:
                    if (TryDriveAccessorTarget(tree, nested.LeftPart, receiver, token, out receiverExpression, out memberName))
                    {
                        return true;
                    }

                    var nestedReceiver = new AccessorExpressionSyntax(tree, receiver, nested.DotToken, nested.LeftPart);
                    return TryDriveAccessorTarget(tree, nested.RightPart, nestedReceiver, token, out receiverExpression, out memberName);
                default:
                    return false;
            }
        }

        private TypeSymbol ResolveReceiverTypeSymbol(SyntaxTree tree, ExpressionSyntax expression)
        {
            switch (expression)
            {
                case NameExpressionSyntax name:
                    return AsTypeSymbol(this.Resolve(name.IdentifierToken));
                case CallExpressionSyntax call:
                    return AsTypeSymbol(this.Resolve(call.Identifier));
                case AccessorExpressionSyntax nested:
                    var outerType = this.ResolveReceiverTypeSymbol(tree, nested.LeftPart);
                    if (outerType == null)
                    {
                        return null;
                    }

                    if (!TryGetMemberName(nested.RightPart, out var intermediateName))
                    {
                        return null;
                    }

                    var member = LookupTypeMember(outerType, intermediateName);
                    return member switch
                    {
                        PropertySymbol property => property.Type as TypeSymbol,
                        FieldSymbol field => field.Type as TypeSymbol,
                        FunctionSymbol fn => fn.Type as TypeSymbol,
                        _ => null,
                    };
                default:
                    return null;
            }
        }

        private static bool TryGetMemberName(ExpressionSyntax expression, out string memberName)
        {
            memberName = expression switch
            {
                NameExpressionSyntax name => name.IdentifierToken.Text,
                CallExpressionSyntax call => call.Identifier.Text,
                _ => null,
            };

            return memberName != null;
        }

        private static TypeSymbol AsTypeSymbol(Symbol symbol)
        {
            return symbol switch
            {
                TypeSymbol t => t,
                VariableSymbol v => v.Type,
                FunctionSymbol f => f.Type,
                PropertySymbol p => p.Type,
                FieldSymbol fld => fld.Type,
                _ => null,
            };
        }

        private static Symbol LookupTypeMember(TypeSymbol receiverType, string memberName)
        {
            switch (receiverType)
            {
                case StructSymbol structSymbol:
                    return LookupMember(structSymbol, memberName);
                case EnumSymbol enumSymbol:
                    return enumSymbol.Members.FirstOrDefault(m => m.Name == memberName);
                default:
                    return null;
            }
        }

        private FunctionDeclarationSyntax FindContainingFunction(SyntaxToken token)
        {
            FunctionDeclarationSyntax best = null;
            var bestLength = int.MaxValue;
            foreach (var f in this.cachedFunctionDeclarations)
            {
                if (f.Span.Start <= token.Span.Start && token.Span.End <= f.Span.End && f.Span.Length < bestLength)
                {
                    best = f;
                    bestLength = f.Span.Length;
                }
            }

            return best;
        }

        private Symbol ResolveForRangeLoopLocal(SyntaxToken token)
        {
            if (token?.SyntaxTree == null)
            {
                return null;
            }

            Symbol best = null;
            var bestSpanLength = int.MaxValue;

            foreach (var statement in this.GetForRangesForTree(token.SyntaxTree))
            {
                if (statement.Body == null
                    || token.Span.Start < statement.Body.Span.Start
                    || statement.Body.Span.End < token.Span.End)
                {
                    continue;
                }

                if (statement.SecondIdentifier != null && string.Equals(statement.FirstIdentifier?.Text, token.Text, StringComparison.Ordinal))
                {
                    var keySymbol = this.Resolve(statement.FirstIdentifier);
                    if (keySymbol != null && statement.Body.Span.Length < bestSpanLength)
                    {
                        best = keySymbol;
                        bestSpanLength = statement.Body.Span.Length;
                    }
                }

                var valueIdentifier = statement.SecondIdentifier ?? statement.FirstIdentifier;
                if (!string.Equals(valueIdentifier?.Text, token.Text, StringComparison.Ordinal))
                {
                    continue;
                }

                var valueSymbol = this.Resolve(valueIdentifier);
                if (valueSymbol != null && statement.Body.Span.Length < bestSpanLength)
                {
                    best = valueSymbol;
                    bestSpanLength = statement.Body.Span.Length;
                }
            }

            foreach (var statement in this.GetAwaitForRangesForTree(token.SyntaxTree))
            {
                if (statement.Body == null
                    || token.Span.Start < statement.Body.Span.Start
                    || statement.Body.Span.End < token.Span.End
                    || !string.Equals(statement.Identifier?.Text, token.Text, StringComparison.Ordinal))
                {
                    continue;
                }

                var valueSymbol = this.Resolve(statement.Identifier);
                if (valueSymbol != null && statement.Body.Span.Length < bestSpanLength)
                {
                    best = valueSymbol;
                    bestSpanLength = statement.Body.Span.Length;
                }
            }

            return best;
        }

        private ForRangeStatementSyntax[] GetForRangesForTree(SyntaxTree tree)
        {
            return this.cachedForRangesByTree.TryGetValue(tree, out var cached)
                ? cached
                : FindNodes<ForRangeStatementSyntax>(tree.Root).ToArray();
        }

        private AwaitForRangeStatementSyntax[] GetAwaitForRangesForTree(SyntaxTree tree)
        {
            return this.cachedAwaitForRangesByTree.TryGetValue(tree, out var cached)
                ? cached
                : FindNodes<AwaitForRangeStatementSyntax>(tree.Root).ToArray();
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
