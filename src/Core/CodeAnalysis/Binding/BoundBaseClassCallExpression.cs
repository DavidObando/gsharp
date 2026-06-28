// <copyright file="BoundBaseClassCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #986: a base-class call expression of the form
/// <c>base.Method(args)</c> (and the bracketed
/// <c>base[BaseClass].Method(args)</c> form). Lets an override delegate to
/// the nearest base class's virtual implementation non-virtually — exactly
/// like C# <c>base.M(...)</c>. The emitter lowers this to
/// <c>ldarg.0</c> + a non-virtual <c>call instance R BaseClass::Method(...)</c>;
/// the interpreter dispatches directly to the base method body without
/// re-entering the derived type's v-table (which would recurse infinitely).
/// </summary>
public sealed class BoundBaseClassCallExpression : BoundExpression
{
    private readonly TypeSymbol returnTypeOverride;

    /// <summary>Initializes a new instance of the <see cref="BoundBaseClassCallExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The implicit <c>this</c> receiver of the enclosing instance member.</param>
    /// <param name="baseClass">The base class whose member is invoked (the declaring type of <paramref name="method"/>).</param>
    /// <param name="method">The base-class method whose implementation is invoked non-virtually, or <see langword="null"/> for a base auto-property accessor (issue #1347), in which case <paramref name="property"/> identifies the accessor and <paramref name="returnTypeOverride"/> must be supplied.</param>
    /// <param name="arguments">The bound argument expressions in declared order.</param>
    /// <param name="returnTypeOverride">Optional substituted return type for a constructed generic base; <see langword="null"/> uses <see cref="FunctionSymbol.Type"/>. Required when <paramref name="method"/> is <see langword="null"/>.</param>
    /// <param name="property">Issue #1347: the base auto-property whose synthesized accessor is invoked non-virtually, or <see langword="null"/> for an ordinary method/computed-accessor call.</param>
    /// <param name="isSetterAccessor">Issue #1347: when <paramref name="property"/> is set, whether the setter accessor (rather than the getter) is invoked.</param>
    public BoundBaseClassCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        StructSymbol baseClass,
        FunctionSymbol method,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol returnTypeOverride = null,
        PropertySymbol property = null,
        bool isSetterAccessor = false)
        : base(syntax)
    {
        Receiver = receiver;
        BaseClass = baseClass;
        Method = method;
        Arguments = arguments;
        this.returnTypeOverride = returnTypeOverride;
        Property = property;
        IsSetterAccessor = isSetterAccessor;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BaseClassCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => returnTypeOverride ?? Method?.Type;

    /// <summary>Gets the implicit <c>this</c> receiver — a <see cref="BoundVariableExpression"/> reading the enclosing method's first parameter.</summary>
    public BoundExpression Receiver { get; }

    /// <summary>Gets the base class whose member is invoked (the declaring type of <see cref="Method"/> or <see cref="Property"/>).</summary>
    public StructSymbol BaseClass { get; }

    /// <summary>Gets the base-class method whose implementation is invoked non-virtually, or <see langword="null"/> for a base auto-property accessor (issue #1347).</summary>
    public FunctionSymbol Method { get; }

    /// <summary>
    /// Gets the base auto-property whose synthesized accessor is invoked
    /// non-virtually, or <see langword="null"/> for an ordinary method or
    /// computed-accessor call (issue #1347). Auto-properties have no accessor
    /// <see cref="FunctionSymbol"/>, so the accessor is resolved through the
    /// property's emitted get_/set_ MethodDef (or, in the interpreter, its
    /// synthesized backing field).
    /// </summary>
    public PropertySymbol Property { get; }

    /// <summary>Gets a value indicating whether <see cref="Property"/>'s setter accessor (rather than its getter) is invoked (issue #1347).</summary>
    public bool IsSetterAccessor { get; }

    /// <summary>Gets the bound argument expressions in declared order.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }
}
