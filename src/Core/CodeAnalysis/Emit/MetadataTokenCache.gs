// <copyright file="MetadataTokenCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Runtime.CompilerServices

/// Owns every key→handle dictionary that the
/// (cref:ReflectionMetadataEmitter) uses to dedup ECMA-335 metadata
/// rows (assembly/type/member references, type/method specs,
/// type/method/field definitions, and a handful of book-keeping sets) for
/// a single emit. Externalises the ~28 cache fields and the structural
/// (cref:MethodSpecSymbolKey) key that the emitter previously held
/// inline.
/// @remarks PR-E-2 introduces this type as the second step of the
/// (cref:ReflectionMetadataEmitter) decomposition described in the
/// repository-level decomposition plan. It is intentionally a pure data
/// bag: every member is a mutable dictionary (or, for
/// (cref:SystemRuntimeAssemblyRef), a single mutable handle) that
/// the emitter reads from and writes to directly. No `GetOrAdd`
/// indirection or row-creation logic lives here yet — that's deliberate
/// so this PR moves state without altering the behavioural shape of the
/// existing call sites.
///
/// State that is deliberately <em>not</em> on
/// (cref:MetadataTokenCache):
/// the well-known BCL `MemberReferenceHandle?` / `TypeReferenceHandle`
/// singletons (`objectCtorRef`, `stringConcatRef`,
/// `delegateCombineRef`, etc. — move in PR-E-3
/// `WellKnownReferences`); the lambda/closure bookkeeping
/// (`lambdaBodies`, `closureInfos`, `goClosureInfos`,
/// `closureInvokeToInfo`, `synthesizedClosureClasses` — move in
/// PR-E-9 `ClosureEmitter`); and the state-machine plans
/// (`asyncStateMachinePlans`, `iteratorPlans`,
/// `asyncIteratorPlans`, `iteratorKickoffBodies`,
/// `iteratorStateMachineInfos`, `asyncIteratorInfos`,
/// `iteratorEmitContexts`, `asyncSmEnclosingClosures` —
/// move in PR-E-10 `StateMachineEmitter`).
internal class MetadataTokenCache {
    /// Initializes a new instance of the (cref:MetadataTokenCache)
    /// class. The cache is intentionally constructor-only with no
    /// dependencies: it's a typed dictionary collection that the emitter
    /// populates as it emits metadata rows.
    init() {
        DataClassEqualsTypedHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        AssemblyRefs = Dictionary[Assembly, AssemblyReferenceHandle]()
        TypeRefs = Dictionary[Type, TypeReferenceHandle](TypeIdentityComparer.Instance)
        TypeSpecs = Dictionary[Type, TypeSpecificationHandle](TypeIdentityComparer.Instance)
        MethodRefs = Dictionary[MethodInfo, MemberReferenceHandle]()
        MethodSpecs = Dictionary[MethodInfo, MethodSpecificationHandle]()
        MethodSpecsWithSymbolArgs = Dictionary[MethodSpecSymbolKey, MethodSpecificationHandle]()
        CtorRefs = Dictionary[ConstructorInfo, MemberReferenceHandle]()
        CtorRefsWithSymbolArgs = Dictionary[CtorRefSymbolKey, MemberReferenceHandle]()
        NullableOpenCtorMemberRefs = Dictionary[(Tp TypeParameterSymbol, Scope RemapScope), MemberReferenceHandle]()
        NullableUserEnumCtorMemberRefs = Dictionary[(Enum EnumSymbol, Scope RemapScope), MemberReferenceHandle]()
        NullableUserStructCtorMemberRefs = Dictionary[
            (Underlying TypeSymbol, Scope RemapScope),
            MemberReferenceHandle
        ]()
        NullableUserValueTypeGetValueMemberRefs = Dictionary[
            (Underlying TypeSymbol, Scope RemapScope),
            MemberReferenceHandle
        ]()
        NullableUserValueTypeGetHasValueMemberRefs = Dictionary[
            (Underlying TypeSymbol, Scope RemapScope),
            MemberReferenceHandle
        ]()
        FieldRefs = Dictionary[FieldInfo, MemberReferenceHandle]()
        FunctionHandles = Dictionary[FunctionSymbol, MethodDefinitionHandle]()
        PInvokeModuleRefs = Dictionary[string, ModuleReferenceHandle](StringComparer.Ordinal)
        LibraryImportInnerHandles = Dictionary[FunctionSymbol, MethodDefinitionHandle]()
        StructTypeDefs = Dictionary[StructSymbol, TypeDefinitionHandle]()
        StructFieldDefs = Dictionary[FieldSymbol, FieldDefinitionHandle]()
        DeclaredFieldDefs = Dictionary[FieldSymbol, FieldDefinitionHandle]()
        ClassCtorHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        ClassPrimaryCtorHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        ExplicitCtorHandles = Dictionary[ConstructorSymbol, MethodDefinitionHandle]()
        CctorHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        InterfaceTypeDefs = Dictionary[InterfaceSymbol, TypeDefinitionHandle]()
        EnumTypeDefs = Dictionary[EnumSymbol, TypeDefinitionHandle]()
        EnumMemberFieldDefs = Dictionary[EnumMemberSymbol, FieldDefinitionHandle]()
        DelegateTypeDefs = Dictionary[DelegateTypeSymbol, TypeDefinitionHandle]()
        DelegateInvokeHandles = Dictionary[DelegateTypeSymbol, MethodDefinitionHandle]()
        DelegateCtorHandles = Dictionary[DelegateTypeSymbol, MethodDefinitionHandle]()
        GlobalFieldDefs = Dictionary[GlobalVariableSymbol, FieldDefinitionHandle]()
        MethodHandles = Dictionary[FunctionSymbol, MethodDefinitionHandle]()
        PropertyAccessorHandles = Dictionary[
            PropertySymbol,
            (Getter MethodDefinitionHandle?, Setter MethodDefinitionHandle?)
        ]()
        TypesWithPropertyMap = HashSet[TypeDefinitionHandle]()
        EventAccessorHandles = Dictionary[
            EventSymbol,
            (Add MethodDefinitionHandle, Remove MethodDefinitionHandle, Raise MethodDefinitionHandle?)
        ]()
        DataStructOpEqualityHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        DataClassCopyConstructorHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
        DataClassCloneHandles = Dictionary[StructSymbol, MethodDefinitionHandle]()
    }

