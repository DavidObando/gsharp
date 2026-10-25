// <copyright file="ClrTypeUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation

/// Helpers for comparing (cref:Type) instances that may originate from
/// different reflection contexts (e.g. the gsc host's live runtime vs. a
/// (cref:System.Reflection.MetadataLoadContext) over target-framework
/// reference assemblies). Reference-equality (`==`) and
/// (cref:Type.IsAssignableFrom) only work within a single context, so
/// cross-context comparisons must fall back to name-based matching.
shared class ClrTypeUtilities {
    /// Per-member-kind cache backing (cref:SafeEnumerate{TMember}). A
    /// distinct closed generic (`MemberCache<MethodInfo>` vs.
    /// `MemberCache<PropertyInfo>`, etc.) gets its own static
    /// dictionary, so a single `(Type, BindingFlags)` key cannot collide
    /// across member kinds.
    /// @typeparam TMember The (cref:MemberInfo)-derived member kind cached.
    private shared class MemberCache[TMember MemberInfo] {
        internal let Cache ConcurrentDictionary[(Type Type, Flags BindingFlags), []TMember] = ConcurrentDictionary[
            (Type Type, Flags BindingFlags),
            []TMember
        ]()
    }

    /// Issue #1678: process-wide memoization of (cref:SafeGetInterfaces),
    /// keyed by the CLR (cref:Type). Every binder call site that walks a
    /// receiver's transitive interfaces (member lookup, collection-initializer
    /// `Add` probing, base-call candidate collection, etc.) re-enumerated
    /// (cref:Type.GetInterfaces) from scratch before this cache existed;
    /// for BCL types with wide interface sets (`List<T>`) that cost
    /// was paid once per call site instead of once per type.
    private var interfacesCache ConditionalWeakTable[Type, []Type] = ConditionalWeakTable[Type, []Type]()

    // Only members enumerated from the weak key enter this cache. A foreign request's
    // module or generic arguments must not become rooted through a live host type (#5038).
    private let metadataDefinitions ConditionalWeakTable[
        Type,
        ConcurrentDictionary[(Token int32, Flags BindingFlags, Kind MemberTypes, Name string, Safe bool), MemberInfo]
    ] = ConditionalWeakTable[
        Type,
        ConcurrentDictionary[(Token int32, Flags BindingFlags, Kind MemberTypes, Name string, Safe bool), MemberInfo]
    ]()

    /// Finds a member on an open declaring type without changing the caller's reflection view.
    /// @param type The target declaring type.
    /// @param member The member whose module and metadata token identify the declaration.
    /// @param flags The original enumeration flags.
    /// @param safeEnumeration Whether to use the signature-filtered member enumeration.
    /// @returns The matching declaration, or `nil`.
    internal func FindMetadataDefinition(
        type Type,
        member MemberInfo,
        flags BindingFlags,
        safeEnumeration bool = false
    ) MemberInfo? {
        CompilationMeasurements.Count("metadata.definition-requests")
        var token int32
        var module Module
        try {
            token = member.MetadataToken
            module = member.Module
        } catch (exception Exception) when exception is InvalidOperationException ||
            exception is NotSupportedException {
            // An empty original enumeration never asked a tokenless member for its identity.
            CompilationMeasurements.Count("metadata.definition-scans")
            for candidate in EnumerateMetadataDefinitions(type, member, flags, safeEnumeration) {
                CompilationMeasurements.Count("metadata.definition-members")
                if candidate.MetadataToken == member.MetadataToken && object.ReferenceEquals(
                    candidate.Module,
                    member.Module
                ) {
                    return candidate
                }
            }
            return nil
        }
        let kind = member.MemberType
        let name = if member is MethodBase {
            string.Empty
        } else {
            member.Name
        }
        let cache = metadataDefinitions.GetValue(
            type,
            (_ Type) -> ConcurrentDictionary[
                (Token int32, Flags BindingFlags, Kind MemberTypes, Name string, Safe bool),
                MemberInfo
            ]()
        )
        let key = (token, flags, kind, name, safeEnumeration)
        if cache.TryGetValue(key, out var cached) && object.ReferenceEquals(cached.Module, module) {
            return cached
        }
        CompilationMeasurements.Count("metadata.definition-scans")
        for candidate in EnumerateMetadataDefinitions(type, member, flags, safeEnumeration) {
            CompilationMeasurements.Count("metadata.definition-members")
            if candidate.MetadataToken == token && object.ReferenceEquals(candidate.Module, module) {
                if cache.TryAdd(key, candidate) {
                    CompilationMeasurements.Count("metadata.definition-cache-entries")
                }
                return candidate
            }
        }
        return nil
    }

    private func EnumerateMetadataDefinitions(
        type Type,
        member MemberInfo,
        flags BindingFlags,
        safeEnumeration bool
    ) IEnumerable[MemberInfo] -> switch member {
        case _ is ConstructorInfo: if safeEnumeration {
            SafeGetConstructors(type, flags)
        } else {
            type.GetConstructors(flags)
        }
        case _ is MethodInfo: if safeEnumeration {
            SafeGetMethods(type, flags)
        } else {
            type.GetMethods(flags)
        }
        default: type.GetMember(member.Name, member.MemberType, flags)
    }

    /// Returns whether two (cref:Type)s refer to the same logical CLR
    /// type, regardless of which reflection context produced them. Two types
    /// are considered the same when their (cref:Type.FullName)s match.
    /// @remarks Issue #504-reopen: constructed generics, arrays, by-ref, and pointer
    /// types are compared <em>structurally</em> (definition + element / type
    /// arguments) rather than by raw (cref:Type.FullName). The
    /// FullName of a constructed generic (e.g. `Nullable<bool>`)
    /// embeds the assembly-qualified name of every type argument
    /// (`System.Boolean, System.Private.CoreLib, …`), and those
    /// assembly identities differ across reflection contexts — the host
    /// runtime's `System.Boolean` lives in `System.Private.CoreLib`
    /// while the MetadataLoadContext-loaded reference-assembly
    /// `System.Boolean` lives in the `System.Runtime` facade — so
    /// the embedded strings diverge even when the two types denote the same
    /// logical CLR shape. Recursing on the type definition plus each leaf
    /// type argument keeps the cross-context identity check correct, since
    /// leaf non-generic types have an assembly-independent
    /// (cref:Type.FullName).
    /// @param a First type.
    /// @param b Second type.
    /// @returns `true` when both types are non-null and denote the same logical CLR type.
    func AreSame(a Type?, b Type?) bool -> a.IsSameAs(b)

    /// Returns whether [`source`](paramref) is assignable to
    /// [`target`](paramref) when the two types may live in different
    /// reflection contexts. Falls back to identity-by-name and special-cases
    /// `System.Object` as universally assignable.
    /// @param target Target parameter type.
    /// @param source Source argument type.
    /// @returns `true` when an assignment is permissible.
    func IsAssignableByName(target Type?, source Type?) bool {
        if target == nil || source == nil {
            return false
        }
        if AreSame(target, source) {
            return true
        }
        if string.Equals(target.FullName, "System.Object", StringComparison.Ordinal) {
            return true
        }
        if target.IsGenericType &&
            source.IsGenericType &&
            AreSame(target.GetGenericTypeDefinition(), source.GetGenericTypeDefinition()) &&
            GenericArgumentsAreAssignable(target, source) {
            return true
        }
        // Same-context fast path covers inheritance / interfaces.
        if object.ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType() {
            try {
                // A TypeBuilderInstantiation target always throws from IsAssignableFrom;
                // go straight to the by-name walk below.
                if !IsTypeBuilderInstantiation(target) && target.IsAssignableFrom(source) {
                    return true
                }
                // Issue #908: do NOT treat a `false` here as authoritative. The
                // `target.GetType() == source.GetType()` guard also fires when the
                // two types are the same reflection-kind (e.g. both
                // MetadataLoadContext RoTypes) but originate from *different*
                // context instances — across two separate compilations sharing a
                // process. There, IsAssignableFrom compares base types by
                // reference and returns a spurious `false` even for a genuine
                // upcast (e.g. MemoryStream → Stream). Fall through to the
                // by-name walk, which is reference-context independent and only
                // ever returns true for real inheritance / implementation.

            } catch (ex Exception) when ex is InvalidOperationException || ex is NotSupportedException {
                // InvalidOperationException: MLC types throw for some cross-context paths.
                // NotSupportedException: a TypeBuilderInstantiation (generic instantiation of
                // a type still being defined by emit's TypeBuilders) throws from
                // IsAssignableFrom. In both cases fall through to the reference-context-
                // independent by-name walk below (issue #2135).

            }
        }
        // Cross-context fallback (#610): when the same-context fast path
        // cannot fire (live-runtime ↔ MetadataLoadContext boundary), walk
        // the source's interface set and base-type chain by name. This
        // generalizes the dedicated #570 slice-to-interface arm so ALL CLR
        // reference upcasts work across reflection contexts.
        if target.IsInterface {
            return ImplementsInterfaceByName(source, target)
        }
        // Base-class walk: check if source derives from target by comparing
        // base type full names up the chain.
        for var baseType Type? = source.BaseType; baseType != nil; baseType = baseType!!.BaseType {
            if AreSame(baseType, target) {
                return true
            }
        }
        return false
    }

    /// Returns whether [`concrete`](paramref) implements an interface
    /// equivalent to [`targetInterface`](paramref) by name and generic-
    /// argument-name. Generalizes the cross-context (live-runtime vs.
    /// MetadataLoadContext) interface walk that (cref:IsAssignableByName)'s
    /// same-context fast path cannot resolve. Used by #570's slice-conversions-
    /// equal-array-conversions rule and reusable for any future cross-context
    /// "does X implement Y?" probe.
    /// @param concrete The candidate concrete type whose interfaces to walk.
    /// @param targetInterface The interface type to match (live or MLC).
    /// @returns `true` when the concrete type implements an
    /// interface whose full-name and generic argument full-names equal the target.
    func ImplementsInterfaceByName(concrete Type?, targetInterface Type?) bool {
        if concrete == nil || targetInterface == nil {
            return false
        }
        for iface in SafeGetInterfaces(concrete) {
            if InterfaceMatchesByName(iface, targetInterface) {
                return true
            }
        }
        return false
    }

    /// Returns whether [`type`](paramref) is a CLR delegate type, i.e. it
    /// (transitively) derives from `System.MulticastDelegate` /
    /// `System.Delegate`. Walks the base-type chain by name so it is safe
    /// for types loaded through a (cref:System.Reflection.MetadataLoadContext),
    /// where `typeof(Delegate).IsAssignableFrom` would throw.
    /// @param type The candidate type.
    /// @returns `true` when the type is a delegate type.
    func IsDelegateType(type Type?) bool {
        for var t Type? = type; t != nil; t = t!!.BaseType {
            let fullName = t.FullName
            if string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal) || string.Equals(
                fullName,
                "System.Delegate",
                StringComparison.Ordinal
            ) {
                return true
            }
        }
        return false
    }

    /// The `System.Reflection.Emit.TypeBuilderInstantiation` runtime type, or `nil`
    /// when this runtime does not expose it by that name.
    private let typeBuilderInstantiationType Type? = typeof(TypeBuilder).Assembly.GetType(
        "System.Reflection.Emit.TypeBuilderInstantiation",
        false
    )

    /// The assembly that holds the `System.Reflection.MetadataLoadContext` reflection objects.
    private let metadataLoadContextAssembly Assembly = typeof(MetadataLoadContext).Assembly

    /// Whether [`type`](paramref) is a `System.Reflection.Emit.TypeBuilderInstantiation`: a
    /// generic instantiation closed over a type that is still being defined by emit.
    /// @remarks That type answers `GetMethods`, `GetMethodImpl`, `GetInterfaces`,
    /// `IsSubclassOf`, `IsByRefLike` and `IsAssignableFrom` by throwing
    /// (cref:NotSupportedException). Probes test this first so the common case does
    /// not pay for a thrown and caught exception. The probes keep their `catch` as
    /// the last resort, so a runtime that hides the type only loses the fast path.
    /// @param type The type to inspect.
    /// @returns `true` when the type is a `TypeBuilderInstantiation`.
    internal func IsTypeBuilderInstantiation(type Type?) bool -> type != nil &&
        typeBuilderInstantiationType != nil &&
        type.GetType() == typeBuilderInstantiationType

    /// The `System.Reflection.Emit.SymbolType` runtime type (an array, pointer or by-ref
    /// over a type that is still being defined), or `nil` when this runtime does not
    /// expose it by that name.
    private let symbolTypeType Type? = typeof(TypeBuilder).Assembly.GetType("System.Reflection.Emit.SymbolType", false)

    /// Whether [`type`](paramref) is a type that reflection emit is still defining: a
    /// `TypeBuilder`, an `EnumBuilder`, a `GenericTypeParameterBuilder`, or a
    /// `SymbolType` (an array, pointer or by-ref over one of those).
    /// @remarks Those types answer `IsByRefLike` by throwing (cref:NotSupportedException)
    /// until they are created. Probes test this first and keep their `catch` as the last
    /// resort, so a runtime that hides `SymbolType` only loses the fast path.
    /// @param type The type to inspect.
    /// @returns `true` when the type is an unfinished emit type.
    internal func IsUnfinishedEmitType(type Type?) bool -> type is TypeBuilder ||
        type is EnumBuilder ||
        type is GenericTypeParameterBuilder ||
        (symbolTypeType != nil && type != nil && type.GetType() == symbolTypeType)

    /// Whether [`member`](paramref) was produced by a `System.Reflection.MetadataLoadContext`.
    /// @param member The reflection object to inspect.
    /// @returns `true` when the object belongs to the metadata load context assembly.
    internal func IsMetadataLoadContextMember(member MemberInfo?) bool -> member != nil && object.ReferenceEquals(
        member.GetType().Assembly,
        metadataLoadContextAssembly
    )

    /// Whether `definition.MakeGenericType(arguments)` is certain to be rejected
    /// because a `MetadataLoadContext` definition was handed a host runtime type.
    /// @remarks `RoDefinitionType.MakeGenericType` accepts only arguments loaded by its own
    /// context and throws (cref:ArgumentException) for any host `RuntimeType`. Callers that
    /// already treat the rejection as "no closure" test this first. A `false` answer does
    /// not promise success: other contexts and constraint violations still throw, and
    /// callers keep their `catch` for those.
    /// @param definition The generic type definition to close.
    /// @param arguments The type arguments to close it over.
    /// @returns `true` when the closure is certain to be rejected.
    internal func MakeGenericTypeIsRejectedAcrossContexts(definition Type?, arguments[]Type) bool {
        if !IsMetadataLoadContextMember(definition) {
            return false
        }
        for argument in arguments {
            if argument.IsRuntimeProvidedType() {
                return true
            }
        }
        return false
    }

    /// Issue #367: returns whether [`type`](paramref) is a CLR by-ref-like
    /// (`ref struct`) type — one carrying
    /// `System.Runtime.CompilerServices.IsByRefLikeAttribute`, such as
    /// `System.Span<T>`, `System.ReadOnlySpan<T>`, or
    /// `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler`.
    /// Such values are stack-only: they cannot be boxed, stored in fields of a
    /// non-ref-struct, captured by closures, hoisted into async/iterator state
    /// machines, or used as generic type arguments. (cref:Type.IsByRefLike)
    /// is honoured by (cref:System.Reflection.MetadataLoadContext), so this
    /// works for types loaded from reference assemblies. Guards against the
    /// metadata-load failures described on (cref:IsMetadataLoadFailure).
    /// @param type The candidate type.
    /// @returns `true` when the type is a by-ref-like value type.
    func IsByRefLike(type Type?) bool {
        if type == nil || IsTypeBuilderInstantiation(type) || IsUnfinishedEmitType(type) {
            return false
        }
        try {
            return type.IsByRefLike
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
    }

    /// Issue #5216: returns whether a CLR generic parameter declares `allows ref struct`
    /// (the `AllowByRefLike` flag). Only such a parameter accepts a by-ref-like type argument.
    /// @param attributes The attributes of the generic parameter.
    /// @returns `true` when the parameter admits by-ref-like type arguments.
    internal func AllowsByRefLikeArgument(attributes GenericParameterAttributes) bool {
        return (attributes & GenericParameterAttributes.AllowByRefLike) != 0
    }

    /// Issue #5216: returns whether the generic parameter at [`index`](paramref) of an open CLR generic
    /// definition declares `allows ref struct`. A metadata-load failure answers `false`.
    /// @param openDefinition The open generic type or method definition.
    /// @param index The position of the generic parameter, in reflection order.
    /// @returns `true` when that parameter admits by-ref-like type arguments.
    internal func GenericParameterAllowsByRefLike(openDefinition Type?, index int32) bool {
        if openDefinition == nil || index < 0 {
            return false
        }
        try {
            let parameters = openDefinition.GetGenericArguments()
            return index < parameters.Length && AllowsByRefLikeArgument(parameters[index].GenericParameterAttributes)
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
    }

    /// Issue #338 (generalizing the #321 fix): determines whether an exception
    /// thrown while reflecting over a CLR member's signature is a
    /// metadata/assembly load failure. Such failures arise when a member's
    /// signature (parameter, return, property, field, or event-handler type)
    /// references a type that cannot be loaded or projected under the reference
    /// (cref:System.Reflection.MetadataLoadContext) — for example a
    /// ref-struct type or a type living in a transitive assembly that was not
    /// supplied via `/r:`. Member enumeration sites treat the offending
    /// member as absent rather than letting the throw sink the whole member set;
    /// any other exception is left to propagate. This is the single shared
    /// predicate used by every CLR member enumeration site (overload
    /// resolution, property/field/event/constructor enumeration, and the
    /// member-access binding path).
    /// @param ex The exception observed while evaluating a member.
    /// @returns Whether the exception represents a tolerable load failure.
    func IsMetadataLoadFailure(ex Exception) bool -> ex is FileNotFoundException ||
        ex is FileLoadException ||
        ex is TypeLoadException ||
        ex is BadImageFormatException ||
        ex is MissingMethodException ||
        ex is MissingMemberException ||
        ex is NotSupportedException

    /// Probes whether a member's full signature can be read without triggering a
    /// metadata-load failure (issue #338). Touching the relevant signature types
    /// (property/field/event-handler/parameter/return types) forces the
    /// (cref:System.Reflection.MetadataLoadContext) to resolve them; if
    /// any cannot be loaded the member is treated as unusable and skipped.
    /// @param member The reflected member to probe.
    /// @returns `true` when the member's signature loads cleanly.
    func CanLoadSignature(member MemberInfo?) bool {
        if member == nil {
            return false
        }
        try {
            switch member {
                case property is PropertyInfo {
                    let _ = property.PropertyType
                    for indexParameter in property.GetIndexParameters() {
                        let _ = indexParameter.ParameterType
                    }
                }
                case field is FieldInfo {
                    let _ = field.FieldType
                }
                case event is EventInfo {
                    let _ = event.EventHandlerType
                }
                case method is MethodBase {
                    for parameter in method.GetParameters() {
                        let _ = parameter.ParameterType
                    }
                    if method is MethodInfo methodInfo {
                        let _ = methodInfo.ReturnType
                    }
                }
            }
            return true
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
    }

    /// Enumerates a type's public properties tolerantly (issue #338): properties
    /// whose signature cannot be loaded under the reference context are skipped
    /// instead of sinking the whole set.
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The properties whose signatures load cleanly.
    func SafeGetProperties(type Type, flags BindingFlags)[]PropertyInfo -> SafeEnumerate[PropertyInfo](
        type,
        flags,
        (t Type) -> t.GetProperties(flags)
    )

    /// Enumerates a type's fields tolerantly (issue #338): fields whose type
    /// cannot be loaded under the reference context are skipped.
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The fields whose signatures load cleanly.
    func SafeGetFields(type Type, flags BindingFlags)[]FieldInfo -> SafeEnumerate[FieldInfo](
        type,
        flags,
        (t Type) -> t.GetFields(flags)
    )

    /// Enumerates a type's events tolerantly (issue #338): events whose handler
    /// type cannot be loaded under the reference context are skipped.
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The events whose signatures load cleanly.
    func SafeGetEvents(type Type, flags BindingFlags)[]EventInfo -> SafeEnumerate[EventInfo](
        type,
        flags,
        (t Type) -> t.GetEvents(flags)
    )

    /// Enumerates a type's constructors tolerantly (issue #338): constructors
    /// whose parameter signature cannot be loaded under the reference context
    /// are skipped instead of sinking the whole overload set.
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The constructors whose signatures load cleanly.
    func SafeGetConstructors(type Type, flags BindingFlags)[]ConstructorInfo -> SafeEnumerate[ConstructorInfo](
        type,
        flags,
        (t Type) -> t.GetConstructors(flags)
    )

    /// Enumerates a type's methods tolerantly (issue #338): methods whose
    /// parameter or return signature cannot be loaded under the reference
    /// context are skipped instead of sinking the whole candidate set.
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The methods whose signatures load cleanly.
    func SafeGetMethods(type Type, flags BindingFlags)[]MethodInfo -> SafeEnumerate[MethodInfo](
        type,
        flags,
        (t Type) -> t.GetMethods(flags)
    )

    /// Matches a G# emitted member spelling to its original CLR metadata name.
    /// Exact CLR names win; sanitized names use the same collision-aware
    /// normalization as cs2gs.
    /// @param member The CLR member candidate.
    /// @param emittedName The G# source spelling.
    /// @returns `true` when the names identify the same member.
    func EmittedMemberNameMatches(member MemberInfo, emittedName string) bool {
        if string.Equals(member.Name, emittedName, StringComparison.Ordinal) {
            return true
        }
        let declaringType Type? = member.DeclaringType
        if declaringType == nil {
            return false
        }
        const allMembers = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
        let scopeNames = SafeGetProperties(declaringType, allMembers)
            .Select((candidate PropertyInfo) -> candidate.Name)
            .Concat(SafeGetFields(declaringType, allMembers).Select((candidate FieldInfo) -> candidate.Name))
            .Concat(SafeGetEvents(declaringType, allMembers).Select((candidate EventInfo) -> candidate.Name))
            .Concat(SafeGetMethods(declaringType, allMembers).Select((candidate MethodInfo) -> candidate.Name))
        return string.Equals(
            SyntaxFacts.GetEmittedIdentifier(member.Name, IdentifierNameContext.General, scopeNames),
            emittedName,
            StringComparison.Ordinal
        )
    }

    /// Looks up a single property by name tolerantly (issue #338). When the
    /// requested member — or an unrelated sibling probed during the lookup —
    /// references an unloadable type, the direct lookup is retried via a guarded
    /// enumeration that skips only the offending members.
    /// @param type The type to search.
    /// @param name The property name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching property, or `null` when none is usable.
    func SafeGetProperty(type Type, name string, flags BindingFlags) PropertyInfo? -> SafeGetMember(
        type,
        name,
        flags,
        (t Type, f BindingFlags) -> t.GetProperty(name, f),
        SafeGetProperties
    )

    /// Looks up a single field by name tolerantly (issue #338). See
    /// (cref:SafeGetProperty) for the tolerance contract.
    /// @param type The type to search.
    /// @param name The field name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching field, or `null` when none is usable.
    func SafeGetField(type Type?, name string, flags BindingFlags) FieldInfo? -> SafeGetMember(
        type,
        name,
        flags,
        (t Type, f BindingFlags) -> t.GetField(name, f),
        SafeGetFields
    )

    /// Issue #1582: looks up an instance FIELD named [`name`](paramref)
    /// inherited from [`type`](paramref) (a CLR/metadata base class),
    /// walking the CLR base chain and including non-public members whose
    /// accessibility is visible to a derived type — `public`,
    /// `protected` (Family), or `protected internal`
    /// (FamilyOrAssembly), plus friend-visible `internal` and
    /// `internal` when requested. Private and `private protected`
    /// fields are excluded,
    /// mirroring the accessibility rule used for inherited CLR methods in
    /// `CollectBaseClrMethodCandidates`. Reflection's
    /// (cref:Type.GetField(string, BindingFlags)) already surfaces
    /// inherited (non-`DeclaredOnly`) members, so a single tolerant probe
    /// covers the whole chain.
    /// @param type The CLR base type to search (its base chain is walked by reflection).
    /// @param name The field name.
    /// @param canAccessInternalsOf Optional predicate that decides friend-internal access for the returned
    /// field's declaring type.
    /// @returns The matching visible inherited field, or `null` when none is found.
    func SafeGetInheritedInstanceField(
        type Type?,
        name string,
        canAccessInternalsOf((Type?) -> bool)? = nil
    ) FieldInfo? {
        if type == nil {
            return nil
        }
        let field = SafeGetField(type, name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
        let includeInternal = canAccessInternalsOf?(field?.DeclaringType) == true
        if ClrMemberVisibility.IsVisibleFromDerived(field, includeInternal) {
            return field
        }
        return nil
    }

    /// Issue #1582: looks up a non-indexer instance PROPERTY named
    /// [`name`](paramref) inherited from [`type`](paramref) (a
    /// CLR/metadata base class), walking the CLR base chain and including
    /// members with at least one accessor whose accessibility is visible to a
    /// derived type (`public`, `protected`, or
    /// `protected internal`), plus friend-visible `internal` and
    /// `internal` when requested. Private and `private protected`
    /// accessors are excluded. See
    /// (cref:SafeGetInheritedInstanceField) for the accessibility rule.
    /// @param type The CLR base type to search (its base chain is walked by reflection).
    /// @param name The property name.
    /// @param canAccessInternalsOf Optional predicate that decides friend-internal access for the returned
    /// property's declaring type.
    /// @returns The matching visible inherited property, or `null` when none is found.
    func SafeGetInheritedInstanceProperty(
        type Type?,
        name string,
        canAccessInternalsOf((Type?) -> bool)? = nil
    ) PropertyInfo? {
        if type == nil {
            return nil
        }
        let property PropertyInfo? = SafeGetProperty(
            type,
            name,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        if property == nil || property.GetIndexParameters().Length != 0 {
            return nil
        }
        let includeInternal = canAccessInternalsOf?(property.DeclaringType) == true
        if ClrMemberVisibility.GetDerivedVisibleGetter(property, includeInternal) != nil ||
            ClrMemberVisibility.GetDerivedVisibleSetter(property, includeInternal) != nil {
            return property
        }
        return nil
    }

    /// Looks up a single event by name tolerantly (issue #338). See
    /// (cref:SafeGetProperty) for the tolerance contract.
    /// @param type The type to search.
    /// @param name The event name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching event, or `null` when none is usable.
    func SafeGetEvent(type Type, name string, flags BindingFlags) EventInfo? -> SafeGetMember(
        type,
        name,
        flags,
        (t Type, f BindingFlags) -> t.GetEvent(name, f),
        SafeGetEvents
    )

    /// Looks up an event by name across an interface and its inherited interfaces.
    /// @param type The interface type to search.
    /// @param name The event name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching event, or `null` when none is found.
    func SafeGetEventIncludingInterfaces(type Type?, name string, flags BindingFlags) EventInfo? {
        // Issue #4932: a nil type finds nothing, as in the C#; do not assert it.
        if type == nil {
            return nil
        }
        let direct EventInfo? = SafeGetEvent(type, name, flags)
        if direct != nil {
            return direct
        }
        for iface in SafeGetInterfaces(type) {
            let inherited EventInfo? = SafeGetEvent(iface, name, flags)
            if inherited != nil {
                return inherited
            }
        }
        return nil
    }

    /// Issues #529 / #572: looks up a property by name, walking the transitive
    /// interface hierarchy. For interface types this surfaces inherited
    /// interface members; for concrete classes this surfaces default
    /// interface properties (DIMs) that the class does not override.
    /// CLR reflection does not include inherited interface members in
    /// (cref:Type.GetProperties(BindingFlags)), so this helper
    /// explicitly walks (cref:Type.GetInterfaces()).
    /// @param type The type to search.
    /// @param name The property name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching property, or `null` when none is found.
    func SafeGetPropertyIncludingInterfaces(type Type?, name string, flags BindingFlags) PropertyInfo? {
        // Issue #4932: a nil type finds nothing, as in the C#; do not assert it.
        if type == nil {
            return nil
        }
        let direct PropertyInfo? = SafeGetProperty(type, name, flags)
        if direct != nil {
            return direct
        }
        for iface in SafeGetInterfaces(type) {
            let inherited PropertyInfo? = SafeGetProperty(iface, name, flags)
            if inherited != nil {
                return inherited
            }
        }
        return nil
    }

    /// Issue #529: looks up a field by name, walking the transitive
    /// interface hierarchy when [`type`](paramref) is an interface.
    /// @param type The type to search.
    /// @param name The field name.
    /// @param flags The binding flags controlling visibility.
    /// @returns The matching field, or `null` when none is found.
    func SafeGetFieldIncludingInterfaces(type Type?, name string, flags BindingFlags) FieldInfo? {
        let direct FieldInfo? = SafeGetField(type, name, flags)
        if direct != nil {
            return direct
        }
        if type == nil || !type.IsInterface {
            return nil
        }
        for iface in SafeGetInterfaces(type) {
            let inherited FieldInfo? = SafeGetField(iface, name, flags)
            if inherited != nil {
                return inherited
            }
        }
        return nil
    }

    /// Issues #529 / #572: enumerates methods including those declared on
    /// transitive base interfaces. For interface types this surfaces
    /// inherited interface members; for concrete classes this surfaces
    /// default interface methods (DIMs) that the class does not override.
    /// Methods from interfaces that are hidden by a same-name-and-parameter-types
    /// method already present (on the class or a more-derived interface) are
    /// excluded (mirrors C# hiding rules).
    /// @param type The type to enumerate.
    /// @param flags The binding flags controlling visibility.
    /// @returns The methods whose signatures load cleanly.
    func SafeGetMethodsIncludingInterfaces(type Type?, flags BindingFlags)[]MethodInfo {
        // Issue #4932: a nil type has no methods, as in the C#; do not assert it.
        if type == nil {
            return Array.Empty[MethodInfo]()
        }
        let direct = SafeGetMethods(type, flags)
        let interfaces = SafeGetInterfaces(type)
        if interfaces.Length == 0 {
            return direct
        }
        let all = List[MethodInfo](direct)
        for iface in interfaces {
            for m in SafeGetMethods(iface, flags) {
                if !IsHiddenByExisting(all, m) {
                    all.Add(m)
                }
            }
        }
        return all.ToArray()
    }

    /// Issue #2291: safely determines whether a property accessor OVERRIDES a
    /// base declaration, tolerating a (cref:System.Reflection.MetadataLoadContext)
    /// that does not support (cref:MethodInfo.GetBaseDefinition) (it
    /// throws (cref:NotSupportedException) unconditionally for every
    /// virtual method, not just an unresolvable one). A genuine C# record's
    /// `EqualityContract` property getter is `virtual` (so a derived
    /// record can widen it), which is exactly the shape that first surfaced
    /// this: building a semantic aggregate for an imported record under an
    /// MLC-backed resolver must not crash just because ONE property happens to
    /// be virtual. Falls back to "not an override" on failure — the same
    /// conservative default every other MLC-safe query in this file uses.
    /// @param accessor The property accessor (getter or setter) to probe.
    /// @returns `true` when the accessor is confirmed to override a base declaration.
    func SafeIsOverride(accessor MethodInfo?) bool {
        if accessor == nil {
            return false
        }
        // MetadataLoadContext methods throw from GetBaseDefinition unconditionally (#2863),
        // so read the override bit from the metadata attributes without raising first.
        if IsMetadataLoadContextMember(accessor) {
            return IsOverrideFromMetadataAttributes(accessor)
        }
        try {
            return accessor.GetBaseDefinition() != accessor
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            // Issue #2863: MetadataLoadContext does not implement
            // GetBaseDefinition() at all — it throws NotSupportedException for
            // EVERY method, which IsMetadataLoadFailure classifies as a load
            // failure. Returning the conservative "not an override" here made
            // every imported member look like a fresh declaration, which in
            // turn made every virtual imported property look abstract
            // (PropertySymbol.IsAbstract) and every imported type that had one
            // report GS0386 at its concrete use sites. Read the override bit
            // straight out of the metadata instead: a method that introduces a
            // new virtual slot carries `newslot`, while one that overrides an
            // inherited slot does not. Interface implementations are emitted
            // `virtual final newslot`, so they correctly stay non-overrides.
            return IsOverrideFromMetadataAttributes(accessor)
        }
    }

    /// Issue #1181: collects the transitive closure of imported/BCL base
    /// interfaces declared on [`interfaceSymbol`](paramref) or on any of
    /// its user base interfaces. A user interface
    /// `interface IBox : System.IDisposable` records `IDisposable` in
    /// (cref:InterfaceSymbol.BaseClrInterfaces); this walk surfaces that
    /// CLR interface plus every interface IT extends (e.g.
    /// `IEnumerable<T>` → `IEnumerable`) so the binder and the
    /// language server can project the inherited CLR members onto an
    /// `IBox`-typed receiver. The result is deduplicated structurally via
    /// (cref:ClrTypeUtilities.AreSame) (FullName-based, robust across
    /// metadata-load contexts).
    /// @param interfaceSymbol The user interface whose imported base interfaces to collect.
    /// @returns The transitive CLR base interface (cref:Type)s, each appearing once.
    func GetTransitiveClrBaseInterfaces(interfaceSymbol InterfaceSymbol?) IReadOnlyList[Type] {
        if interfaceSymbol == nil {
            return Array.Empty[Type]()
        }
        let result = List[Type]()
        let AddClr = func (clr Type?) {
            if clr == nil || !clr.IsInterface {
                return
            }
            for existing in result {
                if AreSame(existing, clr) {
                    return
                }
            }
            result.Add(clr)
            for transitive in SafeGetInterfaces(clr) {
                AddClr(transitive)
            }
        }
        // A user base interface may itself extend a CLR interface, so walk the
        // whole user interface hierarchy (this-first) and harvest each level's
        // imported base interfaces.
        for iface in interfaceSymbol.SelfAndAllBaseInterfaces() {
            if iface.BaseClrInterfaces.IsDefaultOrEmpty {
                continue
            }
            for clrBase in iface.BaseClrInterfaces {
                if clrBase?.ClrType is Type clrType {
                    AddClr(clrType)
                }
            }
        }
        return result
    }

    internal func SafeGetInterfaces(type Type?)[]Type {
        if type == nil {
            return Array.Empty[Type]()
        }
        // Some MetadataLoadContext Type implementations return only direct
        // interfaces. Complete the graph explicitly and include interfaces
        // inherited through base classes, then cache that canonical result.
        return interfacesCache.GetValue(
            type,
            (t Type) -> {
                let result = List[Type]()
                let visited = HashSet[Type]()
                let Visit = func (current Type?) {
                    if current == nil || !visited.Add(current) {
                        return
                    }
                    var direct[]Type
                    try {
                        direct = if IsTypeBuilderInstantiation(current) {
                            Array.Empty[Type]()
                        } else {
                            current.GetInterfaces()
                        }
                    } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                        direct = Array.Empty[Type]()
                    }
                    for iface in direct {
                        if !result.Contains(iface) {
                            result.Add(iface)
                        }
                        Visit(iface)
                    }
                    try {
                        if current.BaseType is {} baseType {
                            Visit(baseType)
                        }
                    } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                        // A partial graph is still useful to callers.

                    }
                }
                Visit(t)
                return result.ToArray()
            }
        )
    }

    /// Enumerates [`type`](paramref) followed by every interface it implements,
    /// using the guarded transitive walk of (cref:SafeGetInterfaces).
    /// @param type The starting CLR type.
    /// @param includeSelfWhenClass When false, [`type`](paramref) itself is yielded only if it is an interface.
    /// @returns The type (per the self policy) and then its interfaces in walk order.
    internal func EnumerateSelfAndInterfaces(type Type, includeSelfWhenClass bool) sequence[Type] {
        if includeSelfWhenClass || type.IsInterface {
            yield type
        }
        for implemented in SafeGetInterfaces(type) {
            yield implemented
        }
    }

    @return: NotNullIfNotNull("type")
    internal func RemapHostCoreTypeToContext(type Type?, contextObject Type?) Type? {
        if type == nil || contextObject == nil || object.ReferenceEquals(
            contextObject.Assembly,
            typeof(object).Assembly
        ) {
            return type
        }
        if type.IsByRef {
            return Invariant.Required(
                RemapHostCoreTypeToContext(type.GetElementType(), contextObject),
                "a by-ref CLR type has an element type",
                expression: "RemapHostCoreTypeToContext(type.GetElementType(), contextObject)"
            )
                .MakeByRefType()
        }
        if type.IsPointer {
            return Invariant.Required(
                RemapHostCoreTypeToContext(type.GetElementType(), contextObject),
                "a pointer CLR type has an element type",
                expression: "RemapHostCoreTypeToContext(type.GetElementType(), contextObject)"
            )
                .MakePointerType()
        }
        if type.IsArray {
            let element = Invariant.Required(
                RemapHostCoreTypeToContext(type.GetElementType(), contextObject),
                "an array CLR type has an element type",
                expression: "RemapHostCoreTypeToContext(type.GetElementType(), contextObject)"
            )
            return if type.IsSZArray {
                element.MakeArrayType()
            } else {
                element.MakeArrayType(type.GetArrayRank())
            }
        }
        if type.IsConstructedGenericType && object.ReferenceEquals(
            type.GetGenericTypeDefinition().Assembly,
            typeof(object).Assembly
        ) {
            let openName string? = type.GetGenericTypeDefinition().FullName
            let open_ Type? = if openName == nil {
                default(Type?)
            } else {
                contextObject.Assembly.GetType(openName, throwOnError: false)
            }
            if open_ != nil {
                let arguments = type.GetGenericArguments()
                let remappedArguments = [arguments.Length]Type
                for var i = 0; i < arguments.Length; i++ {
                    remappedArguments[i] = RemapHostCoreTypeToContext(arguments[i], contextObject)!!
                }
                return open_.MakeGenericType(remappedArguments)
            }
        }
        if object.ReferenceEquals(type.Assembly, typeof(object).Assembly) {
            return if type.FullName is {} fullName {
                contextObject.Assembly.GetType(fullName, throwOnError: false) ?? type
            } else {
                type
            }
        }
        return type
    }

    /// Removes every entry from the process-wide CLR member-enumeration caches
    /// (`interfacesCache` and the per-member-kind caches backing
    /// (cref:SafeEnumerate{TMember})). Called by
    /// (cref:ReferenceResolver.Dispose) alongside the other
    /// process-wide symbol caches (#1622) so entries keyed on a disposed
    /// (cref:System.Reflection.MetadataLoadContext)'s (cref:Type)
    /// instances do not pin that context's memory for the life of the process.
    internal func ClearCache() {
        interfacesCache = ConditionalWeakTable[Type, []Type]()
        MemberCache[MethodInfo].Cache.Clear()
        MemberCache[PropertyInfo].Cache.Clear()
        MemberCache[FieldInfo].Cache.Clear()
        MemberCache[EventInfo].Cache.Clear()
        MemberCache[ConstructorInfo].Cache.Clear()
    }

    /// Issue #2863: decides whether [`accessor`](paramref) overrides an
    /// inherited virtual slot using only (cref:MethodBase.Attributes),
    /// which every metadata backend — including
    /// `MetadataLoadContext` — supports. A method that introduces a new
    /// virtual slot is emitted `virtual newslot`; a method that overrides
    /// an inherited one is emitted `virtual` without `newslot`.
    /// @param accessor The method to classify.
    /// @returns `true` when the method reuses an inherited virtual slot.
    private func IsOverrideFromMetadataAttributes(accessor MethodInfo) bool {
        try {
            let attributes = accessor.Attributes
            return (attributes & MethodAttributes.Virtual) != 0 && (attributes & MethodAttributes.NewSlot) == 0
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
    }

    private func GenericArgumentsAreAssignable(target Type, source Type) bool {
        let parameters = target.GetGenericTypeDefinition().GetGenericArguments()
        let targetArguments = target.GetGenericArguments()
        let sourceArguments = source.GetGenericArguments()
        for var i = 0; i < parameters.Length; i++ {
            if AreSame(targetArguments[i], sourceArguments[i]) {
                continue
            }
            if targetArguments[i].IsValueType || sourceArguments[i].IsValueType {
                return false
            }
            let variance = parameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            if variance == GenericParameterAttributes.Covariant &&
                IsAssignableByName(targetArguments[i], sourceArguments[i]) {
                continue
            }
            if variance == GenericParameterAttributes.Contravariant &&
                IsAssignableByName(sourceArguments[i], targetArguments[i]) {
                continue
            }
            return false
        }
        return true
    }

    private func IsConstructedGenericWithTypeBuilderArgument(type Type?) bool {
        return type != nil && type.IsConstructedGenericType && ContainsTypeBuilderGenericArgument(type)
    }

    private func GetConstructedGenericMethod(type Type, openMethod MethodInfo) MethodInfo {
        let declaringType Type? = openMethod.DeclaringType
        if declaringType == nil || !declaringType.IsGenericType {
            return openMethod
        }
        let declaringDefinition = declaringType.GetGenericTypeDefinition()
        var methodDefinition = openMethod
        if !declaringType.IsGenericTypeDefinition {
            var matchingDefinition MethodInfo? = nil
            for method in declaringDefinition.GetMethods() {
                if method.Module == openMethod.Module && method.MetadataToken == openMethod.MetadataToken {
                    matchingDefinition = method
                    break
                }
            }
            methodDefinition = Invariant.Required(
                matchingDefinition,
                "a constructed generic method has a matching definition",
                expression: "matchingDefinition"
            )
        }
        let openType = type.GetGenericTypeDefinition()
        let constructedDeclaringType = SubstituteGenericTypeArguments(
            declaringType,
            openType.GetGenericArguments(),
            type.GetGenericArguments()
        )
        return TypeBuilder.GetMethod(constructedDeclaringType, methodDefinition)
    }

    private func SubstituteGenericTypeArguments(type Type, openTypeArguments[]Type, typeArguments[]Type) Type {
        if type.IsGenericParameter {
            let position = Array.IndexOf(openTypeArguments, type)
            return if position >= 0 {
                typeArguments[position]
            } else {
                type
            }
        }
        if type.HasElementType {
            let elementType = SubstituteGenericTypeArguments(
                Invariant.Required(
                    type.GetElementType(),
                    "an element-bearing CLR type has an element type",
                    expression: "type.GetElementType()"
                ),
                openTypeArguments,
                typeArguments
            )
            if type.IsByRef {
                return elementType.MakeByRefType()
            }
            if type.IsPointer {
                return elementType.MakePointerType()
            }
            return if type.IsSZArray {
                elementType.MakeArrayType()
            } else {
                elementType.MakeArrayType(type.GetArrayRank())
            }
        }
        if !type.IsGenericType {
            return type
        }
        let genericArguments = type.GetGenericArguments()
        let substitutedArguments = [genericArguments.Length]Type
        for var i = 0; i < genericArguments.Length; i++ {
            substitutedArguments[i] = SubstituteGenericTypeArguments(
                genericArguments[i],
                openTypeArguments,
                typeArguments
            )
        }
        return type.GetGenericTypeDefinition().MakeGenericType(substitutedArguments)
    }

    private func FindOpenGenericMethod(
        openType Type,
        name string,
        parameterTypes[]Type,
        openTypeArguments[]Type,
        typeArguments[]Type
    ) MethodInfo? {
        let matches = List[MethodInfo](2)
        for method in openType.GetMethods() {
            if !string.Equals(method.Name, name, StringComparison.Ordinal) {
                continue
            }
            let parameters = method.GetParameters()
            if parameters.Length != parameterTypes.Length {
                continue
            }
            var parametersMatch = true
            for var i = 0; i < parameters.Length; i++ {
                parametersMatch &= MatchesConstructedParameterType(
                    parameters[i].ParameterType,
                    parameterTypes[i],
                    openTypeArguments,
                    typeArguments
                )
            }
            if parametersMatch {
                matches.Add(method)
                if matches.Count == 2 {
                    break
                }
            }
        }
        return switch matches.Count {
            case 0: default(MethodInfo?)
            case 1: matches[0]
            default: throw AmbiguousMatchException()
        }
    }

    private func MatchesConstructedParameterType(
        $open Type?,
        constructed Type?,
        openTypeArguments[]Type,
        typeArguments[]Type
    ) bool {
        if $open == nil || constructed == nil {
            return $open == nil && constructed == nil
        }
        if $open.IsGenericParameter {
            let position = Array.IndexOf(openTypeArguments, $open)
            if position >= 0 {
                return constructed == typeArguments[position]
            }
        }
        if $open.IsByRef || constructed.IsByRef {
            return $open.IsByRef &&
                constructed.IsByRef &&
                MatchesConstructedParameterType(
                $open.GetElementType(),
                constructed.GetElementType(),
                openTypeArguments,
                typeArguments
            )
        }
        if $open.IsPointer || constructed.IsPointer {
            return $open.IsPointer &&
                constructed.IsPointer &&
                MatchesConstructedParameterType(
                $open.GetElementType(),
                constructed.GetElementType(),
                openTypeArguments,
                typeArguments
            )
        }
        if $open.IsArray || constructed.IsArray {
            return $open.IsArray &&
                constructed.IsArray &&
                $open.IsSZArray == constructed.IsSZArray &&
                $open.GetArrayRank() == constructed.GetArrayRank() &&
                MatchesConstructedParameterType(
                $open.GetElementType(),
                constructed.GetElementType(),
                openTypeArguments,
                typeArguments
            )
        }
        if $open.IsConstructedGenericType || constructed.IsConstructedGenericType {
            if !$open.IsConstructedGenericType ||
                !constructed.IsConstructedGenericType ||
                $open.GetGenericTypeDefinition() != constructed.GetGenericTypeDefinition() {
                return false
            }
            let openArguments = $open.GetGenericArguments()
            let constructedArguments = constructed.GetGenericArguments()
            if openArguments.Length != constructedArguments.Length {
                return false
            }
            for var i = 0; i < openArguments.Length; i++ {
                if !MatchesConstructedParameterType(
                    openArguments[i],
                    constructedArguments[i],
                    openTypeArguments,
                    typeArguments
                ) {
                    return false
                }
            }
            return true
        }
        return $open == constructed
    }

    private func ContainsTypeBuilderGenericArgument(type Type?) bool {
        if type == nil {
            return false
        }
        if type is TypeBuilder {
            return true
        }
        if type.HasElementType {
            return ContainsTypeBuilderGenericArgument(type.GetElementType())
        }
        if !type.IsGenericType {
            return false
        }
        try {
            for arg in type.GetGenericArguments() {
                if ContainsTypeBuilderGenericArgument(arg) {
                    return true
                }
            }
        } catch (NotSupportedException) {
            return false
        }
        return false
    }

    private func InterfaceMatchesByName(candidate Type, target Type) bool {
        // Non-generic interfaces: direct FullName comparison.
        if !target.IsGenericType {
            return string.Equals(candidate.FullName, target.FullName, StringComparison.Ordinal)
        }
        // Generic interfaces: compare the open definition's FullName (e.g.
        // `System.Collections.Generic.IEnumerable`1`) then match each
        // generic argument structurally via AreSame.
        if !candidate.IsGenericType {
            return false
        }
        if !string.Equals(
            candidate.GetGenericTypeDefinition().FullName,
            target.GetGenericTypeDefinition().FullName,
            StringComparison.Ordinal
        ) {
            return false
        }
        let candidateArgs = candidate.GetGenericArguments()
        let targetArgs = target.GetGenericArguments()
        if candidateArgs.Length != targetArgs.Length {
            return false
        }
        for var i = 0; i < candidateArgs.Length; i++ {
            if !AreSame(candidateArgs[i], targetArgs[i]) {
                return false
            }
        }
        return true
    }

    private func SafeEnumerate[TMember MemberInfo](type Type?, flags BindingFlags, getAll(Type) -> []TMember)[]TMember {
        if type == nil {
            return Array.Empty[TMember]()
        }
        // Issue #1678: Type.GetMethods()/GetProperties()/etc. re-walk and
        // re-validate every member on every call (expensive under a
        // MetadataLoadContext); memoize per (Type, Flags, member kind) so a
        // type used at N call sites pays this once instead of N times.
        return MemberCache[TMember].Cache.GetOrAdd(
            (type, flags),
            (key(Type Type, Flags BindingFlags)) -> {
                // A `TypeBuilderInstantiation` answers every member enumeration by throwing
                // (cref:NotSupportedException), which the catch below turns into the empty set.
                // Answer the empty set without paying for the throw.
                if IsTypeBuilderInstantiation(key.Type) {
                    return Array.Empty[TMember]()
                }
                var all[]TMember
                try {
                    all = getAll(key.Type)
                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    return Array.Empty[TMember]()
                }
                let usable = List[TMember](all.Length)
                for member in all {
                    if CanLoadSignature(member) {
                        usable.Add(member)
                    }
                }
                return usable.ToArray()
            }
        )
    }

    private func SafeGetMember[TMember MemberInfo](
        type Type?,
        name string,
        flags BindingFlags,
        directLookup(Type, BindingFlags) -> TMember?,
        safeEnumerate(Type, BindingFlags) -> []TMember
    ) TMember? {
        if type == nil {
            return nil
        }
        // Issue #3501: enumerate each hierarchy level DECLARED-ONLY rather
        // than filtering one flattened enumeration of `type`. Reflection's
        // flattened view applies hide-by-name BEFORE the visibility filter, so
        // an INTERNAL `new` shadow in a derived class (Roslyn's
        // `CSharpSyntaxNode.SyntaxTree` over the public
        // `SyntaxNode.SyntaxTree`) removes the base member from the flattened
        // set while the shadow itself is excluded by the Public flag — the
        // member vanishes entirely and every `node.SyntaxTree` read failed
        // GS0158. Walking most-derived-first with DeclaredOnly matches C#
        // lookup: an accessible shadow wins at its own level, and an
        // inaccessible one simply doesn't hide the base member.
        let FindCanonical = func () TMember? {
            for var declaringType Type? = type; declaringType != nil; declaringType = declaringType!!.BaseType {
                var match TMember? = nil
                for candidate in safeEnumerate(declaringType, flags | BindingFlags.DeclaredOnly) {
                    if !EmittedMemberNameMatches(candidate, name) {
                        continue
                    }
                    if match != nil {
                        return nil
                    }
                    match = candidate
                }
                if match != nil {
                    return match
                }
            }
            return nil
        }
        // A `TypeBuilderInstantiation` answers a direct lookup by throwing
        // (cref:NotSupportedException); the catch below recovers through the guarded
        // enumeration. Take that path without paying for the throw.
        if IsTypeBuilderInstantiation(type) {
            return FindCanonical()
        }
        try {
            let member TMember? = directLookup(type, flags)
            if member != nil && CanLoadSignature(member) {
                return member
            }
            return FindCanonical()
        } catch (AmbiguousMatchException) {
            return FindCanonical()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            // The direct lookup was poisoned by an unloadable member (the target
            // or a sibling reflected over during the search). Recover via the
            // guarded enumeration, which skips only the offending members.
            return FindCanonical()
        }
    }

    /// Issue #529: returns whether [`candidate`](paramref) is hidden
    /// by any method already in [`existing`](paramref). A method is
    /// hidden when another method with the same name and same parameter
    /// types is already present (C# interface hiding semantics).
    /// @param existing The methods found so far.
    /// @param candidate The candidate from a base interface.
    /// @returns `true` when the candidate is hidden.
    private func IsHiddenByExisting(existing List[MethodInfo], candidate MethodInfo) bool {
        for m in existing {
            if !string.Equals(m.Name, candidate.Name, StringComparison.Ordinal) {
                continue
            }
            let existingParams = m.GetParameters()
            let candidateParams = candidate.GetParameters()
            if existingParams.Length != candidateParams.Length {
                continue
            }
            var match = true
            for var i = 0; i < existingParams.Length; i++ {
                if !AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType) {
                    match = false
                    break
                }
            }
            if match {
                return true
            }
        }
        return false
    }
}

/// Resolves a named method without asking a constructed
/// (cref:TypeBuilder) generic instantiation to resolve members
/// directly. The name must be unambiguous; use the parameter-type overload
/// for overloaded methods.
/// @param name The method name to resolve.
/// @returns The resolved method, or `null` when no matching method exists.
/// @exception AmbiguousMatchException [`name`](paramref) identifies multiple methods.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) GetMethodSafe(name string?) MethodInfo? {
    if type == nil || name == nil {
        return nil
    }
    try {
        if !ClrTypeUtilities.IsTypeBuilderInstantiation(type) {
            return type.GetMethod(name)
        }
    } catch (NotSupportedException) {
        // Resolved through the open definition below.

    }
    if !ClrTypeUtilities.IsConstructedGenericWithTypeBuilderArgument(type) {
        return nil
    }
    let openMethod MethodInfo? = type.GetGenericTypeDefinition().GetMethod(name)
    return if openMethod != nil {
        ClrTypeUtilities.GetConstructedGenericMethod(type, openMethod)
    } else {
        default(MethodInfo?)
    }
}

/// Resolves a named method with the specified parameter types without
/// asking a constructed (cref:TypeBuilder) generic instantiation to
/// resolve members directly.
/// @param name The method name to resolve.
/// @param types The method's parameter types.
/// @returns The resolved method, or `null` when no matching method exists.
/// @exception AmbiguousMatchException More than one method matches the supplied signature.
/// @exception ArgumentNullException [`types`](paramref) contains a `null` element.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) GetMethodSafe(name string?, types[]?Type) MethodInfo? {
    if type == nil || name == nil || types == nil {
        return nil
    }
    try {
        if !ClrTypeUtilities.IsTypeBuilderInstantiation(type) {
            return type.GetMethod(name, types)
        }
    } catch (NotSupportedException) {
        // Resolved through the open definition below.

    }
    if !ClrTypeUtilities.IsConstructedGenericWithTypeBuilderArgument(type) {
        return nil
    }
    let openType = type.GetGenericTypeDefinition()
    let typeArguments = type.GetGenericArguments()
    let openTypeArguments = openType.GetGenericArguments()
    let openMethod MethodInfo? = ClrTypeUtilities.FindOpenGenericMethod(
        openType,
        name,
        types,
        openTypeArguments,
        typeArguments
    )
    return if openMethod != nil {
        ClrTypeUtilities.GetConstructedGenericMethod(type, openMethod)
    } else {
        default(MethodInfo?)
    }
}

