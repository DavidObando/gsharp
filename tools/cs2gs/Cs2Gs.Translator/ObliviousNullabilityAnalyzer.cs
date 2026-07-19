// <copyright file="ObliviousNullabilityAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #2113: a whole-program, symbol-keyed null-TAINT analysis for a
/// nullable-<em>oblivious</em> compilation (one whose
/// <see cref="CSharpCompilationOptions.NullableContextOptions"/> is
/// <see cref="NullableContextOptions.Disable"/>).
///
/// <para>
/// In oblivious C# Roslyn reports every reference type as
/// <c>NullableAnnotation.None</c> with no flow state, so the translator
/// cannot tell a "definitely non-null" declaration apart from a "maybe null"
/// one (<c>NullableAnnotation.None</c> with no flow state). Mapping every
/// oblivious reference `T` to a non-null G# `T` then collides
/// with the `T?` values cs2gs legitimately introduces (`?.`, `= null` defaults,
/// nullable-returning BCL members), producing a cluster of GS0154/0155/0156
/// "T? vs T" errors. Mapping every oblivious reference to `T?` instead over-
/// promotes and forces a use-site explosion of `!!` assertions and idiomatic
/// non-null decls become nullable.
/// </para>
///
/// <para>
/// This analyzer instead decides, per reference-type declaration symbol S
/// (field / auto-property / parameter / method-return / local), whether S is
/// null-TAINTED. A tainted S is rendered `T?`; an untainted S stays non-null
/// `T` (the idiomatic default). Taint is seeded from direct null evidence
/// (== null, = null, ??=, is null, `?.`, `= null|default` initializers,
/// nullable-returning BCL members, and `return null` paths) and then propagated
/// to a fixpoint along assignment / initializer / return edges: if S is
/// assigned/initialized/returned a value that reads a tainted symbol or calls a
/// tainted method's return, S becomes tainted too.
/// </para>
///
/// <para>
/// The whole result is keyed on the declaration's <see cref="ISymbol"/> and is
/// consulted ONLY at declaration sites (see
/// <c>CSharpToGSharpTranslator.DeclarationVisitor.IsPromotedToNullableReference</c>
/// and the method-return path), so name positions (typeof/construction/base
/// list) and — because the analyzer never runs for a nullable-enabled
/// compilation — enabled projects are provably untouched.
/// </para>
/// </summary>
internal static class ObliviousNullabilityAnalyzer
{
    // Keyed by Compilation identity so an edited/new compilation naturally gets
    // a fresh entry and stale ones are collectible — same pattern as the
    // subclassed-base-types / partial-type-parts caches in the translator.
    private static readonly ConditionalWeakTable<Compilation, TaintResult> Cache = new();

    // Which source expressions a transitive return/forwarding edge follows.
    private enum SourceScope
    {
        // Follow method-call returns AND every value declaration the value
        // reads (fields, properties, locals, parameters). Default for method /
        // local-function / lambda return seeding.
        AllSources,

        // Follow ONLY method-call returns (`m(args)`); plain identifier/member
        // forwarding is skipped. Property-getter contract guardrail path where
        // no forwarding may be followed.
        CallsOnly,

        // Follow method-call returns AND field/local/parameter forwarding, but
        // NOT property forwarding. Used for a NON-CONTRACT property getter
        // (issue #914 oblivious sink): `TextWriter Writer => logStreamWriter;`
        // over a promoted `StreamWriter?` backing FIELD must itself be `T?`,
        // yet `string Forward => Work;` forwarding another PROPERTY must keep
        // its declared type and rely on the null-forgiveness `!!` pass, so the
        // property contract with #1354 / #2167 is preserved.
        CallsAndNonPropertyDeclarations,
    }

    /// <summary>
    /// Whether <paramref name="symbol"/> (a declaration symbol: field / property
    /// / parameter / local, or a method whose RETURN is under test) is
    /// null-tainted in <paramref name="compilation"/>. Always returns
    /// <see langword="false"/> for a non-oblivious (nullable-enabled) compilation
    /// — the analysis never runs there, so enabled projects are untouched.
    /// </summary>
    /// <param name="compilation">The C# compilation being translated.</param>
    /// <param name="symbol">The declaration symbol to test.</param>
    /// <returns><see langword="true"/> when the symbol is null-tainted.</returns>
    public static bool IsTainted(CSharpCompilation compilation, ISymbol symbol)
    {
        if (symbol == null ||
            compilation == null ||
            compilation.Options.NullableContextOptions != NullableContextOptions.Disable)
        {
            return false;
        }

        return Cache.GetValue(compilation, Compute).Tainted.Contains(Canonical(symbol));
    }

