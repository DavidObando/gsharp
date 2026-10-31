// <copyright file="TupleTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Text

/// Represents a tuple type `(T1, T2, ...)` (Phase 4.5).
/// @remarks Backed by the CLR `System.ValueTuple<...>` family. Instances are
/// cached per element-type sequence so identical tuple types compare by
/// reference. Arity 8 and higher use the CLR's canonical
/// `ValueTuple<T1,...,T7,TRest>` nesting.
class TupleTypeSymbol : TypeSymbol {
    private init(elementTypes ImmutableArray[TypeSymbol], elementNames ImmutableArray[string?]) : base(
        BuildName(elementTypes, elementNames),
        BuildClrType(elementTypes)
    ) {
        ElementTypes = elementTypes
        ElementNames = elementNames
    }

    /// Gets the tuple element types in declaration order.
    prop ElementTypes ImmutableArray[TypeSymbol] {
        get;
    }

    /// Gets the declared element names, parallel to
    /// (cref:ElementTypes) with `null` at unnamed
    /// positions — or an empty array for a fully unnamed tuple (ADR-0172).
    /// Names are metadata: they never affect the CLR backing, conversions,
    /// or equality; same-shape tuples differing only in names are related by
    /// an identity conversion.
    prop ElementNames ImmutableArray[string?] {
        get;
    }

    /// Gets a value indicating whether any element declares a name.
    prop HasNames bool -> !ElementNames.IsDefaultOrEmpty

    /// Gets the arity of the tuple.
    prop Arity int32 -> ElementTypes.Length

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop IsTupleType bool -> true

    /// Gets the positional tuple elements as field symbols — the Roslyn
    /// `INamedTypeSymbol.TupleElements` analogue (ADR-0169, issue #3794).
    ///
    /// Without this override the base returned EMPTY, so a migrated analyzer
    /// that walks a tuple's elements (GSA0004's cache-key inspection is
    /// exactly that) saw a tuple with no components and silently concluded
    /// the key mentioned nothing — reporting nothing at all. Elements are
    /// named after their declared name where ADR-0172 gives one, and
    /// `Item1..ItemN` otherwise, which is what Roslyn does.
    override prop TupleElements ImmutableArray[FieldSymbol] {
        get {
            let builder = ImmutableArray.CreateBuilder[FieldSymbol](ElementTypes.Length)
            for var i = 0; i < ElementTypes.Length; i++ {
                let declared string? = if ElementNames.IsDefaultOrEmpty {
                    default(string?)
                } else {
                    ElementNames[i]
                }
                let elementName = if string.IsNullOrEmpty(declared) {
                    "Item${i + 1}"
                } else {
                    declared!!
                }
                builder.Add(FieldSymbol(elementName, ElementTypes[i], Accessibility.Public, isReadOnly: true))
            }
            return builder.MoveToImmutable()
        }
    }

    /// Returns the canonical fully unnamed tuple of this tuple's shape,
    /// recursively stripping names from nested tuple elements (ADR-0172).
    /// Two tuples denote the same type exactly when their
    /// (cref:WithoutNames) results are reference-equal.
    /// @returns The (cached) unnamed same-shape tuple symbol.
    func WithoutNames() TupleTypeSymbol {
        let stripped = ImmutableArray.CreateBuilder[TypeSymbol](ElementTypes.Length)
        var changed = HasNames
        for elementType in ElementTypes {
            let strippedElement = StripNames(elementType)
            stripped.Add(strippedElement)
            changed |= !object.ReferenceEquals(strippedElement, elementType)
        }
        return if changed {
            Get(stripped.MoveToImmutable())
        } else {
            this
        }
    }

    /// Issue #4316: whether an element, at any depth, is the `nil` type (`(nil, int32)`, the type of
    /// a tuple literal that holds a bare `nil`). Such a tuple has no runtime representation until it
    /// converts to a tuple whose element is a `T?`.
    prop HasNilElement bool {
        get {
            for elementType in ElementTypes {
                if elementType == TypeSymbol.Null || elementType is TupleTypeSymbol nested && nested.HasNilElement {
                    return true
                }
            }
            return false
        }
    }

