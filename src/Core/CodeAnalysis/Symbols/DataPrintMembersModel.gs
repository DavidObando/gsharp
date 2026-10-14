// <copyright file="DataPrintMembersModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text

/// ADR-0199: the single decision point for the C#-record `PrintMembers(StringBuilder)`
/// slot of a `data class` / `data struct` — whether the type has
/// one, which accessibility and virtuality it carries, which base slot it
/// overrides, and which members it prints. Binding, member lookup and the
/// emitter all read the answer from here.
internal shared class DataPrintMembersModel {
    /// A member printed by `PrintMembers`.
    /// @param Name The printed name.
    /// @param Field The field, for a field member.
    /// @param Property The property, for a property member.
    internal data struct PrintableMember(Name string, Field FieldSymbol?, Property PropertySymbol?) : IEquatable[
        PrintableMember
    ] {
        /// Gets the member's type.
        internal prop Type TypeSymbol -> Field?.Type ?? Property!!.Type
    }

    /// The name of the print-members slot.
    internal const Name string = "PrintMembers"

    /// Gets a value indicating whether [`type`](paramref) is a G# data type declared in source (a native
    /// `data` declaration, not an anonymous literal).
    /// @param type The type to test.
    /// @returns `true` when the type is a declared source data type.
    internal func IsDeclaredDataType(type StructSymbol) bool -> type.IsData &&
        type.ClrType == nil &&
        !type.IsAnonymousLiteral

    /// Gets the user-declared `PrintMembers(StringBuilder)` slot, when
    /// the type declares one (ADR-0199: it replaces the synthesized member).
    /// @param type The data type.
    /// @returns The declared method, or null.
    internal func FindDeclared(type StructSymbol) FunctionSymbol? {
        if type.Methods.IsDefaultOrEmpty {
            return nil
        }
        for method in type.Methods {
            if IsSlot(method) {
                return method
            }
        }
        return nil
    }

    /// The single answer to "is this declaration the print-members slot": a method
    /// named `PrintMembers` taking exactly one (cref:StringBuilder) by
    /// value that is not an explicit interface implementation (those are emitted
    /// under a mangled name and are ordinary members). Staticness is the caller's
    /// business: an instance declaration is the slot, a static one of this shape
    /// is rejected. Other overloads named `PrintMembers` are ordinary methods.
    /// @param name The method name.
    /// @param hasExplicitInterfaceClause Whether the declaration names an interface.
    /// @param parameters The parameters.
    /// @returns `true` when the declaration has the slot's identity.
    internal func IsSlotCandidate(
        name string,
        hasExplicitInterfaceClause bool,
        parameters ImmutableArray[ParameterSymbol]
    ) bool -> name == Name &&
        !hasExplicitInterfaceClause &&
        !parameters.IsDefaultOrEmpty &&
        parameters.Length == 1 &&
        parameters[0].RefKind == RefKind.None &&
        IsStringBuilder(parameters[0].Type)

    /// Tests whether a bound method has the slot's identity (see (cref:IsSlotCandidate)).
    /// @param method The method.
    /// @returns `true` for the print-members slot.
    internal func IsSlot(method FunctionSymbol) bool -> method.Name != nil &&
        !method.IsStatic &&
        IsSlotCandidate(method.Name, method.HasExplicitInterfaceClause, method.Parameters)

    /// Tests whether a type is (cref:StringBuilder) (ignoring reference nullability).
    /// @param type The type.
    /// @returns `true` for `StringBuilder`.
    internal func IsStringBuilder(type TypeSymbol) bool -> type.ClrType is {} clr && ClrTypeUtilities.AreSame(
        clr,
        typeof(StringBuilder)
    )

    /// Resolves the base slot this type's print-members overrides.
    /// @param owner The data type.
    /// @param importedMethod The actual imported slot, when the base is a native record.
    /// @returns The symbolic base owner, or null when the type starts its own slot.
    internal func GetBase(owner StructSymbol, out importedMethod MethodInfo?) TypeSymbol? {
        importedMethod = nil
        if !owner.IsData || !owner.IsClass {
            return nil
        }
        let hierarchy = owner.GetHierarchy()
        for var level = 0; level < hierarchy.Count; level++ {
            let ancestor = hierarchy[level]
            // The nearest ancestor that owns the slot: a declared data type, or an
            // ordinary class that overrides the inherited slot itself (its override
            // is what a derived `base.PrintMembers` must reach, not the older one).
            if level > 0 && (IsDeclaredDataType(ancestor) || DeclaresVirtualSlot(ancestor)) {
                return ancestor
            }
            // Only an imported record / data base owns the slot; an ordinary CLR class
            // that happens to expose a matching virtual method does not.
            if DataEqualityMemberModel.GetImportedDataBase(ancestor) is not{} importedDataBase {
                continue
            }
            let (importedBase, clrBase) = importedDataBase
            for method in ClrTypeUtilities.SafeGetMethods(
                clrBase,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly
            ) {
                let parameters = method.GetParameters()
                if method.Name == Name &&
                    method.IsVirtual &&
                    !method.IsFinal &&
                    !method.IsGenericMethod &&
                    (method.IsFamily || method.IsFamilyOrAssembly) &&
                    ClrTypeUtilities.AreSame(method.ReturnType, typeof(bool)) &&
                    parameters.Length == 1 &&
                    ClrTypeUtilities.AreSame(parameters[0].ParameterType, typeof(StringBuilder)) {
                    importedMethod = method
                    return importedBase
                }
            }
        }
        return nil
    }

    /// Tests whether the inherited slot is abstract, so a synthesized override
    /// still overrides it but has no base body to call.
    /// @param owner The data type.
    /// @returns `true` when the base slot has no body.
    internal func IsBaseSlotAbstract(owner StructSymbol) bool -> switch GetBase(owner, out var importedMethod) {
        case nil: false
        case _ when importedMethod != nil: importedMethod!!.IsAbstract
        case baseOwner is StructSymbol: FindDeclared(baseOwner)?.IsAbstract == true
        default: false
    }

    /// Gets the hand-written slot of the nearest base that a synthesized
    /// override would have to override although it is final (a sealed override
    /// in an intermediary class), or null when the inherited slot stays overridable.
    /// @param owner The data type.
    /// @returns The blocking declaration, or null.
    internal func GetSealedBaseSlot(owner StructSymbol) FunctionSymbol? {
        if GetBase(owner, out _) is not StructSymbol baseOwner || FindDeclared(baseOwner) is not{} slot {
            return nil
        }
        return if slot.IsOverride && !slot.IsOpen && !slot.IsAbstract {
            slot
        } else {
            default(FunctionSymbol?)
        }
    }

    /// Gets the accessibility the slot must have: `private` for a sealed
    /// type that starts the slot, `protected` otherwise (Roslyn's model).
    /// @param owner The data type.
    /// @returns The required accessibility.
    internal func GetRequiredAccessibility(owner StructSymbol) Accessibility -> if IsSealed(owner) &&
        GetBase(owner, out _) == nil {
        Accessibility.Private
    } else {
        Accessibility.Protected
    }

    /// Tests whether no type can derive from [`owner`](paramref).
    /// @param owner The data type.
    /// @returns `true` for a struct or a non-extensible class.
    internal func IsSealed(owner StructSymbol) bool -> !owner.IsClass || (!owner.IsOpen && !owner.IsSealedHierarchy)

    /// Creates the compiler-owned print-members slot for a data type that does not declare one.
    /// @param owner The data type.
    /// @returns The synthesized slot, or null for a type that gets none (an anonymous literal).
    internal func Create(owner StructSymbol) FunctionSymbol? {
        if !IsDeclaredDataType(owner) {
            return nil
        }
        let hasBase = GetBase(owner, out _) != nil
        // Emitted non-final whenever it is virtual, so the symbol is open too: a
        // further source `override` binds against it.
        let isVirtual = GetRequiredAccessibility(owner) != Accessibility.Private
        let builder = ImportedTypeSymbol.GetWithoutNullability(
            typeof(StringBuilder),
            NullabilityFreeReason.CompilerProduced
        )
        return FunctionSymbol(
            Name,
            ImmutableArray.Create(ParameterSymbol("builder", builder)),
            TypeSymbol.Bool,
            declaration: nil,
            $package: nil,
            accessibility: GetRequiredAccessibility(owner),
            receiverType: owner,
            isOpen: isVirtual,
            isOverride: hasBase
        )
    }

    /// Gets the members `PrintMembers` prints, in declaration order: the
    /// public instance fields and the public readable non-indexer, non-override properties
    /// the type itself declares (Roslyn's rule). Private members still take
    /// part in equality, but never in the text.
    /// @param owner The data type.
    /// @returns The printable members.
    internal func GetPrintableMembers(owner StructSymbol) ImmutableArray[PrintableMember] {
        let members = ImmutableArray.CreateBuilder[(File string, Position int32, Group int32, Member PrintableMember)]()
        for field in owner.Fields {
            if field.IsStatic || field.Accessibility != Accessibility.Public || field.Type is PointerTypeSymbol {
                continue
            }
            members.Add(
                (
                    field.Declaration?.SyntaxTree.Text?.FileName ?? string.Empty,
                    field.Declaration?.Span.Start ?? -1,
                    0,
                    PrintableMember(field.Name, field, nil)
                )
            )
        }
        for property in owner.Properties {
            // Roslyn skips an override: the base declaration already prints it
            // (through the virtual getter), so printing both would repeat it.
            if property.IsStatic ||
                property.IsOverride ||
                property.IsIndexer ||
                !property.HasGetter ||
                property.Accessibility != Accessibility.Public ||
                property.Type is PointerTypeSymbol {
                continue
            }
            members.Add(
                (
                    property.Declaration?.SyntaxTree.Text?.FileName ?? string.Empty,
                    property.Declaration?.Span.Start ?? -1,
                    1,
                    PrintableMember(property.Name, nil, property)
                )
            )
        }
        // Stable: positional parameters (no body position) first, then source
        // order with a field before a property at an equal position. A partial
        // type's parts are merged in (file name, position) order (ADR-0066), so
        // a position is only comparable within one file.
        return members
            .Select(
            (entry(File string, Position int32, Group int32, Member PrintableMember), index int32) -> (
                entry.File,
                entry.Position,
                entry.Group,
                Index: index,
                entry.Member
            )
        )
            .OrderBy(
            (entry(File string, Position int32, Group int32, Index int32, Member PrintableMember)) -> entry.Item1,
            StringComparer.Ordinal
        )
            .ThenBy(
            (entry(File string, Position int32, Group int32, Index int32, Member PrintableMember)) -> entry.Item2
        )
            .ThenBy(
            (entry(File string, Position int32, Group int32, Index int32, Member PrintableMember)) -> entry.Item3
        )
            .ThenBy(
            (entry(File string, Position int32, Group int32, Index int32, Member PrintableMember)) -> entry.Item4
        )
            .Select(
            (entry(File string, Position int32, Group int32, Index int32, Member PrintableMember)) -> entry.Item5
        )
            .ToImmutableArray()
    }

    /// Tests whether a non-data class declares a virtual print-members slot of its own.
    /// @param ancestor The ancestor class.
    /// @returns `true` for a hand-written `open` or `override` slot.
    private func DeclaresVirtualSlot(ancestor StructSymbol) bool -> !ancestor.IsData &&
        ancestor.ClrType == nil &&
        FindDeclared(ancestor) is {} slot &&
        (slot.IsOpen || slot.IsOverride) &&
        slot.Accessibility == Accessibility.Protected &&
        slot.Type == TypeSymbol.Bool &&
        slot.ReturnRefKind == RefKind.None &&
        !slot.IsAsync &&
        !slot.IsSuspending &&
        slot
        .TypeParameters
        .IsDefaultOrEmpty
}