    /// <summary>
    /// Issue #2412: cross-project overload of <see cref="IsTainted(CSharpCompilation, ISymbol)"/>.
    /// <paramref name="compilation"/>'s own whole-program taint fixpoint only
    /// walks ITS OWN syntax trees, so it never sees a referenced sibling
    /// project's tainting evidence — even for a symbol DECLARED in
    /// <paramref name="compilation"/> itself, when that evidence is an
    /// interface-implementation edge (issue #2285) recorded only inside a
    /// sibling project's own fixpoint (the sibling's own source types are the
    /// ones implementing the interface). This tries <paramref name="compilation"/>
    /// first (byte-identical to the two-argument overload for every existing,
    /// single-compilation caller — an empty or <see langword="null"/>
    /// <paramref name="siblingCompilations"/> reduces to exactly that), then
    /// each of <paramref name="siblingCompilations"/> in the supplied
    /// (deterministic) order, returning <see langword="true"/> on the first
    /// compilation whose OWN cached <see cref="Compute"/> result proves the
    /// symbol tainted. A symbol declared in — or seeded/propagated from — ANY
    /// ONE known project's own source is a single global fact once true, so
    /// this is a plain existential OR: each candidate's result is computed
    /// (and cached, same <see cref="Cache"/>) independently and exactly once
    /// regardless of how many times this overload is called, keeping repeated
    /// per-document queries within one run, and across a project translated
    /// both standalone and as a sibling, consistent and cheap.
    /// <para>
    /// Deliberately scoped to <paramref name="symbol"/> ITSELF (plus its
    /// remapped counterpart in each sibling) — never a same-compilation
    /// backward walk through <paramref name="compilation"/>'s own assignment
    /// edges to some OTHER, indirectly-connected declaration. Issue #2412's
    /// own worked example is explicit that the fix must insert `!!`
    /// forgiveness AT THE CONSUMPTION SITE while leaving the consuming
    /// project's OWN declarations (e.g. an object-initializer target
    /// property) untouched — confirmed empirically: even a fully MERGED
    /// single-compilation version of the exact LibA/LibB repro promotes the
    /// object-initializer TARGET property's own declared type too (the
    /// existing, pre-#2412 edge-based fixpoint already treats "declaration
    /// type is the join of every direct assignment" uniformly for locals,
    /// fields, AND properties alike) — a broader, transitively-propagating
    /// design here would branch further from that minimal, explicitly-scoped
    /// request than necessary, and would let ONE cross-project call site's
    /// taint silently repaint an unrelated declaration's own type everywhere
    /// else it is used in the consuming project.
    /// </para>
    /// </summary>
    /// <param name="compilation">The compilation of the translation unit asking about <paramref name="symbol"/>.</param>
    /// <param name="symbol">The declaration symbol to test.</param>
    /// <param name="siblingCompilations">
    /// Every other project's own compilation loaded in the same migration run
    /// (<see cref="TranslationContext.SiblingCompilations"/>), or
    /// <see langword="null"/> when none is known.
    /// </param>
    /// <returns><see langword="true"/> when any known compilation's own analysis proves the symbol null-tainted.</returns>
    public static bool IsTainted(
        CSharpCompilation compilation,
        ISymbol symbol,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        if (IsTainted(compilation, symbol))
        {
            return true;
        }

        if (symbol == null || siblingCompilations == null)
        {
            return false;
        }

        foreach (CSharpCompilation sibling in siblingCompilations)
        {
            if (sibling == null || ReferenceEquals(sibling, compilation))
            {
                continue;
            }

            // A symbol resolved through one compilation's semantic model and
            // the "same" declaration resolved directly in the compilation that
            // actually owns it are NOT `SymbolEqualityComparer.Default`-equal
            // across two independently-bound `CSharpCompilation`s linked only
            // by a `CompilationReference` (confirmed empirically: two separate
            // `CSharpCompilation.Create` calls each mint their own distinct
            // `IAssemblySymbol` wrapper for the "same" referenced assembly, so
            // even `ContainingAssembly` differs) — this is true of the exact
            // `LoadProjectWithReferencesAsync` shape too (a separate
            // `BuildLoadedProjectAsync`/`GetCompilationAsync` call per project).
            // So `IsTainted(sibling, symbol)` alone would only ever match a
            // symbol whose OWN declaring compilation happens to be `sibling`
            // itself — remap `symbol` to ITS OWN symbol in `sibling`'s symbol
            // table (by stable metadata identity: containing type's fully
            // qualified metadata name + member name/arity, not object/CLR
            // symbol identity) and test that remapped symbol against
            // `sibling`'s own cached result instead.
            ISymbol remapped = RemapToCompilation(sibling, symbol);
            if (remapped != null && IsTainted(sibling, remapped))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether one reference-typed leaf inside a tuple-valued declaration is
    /// null-tainted. Tuple leaves are tracked independently so evidence for
    /// one element never widens its siblings.
    /// </summary>
    /// <param name="compilation">The compilation containing the query.</param>
    /// <param name="symbol">The tuple-valued declaration symbol.</param>
    /// <param name="elementPath">Zero-based indexes from the outer tuple to the leaf.</param>
    /// <param name="siblingCompilations">Other compilations loaded in the same translation run.</param>
    /// <returns><see langword="true"/> when the selected tuple leaf is null-tainted.</returns>
    public static bool IsTupleElementTainted(
        CSharpCompilation compilation,
        ISymbol symbol,
        IReadOnlyList<int> elementPath,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        if (symbol == null
            || elementPath == null
            || elementPath.Count == 0
            || compilation == null
            || compilation.Options.NullableContextOptions != NullableContextOptions.Disable)
        {
            return false;
        }

        return IsTupleElementTaintedCore(
            compilation,
            Canonical(symbol),
            EncodeTuplePath(elementPath),
            siblingCompilations,
            new HashSet<TupleElementQuery>(TupleElementQueryComparer.Instance));
    }

    private static bool IsTupleElementTaintedCore(
        CSharpCompilation compilation,
        ISymbol symbol,
        string path,
        IReadOnlyList<CSharpCompilation> siblingCompilations,
        HashSet<TupleElementQuery> visited)
    {
        var key = new TupleElementKey(symbol, path);
        if (!visited.Add(new TupleElementQuery(compilation, key)))
        {
            return false;
        }

        TaintResult result = Cache.GetValue(compilation, Compute);
        if (result.TupleTainted.Contains(key))
        {
            return true;
        }

        foreach ((TupleElementKey target, ISymbol source) in result.TupleScalarEdges)
        {
            if (TupleElementKeyComparer.Instance.Equals(target, key)
                && IsTainted(compilation, source, siblingCompilations))
            {
                return true;
            }
        }

        foreach ((TupleElementKey target, TupleElementKey source) in result.TupleEdges)
        {
            if (TupleElementKeyComparer.Instance.Equals(target, key)
                && IsTupleElementTaintedCore(
                    compilation,
                    source.Symbol,
                    source.Path,
                    siblingCompilations,
                    visited))
            {
                return true;
            }
        }

        if (siblingCompilations != null)
        {
            foreach (CSharpCompilation sibling in siblingCompilations)
            {
                if (sibling == null
                    || ReferenceEquals(sibling, compilation)
                    || sibling.Options.NullableContextOptions != NullableContextOptions.Disable)
                {
                    continue;
                }

                ISymbol remapped = RemapToCompilation(sibling, symbol);
                if (remapped != null
                    && IsTupleElementTaintedCore(
                        sibling,
                        Canonical(remapped),
                        path,
                        siblingCompilations,
                        visited))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Finds the symbol in <paramref name="targetCompilation"/>'s own symbol
    /// table that is the "same" declaration as <paramref name="symbol"/>,
    /// which may have been resolved through an entirely different
    /// <see cref="CSharpCompilation"/>. Matching is by stable metadata
    /// identity (containing type's fully qualified metadata name plus member
    /// name/kind/arity), never by <see cref="SymbolEqualityComparer"/> or CLR
    /// object identity, since those do not hold across independently bound
    /// compilations (see the long comment on the calling overload). Returns
    /// <see langword="null"/> when no matching declaration exists in
    /// <paramref name="targetCompilation"/> (e.g. `symbol` is unrelated to it).
    /// </summary>
    private static ISymbol RemapToCompilation(Compilation targetCompilation, ISymbol symbol)
    {
        if (symbol is IParameterSymbol parameter)
        {
            ISymbol remappedOwner = RemapMemberOwner(targetCompilation, parameter.ContainingSymbol);
            return remappedOwner switch
            {
                IMethodSymbol method when parameter.Ordinal < method.Parameters.Length =>
                    method.Parameters[parameter.Ordinal],
                IPropertySymbol indexer when parameter.Ordinal < indexer.Parameters.Length =>
                    indexer.Parameters[parameter.Ordinal],
                _ => null,
            };
        }

        return RemapMemberOwner(targetCompilation, symbol);
    }

    /// <summary>
    /// Remaps a field/property/method/local-owning member symbol (everything
    /// <see cref="RemapToCompilation"/> handles other than parameters
    /// themselves) into <paramref name="targetCompilation"/>'s own symbol
    /// table by metadata name. Locals have no stable cross-compilation
    /// identity (they only ever make sense within the one method body/one
    /// compilation that declares them), so they intentionally fall through to
    /// <see langword="null"/> here.
    /// </summary>
    private static ISymbol RemapMemberOwner(Compilation targetCompilation, ISymbol symbol)
    {
        if (symbol == null)
        {
            return null;
        }

        INamedTypeSymbol containingType = symbol.ContainingType;
        if (containingType == null)
        {
            return null;
        }

        INamedTypeSymbol remappedType = targetCompilation.GetTypeByMetadataName(MetadataTypeName(containingType));
        if (remappedType == null)
        {
            return null;
        }

        if (symbol is IMethodSymbol method)
        {
            return remappedType.GetMembers(method.Name)
                .OfType<IMethodSymbol>()
                .FirstOrDefault(candidate =>
                    candidate.IsStatic == method.IsStatic &&
                    candidate.Parameters.Length == method.Parameters.Length &&
                    candidate.TypeParameters.Length == method.TypeParameters.Length);
        }

        return remappedType.GetMembers(symbol.Name).FirstOrDefault(candidate => candidate.Kind == symbol.Kind);
    }

    /// <summary>
    /// Builds the CLR metadata name (e.g. <c>Outer+Inner`1</c> within its
    /// namespace) that <see cref="Compilation.GetTypeByMetadataName"/> expects,
    /// walking outward through nested-type containment so nested types (which
    /// <c>MetadataName</c> alone does not capture) are found too.
    /// </summary>
    private static string MetadataTypeName(INamedTypeSymbol type)
    {
        var parts = new List<string>();
        for (INamedTypeSymbol current = type; current != null; current = current.ContainingType)
        {
            parts.Insert(0, current.MetadataName);
        }

        string nested = string.Join("+", parts);
        return type.ContainingNamespace is { IsGlobalNamespace: false } ns
            ? ns.ToDisplayString() + "." + nested
            : nested;
    }

    private static TaintResult Compute(Compilation compilation)
    {
        var tainted = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var tupleTainted = new HashSet<TupleElementKey>(TupleElementKeyComparer.Instance);

        // Transitive edges: (target <- source). If `source` is tainted then
        // `target` becomes tainted. Both are canonicalized declaration symbols
        // (field/property/parameter/local for a value target; method for a
        // return target; field/property/parameter/local/method for a source).
        var edges = new List<(ISymbol Target, ISymbol Source)>();
        var tupleEdges = new List<(TupleElementKey Target, TupleElementKey Source)>();
        var tupleScalarEdges = new List<(TupleElementKey Target, ISymbol Source)>();
        var scalarTupleEdges = new List<(ISymbol Target, TupleElementKey Source)>();

        foreach (SyntaxTree tree in compilation.SyntaxTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            SyntaxNode root = tree.GetRoot();

            foreach (SyntaxNode node in root.DescendantNodes())
            {
                SeedDirectTaint(node, model, tainted);
                CollectEdges(node, model, tainted, edges);
            }

            // Method / accessor / local-function RETURN taint: a `return null`,
            // `return default`, or `return <nullable-expr>` path taints the
            // enclosing member's return symbol; a non-directly-null `return`
            // records a transitive edge from the return symbol to the returned
            // value's source.
            SeedReturnTaint(root, model, tainted, edges);
            CollectTupleFlows(
                root,
                model,
                tainted,
                edges,
                tupleTainted,
                tupleEdges,
                tupleScalarEdges,
                scalarTupleEdges);
        }

        // Issue #2285: an interface member and every member that implements it
        // (across the whole compilation) must reach the SAME tainted-ness, so
        // cs2gs never promotes one endpoint (e.g. a record's primary-ctor
        // parameter) to `T?` while leaving the other (the interface property it
        // satisfies) non-null `T` — see <see cref="CollectInterfaceImplementationEdges"/>.
        CollectInterfaceImplementationEdges(compilation, edges);
        CollectTupleContractEdges(compilation, tupleTainted, tupleEdges);

        // Fixpoint: propagate taint along the edge set until it stabilizes.
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach ((ISymbol target, ISymbol source) in edges)
            {
                if (!tainted.Contains(target) && tainted.Contains(source))
                {
                    tainted.Add(target);
                    changed = true;
                }
            }

            foreach ((TupleElementKey target, ISymbol source) in tupleScalarEdges)
            {
                if (!tupleTainted.Contains(target) && tainted.Contains(source))
                {
                    tupleTainted.Add(target);
                    changed = true;
                }
            }

            foreach ((ISymbol target, TupleElementKey source) in scalarTupleEdges)
            {
                if (!tainted.Contains(target) && tupleTainted.Contains(source))
                {
                    tainted.Add(target);
                    changed = true;
                }
            }

            foreach ((TupleElementKey target, TupleElementKey source) in tupleEdges)
            {
                if (!tupleTainted.Contains(target) && tupleTainted.Contains(source))
                {
                    tupleTainted.Add(target);
                    changed = true;
                }
            }
        }

        return new TaintResult(
            tainted,
            tupleTainted,
            tupleEdges,
            tupleScalarEdges);
    }

    // Seeds direct null evidence for a value declaration symbol (field /
    // property / parameter / local): the exact forms the translator's local
    // ComputeIsUsedAsNullable / IsNullableInitializer already recognize, applied
    // whole-program.
    private static void SeedDirectTaint(
        SyntaxNode node,
        SemanticModel model,
        HashSet<ISymbol> tainted)
    {
        switch (node)
        {
            // `x == null` / `null == x` / `x != null` / `null != x`.
            case BinaryExpressionSyntax binary
                when binary.IsKind(SyntaxKind.EqualsExpression)
                    || binary.IsKind(SyntaxKind.NotEqualsExpression):
                if (IsNullLiteral(binary.Right))
                {
                    TaintTarget(binary.Left, model, tainted);
                }
                else if (IsNullLiteral(binary.Left))
                {
                    TaintTarget(binary.Right, model, tainted);
                }

                break;

            // `x = null` / `x = null!`.
            case AssignmentExpressionSyntax assign
                when assign.IsKind(SyntaxKind.SimpleAssignmentExpression)
                    && IsNullOrSuppressedNull(assign.Right):
                TaintTarget(assign.Left, model, tainted);
                break;

            // `x ??= y`: `x` is a legal `??=` target only if it is nullable.
            case AssignmentExpressionSyntax coalesceAssign
                when coalesceAssign.IsKind(SyntaxKind.CoalesceAssignmentExpression):
                TaintTarget(coalesceAssign.Left, model, tainted);
                break;

            // `x is null` / `x is not null`.
            case IsPatternExpressionSyntax isPattern
                when IsNullConstantPattern(isPattern.Pattern):
                TaintTarget(isPattern.Expression, model, tainted);
                break;

            // `x?.M` / `x?[i]`: the receiver before the `?` is nullable.
            case ConditionalAccessExpressionSyntax conditionalAccess:
                TaintTarget(conditionalAccess.Expression, model, tainted);
                break;

            // `T x = null|default`, `field = null|default`, parameter `= null`.
            case VariableDeclaratorSyntax declarator
                when declarator.Initializer != null:
                if (model.GetDeclaredSymbol(declarator) is ISymbol declared
                    && IsValueDeclarationSymbol(declared)
                    && IsDirectlyNullable(declarator.Initializer.Value, model))
                {
                    tainted.Add(Canonical(declared));
                }

                break;

            case PropertyDeclarationSyntax property
                when property.Initializer != null:
                if (model.GetDeclaredSymbol(property) is IPropertySymbol propertySymbol
                    && IsDirectlyNullable(property.Initializer.Value, model))
                {
                    tainted.Add(Canonical(propertySymbol));
                }

                break;

            case ParameterSyntax parameter
                when parameter.Default != null:
                if (model.GetDeclaredSymbol(parameter) is IParameterSymbol parameterSymbol
                    && IsDirectlyNullable(parameter.Default.Value, model))
                {
                    tainted.Add(Canonical(parameterSymbol));
                }

                break;
        }
    }

    // Records transitive taint edges for the assignment / initializer forms
    // whose RHS is not itself directly-null but reads another declaration.
    private static void CollectEdges(
        SyntaxNode node,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        // Interprocedural parameter taint: an argument that is directly null or
        // reads a (possibly tainted) declaration flows to the bound parameter, so
        // a parameter that ever receives null becomes `T?` too. This keeps a
        // pass-through call `Callee(maybeNull)` from demanding a non-null
        // parameter (GS0154) once `maybeNull` is promoted.
        //
        // Issue #914 (oblivious sink): a constructor initializer delegation
        // (`: this(...)` / `: base(...)`) is an argument-passing call site too.
        // A convenience initializer that forwards its own (possibly promoted)
        // parameters to the designated initializer — e.g. `LogMessage(string
        // context, string message) : this(DateTime.Now, threadId, context,
        // message)` where `context`/`message` are themselves promoted `string?`
        // — must promote the designated initializer's matching parameters, else
        // the delegating call demands a non-null value (GS0154). Roslyn models a
        // constructor initializer as an `IInvocationOperation`, so it flows
        // through the same argument→parameter edge collection.
        if (node is InvocationExpressionSyntax
            or ObjectCreationExpressionSyntax
            or ConstructorInitializerSyntax)
        {
            CollectArgumentEdges(node, model, tainted, edges);
        }

        switch (node)
        {
            case AssignmentExpressionSyntax assign
                when assign.IsKind(SyntaxKind.SimpleAssignmentExpression):
                ISymbol assignTarget = ResolveAssignable(assign.Left, model);
                if (assignTarget != null)
                {
                    // A declaration's emitted type is the JOIN over its
                    // initializer AND every assignment to it. A later `lhs =
                    // <nullable>` (e.g. `id = mo["ProcessorID"]!!.ToString()`,
                    // where `object.ToString()` is declared `string?`) therefore
                    // promotes `lhs` even when the declaration's initializer was
                    // non-null (issue #2167, the `var` local-join case). A
                    // directly-nullable RHS taints immediately; any other RHS
                    // records a transitive edge so a nullable source propagates.
                    if (IsDirectlyNullable(assign.Right, model))
                    {
                        tainted.Add(assignTarget);
                    }
                    else
                    {
                        AddEdges(assignTarget, assign.Right, model, edges);
                    }
                }

                break;

            case VariableDeclaratorSyntax declarator
                when declarator.Initializer != null:
                if (model.GetDeclaredSymbol(declarator) is ISymbol declared
                    && IsValueDeclarationSymbol(declared)
                    && !IsDirectlyNullable(declarator.Initializer.Value, model))
                {
                    AddEdges(Canonical(declared), declarator.Initializer.Value, model, edges);
                }

                break;

            case PropertyDeclarationSyntax property
                when property.Initializer != null:
                if (model.GetDeclaredSymbol(property) is IPropertySymbol propertySymbol
                    && !IsDirectlyNullable(property.Initializer.Value, model))
                {
                    AddEdges(Canonical(propertySymbol), property.Initializer.Value, model, edges);
                }

                break;
        }
    }

    // Interprocedural: map each call argument to its bound parameter and add a
    // taint edge (or a direct taint for a directly-null argument), so a parameter
    // that ever receives a nullable value is itself promoted to `T?`.
    private static void CollectArgumentEdges(
        SyntaxNode call,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        ImmutableArray<IArgumentOperation> arguments = model.GetOperation(call) switch
        {
            IInvocationOperation invocation => invocation.Arguments,
            IObjectCreationOperation creation => creation.Arguments,
            _ => default,
        };

        if (arguments.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (IArgumentOperation argument in arguments)
        {
            if (argument.Parameter is not IParameterSymbol parameter
                || argument.Value?.Syntax is not ExpressionSyntax value)
            {
                continue;
            }

            ISymbol parameterSymbol = Canonical(parameter);
            if (IsDirectlyNullable(value, model))
            {
                tainted.Add(parameterSymbol);
            }
            else
            {
                AddEdges(parameterSymbol, value, model, edges);
            }
        }
    }

    // Issue #2469: tuple-valued declarations need the same direct/transitive
    // evidence graph as scalar declarations, but keyed by an element path.
    // This pass covers tuple literals, nested tuples, conditionals/switches,
    // tuple locals/parameters/properties, calls, and deconstruction.
    private static void CollectTupleFlows(
        SyntaxNode root,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
        List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges,
        List<(ISymbol Target, TupleElementKey Source)> scalarTupleEdges)
    {
        foreach (SyntaxNode node in root.DescendantNodes())
        {
            switch (node)
            {
                case MethodDeclarationSyntax method:
                    CollectTupleReturnFlows(
                        model.GetDeclaredSymbol(method),
                        method.ExpressionBody?.Expression,
                        method.Body,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges);
                    break;

                case LocalFunctionStatementSyntax localFunction:
                    CollectTupleReturnFlows(
                        model.GetDeclaredSymbol(localFunction),
                        localFunction.ExpressionBody?.Expression,
                        localFunction.Body,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges);
                    break;

                case PropertyDeclarationSyntax property:
                    IPropertySymbol propertySymbol = model.GetDeclaredSymbol(property);
                    if (TryGetTupleType(propertySymbol, out INamedTypeSymbol propertyTuple))
                    {
                        if (property.Initializer?.Value is ExpressionSyntax initializer)
                        {
                            CollectTupleValueFlow(
                                Canonical(propertySymbol),
                                propertyTuple,
                                initializer,
                                model,
                                string.Empty,
                                tupleTainted,
                                tupleEdges,
                                tupleScalarEdges);
                        }

                        CollectTupleGetterFlows(
                            propertySymbol,
                            propertyTuple,
                            property.ExpressionBody?.Expression,
                            property.AccessorList,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges);
                    }

                    break;

                case IndexerDeclarationSyntax indexer:
                    IPropertySymbol indexerSymbol = model.GetDeclaredSymbol(indexer);
                    if (TryGetTupleType(indexerSymbol, out INamedTypeSymbol indexerTuple))
                    {
                        CollectTupleGetterFlows(
                            indexerSymbol,
                            indexerTuple,
                            indexer.ExpressionBody?.Expression,
                            indexer.AccessorList,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges);
                    }

                    break;

                case VariableDeclaratorSyntax declarator
                    when declarator.Initializer?.Value is ExpressionSyntax initializer:
                    ISymbol declared = model.GetDeclaredSymbol(declarator);
                    if (TryGetTupleType(declared, out INamedTypeSymbol declaredTuple))
                    {
                        CollectTupleValueFlow(
                            Canonical(declared),
                            declaredTuple,
                            initializer,
                            model,
                            string.Empty,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges);
                    }

                    break;

                case AssignmentExpressionSyntax assignment
                    when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression):
                    ISymbol target = ResolveAssignable(assignment.Left, model);
                    if (TryGetTupleType(target, out INamedTypeSymbol targetTuple))
                    {
                        CollectTupleValueFlow(
                            target,
                            targetTuple,
                            assignment.Right,
                            model,
                            string.Empty,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges);
                    }
                    else if (assignment.Left is TupleExpressionSyntax or DeclarationExpressionSyntax)
                    {
                        CollectDeconstructionFlow(
                            assignment.Left,
                            assignment.Right,
                            model,
                            tainted,
                            edges,
                            scalarTupleEdges);
                    }

                    break;

                case InvocationExpressionSyntax
                    or ObjectCreationExpressionSyntax
                    or ConstructorInitializerSyntax:
                    CollectTupleArgumentFlows(
                        node,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges);
                    break;
            }
        }
    }

    private static void CollectTupleReturnFlows(
        IMethodSymbol method,
        ExpressionSyntax arrowBody,
        BlockSyntax body,
        SemanticModel model,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
        List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges)
    {
        if (!TryGetTupleType(method, out INamedTypeSymbol tupleType))
        {
            return;
        }

        ISymbol target = Canonical(method);
        if (arrowBody != null)
        {
            CollectTupleValueFlow(
                target,
                tupleType,
                arrowBody,
                model,
                string.Empty,
                tupleTainted,
                tupleEdges,
                tupleScalarEdges);
        }

        foreach (ReturnStatementSyntax statement in EnumerateOwnReturns(body))
        {
            if (statement.Expression != null)
            {
                CollectTupleValueFlow(
                    target,
                    tupleType,
                    statement.Expression,
                    model,
                    string.Empty,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges);
            }
        }
    }

    private static void CollectTupleGetterFlows(
        IPropertySymbol property,
        INamedTypeSymbol tupleType,
        ExpressionSyntax arrowBody,
        AccessorListSyntax accessorList,
        SemanticModel model,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
        List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges)
    {
        ISymbol target = Canonical(property);
        if (arrowBody != null)
        {
            CollectTupleValueFlow(
                target,
                tupleType,
                arrowBody,
                model,
                string.Empty,
                tupleTainted,
                tupleEdges,
                tupleScalarEdges);
        }

        AccessorDeclarationSyntax getter = accessorList?.Accessors
            .FirstOrDefault(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
        if (getter?.ExpressionBody?.Expression is ExpressionSyntax getterArrow)
        {
            CollectTupleValueFlow(
                target,
                tupleType,
                getterArrow,
                model,
                string.Empty,
                tupleTainted,
                tupleEdges,
                tupleScalarEdges);
        }

        foreach (ReturnStatementSyntax statement in EnumerateOwnReturns(getter?.Body))
        {
            if (statement.Expression != null)
            {
                CollectTupleValueFlow(
                    target,
                    tupleType,
                    statement.Expression,
                    model,
                    string.Empty,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges);
            }
        }
    }

    private static void CollectTupleArgumentFlows(
        SyntaxNode call,
        SemanticModel model,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
        List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges)
    {
        ImmutableArray<IArgumentOperation> arguments = model.GetOperation(call) switch
        {
            IInvocationOperation invocation => invocation.Arguments,
            IObjectCreationOperation creation => creation.Arguments,
            _ => default,
        };

        if (arguments.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (IArgumentOperation argument in arguments)
        {
            if (argument.Parameter is IParameterSymbol parameter
                && argument.Value?.Syntax is ExpressionSyntax value
                && TryGetTupleType(parameter, out INamedTypeSymbol tupleType))
            {
                CollectTupleValueFlow(
                    Canonical(parameter),
                    tupleType,
                    value,
                    model,
                    string.Empty,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges);
            }
        }
    }

    private static void CollectTupleValueFlow(
        ISymbol target,
        INamedTypeSymbol targetTuple,
        ExpressionSyntax value,
        SemanticModel model,
        string prefix,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
        List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges)
    {
        value = UnwrapTupleValue(value);
        switch (value)
        {
            case null:
                return;

            case ConditionalExpressionSyntax conditional:
                CollectTupleValueFlow(target, targetTuple, conditional.WhenTrue, model, prefix, tupleTainted, tupleEdges, tupleScalarEdges);
                CollectTupleValueFlow(target, targetTuple, conditional.WhenFalse, model, prefix, tupleTainted, tupleEdges, tupleScalarEdges);
                return;

            case SwitchExpressionSyntax switchExpression:
                foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                {
                    CollectTupleValueFlow(target, targetTuple, arm.Expression, model, prefix, tupleTainted, tupleEdges, tupleScalarEdges);
                }

                return;

            case TupleExpressionSyntax tuple
                when tuple.Arguments.Count == targetTuple.TupleElements.Length:
                for (int i = 0; i < targetTuple.TupleElements.Length; i++)
                {
                    ITypeSymbol targetType = targetTuple.TupleElements[i].Type;
                    ExpressionSyntax elementValue = tuple.Arguments[i].Expression;
                    string path = AppendTuplePath(prefix, i);
                    if (targetType is INamedTypeSymbol { IsTupleType: true } nestedTarget)
                    {
                        CollectTupleValueFlow(
                            target,
                            nestedTarget,
                            elementValue,
                            model,
                            path,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges);
                    }
                    else if (IsEligibleTupleLeaf(targetType))
                    {
                        var targetKey = new TupleElementKey(target, path);
                        if (IsDirectlyNullable(elementValue, model))
                        {
                            tupleTainted.Add(targetKey);
                        }
                        else if (TryResolveTupleElementSource(elementValue, model, out TupleElementKey tupleSource))
                        {
                            tupleEdges.Add((targetKey, tupleSource));
                        }
                        else
                        {
                            foreach (ISymbol scalarSource in ResolveSources(elementValue, model))
                            {
                                tupleScalarEdges.Add((targetKey, scalarSource));
                            }
                        }
                    }
                }

                return;
        }

        if (IsDefaultTupleValue(value, model))
        {
            TaintAllTupleLeaves(target, targetTuple, prefix, tupleTainted);
            return;
        }

        if (TryResolveTupleSource(value, model, out ISymbol source, out INamedTypeSymbol sourceTuple))
        {
            AddTupleShapeEdges(
                target,
                targetTuple,
                prefix,
                source,
                sourceTuple,
                string.Empty,
                tupleTainted,
                tupleEdges);
        }
    }

    private static void AddTupleShapeEdges(
        ISymbol target,
        INamedTypeSymbol targetTuple,
        string targetPrefix,
        ISymbol source,
        INamedTypeSymbol sourceTuple,
        string sourcePrefix,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges)
    {
        int count = System.Math.Min(targetTuple.TupleElements.Length, sourceTuple.TupleElements.Length);
        for (int i = 0; i < count; i++)
        {
            ITypeSymbol targetType = targetTuple.TupleElements[i].Type;
            ITypeSymbol sourceType = sourceTuple.TupleElements[i].Type;
            string targetPath = AppendTuplePath(targetPrefix, i);
            string sourcePath = AppendTuplePath(sourcePrefix, i);

            if (targetType is INamedTypeSymbol { IsTupleType: true } nestedTarget
                && sourceType is INamedTypeSymbol { IsTupleType: true } nestedSource)
            {
                AddTupleShapeEdges(
                    target,
                    nestedTarget,
                    targetPath,
                    source,
                    nestedSource,
                    sourcePath,
                    tupleTainted,
                    tupleEdges);
            }
            else if (IsEligibleTupleLeaf(targetType))
            {
                var targetKey = new TupleElementKey(target, targetPath);
                if (sourceType is { IsReferenceType: true, NullableAnnotation: NullableAnnotation.Annotated })
                {
                    tupleTainted.Add(targetKey);
                }
                else
                {
                    tupleEdges.Add((targetKey, new TupleElementKey(source, sourcePath)));
                }
            }
        }
    }

    private static void TaintAllTupleLeaves(
        ISymbol target,
        INamedTypeSymbol tupleType,
        string prefix,
        HashSet<TupleElementKey> tupleTainted)
    {
        for (int i = 0; i < tupleType.TupleElements.Length; i++)
        {
            ITypeSymbol elementType = tupleType.TupleElements[i].Type;
            string path = AppendTuplePath(prefix, i);
            if (elementType is INamedTypeSymbol { IsTupleType: true } nested)
            {
                TaintAllTupleLeaves(target, nested, path, tupleTainted);
            }
            else if (IsEligibleTupleLeaf(elementType))
            {
                tupleTainted.Add(new TupleElementKey(target, path));
            }
        }
    }

    private static void CollectDeconstructionFlow(
        ExpressionSyntax targetPattern,
        ExpressionSyntax value,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges,
        List<(ISymbol Target, TupleElementKey Source)> scalarTupleEdges)
    {
        value = UnwrapTupleValue(value);
        if (value is ConditionalExpressionSyntax conditional)
        {
            CollectDeconstructionFlow(targetPattern, conditional.WhenTrue, model, tainted, edges, scalarTupleEdges);
            CollectDeconstructionFlow(targetPattern, conditional.WhenFalse, model, tainted, edges, scalarTupleEdges);
            return;
        }

        if (value is SwitchExpressionSyntax switchExpression)
        {
            foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
            {
                CollectDeconstructionFlow(targetPattern, arm.Expression, model, tainted, edges, scalarTupleEdges);
            }

            return;
        }

        if (value is TupleExpressionSyntax tupleValue
            && TryGetDeconstructionElements(targetPattern, out IReadOnlyList<ExpressionSyntax> targets)
            && targets.Count == tupleValue.Arguments.Count)
        {
            for (int i = 0; i < targets.Count; i++)
            {
                CollectDeconstructionFlow(
                    targets[i],
                    tupleValue.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges);
            }

            return;
        }

        if (value is TupleExpressionSyntax declarationTupleValue
            && targetPattern is DeclarationExpressionSyntax
                { Designation: ParenthesizedVariableDesignationSyntax declarationPattern }
            && declarationPattern.Variables.Count == declarationTupleValue.Arguments.Count)
        {
            for (int i = 0; i < declarationPattern.Variables.Count; i++)
            {
                CollectDesignationFlow(
                    declarationPattern.Variables[i],
                    declarationTupleValue.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges);
            }

            return;
        }

        if (TryResolveDeconstructionTarget(targetPattern, model, out ISymbol scalarTarget))
        {
            if (IsDirectlyNullable(value, model))
            {
                tainted.Add(scalarTarget);
            }
            else if (TryResolveTupleElementSource(value, model, out TupleElementKey elementSource))
            {
                scalarTupleEdges.Add((scalarTarget, elementSource));
            }
            else
            {
                AddEdges(scalarTarget, value, model, edges);
            }

            return;
        }

        if (TryResolveTupleSource(value, model, out ISymbol tupleSource, out INamedTypeSymbol sourceTuple))
        {
            if (targetPattern is DeclarationExpressionSyntax
                { Designation: ParenthesizedVariableDesignationSyntax forwardedPattern })
            {
                CollectDesignationPatternFromTupleSource(
                    forwardedPattern,
                    tupleSource,
                    sourceTuple,
                    string.Empty,
                    model,
                    scalarTupleEdges);
                return;
            }

            CollectPatternFromTupleSource(
                targetPattern,
                tupleSource,
                sourceTuple,
                string.Empty,
                model,
                scalarTupleEdges);
        }
    }

    private static void CollectDesignationFlow(
        VariableDesignationSyntax target,
        ExpressionSyntax value,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges,
        List<(ISymbol Target, TupleElementKey Source)> scalarTupleEdges)
    {
        if (target is ParenthesizedVariableDesignationSyntax parenthesized
            && value is TupleExpressionSyntax tuple
            && parenthesized.Variables.Count == tuple.Arguments.Count)
        {
            for (int i = 0; i < parenthesized.Variables.Count; i++)
            {
                CollectDesignationFlow(
                    parenthesized.Variables[i],
                    tuple.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges);
            }

            return;
        }

        if (target is not SingleVariableDesignationSyntax single
            || model.GetDeclaredSymbol(single) is not ISymbol declared
            || !IsValueDeclarationSymbol(declared))
        {
            return;
        }

        ISymbol scalarTarget = Canonical(declared);
        if (IsDirectlyNullable(value, model))
        {
            tainted.Add(scalarTarget);
        }
        else if (TryResolveTupleElementSource(value, model, out TupleElementKey elementSource))
        {
            scalarTupleEdges.Add((scalarTarget, elementSource));
        }
        else
        {
            AddEdges(scalarTarget, value, model, edges);
        }
    }

    private static void CollectPatternFromTupleSource(
        ExpressionSyntax pattern,
        ISymbol source,
        INamedTypeSymbol sourceTuple,
        string prefix,
        SemanticModel model,
        List<(ISymbol Target, TupleElementKey Source)> scalarTupleEdges)
    {
        if (!TryGetDeconstructionElements(pattern, out IReadOnlyList<ExpressionSyntax> targets))
        {
            return;
        }

        int count = System.Math.Min(targets.Count, sourceTuple.TupleElements.Length);
        for (int i = 0; i < count; i++)
        {
            ITypeSymbol sourceType = sourceTuple.TupleElements[i].Type;
            string path = AppendTuplePath(prefix, i);
            if (sourceType is INamedTypeSymbol { IsTupleType: true } nested)
            {
                CollectPatternFromTupleSource(targets[i], source, nested, path, model, scalarTupleEdges);
            }
            else if (TryResolveDeconstructionTarget(targets[i], model, out ISymbol scalarTarget))
            {
                scalarTupleEdges.Add((scalarTarget, new TupleElementKey(source, path)));
            }
        }
    }

    private static void CollectDesignationPatternFromTupleSource(
        ParenthesizedVariableDesignationSyntax pattern,
        ISymbol source,
        INamedTypeSymbol sourceTuple,
        string prefix,
        SemanticModel model,
        List<(ISymbol Target, TupleElementKey Source)> scalarTupleEdges)
    {
        int count = System.Math.Min(pattern.Variables.Count, sourceTuple.TupleElements.Length);
        for (int i = 0; i < count; i++)
        {
            VariableDesignationSyntax target = pattern.Variables[i];
            ITypeSymbol sourceType = sourceTuple.TupleElements[i].Type;
            string path = AppendTuplePath(prefix, i);
            if (target is ParenthesizedVariableDesignationSyntax nestedPattern
                && sourceType is INamedTypeSymbol { IsTupleType: true } nestedTuple)
            {
                CollectDesignationPatternFromTupleSource(
                    nestedPattern,
                    source,
                    nestedTuple,
                    path,
                    model,
                    scalarTupleEdges);
            }
            else if (target is SingleVariableDesignationSyntax single
                && model.GetDeclaredSymbol(single) is ISymbol declared
                && IsValueDeclarationSymbol(declared))
            {
                scalarTupleEdges.Add((Canonical(declared), new TupleElementKey(source, path)));
            }
        }
    }

    private static bool TryGetDeconstructionElements(
        ExpressionSyntax pattern,
        out IReadOnlyList<ExpressionSyntax> elements)
    {
        if (pattern is TupleExpressionSyntax tuple)
        {
            elements = tuple.Arguments.Select(a => a.Expression).ToList();
            return true;
        }

        elements = null;
        return false;
    }

    private static bool TryResolveDeconstructionTarget(
        ExpressionSyntax target,
        SemanticModel model,
        out ISymbol symbol)
    {
        symbol = target switch
        {
            IdentifierNameSyntax identifier => model.GetSymbolInfo(identifier).Symbol,
            DeclarationExpressionSyntax { Designation: SingleVariableDesignationSyntax single } =>
                model.GetDeclaredSymbol(single),
            _ => null,
        };

        if (symbol != null && IsValueDeclarationSymbol(symbol))
        {
            symbol = Canonical(symbol);
            return true;
        }

        symbol = null;
        return false;
    }

    private static bool TryResolveTupleSource(
        ExpressionSyntax expression,
        SemanticModel model,
        out ISymbol symbol,
        out INamedTypeSymbol tupleType)
    {
        expression = UnwrapTupleValue(expression);
        symbol = expression switch
        {
            InvocationExpressionSyntax invocation => model.GetSymbolInfo(invocation).Symbol,
            IdentifierNameSyntax or MemberAccessExpressionSyntax => model.GetSymbolInfo(expression).Symbol,
            _ => null,
        };

        if (TryGetTupleType(symbol, out tupleType))
        {
            symbol = Canonical(symbol);
            return true;
        }

        symbol = null;
        tupleType = null;
        return false;
    }

    private static bool TryResolveTupleElementSource(
        ExpressionSyntax expression,
        SemanticModel model,
        out TupleElementKey source)
    {
        expression = UnwrapTupleValue(expression);
        if (expression is MemberAccessExpressionSyntax member
            && model.GetSymbolInfo(member).Symbol is IFieldSymbol field
            && model.GetTypeInfo(member.Expression).Type is INamedTypeSymbol { IsTupleType: true } receiverTuple)
        {
            int index = TupleElementIndex(receiverTuple, field);
            if (index >= 0)
            {
                if (TryResolveTupleSource(member.Expression, model, out ISymbol symbol, out _))
                {
                    source = new TupleElementKey(symbol, index.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    return true;
                }

                if (TryResolveTupleElementSource(member.Expression, model, out TupleElementKey parent))
                {
                    source = new TupleElementKey(parent.Symbol, AppendTuplePath(parent.Path, index));
                    return true;
                }
            }
        }

        source = default;
        return false;
    }

    private static int TupleElementIndex(INamedTypeSymbol tupleType, IFieldSymbol field)
    {
        IFieldSymbol canonicalField = field.CorrespondingTupleField ?? field;
        for (int i = 0; i < tupleType.TupleElements.Length; i++)
        {
            IFieldSymbol candidate = tupleType.TupleElements[i].CorrespondingTupleField
                ?? tupleType.TupleElements[i];
            if (SymbolEqualityComparer.Default.Equals(candidate, canonicalField)
                || tupleType.TupleElements[i].Name == field.Name)
            {
                return i;
            }
        }

        return -1;
    }

    private static bool TryGetTupleType(ISymbol symbol, out INamedTypeSymbol tupleType)
    {
        ITypeSymbol type = symbol switch
        {
            IMethodSymbol method => UnwrapAwaitedType(method.ReturnType),
            IPropertySymbol property => property.Type,
            IFieldSymbol field => field.Type,
            ILocalSymbol local => local.Type,
            IParameterSymbol parameter => parameter.Type,
            _ => null,
        };

        tupleType = type as INamedTypeSymbol;
        return tupleType is { IsTupleType: true };
    }

    private static bool IsEligibleTupleLeaf(ITypeSymbol type) =>
        type is { IsReferenceType: true }
            && type.NullableAnnotation != NullableAnnotation.Annotated;

    private static bool IsDefaultTupleValue(ExpressionSyntax expression, SemanticModel model) =>
        expression is DefaultExpressionSyntax
            || (expression is LiteralExpressionSyntax literal
                && literal.IsKind(SyntaxKind.DefaultLiteralExpression)
                && model.GetTypeInfo(literal).ConvertedType is INamedTypeSymbol { IsTupleType: true });

    private static ExpressionSyntax UnwrapTupleValue(ExpressionSyntax expression)
    {
        while (true)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    expression = parenthesized.Expression;
                    continue;
                case CastExpressionSyntax cast:
                    expression = cast.Expression;
                    continue;
                case AwaitExpressionSyntax awaitExpression:
                    expression = awaitExpression.Expression;
                    continue;
                default:
                    return expression;
            }
        }
    }

    private static string AppendTuplePath(string prefix, int index) =>
        string.IsNullOrEmpty(prefix)
            ? index.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : prefix + "." + index.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static string EncodeTuplePath(IReadOnlyList<int> path) =>
        string.Join(".", path.Select(i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)));

    // Return taint: for each method / accessor / local function, examine every
    // `return` (or arrow expression body) that belongs to it (not to a nested
    // lambda / local function). A directly-null return taints the member's
    // return symbol immediately; any other return records a transitive edge.
    private static void SeedReturnTaint(
        SyntaxNode root,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        foreach (SyntaxNode node in root.DescendantNodes())
        {
            switch (node)
            {
                case MethodDeclarationSyntax method:
                    SeedMethodLikeReturnTaint(
                        model.GetDeclaredSymbol(method),
                        method.ExpressionBody?.Expression,
                        method.Body,
                        model,
                        tainted,
                        edges);
                    break;

                case LocalFunctionStatementSyntax localFunction:
                    SeedMethodLikeReturnTaint(
                        model.GetDeclaredSymbol(localFunction),
                        localFunction.ExpressionBody?.Expression,
                        localFunction.Body,
                        model,
                        tainted,
                        edges);
                    break;

                // Property / indexer getters: the "return type" is the
                // property's own type and the taint TARGET is the property
                // symbol itself. A getter whose expression body / `get` accessor
                // yields a nullable (`?.` / `??` / ternary / `return null`)
                // value must be emitted as `T?` (issue #2157).
                case PropertyDeclarationSyntax property:
                    SeedPropertyLikeReturnTaint(
                        model.GetDeclaredSymbol(property),
                        property.ExpressionBody?.Expression,
                        property.AccessorList,
                        model,
                        tainted,
                        edges);
                    break;

                case IndexerDeclarationSyntax indexer:
                    SeedPropertyLikeReturnTaint(
                        model.GetDeclaredSymbol(indexer),
                        indexer.ExpressionBody?.Expression,
                        indexer.AccessorList,
                        model,
                        tainted,
                        edges);
                    break;
            }
        }
    }

    private static void SeedMethodLikeReturnTaint(
        ISymbol returnSymbol,
        ExpressionSyntax arrowBody,
        BlockSyntax body,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        if (returnSymbol is not IMethodSymbol { ReturnsVoid: false })
        {
            return;
        }

        ISymbol canonicalReturn = Canonical(returnSymbol);

        if (arrowBody != null)
        {
            ApplyReturnValue(canonicalReturn, arrowBody, model, tainted, edges, transitive: true);
        }

        foreach (ReturnStatementSyntax statement in EnumerateOwnReturns(body))
        {
            if (statement.Expression != null)
            {
                ApplyReturnValue(canonicalReturn, statement.Expression, model, tainted, edges, transitive: true);
            }
        }
    }

    private static void SeedPropertyLikeReturnTaint(
        IPropertySymbol propertySymbol,
        ExpressionSyntax propertyArrowBody,
        AccessorListSyntax accessorList,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        // Only reference-typed, not-already-nullable property/indexer types are
        // governed by this analysis; value types and `T?` declarations are left
        // untouched.
        if (propertySymbol is not { Type.IsReferenceType: true } ||
            propertySymbol.Type.NullableAnnotation == NullableAnnotation.Annotated)
        {
            return;
        }

        ISymbol canonicalReturn = Canonical(propertySymbol);

        // A property/indexer getter is direct-taint always: a syntactically
        // nullable body (`?.` / `??`-with-nullable-fallback / ternary /
        // `return null`) promotes the property to `T?` (issue #2157).
        //
        // Issue #2167: it is ALSO transitive for a property that neither
        // overrides a base member nor implements an interface member — a getter
        // that returns a nullable-returning method / forwards a tainted
        // declaration (e.g. `MotherboardInfo.InstallDate` returning
        // `ConvertToDateTime(...)` whose own return is `string?`) must itself be
        // `T?`, otherwise gsc rejects the `T? -> T` return (GS0156). For an
        // OVERRIDE / interface implementation we keep the direct-taint-only
        // behavior and rely on the translator's null-forgiveness pass (issue
        // #1354) to assert the forwarded value non-null, preserving the property
        // contract with the base / interface declaration.
        //
        // Issue #914 (oblivious sink): a NON-CONTRACT getter that merely FORWARDS
        // a promoted-nullable field/local/parameter (e.g. `TextWriter Writer =>
        // logStreamWriter;` where the backing field is a promoted `StreamWriter?`
        // — null-assigned in `CloseWriter`) must itself be `T?`, otherwise the
        // `StreamWriter? -> TextWriter` getter return is rejected (GS0155). Such
        // a property genuinely can be null, so field/local/param forwarding is
        // followed (`SourceScope.CallsAndNonPropertyDeclarations`); every
        // downstream member use (`Writer.WriteLine(...)`) then gets its `!!`
        // assertion from the translator's null-forgiveness pass, which keys off
        // the same promotion. Forwarding ANOTHER PROPERTY is deliberately NOT
        // followed, so `string Forward => Work;` keeps its declared type and the
        // #1354 / #2167 property-contract guardrail is preserved. A contract
        // member stays direct-taint-only (transitive is false below, so the
        // forwarding edges are not recorded for it regardless).
        bool transitive = !ImplementsBaseOrInterfaceMember(propertySymbol);

        // `Prop => expr;`
        if (propertyArrowBody != null)
        {
            ApplyReturnValue(canonicalReturn, propertyArrowBody, model, tainted, edges, transitive, SourceScope.CallsAndNonPropertyDeclarations);
        }

        // Only the `get` accessor produces the property value; `set`/`init`
        // return void and are ignored.
        AccessorDeclarationSyntax getter = accessorList?.Accessors
            .FirstOrDefault(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
        if (getter == null)
        {
            return;
        }

        // `get => expr;`
        if (getter.ExpressionBody?.Expression is ExpressionSyntax getterArrow)
        {
            ApplyReturnValue(canonicalReturn, getterArrow, model, tainted, edges, transitive, SourceScope.CallsAndNonPropertyDeclarations);
        }

        // `get { ... return x; }`
        foreach (ReturnStatementSyntax statement in EnumerateOwnReturns(getter.Body))
        {
            if (statement.Expression != null)
            {
                ApplyReturnValue(canonicalReturn, statement.Expression, model, tainted, edges, transitive, SourceScope.CallsAndNonPropertyDeclarations);
            }
        }
    }

    // Whether the property/indexer overrides a base member or implements an
    // interface member (explicitly or implicitly). Such a member's emitted G#
    // return type must stay in lock-step with the base / interface declaration,
    // so it is excluded from TRANSITIVE return promotion (issue #2167 guardrail;
    // preserves issue #2157 / #1354 behavior for contract members).
    private static bool ImplementsBaseOrInterfaceMember(IPropertySymbol property)
    {
        if (property.IsOverride || !property.ExplicitInterfaceImplementations.IsDefaultOrEmpty)
        {
            return true;
        }

        INamedTypeSymbol containingType = property.ContainingType;
        if (containingType == null)
        {
            return false;
        }

        foreach (INamedTypeSymbol iface in containingType.AllInterfaces)
        {
            foreach (ISymbol member in iface.GetMembers())
            {
                if (member is IPropertySymbol
                    && SymbolEqualityComparer.Default.Equals(
                        containingType.FindImplementationForInterfaceMember(member),
                        property))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2285: for every source-declared type in <paramref name="compilation"/>
    /// that implements an interface, records BIDIRECTIONAL taint edges between
    /// each reference-typed interface property and the member that implements
    /// it, so the two endpoints of the same logical contract always reach the
    /// SAME tainted-ness in the fixpoint below — cs2gs must never promote only
    /// one side (the interface property's `T` vs. the implementation's `T?`),
    /// since gsc's Kotlin-style get-only-property variance rejects a non-null
    /// interface contract satisfied by a nullable member (GS0187, tightened by
    /// the #2150/#2284 follow-up). Both directions are recorded (not just the
    /// sound "impl nullable -> widen the interface" direction) so the two
    /// endpoints CONVERGE regardless of which side taint was originally seeded
    /// on (e.g. a caller might null-check through the INTERFACE-typed reference
    /// rather than the concrete type).
    /// <para>
    /// A C# record's positional parameter is a distinct <see cref="ISymbol"/>
    /// from its synthesized auto-property (the one
    /// <c>INamedTypeSymbol.FindImplementationForInterfaceMember</c>
    /// reports as the interface-member implementation) — yet cs2gs maps the
    /// PARAMETER's own type, not the property's, to the emitted G# primary-
    /// constructor parameter (<see cref="CSharpToGSharpTranslator.DeclarationVisitor.MapParameter"/>).
    /// The synthesized property's declaring syntax reference IS the parameter
    /// syntax node itself for a positional record member, so the corresponding
    /// <see cref="IParameterSymbol"/> is resolved from it and wired into the
    /// same edge set, generalizing this fix beyond ordinary classes/properties
    /// to record positional parameters.
    /// </para>
    /// </summary>
    /// <param name="compilation">The C# compilation being translated.</param>
    /// <param name="edges">The taint-edge list to append to.</param>
    private static void CollectInterfaceImplementationEdges(
        Compilation compilation,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        foreach (INamedTypeSymbol type in EnumerateSourceNamedTypes(compilation))
        {
            if (type.TypeKind is not (TypeKind.Class or TypeKind.Struct) || type.AllInterfaces.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (INamedTypeSymbol iface in type.AllInterfaces)
            {
                foreach (ISymbol member in iface.GetMembers())
                {
                    switch (member)
                    {
                        case IPropertySymbol interfaceProperty:
                            CollectInterfacePropertyEdges(compilation, type, interfaceProperty, edges);
                            break;

                        case IMethodSymbol interfaceMethod:
                            CollectInterfaceMethodEdges(type, interfaceMethod, edges);
                            break;
                    }
                }
            }
        }
    }

    private static void CollectInterfacePropertyEdges(
        Compilation compilation,
        INamedTypeSymbol type,
        IPropertySymbol interfaceProperty,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        if (interfaceProperty.Type is not { IsReferenceType: true }
            || interfaceProperty.Type.NullableAnnotation == NullableAnnotation.Annotated)
        {
            return;
        }

        if (type.FindImplementationForInterfaceMember(interfaceProperty) is not IPropertySymbol implementingProperty)
        {
            return;
        }

        ISymbol interfaceCanonical = Canonical(interfaceProperty);
        ISymbol implCanonical = Canonical(implementingProperty);
        edges.Add((interfaceCanonical, implCanonical));
        edges.Add((implCanonical, interfaceCanonical));

        IParameterSymbol positionalParameter = FindPositionalRecordParameter(compilation, implementingProperty);
        if (positionalParameter != null)
        {
            ISymbol paramCanonical = Canonical(positionalParameter);
            edges.Add((interfaceCanonical, paramCanonical));
            edges.Add((paramCanonical, interfaceCanonical));
        }
    }

    // Issue #2423: the method-return analog of
    // <see cref="CollectInterfacePropertyEdges"/>. `CollectInterfaceImplementationEdges`
    // previously handled ONLY properties, so a method that implements an
    // interface member had no synchronization at all: `SeedMethodLikeReturnTaint`
    // (unlike its property counterpart) applies UNCONDITIONAL transitive
    // return-taint promotion to every method, including one that implements an
    // interface — so an implementation whose body forwards a tainted call (e.g.
    // an `async Task&lt;T&gt;` method delegating to a sibling overload that can
    // return null) is correctly promoted to `T?`, but the interface declaration
    // it implements — which has no body of its own to seed taint from — never
    // is, producing an internally-inconsistent translation gsc's Kotlin-style
    // interface-conformance check rejects (GS0187: "does not implement interface
    // method"). Only an ORDINARY method member is considered (interface property
    // accessors surface as <see cref="IMethodSymbol"/> too via
    // <see cref="ITypeSymbol.GetMembers()"/> and are already handled by the
    // property edge above). The eligibility check is keyed off the UNWRAPPED
    // `async Task&lt;T&gt;`/`ValueTask&lt;T&gt;` result type (mirroring
    // <c>CSharpToGSharpTranslator.PromoteAwaitedReturnIfTainted</c>'s own
    // unwrap), since the interface method symbol's own <c>ReturnType</c> is the
    // `Task&lt;T&gt;` envelope regardless of the implementing method's `async`
    // modifier (a signature-level fact, not an implementation detail) — so a
    // value-typed `Task&lt;int&gt;` is correctly left untouched, exactly like the
    // synchronous case. Both directions are recorded (mirroring the property
    // fix) so the two endpoints always converge to the same tainted-ness
    // regardless of which side (interface or implementation) the taint was
    // originally seeded on.
    private static void CollectInterfaceMethodEdges(
        INamedTypeSymbol type,
        IMethodSymbol interfaceMethod,
        List<(ISymbol Target, ISymbol Source)> edges)
    {
        if (interfaceMethod.MethodKind != MethodKind.Ordinary || interfaceMethod.ReturnsVoid)
        {
            return;
        }

        ITypeSymbol effectiveReturnType = UnwrapAwaitedType(interfaceMethod.ReturnType);
        if (effectiveReturnType is not { IsReferenceType: true }
            || effectiveReturnType.NullableAnnotation == NullableAnnotation.Annotated)
        {
            return;
        }

        if (type.FindImplementationForInterfaceMember(interfaceMethod) is not IMethodSymbol implementingMethod)
        {
            return;
        }

        ISymbol interfaceCanonical = Canonical(interfaceMethod);
        ISymbol implCanonical = Canonical(implementingMethod);
        edges.Add((interfaceCanonical, implCanonical));
        edges.Add((implCanonical, interfaceCanonical));
    }

    private static void CollectTupleContractEdges(
        Compilation compilation,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges)
    {
        foreach (INamedTypeSymbol type in EnumerateSourceNamedTypes(compilation))
        {
            foreach (IMethodSymbol method in type.GetMembers().OfType<IMethodSymbol>())
            {
                if (method.MethodKind != MethodKind.Ordinary
                    || !TryGetTupleType(method, out INamedTypeSymbol methodTuple))
                {
                    continue;
                }

                if (method.OverriddenMethod is IMethodSymbol overridden
                    && TryGetTupleType(overridden, out INamedTypeSymbol overriddenTuple))
                {
                    AddTupleContractPair(
                        method,
                        methodTuple,
                        overridden,
                        overriddenTuple,
                        tupleTainted,
                        tupleEdges);
                }
            }

            foreach (INamedTypeSymbol iface in type.AllInterfaces)
            {
                foreach (IMethodSymbol interfaceMethod in iface.GetMembers().OfType<IMethodSymbol>())
                {
                    if (interfaceMethod.MethodKind != MethodKind.Ordinary
                        || !TryGetTupleType(interfaceMethod, out INamedTypeSymbol interfaceTuple)
                        || type.FindImplementationForInterfaceMember(interfaceMethod) is not IMethodSymbol implementation
                        || !TryGetTupleType(implementation, out INamedTypeSymbol implementationTuple))
                    {
                        continue;
                    }

                    AddTupleContractPair(
                        interfaceMethod,
                        interfaceTuple,
                        implementation,
                        implementationTuple,
                        tupleTainted,
                        tupleEdges);
                }
            }
        }
    }

    private static void AddTupleContractPair(
        IMethodSymbol first,
        INamedTypeSymbol firstTuple,
        IMethodSymbol second,
        INamedTypeSymbol secondTuple,
        HashSet<TupleElementKey> tupleTainted,
        List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges)
    {
        ISymbol firstCanonical = Canonical(first);
        ISymbol secondCanonical = Canonical(second);
        AddTupleShapeEdges(
            firstCanonical,
            firstTuple,
            string.Empty,
            secondCanonical,
            secondTuple,
            string.Empty,
            tupleTainted,
            tupleEdges);
        AddTupleShapeEdges(
            secondCanonical,
            secondTuple,
            string.Empty,
            firstCanonical,
            firstTuple,
            string.Empty,
            tupleTainted,
            tupleEdges);
    }

    // Unwraps a (non-generic-parameter) `System.Threading.Tasks.Task<T>` or
    // `System.Threading.Tasks.ValueTask<T>` return type to its awaited result
    // `T`, mirroring `CSharpToGSharpTranslator.PromoteAwaitedReturnIfTainted`'s
    // own unwrap so an interface method's `Task<T>`-declared signature is judged
    // on the SAME effective type an `async` implementation's return is. Any
    // other type (including the non-generic `Task`/`ValueTask`, and a
    // value-typed `Task<int>`, whose `T` is filtered out by the reference-type
    // eligibility check at the call site) is returned unchanged.
    private static ITypeSymbol UnwrapAwaitedType(ITypeSymbol returnType)
    {
        if (returnType is INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } named
            && named.OriginalDefinition.SpecialType != SpecialType.System_Nullable_T
            && (named.Name == "Task" || named.Name == "ValueTask")
            && named.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
        {
            return named.TypeArguments[0];
        }

        return returnType;
    }

    // A record's positional-parameter property has a declaring syntax
    // reference that IS the `ParameterSyntax` node itself (verified against
    // Roslyn's actual behavior), so the corresponding primary-constructor
    // `IParameterSymbol` — the symbol cs2gs's own primary-constructor mapping
    // promotes — is resolved by re-binding that same syntax node. Returns
    // `null` for an ordinary (non-positional) property.
    private static IParameterSymbol FindPositionalRecordParameter(Compilation compilation, IPropertySymbol property)
    {
        foreach (SyntaxReference reference in property.DeclaringSyntaxReferences)
        {
            if (reference.GetSyntax() is ParameterSyntax parameterSyntax)
            {
                SemanticModel model = compilation.GetSemanticModel(parameterSyntax.SyntaxTree);
                if (model.GetDeclaredSymbol(parameterSyntax) is IParameterSymbol parameterSymbol)
                {
                    return parameterSymbol;
                }
            }
        }

        return null;
    }

    // Every source-declared named type reachable from the compilation's
    // assembly, walking nested types too (mirrors
    // `CSharpToGSharpTranslator.EnumerateNamedTypes`, duplicated locally so
    // this analyzer stays a self-contained, independently testable unit).
    private static IEnumerable<INamedTypeSymbol> EnumerateSourceNamedTypes(Compilation compilation)
    {
        foreach (INamedTypeSymbol type in EnumerateNamespaceTypes(compilation.Assembly.GlobalNamespace))
        {
            yield return type;
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNamespaceTypes(INamespaceSymbol ns)
    {
        foreach (INamedTypeSymbol type in ns.GetTypeMembers())
        {
            foreach (INamedTypeSymbol typeOrNested in EnumerateTypeAndNested(type))
            {
                yield return typeOrNested;
            }
        }

        foreach (INamespaceSymbol nested in ns.GetNamespaceMembers())
        {
            foreach (INamedTypeSymbol type in EnumerateNamespaceTypes(nested))
            {
                yield return type;
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateTypeAndNested(INamedTypeSymbol type)
    {
        yield return type;
        foreach (INamedTypeSymbol nested in type.GetTypeMembers())
        {
            foreach (INamedTypeSymbol nestedOrDeeper in EnumerateTypeAndNested(nested))
            {
                yield return nestedOrDeeper;
            }
        }
    }

    private static void ApplyReturnValue(
        ISymbol returnSymbol,
        ExpressionSyntax value,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges,
        bool transitive,
        SourceScope scope = SourceScope.AllSources)
    {
        if (IsDirectlyNullable(value, model))
        {
            tainted.Add(returnSymbol);
        }
        else if (transitive)
        {
            AddEdges(returnSymbol, value, model, edges, scope);
        }
    }

    // The `return` statements that belong to <paramref name="body"/> itself,
    // excluding those inside a nested lambda / local function (which have their
    // own return contract).
    private static IEnumerable<ReturnStatementSyntax> EnumerateOwnReturns(BlockSyntax body)
    {
        if (body == null)
        {
            yield break;
        }

        foreach (SyntaxNode descendant in body.DescendantNodes(
            n => n is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)))
        {
            if (descendant is ReturnStatementSyntax statement)
            {
                yield return statement;
            }
        }
    }

    // Adds transitive edges `target <- source` for every declaration symbol the
    // value expression reads (identifier/member) or the method it calls
    // (invocation), unwrapping the compositional forms `??`, `?:`, `(cast)`.
    // <paramref name="scope"/> selects which forwarding sources are followed
    // (see <see cref="SourceScope"/>). This is the interprocedural edge used for
    // property/indexer getters (issue #2167 / #914): a getter returning a
    // nullable-returning method call is promoted; a non-contract getter that
    // forwards a tainted field/local/param is promoted; but a getter that merely
    // FORWARDS another PROPERTY keeps its declared type and relies on the
    // translator's null-forgiveness `!!` pass (issue #1354 / #2157), preserving
    // the property contract.
    private static void AddEdges(
        ISymbol target,
        ExpressionSyntax value,
        SemanticModel model,
        List<(ISymbol Target, ISymbol Source)> edges,
        SourceScope scope = SourceScope.AllSources)
    {
        foreach (ISymbol source in ResolveSources(value, model, scope))
        {
            edges.Add((target, source));
        }
    }

    private static IEnumerable<ISymbol> ResolveSources(
        ExpressionSyntax expression,
        SemanticModel model,
        SourceScope scope = SourceScope.AllSources)
    {
        switch (expression)
        {
            case null:
                yield break;

            case ParenthesizedExpressionSyntax paren:
                foreach (ISymbol source in ResolveSources(paren.Expression, model, scope))
                {
                    yield return source;
                }

                break;

            // `await expr`: issue #2421 — a `return await TaintedAsyncCall()`
            // must forward the SAME transitive edge a synchronous `return
            // TaintedCall()` already gets, or the enclosing async method never
            // converges to tainted despite forwarding a provably-nullable
            // awaited result (mirrors the identical unwrap in
            // IsDirectlyNullable above).
            case AwaitExpressionSyntax awaitExpression:
                foreach (ISymbol source in ResolveSources(awaitExpression.Expression, model, scope))
                {
                    yield return source;
                }

                break;

            case PostfixUnaryExpressionSyntax suppress
                when suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                yield break;

            // `a ?? b`: the result is `b`'s value when `a` is null.
            case BinaryExpressionSyntax coalesce
                when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                foreach (ISymbol source in ResolveSources(coalesce.Right, model, scope))
                {
                    yield return source;
                }

                break;

            // `cond ? a : b`: either branch may flow through.
            case ConditionalExpressionSyntax ternary:
                foreach (ISymbol source in ResolveSources(ternary.WhenTrue, model, scope)
                    .Concat(ResolveSources(ternary.WhenFalse, model, scope)))
                {
                    yield return source;
                }

                break;

            // `x switch { ... }`: any arm's result value may flow through.
            case SwitchExpressionSyntax switchExpression:
                foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                {
                    foreach (ISymbol source in ResolveSources(arm.Expression, model, scope))
                    {
                        yield return source;
                    }
                }

                break;

            case CastExpressionSyntax cast:
                foreach (ISymbol source in ResolveSources(cast.Expression, model, scope))
                {
                    yield return source;
                }

                break;

            case InvocationExpressionSyntax invocation:
                if (model.GetSymbolInfo(invocation).Symbol is IMethodSymbol called
                    && !called.ReturnsVoid)
                {
                    yield return Canonical(called);
                }

                break;

            case IdentifierNameSyntax:
            case MemberAccessExpressionSyntax:
                if (scope == SourceScope.CallsOnly)
                {
                    yield break;
                }

                ISymbol symbol = model.GetSymbolInfo(expression).Symbol;
                if (symbol == null)
                {
                    break;
                }

                // A NON-CONTRACT getter follows field/local/param forwarding but
                // never PROPERTY forwarding (that would regress the #1354 /
                // #2167 property-contract guardrail).
                if (scope == SourceScope.CallsAndNonPropertyDeclarations
                    && symbol is IPropertySymbol)
                {
                    yield break;
                }

                if (IsValueDeclarationSymbol(symbol) || symbol is IMethodSymbol)
                {
                    yield return Canonical(symbol);
                }

                break;
        }
    }

    // Taints the declaration symbol an lvalue-ish expression binds to (the
    // receiver of a null-check / null-assignment / `?.`).
    private static void TaintTarget(ExpressionSyntax expression, SemanticModel model, HashSet<ISymbol> tainted)
    {
        ISymbol symbol = ResolveAssignable(expression, model);
        if (symbol != null)
        {
            tainted.Add(symbol);
        }
    }

    // Resolves the field/property/parameter/local a reference expression binds
    // to (canonicalized), or null when the expression is not a simple binding to
    // one of those (e.g. an element access, a method group, a `this`).
    private static ISymbol ResolveAssignable(ExpressionSyntax expression, SemanticModel model)
    {
        switch (expression)
        {
            case ParenthesizedExpressionSyntax paren:
                return ResolveAssignable(paren.Expression, model);

            case IdentifierNameSyntax:
            case MemberAccessExpressionSyntax:
                ISymbol symbol = model.GetSymbolInfo(expression).Symbol;
                return symbol != null && IsValueDeclarationSymbol(symbol) ? Canonical(symbol) : null;

            default:
                return null;
        }
    }

    // Whether a reference expression is directly (syntactically or by declared
    // BCL annotation) nullable, independent of any other declaration's taint.
    // Mirrors the translator's IsNullableInitializer, plus the `null`/`default`
    // literal forms used in initializer/return positions.
    private static bool IsDirectlyNullable(ExpressionSyntax expression, SemanticModel model)
    {
        switch (expression)
        {
            case null:
                return false;

            case ParenthesizedExpressionSyntax paren:
                return IsDirectlyNullable(paren.Expression, model);

            // `await expr`: an awaited `Task<T>`'s own nullability is that of
            // T, which is exactly what the UNWRAPPED awaited expression's own
            // syntactic shape already answers here (mirrors ResolveSources'
            // identical unwrap immediately below, and the translator's
            // symmetric async-return unwrap in
            // CSharpToGSharpTranslator.PromoteAwaitedReturnIfTainted, issue
            // #2421). Without this, `return await x?.M();` inside an async
            // method would be treated as NOT directly nullable at all.
            case AwaitExpressionSyntax awaitExpression:
                return IsDirectlyNullable(awaitExpression.Expression, model);

            case PostfixUnaryExpressionSyntax suppress
                when suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                return false;

            case LiteralExpressionSyntax literal:
                return literal.IsKind(SyntaxKind.NullLiteralExpression)
                    || (literal.IsKind(SyntaxKind.DefaultLiteralExpression)
                        && IsReferenceLike(model.GetTypeInfo(literal).ConvertedType));

            case DefaultExpressionSyntax defaultExpression:
                return IsReferenceLike(model.GetTypeInfo(defaultExpression).Type);

            // `a?.b` / `a?[i]`.
            case ConditionalAccessExpressionSyntax:
                return true;

            // `a ?? b`: nullable iff the `b` fallback is nullable.
            case BinaryExpressionSyntax coalesce
                when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                return IsDirectlyNullable(coalesce.Right, model);

            // `cond ? a : b`: nullable iff either branch is.
            case ConditionalExpressionSyntax ternary:
                return IsDirectlyNullable(ternary.WhenTrue, model)
                    || IsDirectlyNullable(ternary.WhenFalse, model);

            // `x switch { ... }`: nullable iff any arm's result is (e.g. a
            // `_ => null` / `_ => default` fallback arm, or an arm forwarding
            // an already-nullable value).
            case SwitchExpressionSyntax switchExpression:
                foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                {
                    if (IsDirectlyNullable(arm.Expression, model))
                    {
                        return true;
                    }
                }

                return false;
        }

        // Flow nullability when the context happens to be enabled (inert in a
        // truly oblivious compilation, but harmless).
        TypeInfo info = model.GetTypeInfo(expression);
        if (info.Nullability.Annotation == NullableAnnotation.Annotated)
        {
            return true;
        }

        // Otherwise consult the bound symbol's DECLARED annotation, which
        // survives in BCL/source metadata regardless of the consuming context
        // (e.g. `AssemblyName.Name` and `Path.GetFileNameWithoutExtension(...)`
        // are declared `string?`).
        ISymbol symbol = model.GetSymbolInfo(expression).Symbol;
        ITypeSymbol symbolType = symbol switch
        {
            IMethodSymbol m => m.ReturnType,
            IPropertySymbol p => p.Type,
            IFieldSymbol f => f.Type,
            ILocalSymbol l => l.Type,
            IParameterSymbol pr => pr.Type,
            _ => null,
        };

        return symbolType is { IsReferenceType: true }
            && symbolType.NullableAnnotation == NullableAnnotation.Annotated;
    }

    private static bool IsReferenceLike(ITypeSymbol type) =>
        type is { IsReferenceType: true } || type is ITypeParameterSymbol;

    // The declaration kinds whose emitted reference type this analysis governs.
    private static bool IsValueDeclarationSymbol(ISymbol symbol) =>
        symbol is IFieldSymbol or IPropertySymbol or IParameterSymbol or ILocalSymbol;

    private static ISymbol Canonical(ISymbol symbol)
    {
        // A reduced extension-method invocation (`value.Ext(...)`) binds to the
        // REDUCED method symbol, whereas the extension's own declaration node
        // binds to the UNREDUCED static method; normalize to the unreduced
        // original so a return-taint keyed on the declaration matches a call-site
        // edge that reads it (issue #2113 — otherwise chained extension methods
        // like `values.FirstEtAlImpl(...)` never propagate their nullable return).
        if (symbol is IMethodSymbol method)
        {
            return (method.ReducedFrom ?? method).OriginalDefinition;
        }

        return symbol?.OriginalDefinition ?? symbol;
    }

    // `x is null` / `x is not null` constant pattern.
    private static bool IsNullConstantPattern(PatternSyntax pattern)
    {
        if (pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern))
        {
            pattern = unary.Pattern;
        }

        return pattern is ConstantPatternSyntax constant && IsNullLiteral(constant.Expression);
    }

    private static bool IsNullLiteral(ExpressionSyntax expression) =>
        expression is LiteralExpressionSyntax literal
            && literal.IsKind(SyntaxKind.NullLiteralExpression);

    // `null` or `null!` (a SuppressNullableWarning over a null literal).
    private static bool IsNullOrSuppressedNull(ExpressionSyntax expression)
    {
        if (expression is PostfixUnaryExpressionSyntax suppress
            && suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression))
        {
            expression = suppress.Operand;
        }

        return IsNullLiteral(expression);
    }

    private readonly struct TupleElementKey
    {
        public TupleElementKey(ISymbol symbol, string path)
        {
            this.Symbol = Canonical(symbol);
            this.Path = path;
        }

        public ISymbol Symbol { get; }

        public string Path { get; }
    }

    private readonly struct TupleElementQuery
    {
        public TupleElementQuery(CSharpCompilation compilation, TupleElementKey key)
        {
            this.Compilation = compilation;
            this.Key = key;
        }

        public CSharpCompilation Compilation { get; }

        public TupleElementKey Key { get; }
    }

    private sealed class TupleElementKeyComparer : IEqualityComparer<TupleElementKey>
    {
        public static TupleElementKeyComparer Instance { get; } = new();

        public bool Equals(TupleElementKey x, TupleElementKey y) =>
            SymbolEqualityComparer.Default.Equals(x.Symbol, y.Symbol)
                && string.Equals(x.Path, y.Path, System.StringComparison.Ordinal);

        public int GetHashCode(TupleElementKey obj)
        {
            int symbolHash = obj.Symbol == null
                ? 0
                : SymbolEqualityComparer.Default.GetHashCode(obj.Symbol);
            return System.HashCode.Combine(symbolHash, obj.Path);
        }
    }

    private sealed class TupleElementQueryComparer : IEqualityComparer<TupleElementQuery>
    {
        public static TupleElementQueryComparer Instance { get; } = new();

        public bool Equals(TupleElementQuery x, TupleElementQuery y) =>
            ReferenceEquals(x.Compilation, y.Compilation)
                && TupleElementKeyComparer.Instance.Equals(x.Key, y.Key);

        public int GetHashCode(TupleElementQuery obj) =>
            System.HashCode.Combine(
                System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj.Compilation),
                TupleElementKeyComparer.Instance.GetHashCode(obj.Key));
    }

    private sealed class TaintResult
    {
        public TaintResult(
            HashSet<ISymbol> tainted,
            HashSet<TupleElementKey> tupleTainted,
            List<(TupleElementKey Target, TupleElementKey Source)> tupleEdges,
            List<(TupleElementKey Target, ISymbol Source)> tupleScalarEdges)
        {
            this.Tainted = tainted;
            this.TupleTainted = tupleTainted;
            this.TupleEdges = tupleEdges;
            this.TupleScalarEdges = tupleScalarEdges;
        }

        public HashSet<ISymbol> Tainted { get; }

        public HashSet<TupleElementKey> TupleTainted { get; }

        public List<(TupleElementKey Target, TupleElementKey Source)> TupleEdges { get; }

        public List<(TupleElementKey Target, ISymbol Source)> TupleScalarEdges { get; }
    }
}
