// <copyright file="TypeDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// A class/struct/data-class/data-struct/inline-struct/interface declaration
/// (ADR-0115 §B.4/§B.6/§B.7). The base clause lists the base class first, then
/// interfaces (ADR-0115 §B.6).
/// </summary>
public sealed class TypeDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TypeDeclaration"/> class.
    /// </summary>
    /// <param name="kind">The aggregate kind.</param>
    /// <param name="name">The type name.</param>
    /// <param name="typeParameters">The generic type parameters.</param>
    /// <param name="primaryConstructorParameters">The optional primary-constructor parameter list.</param>
    /// <param name="baseType">The optional base type (rendered first in the base clause).</param>
    /// <param name="baseConstructorArguments">
    /// The optional primary-constructor base-call arguments (<c>: Base(args)</c>,
    /// issue #1909) — forwards this type's primary-constructor parameters (or
    /// other expressions) to the base class's designated constructor.
    /// </param>
    /// <param name="interfaces">The implemented interfaces.</param>
    /// <param name="members">The body members.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="isOpen">Whether the type is <c>open</c> for subclassing.</param>
    /// <param name="isSealed">Whether the type is a <c>sealed</c> closed hierarchy.</param>
    /// <param name="isAbstract">Whether the type is <c>abstract</c>.</param>
    /// <param name="hasBody">Whether to render a body block (false emits the bodyless primary-ctor form).</param>
    /// <param name="attributes">The type attributes.</param>
    /// <param name="isUnsafe">Whether the type is <c>unsafe</c> (its body is an unsafe context).</param>
    public TypeDeclaration(
        TypeDeclarationKind kind,
        string name,
        IReadOnlyList<TypeParameter> typeParameters = null,
        IReadOnlyList<Parameter> primaryConstructorParameters = null,
        GTypeReference baseType = null,
        IReadOnlyList<GExpression> baseConstructorArguments = null,
        IReadOnlyList<GTypeReference> interfaces = null,
        IReadOnlyList<GMember> members = null,
        Visibility visibility = Visibility.Default,
        bool isOpen = false,
        bool isSealed = false,
        bool isAbstract = false,
        bool hasBody = true,
        IReadOnlyList<AttributeUse> attributes = null,
        bool isUnsafe = false)
    {
        Kind = kind;
        Name = name;
        TypeParameters = typeParameters ?? new List<TypeParameter>();
        PrimaryConstructorParameters = primaryConstructorParameters;
        BaseType = baseType;
        BaseConstructorArguments = baseConstructorArguments;
        Interfaces = interfaces ?? new List<GTypeReference>();
        Members = members ?? new List<GMember>();
        Visibility = visibility;
        IsOpen = isOpen;
        IsSealed = isSealed;
        IsAbstract = isAbstract;
        HasBody = hasBody;
        Attributes = attributes ?? new List<AttributeUse>();
        IsUnsafe = isUnsafe;
    }

    /// <summary>Gets the aggregate kind.</summary>
    public TypeDeclarationKind Kind { get; }

    /// <summary>Gets the type name.</summary>
    public string Name { get; }

    /// <summary>Gets the generic type parameters.</summary>
    public IReadOnlyList<TypeParameter> TypeParameters { get; }

    /// <summary>Gets the optional primary-constructor parameter list, or <see langword="null"/> if absent.</summary>
    public IReadOnlyList<Parameter> PrimaryConstructorParameters { get; }

    /// <summary>Gets the optional base type, rendered first in the base clause.</summary>
    public GTypeReference BaseType { get; }

    /// <summary>
    /// Gets the optional primary-constructor base-call arguments (<c>: Base(args)</c>,
    /// issue #1909), or <see langword="null"/> when the base clause carries no
    /// argument list (implicit parameterless base chaining).
    /// </summary>
    public IReadOnlyList<GExpression> BaseConstructorArguments { get; }

    /// <summary>Gets the implemented interfaces.</summary>
    public IReadOnlyList<GTypeReference> Interfaces { get; }

    /// <summary>Gets the body members.</summary>
    public IReadOnlyList<GMember> Members { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets a value indicating whether the type is <c>open</c>.</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether the type is <c>sealed</c>.</summary>
    public bool IsSealed { get; }

    /// <summary>Gets a value indicating whether the type is <c>abstract</c>.</summary>
    public bool IsAbstract { get; }

    /// <summary>Gets a value indicating whether to render a body block.</summary>
    public bool HasBody { get; }

    /// <summary>Gets the type attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }

    /// <summary>
    /// Gets a value indicating whether the type is <c>unsafe</c> (ADR-0122 /
    /// issue #1014); its whole body is an unsafe context.
    /// </summary>
    public bool IsUnsafe { get; }
}