/// Issue #2327: single shared guard for every enum-reflection predicate
/// in the binder/emitter (generalizes the #1100 / #2135 pattern already
/// established for `IsAssignableFrom`/`IsInterface` probes).
/// (cref:Type.IsEnum) walks the base-type chain via
/// `IsSubclassOf(typeof(Enum))` under the hood, which is one of the
/// operations `System.Reflection.Emit.TypeBuilderInstantiation`
/// (a constructed generic — e.g. a compiler-synthesized structural
/// function-type delegate — closed over an in-flight (cref:TypeBuilder)
/// definition) throws (cref:NotSupportedException) for. Such a type
/// is never a genuine CLR enum, so a throw here is treated as a definite
/// "not an enum" rather than propagating and crashing emit/binding.
/// @returns `true` when [`type`](paramref) is a real CLR enum.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) IsEnumSafe() bool {
    if type == nil || ClrTypeUtilities.IsTypeBuilderInstantiation(type) {
        return false
    }
    try {
        return type.IsEnum
    } catch (NotSupportedException) {
        return false
    }
}

/// Issue #2327: safe companion to (cref:IsEnumSafe) — resolves the
/// CLR underlying primitive of an enum type without risking the same
/// (cref:NotSupportedException) a `TypeBuilderInstantiation`
/// (or other unsupported reflection type) can throw from
/// (cref:Enum.GetUnderlyingType)'s own `IsEnum` validation.
/// @returns The underlying primitive (cref:Type), or `null` when [`type`](paramref) is not a genuine
/// CLR enum.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) GetEnumUnderlyingTypeSafe() Type? {
    if type == nil || !type.IsEnumSafe() {
        return nil
    }
    try {
        return Enum.GetUnderlyingType(type)
    } catch (NotSupportedException) {
        return nil
    }
}