    /// Gets the planned self-typed equality slots for native data classes.
    prop DataClassEqualsTypedHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a loaded (cref:Assembly) to its
    /// (cref:AssemblyReferenceHandle) in the emitted metadata.
    prop AssemblyRefs Dictionary[Assembly, AssemblyReferenceHandle] {
        get;
    }

    /// Gets or sets the cached (cref:AssemblyReferenceHandle) for the
    /// well-known `System.Runtime` facade assembly. `default`
    /// when not yet resolved.
    prop SystemRuntimeAssemblyRef AssemblyReferenceHandle

    /// Gets the cache mapping a CLR (cref:Type) to its
    /// (cref:TypeReferenceHandle). Issue #420 (P3-9): keyed by
    /// (cref:TypeIdentityComparer) so the same logical type reached
    /// through different MetadataLoadContext paths collapses to one TypeRef
    /// row instead of producing duplicates.
    prop TypeRefs Dictionary[Type, TypeReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a CLR (cref:Type) (typically a
    /// constructed generic) to its (cref:TypeSpecificationHandle).
    /// Keyed by (cref:TypeIdentityComparer) for the same reason as
    /// (cref:TypeRefs).
    prop TypeSpecs Dictionary[Type, TypeSpecificationHandle] {
        get;
    }

    /// Gets the cache mapping a (cref:MethodInfo) to its
    /// (cref:MemberReferenceHandle).
    prop MethodRefs Dictionary[MethodInfo, MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a (cref:MethodInfo) (a constructed
    /// generic method) to its (cref:MethodSpecificationHandle).
    prop MethodSpecs Dictionary[MethodInfo, MethodSpecificationHandle] {
        get;
    }

    /// Gets the cache for MethodSpec rows whose generic arguments include
    /// user-defined type symbols. Issue #420 (P3-7): the placeholder-closed
    /// (cref:MethodInfo) is identical across symbol arguments, so the
    /// key must include the symbol argument list with structural equality.
    prop MethodSpecsWithSymbolArgs Dictionary[MethodSpecSymbolKey, MethodSpecificationHandle] {
        get;
    }

    /// Gets the cache mapping a (cref:ConstructorInfo) to its
    /// (cref:MemberReferenceHandle).
    prop CtorRefs Dictionary[ConstructorInfo, MemberReferenceHandle] {
        get;
    }

    /// Gets the cache for ctor MemberRef rows whose parent TypeSpec is
    /// encoded against G# user-defined symbolic type arguments (issue #671).
    /// The placeholder-closed (cref:ConstructorInfo) is identical
    /// across distinct user-type closures (all closed to `object` at the
    /// CLR level), so the key must include the symbol argument list with
    /// structural equality, mirroring (cref:MethodSpecsWithSymbolArgs).
    prop CtorRefsWithSymbolArgs Dictionary[CtorRefSymbolKey, MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping an open type parameter `T` (constrained to
    /// `struct`) to the (cref:MemberReferenceHandle) for
    /// `System.Nullable`1<!!T>::.ctor(!0)` (issue #814 / ADR-0084 §L5).
    /// The parent TypeSpec uses the same VAR/MVAR slot as the wrapping
    /// method's signature, so a single MemberRef per `T` serves every
    /// instantiation of the enclosing generic method or type. Issue #3163:
    /// the parent TypeSpec is encoded through `EncodeTypeSymbol`, whose
    /// VAR/MVAR ordinal depends on the active generic remaps, so the key
    /// includes the (cref:RemapScope).
    prop NullableOpenCtorMemberRefs Dictionary[(Tp TypeParameterSymbol, Scope RemapScope), MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined (cref:EnumSymbol) to the
    /// (cref:MemberReferenceHandle) for
    /// `System.Nullable`1<E>::.ctor(!0)` (issue #1298). The parent
    /// TypeSpec closes `Nullable<>` over the enum's emitted TypeDef,
    /// so one MemberRef per enum serves every `E -> E?` lift site.
    /// Issue #3163: a nested enum's parent TypeSpec can encode enclosing
    /// type-parameter ordinals, so the key includes the
    /// (cref:RemapScope).
    prop NullableUserEnumCtorMemberRefs Dictionary[(Enum EnumSymbol, Scope RemapScope), MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a symbolic value-type underlying to the
    /// (cref:MemberReferenceHandle) for
    /// `System.Nullable`1<T>::.ctor(!0)`. The parent TypeSpec closes
    /// `Nullable<>` over the encoded underlying, so one MemberRef
    /// serves every matching nullable lift site. Issue #3163: the symbolic
    /// underlying can encode type-parameter ordinals, so the key includes
    /// the (cref:RemapScope).
    prop NullableUserStructCtorMemberRefs Dictionary[(Underlying TypeSymbol, Scope RemapScope), MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined value-type underlying
    /// ((cref:EnumSymbol) or value-kind (cref:StructSymbol)) to the
    /// (cref:MemberReferenceHandle) for
    /// `System.Nullable`1<T>::get_Value()` (issue #1572). The parent
    /// TypeSpec closes `Nullable<>` over the type's emitted
    /// TypeDef/TypeSpec, so one MemberRef per underlying serves every
    /// `(v!!)` unwrap and narrowing-read site. Issue #3163: the
    /// underlying can be (or contain) a type parameter whose VAR/MVAR
    /// ordinal depends on the active remaps, so the key includes the
    /// (cref:RemapScope).
    prop NullableUserValueTypeGetValueMemberRefs Dictionary[
        (Underlying TypeSymbol, Scope RemapScope),
        MemberReferenceHandle
    ] {
        get;
    }

    /// Gets the cache mapping a user-defined value-type underlying
    /// ((cref:EnumSymbol) or value-kind (cref:StructSymbol)) to
    /// the (cref:MemberReferenceHandle) for
    /// `System.Nullable`1<T>::get_HasValue()` (issue #2388). Mirrors
    /// (cref:NullableUserValueTypeGetValueMemberRefs); used to
    /// HasValue-branch a nullable-lifted Stream C/D custom-operator call
    /// over a same-compilation struct, where no real CLR
    /// (cref:System.Type) exists to drive the reflection-based
    /// (cref:WellKnownReferences.GetNullableGetHasValueReference).
    /// Issue #3163: keyed with the (cref:RemapScope), mirroring
    /// (cref:NullableUserValueTypeGetValueMemberRefs).
    prop NullableUserValueTypeGetHasValueMemberRefs Dictionary[
        (Underlying TypeSymbol, Scope RemapScope),
        MemberReferenceHandle
    ] {
        get;
    }

    /// Gets the cache mapping a (cref:FieldInfo) to its
    /// (cref:MemberReferenceHandle).
    prop FieldRefs Dictionary[FieldInfo, MemberReferenceHandle] {
        get;
    }

    /// Gets the cache mapping a top-level user (cref:FunctionSymbol)
    /// to the (cref:MethodDefinitionHandle) emitted for it.
    prop FunctionHandles Dictionary[FunctionSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a P/Invoke library name to its emitted
    /// (cref:ModuleReferenceHandle) (ADR-0086 / issue #727). The
    /// emitter deduplicates module references by case-sensitive library
    /// name so two `@DllImport("libc")` functions share a single
    /// `ModuleRef` row.
    prop PInvokeModuleRefs Dictionary[string, ModuleReferenceHandle] {
        get;
    }

    /// Gets the cache mapping an `@LibraryImport` function symbol
    /// (ADR-0092 / issue #758) to the (cref:MethodDefinitionHandle)
    /// of the synthesized blittable inner P/Invoke method. The outer
    /// managed stub (which lives in (cref:FunctionHandles)) calls
    /// into this inner method after performing explicit string
    /// marshalling.
    prop LibraryImportInnerHandles Dictionary[FunctionSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user struct/class (cref:StructSymbol)
    /// to its emitted (cref:TypeDefinitionHandle).
    prop StructTypeDefs Dictionary[StructSymbol, TypeDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user struct/class field
    /// (cref:FieldSymbol) to its emitted
    /// (cref:FieldDefinitionHandle).
    prop StructFieldDefs Dictionary[FieldSymbol, FieldDefinitionHandle] {
        get;
    }

    /// Gets field rows reserved before any method body is emitted.
    prop DeclaredFieldDefs Dictionary[FieldSymbol, FieldDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a class (cref:StructSymbol) to the
    /// (cref:MethodDefinitionHandle) of its (first) ctor.
    prop ClassCtorHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a class (cref:StructSymbol) with a
    /// primary constructor to that ctor's
    /// (cref:MethodDefinitionHandle).
    prop ClassPrimaryCtorHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping each (cref:ConstructorSymbol) overload
    /// to its emitted (cref:MethodDefinitionHandle). ADR-0063 §9: when
    /// a class declares multiple `init(...)` overloads, each
    /// (cref:ConstructorSymbol) gets its own MethodDef. The first
    /// overload doubles as the entry in
    /// (cref:ClassCtorHandles) for legacy lookups.
    prop ExplicitCtorHandles Dictionary[ConstructorSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a (cref:StructSymbol) with static
    /// field initializers to its synthesized `.cctor`'s
    /// (cref:MethodDefinitionHandle) (issue #262).
    prop CctorHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined (cref:InterfaceSymbol)
    /// to its emitted (cref:TypeDefinitionHandle) (Phase 3.B.4).
    prop InterfaceTypeDefs Dictionary[InterfaceSymbol, TypeDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined (cref:EnumSymbol) to its
    /// emitted (cref:TypeDefinitionHandle) (issue #193).
    prop EnumTypeDefs Dictionary[EnumSymbol, TypeDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping each (cref:EnumMemberSymbol) to the
    /// per-member literal (cref:FieldDefinitionHandle) carrying its
    /// integer constant.
    prop EnumMemberFieldDefs Dictionary[EnumMemberSymbol, FieldDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined named
    /// (cref:DelegateTypeSymbol) to its emitted
    /// (cref:TypeDefinitionHandle) (ADR-0059 / issue #255).
    prop DelegateTypeDefs Dictionary[DelegateTypeSymbol, TypeDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined named
    /// (cref:DelegateTypeSymbol) to its synthesized
    /// `Invoke` method's (cref:MethodDefinitionHandle).
    prop DelegateInvokeHandles Dictionary[DelegateTypeSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a user-defined named
    /// (cref:DelegateTypeSymbol) to its synthesized
    /// `.ctor(object, IntPtr)`'s
    /// (cref:MethodDefinitionHandle).
    prop DelegateCtorHandles Dictionary[DelegateTypeSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a top-level (cref:GlobalVariableSymbol)
    /// to its emitted static (cref:FieldDefinitionHandle) on the
    /// entry-point package's `<Program>` TypeDef (issue #191).
    prop GlobalFieldDefs Dictionary[GlobalVariableSymbol, FieldDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping an instance method (cref:FunctionSymbol)
    /// on a user-defined class to its emitted
    /// (cref:MethodDefinitionHandle) (Phase 3.B.3 sub-step 2b).
    prop MethodHandles Dictionary[FunctionSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping a (cref:PropertySymbol) to the
    /// getter/setter accessor method handles used when emitting the
    /// PropertyDef + MethodSemantics rows (ADR-0051 Phase 6).
    prop PropertyAccessorHandles Dictionary[
        PropertySymbol,
        (Getter MethodDefinitionHandle?, Setter MethodDefinitionHandle?)
    ] {
        get;
    }

    /// Gets the set of TypeDefs that already had a PropertyMap row emitted.
    /// Issue #418 (P1-7): allows the static-property emission path to decide
    /// whether to add its own PropertyMap without relying on symbol-level
    /// heuristics (which fail when instance properties are declared but all
    /// skipped during emission, leaving the static PropertyDef rows
    /// orphaned).
    prop TypesWithPropertyMap HashSet[TypeDefinitionHandle] {
        get;
    }

    /// Gets the cache mapping an (cref:EventSymbol) to its
    /// add/remove/raise accessor method handles used when emitting the
    /// EventDef + MethodSemantics rows (ADR-0052; issue #257 added the
    /// optional `Raise` handle).
    prop EventAccessorHandles Dictionary[
        EventSymbol,
        (Add MethodDefinitionHandle, Remove MethodDefinitionHandle, Raise MethodDefinitionHandle?)
    ] {
        get;
    }

    /// Gets the cache mapping a `data struct`'s
    /// (cref:StructSymbol) to its synthesized
    /// `op_Equality` (cref:MethodDefinitionHandle) (issue #410 /
    /// ADR-0029). Populated when the operator is synthesized so future call
    /// sites could route through it directly; not currently used by the
    /// `BoundBinaryExpression` lowering (which still boxes and
    /// dispatches via `Object.Equals`) but kept for forward-
    /// compatibility with future perf work.
    prop DataStructOpEqualityHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the planned copy-constructor MethodDef for each data class and
    /// non-data class in a data-class inheritance chain. Planned handles let
    /// derived copy constructors call their direct base copy constructor
    /// regardless of declaration or body-emission order.
    prop DataClassCopyConstructorHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Gets the planned `<Clone>$` MethodDef for each data class.
    /// Planned handles let covariant clone MethodImpl rows target a base clone
    /// even when the base method body has not been emitted yet.
    prop DataClassCloneHandles Dictionary[StructSymbol, MethodDefinitionHandle] {
        get;
    }

    /// Issue #420 / #3065: structural cache key for MethodSpec rows whose
    /// generic arguments include user-defined type symbols. Requires the
    /// full (cref:RemapScope) (issue #3163) because the same symbols
    /// can encode to different VAR/MVAR ordinals under different active
    /// remaps. Uses reference equality throughout.
    internal struct MethodSpecSymbolKey : IEquatable[MethodSpecSymbolKey] {
        private let method MethodInfo
        private let typeArgs ImmutableArray[TypeSymbol?]
        private let $scope RemapScope

        init(method MethodInfo, typeArgs ImmutableArray[TypeSymbol?], $scope RemapScope) {
            this.method = method
            this.typeArgs = if typeArgs.IsDefault {
                ImmutableArray[TypeSymbol?].Empty
            } else {
                typeArgs
            }
            this.$scope = $scope
        }

        func Equals(other MethodSpecSymbolKey) bool {
            if !object.ReferenceEquals(this.method, other.method) {
                return false
            }
            if !this.$scope.Equals(other.$scope) || this.typeArgs.Length != other.typeArgs.Length {
                return false
            }
            for var i = 0; i < this.typeArgs.Length; i++ {
                if !object.ReferenceEquals(this.typeArgs[i], other.typeArgs[i]) {
                    return false
                }
            }
            return true
        }

        override func Equals(obj object?) bool -> obj is MethodSpecSymbolKey other && this.Equals(other)

        override func GetHashCode() int32 {
            var hash = RuntimeHelpers.GetHashCode(this.method)
            hash = unchecked((hash * 31) + this.$scope.GetHashCode())
            for var i = 0; i < this.typeArgs.Length; i++ {
                hash = unchecked(
                    (hash * 31) +
                        (
                        if this.typeArgs[i] is {} typeArg {
                            RuntimeHelpers.GetHashCode(typeArg)
                        } else {
                            0
                        }
                    )
                )
            }
            return hash
        }
    }

    /// Issues #671 and #2930: structural cache key for ctor MemberRef rows
    /// whose parent TypeSpec carries G# user-defined symbolic type arguments.
    /// Requires the full (cref:RemapScope) (issue #3163) because the
    /// same symbols can encode to different VAR/MVAR ordinals under
    /// different active remaps. Counterpart to
    /// (cref:MethodSpecSymbolKey), which is keyed the same way
    /// since #3065.
    internal struct CtorRefSymbolKey : IEquatable[CtorRefSymbolKey] {
        private let ctor ConstructorInfo
        private let typeArgs ImmutableArray[TypeSymbol]
        private let $scope RemapScope

        init(ctor ConstructorInfo, typeArgs ImmutableArray[TypeSymbol], $scope RemapScope) {
            this.ctor = ctor
            this.typeArgs = if typeArgs.IsDefault {
                ImmutableArray[TypeSymbol].Empty
            } else {
                typeArgs
            }
            this.$scope = $scope
        }

        func Equals(other CtorRefSymbolKey) bool {
            if !object.ReferenceEquals(this.ctor, other.ctor) {
                return false
            }
            if !this.$scope.Equals(other.$scope) || this.typeArgs.Length != other.typeArgs.Length {
                return false
            }
            for var i = 0; i < this.typeArgs.Length; i++ {
                if !object.ReferenceEquals(this.typeArgs[i], other.typeArgs[i]) {
                    return false
                }
            }
            return true
        }

        override func Equals(obj object?) bool -> obj is CtorRefSymbolKey other && this.Equals(other)

        override func GetHashCode() int32 {
            var hash = RuntimeHelpers.GetHashCode(this.ctor)
            hash = unchecked((hash * 31) + this.$scope.GetHashCode())
            for var i = 0; i < this.typeArgs.Length; i++ {
                hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.typeArgs[i]))
            }
            return hash
        }
    }
}
