// <copyright file="MetadataTokenCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Owns every key→handle dictionary that the
/// <see cref="ReflectionMetadataEmitter"/> uses to dedup ECMA-335 metadata
/// rows (assembly/type/member references, type/method specs,
/// type/method/field definitions, and a handful of book-keeping sets) for
/// a single emit. Externalises the ~28 cache fields and the structural
/// <see cref="MethodSpecSymbolKey"/> key that the emitter previously held
/// inline.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-2 introduces this type as the second step of the
/// <see cref="ReflectionMetadataEmitter"/> decomposition described in the
/// repository-level decomposition plan. It is intentionally a pure data
/// bag: every member is a mutable dictionary (or, for
/// <see cref="SystemRuntimeAssemblyRef"/>, a single mutable handle) that
/// the emitter reads from and writes to directly. No <c>GetOrAdd</c>
/// indirection or row-creation logic lives here yet — that's deliberate
/// so this PR moves state without altering the behavioural shape of the
/// existing call sites.
/// </para>
/// <para>
/// State that is deliberately <em>not</em> on
/// <see cref="MetadataTokenCache"/>:
/// the well-known BCL <c>MemberReferenceHandle?</c> / <c>TypeReferenceHandle</c>
/// singletons (<c>objectCtorRef</c>, <c>stringConcatRef</c>,
/// <c>delegateCombineRef</c>, etc. — move in PR-E-3
/// <c>WellKnownReferences</c>); the lambda/closure bookkeeping
/// (<c>lambdaBodies</c>, <c>closureInfos</c>, <c>goClosureInfos</c>,
/// <c>closureInvokeToInfo</c>, <c>synthesizedClosureClasses</c> — move in
/// PR-E-9 <c>ClosureEmitter</c>); and the state-machine plans
/// (<c>asyncStateMachinePlans</c>, <c>iteratorPlans</c>,
/// <c>asyncIteratorPlans</c>, <c>iteratorKickoffBodies</c>,
/// <c>iteratorStateMachineInfos</c>, <c>asyncIteratorInfos</c>,
/// <c>asyncIteratorEmitContexts</c>, <c>asyncSmEnclosingClosures</c> —
/// move in PR-E-10 <c>StateMachineEmitter</c>).
/// </para>
/// </remarks>
internal sealed class MetadataTokenCache
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MetadataTokenCache"/>
    /// class. The cache is intentionally constructor-only with no
    /// dependencies: it's a typed dictionary collection that the emitter
    /// populates as it emits metadata rows.
    /// </summary>
    public MetadataTokenCache()
    {
    }

    /// <summary>
    /// Gets the cache mapping a loaded <see cref="Assembly"/> to its
    /// <see cref="AssemblyReferenceHandle"/> in the emitted metadata.
    /// </summary>
    public Dictionary<Assembly, AssemblyReferenceHandle> AssemblyRefs { get; }
        = new Dictionary<Assembly, AssemblyReferenceHandle>();

    /// <summary>
    /// Gets or sets the cached <see cref="AssemblyReferenceHandle"/> for the
    /// well-known <c>System.Runtime</c> facade assembly. <c>default</c>
    /// when not yet resolved.
    /// </summary>
    public AssemblyReferenceHandle SystemRuntimeAssemblyRef { get; set; }

    /// <summary>
    /// Gets the cache mapping a CLR <see cref="Type"/> to its
    /// <see cref="TypeReferenceHandle"/>. Issue #420 (P3-9): keyed by
    /// <see cref="TypeIdentityComparer"/> so the same logical type reached
    /// through different MetadataLoadContext paths collapses to one TypeRef
    /// row instead of producing duplicates.
    /// </summary>
    public Dictionary<Type, TypeReferenceHandle> TypeRefs { get; }
        = new Dictionary<Type, TypeReferenceHandle>(TypeIdentityComparer.Instance);

    /// <summary>
    /// Gets the cache mapping a CLR <see cref="Type"/> (typically a
    /// constructed generic) to its <see cref="TypeSpecificationHandle"/>.
    /// Keyed by <see cref="TypeIdentityComparer"/> for the same reason as
    /// <see cref="TypeRefs"/>.
    /// </summary>
    public Dictionary<Type, TypeSpecificationHandle> TypeSpecs { get; }
        = new Dictionary<Type, TypeSpecificationHandle>(TypeIdentityComparer.Instance);

    /// <summary>
    /// Gets the cache mapping a <see cref="MethodInfo"/> to its
    /// <see cref="MemberReferenceHandle"/>.
    /// </summary>
    public Dictionary<MethodInfo, MemberReferenceHandle> MethodRefs { get; }
        = new Dictionary<MethodInfo, MemberReferenceHandle>();

    /// <summary>
    /// Gets the cache mapping a <see cref="MethodInfo"/> (a constructed
    /// generic method) to its <see cref="MethodSpecificationHandle"/>.
    /// </summary>
    public Dictionary<MethodInfo, MethodSpecificationHandle> MethodSpecs { get; }
        = new Dictionary<MethodInfo, MethodSpecificationHandle>();

    /// <summary>
    /// Gets the cache for MethodSpec rows whose generic arguments include
    /// user-defined type symbols. Issue #420 (P3-7): the placeholder-closed
    /// <see cref="MethodInfo"/> is identical across symbol arguments, so the
    /// key must include the symbol argument list with structural equality.
    /// </summary>
    public Dictionary<MethodSpecSymbolKey, MethodSpecificationHandle> MethodSpecsWithSymbolArgs { get; }
        = new Dictionary<MethodSpecSymbolKey, MethodSpecificationHandle>();

    /// <summary>
    /// Gets the cache mapping a <see cref="ConstructorInfo"/> to its
    /// <see cref="MemberReferenceHandle"/>.
    /// </summary>
    public Dictionary<ConstructorInfo, MemberReferenceHandle> CtorRefs { get; }
        = new Dictionary<ConstructorInfo, MemberReferenceHandle>();

    /// <summary>
    /// Gets the cache for ctor MemberRef rows whose parent TypeSpec is
    /// encoded against G# user-defined symbolic type arguments (issue #671).
    /// The placeholder-closed <see cref="ConstructorInfo"/> is identical
    /// across distinct user-type closures (all closed to <c>object</c> at the
    /// CLR level), so the key must include the symbol argument list with
    /// structural equality, mirroring <see cref="MethodSpecsWithSymbolArgs"/>.
    /// </summary>
    public Dictionary<CtorRefSymbolKey, MemberReferenceHandle> CtorRefsWithSymbolArgs { get; }
        = new Dictionary<CtorRefSymbolKey, MemberReferenceHandle>();

    /// <summary>
    /// Gets the cache mapping a <see cref="FieldInfo"/> to its
    /// <see cref="MemberReferenceHandle"/>.
    /// </summary>
    public Dictionary<FieldInfo, MemberReferenceHandle> FieldRefs { get; }
        = new Dictionary<FieldInfo, MemberReferenceHandle>();

    /// <summary>
    /// Gets the cache mapping a top-level user <see cref="FunctionSymbol"/>
    /// to the <see cref="MethodDefinitionHandle"/> emitted for it.
    /// </summary>
    public Dictionary<FunctionSymbol, MethodDefinitionHandle> FunctionHandles { get; }
        = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user struct/class <see cref="StructSymbol"/>
    /// to its emitted <see cref="TypeDefinitionHandle"/>.
    /// </summary>
    public Dictionary<StructSymbol, TypeDefinitionHandle> StructTypeDefs { get; }
        = new Dictionary<StructSymbol, TypeDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user struct/class field
    /// <see cref="FieldSymbol"/> to its emitted
    /// <see cref="FieldDefinitionHandle"/>.
    /// </summary>
    public Dictionary<FieldSymbol, FieldDefinitionHandle> StructFieldDefs { get; }
        = new Dictionary<FieldSymbol, FieldDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a class <see cref="StructSymbol"/> to the
    /// <see cref="MethodDefinitionHandle"/> of its (first) ctor.
    /// </summary>
    public Dictionary<StructSymbol, MethodDefinitionHandle> ClassCtorHandles { get; }
        = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a class <see cref="StructSymbol"/> with a
    /// primary constructor to that ctor's
    /// <see cref="MethodDefinitionHandle"/>.
    /// </summary>
    public Dictionary<StructSymbol, MethodDefinitionHandle> ClassPrimaryCtorHandles { get; }
        = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping each <see cref="ConstructorSymbol"/> overload
    /// to its emitted <see cref="MethodDefinitionHandle"/>. ADR-0063 §9: when
    /// a class declares multiple <c>init(...)</c> overloads, each
    /// <see cref="ConstructorSymbol"/> gets its own MethodDef. The first
    /// overload doubles as the entry in
    /// <see cref="ClassCtorHandles"/> for legacy lookups.
    /// </summary>
    public Dictionary<ConstructorSymbol, MethodDefinitionHandle> ExplicitCtorHandles { get; }
        = new Dictionary<ConstructorSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a <see cref="StructSymbol"/> with static
    /// field initializers to its synthesized <c>.cctor</c>'s
    /// <see cref="MethodDefinitionHandle"/> (issue #262).
    /// </summary>
    public Dictionary<StructSymbol, MethodDefinitionHandle> CctorHandles { get; }
        = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user-defined <see cref="InterfaceSymbol"/>
    /// to its emitted <see cref="TypeDefinitionHandle"/> (Phase 3.B.4).
    /// </summary>
    public Dictionary<InterfaceSymbol, TypeDefinitionHandle> InterfaceTypeDefs { get; }
        = new Dictionary<InterfaceSymbol, TypeDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user-defined <see cref="EnumSymbol"/> to its
    /// emitted <see cref="TypeDefinitionHandle"/> (issue #193).
    /// </summary>
    public Dictionary<EnumSymbol, TypeDefinitionHandle> EnumTypeDefs { get; }
        = new Dictionary<EnumSymbol, TypeDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping each <see cref="EnumMemberSymbol"/> to the
    /// per-member literal <see cref="FieldDefinitionHandle"/> carrying its
    /// integer constant.
    /// </summary>
    public Dictionary<EnumMemberSymbol, FieldDefinitionHandle> EnumMemberFieldDefs { get; }
        = new Dictionary<EnumMemberSymbol, FieldDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user-defined named
    /// <see cref="DelegateTypeSymbol"/> to its emitted
    /// <see cref="TypeDefinitionHandle"/> (ADR-0059 / issue #255).
    /// </summary>
    public Dictionary<DelegateTypeSymbol, TypeDefinitionHandle> DelegateTypeDefs { get; }
        = new Dictionary<DelegateTypeSymbol, TypeDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user-defined named
    /// <see cref="DelegateTypeSymbol"/> to its synthesized
    /// <c>Invoke</c> method's <see cref="MethodDefinitionHandle"/>.
    /// </summary>
    public Dictionary<DelegateTypeSymbol, MethodDefinitionHandle> DelegateInvokeHandles { get; }
        = new Dictionary<DelegateTypeSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a user-defined named
    /// <see cref="DelegateTypeSymbol"/> to its synthesized
    /// <c>.ctor(object, IntPtr)</c>'s
    /// <see cref="MethodDefinitionHandle"/>.
    /// </summary>
    public Dictionary<DelegateTypeSymbol, MethodDefinitionHandle> DelegateCtorHandles { get; }
        = new Dictionary<DelegateTypeSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a top-level <see cref="GlobalVariableSymbol"/>
    /// to its emitted static <see cref="FieldDefinitionHandle"/> on the
    /// entry-point package's <c>&lt;Program&gt;</c> TypeDef (issue #191).
    /// </summary>
    public Dictionary<GlobalVariableSymbol, FieldDefinitionHandle> GlobalFieldDefs { get; }
        = new Dictionary<GlobalVariableSymbol, FieldDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping an instance method <see cref="FunctionSymbol"/>
    /// on a user-defined class to its emitted
    /// <see cref="MethodDefinitionHandle"/> (Phase 3.B.3 sub-step 2b).
    /// </summary>
    public Dictionary<FunctionSymbol, MethodDefinitionHandle> MethodHandles { get; }
        = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping a <see cref="PropertySymbol"/> to the
    /// getter/setter accessor method handles used when emitting the
    /// PropertyDef + MethodSemantics rows (ADR-0051 Phase 6).
    /// </summary>
    public Dictionary<PropertySymbol, (MethodDefinitionHandle? Getter, MethodDefinitionHandle? Setter)> PropertyAccessorHandles { get; }
        = new Dictionary<PropertySymbol, (MethodDefinitionHandle? Getter, MethodDefinitionHandle? Setter)>();

    /// <summary>
    /// Gets the set of TypeDefs that already had a PropertyMap row emitted.
    /// Issue #418 (P1-7): allows the static-property emission path to decide
    /// whether to add its own PropertyMap without relying on symbol-level
    /// heuristics (which fail when instance properties are declared but all
    /// skipped during emission, leaving the static PropertyDef rows
    /// orphaned).
    /// </summary>
    public HashSet<TypeDefinitionHandle> TypesWithPropertyMap { get; }
        = new HashSet<TypeDefinitionHandle>();

    /// <summary>
    /// Gets the cache mapping an <see cref="EventSymbol"/> to its
    /// add/remove/raise accessor method handles used when emitting the
    /// EventDef + MethodSemantics rows (ADR-0052; issue #257 added the
    /// optional <c>Raise</c> handle).
    /// </summary>
    public Dictionary<EventSymbol, (MethodDefinitionHandle Add, MethodDefinitionHandle Remove, MethodDefinitionHandle? Raise)> EventAccessorHandles { get; }
        = new Dictionary<EventSymbol, (MethodDefinitionHandle Add, MethodDefinitionHandle Remove, MethodDefinitionHandle? Raise)>();

    /// <summary>
    /// Gets the cache mapping a <c>data struct</c>'s
    /// <see cref="StructSymbol"/> to its synthesized
    /// <c>op_Equality</c> <see cref="MethodDefinitionHandle"/> (issue #410 /
    /// ADR-0029). Populated when the operator is synthesized so future call
    /// sites could route through it directly; not currently used by the
    /// <c>BoundBinaryExpression</c> lowering (which still boxes and
    /// dispatches via <c>Object.Equals</c>) but kept for forward-
    /// compatibility with future perf work.
    /// </summary>
    public Dictionary<StructSymbol, MethodDefinitionHandle> DataStructOpEqualityHandles { get; }
        = new Dictionary<StructSymbol, MethodDefinitionHandle>();

    /// <summary>
    /// Issue #420 (P3-7): structural cache key for MethodSpec rows whose
    /// generic arguments include user-defined type symbols. Uses reference
    /// equality on the contained <see cref="TypeSymbol"/> entries (declared
    /// user types are interned per compilation), combined with structural
    /// equality on the array.
    /// </summary>
    internal readonly struct MethodSpecSymbolKey : IEquatable<MethodSpecSymbolKey>
    {
        private readonly MethodInfo method;
        private readonly ImmutableArray<TypeSymbol> typeArgs;

        public MethodSpecSymbolKey(MethodInfo method, ImmutableArray<TypeSymbol> typeArgs)
        {
            this.method = method;
            this.typeArgs = typeArgs.IsDefault ? ImmutableArray<TypeSymbol>.Empty : typeArgs;
        }

        public bool Equals(MethodSpecSymbolKey other)
        {
            if (!ReferenceEquals(this.method, other.method))
            {
                return false;
            }

            if (this.typeArgs.Length != other.typeArgs.Length)
            {
                return false;
            }

            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                if (!ReferenceEquals(this.typeArgs[i], other.typeArgs[i]))
                {
                    return false;
                }
            }

            return true;
        }

        public override bool Equals(object obj) => obj is MethodSpecSymbolKey other && this.Equals(other);

        public override int GetHashCode()
        {
            var hash = RuntimeHelpers.GetHashCode(this.method);
            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.typeArgs[i]));
            }

            return hash;
        }
    }

    /// <summary>
    /// Issue #671: structural cache key for ctor MemberRef rows whose parent
    /// TypeSpec carries G# user-defined symbolic type arguments. Counterpart
    /// to <see cref="MethodSpecSymbolKey"/>.
    /// </summary>
    internal readonly struct CtorRefSymbolKey : IEquatable<CtorRefSymbolKey>
    {
        private readonly ConstructorInfo ctor;
        private readonly ImmutableArray<TypeSymbol> typeArgs;

        public CtorRefSymbolKey(ConstructorInfo ctor, ImmutableArray<TypeSymbol> typeArgs)
        {
            this.ctor = ctor;
            this.typeArgs = typeArgs.IsDefault ? ImmutableArray<TypeSymbol>.Empty : typeArgs;
        }

        public bool Equals(CtorRefSymbolKey other)
        {
            if (!ReferenceEquals(this.ctor, other.ctor))
            {
                return false;
            }

            if (this.typeArgs.Length != other.typeArgs.Length)
            {
                return false;
            }

            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                if (!ReferenceEquals(this.typeArgs[i], other.typeArgs[i]))
                {
                    return false;
                }
            }

            return true;
        }

        public override bool Equals(object obj) => obj is CtorRefSymbolKey other && this.Equals(other);

        public override int GetHashCode()
        {
            var hash = RuntimeHelpers.GetHashCode(this.ctor);
            for (var i = 0; i < this.typeArgs.Length; i++)
            {
                hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.typeArgs[i]));
            }

            return hash;
        }
    }
}
