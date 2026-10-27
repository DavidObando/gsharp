// <copyright file="ImportedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Compilation
import System.Runtime.CompilerServices
import System.Threading
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import SystemObject = System.Object

/// Represents an imported .NET type as a (cref:TypeSymbol).
/// Instances are cached per CLR (cref:Type) so that reference equality
/// and identity conversions work as expected.
class ImportedTypeSymbol : TypeSymbol {
    private init(type Type) : base(type.FullName ?? type.Name, type) {
        TypeArguments = ImmutableArray[TypeSymbol].Empty
    }

    private init(
        name string,
        erasedClosedType Type,
        openDefinition Type?,
        typeArguments ImmutableArray[TypeSymbol]
    ) : base(name, erasedClosedType) {
        OpenDefinition = openDefinition
        TypeArguments = typeArguments
    }

    /// Gets the underlying CLR type. For a type constructed over an in-scope
    /// generic type parameter (#313) this is the type-erased closed form
    /// (e.g. `List<object>` for `List[T]`) so member, index, and
    /// conversion resolution keep working.
    prop Type Type -> Invariant.Required(
        ClrType,
        "an imported type always has a CLR representation",
        expression: "ClrType"
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> Type.Namespace

    /// Gets the open generic CLR definition this symbol was constructed from
    /// (e.g. `List<>`), or `null` when this is a plain imported
    /// type rather than a #313 type-parameter construction.
    prop OpenDefinition Type? {
        get;
    }

    /// Gets the symbolic type arguments this generic type was constructed with
    /// (#313). May contain (cref:TypeParameterSymbol) entries for an
    /// in-scope type parameter (e.g. `[T]` in `List[T]`). Empty for a
    /// plain imported type whose arguments are fully described by its
    /// (cref:TypeSymbol.ClrType).
    prop TypeArguments ImmutableArray[TypeSymbol] {
        get;
    }

    /// Gets a value indicating whether this symbol carries symbolic type
    /// arguments that include an in-scope generic type parameter (#313), in
    /// which case it is an open/partially-constructed generic whose emit form
    /// is type-erased to `System.Object`.
    prop HasTypeParameterArgument bool -> !TypeArguments.IsDefaultOrEmpty && TypeArguments.Any(
        TypeSymbol.ContainsTypeParameter
    )

    /// Gets a value indicating whether this symbol's symbolic type arguments
    /// should be substituted back through its (cref:OpenDefinition) when
    /// projecting member / element types (issue #939).
    /// This is broader than (cref:HasTypeParameterArgument): it also
    /// holds when an argument is a <em>same-compilation</em> user
    /// `class`/`data struct` (whose (cref:TypeSymbol.ClrType)
    /// is `null` because its CLR type is still being built and
    /// the closed shape is erased to `object`), or a nested constructed
    /// generic with symbolic arguments (e.g. `List[List[MyGs]]`). The
    /// indexer path (`MapErasedIndexerElementType`) and the for-in
    /// enumerable path both rely on this so iterating `List[Item]`
    /// recovers the member-bearing user `Item` symbol rather than the
    /// type-erased `object`.
    prop HasSubstitutableTypeArgument bool -> !TypeArguments.IsDefaultOrEmpty && TypeArguments.Any(
        (a TypeSymbol) -> a.ClrType == nil || TypeSymbol.RequiresSymbolicProjection(a) ||
            (
            a is ImportedTypeSymbol nested && nested.OpenDefinition != nil && !nested.TypeArguments.IsDefaultOrEmpty
        ) ||
            a is TupleTypeSymbol &&
            a.HasNames == true
    )

    /// Gets the type arguments this instantiation was constructed with,
    /// preferring the SYMBOLIC (cref:TypeArguments) over the CLR ones
    /// (ADR-0169, issue #3794).
    ///
    /// The base implementation reads `ClrType.GenericTypeArguments`, and
    /// for a generic constructed over a same-compilation user type the CLR
    /// form is type-ERASED — `Dictionary[StructSymbol, MemberReferenceHandle]`
    /// is backed by `Dictionary<object, object>`. A migrated
    /// analyzer walking a member's type structure (GSA0004's key/value
    /// inspection is exactly this) therefore saw `System.Object` for
    /// every argument and matched nothing at all — the silent under-reporting
    /// failure mode #3795 warned about. The symbolic arguments are the ones
    /// the source actually wrote, so they are what Roslyn's
    /// `INamedTypeSymbol.TypeArguments` corresponds to; the erased CLR
    /// list stays the fallback for a plain imported type that carries none.
    override prop ConstructedTypeArguments ImmutableArray[TypeSymbol] -> if TypeArguments.IsDefaultOrEmpty {
        base.ConstructedTypeArguments
    } else {
        TypeArguments
    }

    /// Issue #2381: recursively reconstructs the TRUE closed CLR type for
    /// this constructed generic, recomputing every type argument's CLR type
    /// from its CURRENT state rather than trusting the cached (possibly
    /// erased) (cref:TypeSymbol.ClrType).
    /// @remarks A constructed (cref:ImportedTypeSymbol) closed over a
    /// same-compilation class/struct argument (e.g. `List[DiagnosticCheck]`)
    /// caches an object-erased shape (`List<object>`) because, at
    /// the time (cref:GetConstructed) ran during binding, the
    /// argument's own CLR type (its emitted `TypeBuilder`) did not exist
    /// yet — see (cref:HasSubstitutableTypeArgument). That erased
    /// shape is safe for member/index/conversion resolution during binding,
    /// but is wrong for final metadata (method signatures, generic builder
    /// instantiation, field types) once the argument's real CLR type is
    /// available.
    ///
    /// This walks (cref:OpenDefinition) + (cref:TypeArguments)
    /// and rebuilds the closed type via (cref:Type.MakeGenericType)
    /// using each argument's CURRENT CLR type, recursing into nested
    /// constructed generics (e.g. `List[List[UserClass]]`,
    /// `Dictionary[string, UserClass]`) so every level reflects its
    /// real closed shape. Value-typed nullable arguments are projected
    /// through (cref:NullableLifting.GetEffectiveClrType) so they
    /// close over `Nullable<T>` rather than the bare value type.
    ///
    /// Falls back to the cached (possibly erased) (cref:TypeSymbol.ClrType)
    /// when reification is not possible: an in-scope type parameter argument
    /// ((cref:HasTypeParameterArgument)) has no concrete CLR type to
    /// close over; a nested argument's own CLR type is still unavailable; or
    /// (cref:Type.MakeGenericType) legitimately rejects the
    /// reconstructed arguments (CLR generic constraints).
    /// @returns The reconstructed closed CLR type, or the cached (possibly erased)
    /// (cref:TypeSymbol.ClrType) when reification is not possible.
    func ReifyClosedClrType() Type {
        if OpenDefinition == nil || TypeArguments.IsDefaultOrEmpty || HasTypeParameterArgument {
            return Invariant.Required(
                ClrType,
                "an imported type always has a CLR representation",
                expression: "ClrType"
            )
        }
        let openDefinition = OpenDefinition!!
        var contextObject Type? = nil
        for parameter in openDefinition.GetGenericArguments() {
            if string.Equals(parameter.BaseType?.FullName, "System.Object", StringComparison.Ordinal) {
                contextObject = parameter.BaseType
                break
            }
        }
        let args = [TypeArguments.Length]Type
        for var i = 0; i < args.Length; i++ {
            let arg = TypeArguments[i]
            let argClr Type? = switch arg {
                case nestedImported is ImportedTypeSymbol: nestedImported.ReifyClosedClrType()
                case _ is NullableTypeSymbol: NullableLifting.GetEffectiveClrType(arg)
                default: arg?.ClrType
            }
            if argClr == nil {
                // Some argument still lacks a concrete CLR type (e.g. its own
                // TypeBuilder has not been created yet); degrade to the
                // cached erased shape rather than fail outright.
                return Invariant.Required(
                    ClrType,
                    "an imported type always has a CLR representation",
                    expression: "ClrType"
                )
            }
            args[i] = Invariant.Required(
                ClrTypeUtilities.RemapHostCoreTypeToContext(argClr, contextObject),
                "a concrete generic argument remains available after CLR context remapping",
                expression: "ClrTypeUtilities.RemapHostCoreTypeToContext(argClr, contextObject)"
            )
        }
        try {
            return openDefinition.MakeGenericType(args)
        } catch (ArgumentException) {
            // MakeGenericType can legitimately reject the reconstructed
            // arguments for CLR generic-constraint reasons; degrade to the
            // erased shape instead of throwing.
            return Invariant.Required(
                ClrType,
                "an imported type always has a CLR representation",
                expression: "ClrType"
            )
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetDocumentation() DocumentationComment? {
        return AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type) ?? base.GetDocumentation()
    }

    private class CacheBucket {
        internal let Gate object = SystemObject()
        internal let Symbols Dictionary[int32, List[WeakReference[ImportedTypeSymbol]]] = Dictionary[
            int32,
            List[WeakReference[ImportedTypeSymbol]]
        ]()
        internal var Accesses int32
    }

    /// One level of the construction table (issue #5158). Child tables are created
    /// on demand; the symbol is held weakly and set under the lock of the node. A strong
    /// reference would let a long-lived argument (a primitive) keep the erased type, and
    /// with it the reference context, alive through the ephemeron value.
    private class ConstructionNode {
        private var children ConditionalWeakTable[object, ConstructionNode]?
        internal var Symbol WeakReference[ImportedTypeSymbol]?

        internal func GetChild(key object) ConstructionNode {
            var table = Volatile.Read(&children)
            if table == nil {
                Interlocked.CompareExchange[ConditionalWeakTable[object, ConstructionNode]?](
                    &children,
                    ConditionalWeakTable[object, ConstructionNode](),
                    nil
                )
                table = Volatile.Read(&children)
            }
            return table!!.GetValue(key, ImportedTypeSymbol.CreateConstructionNode)
        }
    }

    shared {
        private let ConstructionRoots ConditionalWeakTable[object, ConstructionNode] = ConditionalWeakTable[
            object,
            ConstructionNode
        ]()
        private let CreateConstructionNode ConditionalWeakTable[object, ConstructionNode].CreateValueCallback =
        (_ object) -> ConstructionNode()

        /// Key part for a construction without an open definition.
        private let NoOpenDefinition object = SystemObject()

        private let Cache ConditionalWeakTable[Assembly, CacheBucket] = ConditionalWeakTable[Assembly, CacheBucket]()

        /// Gets or creates the imported type symbol for the given CLR type.
        /// @param type The CLR type.
        /// @returns The cached (cref:ImportedTypeSymbol).
        /// @remarks ADR-0193 §3: a conversion door, like (cref:TypeSymbol.FromClrType)
        /// (which ends here). GSA0007 reports a call outside a
        /// (cref:NullabilityFunnelAttribute) member; a type with no
        /// declaration nullability to lose goes through
        /// (cref:GetWithoutNullability).
        @NullabilityFunnel
        func Get(type Type?) ImportedTypeSymbol {
            if type == nil {
                throw ArgumentNullException("type")
            }
            // Issue #3826: the comparer must be load-context sensitive. Keying on
            // the assembly-qualified name alone (TypeIdentityComparer) aliases two
            // copies of one logical type loaded into different contexts, so a
            // symbol — and the CLR Type it carries — created by one compilation
            // answers a later compilation's lookup. The outer bucket does not
            // prevent that: a constructed generic like ImmutableArray[SyntaxNode]
            // is keyed by ITS OWN assembly (the host's System.Collections.Immutable,
            // shared by every compilation in the process) while its argument comes
            // from a private reference context.
            // Issue #5038: a host generic definition can contain private-context
            // arguments. Neither the bucket's keys nor values may strongly retain
            // those types. Keep canonical symbols while callers still own them.
            let bucket = Cache.GetValue(type.Assembly, (_ Assembly) -> CacheBucket())
            lock bucket.Gate {
                bucket.Accesses = (bucket.Accesses + 1) % 256
                if bucket.Accesses == 0 {
                    for hash in bucket.Symbols.Keys.ToArray() {
                        let candidates = bucket.Symbols[hash]
                        candidates.RemoveAll(
                            (weak WeakReference[ImportedTypeSymbol]) -> !weak.TryGetTarget(out var _symbol)
                        )
                        if candidates.Count == 0 {
                            bucket.Symbols.Remove(hash)
                        }
                    }
                }
                let key = LoadContextSensitiveTypeComparer.Instance.GetHashCode(type)
                if !bucket.Symbols.TryGetValue(key, out var symbols) {
                    symbols = List[WeakReference[ImportedTypeSymbol]]()
                    bucket.Symbols.Add(key, symbols)
                }
                for var i = symbols.Count - 1; i >= 0; i-- {
                    if !symbols[i].TryGetTarget(out var symbol) {
                        symbols.RemoveAt(i)
                    } else if LoadContextSensitiveTypeComparer.Instance.Equals(symbol.Type, type) {
                        return symbol
                    }
                }
                let created = ImportedTypeSymbol(type)
                symbols.Add(WeakReference[ImportedTypeSymbol](created))
                return created
            }
        }

        /// #313: gets the generic type constructed over one or more in-scope type
        /// parameters (e.g. `List[T]`). Issue #5158: equal constructions share one
        /// instance. Two calls are equal when they pass the same erased closed type
        /// object, the same open definition object and the same argument symbol
        /// objects in the same order.
        /// @param erasedClosedType The type-erased closed CLR type (type parameters projected onto `object`).
        /// @param openDefinition The open generic CLR definition (e.g. `List<>`).
        /// @param typeArguments The symbolic type arguments, possibly containing (cref:TypeParameterSymbol).
        /// @returns The constructed (cref:ImportedTypeSymbol).
        /// @remarks The table is a chain of weak tables, one level per key part. The
        /// symbol at the end of the chain is held through a (cref:WeakReference), not
        /// directly: the symbol refers to every key above it, so a strong value under a
        /// long-lived last key (a primitive argument) would keep the erased type, and
        /// with it the whole reference context, alive. While any caller holds the
        /// symbol, equal calls get the same instance; once all callers drop it, a later
        /// call builds a new one, which nobody can tell apart. Keys use reference
        /// identity, so a symbol from another reference set, another nullability mode
        /// (a nullable or platform-type annotation is a different argument object) or
        /// another argument identity never answers for this one. A missing deduplication
        /// is harmless; an alias would not be. Each symbol is built once under the lock
        /// of its entry and published after it is fully built, and an exception while
        /// building publishes nothing. No collection is iterated, so the table does not
        /// affect ordering or output.
        func GetConstructed(
            erasedClosedType Type?,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol]
        ) ImportedTypeSymbol {
            if erasedClosedType == nil {
                throw ArgumentNullException("erasedClosedType")
            }
            if !CanIntern(typeArguments) {
                return CreateConstructed(erasedClosedType, openDefinition, typeArguments)
            }
            var node = ConstructionRoots.GetValue(erasedClosedType, CreateConstructionNode)
            node = node.GetChild(openDefinition ?? NoOpenDefinition)
            for argument in typeArguments {
                node = node.GetChild(argument)
            }
            lock node {
                let previous = node.Symbol
                if previous != nil && previous.TryGetTarget(out var existing) {
                    CompilationMeasurements.Count("metadata.construction-hits")
                    return existing
                }
                let created = CreateConstructed(erasedClosedType, openDefinition, typeArguments)
                node.Symbol = WeakReference[ImportedTypeSymbol](created)
                CompilationMeasurements.Count("metadata.constructions")
                return created
            }
        }

        /// An array with an unset or null element cannot key the table; the old
        /// behaviour (a fresh symbol or the same exception) applies to it.
        private func CanIntern(typeArguments ImmutableArray[TypeSymbol]) bool {
            if typeArguments.IsDefault {
                return false
            }
            for argument in typeArguments {
                if argument == nil {
                    return false
                }
            }
            return true
        }

        private func CreateConstructed(
            erasedClosedType Type,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol]
        ) ImportedTypeSymbol {
            let argNames = string.Join(", ", typeArguments.Select((a TypeSymbol) -> a?.Name ?? "?"))
            let baseName = openDefinition?.FullName ??
                openDefinition?.Name ??
                erasedClosedType.FullName ??
                erasedClosedType.Name
            let name = "$baseName[$argNames]"
            return ImportedTypeSymbol(name, erasedClosedType, openDefinition, typeArguments)
        }

        internal func TryCreateSemanticAggregate(
            type Type?,
            references ReferenceResolver?,
            @NotNullWhen(true) out aggregate StructSymbol?
        ) bool {
            aggregate = nil
            if type == nil || type.IsPrimitive || type.IsEnum || type.IsGenericParameter || type.IsInterface {
                return false
            }
            // Issue #2291: an externally-referenced assembly that was compiled by
            // the C# compiler (not gsc) never carries the `GSharp.TypeSemantics`
            // marker, even when the type is a genuine C# `record`/`record struct`.
            // Fall back to recognizing the compiler-emitted record SHAPE (the
            // `PrintMembers`/copy-constructor/`<Clone>$`/`EqualityContract`
            // markers every C# record synthesizes) so such a type still resolves
            // to a data-class semantic aggregate and `with`/copy keep working.
            if !ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics) &&
                !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(type, out semantics) {
                return false
            }
            // Issue #2263: a marked *reference* type is an imported `data class`;
            // a marked *value* type is a `data struct` (or a primary-ctor struct).
            // Both build a semantic-aggregate StructSymbol so members, primary
            // constructors and `with`/copy resolve consistently in EVERY position.
            // Guard the payload against a value/reference mismatch so a stale
            // marker can never mis-shape the aggregate.
            if type.IsValueType != semantics!!.IsValueType {
                return false
            }
            // Issue #2278: a generic type's OPEN definition (e.g. `Box<>`,
            // `Pair<,>`) is always excluded, for both a `data class` and a `data
            // struct` — building an aggregate from it would be 0-arity (its
            // members typed by the raw, unsubstituted type parameter) and would
            // shadow every real closed instantiation at construction sites. A
            // CLOSED generic (`Box<int>`, `Pair<K,V>`) is fine: it is a distinct
            // CLR `Type` per instantiation whose `MetadataToken` still matches the
            // marker (tokens are shared between a generic type's open definition
            // and every closed construction), and reflecting over it (fields,
            // properties, methods) yields already-substituted member types — so
            // the aggregate built below is correctly and independently shaped per
            // closed generic type, with no shared/shadowed identity.
            if type.IsGenericTypeDefinition {
                return false
            }
            if !type.IsValueType && !semantics!!.IsData {
                // A plain (non-data) reference class is never marked by the
                // emitter, so only genuine data classes reach here.
                return false
            }
            let consumerAssemblyName = references?.CurrentAssemblyName ?? string.Empty
            // Issue #2263 / #2269: cache the aggregate on the resolver instance so
            // its lifetime is tied to the metadata load context that owns `type`.
            // A process-wide static cache would strongly pin these CLR Types (and
            // their MLC/assemblies) for the whole process, leaking memory across
            // compilations (ResourceLeakRegressionTests) and churning under the
            // parallel test host. When no resolver is available (e.g. a synthetic
            // ImportedClassSymbol), build uncached — the aggregate is structurally
            // determined by `type`, so identity still holds within that scope.
            aggregate = if references != nil {
                references.GetOrAddSemanticAggregate(
                    type,
                    consumerAssemblyName,
                    (t Type, consumer string) -> {
                        return Invariant.Required[StructSymbol](
                            BuildSemanticAggregate(t, consumer),
                            "a marked imported type has a semantic aggregate",
                            expression: "BuildSemanticAggregate(t, consumer)"
                        )
                    }
                )
            } else {
                BuildSemanticAggregate(type, consumerAssemblyName)
            }
            return aggregate != nil
        }

