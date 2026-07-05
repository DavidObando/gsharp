// <copyright file="SemanticLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
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

    // ADR-0106 — incremental SemanticModel build. The per-edit cost of building
    // the model was dominated by two whole-project walks: collecting syntax
    // nodes from every tree (SemanticModel constructor) and matching bound
    // locals to syntax identifiers for every body (MapLocalVariables, a
    // reflection-based FindBoundNodes walk). Both are pure functions of an
    // instance-stable input — a SyntaxTree for the former, a lowered
    // BoundBlockStatement for the latter — so memoize them by that instance.
    //
    // On a single-file edit, ProjectState.UpdateFile replaces only the edited
    // file's SyntaxTree (every other tree keeps its instance), and ADR-0105's
    // BoundBodyCache serves every unchanged file's body as the same instance.
    // Keying on instance identity therefore yields automatic cache hits for all
    // 53 unchanged files and a miss (recompute) only for the edited file, with
    // no need to thread the previous model: a changed file gets fresh instances
    // and so naturally recomputes. ConditionalWeakTable frees entries once the
    // old trees/bodies become unreachable after the edit.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<SyntaxTree, NodeBuckets> NodeBucketCache = new();
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<BoundBlockStatement, IReadOnlyList<(SyntaxToken Identifier, Symbol Variable)>> FunctionLocalsCache = new();

    // Diagnostics counters (used by tests to assert the incremental path reuses
    // unchanged files rather than re-walking them).
    private static long nodeBucketCacheHits;
    private static long nodeBucketCacheMisses;
    private static long functionLocalsCacheHits;
    private static long functionLocalsCacheMisses;

    /// <summary>
    /// Describes the hovered call's receiver syntax so the same-named imported
    /// method scan can be disambiguated by dispatch shape (issue #906).
    /// </summary>
    public enum CallReceiverGate
    {
        /// <summary>No receiver / unknown — match by name and arity only (legacy behavior).</summary>
        None,

        /// <summary>The receiver is a value expression (e.g. <c>report.Checks.Single(...)</c>): the
        /// call can only bind to an instance method or an extension method dispatched on the
        /// receiver, never to a plain static method.</summary>
        Value,

        /// <summary>The receiver is a type name (e.g. <c>string.Concat(...)</c>): the call can only
        /// bind to a plain static method on that type, never to an instance/extension-dispatched one.</summary>
        TypeName,
    }

    /// <summary>Gets the node-bucket memo (hit, miss) counts. Test hook for ADR-0106.</summary>
    internal static (long Hits, long Misses) NodeBucketCacheStats =>
        (System.Threading.Interlocked.Read(ref nodeBucketCacheHits), System.Threading.Interlocked.Read(ref nodeBucketCacheMisses));

    /// <summary>Gets the per-body local memo (hit, miss) counts. Test hook for ADR-0106.</summary>
    internal static (long Hits, long Misses) FunctionLocalsCacheStats =>
        (System.Threading.Interlocked.Read(ref functionLocalsCacheHits), System.Threading.Interlocked.Read(ref functionLocalsCacheMisses));

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

    public static Symbol ResolveSymbol(Compilation compilation, SyntaxToken identifierToken, CancellationToken ct = default)
    {
        if (identifierToken == null || identifierToken.IsMissing || identifierToken.Kind != SyntaxKind.IdentifierToken)
        {
            return null;
        }

        var model = BuildModel(compilation, ct);
        return model.Resolve(identifierToken);
    }

    /// <summary>
    /// Issue #891 / #906: resolves the imported CLR method that an invoked call
    /// expression bound to. The lowered call nodes do not retain their
    /// originating syntax, so the match is by method name and arity (the
    /// extension-method form carries one extra leading parameter for the
    /// receiver). This returns the exact overload chosen by overload
    /// resolution — including generic extension methods such as LINQ
    /// <c>Single&lt;TSource&gt;</c> — so hover can show the invoked method rather
    /// than an unrelated type that merely shares its name (e.g.
    /// <c>System.Single</c>).
    /// <para>
    /// Because the scan is program-wide (the call nodes carry no syntax to match
    /// on), two different calls that merely share a method name and argument
    /// count would otherwise be indistinguishable — e.g. the LINQ extension
    /// <c>report.Checks.Single(pred)</c> and an unrelated static
    /// <c>Assert.Single(collection)</c> elsewhere. The <paramref name="gate"/>
    /// (derived from the hovered call's receiver syntax) and optional
    /// <paramref name="receiverClrType"/> restrict the match to candidates whose
    /// dispatch shape and receiver type are consistent with the hovered call.
    /// </para>
    /// </summary>
    /// <param name="compilation">The compilation whose bound program is searched.</param>
    /// <param name="methodName">The invoked method's simple name.</param>
    /// <param name="argumentCount">The number of arguments at the call site.</param>
    /// <param name="gate">The hovered call's receiver dispatch shape.</param>
    /// <param name="receiverClrType">The hovered receiver's CLR type when known; used as a tie-breaker.</param>
    /// <param name="method">On success, the resolved CLR method.</param>
    /// <param name="overloadCount">On success, the number of same-named overloads on the declaring type.</param>
    /// <returns><see langword="true"/> when an invoked imported method was found.</returns>
    public static bool TryResolveInvokedImportedMethod(
        Compilation compilation,
        string methodName,
        int argumentCount,
        CallReceiverGate gate,
        Type receiverClrType,
        out System.Reflection.MethodInfo method,
        out int overloadCount)
    {
        method = null;
        overloadCount = 0;
        if (compilation == null || string.IsNullOrEmpty(methodName))
        {
            return false;
        }

        BoundProgram program;
        try
        {
            program = compilation.BoundProgram;
        }
        catch (InvalidOperationException)
        {
            return false;
        }

        System.Reflection.MethodInfo firstGated = null;
        foreach (var root in EnumerateBoundRoots(program))
        {
            if (root == null)
            {
                continue;
            }

            foreach (var node in FindBoundNodes<BoundNode>(root))
            {
                var isInstance = node is BoundImportedInstanceCallExpression;
                var candidate = node switch
                {
                    BoundImportedInstanceCallExpression instanceCall => instanceCall.Method,
                    BoundImportedCallExpression staticCall => staticCall.Function?.Method,
                    _ => null,
                };

                if (candidate == null || !string.Equals(candidate.Name, methodName, StringComparison.Ordinal))
                {
                    continue;
                }

                // An instance/static call has one parameter per argument; an
                // imported extension method dispatched with receiver syntax has
                // one extra leading parameter (the receiver).
                var parameterCount = candidate.GetParameters().Length;
                var isExtensionDispatched = !isInstance && parameterCount == argumentCount + 1;
                var isExactArity = parameterCount == argumentCount;
                if (!isExactArity && !isExtensionDispatched)
                {
                    continue;
                }

                // Reject candidates whose dispatch shape is inconsistent with the
                // hovered call's receiver syntax (issue #906).
                switch (gate)
                {
                    case CallReceiverGate.Value when !(isInstance || isExtensionDispatched):
                        // A value receiver (`x.M(...)`) cannot bind to a plain static method.
                        continue;
                    case CallReceiverGate.TypeName when isInstance || isExtensionDispatched:
                        // A type-name receiver (`T.M(...)`) cannot bind to an instance or
                        // receiver-dispatched extension method.
                        continue;
                    default:
                        break;
                }

                firstGated ??= candidate;

                // When the receiver's CLR type is known, prefer the candidate whose
                // effective receiver type matches it. This disambiguates same-shaped
                // collisions (e.g. `.Single(...)` over two different element types).
                if (receiverClrType != null
                    && IsReceiverTypeCompatible(candidate, isInstance, isExtensionDispatched, receiverClrType))
                {
                    method = candidate;
                    overloadCount = CountSameNamedMethods(candidate);
                    return true;
                }
            }
        }

        if (firstGated != null)
        {
            method = firstGated;
            overloadCount = CountSameNamedMethods(firstGated);
            return true;
        }

        return false;
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
    /// <param name="tree">The syntax tree the offset belongs to; scopes the function search to that file.</param>
    /// <param name="offset">The source offset of the expression.</param>
    /// <returns>The enclosing function symbol and the in-scope local symbols.</returns>
    public static (FunctionSymbol Function, IReadOnlyList<VariableSymbol> Locals) GetExpressionBindingContext(Compilation compilation, SyntaxTree tree, int offset)
    {
        // Spans are per-file offsets; restrict the search to the supplied tree so a function
        // in another file can't be chosen by offset overlap in a multi-file compilation.
        var roots = tree != null
            ? new[] { tree.Root }
            : compilation.SyntaxTrees.Select(t => t.Root);
        var funcDecl = FindNodes<FunctionDeclarationSyntax>(roots)
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

    public static IEnumerable<SyntaxToken> FindReferences(Compilation compilation, Symbol target, CancellationToken ct = default)
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
        return BuildModel(compilation, ct).GetReferences(target, ct);
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

    /// <summary>
    /// ADR-0106 test hook: builds a <see cref="SemanticModel"/> for
    /// <paramref name="compilation"/>, optionally bypassing the incremental memo
    /// caches so the result is a from-scratch oracle. Used by the equivalence
    /// tests to compare the incremental build against a full rebuild.
    /// </summary>
    /// <param name="compilation">The compilation to build a model for.</param>
    /// <param name="useIncrementalCaches">Whether the instance-keyed memo caches are used.</param>
    /// <returns>The semantic model.</returns>
    internal static SemanticModel BuildModelForTest(Compilation compilation, bool useIncrementalCaches)
    {
        return BuildModelUncached(compilation, useIncrementalCaches);
    }

    /// <summary>Resets the ADR-0106 incremental-build memo counters. Test hook.</summary>
    internal static void ResetIncrementalCacheCounters()
    {
        System.Threading.Interlocked.Exchange(ref nodeBucketCacheHits, 0);
        System.Threading.Interlocked.Exchange(ref nodeBucketCacheMisses, 0);
        System.Threading.Interlocked.Exchange(ref functionLocalsCacheHits, 0);
        System.Threading.Interlocked.Exchange(ref functionLocalsCacheMisses, 0);
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

    private static SemanticModel BuildModel(Compilation compilation, CancellationToken ct = default)
    {
        return ModelCache.GetValue(compilation, c => BuildModelUncached(c, useIncrementalCaches: true, ct));
    }

    /// <summary>
    /// ADR-0106: builds the per-compilation <see cref="SemanticModel"/>. When
    /// <paramref name="useIncrementalCaches"/> is <see langword="true"/> the
    /// expensive per-file work (syntax-node collection and per-body local
    /// matching) is memoized by syntax-tree / bound-body <em>instance</em>, so a
    /// single-file edit only recomputes the changed file's buckets while every
    /// unchanged file is served from the memo. When <see langword="false"/> every
    /// file is recomputed from scratch; that path is the correctness oracle the
    /// equivalence tests compare against. Both paths are identical by
    /// construction because the memoized helpers are pure functions of their
    /// instance-stable inputs.
    /// </summary>
    /// <param name="compilation">The compilation to build a model for.</param>
    /// <param name="useIncrementalCaches">Whether to read/write the instance-keyed memo caches.</param>
    /// <param name="ct">Token observed between per-file/per-struct build steps.</param>
    /// <returns>The semantic model.</returns>
    private static SemanticModel BuildModelUncached(Compilation compilation, bool useIncrementalCaches, CancellationToken ct = default)
    {
        var trees = compilation.SyntaxTrees;
        var bucketsByTree = new Dictionary<SyntaxTree, NodeBuckets>(trees.Length);
        foreach (var tree in trees)
        {
            // Bucketing walks every node in the tree; check between files so a
            // superseded request (fast typing) aborts instead of running the
            // whole cold multi-file build to completion (issue #1662).
            ct.ThrowIfCancellationRequested();
            bucketsByTree[tree] = GetNodeBuckets(tree, useIncrementalCaches);
        }

        var declarations = new Dictionary<SyntaxToken, Symbol>();
        var globals = new Dictionary<string, Symbol>(StringComparer.Ordinal);
        var localDeclarations = new Dictionary<SyntaxNode, Dictionary<string, Symbol>>();

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
            foreach (var declaration in bucketsByTree.Values.SelectMany(b => b.VariableDeclarations).Where(v => v.Identifier.Text == variable.Name))
            {
                declarations[declaration.Identifier] = variable;
            }
        }

        foreach (var aggregate in compilation.GlobalScope.Structs)
        {
            // Per-struct member mapping below is O(members); check between structs
            // so cancellation lands within one cold build instead of after it.
            ct.ThrowIfCancellationRequested();
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

                // Issue #894: register parameters and implicit 'this' for
                // user-defined `init(...)` constructors so that hover,
                // go-to-definition, etc. work inside constructor bodies exactly
                // as they do inside method bodies. The constructor body locals
                // themselves are matched in MapLocalVariables.
                foreach (var constructor in aggregate.ExplicitConstructors)
                {
                    if (constructor.Declaration != null)
                    {
                        MapParameters(constructor.Declaration, constructor.Parameters, declarations, localDeclarations);
                        if (constructor.Function.ThisParameter != null)
                        {
                            GetLocals(localDeclarations, constructor.Declaration)[constructor.Function.ThisParameter.Name] = constructor.Function.ThisParameter;
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

        foreach (var import in compilation.GlobalScope.GetCumulativeImports())
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
        foreach (var typeAliasSyntax in bucketsByTree.Values.SelectMany(b => b.TypeAliasDeclarations))
        {
            var aliasId = typeAliasSyntax.Identifier;
            if (aliasId != null && aliasId.Text != null
                && compilation.GlobalScope.TypeAliases.TryGetValue(aliasId.Text, out var aliasedType))
            {
                declarations[aliasId] = aliasedType;
            }
        }

        MapLocalVariables(compilation, declarations, localDeclarations, bucketsByTree, useIncrementalCaches);
        return new SemanticModel(compilation, declarations, globals, localDeclarations, bucketsByTree);
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
        Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations)
    {
        MapParametersCore(declaration, declaration.Parameters.ToArray(), parameters, declarations, localDeclarations);
    }

    private static void MapParameters(
        ConstructorDeclarationSyntax declaration,
        ImmutableArray<ParameterSymbol> parameters,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations)
    {
        MapParametersCore(declaration, declaration.Parameters.ToArray(), parameters, declarations, localDeclarations);
    }

    private static void MapParametersCore(
        SyntaxNode scope,
        ParameterSyntax[] syntaxParameters,
        ImmutableArray<ParameterSymbol> parameters,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations)
    {
        var symbolIndex = parameters.Length - syntaxParameters.Length;
        for (var i = 0; i < syntaxParameters.Length && symbolIndex + i < parameters.Length; i++)
        {
            var symbol = parameters[symbolIndex + i];
            declarations[syntaxParameters[i].Identifier] = symbol;
            GetLocals(localDeclarations, scope)[symbol.Name] = symbol;
        }
    }

    private static void MapLocalVariables(
        Compilation compilation,
        Dictionary<SyntaxToken, Symbol> declarations,
        Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations,
        Dictionary<SyntaxTree, NodeBuckets> bucketsByTree,
        bool useIncrementalCaches)
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

        // Issue #894: constructor (`init`) bodies are keyed in
        // BoundProgram.Functions by a synthesized instance-method-shaped
        // FunctionSymbol whose Declaration is null (the declaring syntax is a
        // ConstructorDeclarationSyntax). Build a reverse map so we can resolve
        // constructor body locals against the constructor's body syntax exactly
        // like a method body.
        var constructorByFunction = new Dictionary<FunctionSymbol, ConstructorDeclarationSyntax>();
        foreach (var aggregate in compilation.GlobalScope.Structs)
        {
            foreach (var constructor in aggregate.ExplicitConstructors)
            {
                if (constructor.Declaration != null && constructor.Function != null)
                {
                    constructorByFunction[constructor.Function] = constructor.Declaration;
                }
            }
        }

        foreach (var pair in program.Functions)
        {
            SyntaxNode scope = pair.Key.Declaration;
            var bodySyntax = pair.Key.Declaration?.Body;
            if (scope == null && constructorByFunction.TryGetValue(pair.Key, out var constructorDeclaration))
            {
                scope = constructorDeclaration;
                bodySyntax = constructorDeclaration.Body;
            }

            if (scope == null || bodySyntax == null)
            {
                continue;
            }

            // ADR-0106: matching bound locals to syntax identifiers walks the
            // lowered body (FindBoundNodes, reflection-based) and the body
            // syntax — the dominant per-edit cost across a whole project. The
            // result is a pure function of the lowered body instance (and its
            // backing syntax), which the BoundBodyCache reuses by reference for
            // unchanged files, so memoize it by that instance.
            var entries = GetFunctionLocals(bodySyntax, pair.Value, useIncrementalCaches);
            foreach (var (identifier, variable) in entries)
            {
                declarations[identifier] = variable;
                GetLocals(localDeclarations, scope)[variable.Name] = variable;
            }
        }

        if (program.Statement != null)
        {
            // Top-level statements have no containing function entry in localDeclarations.
            // We still need loop-variable declaration mappings for for-range hover/reference
            // support in scripts. There is a single synthesized top-level body per
            // compilation; recompute it directly (the for-range syntax comes from the
            // cached per-tree buckets, so this stays cheap on large workspaces).
            var topLevelLoopIdentifiers =
                bucketsByTree.Values.SelectMany(b => b.ForRanges).SelectMany(f => EnumerateForRangeIdentifiers(f))
                .Concat(bucketsByTree.Values.SelectMany(b => b.AwaitForRanges).Select(f => f.Identifier));
            foreach (var (identifier, variable) in MatchBoundLocals(program.Statement, topLevelLoopIdentifiers))
            {
                declarations[identifier] = variable;
            }
        }
    }

    /// <summary>
    /// ADR-0106: returns the (syntax identifier → local variable symbol) pairs
    /// for a single member body, memoized by the lowered-body instance when
    /// <paramref name="useIncrementalCaches"/> is set. Unchanged files reuse the
    /// same lowered body (served from the <c>BoundBodyCache</c>), so this is a
    /// memo hit; the edited file's body is a fresh instance, so it recomputes.
    /// </summary>
    private static IReadOnlyList<(SyntaxToken Identifier, Symbol Variable)> GetFunctionLocals(
        BlockStatementSyntax bodySyntax,
        BoundBlockStatement body,
        bool useIncrementalCaches)
    {
        if (!useIncrementalCaches)
        {
            return ComputeFunctionLocals(bodySyntax, body);
        }

        if (FunctionLocalsCache.TryGetValue(body, out var cached))
        {
            System.Threading.Interlocked.Increment(ref functionLocalsCacheHits);
            return cached;
        }

        System.Threading.Interlocked.Increment(ref functionLocalsCacheMisses);
        return FunctionLocalsCache.GetValue(body, _ => ComputeFunctionLocals(bodySyntax, body));
    }

    private static IReadOnlyList<(SyntaxToken Identifier, Symbol Variable)> ComputeFunctionLocals(
        BlockStatementSyntax bodySyntax,
        BoundBlockStatement body)
    {
        var syntaxLocalIdentifiers = FindNodes<VariableDeclarationSyntax>(new[] { bodySyntax })
            .Select(v => v.Identifier)
            .Concat(FindNodes<ForRangeStatementSyntax>(new[] { bodySyntax }).SelectMany(f => EnumerateForRangeIdentifiers(f)))
            .Concat(FindNodes<AwaitForRangeStatementSyntax>(new[] { bodySyntax }).Select(f => f.Identifier));

        return MatchBoundLocals(body, syntaxLocalIdentifiers);
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

    private static IReadOnlyList<(SyntaxToken Identifier, Symbol Variable)> MatchBoundLocals(
        BoundNode boundRoot,
        IEnumerable<SyntaxToken> syntaxLocalIdentifiers)
    {
        var boundDeclarations = FindBoundNodes<BoundVariableDeclaration>(boundRoot)
            .Where(d => !d.Variable.Name.StartsWith("<", StringComparison.Ordinal))
            .ToList();
        var result = new List<(SyntaxToken Identifier, Symbol Variable)>();
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
                result.Add((syntaxIdentifier, boundDeclarations[i].Variable));
                break;
            }
        }

        return result;
    }

    private static Dictionary<string, Symbol> GetLocals(
        Dictionary<SyntaxNode, Dictionary<string, Symbol>> locals,
        SyntaxNode declaration)
    {
        if (!locals.TryGetValue(declaration, out var functionLocals))
        {
            functionLocals = new Dictionary<string, Symbol>(StringComparer.Ordinal);
            locals[declaration] = functionLocals;
        }

        return functionLocals;
    }

    /// <summary>
    /// ADR-0106: returns the collected syntax-node buckets for
    /// <paramref name="tree"/>, memoized by the tree <em>instance</em> when
    /// <paramref name="useCache"/> is set. Because <c>ProjectState.UpdateFile</c>
    /// only replaces the edited file's tree, every unchanged file keeps its
    /// instance and so hits this memo, turning the whole-project syntax walk
    /// into a single-file walk on a typical edit.
    /// </summary>
    /// <param name="tree">The syntax tree to collect nodes for.</param>
    /// <param name="useCache">Whether to read/write the per-tree memo.</param>
    /// <returns>The collected node buckets.</returns>
    private static NodeBuckets GetNodeBuckets(SyntaxTree tree, bool useCache)
    {
        if (!useCache)
        {
            return CollectNodes(tree.Root);
        }

        if (NodeBucketCache.TryGetValue(tree, out var cached))
        {
            System.Threading.Interlocked.Increment(ref nodeBucketCacheHits);
            return cached;
        }

        System.Threading.Interlocked.Increment(ref nodeBucketCacheMisses);
        return NodeBucketCache.GetValue(tree, t => CollectNodes(t.Root));
    }

    private static NodeBuckets CollectNodes(SyntaxNode root)
    {
        var buckets = new NodeBuckets();
        CollectNodes(root, buckets);
        return buckets;
    }

    private static void CollectNodes(SyntaxNode node, NodeBuckets buckets)
    {
        switch (node)
        {
            case FunctionDeclarationSyntax f:
                buckets.Functions.Add(f);
                break;
            case ConstructorDeclarationSyntax c:
                buckets.Constructors.Add(c);
                break;
            case StructDeclarationSyntax s:
                buckets.Structs.Add(s);
                break;
            case AccessorExpressionSyntax a:
                buckets.Accessors.Add(a);
                break;
            case FieldAssignmentExpressionSyntax fa:
                buckets.FieldAssignments.Add(fa);
                break;
            case ForRangeStatementSyntax fr:
                buckets.ForRanges.Add(fr);
                break;
            case AwaitForRangeStatementSyntax afr:
                buckets.AwaitForRanges.Add(afr);
                break;
            case VariableDeclarationSyntax vd:
                buckets.VariableDeclarations.Add(vd);
                break;
            case TypeAliasDeclarationSyntax ta:
                buckets.TypeAliasDeclarations.Add(ta);
                break;
        }

        foreach (var child in node.GetChildren())
        {
            CollectNodes(child, buckets);
        }
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

    private static IEnumerable<BoundNode> EnumerateBoundRoots(BoundProgram program)
    {
        if (program == null)
        {
            yield break;
        }

        if (program.Statement != null)
        {
            yield return program.Statement;
        }

        foreach (var body in program.Functions.Values)
        {
            if (body != null)
            {
                yield return body;
            }
        }
    }

    private static bool IsReceiverTypeCompatible(
        System.Reflection.MethodInfo candidate,
        bool isInstance,
        bool isExtensionDispatched,
        Type receiverClrType)
    {
        Type effectiveReceiverType = isExtensionDispatched
            ? candidate.GetParameters().FirstOrDefault()?.ParameterType
            : candidate.DeclaringType;
        if (effectiveReceiverType == null)
        {
            return false;
        }

        try
        {
            if (effectiveReceiverType.IsAssignableFrom(receiverClrType)
                || receiverClrType.IsAssignableFrom(effectiveReceiverType))
            {
                return true;
            }
        }
        catch (NotSupportedException)
        {
            // MetadataLoadContext can throw for some open generic comparisons; fall back to name match.
        }

        // Generic/variance comparisons across a MetadataLoadContext are not always
        // resolvable via IsAssignableFrom; fall back to comparing the open generic
        // type identities so `IEnumerable<T>` matches `List<int>` etc.
        var receiverDefinition = receiverClrType.IsGenericType ? receiverClrType.GetGenericTypeDefinition() : receiverClrType;
        var candidateDefinition = effectiveReceiverType.IsGenericType ? effectiveReceiverType.GetGenericTypeDefinition() : effectiveReceiverType;
        return string.Equals(receiverDefinition.FullName, candidateDefinition.FullName, StringComparison.Ordinal);
    }

    private static int CountSameNamedMethods(System.Reflection.MethodInfo method)
    {
        var declaringType = method.DeclaringType;
        if (declaringType == null)
        {
            return 1;
        }

        var count = ClrTypeUtilities.SafeGetMethods(
                declaringType,
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Instance)
            .Count(m => string.Equals(m.Name, method.Name, StringComparison.Ordinal) && !m.IsSpecialName);
        return count > 0 ? count : 1;
    }

    private static bool IsIdentifierPart(char c)
    {
        return c == '_' || char.IsLetterOrDigit(c);
    }

    /// <summary>
    /// ADR-0106: per-tree collected syntax nodes that the model build and
    /// reference index need. Memoized by <see cref="SyntaxTree"/> instance so an
    /// edit only recollects the changed file's nodes (see <c>GetNodeBuckets</c>).
    /// </summary>
    internal sealed class NodeBuckets
    {
        public List<FunctionDeclarationSyntax> Functions { get; } = new();

        public List<ConstructorDeclarationSyntax> Constructors { get; } = new();

        public List<StructDeclarationSyntax> Structs { get; } = new();

        public List<AccessorExpressionSyntax> Accessors { get; } = new();

        public List<FieldAssignmentExpressionSyntax> FieldAssignments { get; } = new();

        public List<ForRangeStatementSyntax> ForRanges { get; } = new();

        public List<AwaitForRangeStatementSyntax> AwaitForRanges { get; } = new();

        public List<VariableDeclarationSyntax> VariableDeclarations { get; } = new();

        public List<TypeAliasDeclarationSyntax> TypeAliasDeclarations { get; } = new();
    }

    internal sealed class SemanticModel
    {
        private readonly Compilation compilation;
        private readonly Dictionary<SyntaxToken, Symbol> declarations;
        private readonly Dictionary<(string FileName, int SpanStart, int SpanEnd), Symbol> declarationsBySpan;
        private readonly Dictionary<string, Symbol> globals;
        private readonly Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations;
        private readonly object referencesLock = new object();
        private Dictionary<Symbol, List<SyntaxToken>> referencesIndex;

        // Cached tree-walk results. Resolve's fallback path used to call
        // FindNodes<FunctionDeclarationSyntax> and FindNodes<StructDeclarationSyntax>
        // for *every* unresolved token, re-walking every tree on each call. With
        // many tokens (and FindReferences calling Resolve per token, per member,
        // per CodeLens request) this dominated request latency. Precomputing the
        // per-tree node lists in BuildModelUncached makes those fallback paths
        // O(number of decls), not O(number of nodes across the workspace).
        // Per-file views keyed by file name. The Resolve fallback runs FindContainingFunction /
        // ResolveImplicitThisMember for *every* identifier token in *every* tree when the reference
        // index is built (CodeLens / FindReferences). Iterating a whole-workspace flat list per
        // token is O(tokens x decls) and took ~145s to build the index on a 54-file project.
        // Bucketing by file makes each token scan only its own file's declarations. Keyed by file
        // name (not tree instance) so interpolation-hole tokens — whose re-parsed sub-tree shares
        // the file name and uses absolute spans — land in the right bucket.
        private Dictionary<string, FunctionDeclarationSyntax[]> cachedFunctionsByFile;
        private Dictionary<string, ConstructorDeclarationSyntax[]> cachedConstructorsByFile;
        private Dictionary<string, StructDeclarationSyntax[]> cachedStructsByFile;
        private Dictionary<SyntaxTree, AccessorExpressionSyntax[]> cachedAccessorsByTree;
        private Dictionary<SyntaxTree, FieldAssignmentExpressionSyntax[]> cachedFieldAssignmentsByTree;
        private Dictionary<SyntaxTree, ForRangeStatementSyntax[]> cachedForRangesByTree;
        private Dictionary<SyntaxTree, AwaitForRangeStatementSyntax[]> cachedAwaitForRangesByTree;

        // (file, span) of every member-access identifier and field-assignment identifier. Resolve
        // runs ResolveAsMemberAccess + IsRightOfMemberAccess for *every* token; without this set
        // each non-member token (the vast majority) still scanned its file's accessors twice. An
        // O(1) span lookup lets non-member tokens bail out immediately, which is the dominant cost
        // of the reference-index build.
        private HashSet<(string, int, int)> memberAccessTokenSpans;
        private HashSet<(string, int, int)> fieldAssignmentTokenSpans;

        internal SemanticModel(
            Compilation compilation,
            Dictionary<SyntaxToken, Symbol> declarations,
            Dictionary<string, Symbol> globals,
            Dictionary<SyntaxNode, Dictionary<string, Symbol>> localDeclarations,
            IReadOnlyDictionary<SyntaxTree, NodeBuckets> bucketsByTree)
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

            // Per-tree node lists. Resolve's fallback chain and the reference index need
            // function/struct/accessor/field-assignment/for-range nodes. ADR-0106: these are
            // computed once per SyntaxTree instance and memoized (see GetNodeBuckets), so an
            // edit only re-walks the changed file's tree; here we just project the supplied
            // (already-cached) per-tree buckets into the lookup tables.
            var treeArray = this.compilation.SyntaxTrees.ToArray();
            var buckets = new NodeBuckets[treeArray.Length];
            for (var i = 0; i < treeArray.Length; i++)
            {
                buckets[i] = bucketsByTree.TryGetValue(treeArray[i], out var b) ? b : GetNodeBuckets(treeArray[i], useCache: false);
            }

            this.cachedAccessorsByTree = new Dictionary<SyntaxTree, AccessorExpressionSyntax[]>(treeArray.Length);
            this.cachedFieldAssignmentsByTree = new Dictionary<SyntaxTree, FieldAssignmentExpressionSyntax[]>(treeArray.Length);
            this.cachedForRangesByTree = new Dictionary<SyntaxTree, ForRangeStatementSyntax[]>(treeArray.Length);
            this.cachedAwaitForRangesByTree = new Dictionary<SyntaxTree, AwaitForRangeStatementSyntax[]>(treeArray.Length);
            var functionsByFile = new Dictionary<string, List<FunctionDeclarationSyntax>>();
            var constructorsByFile = new Dictionary<string, List<ConstructorDeclarationSyntax>>();
            var structsByFile = new Dictionary<string, List<StructDeclarationSyntax>>();
            this.memberAccessTokenSpans = new HashSet<(string, int, int)>();
            this.fieldAssignmentTokenSpans = new HashSet<(string, int, int)>();

            for (var i = 0; i < treeArray.Length; i++)
            {
                var tree = treeArray[i];
                var bucket = buckets[i];
                this.cachedAccessorsByTree[tree] = bucket.Accessors.ToArray();
                this.cachedFieldAssignmentsByTree[tree] = bucket.FieldAssignments.ToArray();
                this.cachedForRangesByTree[tree] = bucket.ForRanges.ToArray();
                this.cachedAwaitForRangesByTree[tree] = bucket.AwaitForRanges.ToArray();

                var fileName = tree.Text?.FileName ?? string.Empty;
                if (bucket.Functions.Count > 0)
                {
                    if (!functionsByFile.TryGetValue(fileName, out var fns))
                    {
                        fns = new List<FunctionDeclarationSyntax>();
                        functionsByFile[fileName] = fns;
                    }

                    fns.AddRange(bucket.Functions);
                }

                if (bucket.Constructors.Count > 0)
                {
                    if (!constructorsByFile.TryGetValue(fileName, out var ctors))
                    {
                        ctors = new List<ConstructorDeclarationSyntax>();
                        constructorsByFile[fileName] = ctors;
                    }

                    ctors.AddRange(bucket.Constructors);
                }

                if (bucket.Structs.Count > 0)
                {
                    if (!structsByFile.TryGetValue(fileName, out var sts))
                    {
                        sts = new List<StructDeclarationSyntax>();
                        structsByFile[fileName] = sts;
                    }

                    sts.AddRange(bucket.Structs);
                }

                foreach (var accessor in bucket.Accessors)
                {
                    foreach (var memberToken in EnumerateAccessorMemberTokens(accessor.RightPart))
                    {
                        var key = SpanKey(memberToken);
                        if (key.HasValue)
                        {
                            this.memberAccessTokenSpans.Add(key.Value);
                        }
                    }
                }

                foreach (var assign in bucket.FieldAssignments)
                {
                    var key = SpanKey(assign.FieldIdentifier);
                    if (key.HasValue)
                    {
                        this.fieldAssignmentTokenSpans.Add(key.Value);
                    }
                }
            }

            this.cachedFunctionsByFile = functionsByFile.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.ToArray());
            this.cachedConstructorsByFile = constructorsByFile.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.ToArray());
            this.cachedStructsByFile = structsByFile.ToDictionary(kvp => kvp.Key, kvp => kvp.Value.ToArray());
        }

        /// <summary>Gets a snapshot of the global name → symbol map. ADR-0106 test hook.</summary>
        internal IReadOnlyDictionary<string, Symbol> GlobalsSnapshot => this.globals;

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

            // Issue #894: a token inside an `init(...)` constructor body resolves
            // its parameters and body locals against the constructor's local
            // scope, mirroring the method-body path above.
            var constructor = this.FindContainingConstructor(token);
            if (constructor != null && this.localDeclarations.TryGetValue(constructor, out var ctorLocals) && ctorLocals.TryGetValue(token.Text, out var ctorLocal))
            {
                return ctorLocal;
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

        public IReadOnlyList<SyntaxToken> GetReferences(Symbol target, CancellationToken ct = default)
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
                        this.referencesIndex = this.BuildReferencesIndex(ct);
                    }

                    index = this.referencesIndex;
                }
            }

            return index.TryGetValue(target, out var tokens) ? tokens : (IReadOnlyList<SyntaxToken>)Array.Empty<SyntaxToken>();
        }

        private Dictionary<Symbol, List<SyntaxToken>> BuildReferencesIndex(CancellationToken ct = default)
        {
            // Resolving every identifier token in the workspace is the dominant cost of the index
            // build (the only thing that touches the model is read-only — all lookup tables are
            // built once in the constructor — so the per-tree walks are independent). Resolve them
            // in parallel across trees, then merge the per-tree partials in tree order to preserve
            // a stable reference ordering.
            var trees = this.compilation.SyntaxTrees;
            var partials = new Dictionary<Symbol, List<SyntaxToken>>[trees.Length];

            // Parallel.For observes ct itself (aborting in-flight iterations with
            // OperationCanceledException) so a superseded hover/definition/references/
            // rename request aborts the cold whole-workspace index build instead of
            // running it to completion (issue #1662).
            System.Threading.Tasks.Parallel.For(0, trees.Length, new ParallelOptions { CancellationToken = ct }, i =>
            {
                var local = new Dictionary<Symbol, List<SyntaxToken>>();
                foreach (var token in EnumerateTokens(trees[i].Root))
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

                    if (!local.TryGetValue(symbol, out var list))
                    {
                        list = new List<SyntaxToken>();
                        local[symbol] = list;
                    }

                    list.Add(token);
                }

                partials[i] = local;
            });

            var index = new Dictionary<Symbol, List<SyntaxToken>>();
            foreach (var partial in partials)
            {
                foreach (var pair in partial)
                {
                    if (!index.TryGetValue(pair.Key, out var list))
                    {
                        list = new List<SyntaxToken>();
                        index[pair.Key] = list;
                    }

                    list.AddRange(pair.Value);
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

        private static IEnumerable<SyntaxToken> EnumerateAccessorMemberTokens(ExpressionSyntax rightPart)
        {
            switch (rightPart)
            {
                case NameExpressionSyntax name:
                    yield return name.IdentifierToken;
                    break;
                case CallExpressionSyntax call:
                    yield return call.Identifier;
                    break;
                case AccessorExpressionSyntax nested:
                    foreach (var t in EnumerateAccessorMemberTokens(nested.LeftPart))
                    {
                        yield return t;
                    }

                    foreach (var t in EnumerateAccessorMemberTokens(nested.RightPart))
                    {
                        yield return t;
                    }

                    break;
            }
        }

        private static Symbol LookupMember(StructSymbol structSymbol, string memberName)
        {
            // ADR-0112: shared canonical member lookup (see TypeMemberModel).
            return TypeMemberModel.LookupMember(structSymbol, memberName, MemberQuery.All);
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
            var fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty;
            if (!this.cachedStructsByFile.TryGetValue(fileName, out var structs))
            {
                return null;
            }

            foreach (var decl in structs)
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

                // Issue #894: `init(...)` constructor bodies also have an implicit
                // `this` receiver, so a bare member reference (e.g. `Area = ...`)
                // inside a constructor must resolve to the class member just like
                // it does inside a method body.
                foreach (var constructor in decl.Constructors)
                {
                    if (constructor.Body == null)
                    {
                        continue;
                    }

                    if (constructor.Body.Span.Start <= token.Span.Start
                        && token.Span.End <= constructor.Body.Span.End
                        && constructor.Body.Span.Length < enclosingBodyLength)
                    {
                        enclosing = decl;
                        enclosingBodyLength = constructor.Body.Span.Length;
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
            // Cheap text-free check used to suppress fallback lookups. A token whose span is the
            // member identifier of an AccessorExpressionSyntax or the field identifier of a
            // FieldAssignmentExpressionSyntax is treated as a member name, and must not be
            // resolved by name as a local or global. Backed by the precomputed O(1) span sets.
            var spanKey = SpanKey(token);
            if (!spanKey.HasValue)
            {
                return false;
            }

            return this.memberAccessTokenSpans.Contains(spanKey.Value)
                || this.fieldAssignmentTokenSpans.Contains(spanKey.Value);
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
            if (token?.SyntaxTree == null || token.Kind != SyntaxKind.IdentifierToken)
            {
                return null;
            }

            // A token physically lives in exactly one file, so its enclosing member-access
            // expression is in that same tree (or, for an interpolation hole, the hole's
            // re-parsed sub-tree which the token already points at). Scanning every compilation
            // tree here was both wrong (spans are per-file offsets) and O(tokens x all-accessors)
            // — it made the reference-index build take ~145s on a 54-file project.
            var tree = token.SyntaxTree;

            // Fast path: the vast majority of tokens are not member-access targets. An O(1) span
            // check lets them bail out before scanning the file's accessors/assignments.
            var spanKey = SpanKey(token);
            if (!spanKey.HasValue
                || (!this.memberAccessTokenSpans.Contains(spanKey.Value) && !this.fieldAssignmentTokenSpans.Contains(spanKey.Value)))
            {
                return null;
            }

            foreach (var accessor in this.GetAccessorsForTree(tree)
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
            var fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty;
            if (!this.cachedFunctionsByFile.TryGetValue(fileName, out var functions))
            {
                return null;
            }

            foreach (var f in functions)
            {
                if (f.Span.Start <= token.Span.Start && token.Span.End <= f.Span.End && f.Span.Length < bestLength)
                {
                    best = f;
                    bestLength = f.Span.Length;
                }
            }

            return best;
        }

        private ConstructorDeclarationSyntax FindContainingConstructor(SyntaxToken token)
        {
            ConstructorDeclarationSyntax best = null;
            var bestLength = int.MaxValue;
            var fileName = token.SyntaxTree?.Text?.FileName ?? string.Empty;
            if (!this.cachedConstructorsByFile.TryGetValue(fileName, out var constructors))
            {
                return null;
            }

            foreach (var c in constructors)
            {
                if (c.Span.Start <= token.Span.Start && token.Span.End <= c.Span.End && c.Span.Length < bestLength)
                {
                    best = c;
                    bestLength = c.Span.Length;
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
