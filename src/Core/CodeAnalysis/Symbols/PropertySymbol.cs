// <copyright file="PropertySymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a property declared on a user-defined type (ADR-0051).
/// </summary>
public sealed class PropertySymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertySymbol"/> class.
    /// </summary>
    /// <param name="name">The property name.</param>
    /// <param name="type">The property type.</param>
    /// <param name="accessibility">The property accessibility.</param>
    /// <param name="hasGetter">Whether this property has a getter accessor.</param>
    /// <param name="hasSetter">Whether this property has a setter accessor.</param>
    /// <param name="isAutoProperty">Whether this is an auto-property (compiler-synthesized backing field).</param>
    /// <param name="isVirtual">Whether this property is virtual (open).</param>
    /// <param name="isOverride">Whether this property overrides a base property.</param>
    /// <param name="setterParameterName">The setter parameter name (defaults to "value").</param>
    public PropertySymbol(
        string name,
        TypeSymbol type,
        Accessibility accessibility,
        bool hasGetter,
        bool hasSetter,
        bool isAutoProperty,
        bool isVirtual,
        bool isOverride,
        string setterParameterName = "value")
        : base(name)
    {
        Type = type;
        Accessibility = accessibility;
        HasGetter = hasGetter;
        HasSetter = hasSetter;
        IsAutoProperty = isAutoProperty;
        IsVirtual = isVirtual;
        IsOverride = isOverride;
        SetterParameterName = setterParameterName;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Property;

    /// <summary>Gets the property type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the property accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets a value indicating whether this property has a getter accessor.</summary>
    public bool HasGetter { get; }

    /// <summary>Gets a value indicating whether this property has a setter accessor.</summary>
    public bool HasSetter { get; }

    /// <summary>Gets a value indicating whether this is an auto-property (compiler-synthesized backing field).</summary>
    public bool IsAutoProperty { get; }

    /// <summary>Gets a value indicating whether this property is virtual (open).</summary>
    public bool IsVirtual { get; }

    /// <summary>Gets a value indicating whether this property overrides a base property.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets the setter parameter name (defaults to "value").</summary>
    public string SetterParameterName { get; }

    /// <summary>Gets or sets the synthesized backing field symbol for auto-properties. Null for computed properties.</summary>
    public FieldSymbol BackingField { get; set; }

    /// <summary>Gets or sets the synthesized getter function symbol.</summary>
    public FunctionSymbol GetterSymbol { get; set; }

    /// <summary>Gets or sets the synthesized setter function symbol.</summary>
    public FunctionSymbol SetterSymbol { get; set; }
}
