// <copyright file="TypeDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic

/// A class/struct/data-class/data-struct/inline-struct/interface declaration
/// (ADR-0115 §B.4/§B.6/§B.7). The base clause lists the base class first, then
/// interfaces (ADR-0115 §B.6).
class TypeDeclaration : GMember {
    /// Initializes a new instance of the (cref:TypeDeclaration) class.
    /// @param kind The aggregate kind.
    /// @param name The type name.
    /// @param typeParameters The generic type parameters.
    /// @param primaryConstructorParameters The optional primary-constructor parameter list.
    /// @param baseType The optional base type (rendered first in the base clause).
    /// @param baseConstructorArguments The optional primary-constructor base-call arguments
    /// (`: Base(args)`,
    /// issue #1909) — forwards this type's primary-constructor parameters (or
    /// other expressions) to the base class's designated constructor.
    /// @param interfaces The implemented interfaces.
    /// @param members The body members.
    /// @param visibility The accessibility.
    /// @param isOpen Whether the type is `open` for subclassing.
    /// @param isSealed Whether the type is a `sealed` closed hierarchy.
    /// @param isAbstract Whether the type is `abstract`.
    /// @param isPartial Whether the type is `partial` (ADR-0144 §G).
    /// @param hasBody Whether to render a body block (false emits the bodyless primary-ctor form).
    /// @param attributes The type attributes.
    /// @param isUnsafe Whether the type is `unsafe` (its body is an unsafe context).
    /// @param isRefLike Whether the type is a by-ref-like `ref struct` (ADR-0058 / issue #367).
    /// @param isShared Whether the type is a `shared class` (ADR-0195 / issue #4674): a C# static class.
    init(
        kind TypeDeclarationKind,
        name string,
        typeParameters IReadOnlyList[TypeParameter]? = nil,
        primaryConstructorParameters IReadOnlyList[Parameter]? = nil,
        baseType GTypeReference? = nil,
        baseConstructorArguments IReadOnlyList[GExpression]? = nil,
        interfaces IReadOnlyList[GTypeReference]? = nil,
        members IReadOnlyList[GMember]? = nil,
        visibility Visibility = Visibility.Default,
        isOpen bool = false,
        isSealed bool = false,
        isAbstract bool = false,
        isPartial bool = false,
        hasBody bool = true,
        attributes IReadOnlyList[AttributeUse]? = nil,
        isUnsafe bool = false,
        isRefLike bool = false,
        isShared bool = false
    ) {
        Kind = kind
        Name = name
        TypeParameters = typeParameters ?? List[TypeParameter]()
        PrimaryConstructorParameters = primaryConstructorParameters
        BaseType = baseType
        BaseConstructorArguments = baseConstructorArguments
        Interfaces = interfaces ?? List[GTypeReference]()
        Members = members ?? List[GMember]()
        Visibility = visibility
        IsOpen = isOpen
        IsSealed = isSealed
        IsAbstract = isAbstract
        IsPartial = isPartial
        HasBody = hasBody
        Attributes = attributes ?? List[AttributeUse]()
        IsUnsafe = isUnsafe
        IsRefLike = isRefLike
        IsShared = isShared
    }

    /// Gets the aggregate kind.
    prop Kind TypeDeclarationKind {
        get;
    }

    /// Gets the type name.
    prop Name string {
        get;
    }

    /// Gets the generic type parameters.
    prop TypeParameters IReadOnlyList[TypeParameter]? {
        get;
    }

    /// Gets the optional primary-constructor parameter list, or `null` if absent.
    prop PrimaryConstructorParameters IReadOnlyList[Parameter]? {
        get;
    }

    /// Gets the optional base type, rendered first in the base clause.
    prop BaseType GTypeReference? {
        get;
    }

    /// Gets the optional primary-constructor base-call arguments (`: Base(args)`,
    /// issue #1909), or `null` when the base clause carries no
    /// argument list (implicit parameterless base chaining).
    prop BaseConstructorArguments IReadOnlyList[GExpression]? {
        get;
    }

    /// Gets the implemented interfaces.
    prop Interfaces IReadOnlyList[GTypeReference] {
        get;
    }

