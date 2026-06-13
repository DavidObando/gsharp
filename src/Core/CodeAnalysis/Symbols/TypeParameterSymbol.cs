// <copyright file="TypeParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A generic type-parameter declared on a generic function or type (Phase 4.1 / ADR-0020).
/// At the binder level it behaves like a stand-in <see cref="TypeSymbol"/>; at call sites
/// it is substituted with a concrete type argument either from an explicit type-argument
/// list or via inference from value arguments.
/// </summary>
public sealed class TypeParameterSymbol : TypeSymbol
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterSymbol"/> class.</summary>
    /// <param name="name">The type-parameter name (e.g. <c>T</c>).</param>
    /// <param name="ordinal">The zero-based position of this parameter in its declaring list.</param>
    /// <param name="constraint">The constraint kind (Phase 4.1: only <see cref="TypeParameterConstraint.Any"/>; Phase 4.2 widens this).</param>
    /// <param name="variance">The variance modifier (Phase 4.3 / ADR-0021).</param>
    /// <param name="interfaceConstraint">Optional sealed-interface constraint (Phase 4.2b / ADR-0020). When non-<c>null</c>, type arguments must implement this interface and the enum <paramref name="constraint"/> is set to <see cref="TypeParameterConstraint.Any"/> (the interface bound subsumes <c>any</c>).</param>
    public TypeParameterSymbol(string name, int ordinal, TypeParameterConstraint constraint, TypeParameterVariance variance, InterfaceSymbol interfaceConstraint = null)
        : base(name)
    {
        Ordinal = ordinal;
        Constraint = constraint;
        Variance = variance;
        InterfaceConstraint = interfaceConstraint;
    }

    /// <summary>Gets the zero-based ordinal of this type parameter in its declaring list.</summary>
    public int Ordinal { get; }

    /// <summary>Gets the constraint applied to this type parameter (Phase 4.2 will add comparable / sealed-interface bounds).</summary>
    public TypeParameterConstraint Constraint { get; }

    /// <summary>Gets the variance modifier (Phase 4.3 / ADR-0021).</summary>
    public TypeParameterVariance Variance { get; }

    /// <summary>Gets or sets the sealed-interface constraint, if any (Phase 4.2b / ADR-0020). When non-<c>null</c>, type arguments must implement this interface. ADR-0089 allows late patching by the binder when the constraint is a self-referential constructed generic such as <c>[T IAdd[T]]</c>.</summary>
    public InterfaceSymbol InterfaceConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries a
    /// reference-type (<c>class</c>) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a reference type
    /// (<c>!IsValueType</c> at the CLR level). Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.ReferenceTypeConstraint"/>
    /// in emitted IL.
    /// </summary>
    public bool HasReferenceTypeConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries a
    /// value-type (<c>struct</c>) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a non-nullable value type. Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint"/>
    /// in emitted IL. A <c>struct</c> constraint implies the
    /// <c>new()</c> (default-constructor) flag at the CLR level — the
    /// emitter sets both bits automatically per ECMA-335 II.10.1.7.
    /// </summary>
    public bool HasValueTypeConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter carries
    /// the default-constructor (<c>new()</c>) constraint (ADR-0097 /
    /// issue #775). Type arguments must either be a value type or expose a
    /// public parameterless constructor. Maps to
    /// <see cref="System.Reflection.GenericParameterAttributes.DefaultConstructorConstraint"/>
    /// in emitted IL.
    /// </summary>
    public bool HasDefaultConstructorConstraint { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this type parameter is declared
    /// on a generic method (as opposed to a generic type). When
    /// <see langword="true"/> the emitter encodes it as
    /// <c>MVAR(<see cref="Ordinal"/>)</c>; when <see langword="false"/> as
    /// <c>VAR(<see cref="Ordinal"/>)</c> (ADR-0087 §3, R2).
    /// </summary>
    /// <remarks>
    /// Set by the binder when the type parameter is attached to a
    /// <c>FunctionSymbol</c>. Type-type parameters keep the default
    /// <see langword="false"/>.
    /// </remarks>
    public bool IsMethodTypeParameter { get; set; }
}
