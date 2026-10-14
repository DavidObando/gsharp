// <copyright file="BoundPropertyReferenceOperationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import System.Reflection
import System.Threading

/// The shape shared by every bound node that READS a property (ADR-0169,
/// issue #4436). It is the analyzer-facing counterpart of Roslyn's
/// `IPropertyReferenceOperation`.
/// @remarks G# binds a property read to a different node for each provenance:
/// `BoundPropertyAccessExpression` for a same-compilation property and
/// `BoundClrPropertyAccessExpression` for an imported member. An
/// analyzer should not have to know the split, so both derive from this base
/// and a rule registers both (cref:BoundNodeKind) values.
///
/// `BoundClrPropertyAccessExpression` also reads imported FIELDS, which
/// Roslyn models as `IFieldReferenceOperation`. For those
/// (cref:ReferencedProperty) is `null`, so a rule written against
/// the property surface does not mistake a field for a property.
abstract class BoundPropertyReferenceOperationExpression : BoundExpression {
    private var importedProperty Symbol?

    /// Initializes a new instance of the (cref:BoundPropertyReferenceOperationExpression) class.
    /// @param syntax The originating syntax.
    internal init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the property read — the Roslyn
    /// `IPropertyReferenceOperation.Property` analogue. An imported
    /// property is represented by a symbol carrying its name, type and
    /// declaring type. `null` when the node reads an imported
    /// field instead.
    ///
    /// Named `ReferencedProperty`, not `Property`, so that
    /// (cref:BoundPropertyAccessExpression.Property) can keep its
    /// narrower (cref:PropertySymbol) type without a covariant-return
    /// override, which gsc miscompiles in the self-migrated Core (#4493).
    abstract prop ReferencedProperty Symbol? {
        get;
    }

    /// Gets the receiver — the Roslyn `IPropertyReferenceOperation.Instance`
    /// analogue — or `null` for a static property.
    abstract prop Instance BoundExpression? {
        get;
    }

    /// Builds, once, the symbol for a reflected property that a node stores
    /// as a (cref:MemberInfo) rather than a symbol.
    /// @param member The reflected member.
    /// @param type The type the read produces.
    /// @returns The property symbol, or null when [`member`](paramref) is not a property.
    internal func ImportedProperty(member MemberInfo, type TypeSymbol) Symbol? {
        if member is not PropertyInfo property {
            return nil
        }
        var cached Symbol? = Volatile.Read(&importedProperty)
        if cached == nil {
            let symbol = PropertySymbol(
                property.Name,
                type,
                AccessibilityOf(property),
                hasGetter: property.CanRead,
                hasSetter: property.CanWrite,
                isAutoProperty: false,
                isVirtual: false,
                isOverride: false
            )
            if property.DeclaringType is {} declaringType {
                // The containing type is identity only (a rule reads its Name),
                // not a signature position, so it carries no nullability.
                symbol.AnchorContainingType(
                    ImportedTypeSymbol.GetWithoutNullability(declaringType, NullabilityFreeReason.TypeStructure)
                )
            }
            // Analyzers may run concurrently: publish the first symbol built,
            // so every reader sees one fully constructed instance.
            cached = Interlocked.CompareExchange(&importedProperty, symbol, nil) ?? symbol
        }
        return cached
    }

    shared {
        // The most accessible of the property's accessors, as C# reports a
        // property's declared accessibility.
        private func AccessibilityOf(property PropertyInfo) Accessibility {
            let accessors = property.GetAccessors(nonPublic: true)
            if accessors.Any((a MethodInfo) -> a.IsPublic) {
                return Accessibility.Public
            }
            if accessors.Any((a MethodInfo) -> a.IsFamily || a.IsFamilyOrAssembly) {
                return Accessibility.Protected
            }
            if accessors.Any((a MethodInfo) -> a.IsAssembly || a.IsFamilyAndAssembly) {
                return Accessibility.Internal
            }
            return Accessibility.Private
        }
    }
}