/// Issue #4023: whether [`type`](paramref) was produced by the live
/// runtime's own loader — a `System.RuntimeType` — and is therefore
/// safe to close open host generics over and to reflect members on.
/// @remarks `RuntimeType.MakeGenericType` answers a real
/// `RuntimeType` only when EVERY type argument is itself a
/// `RuntimeType`. Hand it one that is not — a
/// (cref:System.Reflection.MetadataLoadContext) `RoType`, or an
/// in-flight (cref:System.Reflection.Emit.TypeBuilder) — and it
/// silently answers a `System.Reflection.Emit.TypeBuilderInstantiation`
/// instead, a structural placeholder whose `GetMethod`,
/// `GetProperty` and `GetConstructor` all throw
/// (cref:NotSupportedException). Such a type is non-null and looks
/// usable, so a plain `ClrType != null` gate lets it through and the
/// failure surfaces much later as a missing member or an internal
/// compiler error.
///
/// The same predicate is spelled inline in the emitter
/// (`MethodBodyEmitter.IsRuntimeProvidedType`, ADR-0174 D12's
/// `ChannelElementNeedsSymbolicType`); this is the binder-side
/// spelling of it.
/// @returns `true` when the type is a host `System.RuntimeType`.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) IsRuntimeProvidedType() bool -> type != nil && type.GetType() == typeof(object).GetType()