    /// Gets the body members.
    prop Members IReadOnlyList[GMember] {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets a value indicating whether the type is `open`.
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether the type is `sealed`.
    prop IsSealed bool {
        get;
    }

    /// Gets a value indicating whether the type is `abstract` (ADR-0195 / issue #4674: it implies `open`
    /// and cannot be instantiated).
    prop IsAbstract bool {
        get;
    }

    /// Gets a value indicating whether the type is a `shared class` (ADR-0195 / issue #4674: CLR
    /// `abstract sealed`; every member declared directly in the body is shared, with no `shared { }`
    /// block).
    prop IsShared bool {
        get;
    }

    /// Gets a value indicating whether the type is `partial` (ADR-0144 §G).
    prop IsPartial bool {
        get;
    }

    /// Gets a value indicating whether to render a body block.
    prop HasBody bool {
        get;
    }

    /// Gets the type attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets a value indicating whether the type is `unsafe` (ADR-0122 /
    /// issue #1014); its whole body is an unsafe context.
    prop IsUnsafe bool {
        get;
    }

    /// Gets a value indicating whether the type is a by-ref-like
    /// `ref struct` (ADR-0058 / issue #367). Dropping this modifier is not
    /// cosmetic: it changes the emitted type's CLR identity — without
    /// `System.Runtime.CompilerServices.IsByRefLikeAttribute` a type that
    /// holds a `Span[T]` instance field cannot be loaded by the runtime at
    /// all (`TypeLoadException` out of `GetExportedTypes()`, #3869).
    prop IsRefLike bool {
        get;
    }
}

/// A single enum case (ADR-0115 §B.11). Payload parameters turn the enum into a
/// discriminated union (ADR-0078 §5).
class EnumCase : GNode {
    /// Initializes a new instance of the (cref:EnumCase) class.
    /// @param name The case name.
    /// @param payloadParameters The optional payload parameters.
    /// @param explicitValue The explicit int32 constant value (issue #1912), when the source C#
    /// case has one and it differs from the default sequential ordinal.
    init(name string, payloadParameters IReadOnlyList[Parameter]? = nil, explicitValue int32? = nil) {
        Name = name
        PayloadParameters = payloadParameters ?? List[Parameter]()
        ExplicitValue = explicitValue
    }

    /// Gets the case name.
    prop Name string {
        get;
    }

    /// Gets the optional payload parameters.
    prop PayloadParameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets the explicit int32 constant value (issue #1912), e.g. `Banana = 2`,
    /// `Unknown = -1`, or a resolved `[Flags]`/alias value. Null when
    /// the case uses the default auto-numbered ordinal.
    prop ExplicitValue int32? {
        get;
    }
}

/// An `enum Name { A, B, C }` declaration (ADR-0115 §B.11).
class EnumDeclaration : GMember {
    /// Initializes a new instance of the (cref:EnumDeclaration) class.
    /// @param name The enum name.
    /// @param cases The enum cases.
    /// @param visibility The accessibility.
    /// @param attributes The enum attributes.
    init(
        name string,
        cases IReadOnlyList[EnumCase],
        visibility Visibility = Visibility.Default,
        attributes IReadOnlyList[AttributeUse]? = nil
    ) {
        Name = name
        Cases = cases ?? List[EnumCase]()
        Visibility = visibility
        Attributes = attributes ?? List[AttributeUse]()
    }

    /// Gets the enum name.
    prop Name string {
        get;
    }

    /// Gets the enum cases.
    prop Cases IReadOnlyList[EnumCase] {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets the enum attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }
}

/// A named delegate declaration `delegate Name(params) R`;
/// (ADR-0059, ADR-0115 §B.8) — the one place the `func` keyword stays in a
/// type position.
class NamedDelegateDeclaration : GMember {
    /// Initializes a new instance of the (cref:NamedDelegateDeclaration) class.
    /// @param name The delegate type name.
    /// @param parameters The delegate parameters.
    /// @param returnType The return type, or `null` for void.
    /// @param visibility The accessibility.
    /// @param attributes The delegate attributes.
    /// @param typeParameters The generic type parameters (issue #1960, ADR-0059 "Follow-up work" —
    /// generic delegate aliases `delegate Predicate[T any](value T) bool`;
    /// are supported by gsc; a null/empty list is a non-generic delegate.
    init(
        name string,
        parameters IReadOnlyList[Parameter]? = nil,
        returnType GTypeReference? = nil,
        visibility Visibility = Visibility.Default,
        attributes IReadOnlyList[AttributeUse]? = nil,
        typeParameters IReadOnlyList[TypeParameter]? = nil
    ) {
        Name = name
        Parameters = parameters ?? List[Parameter]()
        ReturnType = returnType
        Visibility = visibility
        Attributes = attributes ?? List[AttributeUse]()
        TypeParameters = typeParameters ?? List[TypeParameter]()
    }

    /// Gets the delegate type name.
    prop Name string {
        get;
    }

    /// Gets the delegate parameters.
    prop Parameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets the return type, or `null` for void.
    prop ReturnType GTypeReference? {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets the delegate attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets the generic type parameters.
    prop TypeParameters IReadOnlyList[TypeParameter] {
        get;
    }
}
