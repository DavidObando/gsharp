// <copyright file="BoundPropertyPatternField.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Bound property-pattern field.
class BoundPropertyPatternField : BoundNode {
    /// Initializes a new instance of the (cref:BoundPropertyPatternField) class.
    /// @param syntax The originating syntax.
    /// @param field The matched field.
    /// @param pattern The nested pattern.
    convenience init(syntax SyntaxNode?, field FieldSymbol, pattern BoundPattern) {
        init(syntax, field, nil, pattern)
    }

    /// Initializes a new instance of the (cref:BoundPropertyPatternField) class.
    /// @param syntax The originating syntax.
    /// @param field The matched field.
    /// @param declaringType The type that declares the field.
    /// @param pattern The nested pattern.
    init(syntax SyntaxNode?, field FieldSymbol, declaringType TypeSymbol?, pattern BoundPattern) : base(syntax) {
        Field = field
        DeclaringType = declaringType
        Type = field.Type
        Pattern = pattern
    }

    /// Initializes a new instance of the (cref:BoundPropertyPatternField) class.
    /// @param syntax The originating syntax.
    /// @param property The matched property.
    /// @param pattern The nested pattern.
    convenience init(syntax SyntaxNode?, property PropertySymbol, pattern BoundPattern) {
        init(syntax, property, nil, pattern)
    }

    /// Initializes a new instance of the (cref:BoundPropertyPatternField) class.
    /// @param syntax The originating syntax.
    /// @param property The matched property.
    /// @param declaringType The type that declares the property.
    /// @param pattern The nested pattern.
    init(syntax SyntaxNode?, property PropertySymbol, declaringType TypeSymbol?, pattern BoundPattern) : base(syntax) {
        Property = property
        DeclaringType = declaringType
        Type = property.Type
        Pattern = pattern
        ValueVariable = LocalVariableSymbol("<property-pattern-member>", isReadOnly: true, Type)
    }

    /// Initializes a new instance of the (cref:BoundPropertyPatternField) class.
    /// @param syntax The originating syntax.
    /// @param clrMember The matched CLR field or property.
    /// @param type The matched member type.
    /// @param pattern The nested pattern.
    init(syntax SyntaxNode?, clrMember MemberInfo, type TypeSymbol, pattern BoundPattern) : base(syntax) {
        ClrMember = clrMember
        Type = type
        Pattern = pattern
        if clrMember is PropertyInfo {
            ValueVariable = LocalVariableSymbol("<property-pattern-member>", isReadOnly: true, Type)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.PropertyPatternField

    /// Gets the field symbol.
    prop Field FieldSymbol? {
        get;
    }

    /// Gets the matched property symbol, when this member is property-backed.
    prop Property PropertySymbol? {
        get;
    }

    /// Gets the matched CLR field or property, when metadata-backed.
    prop ClrMember MemberInfo? {
        get;
    }

    /// Gets the user type that declares the matched field or property.
    prop DeclaringType TypeSymbol? {
        get;
    }

    // Each of the five constructors sets exactly one of ClrMember, Property or
    // Field from a non-nullable parameter, so the last fallback always binds.
    /// Gets the matched member name.
    prop Name string -> ClrMember?.Name ?? Property?.Name ?? Field!!.Name

    /// Gets the matched member type.
    prop Type TypeSymbol {
        get;
    }

    // Both property-backed constructors -- and only those -- allocate
    // ValueVariable, so this discriminates it.
    /// Gets a value indicating whether matching reads through a property getter.
    @MemberNotNullWhen(true, "ValueVariable")
    prop IsProperty bool -> Property != nil || ClrMember is PropertyInfo

    /// Gets the nested field pattern.
    prop Pattern BoundPattern {
        get;
    }

    /// Gets the temporary holding one getter evaluation, when property-backed.
    prop ValueVariable LocalVariableSymbol? {
        get;
    }
}