/// Extension-method companion to (cref:AreSame(Type, Type)). Reads more
/// naturally at call sites that historically used
/// `clrType == typeof(SomeType)` reference-identity comparisons —
/// issue #835 — and prevents the silent feature drops that occur when the
/// left-hand (cref:Type) was materialised through a
/// (cref:System.Reflection.MetadataLoadContext) rather than the host
/// process's `typeof()`.
/// from imported metadata. May be `null`.
/// @param other The expected canonical type, typically a host
/// `typeof(...)` literal.
/// @returns `true` when both types denote the same logical CLR type.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (self Type?) IsSameAs(other Type?) bool {
    if self == nil || other == nil {
        return false
    }
    if object.ReferenceEquals(self, other) {
        return true
    }
    // Arrays: element + rank must match. The constructed-array FullName
    // embeds the element's assembly-qualified name when the element is
    // itself a constructed generic, so arrays of cross-context generics
    // require structural comparison.
    if self.IsArray && other.IsArray {
        return self.GetArrayRank() == other.GetArrayRank() && self.GetElementType().IsSameAs(other.GetElementType())
    }
    if self.IsByRef && other.IsByRef {
        return self.GetElementType().IsSameAs(other.GetElementType())
    }
    if self.IsPointer && other.IsPointer {
        return self.GetElementType().IsSameAs(other.GetElementType())
    }
    // Constructed (closed) generics: compare the open definition's
    // FullName (which is assembly-qualifier-free, e.g.
    // `System.Nullable\u00601`) and recurse on each type argument. This
    // is the cross-reflection-context fix that closes issue #504-reopen
    // for `Nullable<T>` and applies equally to any other constructed
    // generic with a leaf-FullName-matchable type argument.
    if self.IsGenericType && other.IsGenericType && !self.IsGenericTypeDefinition && !other.IsGenericTypeDefinition {
        if !string.Equals(
            self.GetGenericTypeDefinition().FullName,
            other.GetGenericTypeDefinition().FullName,
            StringComparison.Ordinal
        ) {
            return false
        }
        let aArgs = self.GetGenericArguments()
        let bArgs = other.GetGenericArguments()
        if aArgs.Length != bArgs.Length {
            return false
        }
        for var i = 0; i < aArgs.Length; i++ {
            if !aArgs[i].IsSameAs(bArgs[i]) {
                return false
            }
        }
        return true
    }
    return string.Equals(self.FullName, other.FullName, StringComparison.Ordinal)
}

