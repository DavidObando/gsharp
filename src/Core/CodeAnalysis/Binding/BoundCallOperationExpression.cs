// <copyright file="BoundCallOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// The shape shared by every bound node that CALLS a method (ADR-0169, issue
/// #3920).
/// </summary>
/// <remarks>
/// <para>
/// G# binds a call to a different node for each callee provenance —
/// same-compilation static and instance, imported static and instance,
/// constrained static-virtual, base-interface, and raw CLR static. Roslyn
/// models all of them as one <c>IInvocationOperation</c>.
/// </para>
/// <para>
/// The split is a codegen distinction, not a program-meaning one, and an
/// analyzer that does not know it silently sees a fraction of the calls in the
/// program. Covering only the first three left <c>receiver.Method()</c> — the
/// most ordinary call there is, a <c>BoundUserInstanceCallExpression</c> —
/// invisible to every migrated invocation rule (PR #3968 review). The concrete
/// nodes and their <see cref="BoundNode.Kind"/> values are unchanged.
/// </para>
/// <para>
/// Two call shapes deliberately stay outside this base because they have no
/// callee symbol to report: <c>BoundIndirectCallExpression</c> invokes a
/// delegate VALUE, and <c>BoundBaseClassCallExpression</c>'s property-accessor
/// form carries neither a <c>FunctionSymbol</c> nor a <c>MethodInfo</c>.
/// Constructor calls are excluded by design — Roslyn models those as
/// <c>ObjectCreation</c>, not <c>Invocation</c>.
/// </para>
/// </remarks>
public abstract class BoundCallOperationExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCallOperationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    private protected BoundCallOperationExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the symbol of the called method — the Roslyn
    /// <c>IInvocationOperation.TargetMethod</c> analogue. Typed as
    /// <see cref="Symbol"/>: a same-compilation callee is a
    /// <see cref="FunctionSymbol"/> and an imported one an
    /// <see cref="ImportedFunctionSymbol"/>, and <see cref="Symbol.Name"/> and
    /// <see cref="Symbol.ContainingType"/> — the members the Roslyn call-site
    /// surface maps onto — are meaningful on both.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT a richer callee type. The two other members a migrated
    /// analyzer reaches through <c>TargetMethod</c> cannot be answered from
    /// this symbol honestly (PR #3968 review):
    /// <list type="bullet">
    /// <item><description><c>ReturnType</c> — the callee symbol carries the
    /// DECLARATION's return type, so a constructed generic call reports
    /// <c>T</c> where the call site produces <c>int32</c>. cs2gs maps
    /// <c>TargetMethod.ReturnType</c> to the call node's own
    /// <see cref="BoundExpression.Type"/>, which is the constructed
    /// type.</description></item>
    /// <item><description><c>OverriddenMethod</c> — an imported callee has no
    /// override chain in G#, so exposing it here would answer null for every
    /// call into metadata. A member that silently returns null for the common
    /// case is worse than an absent one, because analyzers branch on it; it is
    /// absent, and cs2gs reports reaching it as a gap.</description></item>
    /// </list>
    /// </remarks>
    public abstract Symbol CalledFunction { get; }

    /// <summary>Gets the arguments, in source order.</summary>
    public abstract ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Builds the callee symbol for a node that stores the reflected method
    /// rather than a symbol. Only the analyzer surface needs one, so it is
    /// built on demand by the caller and cached there.
    /// </summary>
    /// <param name="method">The reflected callee.</param>
    /// <param name="returnType">
    /// The CALL SITE's return type, which is what the node already computed:
    /// an imported generic method closed over a user-defined type reflects a
    /// placeholder return type, so deriving it from <paramref name="method"/>
    /// would report the placeholder (PR #3968 review).
    /// </param>
    /// <returns>The callee symbol.</returns>
    private protected static ImportedFunctionSymbol ImportedCallee(
        MethodInfo method, TypeSymbol returnType)
        => new(
            method.Name,
            new ImportedClassSymbol(method.DeclaringType ?? typeof(object), declaration: null),
            method,
            declaration: null,
            returnTypeOverride: returnType);
}
