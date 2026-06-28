#nullable disable

// <copyright file="BoundConstrainedStaticCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0089 / issue #755: a constrained static-virtual interface call site
/// of the form <c>T.Method(args)</c> where <c>T</c> is a generic
/// type-parameter constrained to <see cref="InterfaceSymbol"/>. The
/// emitter lowers this to the IL sequence
/// <c>constrained. !!T  call !iface::Method(args)</c> (ECMA-335 §III.2.1);
/// the interpreter resolves <see cref="InterfaceMethod"/> on the runtime
/// type-argument's <see cref="StructSymbol.StaticMethods"/> table.
/// </summary>
public sealed class BoundConstrainedStaticCallExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundConstrainedStaticCallExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="typeParameter">The receiver type parameter (the <c>T</c> in <c>T.M(...)</c>).</param>
    /// <param name="interfaceMethod">The static-virtual interface method symbol that supplies the slot.</param>
    /// <param name="arguments">The bound argument expressions in declared order.</param>
    /// <param name="returnType">The call-site (post-substitution) return type.</param>
    public BoundConstrainedStaticCallExpression(
        SyntaxNode syntax,
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

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConstrainedStaticCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ReturnType ?? InterfaceMethod.Type;

    /// <summary>Gets the type-parameter symbol that supplies the runtime receiver (the <c>T</c> in <c>T.M(...)</c>).</summary>
    public TypeParameterSymbol TypeParameter { get; }

    /// <summary>Gets the static-virtual interface method symbol that supplies the slot.</summary>
    public FunctionSymbol InterfaceMethod { get; }

    /// <summary>Gets the bound argument expressions in declared order.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the call-site (post-substitution) return type, or <c>null</c> to fall back to <see cref="InterfaceMethod"/>.<see cref="FunctionSymbol.Type"/>.</summary>
    public TypeSymbol ReturnType { get; }
}
