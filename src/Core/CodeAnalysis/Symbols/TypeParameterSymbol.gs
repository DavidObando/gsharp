// <copyright file="TypeParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic

/// A generic type-parameter declared on a generic function or type (Phase 4.1 / ADR-0020).
/// At the binder level it behaves like a stand-in (cref:TypeSymbol); at call sites
/// it is substituted with a concrete type argument either from an explicit type-argument
/// list or via inference from value arguments.
class TypeParameterSymbol : TypeSymbol {
    /// Initializes a new instance of the (cref:TypeParameterSymbol) class.
    /// @param name The type-parameter name (e.g. `T`).
    /// @param ordinal The zero-based position of this parameter in its declaring list.
    /// @param constraint The constraint kind (Phase 4.1: only (cref:TypeParameterConstraint.Any); Phase 4.2
    /// widens this).
    /// @param variance The variance modifier (Phase 4.3 / ADR-0021).
    /// @param interfaceConstraint Optional sealed-interface constraint (Phase 4.2b / ADR-0020). When
    /// non-`null`, type arguments must implement this interface and the enum [`constraint`](paramref) is
    /// set to (cref:TypeParameterConstraint.Any) (the interface bound subsumes `any`).
    init(
        name string,
        ordinal int32,
        constraint TypeParameterConstraint,
        variance TypeParameterVariance,
        interfaceConstraint InterfaceSymbol? = nil
    ) : base(name) {
        Ordinal = ordinal
        Constraint = constraint
        Variance = variance
        InterfaceConstraint = interfaceConstraint
    }

    /// Gets the zero-based ordinal of this type parameter in its declaring list.
    prop Ordinal int32 {
        get;
    }

    /// Gets or sets the constraint applied to this type parameter (Phase 4.2 will add comparable /
    /// sealed-interface bounds).
    prop Constraint TypeParameterConstraint

    /// Gets the variance modifier (Phase 4.3 / ADR-0021).
    prop Variance TypeParameterVariance {
        get;
    }

    /// Gets or sets the sealed-interface constraint, if any (Phase 4.2b / ADR-0020). When non-`null`, type
    /// arguments must implement this interface. ADR-0089 allows late patching by the binder when the
    /// constraint is a self-referential constructed generic such as `[T IAdd[T]]`.
    prop InterfaceConstraint InterfaceSymbol?

    internal prop HasNullableInterfaceConstraint bool

    /// Gets or sets the imported CLR interface constraint, if any (issue #943).
    /// Holds an imported (possibly constructed-generic) CLR interface — e.g.
    /// `System.IComparable[T]` from `[T IComparable[T]]` — that a
    /// type argument must implement. Unlike (cref:InterfaceConstraint)
    /// (which models a G#-declared (cref:InterfaceSymbol)), this models a
    /// BCL / reference-assembly interface. Self-referential generic constraints
    /// (the type parameter appears in its own constraint) are supported. The
    /// emitter projects this onto a `GenericParamConstraint` metadata row
    /// and routes instance calls on the type parameter through it with a
    /// `constrained.` prefix so the IL is verifiable.
    prop ClrInterfaceConstraint TypeSymbol?

    /// Gets or sets the base-class (non-interface) constraint, if any (issue
    /// #1056). Holds the user-declared class (a (cref:StructSymbol) with
    /// (cref:StructSymbol.IsClass), possibly a constructed generic such
    /// as the self-referential `[T Box[T]]`) or an imported reference-type
    /// class that a type argument must derive from (or equal). Mirrors C#'s
    /// `where T : BaseClass`. C# permits at most one class constraint; G#'s
    /// single legacy constraint slot enforces this structurally. The emitter
    /// projects this onto a `GenericParamConstraint` metadata row and
    /// dispatches instance members declared on the base class through a normal
    /// `callvirt` on the (reference-typed) type parameter — no
    /// `constrained.` prefix is required because the bound proves `T`
    /// is a reference type.
    prop ClassConstraint TypeSymbol?

    internal prop HasNullableClassBound bool

    internal prop EffectiveClassConstraint TypeSymbol? -> if ClassConstraint is {} classBound {
        if HasNullableClassBound && !(classBound is NullableTypeSymbol) {
            cast[TypeSymbol](NullableTypeSymbol.Get(classBound))
        } else {
            classBound
        }
    } else {
        nil
    }

    internal prop UnwrappedClassConstraintStruct StructSymbol? -> if ClassConstraint is NullableTypeSymbol nullableClass {
        nullableClass.UnderlyingType as StructSymbol
    } else {
        ClassConstraint as StructSymbol
    }

