// <copyright file="BoundFunctionLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A bound function literal (Phase 4.7). Holds a synthesized
/// <see cref="FunctionSymbol"/> together with the bound body. The set of
/// captured outer variables is recorded so the evaluator can snapshot them
/// when the literal is evaluated to a runtime closure value.
/// </summary>
public sealed class BoundFunctionLiteralExpression : BoundExpression
{
    public BoundFunctionLiteralExpression(
        SyntaxNode? syntax,
        FunctionSymbol function,
        FunctionTypeSymbol type,
        BoundBlockStatement body,
        ImmutableArray<VariableSymbol> capturedVariables)
        : base(syntax)
    {
        Function = function;
        function.IsFunctionLiteral = true;
        FunctionType = type;
        Body = body;
        CapturedVariables = capturedVariables;
    }

    public FunctionSymbol Function { get; }

    public FunctionTypeSymbol FunctionType { get; }

    public BoundBlockStatement Body { get; }

    /// <summary>
    /// Gets the set of outer variables this literal reads or writes. The
    /// setter is internal: issue #4221's transitive-capture reconciliation
    /// (<see cref="LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures"/>)
    /// widens this set after initial binding when a generic local function
    /// calls a sibling that itself captures outer state, so the caller's
    /// synthesized environment ends up with a field for every variable any
    /// callee it directly invokes will need at the call site.
    /// </summary>
    public ImmutableArray<VariableSymbol> CapturedVariables { get; internal set; }

    public override TypeSymbol Type => FunctionType;

    public override BoundNodeKind Kind => BoundNodeKind.FunctionLiteralExpression;

    /// <summary>
    /// Gets or sets the evaluator's lazily lowered body. Concurrent first use
    /// may compute equivalent bodies; <c>Lower</c> allocates a fresh
    /// <c>Lowerer</c> per call and holds no static state, so either cached value
    /// is safe.
    /// </summary>
    internal BoundBlockStatement? LoweredBody { get; set; }

    /// <summary>
    /// Gets or sets the enclosing method/type type parameter this GENERIC
    /// local-function literal (<c>let Name[T, ...] = func ...</c>)
    /// referenced in its own signature, an own type-parameter constraint, or
    /// its body, cached at the literal's own bind time (see
    /// <see cref="LambdaBinder.PrepareGenericLocalFunctionDeclaration"/>).
    /// Null for every literal outside that gate's scope. Issue #4223/#4221
    /// merge follow-up: the gate rejects this combination only when the
    /// literal ALSO captures outer state (issue #4221/#4252's capturing
    /// generic-local-function path has not been extended to carry an extra
    /// enclosing type parameter the way the zero-capture path has); but
    /// <see cref="CapturedVariables"/> can be widened AFTER that initial
    /// check, by <see cref="LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures"/>,
    /// for a forward reference to, or a call cycle with, a sibling that
    /// captures outer state. Caching the offender here lets that later
    /// widening re-evaluate the exclusion instead of silently letting an
    /// unsupported shape reach the emitter.
    /// </summary>
    internal TypeParameterSymbol? EnclosingTypeParameterOffender { get; set; }

    /// <summary>
    /// Gets or sets the site to report <see cref="EnclosingTypeParameterOffender"/>
    /// against, valid whenever that property is non-null.
    /// </summary>
    internal TextLocation EnclosingTypeParameterOffenderLocation { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the "local function cannot
    /// reference enclosing type parameter" diagnostic has already been
    /// reported for this literal, so a later re-check (after
    /// <see cref="CapturedVariables"/> widens) does not report it a second
    /// time.
    /// </summary>
    internal bool EnclosingTypeParameterDiagnosticReported { get; set; }
}
