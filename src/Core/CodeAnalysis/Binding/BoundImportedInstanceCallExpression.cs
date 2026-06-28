#nullable disable

// <copyright file="BoundImportedInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound call expression for an instance method invoked on a value whose type
/// originates from a CLR <see cref="System.Type"/>.
/// </summary>
public sealed class BoundImportedInstanceCallExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundImportedInstanceCallExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The expression that produces the instance.</param>
    /// <param name="method">The <see cref="MethodInfo"/> to invoke.</param>
    /// <param name="returnType">The bound return type.</param>
    /// <param name="arguments">The provided arguments.</param>
    /// <param name="argumentRefKinds">Per-argument ref-kind annotations (default all-None).</param>
    /// <param name="typeArgumentSymbols">
    /// Issue #320: when the call site supplied an explicit generic type-argument
    /// list (e.g. <c>provider.GetService[Clock]()</c>), the resolved type-argument
    /// <see cref="TypeSymbol"/>s in source order. Used by the emitter to encode the
    /// generic method specification so user-defined type arguments (which have no
    /// reference-context CLR type) are written as their own TypeDef token. Default
    /// when there are no explicit type arguments.
    /// </param>
    /// <param name="constrainedReceiverTypeParameter">
    /// Issue #943: when the call is dispatched through a type parameter's CLR
    /// interface constraint (e.g. <c>a.CompareTo(b)</c> with <c>T : IComparable[T]</c>),
    /// the constrained type parameter whose address feeds a <c>constrained.</c>
    /// prefix. Default for ordinary imported instance calls.
    /// </param>
    /// <param name="constrainedInterfaceType">
    /// Issue #943: the symbolic (possibly constructed generic) interface type
    /// that parents the emitted <c>MemberRef</c> for a constrained call. Default
    /// for ordinary imported instance calls.
    /// </param>
    /// <param name="isNonVirtualBaseCall">
    /// Issue #1260: when <see langword="true"/>, this call originates from a
    /// <c>base.Member(...)</c> (or <c>base.Prop</c>) access into an imported/BCL
    /// base class and must be emitted with a non-virtual <c>call</c> (not
    /// <c>callvirt</c>), exactly like C# <c>base.M(...)</c> — otherwise the
    /// virtual dispatch would re-enter the derived override and recurse
    /// infinitely. Default <see langword="false"/> for ordinary imported
    /// instance calls.
    /// </param>
    public BoundImportedInstanceCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        MethodInfo method,
        TypeSymbol returnType,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds = default,
        ImmutableArray<TypeSymbol> typeArgumentSymbols = default,
        TypeParameterSymbol constrainedReceiverTypeParameter = null,
        TypeSymbol constrainedInterfaceType = null,
        bool isNonVirtualBaseCall = false)
        : base(syntax)
    {
        Receiver = receiver;
        Method = method;
        Type = returnType;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
        TypeArgumentSymbols = typeArgumentSymbols.IsDefault ? default : typeArgumentSymbols;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
        IsNonVirtualBaseCall = isNonVirtualBaseCall;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ImportedInstanceCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the receiver expression.
    /// </summary>
    public BoundExpression Receiver { get; }

    /// <summary>
    /// Gets the method to invoke.
    /// </summary>
    public MethodInfo Method { get; }

    /// <summary>
    /// Gets the bound arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    /// </summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }

    /// <summary>
    /// Gets the explicit generic type-argument symbols, in source order, when the
    /// call site supplied a <c>[T1, T2]</c> list closing an imported generic
    /// method (issue #320). Default when there are no explicit type arguments.
    /// </summary>
    public ImmutableArray<TypeSymbol> TypeArgumentSymbols { get; }

    /// <summary>
    /// Gets the type parameter the call is constrained through, when the
    /// receiver is a value of a generic type parameter whose interface
    /// constraint declares the invoked method (issue #943, e.g. calling
    /// <c>a.CompareTo(b)</c> where <c>a : T</c> and <c>T : IComparable[T]</c>).
    /// When non-<c>null</c>, the emitter loads the receiver by address, prefixes
    /// the call with <c>constrained. !!T</c>, and parents the <c>MemberRef</c> at
    /// <see cref="ConstrainedInterfaceType"/> so the IL is verifiable for both
    /// value-type and reference-type substitutions. <c>null</c> for an ordinary
    /// imported instance call.
    /// </summary>
    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    /// <summary>
    /// Gets the (possibly constructed-generic) interface type that parents the
    /// emitted <c>MemberRef</c> when <see cref="ConstrainedReceiverTypeParameter"/>
    /// is set (issue #943) — e.g. <c>System.IComparable[T]</c>. <c>null</c> for an
    /// ordinary imported instance call.
    /// </summary>
    public TypeSymbol ConstrainedInterfaceType { get; }

    /// <summary>Gets a value indicating whether this call dispatches through a type-parameter interface constraint (issue #943).</summary>
    public bool IsConstrainedTypeParameterCall => ConstrainedReceiverTypeParameter != null;

    /// <summary>
    /// Gets a value indicating whether this call originates from a
    /// <c>base.Member(...)</c>/<c>base.Prop</c> access into an imported/BCL base
    /// class (issue #1260), which the emitter lowers with a non-virtual
    /// <c>call</c> rather than <c>callvirt</c> so it does not re-enter the derived
    /// override.
    /// </summary>
    public bool IsNonVirtualBaseCall { get; }
}