/// <summary>
/// A single enum case (ADR-0115 §B.11). Payload parameters turn the enum into a
/// discriminated union (ADR-0078 §5).
/// </summary>
public sealed class EnumCase : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumCase"/> class.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="payloadParameters">The optional payload parameters.</param>
    /// <param name="explicitValue">
    /// The explicit int32 constant value (issue #1912), when the source C#
    /// case has one and it differs from the default sequential ordinal.
    /// </param>
    public EnumCase(string name, IReadOnlyList<Parameter> payloadParameters = null, int? explicitValue = null)
    {
        Name = name;
        PayloadParameters = payloadParameters ?? new List<Parameter>();
        ExplicitValue = explicitValue;
    }

    /// <summary>Gets the case name.</summary>
    public string Name { get; }

    /// <summary>Gets the optional payload parameters.</summary>
    public IReadOnlyList<Parameter> PayloadParameters { get; }

    /// <summary>
    /// Gets the explicit int32 constant value (issue #1912), e.g. <c>Banana = 2</c>,
    /// <c>Unknown = -1</c>, or a resolved <c>[Flags]</c>/alias value. Null when
    /// the case uses the default auto-numbered ordinal.
    /// </summary>
    public int? ExplicitValue { get; }
}

/// <summary>
/// An <c>enum Name { A, B, C }</c> declaration (ADR-0115 §B.11).
/// </summary>
public sealed class EnumDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumDeclaration"/> class.
    /// </summary>
    /// <param name="name">The enum name.</param>
    /// <param name="cases">The enum cases.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="attributes">The enum attributes.</param>
    public EnumDeclaration(
        string name,
        IReadOnlyList<EnumCase> cases,
        Visibility visibility = Visibility.Default,
        IReadOnlyList<AttributeUse> attributes = null)
    {
        Name = name;
        Cases = cases ?? new List<EnumCase>();
        Visibility = visibility;
        Attributes = attributes ?? new List<AttributeUse>();
    }

    /// <summary>Gets the enum name.</summary>
    public string Name { get; }

    /// <summary>Gets the enum cases.</summary>
    public IReadOnlyList<EnumCase> Cases { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets the enum attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }
}

/// <summary>
/// A named delegate declaration <c>type Name = delegate func(params) R</c>
/// (ADR-0059, ADR-0115 §B.8) — the one place the <c>func</c> keyword stays in a
/// type position.
/// </summary>
public sealed class NamedDelegateDeclaration : GMember
{
    /// <summary>
    /// Initializes a new instance of the <see cref="NamedDelegateDeclaration"/> class.
    /// </summary>
    /// <param name="name">The delegate type name.</param>
    /// <param name="parameters">The delegate parameters.</param>
    /// <param name="returnType">The return type, or <see langword="null"/> for void.</param>
    /// <param name="visibility">The accessibility.</param>
    /// <param name="attributes">The delegate attributes.</param>
    /// <param name="typeParameters">
    /// The generic type parameters (issue #1960, ADR-0059 "Follow-up work" —
    /// generic delegate aliases <c>type Predicate[T any] = delegate func(value T) bool</c>
    /// are supported by gsc; a null/empty list is a non-generic delegate.
    /// </param>
    public NamedDelegateDeclaration(
        string name,
        IReadOnlyList<Parameter> parameters = null,
        GTypeReference returnType = null,
        Visibility visibility = Visibility.Default,
        IReadOnlyList<AttributeUse> attributes = null,
        IReadOnlyList<TypeParameter> typeParameters = null)
    {
        Name = name;
        Parameters = parameters ?? new List<Parameter>();
        ReturnType = returnType;
        Visibility = visibility;
        Attributes = attributes ?? new List<AttributeUse>();
        TypeParameters = typeParameters ?? new List<TypeParameter>();
    }

    /// <summary>Gets the delegate type name.</summary>
    public string Name { get; }

    /// <summary>Gets the delegate parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; }

    /// <summary>Gets the return type, or <see langword="null"/> for void.</summary>
    public GTypeReference ReturnType { get; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; }

    /// <summary>Gets the delegate attributes.</summary>
    public IReadOnlyList<AttributeUse> Attributes { get; }

    /// <summary>Gets the generic type parameters.</summary>
    public IReadOnlyList<TypeParameter> TypeParameters { get; }
}