    /// Finds the zero-based position of a declared element name (ordinal,
    /// case-sensitive), or returns `false`.
    /// @param name The element name to find.
    /// @param index The zero-based element index when found.
    /// @returns Whether the name is declared on this tuple.
    func TryGetElementIndexByName(name string, out index int32) bool {
        if HasNames {
            for var i = 0; i < ElementNames.Length; i++ {
                if string.Equals(ElementNames[i], name, StringComparison.Ordinal) {
                    index = i
                    return true
                }
            }
        }
        index = -1
        return false
    }

    shared {
        /// The full-name prefix of the CLR family a tuple IS (ADR-0158).
        private const ValueTupleDefinitionPrefix string = "System.ValueTuple`"

        private let Cache ConcurrentDictionary[string, TupleTypeSymbol] = ConcurrentDictionary[
            string,
            TupleTypeSymbol
        ]()

        /// Returns the cached (cref:TupleTypeSymbol) for the given element types.
        /// @param elementTypes The element types in order.
        /// @returns The (cached) tuple type symbol.
        func Get(elementTypes ImmutableArray[TypeSymbol]) TupleTypeSymbol -> Get(
            elementTypes,
            elementNames: default(ImmutableArray[string?])
        )

        /// Returns the cached (cref:TupleTypeSymbol) for the given element
        /// types and names (ADR-0172). A default/empty or all-`null`
        /// name array yields the canonical unnamed tuple.
        /// @param elementTypes The element types in order.
        /// @param elementNames The element names, parallel to [`elementTypes`](paramref), `null` where unnamed.
        /// @returns The (cached) tuple type symbol.
        func Get(elementTypes ImmutableArray[TypeSymbol], elementNames ImmutableArray[string?]) TupleTypeSymbol {
            var elementNames = elementNames
            if elementTypes.IsDefaultOrEmpty || elementTypes.Length < 2 {
                throw ArgumentException("Tuples must have at least two element types.", "elementTypes")
            }
            if !elementNames.IsDefaultOrEmpty && elementNames.Length != elementTypes.Length {
                throw ArgumentException("Element names must parallel element types.", "elementNames")
            }
            if !elementNames.IsDefaultOrEmpty && elementNames.All((n string?) -> n == nil) {
                elementNames = ImmutableArray[string?].Empty
            }
            if elementNames.IsDefault {
                elementNames = ImmutableArray[string?].Empty
            }
            // Issue #1624: key on element-type *identity* (via FunctionTypeSymbol's
            // shared identity-key builder), not the display name. A name-based key
            // (e.g. "(Holder, string)") can alias two distinct same-named types
            // from different compilations; the previous fix (#649) validated
            // identity on lookup but then racily overwrote the cache entry on a
            // mismatch, so concurrent callers could still observe two distinct
            // instances for the same elements. GetOrAdd is atomic, so no overwrite
            // is needed once the key itself is identity-correct.
            let keyBuilder = StringBuilder()
            for var i = 0; i < elementTypes.Length; i++ {
                if i > 0 {
                    keyBuilder.Append(',')
                }
                FunctionTypeSymbol.AppendIdentityKey(keyBuilder, elementTypes[i])
            }
            // ADR-0172: names participate in the cache key (a named and an
            // unnamed same-shape tuple are distinct interned symbols related by
            // an identity conversion), with an empty suffix for the canonical
            // unnamed tuple so pre-existing keys are unchanged.
            if elementNames.Length > 0 {
                keyBuilder.Append('|')
                for var i = 0; i < elementNames.Length; i++ {
                    if i > 0 {
                        keyBuilder.Append(',')
                    }
                    keyBuilder.Append(elementNames[i])
                }
            }
            let key = keyBuilder.ToString()
            return Cache.GetOrAdd(key, (_ string) -> TupleTypeSymbol(elementTypes, elementNames))
        }

        /// Issue #3987: recognizes a tuple-shaped type by SHAPE rather than by
        /// spelling — G#'s own (cref:TupleTypeSymbol), or the
        /// `System.ValueTuple<…>` it IS (ADR-0158 identity) arriving from
        /// metadata as an (cref:ImportedTypeSymbol) — and yields its
        /// elements FLATTENED through the canonical
        /// `ValueTuple<T1..T7, TRest>` nesting.
        /// @remarks The direct analogue of (cref:ChannelTypeSymbol.TryGetChannelShape)
        /// and (cref:MapTypeSymbol.TryGetMapShape). Flattening is not
        /// optional: an 8-or-more-element tuple is a NESTED
        /// `ValueTuple<…, TRest>` on the imported side and a flat element
        /// list on G#'s side, so comparing arity without unwinding the chain would
        /// exclude exactly the long tuples.
        /// @param type The candidate type.
        /// @param elementTypes The recovered, flattened element types.
        /// @returns True when [`type`](paramref) is tuple-shaped.
        func TryGetTupleShape(type TypeSymbol?, out elementTypes ImmutableArray[TypeSymbol]) bool {
            elementTypes = default(ImmutableArray[TypeSymbol])
            if type is NullabilityAnnotatedTypeSymbol annotated {
                return TryGetTupleShape(annotated.BaseType, out elementTypes)
            }
            if !((type is TupleTypeSymbol || type is ImportedTypeSymbol)) {
                return false
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
            if !TryFlattenTupleShape(type, builder) || builder.Count < 2 {
                return false
            }
            elementTypes = builder.ToImmutable()
            return true
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        internal func GetOpenClrType(arity int32) Type -> switch arity {
            case 1: typeof(ValueTuple[_])
            case 2: typeof(ValueTuple[_, _])
            case 3: typeof(ValueTuple[_, _, _])
            case 4: typeof(ValueTuple[_, _, _, _])
            case 5: typeof(ValueTuple[_, _, _, _, _])
            case 6: typeof(ValueTuple[_, _, _, _, _, _])
            case 7: typeof(ValueTuple[_, _, _, _, _, _, _])
            case 8: typeof(ValueTuple[_, _, _, _, _, _, _, _])
            default: throw ArgumentOutOfRangeException("arity")
        }

        /// Issue #4591: the open `ValueTuple`N` definition in the load
        /// context [`contextObject`](paramref) belongs to. The host
        /// `typeof(ValueTuple<,>)` is right only for the host context;
        /// for a `MetadataLoadContext` the definition is looked up from that
        /// context's own core assembly, which is where its `System.Object`
        /// lives.
        /// @param arity The CLR tuple-node arity (1–8).
        /// @param contextObject The `System.Object` of the target load context.
        /// @returns The open definition, or `null` when the context does not define it.
        internal func GetOpenClrType(arity int32, contextObject Type) Type? {
            let hostDefinition = GetOpenClrType(arity)
            if object.ReferenceEquals(contextObject.Assembly, typeof(object).Assembly) {
                return hostDefinition
            }
            return contextObject.Assembly.GetType(
                ValueTupleDefinitionPrefix + arity.ToString(CultureInfo.InvariantCulture),
                throwOnError: false
            )
        }

        /// Builds the closed `ValueTuple<...>` CLR type over
        /// [`elementTypes`](paramref).
        /// @remarks Issue #4591: the G# primitives are host `typeof(...)` types, but
        /// every other imported type comes from the compiler's
        /// `MetadataLoadContext`. Closing the HOST `ValueTuple` over such
        /// an element does not throw: `RuntimeType.MakeGenericType` silently
        /// returns a `TypeBuilderInstantiation` that throws
        /// (cref:NotSupportedException) from `GetInterfaces` and every
        /// member lookup, which surfaced as GS9998 on an array-to-
        /// `IEnumerable` conversion and as a silently lost generic overload
        /// candidate. When every such element (or, for a host generic already
        /// closed over context types such as a function type's
        /// `Func<…>`, every part of it) provably belongs to one
        /// `MetadataLoadContext`, the tuple is therefore closed in that
        /// context, with host types remapped into it. Every other shape —
        /// all-host elements, or an element whose context cannot be proven —
        /// keeps the previous host construction exactly.
        /// @param elementTypes The element CLR types, in order.
        /// @returns The closed CLR type.
        internal func BuildClrType(elementTypes[]Type) Type? -> BuildClrType(elementTypes, [elementTypes.Length]bool)

        /// Issue #4591: (cref:BuildClrType(Type[])) with nullable value-type
        /// elements passed as their UNDERLYING type plus a flag. A pre-built
        /// `Nullable<T>` over a `MetadataLoadContext` struct would
        /// itself be a host `TypeBuilderInstantiation` (the #4035 trap), so
        /// the wrapper is built only once the context is known, from that
        /// context's own `Nullable<>`.
        /// @param elementTypes The element CLR types, nullable value types unwrapped.
        /// @param liftToNullable Per element, whether to wrap it in `Nullable<>`.
        /// @returns The closed CLR type.
        private func BuildClrType(elementTypes[]Type, liftToNullable[]bool) Type? {
            let hostObject = typeof(object)
            let contextObject = ResolveLoadContextObject(elementTypes)
            if !object.ReferenceEquals(contextObject, hostObject) &&
                TryBuildClrTypeInContext(elementTypes, liftToNullable, contextObject) is {} inContext {
                return inContext
            }
            // The previous construction, unchanged: host `Nullable<>` and host
            // `ValueTuple<…>` (what `GetEffectiveClrType` and the old builder did).
            let arguments = [elementTypes.Length]Type
            for var i = 0; i < elementTypes.Length; i++ {
                arguments[i] = if liftToNullable[i] {
                    typeof(Nullable[_]).MakeGenericType(elementTypes[i])
                } else {
                    elementTypes[i]
                }
            }
            return BuildClrType(arguments, 0, arguments.Length, hostObject)
        }

        /// Issue #4591: closes the tuple in the `MetadataLoadContext`
        /// [`contextObject`](paramref) belongs to, remapping host primitives
        /// into it and building each nullable value type's `Nullable<>`
        /// from that context.
        /// @param elementTypes The element CLR types, nullable value types unwrapped.
        /// @param liftToNullable Per element, whether to wrap it in `Nullable<>`.
        /// @param contextObject The context's `System.Object`.
        /// @returns The closed CLR type, or `null` when the context cannot build it.
        private func TryBuildClrTypeInContext(elementTypes[]Type, liftToNullable[]bool, contextObject Type) Type? {
            try {
                let arguments = [elementTypes.Length]Type
                for var i = 0; i < elementTypes.Length; i++ {
                    var argument = ClrTypeUtilities.RemapHostCoreTypeToContext(elementTypes[i], contextObject)
                    if (liftToNullable[i]) {
                        let nullableOpen Type? = contextObject.Assembly.GetType(
                            "System.Nullable`1",
                            throwOnError: false
                        )
                        if nullableOpen == nil {
                            return nil
                        }
                        argument = nullableOpen.MakeGenericType(argument!!)
                    }
                    arguments[i] = argument!!
                }
                return BuildClrType(arguments, 0, arguments.Length, contextObject)
            } catch (ArgumentException) {
                // An element the remap could not move into the context (a host
                // type outside the core assembly) is rejected by the context's
                // MakeGenericType; the caller falls back to the host build.
                return nil
            }
        }

        private func StripNames(type TypeSymbol) TypeSymbol -> switch type {
            case tuple is TupleTypeSymbol: cast[TypeSymbol](tuple.WithoutNames())
            case NullableTypeSymbol{UnderlyingType: TupleTypeSymbol nested}: cast[TypeSymbol](
                NullableTypeSymbol.Get(nested.WithoutNames())
            )
            default: type
        }

        private func BuildName(elementTypes ImmutableArray[TypeSymbol], elementNames ImmutableArray[string?]) string {
            let sb = StringBuilder("(")
            for var i = 0; i < elementTypes.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                if !elementNames.IsDefaultOrEmpty && elementNames[i] != nil {
                    sb.Append(elementNames[i])
                    sb.Append(' ')
                }
                sb.Append(elementTypes[i].Name)
            }
            sb.Append(')')
            return sb.ToString()
        }

        private func BuildClrType(elementTypes ImmutableArray[TypeSymbol]) Type? {
            // Issues #2119/#2702: a symbolic constructed generic has a non-null but
            // object-erased ClrType. Keep the tuple symbolic so signature encoding
            // preserves the real nested generic arguments.
            if elementTypes.Any((t TypeSymbol) -> t.ClrType == nil || TypeSymbol.RequiresSymbolicProjection(t)) {
                return nil
            }
            // Issue #4591: a nullable value type is handed down as its underlying
            // type plus a flag, never as `GetEffectiveClrType`'s host-built
            // `Nullable<T>`; see BuildClrType(Type[], bool[]).
            let clrTypes = [elementTypes.Length]Type
            let liftToNullable = [elementTypes.Length]bool
            for var i = 0; i < elementTypes.Length; i++ {
                if elementTypes[i] is NullableTypeSymbol{UnderlyingType: {ClrType: {IsValueType: true} underlying}} {
                    clrTypes[i] = underlying
                    liftToNullable[i] = true
                } else {
                    clrTypes[i] = Invariant.Required(
                        NullableTypeSymbol.GetEffectiveClrType(elementTypes[i]),
                        "a CLR-backed tuple element has a CLR type",
                        expression: "NullableTypeSymbol.GetEffectiveClrType(elementTypes[i])"
                    )
                }
            }
            return BuildClrType(clrTypes, liftToNullable)
        }

        private func BuildClrType(elementTypes[]Type, start int32, count int32, contextObject Type) Type? {
            if count <= 7 {
                return GetOpenClrType(count, contextObject)?.MakeGenericType(elementTypes[start .. (start + count)])
            }
            let open_ Type? = GetOpenClrType(8, contextObject)
            let rest Type? = BuildClrType(elementTypes, start + 7, count - 7, contextObject)
            if open_ == nil || rest == nil {
                return nil
            }
            let arguments = [8]Type
            Array.Copy(elementTypes, start, arguments, 0, 7)
            arguments[7] = rest
            return open_.MakeGenericType(arguments)
        }

        /// Issue #4591: the `System.Object` of the one
        /// `MetadataLoadContext` every non-host element of
        /// [`elementTypes`](paramref) provably belongs to. Host
        /// `RuntimeType` elements fit any context (they are remapped). The
        /// answer is the host `typeof(object)`, meaning "keep the previous
        /// host construction", whenever that cannot be proven: no element needs a
        /// context, some part's context cannot be determined, or two parts
        /// disagree. A host generic already closed over context types (a
        /// function type's `Func<…>` over an imported parameter type is
        /// a `TypeBuilderInstantiation`) is decided by its parts, which
        /// (cref:ClrTypeUtilities.RemapHostCoreTypeToContext) then rebuilds
        /// in the context.
        /// @param elementTypes The element CLR types.
        /// @returns The proven context's `System.Object`, otherwise the host `typeof(object)`.
        private func ResolveLoadContextObject(elementTypes[]Type) Type {
            let hostObject = typeof(object)
            let contextObjects = List[Type]()
            for element in elementTypes {
                if !TryCollectLoadContextObjects(element, contextObjects) {
                    return hostObject
                }
            }
            if contextObjects.Count == 0 {
                return hostObject
            }
            let contextObject = contextObjects[0]
            for other in contextObjects {
                if !object.ReferenceEquals(other, contextObject) {
                    return hostObject
                }
            }
            return contextObject
        }

        /// Issue #4591: adds the non-host load contexts [`type`](paramref)
        /// draws on to [`contextObjects`](paramref). A host
        /// `RuntimeType` needs none; a context type contributes its own; a
        /// host composite that is not a `RuntimeType` (a host generic or
        /// array over context types) contributes its parts'.
        /// @param type A CLR type.
        /// @param contextObjects The collected context `System.Object`s.
        /// @returns `false` when some part's context cannot be determined.
        private func TryCollectLoadContextObjects(type Type, contextObjects List[Type]) bool {
            if type.IsRuntimeProvidedType() {
                return true
            }
            let typeObject Type? = FindLoadContextObject(type)
            if typeObject == nil {
                return false
            }
            if !object.ReferenceEquals(typeObject.Assembly, typeof(object).Assembly) {
                contextObjects.Add(typeObject)
                return true
            }
            if type.HasElementType {
                return type.GetElementType() is {} elementType &&
                    TryCollectLoadContextObjects(elementType, contextObjects)
            }
            if !type.IsConstructedGenericType {
                return false
            }
            for argument in type.GetGenericArguments() {
                if !TryCollectLoadContextObjects(argument, contextObjects) {
                    return false
                }
            }
            return true
        }

        /// Issue #4591: the `System.Object` of [`type`](paramref)'s load
        /// context. Every context builds an array over its own types with its own
        /// `System.Array` as the base type, whose base is that context's
        /// `System.Object`; unlike walking [`type`](paramref)'s own base
        /// chain this also answers for an interface.
        /// @param type A CLR type.
        /// @returns The context's `System.Object`, or `null` when it cannot be determined.
        private func FindLoadContextObject(type Type) Type? {
            try {
                let root = type.MakeArrayType().BaseType?.BaseType
                return if root != nil && root.FullName == "System.Object" {
                    root
                } else {
                    default(Type?)
                }
            } catch (ex Exception) when ex is NotSupportedException || ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return nil
            }
        }

        /// Issue #3987: appends [`type`](paramref)'s tuple elements to
        /// [`elements`](paramref), walking the canonical
        /// `ValueTuple<T1..T7, TRest>` chain.
        /// @param type The candidate tuple-shaped type.
        /// @param elements The accumulating element list.
        /// @returns Whether the type was tuple-shaped throughout.
        private func TryFlattenTupleShape(type TypeSymbol?, elements ImmutableArray[TypeSymbol].Builder) bool {
            if type is NullabilityAnnotatedTypeSymbol annotated {
                return TryFlattenTupleShape(annotated.BaseType, elements)
            }
            if type is TupleTypeSymbol tuple {
                elements.AddRange(tuple.ElementTypes)
                return true
            }
            if type is not ImportedTypeSymbol imported {
                return false
            }
            var open_ Type? = imported.OpenDefinition
            if open_ == nil && imported.ClrType is {IsGenericType: true} closed {
                open_ = closed.GetGenericTypeDefinition()
            }
            if open_?.FullName?.StartsWith(ValueTupleDefinitionPrefix, StringComparison.Ordinal) != true {
                return false
            }
            var arguments = imported.TypeArguments
            if arguments.IsDefaultOrEmpty {
                if imported.ClrType is not{IsGenericType: true} closedShape {
                    return false
                }
                let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
                for argument in closedShape.GetGenericArguments() {
                    let symbol TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
                        argument,
                        NullabilityFreeReason.TypeStructure
                    )
                    if symbol == nil {
                        return false
                    }
                    builder.Add(symbol)
                }
                arguments = builder.ToImmutable()
            }
            if (arguments.Length is < 1 or > 8) {
                return false
            }
            if arguments.Length <= 7 {
                elements.AddRange(arguments)
                return true
            }
            for var i = 0; i < 7; i++ {
                elements.Add(arguments[i])
            }
            return TryFlattenTupleShape(arguments[7], elements)
        }
    }
}