    /// Gets or sets the DEPENDENT bound — another type parameter this one must
    /// derive from, satisfy, or equal (issue #4043). Mirrors C#'s
    /// `where TDerived : TBase`, spelled `[TBase, TDerived TBase]` in
    /// G#. The bound may be declared on the same list (a method's or a type's
    /// own parameters) or on the ENCLOSING type when a generic method's
    /// parameter names the class's — `class Box[T] { func Accept[U T](u U) }`.
    ///
    /// Deliberately a SEPARATE slot from (cref:ClassConstraint).
    /// Roughly forty consumers read `ClassConstraint != null` as "this
    /// parameter is a reference type" (nil acceptance, boxing decisions,
    /// `callvirt` without a `constrained.` prefix). A dependent bound
    /// proves nothing of the sort — `TBase` may itself be unconstrained,
    /// so `TDerived` can be instantiated with a struct — and reusing the
    /// slot would admit `nil` at a value-type slot, which is the #4027
    /// unverifiable-`ldnull` defect one release later.
    ///
    /// The emitter projects this onto a `GenericParamConstraint`
    /// metadata row whose `TypeDefOrRefOrSpec` is a TypeSpec naming
    /// `VAR(n)` / `MVAR(n)` — the encoding Roslyn emits for the same
    /// C# shape — through the existing `TypeParameterSymbol` branch of
    /// `ImportedMemberRefFactory.GetElementTypeToken`.
    prop TypeParameterBound TypeParameterSymbol?

    /// Gets whether a dependent bound has a concrete reference-kind proof.
    prop DependentBoundProvesReferenceType bool ->
    TypeParameterBound != nil && ProvesNonUniversalReferenceConstraint

    /// Gets the single interface bound carried by this type parameter, if any —
    /// either the G# (cref:InterfaceConstraint) or the imported
    /// (cref:ClrInterfaceConstraint) (issue #943). Used by the emitter to
    /// emit the `GenericParamConstraint` row and by the binder to enforce
    /// constraint satisfaction at call sites.
    prop ConstraintInterfaceType TypeSymbol? -> if InterfaceConstraint is {} iface {
        if HasNullableInterfaceConstraint {
            cast[TypeSymbol](NullableTypeSymbol.Get(iface))
        } else {
            cast[TypeSymbol](iface)
        }
    } else {
        ClrInterfaceConstraint
    }

    /// Gets the single TypeDefOrRefOrSpec bound this type parameter projects onto
    /// a `GenericParamConstraint` metadata row — the interface bound
    /// ((cref:ConstraintInterfaceType)) or the base-class bound
    /// ((cref:ClassConstraint), issue #1056), or the dependent bound on
    /// another type parameter ((cref:TypeParameterBound), issue #4043).
    /// At most one of these is set for a given type parameter.
    prop ConstraintReferenceType TypeSymbol? -> ConstraintInterfaceType ??
        EffectiveClassConstraint ??
        (
        if TypeParameterBound is {} tpBound {
            if HasNullableClassBound {
                cast[TypeSymbol](NullableTypeSymbol.Get(tpBound))
            } else {
                cast[TypeSymbol](tpBound)
            }
        } else {
            default(TypeSymbol?)
        }
    )

    /// Gets or sets a value indicating whether this type parameter carries a
    /// reference-type (`class`) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a reference type
    /// (`!IsValueType` at the CLR level). Maps to
    /// (cref:System.Reflection.GenericParameterAttributes.ReferenceTypeConstraint)
    /// in emitted IL.
    prop HasReferenceTypeConstraint bool

    /// Gets or sets a value indicating whether this type parameter carries a
    /// value-type (`struct`) constraint (ADR-0097 / issue #775).
    /// Type arguments must be a non-nullable value type. Maps to
    /// (cref:System.Reflection.GenericParameterAttributes.NotNullableValueTypeConstraint)
    /// in emitted IL. A `struct` constraint implies the
    /// `init()` (default-constructor) flag at the CLR level — the
    /// emitter sets both bits automatically per ECMA-335 II.10.1.7.
    prop HasValueTypeConstraint bool

    /// Gets or sets a value indicating whether this type parameter carries
    /// the default-constructor (`init()`) constraint (ADR-0097 /
    /// issue #775; spelled `new()` before issue #997). Type arguments
    /// must either be a value type or expose a
    /// public parameterless constructor. Maps to
    /// (cref:System.Reflection.GenericParameterAttributes.DefaultConstructorConstraint)
    /// in emitted IL.
    prop HasDefaultConstructorConstraint bool

    /// Gets or sets a value indicating whether this type parameter carries an
    /// `unmanaged` constraint (issue #1336). Type arguments must be an
    /// unmanaged type — a non-nullable value type whose fields are recursively
    /// unmanaged (blittable primitives, enums, pointers, or other unmanaged
    /// structs). The `unmanaged` constraint implies the value-type
    /// (`struct`) and default-constructor flags at the CLR level, and the
    /// emitter additionally projects a `GenericParamConstraint` to
    /// `System.ValueType` carrying a required custom modifier
    /// (`modreq`) of
    /// `System.Runtime.InteropServices.UnmanagedType` — the exact metadata
    /// shape C# emits for `where T : unmanaged`. That modreq is what makes
    /// a pointer to the type parameter (`*T`) and `sizeof(T)` over it
    /// verifiable.
    prop HasUnmanagedConstraint bool

    internal prop HasNullableReferenceTypeConstraint bool

    internal prop HasNotNullConstraint bool