/// Issue #3764: returns whether [`type`](paramref) is a CLR value type,
/// answering correctly for types that reached the compiler from
/// <em>outside</em> the reflection context asking the question.
///
/// (cref:Type.IsValueType) is not a metadata predicate: every
/// implementation answers it by comparing the type's
/// (cref:Type.BaseType) against <em>its own context's</em>
/// `System.ValueType`. Inside a
/// (cref:System.Reflection.MetadataLoadContext) that identity is the
/// `System.ValueType` of the context's <em>core assembly</em>, so a
/// type whose base comes from some other assembly compares unequal and the
/// property answers `false` for a genuine struct — silently,
/// with no exception.
///
/// That is not hypothetical. Compiling a `netstandard2.0` target whose
/// reference closure does not declare
/// `DefaultInterpolatedStringHandler`, the resolver's fallback
/// assembly loader supplies the host's `System.Private.CoreLib`
/// definition; the context's core assembly is `netstandard`, so the
/// handler answers `IsValueType == false` while simultaneously
/// answering `IsByRefLike == true` and reporting
/// `BaseType == System.ValueType` — a contradiction only a value type
/// can produce. Emit decisions keyed on the raw property then chose
/// `callvirt` plus a by-value receiver for a struct's instance call
/// and produced IL that only ILVerify rejected.
///
/// The fallback is exact rather than heuristic: in ECMA-335 a value type is
/// precisely a type whose immediate base is `System.ValueType` (or
/// `System.Enum`, itself the base of enums). Structs never have deeper
/// hierarchies, so one (cref:Type.BaseType) hop by name settles it.
/// `System.Enum` is excluded explicitly: it is a <em>class</em> that
/// derives from `System.ValueType`.
/// @returns `true` when [`type`](paramref) is a CLR value type.
@ExtensionOwner(typeof(ClrTypeUtilities))
func (type Type?) IsValueTypeSafe() bool {
    if type == nil {
        return false
    }
    // The property is asked exactly as before — including letting its
    // exceptions escape — so a `true` answer, and every throwing shape,
    // behave identically to the raw call this helper replaced. Only the
    // `false` answer gets a second opinion.
    if type.IsValueType {
        return true
    }
    // Only a type definition can be a cross-context struct answering
    // wrongly; constructed shapes (arrays, byrefs, pointers), interfaces
    // and open generic parameters are settled by the property above.
    if type.IsGenericParameter || type.IsArray || type.IsByRef || type.IsPointer || type.IsInterface {
        return false
    }
    // `System.Enum` is a class that derives from `System.ValueType`; the
    // base-name test below would otherwise call it a value type.
    if string.Equals(type.FullName, "System.Enum", StringComparison.Ordinal) {
        return false
    }
    try {
        let baseName string? = type.BaseType?.FullName
        return string.Equals(baseName, "System.ValueType", StringComparison.Ordinal) || string.Equals(
            baseName,
            "System.Enum",
            StringComparison.Ordinal
        )
    } catch (NotSupportedException) {
        // Issue #2327's shape: a `TypeBuilderInstantiation` closed over an
        // in-flight definition refuses base-chain questions. Such a type is
        // never one of the cross-context strays this fallback exists for.
        return false
    } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
        return false
    }
}
