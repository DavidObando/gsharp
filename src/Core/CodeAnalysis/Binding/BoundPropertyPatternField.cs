// <copyright file="BoundPropertyPatternField.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound property-pattern field.</summary>
public sealed class BoundPropertyPatternField : BoundNode
{
    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="field">The matched field.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, FieldSymbol field, BoundPattern pattern)
        : this(syntax, field, declaringType: null, pattern)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="field">The matched field.</param>
    /// <param name="declaringType">The type that declares the field.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, FieldSymbol field, TypeSymbol declaringType, BoundPattern pattern)
        : base(syntax)
    {
        Field = field;
        DeclaringType = declaringType;
        Type = field.Type;
        Pattern = pattern;
        ValueVariable = new LocalVariableSymbol("<property-pattern-member>", isReadOnly: true, Type);
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="property">The matched property.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, PropertySymbol property, BoundPattern pattern)
        : this(syntax, property, declaringType: null, pattern)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="property">The matched property.</param>
    /// <param name="declaringType">The type that declares the property.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, PropertySymbol property, TypeSymbol declaringType, BoundPattern pattern)
        : base(syntax)
    {
        Property = property;
        DeclaringType = declaringType;
        Type = property.Type;
        Pattern = pattern;
        ValueVariable = new LocalVariableSymbol("<property-pattern-member>", isReadOnly: true, Type);
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyPatternField"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="clrMember">The matched CLR field or property.</param>
    /// <param name="type">The matched member type.</param>
    /// <param name="pattern">The nested pattern.</param>
    public BoundPropertyPatternField(SyntaxNode syntax, MemberInfo clrMember, TypeSymbol type, BoundPattern pattern)
        : base(syntax)
    {
        ClrMember = clrMember;
        Type = type;
        Pattern = pattern;
        ValueVariable = new LocalVariableSymbol("<property-pattern-member>", isReadOnly: true, Type);
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.PropertyPatternField;

    /// <summary>Gets the field symbol.</summary>
    public FieldSymbol Field { get; }

    /// <summary>Gets the matched property symbol, when this member is property-backed.</summary>
    public PropertySymbol Property { get; }

    /// <summary>Gets the matched CLR field or property, when metadata-backed.</summary>
    public MemberInfo ClrMember { get; }

    /// <summary>Gets the user type that declares the matched field or property.</summary>
    public TypeSymbol DeclaringType { get; }

    /// <summary>Gets the matched member name.</summary>
    public string Name => ClrMember?.Name ?? Property?.Name ?? Field.Name;

    /// <summary>Gets the matched member type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the nested field pattern.</summary>
    public BoundPattern Pattern { get; }

    /// <summary>Gets the temporary holding one evaluation of the matched member.</summary>
    public LocalVariableSymbol ValueVariable { get; }
}
