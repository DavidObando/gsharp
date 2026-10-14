// <copyright file="DataEqualityMemberModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Compiler-owned signatures shared by data equality binding and emission.
internal shared class DataEqualityMemberModel {
    /// Resolves the immediate source or imported record self-equality slot.
    /// @param owner The derived data class.
    /// @param importedMethod The actual imported slot, when the base is native.
    /// @returns The symbolic direct owner, or null when it has no record equality slot.
    internal func GetDirectBase(owner StructSymbol, out importedMethod MethodInfo?) TypeSymbol? {
        importedMethod = nil
        if !owner.IsData || !owner.IsClass {
            return nil
        }
        let hierarchy = owner.GetHierarchy()
        for var level = 0; level < hierarchy.Count; level++ {
            let ancestor = hierarchy[level]
            if level > 0 && (ancestor != nil && ancestor.IsData == true && ancestor.ClrType == nil) {
                if FindSealedIntermediaryOverride(hierarchy, level, ancestor) != nil {
                    return nil
                }
                return ancestor
            }
            if GetImportedDataBase(ancestor) is not{} importedDataBase {
                continue
            }
            let (importedBase, clrBase) = importedDataBase
            if FindSealedIntermediaryOverride(hierarchy, level + 1, importedBase) != nil {
                return nil
            }
            for method in ClrTypeUtilities.SafeGetMethods(
                clrBase,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            ) {
                let parameters = method.GetParameters()
                if method.Name == "Equals" &&
                    method.IsVirtual &&
                    !method.IsFinal &&
                    !method.IsGenericMethod &&
                    ClrTypeUtilities.AreSame(method.ReturnType, typeof(bool)) &&
                    parameters.Length == 1 &&
                    ClrTypeUtilities.AreSame(parameters[0].ParameterType, clrBase) {
                    importedMethod = method
                    return importedBase
                }
            }
        }
        return nil
    }

    /// Finds a sealed source override that blocks the inherited typed equality slot.
    /// @param owner The derived data class.
    /// @returns The blocking override, or null when the slot remains overridable.
    internal func GetSealedIntermediaryOverride(owner StructSymbol) FunctionSymbol? {
        if !owner.IsData || !owner.IsClass {
            return nil
        }
        let hierarchy = owner.GetHierarchy()
        for var level = 1; level < hierarchy.Count; level++ {
            let ancestor = hierarchy[level]
            if ancestor is {IsData: true, ClrType: nil} dataBase {
                return FindSealedIntermediaryOverride(hierarchy, level, dataBase)
            }
            if GetImportedDataBase(ancestor) is {} importedDataBase {
                return FindSealedIntermediaryOverride(hierarchy, level + 1, importedDataBase.Symbol)
            }
        }
        return nil
    }

    internal func FindSealedIntermediaryOverride(
        hierarchy IReadOnlyList[StructSymbol],
        dataBaseLevel int32,
        dataBase TypeSymbol
    ) FunctionSymbol? {
        for var level = 1; level < dataBaseLevel; level++ {
            for method in hierarchy[level].Methods {
                if IsSealedIntermediaryEqualityOverride(method, dataBase, hierarchy[level]) {
                    return method
                }
            }
        }
        return nil
    }

    internal func IsSealedIntermediaryEqualityOverride(
        method FunctionSymbol,
        dataBase TypeSymbol,
        constructedOwner StructSymbol? = nil
    ) bool -> method.Name == "Equals" &&
        method.IsOverride &&
        method
        .TypeParameters
        .IsDefaultOrEmpty &&
        method.Type == TypeSymbol.Bool &&
        method.ReturnRefKind == RefKind.None &&
        method
        .Parameters
        .Length == 1 &&
        method
        .Parameters[0]
        .RefKind == RefKind.None &&
        TypeSymbol
        .AreRuntimeEquivalentIgnoringReferenceNullability(
        constructedOwner?.SubstituteMemberType(method.Parameters[0].Type) ?? method.Parameters[0].Type,
        dataBase
    )

    internal func GetImportedDataBase(ancestor StructSymbol)(Symbol TypeSymbol, Clr Type)? {
        if !(ancestor.ImportedBaseType is {ClrType: {} clrBase} importedBase) ||
            (
            (
                !ImportedAssemblySemantics.TryGetTypeSemantics(clrBase, out var semantics) &&
                    !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(clrBase, out semantics)
            ) ||
                !semantics!!.IsData
        ) {
            return nil
        }
        return (importedBase, clrBase)
    }

    /// Creates a self or inherited typed-base equality member.
    /// @param owner The declaring data type.
    /// @param otherType The self type or direct data base.
    /// @param isOverride Whether this member overrides the direct base typed slot.
    /// @param importedMethod The actual imported slot supplying its parameter contract.
    /// @returns The compiler-owned equality signature.
    internal func Create(
        owner StructSymbol,
        otherType TypeSymbol,
        isOverride bool,
        importedMethod MethodInfo? = nil
    ) FunctionSymbol {
        let definition = typeof(IEquatable[_])
        let method = Invariant.Required(
            definition.GetMethod("Equals"),
            "IEquatable<T> declares Equals",
            expression: "definition.GetMethod(\"Equals\")"
        )
        let signatureType = if otherType is StructSymbol{IsGenericDefinition: true} sourceType {
            cast[TypeSymbol](
                StructSymbol.Construct(sourceType, sourceType.TypeParameters.Cast[TypeSymbol]().ToImmutableArray())!!
            )
        } else {
            otherType
        }
        let parameterType = if importedMethod == nil {
            MemberLookup.GetClrOpenParameterTypeSymbol(
                method.GetParameters()[0],
                definition,
                ImmutableArray.Create[TypeSymbol](signatureType)
            )
        } else {
            MemberLookup.GetClrMethodParameterTypeSymbol(signatureType, importedMethod, 0)
        }
        let parameterName = if importedMethod == nil {
            "other"
        } else {
            importedMethod.GetParameters()[0].Name ?? "arg${importedMethod.GetParameters()[0].Position}"
        }
        return FunctionSymbol(
            "Equals",
            ImmutableArray.Create(ParameterSymbol(parameterName, parameterType)),
            TypeSymbol.Bool,
            declaration: nil,
            $package: nil,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy) && !isOverride,
            isOverride: isOverride
        )
    }

    /// ADR-0199: the `IEquatable<Self>` every data type implements
    /// through its compiler-owned typed `Equals` slot, constructed over the
    /// type itself (over its own type parameters when it is generic).
    /// @param owner The data type.
    /// @returns The symbolic `IEquatable[Self]`.
    internal func CreateSelfEquatable(owner StructSymbol) TypeSymbol {
        let self TypeSymbol = if owner.TypeParameters.IsDefaultOrEmpty {
            owner
        } else {
            StructSymbol.Construct(owner, owner.TypeParameters.Cast[TypeSymbol]().ToImmutableArray())!!
        }
        return ImportedTypeSymbol.GetConstructed(
            typeof(IEquatable[object]),
            typeof(IEquatable[_]),
            ImmutableArray.Create(self)
        )
    }

    /// ADR-0199: tests whether [`interfaces`](paramref) already lists
    /// `IEquatable[Self]` for [`owner`](paramref), so the implicit
    /// interface is added exactly once (a cs2gs-translated record carries the
    /// native one over from the C# symbol).
    /// @param owner The data type.
    /// @param interfaces The imported interfaces the type names.
    /// @returns `true` when the self interface is already listed.
    internal func ListsSelfEquatable(owner StructSymbol, interfaces IEnumerable[TypeSymbol]) bool {
        let ownerDefinition = owner.Definition ?? owner
        for candidate in interfaces {
            if MemberLookup.TryGetSymbolicClrGenericInterface(candidate, out var open_, out var arguments) &&
                ClrTypeUtilities.AreSame(open_, typeof(IEquatable[_])) &&
                arguments.Length == 1 &&
                StripReferenceNullability(arguments[0]) is StructSymbol argument &&
                object.ReferenceEquals(argument.Definition ?? argument, ownerDefinition) &&
                IsOwnConstruction(owner, argument) {
                return true
            }
        }
        return false
    }

    /// Creates the existing synthesized override of object equality.
    /// @param owner The declaring data type.
    /// @returns The compiler-owned object equality signature.
    internal func CreateObject(owner StructSymbol) FunctionSymbol {
        let method = Invariant.Required(
            typeof(object).GetMethod("Equals", []Type{typeof(object)}),
            "System.Object declares instance Equals",
            expression: "typeof(object).GetMethod(\"Equals\", new[] { typeof(object) })"
        )
        let parameter = method.GetParameters()[0]
        return FunctionSymbol(
            "Equals",
            ImmutableArray.Create(
                ParameterSymbol(
                    Invariant.Required(
                        parameter.Name,
                        "System.Object.Equals has a named parameter",
                        expression: "parameter.Name"
                    ),
                    MemberLookup.GetClrOpenParameterTypeSymbol(
                        parameter,
                        typeof(object),
                        ImmutableArray[TypeSymbol].Empty
                    )
                )
            ),
            TypeSymbol.Bool,
            declaration: nil,
            $package: nil,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy),
            isOverride: true
        )
    }

    // `IEquatable[Item?]` and `IEquatable[Item]` are one runtime interface: `?` and
    // platform marks on a reference type are metadata only. A nullable VALUE type
    // (`Item?` on a data struct) is `Nullable<Item>`, a different interface.
    private func StripReferenceNullability(type TypeSymbol) TypeSymbol {
        var type = type
        while true {
            switch type {
                case NullableTypeSymbol{UnderlyingType: StructSymbol{IsClass: true} referenceType} {
                    type = referenceType
                    continue
                }
                case platform is PlatformTypeSymbol {
                    type = platform.UnderlyingType
                    continue
                }
                default {
                    return type
                }
            }
        }
    }

    // `IEquatable[Item[int32]]` is a different interface from `IEquatable[Item[T]]`:
    // the argument must be the type itself, closed over its own type parameters.
    private func IsOwnConstruction(owner StructSymbol, argument StructSymbol) bool {
        // The enclosing construction counts too: `Outer[int32].Item` is not `Outer[T].Item`.
        let enclosingParameters = StructSymbol.CollectEnclosingTypeParameters(owner)
        let enclosingArguments = argument.EnclosingTypeArguments
        if !enclosingArguments.IsDefaultOrEmpty && !SameParameters(enclosingArguments, enclosingParameters) {
            return false
        }
        let ownParameters = owner.TypeParameters
        let closedOver = argument.TypeArguments
        if ownParameters.IsDefaultOrEmpty {
            return closedOver.IsDefaultOrEmpty
        }
        if closedOver.IsDefaultOrEmpty || closedOver.Length != ownParameters.Length {
            return false
        }
        return SameParameters(closedOver, ownParameters)
    }

    private func SameParameters(
        arguments ImmutableArray[TypeSymbol],
        parameters ImmutableArray[TypeParameterSymbol]
    ) bool {
        if arguments.Length != parameters.Length {
            return false
        }
        for var i = 0; i < parameters.Length; i++ {
            // Ordinals restart per declaring type, so only the symbol itself is identity.
            if !object.ReferenceEquals(arguments[i], parameters[i]) {
                return false
            }
        }
        return true
    }
}
