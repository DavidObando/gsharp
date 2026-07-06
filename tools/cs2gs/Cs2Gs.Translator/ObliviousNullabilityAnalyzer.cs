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

    private static TaintResult Compute(Compilation compilation)
    {
        var tainted = new HashSet<ISymbol>(SymbolEqualityComparer.Default);

        // Transitive edges: (target <- source). If `source` is tainted then
        // `target` becomes tainted. Both are canonicalized declaration symbols
        // (field/property/parameter/local for a value target; method for a
        // return target; field/property/parameter/local/method for a source).
        var edges = new List<(ISymbol Target, ISymbol Source)>();

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
        }

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
        }

        return new TaintResult(tainted);
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
        bool transitive = !ImplementsBaseOrInterfaceMember(propertySymbol);

        // `Prop => expr;`
        if (propertyArrowBody != null)
        {
            ApplyReturnValue(canonicalReturn, propertyArrowBody, model, tainted, edges, transitive, callSourcesOnly: true);
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
            ApplyReturnValue(canonicalReturn, getterArrow, model, tainted, edges, transitive, callSourcesOnly: true);
        }

        // `get { ... return x; }`
        foreach (ReturnStatementSyntax statement in EnumerateOwnReturns(getter.Body))
        {
            if (statement.Expression != null)
            {
                ApplyReturnValue(canonicalReturn, statement.Expression, model, tainted, edges, transitive, callSourcesOnly: true);
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

    private static void ApplyReturnValue(
        ISymbol returnSymbol,
        ExpressionSyntax value,
        SemanticModel model,
        HashSet<ISymbol> tainted,
        List<(ISymbol Target, ISymbol Source)> edges,
        bool transitive,
        bool callSourcesOnly = false)
    {
        if (IsDirectlyNullable(value, model))
        {
            tainted.Add(returnSymbol);
        }
        else if (transitive)
        {
            AddEdges(returnSymbol, value, model, edges, callSourcesOnly);
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
    // When <paramref name="callSourcesOnly"/> is set, ONLY method-call returns
    // (`m(args)`) are followed — plain identifier/member forwarding is skipped.
    // This is the interprocedural edge used for property/indexer getters (issue
    // #2167): a getter returning a nullable-returning method call is promoted,
    // but a getter that merely FORWARDS a tainted field/property keeps its
    // declared type and relies on the translator's null-forgiveness `!!` pass
    // (issue #1354 / #2157), preserving the property contract.
    private static void AddEdges(
        ISymbol target,
        ExpressionSyntax value,
        SemanticModel model,
        List<(ISymbol Target, ISymbol Source)> edges,
        bool callSourcesOnly = false)
    {
        foreach (ISymbol source in ResolveSources(value, model, callSourcesOnly))
        {
            edges.Add((target, source));
        }
    }

    private static IEnumerable<ISymbol> ResolveSources(
        ExpressionSyntax expression,
        SemanticModel model,
        bool callSourcesOnly = false)
    {
        switch (expression)
        {
            case null:
                yield break;

            case ParenthesizedExpressionSyntax paren:
                foreach (ISymbol source in ResolveSources(paren.Expression, model, callSourcesOnly))
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
                foreach (ISymbol source in ResolveSources(coalesce.Right, model, callSourcesOnly))
                {
                    yield return source;
                }

                break;

            // `cond ? a : b`: either branch may flow through.
            case ConditionalExpressionSyntax ternary:
                foreach (ISymbol source in ResolveSources(ternary.WhenTrue, model, callSourcesOnly)
                    .Concat(ResolveSources(ternary.WhenFalse, model, callSourcesOnly)))
                {
                    yield return source;
                }

                break;

            case CastExpressionSyntax cast:
                foreach (ISymbol source in ResolveSources(cast.Expression, model, callSourcesOnly))
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
                if (callSourcesOnly)
                {
                    yield break;
                }

                ISymbol symbol = model.GetSymbolInfo(expression).Symbol;
                if (symbol != null && (IsValueDeclarationSymbol(symbol) || symbol is IMethodSymbol))
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

    private sealed class TaintResult
    {
        public TaintResult(HashSet<ISymbol> tainted) => this.Tainted = tainted;

        public HashSet<ISymbol> Tainted { get; }
    }
}
