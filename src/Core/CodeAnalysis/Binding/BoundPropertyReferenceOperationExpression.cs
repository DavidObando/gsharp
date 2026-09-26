// <copyright file="BoundPropertyReferenceOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// The shape shared by every bound node that READS a property (ADR-0169,
/// issue #4436). It is the analyzer-facing counterpart of Roslyn's
/// <c>IPropertyReferenceOperation</c>.
/// </summary>
/// <remarks>
/// <para>
/// G# binds a property read to a different node for each provenance:
/// <c>BoundPropertyAccessExpression</c> for a same-compilation property and
/// <c>BoundClrPropertyAccessExpression</c> for an imported member. An
/// analyzer should not have to know the split, so both derive from this base
/// and a rule registers both <see cref="BoundNodeKind"/> values.
/// </para>
/// <para>
/// <c>BoundClrPropertyAccessExpression</c> also reads imported FIELDS, which
/// Roslyn models as <c>IFieldReferenceOperation</c>. For those
/// <see cref="Property"/> is <see langword="null"/>, so a rule written against
/// the property surface does not mistake a field for a property.
/// </para>
/// </remarks>
public abstract class BoundPropertyReferenceOperationExpression : BoundExpression
{
    private Symbol? importedProperty;

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundPropertyReferenceOperationExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    private protected BoundPropertyReferenceOperationExpression(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <summary>
    /// Gets the property read — the Roslyn
    /// <c>IPropertyReferenceOperation.Property</c> analogue. An imported
    /// property is represented by a symbol carrying its name, type and
    /// declaring type. <see langword="null"/> when the node reads an imported
    /// field instead.
    /// </summary>
    public abstract Symbol? Property { get; }

    /// <summary>
    /// Gets the receiver — the Roslyn <c>IPropertyReferenceOperation.Instance</c>
    /// analogue — or <see langword="null"/> for a static property.
    /// </summary>
    public abstract BoundExpression? Instance { get; }

    /// <summary>
    /// Builds, once, the symbol for a reflected property that a node stores
    /// as a <see cref="MemberInfo"/> rather than a symbol.
    /// </summary>
    /// <param name="member">The reflected member.</param>
    /// <param name="type">The type the read produces.</param>
    /// <returns>The property symbol, or null when <paramref name="member"/> is not a property.</returns>
    private protected Symbol? ImportedProperty(MemberInfo member, TypeSymbol type)
    {
        if (member is not PropertyInfo property)
        {
            return null;
        }

        var cached = Volatile.Read(ref importedProperty);
        if (cached == null)
        {
            var symbol = new PropertySymbol(
                property.Name,
                type,
                AccessibilityOf(property),
                hasGetter: property.CanRead,
                hasSetter: property.CanWrite,
                isAutoProperty: false,
                isVirtual: false,
                isOverride: false);
            if (property.DeclaringType is { } declaringType)
            {
                symbol.AnchorContainingType(ImportedTypeSymbol.Get(declaringType));
            }

            // Analyzers may run concurrently: publish the first symbol built,
            // so every reader sees one fully constructed instance.
            cached = Interlocked.CompareExchange(ref importedProperty, symbol, null) ?? symbol;
        }

        return cached;
    }

    // The most accessible of the property's accessors, as C# reports a
    // property's declared accessibility.
    private static Accessibility AccessibilityOf(PropertyInfo property)
    {
        var accessors = property.GetAccessors(nonPublic: true);
        if (accessors.Any(a => a.IsPublic))
        {
            return Accessibility.Public;
        }

        if (accessors.Any(a => a.IsFamily || a.IsFamilyOrAssembly))
        {
            return Accessibility.Protected;
        }

        if (accessors.Any(a => a.IsAssembly || a.IsFamilyAndAssembly))
        {
            return Accessibility.Internal;
        }

        return Accessibility.Private;
    }
}
