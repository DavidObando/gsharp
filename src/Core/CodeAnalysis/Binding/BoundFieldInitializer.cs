#nullable disable

// <copyright file="BoundFieldInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A single <c>FieldName: value</c> initializer inside a struct/class composite
/// literal. The targeted member is either a <see cref="FieldSymbol"/> (a
/// <c>var</c> member) or, since issue #1211, a settable
/// <see cref="PropertySymbol"/> (a <c>prop</c> auto-property with a
/// <c>set</c>/<c>init</c> accessor).
/// </summary>
public sealed class BoundFieldInitializer
{
    public BoundFieldInitializer(FieldSymbol field, BoundExpression value)
    {
        Field = field;
        Value = value;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundFieldInitializer"/>
    /// class targeting a settable property (issue #1211): an auto-property with
    /// a <c>set</c> or <c>init</c> accessor. The emitter lowers this to a call
    /// to the property's setter/init accessor instead of a <c>stfld</c>.
    /// </summary>
    /// <param name="property">The targeted property.</param>
    /// <param name="value">The value to assign.</param>
    public BoundFieldInitializer(PropertySymbol property, BoundExpression value)
    {
        Property = property;
        Value = value;
    }

    /// <summary>Gets the targeted field, or <see langword="null"/> when this initializer targets a property.</summary>
    public FieldSymbol Field { get; }

    /// <summary>Gets the targeted property, or <see langword="null"/> when this initializer targets a field.</summary>
    public PropertySymbol Property { get; }

    public BoundExpression Value { get; }

    /// <summary>Gets the name of the targeted member (field or property).</summary>
    public string MemberName => Field != null ? Field.Name : Property.Name;

    /// <summary>Gets the declared type of the targeted member (field or property).</summary>
    public TypeSymbol MemberType => Field != null ? Field.Type : Property.Type;
}