    internal prop ProvesNotNullConstraint bool {
        get {
            var current TypeParameterSymbol? = this
            var visited HashSet[TypeParameterSymbol]? = nil
            while current != nil {
                let p = current
                if p.HasNotNullConstraint ||
                    (p.HasReferenceTypeConstraint && !p.HasNullableReferenceTypeConstraint) ||
                    p.HasValueTypeConstraint ||
                    p.HasUnmanagedConstraint ||
                    (p.InterfaceConstraint != nil && !p.HasNullableInterfaceConstraint) ||
                    p
                    .ClrInterfaceConstraint
                    ?.ReferenceNullability == ReferenceNullabilityKind.NotNull ||
                    (
                    !p.HasNullableClassBound &&
                        p
                        .ClassConstraint
                        ?.ReferenceNullability == ReferenceNullabilityKind.NotNull &&
                        !(p.ClassConstraint is TypeParameterSymbol)
                ) {
                    return true
                }
                if p.TypeParameterBound != nil && p.HasNullableClassBound {
                    break
                }
                visited ??= HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance)
                if !visited.Add(p) {
                    break
                }
                current = p.TypeParameterBound
            }
            return false
        }
    }

    internal prop HasNullableConstraintWithoutNotNull bool {
        get {
            if ProvesNotNullConstraint {
                return false
            }
            let chain = List[TypeParameterSymbol]{this}
            let visited = HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance){this}
            for var i = 0; i < chain.Count; i++ {
                let p = chain[i]
                if p.HasNullableReferenceTypeConstraint ||
                    p.HasNullableClassBound ||
                    p.HasNullableInterfaceConstraint ||
                    p.ClassConstraint is NullableTypeSymbol ||
                    p.ClrInterfaceConstraint is NullableTypeSymbol {
                    return true
                }
                if p.TypeParameterBound is {} tpBound && visited.Add(tpBound) {
                    chain.Add(tpBound)
                }
                if p.ClassConstraint is TypeParameterSymbol classTp && visited.Add(classTp) {
                    chain.Add(classTp)
                }
            }
            return false
        }
    }

    internal prop ProvesNonUniversalReferenceConstraint bool {
        get {
            if HasReferenceTypeConstraint {
                return true
            }
            let chain = List[TypeParameterSymbol]{this}
            let visited = HashSet[TypeParameterSymbol](ReferenceEqualityComparer.Instance){this}
            for var i = 0; i < chain.Count; i++ {
                let p = chain[i]
                if IsNonUniversalReferenceClassConstraint(p.ClassConstraint) {
                    return true
                }
                if p.TypeParameterBound is {} tpBound && visited.Add(tpBound) {
                    chain.Add(tpBound)
                }
                if p.ClassConstraint is TypeParameterSymbol classTp && visited.Add(classTp) {
                    chain.Add(classTp)
                }
            }
            return false
        }
    }

    internal prop HasKnownSourceNullableKind bool ->
    NullabilityImportRule.ClassifyArgument(this) != TypeArgumentKind.Unknown

    /// Records a primary annotation error so operator recovery does not repeat it.
    internal prop HasSourceNullableAnnotationError bool

    internal prop RequiresNullableGenericParamAttribute bool -> !HasValueTypeConstraint &&
        !HasUnmanagedConstraint &&
        (
        HasNullableReferenceTypeConstraint ||
            (!HasReferenceTypeConstraint && !HasNotNullConstraint && ConstraintReferenceType == nil) ||
            HasNullableConstraintWithoutNotNull ||
            (TypeParameterBound != nil && !ProvesNotNullConstraint)
    )

    internal prop RequiresNotNullGenericParamAttribute bool -> !HasValueTypeConstraint &&
        !HasUnmanagedConstraint &&
        !RequiresNullableGenericParamAttribute &&
        (
        HasNotNullConstraint ||
            (TypeParameterBound != nil && ProvesNotNullConstraint && !ProvesNonUniversalReferenceConstraint)
    )

    /// Gets or sets a value indicating whether this type parameter is declared
    /// on a generic method (as opposed to a generic type). When
    /// `true` the emitter encodes it as
    /// `MVAR()`; when `false` as
    /// `VAR()` (ADR-0087 §3, R2).
    /// @remarks Set by the binder when the type parameter is attached to a
    /// `FunctionSymbol`. Type-type parameters keep the default
    /// `false`.
    prop IsMethodTypeParameter bool

    shared {
        internal func IsNonUniversalReferenceClassConstraint(classConstraint TypeSymbol?) bool {
            if classConstraint == nil {
                return false
            }
            let unwrapped = if classConstraint is NullableTypeSymbol nullableClass {
                nullableClass.UnderlyingType
            } else {
                classConstraint
            }
            if unwrapped is StructSymbol structSym {
                return structSym.IsClass
            }
            if unwrapped.ClrType is {} clr {
                return IsNonUniversalReferenceClassConstraint(clr)
            }
            return false
        }

        internal func IsNonUniversalReferenceClassConstraint(clr Type) bool ->
        !clr.IsGenericParameter && clr.IsClass && !clr.IsValueType && !ClrTypeUtilities.AreSame(clr, typeof(object)) &&
            !ClrTypeUtilities.AreSame(clr, typeof(ValueType)) && !ClrTypeUtilities.AreSame(clr, typeof(Enum))
    }
}
