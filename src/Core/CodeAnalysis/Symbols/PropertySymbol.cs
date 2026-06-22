// <copyright file="PropertySymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

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
    /// <param name="hasSetter">Whether this property has a setter accessor (a <c>set</c> or an <c>init</c> accessor).</param>
    /// <param name="isAutoProperty">Whether this is an auto-property (compiler-synthesized backing field).</param>
    /// <param name="isVirtual">Whether this property is virtual (open).</param>
    /// <param name="isOverride">Whether this property overrides a base property.</param>
    /// <param name="setterParameterName">The setter parameter name (defaults to "value").</param>
    /// <param name="isStatic">Whether this property is declared inside a <c>shared</c> block (ADR-0053).</param>
    /// <param name="declaration">The declaring syntax node, or <see langword="null"/> for synthesized properties.</param>
    /// <param name="isInitOnly">Whether the property's setter is an <c>init</c>-only accessor (issue #946).</param>
    public PropertySymbol(
        string name,
        TypeSymbol type,
        Accessibility accessibility,
        bool hasGetter,
        bool hasSetter,
        bool isAutoProperty,
        bool isVirtual,
        bool isOverride,
        string setterParameterName = "value",
        bool isStatic = false,
        PropertyDeclarationSyntax declaration = null,
        bool isInitOnly = false)
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
        IsStatic = isStatic;
        Declaration = declaration;
        IsInitOnly = isInitOnly;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Property;

    /// <summary>Gets the property type.</summary>
    public TypeSymbol Type { get; }

    /// <summary>Gets the property accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets a value indicating whether this property has a getter accessor.</summary>
    public bool HasGetter { get; }

    /// <summary>Gets a value indicating whether this property has a setter accessor (a <c>set</c> or an <c>init</c> accessor).</summary>
    public bool HasSetter { get; }

    /// <summary>
    /// Gets a value indicating whether this property's setter is an
    /// <c>init</c>-only accessor (issue #946). An init-only setter is emitted
    /// as a <c>set_Prop</c> method whose void return carries the
    /// <c>System.Runtime.CompilerServices.IsExternalInit</c> modreq, and
    /// assignment is restricted to object initialization (the declaring type's
    /// constructors, object/aggregate initializers at the creation site, and
    /// other <c>init</c> accessors of the same instance).
    /// </summary>
    public bool IsInitOnly { get; }

    /// <summary>Gets a value indicating whether this is an auto-property (compiler-synthesized backing field).</summary>
    public bool IsAutoProperty { get; }

    /// <summary>Gets a value indicating whether this property is virtual (open).</summary>
    public bool IsVirtual { get; }

    /// <summary>Gets a value indicating whether this property overrides a base property.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets the setter parameter name (defaults to "value").</summary>
    public string SetterParameterName { get; }

    /// <summary>Gets a value indicating whether this property is declared inside a <c>shared</c> block (ADR-0053).</summary>
    public bool IsStatic { get; }

    /// <summary>Gets the declaring syntax node, or <see langword="null"/> for synthesized properties.</summary>
    public PropertyDeclarationSyntax Declaration { get; private set; }

    /// <summary>Gets or sets the synthesized backing field symbol for auto-properties. Null for computed properties.</summary>
    public FieldSymbol BackingField { get; set; }

    /// <summary>Gets or sets the synthesized getter function symbol.</summary>
    public FunctionSymbol GetterSymbol { get; set; }

    /// <summary>Gets or sets the synthesized setter function symbol.</summary>
    public FunctionSymbol SetterSymbol { get; set; }

    /// <summary>
    /// Gets a value indicating whether this property is an indexer member
    /// (ADR-0118 / issue #944). Indexers are emitted as the CLR default
    /// member named <c>Item</c> with index parameters.
    /// </summary>
    public bool IsIndexer { get; init; }

    /// <summary>
    /// Gets the index parameters of an indexer member (ADR-0118). Empty for an
    /// ordinary property.
    /// </summary>
    public System.Collections.Immutable.ImmutableArray<ParameterSymbol> Parameters { get; init; }
        = System.Collections.Immutable.ImmutableArray<ParameterSymbol>.Empty;

    /// <summary>Gets or sets the getter accessor body syntax (for computed properties). Null for auto-properties.</summary>
    public Syntax.BlockStatementSyntax GetterBodySyntax { get; set; }

    /// <summary>Gets or sets the setter accessor body syntax (for computed properties). Null for auto-properties.</summary>
    public Syntax.BlockStatementSyntax SetterBodySyntax { get; set; }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) property at the declaration
    /// node of a freshly-parsed syntax tree whose property signature and
    /// accessor shape are byte-identical to the previous one (a body-only edit).
    /// The caller is responsible for re-pointing <see cref="GetterBodySyntax"/>
    /// and <see cref="SetterBodySyntax"/> at the corresponding accessor bodies in
    /// the re-parsed tree. The symbol's identity (including
    /// <see cref="GetterSymbol"/>/<see cref="SetterSymbol"/>) is preserved so
    /// cross-compilation reuse stays sound. Intended to be called only by
    /// <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(PropertyDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }
}