        internal func NormalizeSemanticAggregate(
            type TypeSymbol,
            clrType Type?,
            references ReferenceResolver?
        ) TypeSymbol {
            let nullable = type is NullableTypeSymbol
            let unwrapped = if nullable {
                (cast[NullableTypeSymbol](type)).UnderlyingType
            } else {
                type
            }
            let annotated NullabilityAnnotatedTypeSymbol? = unwrapped as NullabilityAnnotatedTypeSymbol
            let baseType = annotated?.BaseType ?? unwrapped
            // The CLR-keyed aggregate cannot retain unreified generic arguments.
            if baseType is not ImportedTypeSymbol || TypeSymbol.ContainsTypeParameter(baseType) ||
                TypeSymbol.ContainsSameCompilationUserType(baseType) ||
                !TryCreateSemanticAggregate(clrType, references, out var aggregate) {
                return type
            }
            let normalized TypeSymbol = if annotated == nil {
                cast[TypeSymbol](aggregate!!)
            } else {
                cast[TypeSymbol](NullabilityAnnotatedTypeSymbol(aggregate!!, annotated.NullableFlags))
            }
            return if nullable {
                cast[TypeSymbol](NullableTypeSymbol.Get(normalized))
            } else {
                normalized
            }
        }

        /// ADR-0193 §3: (cref:Get) for an audited, nullability-free
        /// conversion — the (cref:ImportedTypeSymbol) twin of
        /// (cref:TypeSymbol.FromClrTypeWithoutNullability), for callers that
        /// need the imported symbol itself rather than (cref:TypeSymbol.FromClrType)'s
        /// primitive and tuple mapping. GSA0007 checks it exactly as it checks that
        /// door: allowed anywhere, except on a signature accessor.
        /// @param type The CLR type.
        /// @param reason Why no declaration nullability applies.
        /// @returns The cached (cref:ImportedTypeSymbol).
        @NullabilityFunnel
        internal func GetWithoutNullability(type Type, reason NullabilityFreeReason) ImportedTypeSymbol {
            return Get(type)
        }

