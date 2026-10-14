// <copyright file="BoundFieldAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Reads a field from a struct value: `receiver.Field` (Phase 3.B.1).
class BoundFieldAccessExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundFieldAccessExpression) class.
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param receiver The instance receiver, or `null` for a static field.
    /// @param structType The declaring struct/class type, or `null` for an interface static field.
    /// @param field The field to read.
    convenience init(syntax SyntaxNode?, receiver BoundExpression?, structType StructSymbol?, field FieldSymbol) {
        init(syntax, receiver, structType, field, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundFieldAccessExpression)
    /// class for an interface static field read (ADR-0089 / issue #1030). The
    /// declaring (cref:StructType) is `null`; (cref:InterfaceType)
    /// records the owning interface (the open definition for a self-instantiation,
    /// or a constructed `IBox[int32]` for a closed access) so the emitter can
    /// route generic-interface field references through a `TypeSpec` and the
    /// interpreter can key static storage per closed construction.
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param field The interface static field to read.
    /// @param interfaceType The owning interface (definition or constructed).
    convenience init(syntax SyntaxNode?, field FieldSymbol, interfaceType InterfaceSymbol) {
        init(syntax, field, interfaceType, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundFieldAccessExpression) class for an interface
    /// static-field read with a substituted type.
    /// @param syntax Originating syntax.
    /// @param field Field declared on the interface definition.
    /// @param interfaceType Effective interface construction.
    /// @param substitutedType Construction-substituted member type.
    convenience init(
        syntax SyntaxNode?,
        field FieldSymbol,
        interfaceType InterfaceSymbol,
        substitutedType TypeSymbol?
    ) {
        init(syntax, field, interfaceType, substitutedType, nil)
    }

    /// Initializes a new instance of the (cref:BoundFieldAccessExpression) class for an interface
    /// static-field read with distinct substituted and narrowed types.
    /// @param syntax Originating syntax.
    /// @param field Field declared on the interface definition.
    /// @param interfaceType Effective interface construction.
    /// @param substitutedType Construction-substituted member type.
    /// @param narrowedType Flow-narrowed type.
    init(
        syntax SyntaxNode?,
        field FieldSymbol,
        interfaceType InterfaceSymbol,
        substitutedType TypeSymbol?,
        narrowedType TypeSymbol?
    ) : base(syntax) {
        Receiver = nil
        StructType = nil
        Field = field
        NarrowedType = narrowedType
        SubstitutedType = substitutedType
        InterfaceType = interfaceType
    }

    /// Initializes a new instance of the (cref:BoundFieldAccessExpression)
    /// class with a narrowed type. Issue #208: used by smart-cast flow analysis
    /// to surface a non-nullable view of a nullable field inside a block where
    /// a `[MemberNotNull]` call has been observed, without changing the
    /// underlying field symbol identity (so the emitter still uses the same
    /// field handle).
    /// @param syntax The originating syntax, or `null` for synthesized nodes.
    /// @param receiver The instance receiver, or `null` for a static field.
    /// @param structType The declaring struct/class type, or `null` for an interface static field.
    /// @param field The field to read.
    /// @param narrowedType The narrowed type to surface, or `null` to use [`field`](paramref)'s declared
    /// type.
    convenience init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        field FieldSymbol,
        narrowedType TypeSymbol?
    ) {
        init(syntax, receiver, structType, field, nil, narrowedType)
    }

    /// Initializes a new instance of the (cref:BoundFieldAccessExpression) class with distinct
    /// construction-substituted and flow-narrowed types.
    /// @param syntax The originating syntax.
    /// @param receiver Instance receiver, or `null` for static access.
    /// @param structType Declaring struct/class type.
    /// @param field Field to read.
    /// @param substitutedType Construction-substituted member type.
    /// @param narrowedType Flow-narrowed type.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression?,
        structType StructSymbol?,
        field FieldSymbol,
        substitutedType TypeSymbol?,
        narrowedType TypeSymbol?
    ) : base(syntax) {
        Receiver = receiver
        StructType = structType
        Field = field
        NarrowedType = narrowedType
        SubstitutedType = substitutedType
    }

    prop Receiver BoundExpression? {
        get;
    }

    prop StructType StructSymbol? {
        get;
    }

    /// Gets the owning interface for an interface static field read (ADR-0089 /
    /// issue #1030), or `null` for a struct/class field. When non-null and
    /// it is a generic-interface reference, the emitter resolves the field via a
    /// `TypeSpec`-parented MemberRef; the interpreter keys static storage by
    /// this symbol so each closed construction has independent storage.
    prop InterfaceType InterfaceSymbol? {
        get;
    }

    prop Field FieldSymbol {
        get;
    }

    /// Gets the narrowed type for flow-analysis smart-cast, or `null` to
    /// use the field's declared type. When non-null the binder reports this
    /// type to callers so that member-access and type-compatibility checks see
    /// the narrowed (non-nullable) view; the emitter always uses
    /// (cref:Field) for the actual field handle.
    prop NarrowedType TypeSymbol? {
        get;
    }

    /// Gets the member type after generic construction substitution, before flow narrowing.
    prop SubstitutedType TypeSymbol? {
        get;
    }

    override prop Type TypeSymbol -> NarrowedType ?? SubstitutedType ?? Field.Type
    override prop Kind BoundNodeKind -> BoundNodeKind.FieldAccessExpression
}
