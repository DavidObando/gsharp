// <copyright file="SymbolContainment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Fills in <see cref="Symbol.ContainingType"/> for the members of a
/// user-defined type (ADR-0169). G# binds members into per-kind collections on
/// <see cref="StructSymbol"/> rather than threading a containing-type back-link
/// through every symbol, so the Roslyn <c>ISymbol.ContainingType</c> analogue
/// is anchored fill-once when symbols surface on an analyzer-facing surface.
/// </summary>
/// <remarks>
/// Issue #3795: this used to run only on the analyzer driver's SYMBOL-action
/// path, which a syntax-node analyzer never reaches. Such an analyzer obtains
/// the same symbols through <see cref="SemanticModel.GetDeclaredSymbol"/> and
/// saw <c>ContainingType == null</c> where Roslyn always populates it, so every
/// rule keyed on containment (a base-type walk, a "declared on type X" test)
/// silently reported nothing rather than failing. Anchoring is idempotent and
/// never overwrites containment the binder already set, so calling it from both
/// surfaces is safe.
/// </remarks>
internal static class SymbolContainment
{
    /// <summary>
    /// Anchors every member of <paramref name="type"/> to it.
    /// </summary>
    /// <param name="type">The declaring type.</param>
    public static void AnchorMembers(StructSymbol type)
    {
        foreach (FieldSymbol field in type.Fields)
        {
            field.AnchorContainingType(type);
        }

        foreach (FieldSymbol field in type.StaticFields)
        {
            field.AnchorContainingType(type);
        }

        foreach (FieldSymbol field in type.ConstFields)
        {
            field.AnchorContainingType(type);
        }

        foreach (PropertySymbol property in type.Properties)
        {
            property.AnchorContainingType(type);
        }

        foreach (PropertySymbol property in type.StaticProperties)
        {
            property.AnchorContainingType(type);
        }

        foreach (EventSymbol declaredEvent in type.Events)
        {
            declaredEvent.AnchorContainingType(type);
        }

        foreach (EventSymbol declaredEvent in type.StaticEvents)
        {
            declaredEvent.AnchorContainingType(type);
        }

        foreach (FunctionSymbol method in type.Methods)
        {
            method.AnchorContainingType(type);
        }

        foreach (FunctionSymbol method in type.StaticMethods)
        {
            method.AnchorContainingType(type);
        }

        foreach (ConstructorSymbol constructor in type.EffectiveExplicitConstructors)
        {
            constructor.Function.AnchorContainingType(type);
        }
    }
}