        /// Legacy dispose hook, deliberately a NO-OP since #2341: the cache is
        /// weakly keyed by assembly and holds weak symbol values, so a disposed
        /// context's entries are collectable without process-wide clearing.
        ///
        /// Issue #3826: do NOT reintroduce clearing here as a fix for a
        /// cross-compilation identity bug. Entries surviving a dispose is by
        /// design; entries being FOUND by a different compilation's lookup was the
        /// defect, and that is a property of the key
        /// ((cref:LoadContextSensitiveTypeComparer)), not of the lifetime.
        internal func ClearCache() { }

        internal func IsInitOnlySetter(setter MethodInfo) bool {
            try {
                let requiredModifiers = setter.ReturnParameter.GetRequiredCustomModifiers()
                for modifier in requiredModifiers {
                    if string.Equals(
                        modifier.FullName,
                        "System.Runtime.CompilerServices.IsExternalInit",
                        StringComparison.Ordinal
                    ) {
                        return true
                    }
                }
                return false
            } catch {
                return false
            }
        }

        private func BuildSemanticAggregate(type Type, consumerAssemblyName string) StructSymbol? {
            if !ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics) &&
                !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(type, out semantics) {
                return nil
            }
            let includeInternal = ImportedAssemblySemantics.GrantsInternalAccessTo(type.Assembly, consumerAssemblyName)
            let bindingFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            let fieldBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
            let fieldByToken = Dictionary[int32, FieldSymbol]()
            for field in ClrTypeUtilities.SafeGetFields(type, bindingFlags) {
                if field.IsStatic || !IsVisible(field, includeInternal) || field.IsSpecialName || field.Name.StartsWith(
                    "<",
                    StringComparison.Ordinal
                ) {
                    continue
                }
                let fieldSymbol = FieldSymbol(
                    field.Name,
                    ClrNullability.GetFieldTypeSymbol(field),
                    MapAccessibility(field),
                    isReadOnly: field.IsInitOnly
                )
                fieldBuilder.Add(fieldSymbol)
                fieldByToken[field.MetadataToken] = fieldSymbol
            }
            let propertyBuilder = ImmutableArray.CreateBuilder[PropertySymbol]()
            for property in ClrTypeUtilities.SafeGetProperties(type, bindingFlags) {
                if property.GetIndexParameters().Length != 0 {
                    continue
                }
                let getter MethodInfo? = property.GetMethod
                let setter MethodInfo? = property.SetMethod
                if (getter == nil || !IsVisible(getter, includeInternal)) &&
                    (setter == nil || !IsVisible(setter, includeInternal)) {
                    continue
                }
                let propertyType = ClrNullability.GetPropertyTypeSymbol(property)
                propertyBuilder.Add(
                    PropertySymbol(
                        property.Name,
                        if propertyType is ByRefTypeSymbol byRefProperty {
                            byRefProperty.PointeeType
                        } else {
                            propertyType
                        },
                        GetPropertyAccessibility(property),
                        hasGetter: getter != nil && IsVisible(getter, includeInternal),
                        hasSetter: setter != nil && IsVisible(setter, includeInternal),
                        isAutoProperty: false,
                        isVirtual: (getter ?? setter)?.IsVirtual == true,
                        isOverride: (getter ?? setter) is {} accessor && ClrTypeUtilities.SafeIsOverride(accessor),
                        isStatic: (getter ?? setter)?.IsStatic == true,
                        isInitOnly: setter != nil && IsInitOnlySetter(setter),
                        metadataIsAbstract: (getter ?? setter)?.IsAbstract == true
                    ){ReturnRefKind = RefCapabilities.GetReturnRefKind(property)}
                )
            }
            let primaryConstructorParameters = BuildPrimaryConstructorParameters(
                fieldBuilder.ToImmutable(),
                propertyBuilder.ToImmutable(),
                fieldByToken,
                semantics!!
            )
            ApplyPrimaryConstructorDefaults(type, primaryConstructorParameters)
            let aggregate = StructSymbol(
                name: BuildAggregateDisplayName(type),
                fields: fieldBuilder.ToImmutable(),
                accessibility: MapTypeAccessibility(type),
                declaration: nil,
                packageName: type.Namespace ?? string.Empty,
                isData: semantics!!.IsData,
                isInline: false,
                isClass: !semantics!!.IsValueType,
                primaryConstructorParameters: primaryConstructorParameters,
                isOpen: false,
                baseClass: nil,
                clrType: type
            )
            aggregate.SetProperties(propertyBuilder.ToImmutable())
            aggregate.SetMethods(BuildMethods(type, aggregate, includeInternal))
            aggregate.SetStaticMethods(BuildStaticMethods(type, aggregate, includeInternal))
            let instanceInitBuilder = ImmutableDictionary.CreateBuilder[FieldSymbol, BoundExpression]()
            // Issue #3329: a value struct's ADR-0159 magic-collection field zero
            // value is normally recorded on the DECLARING compilation's own
            // StructSymbol.InstanceFieldInitializers (DeclarationBinder.Structs.cs)
            // — unavailable here, since this aggregate is built purely from
            // reflection over an ALREADY-EMITTED type in another assembly (or,
            // for the REPL, an earlier submission). Reconstruct it from the
            // GSharp.MagicCollectionFields marker so a struct literal `S{}` for
            // this imported type still zero-initializes such a field to its
            // sound empty instance rather than a raw (often null) CLR default.
            // A class needs no reconstruction: its literal always calls the
            // REAL parameterless constructor, which already runs these
            // initializers in-type.
            if semantics!!.IsValueType && ImportedAssemblySemantics.TryGetMagicCollectionFields(
                type,
                out var magicFieldKinds
            ) {
                let fieldsByName = aggregate.Fields.ToDictionary((f FieldSymbol) -> f.Name, StringComparer.Ordinal)
                for (fieldName, kind) in magicFieldKinds!! {
                    if !fieldsByName.TryGetValue(fieldName, out var fieldSymbol) || instanceInitBuilder.ContainsKey(
                        fieldSymbol
                    ) {
                        continue
                    }
                    let reflectedField FieldInfo? = type.GetField(fieldName, bindingFlags)
                    let zeroValue BoundExpression? = if reflectedField != nil {
                        MagicCollectionZeroValue.TrySynthesizeEmptyInstanceFromMarker(
                            reflectedField,
                            kind,
                            fieldSymbol.Type
                        )
                    } else {
                        default(BoundExpression?)
                    }
                    if zeroValue != nil {
                        instanceInitBuilder[fieldSymbol] = zeroValue
                    }
                }
            }
            if instanceInitBuilder.Count > 0 {
                aggregate.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable())
            }
            return aggregate
        }

        /// Issue #2278: renders the aggregate's display name. For a plain
        /// (non-generic) imported data type this is just the CLR type's own
        /// name (matching pre-#2278 behavior). For a CLOSED generic data
        /// type this rebuilds a G#-flavored constructed-generic name (e.g.
        /// `Box[int32]`, `Pair[int32, string]`) from the reflected
        /// arguments rather than surfacing the raw backtick-arity CLR name
        /// (`Box`1`) in diagnostics and hover text.
        /// @param type The reflected CLR type the aggregate is built from.
        /// @returns A display-friendly name for the aggregate.
        private func BuildAggregateDisplayName(type Type) string {
            if !type.IsGenericType || type.IsGenericTypeDefinition {
                return type.Name
            }
            let baseName = StripGenericArity(type.Name)
            let args = type.GetGenericArguments().Select(BuildAggregateDisplayName)
            return "$baseName[${string.Join(", ", args)}]"
        }

        private func StripGenericArity(name string) string {
            let tick = name.IndexOf('`', StringComparison.Ordinal)
            return if tick >= 0 {
                name.Substring(0, tick)
            } else {
                name
            }
        }

        private func BuildPrimaryConstructorParameters(
            fields ImmutableArray[FieldSymbol],
            properties ImmutableArray[PropertySymbol],
            fieldByToken Dictionary[int32, FieldSymbol]?,
            semantics ImportedTypeSemantics
        ) ImmutableArray[ParameterSymbol] {
            if semantics.PrimaryConstructorParameterNames.IsDefaultOrEmpty {
                return ImmutableArray[ParameterSymbol].Empty
            }
            let fieldMap = fields.ToDictionary((f FieldSymbol) -> f.Name, StringComparer.Ordinal)
            let propertyMap = properties.ToDictionary((p PropertySymbol) -> p.Name, StringComparer.Ordinal)
            let tokens = semantics.PrimaryConstructorParameterFieldTokens
            let builder = ImmutableArray.CreateBuilder[ParameterSymbol](
                semantics.PrimaryConstructorParameterNames.Length
            )
            for var i = 0; i < semantics.PrimaryConstructorParameterNames.Length; i++ {
                let name = semantics.PrimaryConstructorParameterNames[i]
                var parameter ParameterSymbol? = nil
                // Prefer the exact backing field recorded by metadata token
                // (issue #1953 follow-up) — this is immune to the parameter name
                // ever diverging from the field name (renames, lowering,
                // mangling). Only fall back to a name-based lookup when no token
                // was recorded (older payload shape) or the token failed to
                // resolve (e.g. a property-backed parameter).
                if !tokens.IsDefaultOrEmpty &&
                    i < tokens.Length &&
                    tokens[i] != 0 &&
                    fieldByToken != nil &&
                    fieldByToken.TryGetValue(tokens[i], out var tokenField) {
                    parameter = ParameterSymbol(name, tokenField.Type)
                } else if fieldMap.TryGetValue(name, out var field) {
                    parameter = ParameterSymbol(name, field.Type)
                } else if propertyMap.TryGetValue(name, out var property) {
                    parameter = ParameterSymbol(name, property.Type)
                }
                if parameter == nil {
                    continue
                }
                builder.Add(parameter)
            }
            return builder.ToImmutable()
        }

        private func ApplyPrimaryConstructorDefaults(type Type, parameters ImmutableArray[ParameterSymbol]) {
            let clrParameters = FindPrimaryConstructor(type, parameters)?.GetParameters() ??
                Array.Empty[ParameterInfo]()
            for var i = 0; i < parameters.Length && i < clrParameters.Length; i++ {
                if TryGetOptionalDefault(clrParameters[i], out var defaultValue) {
                    parameters[i].SetExplicitDefaultValue(defaultValue)
                }
            }
        }

        internal func FindPrimaryConstructor(
            type Type,
            primaryParameters ImmutableArray[ParameterSymbol]
        ) ConstructorInfo? {
            let definition = if type.IsGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
            if !ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics) &&
                !ImportedAssemblySemantics.TryDetectCSharpRecordSemantics(type, out semantics) {
                return nil
            }
            if semantics is not ImportedTypeSemantics shape {
                return nil
            }
            let fields = ClrTypeUtilities.SafeGetFields(
                definition,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            )
            for constructor in ClrTypeUtilities.SafeGetConstructors(
                definition,
                BindingFlags.Public | BindingFlags.Instance
            ) {
                let parameters = constructor.GetParameters()
                if parameters.Length != primaryParameters.Length {
                    continue
                }
                var matches = true
                for var i = 0; i < parameters.Length; i++ {
                    if !string.Equals(parameters[i].Name, primaryParameters[i].Name, StringComparison.Ordinal) {
                        matches = false
                        break
                    }
                    let tokens = shape.PrimaryConstructorParameterFieldTokens
                    let field = if !tokens.IsDefaultOrEmpty && i < tokens.Length && tokens[i] != 0 {
                        fields.FirstOrDefault((candidate FieldInfo) -> candidate.MetadataToken == tokens[i])
                    } else {
                        fields.FirstOrDefault((candidate FieldInfo) -> candidate.Name == primaryParameters[i].Name)
                    }
                    let member MemberInfo? = if field != nil {
                        field
                    } else {
                        definition.GetProperty(
                            primaryParameters[i].Name,
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                        )
                    }
                    if member == nil || !ClrNullability.GetSignatureType(parameters[i]).Equals(
                        ClrNullability.GetSignatureType(member)
                    ) {
                        matches = false
                        break
                    }
                }
                if matches {
                    // Closing can collapse distinct overloads. Keep the selected open MethodDef.
                    return ClrTypeUtilities.FindMetadataDefinition(
                        type,
                        constructor,
                        BindingFlags.Public | BindingFlags.Instance
                    ) as ConstructorInfo
                }
            }
            return nil
        }

        private func TryGetOptionalDefault(parameter ParameterInfo, out value object?) bool {
            value = nil
            try {
                if !parameter.IsOptional && !parameter.HasDefaultValue {
                    return false
                }
                value = parameter.RawDefaultValue
                return value != DBNull.Value && value != Missing.Value
            } catch {
                return false
            }
        }

        private func BuildMethods(type Type, aggregate StructSymbol, includeInternal bool) ImmutableArray[
            FunctionSymbol
        ] {
            let methods = ClrTypeUtilities.SafeGetMethods(
                type,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for method in methods {
                if method.IsSpecialName || !IsVisible(method, includeInternal) {
                    continue
                }
                builder.Add(BuildMethodSymbol(method, aggregate, isStatic: false))
            }
            return builder.ToImmutable()
        }

        private func BuildStaticMethods(type Type, aggregate StructSymbol, includeInternal bool) ImmutableArray[
            FunctionSymbol
        ] {
            let methods = ClrTypeUtilities.SafeGetMethods(
                type,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for method in methods {
                if method.IsSpecialName || !IsVisible(method, includeInternal) {
                    continue
                }
                let symbol = BuildMethodSymbol(method, aggregate, isStatic: true)
                symbol.IsStatic = true
                symbol.StaticOwnerType = aggregate
                builder.Add(symbol)
            }
            return builder.ToImmutable()
        }

        private func BuildMethodSymbol(method MethodInfo, aggregate StructSymbol, isStatic bool) FunctionSymbol {
            let reflectedParameters = method.GetParameters()
            let parameterBuilder = ImmutableArray.CreateBuilder[ParameterSymbol](reflectedParameters.Length)
            for parameter in reflectedParameters {
                parameterBuilder.Add(
                    RefCapabilities.CreateParameterSymbol(
                        parameter,
                        ClrNullability.GetParameterTypeSymbol(parameter),
                        "arg"
                    )
                )
            }
            let parameters = parameterBuilder.MoveToImmutable()
            let returnType = ClrNullability.GetReturnTypeSymbol(method)
            return FunctionSymbol(
                method.Name,
                parameters,
                if returnType is ByRefTypeSymbol byRefReturn {
                    byRefReturn.PointeeType
                } else {
                    returnType
                },
                declaration: nil,
                $package: nil,
                accessibility: MapAccessibility(method),
                receiverType: if isStatic {
                    default(StructSymbol?)
                } else {
                    aggregate
                }
            ){ReturnRefKind = RefCapabilities.GetReturnRefKind(method)}
        }

        private func IsVisible(field FieldInfo, includeInternal bool) bool -> field.IsPublic ||
            (includeInternal && field.IsAssembly)

        private func IsVisible(method MethodBase, includeInternal bool) bool -> method.IsPublic ||
            (includeInternal && method.IsAssembly)

        private func MapTypeAccessibility(type Type) Accessibility {
            if type.IsNested {
                if type.IsNestedPublic {
                    return Accessibility.Public
                }
                if type.IsNestedAssembly {
                    return Accessibility.Internal
                }
                if type.IsNestedFamily {
                    return Accessibility.Protected
                }
                return Accessibility.Private
            }
            return if type.IsPublic {
                Accessibility.Public
            } else {
                Accessibility.Internal
            }
        }

        private func MapAccessibility(field FieldInfo) Accessibility -> if field.IsPublic {
            Accessibility.Public
        } else {
            (
                if field.IsAssembly {
                    Accessibility.Internal
                } else {
                    (
                        if field.IsFamily {
                            Accessibility.Protected
                        } else {
                            Accessibility.Private
                        }
                    )
                }
            )
        }

        private func MapAccessibility(method MethodBase) Accessibility -> if method.IsPublic {
            Accessibility.Public
        } else {
            (
                if method.IsAssembly {
                    Accessibility.Internal
                } else {
                    (
                        if method.IsFamily {
                            Accessibility.Protected
                        } else {
                            Accessibility.Private
                        }
                    )
                }
            )
        }

        private func GetPropertyAccessibility(property PropertyInfo) Accessibility {
            let accessor MethodInfo? = property.GetMethod ?? property.SetMethod
            return if accessor == nil {
                Accessibility.Private
            } else {
                MapAccessibility(accessor)
            }
        }
    }
}
