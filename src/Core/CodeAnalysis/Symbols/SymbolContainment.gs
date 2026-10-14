// <copyright file="SymbolContainment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Fills in (cref:Symbol.ContainingType) for the members of a
/// user-defined type (ADR-0169). G# binds members into per-kind collections on
/// (cref:StructSymbol) rather than threading a containing-type back-link
/// through every symbol, so the Roslyn `ISymbol.ContainingType` analogue
/// is anchored fill-once when symbols surface on an analyzer-facing surface.
/// @remarks Issue #3795: this used to run only on the analyzer driver's SYMBOL-action
/// path, which a syntax-node analyzer never reaches. Such an analyzer obtains
/// the same symbols through (cref:SemanticModel.GetDeclaredSymbol) and
/// saw `ContainingType == null` where Roslyn always populates it, so every
/// rule keyed on containment (a base-type walk, a "declared on type X" test)
/// silently reported nothing rather than failing. Anchoring is idempotent and
/// never overwrites containment the binder already set, so calling it from both
/// surfaces is safe.
internal shared class SymbolContainment {
    /// Anchors every member of [`type`](paramref) to it.
    /// @param type The declaring type.
    func AnchorMembers(type StructSymbol) {
        for field in type.Fields {
            field.AnchorContainingType(type)
        }
        for field in type.StaticFields {
            field.AnchorContainingType(type)
        }
        for field in type.ConstFields {
            field.AnchorContainingType(type)
        }
        for property in type.Properties {
            property.AnchorContainingType(type)
        }
        for property in type.StaticProperties {
            property.AnchorContainingType(type)
        }
        for declaredEvent in type.Events {
            declaredEvent.AnchorContainingType(type)
        }
        for declaredEvent in type.StaticEvents {
            declaredEvent.AnchorContainingType(type)
        }
        for method in type.Methods {
            method.AnchorContainingType(type)
        }
        for method in type.StaticMethods {
            method.AnchorContainingType(type)
        }
        for constructor in type.EffectiveExplicitConstructors {
            constructor.Function.AnchorContainingType(type)
        }
    }
}
