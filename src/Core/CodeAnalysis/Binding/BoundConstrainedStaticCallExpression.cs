// <copyright file="BoundConstrainedStaticCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0089 / issue #755: a constrained static-virtual interface call site
/// of the form <c>T.Method(args)</c> where <c>T</c> is a generic
/// type-parameter constrained to <see cref="InterfaceSymbol"/>. The
/// emitter lowers this to the IL sequence
/// <c>constrained. !!T  call !iface::Method(args)</c> (ECMA-335 §III.2.1);
/// the interpreter resolves <see cref="InterfaceMethod"/> on the runtime
/// type-argument's <see cref="StructSymbol.StaticMethods"/> table.
/// Issue #3525: the same call shape also covers a type-parameter constrained
/// to an imported CLR interface (e.g. <c>T : IParsable[T]</c>) — that
/// variant carries <see cref="ClrMethod"/>/<see cref="ConstrainedInterfaceType"/>
/// instead of <see cref="InterfaceMethod"/>.
/// </summary>
public sealed class BoundConstrainedStaticCallExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundConstrainedStaticCallExpression"/> class for a source-interface static-virtual slot.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="typeParameter">The receiver type parameter (the <c>T</c> in <c>T.M(...)</c>).</param>
    /// <param name="interfaceMethod">The static-virtual interface method symbol that supplies the slot.</param>
    /// <param name="arguments">The bound argument expressions in declared order.</param>
    /// <param name="returnType">The call-site (post-substitution) return type.</param>
    public BoundConstrainedStaticCallExpression(
        SyntaxNode? syntax,
        TypeParameterSymbol typeParameter,
        FunctionSymbol interfaceMethod,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol returnType)
        : base(syntax)
    {
        TypeParameter = typeParameter;
        InterfaceMethod = interfaceMethod;
        Arguments = arguments;
        ReturnType = returnType;
    }

    /// <summary>Initializes a new instance of the <see cref="BoundConstrainedStaticCallExpression"/> class for a static-virtual member declared by an imported CLR interface (issue #3525).</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="typeParameter">The receiver type parameter (the <c>T</c> in <c>T.M(...)</c>).</param>
    /// <param name="clrMethod">The static-virtual interface method resolved via reflection.</param>
    /// <param name="arguments">The bound argument expressions in declared (parameter) order.</param>
    /// <param name="argumentRefKinds">Per-argument ref-kind annotations (default all-None).</param>
    /// <param name="returnType">The call-site return type.</param>
    /// <param name="constrainedInterfaceType">The (possibly constructed generic) imported interface type that parents the emitted <c>MemberRef</c>.</param>
    public BoundConstrainedStaticCallExpression(
        SyntaxNode? syntax,
        TypeParameterSymbol typeParameter,
        MethodInfo clrMethod,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds,
        TypeSymbol returnType,
        TypeSymbol constrainedInterfaceType)
        : base(syntax)
    {
        TypeParameter = typeParameter;
        ClrMethod = clrMethod;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
        ReturnType = returnType;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConstrainedStaticCallExpression;

    /// <inheritdoc/>
    // ReturnType is always supplied by both constructors (see call sites), so this
    // fallback chain is dead in practice; ClrMethod! is safe because the only way
    // to reach it is InterfaceMethod being null, which happens exclusively via the
    // ClrMethod-taking constructor overload, which requires a non-null clrMethod.
    public override TypeSymbol Type => ReturnType ?? InterfaceMethod?.Type ?? TypeSymbol.FromClrType(ClrMethod!.ReturnType);

    /// <summary>Gets the type-parameter symbol that supplies the runtime receiver (the <c>T</c> in <c>T.M(...)</c>).</summary>
    public TypeParameterSymbol TypeParameter { get; }

    /// <summary>Gets the static-virtual interface method symbol that supplies the slot, when the constraint is a source G# interface. <see langword="null"/> when <see cref="ClrMethod"/> is set instead.</summary>
    public FunctionSymbol? InterfaceMethod { get; }

    /// <summary>Gets the static-virtual interface method resolved via reflection, when the constraint is an imported CLR interface (issue #3525). <see langword="null"/> when <see cref="InterfaceMethod"/> is set instead.</summary>
    public MethodInfo? ClrMethod { get; }

    /// <summary>Gets the bound argument expressions in declared order.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the per-argument ref-kind annotations for the <see cref="ClrMethod"/> shape. May be default (all-None).</summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }

    /// <summary>Gets the call-site (post-substitution) return type, or <c>null</c> to fall back to <see cref="InterfaceMethod"/>.<see cref="FunctionSymbol.Type"/>.</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>
    /// Gets the (possibly constructed generic) imported interface type that
    /// parents the emitted <c>MemberRef</c> for the <see cref="ClrMethod"/>
    /// shape (issue #3525) — e.g. <c>System.IParsable[T]</c>. <c>null</c> for
    /// the source-interface shape.
    /// </summary>
    public TypeSymbol? ConstrainedInterfaceType { get; }
}
