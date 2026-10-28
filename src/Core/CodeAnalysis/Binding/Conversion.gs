// <copyright file="Conversion.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import System.Collections
import System.Reflection

/// Type conversion classifier.
class Conversion {
    // Issue #1482: the implicit numeric-widening lattice and the numeric
    // primitive set now live in the single authoritative
    // `NumericWideningLattice` helper. Conversion classification and overload
    // "better conversion" ranking both query that one table so they cannot
    // drift apart (they previously disagreed about native-int widening).
    private convenience init(exists bool, isIdentity bool, isImplicit bool) {
        init(exists, isIdentity, isImplicit, false)
    }

    private convenience init(exists bool, isIdentity bool, isImplicit bool, isStructuralProjection bool) {
        init(exists, isIdentity, isImplicit, isStructuralProjection, false)
    }

    private init(
        exists bool,
        isIdentity bool,
        isImplicit bool,
        isStructuralProjection bool,
        requiresPlatformNilCheck bool
    ) {
        Exists = exists
        IsIdentity = isIdentity
        IsImplicit = isImplicit
        IsStructuralProjection = isStructuralProjection
        RequiresPlatformNilCheck = requiresPlatformNilCheck
    }

    /// The container kinds that have argument positions but no generic
    /// argument list. Distinct from the CLR type on purpose: `[]T` and
    /// `[N]T` are both backed by `T[]` (issue #3962), so a CLR
    /// comparison alone would treat `[3]string!` and `[]string` as
    /// one container.
    private enum CompositeContainerKind {
        None,
        Slice,
        FixedArray,
        Rectangular,
        Map,
        Tuple
    }

    /// The three ways a single pair of corresponding type arguments can relate
    /// under ADR-0186 §3 rule 3.
    private enum PlatformArgumentRelation {
        Same,
        Widening,
        IllegalFromPlatform,
        IllegalToPlatform,
        IllegalUnknown,
        IllegalMixed,
        Unrelated
    }

    /// Gets a value indicating whether the conversion exists or not.
    prop Exists bool {
        get;
    }

    /// Gets whether invariant arguments rule out this conversion before structural projection.
    internal prop IsInvariantArgumentMismatch bool -> object.ReferenceEquals(this, InvariantArgumentMismatch)

    /// Gets a value indicating whether the conversion is identity or not.
    prop IsIdentity bool {
        get;
    }

    /// Gets a value indicating whether the conversion is implicit or not.
    prop IsImplicit bool {
        get;
    }

    /// Gets a value indicating whether this conversion constructs a target through ADR-0148 structural
    /// projection.
    prop IsStructuralProjection bool {
        get;
    }

    /// Gets a value indicating whether this conversion carries a platform
    /// value (`T!`) into a destination whose declared type is a
    /// <b>non-null reference type</b>, so ADR-0186 §4's runtime nil check must
    /// be inserted at the coercion point.
    ///
    /// The flag exists because ADR-0186 §4's rule is stated over the
    /// <em>destination's</em> nullability, not over the literal type `T`:
    /// `T! → T`, `T! → object`, `T! → BaseClass` and
    /// `T! → ISomeInterface` are all such destinations and all check,
    /// while `T! → T?`, `T! → object?` and `T! → U!` are not and
    /// do not. Classification is the only place that distinction is available
    /// as a single fact, so it is recorded here rather than re-derived at each
    /// of `BindConversion`'s callers — which is precisely the
    /// per-site-predicate shape ADR-0186 exists to remove.
    prop RequiresPlatformNilCheck bool {
        get;
    }

    /// Gets a value indicating whether the conversion is explicit or not.
    prop IsExplicit bool -> Exists && !IsImplicit

    shared {
        /// States that there's no conversion between the given types.
        let None Conversion = Conversion(exists: false, isIdentity: false, isImplicit: false)

        private let InvariantArgumentMismatch Conversion = Conversion(
            exists: false,
            isIdentity: false,
            isImplicit: false
        )

        /// States that there's an identity conversion between the given types.
        let Identity Conversion = Conversion(exists: true, isIdentity: true, isImplicit: true)

        /// States that there's an implicit conversion between the given types.
        let Implicit Conversion = Conversion(exists: true, isIdentity: false, isImplicit: true)

        /// States that there's an explicit conversion between the given types.
        let Explicit Conversion = Conversion(exists: true, isIdentity: false, isImplicit: false)

        /// ADR-0148: a safe structural projection that constructs a new concrete
        /// target through its public constructor/member surface.
        let StructuralProjection Conversion = Conversion(
            exists: true,
            isIdentity: false,
            isImplicit: true,
            isStructuralProjection: true
        )

        /// ADR-0186 §3/§4: an implicit conversion of a platform value `T!`
        /// into a <b>non-null reference</b> destination. Implicit and operator-free
        /// in the source, but a runtime nil check is inserted at the coercion
        /// point.
        ///
        /// Deliberately <b>not</b> (cref:Identity), for two independent
        /// reasons an implementer will otherwise hit in sequence.
        /// `ConversionClassifier.BindConversion` returns the source expression
        /// untouched on an identity classification, so an identity `T! → T`
        /// would silently reach no materialisation arm and §4's check would never
        /// be emitted anywhere. And the overload ranker prefers identity over
        /// implicit, so an identity `T! → T?` beside an implicit `T! → T`
        /// would invert §3's tie-break, which states the opposite (`T` wins).
        /// Both platform rows are therefore plain implicit conversions,
        /// distinguished by this flag, and §3's tie-break is stated once, in the
        /// ranker, rather than falling out of a classification accident.
        let PlatformChecked Conversion = Conversion(
            exists: true,
            isIdentity: false,
            isImplicit: true,
            isStructuralProjection: false,
            requiresPlatformNilCheck: true
        )

        /// Clasifies the convertibility from one type to the other.
        /// @param from From type.
        /// @param to To type.
        /// @returns The conversion mapping between the two types.
        func Classify(from TypeSymbol, to TypeSymbol) Conversion -> ClassifyCore(
            from,
            to,
            allowStructuralProjection: true
        )

        /// ADR-0186 §3 rule 3, asked about a single ARGUMENT position: is
        /// [`source`](paramref) to [`target`](paramref) one of the
        /// relations a constructed type must <b>not</b> permit — `C[T!]
        /// -> C[T]`, `C[T] -> C[T!]` or `C[T?] -> C[T!]`.
        ///
        /// The companion of (cref:IsPlatformArgumentWidening), and exposed
        /// for the same reason: `MemberLookup`'s symbolic-indexer
        /// applicability check has to reject what rule 3 rejects, and its own
        /// same-type helper deliberately looks through the platform wrapper
        /// (which is the right answer for member hiding and the wrong one here).
        /// @param source The source argument position.
        /// @param target The target argument position.
        /// @returns `true` for a relation rule 3 forbids.
        internal func IsPlatformArgumentIllegal(
            source TypeSymbol?,
            target TypeSymbol?
        ) bool -> IsIllegalPlatformArgumentRelation(RelatePlatformArguments(source, target))

        /// ADR-0186 §3 rule 2, asked about a single ARGUMENT position: is
        /// [`source`](paramref) to [`target`](paramref) the one
        /// widening a constructed type permits, `C[T!] -> C[T?]`.
        ///
        /// Exposed so that `MemberLookup`'s symbolic-indexer applicability
        /// check can ask the same question the conversion classifier asks,
        /// instead of restating the rule. It is deliberately NOT
        /// `Conversion.Classify`: at the top level `T! -> T` is an
        /// implicit (checked) conversion, and admitting that INSIDE an invariant
        /// type argument is precisely the aliasing unsoundness rule 3 exists to
        /// reject.
        /// @param source The source argument position.
        /// @param target The target argument position.
        /// @returns `true` for rule 2's permitted widening.
        internal func IsPlatformArgumentWidening(
            source TypeSymbol?,
            target TypeSymbol?
        ) bool -> RelatePlatformArguments(source, target) == PlatformArgumentRelation.Widening

        internal func IsArrayElementInterface(definition Type) bool -> (
            definition.FullName is "System.Collections.Generic.IEnumerable`1" or
                "System.Collections.Generic.ICollection`1" or
                "System.Collections.Generic.IList`1" or
                "System.Collections.Generic.IReadOnlyCollection`1" or
                "System.Collections.Generic.IReadOnlyList`1"
        )

        /// ADR-0186 §3, asked about a whole <b>container pair</b> rather than a
        /// single argument position: does the rule speak to
        /// [`source`](paramref) to [`target`](paramref) at all, and if
        /// so does it admit the conversion.
        ///
        /// This is the guarded entry (cref:ClassifyCore) itself uses, and
        /// it is the one an outside caller wants. The two per-argument
        /// predicates above assume their container has <b>already</b> been matched
        /// — asked about the containers themselves they have no shape guard, so an
        /// ordinary upcast such as `[]string! -> object`, whose two sides
        /// have no corresponding argument positions to compare, comes back
        /// `Illegal`. This entry declines for such a pair, and for a function
        /// shape, a value-type container and a pair whose platform-ness already
        /// agrees; it answers only for rule 3's three illegal directions and rule
        /// 2's one permitted widening.
        ///
        /// Exposed for `MemberLookup`'s symbolic-indexer applicability check,
        /// which has to ask it <b>before</b> its own same-type fast path — that
        /// helper looks through the platform wrapper by design, which is the right
        /// answer for member hiding and would otherwise pre-empt this rule with
        /// <em>identity</em>.
        /// @param source The source type.
        /// @param target The target type.
        /// @param isImplicit When this returns `true`: whether the conversion is
        /// admitted (rule 2's widening) rather than rejected (rule 3).
        /// @returns `true` when ADR-0186 §3 decides this pair.
        internal func TryRelatePlatformContainer(
            source TypeSymbol?,
            target TypeSymbol?,
            out isImplicit bool
        ) bool -> TryRelatePlatformContainer(source, target, out isImplicit, out _)

        /// Applies ADR-0186 §3 and identifies the illegal direction needed by
        /// imported-call diagnostics.
        /// @param source The source type.
        /// @param target The target type.
        /// @param isImplicit Whether the relation is the legal widening.
        /// @param rejectsImportedParameter Whether a platform source position is exposed as stated non-null.
        /// @returns `true` when rule 3 owns the relation.
        internal func TryRelatePlatformContainer(
            source TypeSymbol?,
            target TypeSymbol?,
            out isImplicit bool,
            out rejectsImportedParameter bool
        ) bool {
            if TryClassifyPlatformTypeArgumentMismatch(
                source,
                target,
                out var conversion,
                out rejectsImportedParameter
            ) {
                isImplicit = conversion.IsImplicit
                return true
            }
            isImplicit = false
            rejectsImportedParameter = false
            return false
        }

        /// Whether a platform type appears anywhere in the type structure.
        /// @param type The type to scan.
        /// @returns `true` when the type contains a platform position.
        internal func ContainsPlatformTypeInStructure(type TypeSymbol?) bool -> ContainsPlatformType(type)

        /// Recognizes source and imported interfaces, including symbolic constructed owners.
        /// @param type The candidate interface type.
        /// @returns Whether the type denotes an interface.
        internal func IsInterfaceLikeType(type TypeSymbol?) bool {
            if (
                type is InterfaceSymbol or
                    SequenceTypeSymbol or
                    AsyncSequenceTypeSymbol or
                    ImportedTypeSymbol and
                    {OpenDefinition: {IsInterface: true}}
            ) {
                return true
            }
            let clr Type? = type?.ClrType
            if clr == nil {
                return false
            }
            // Issue #1100: querying IsInterface on a TypeBuilderInstantiation
            // throws NotSupportedException. A constructed delegate is not an interface.
            try {
                return clr.IsInterface
            } catch (NotSupportedException) {
                return false
            }
        }

        /// Checks the actual runtime relation of a slot already admitted by CLR
        /// applicability; this does not replace a declared nullability contract.
        /// @param source The argument's actual type.
        /// @param target The emitted MethodSpec slot.
        /// @returns Whether their runtime shapes satisfy identity or reference variance.
        internal func HasClrArgumentRuntimeRelation(
            source TypeSymbol,
            target TypeSymbol
        ) bool -> TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(source, target) ||
            (
            !NullableLifting.IsAnyValueTypeNullable(source as NullableTypeSymbol) &&
                (
                IsMapInterfaceReferenceUpcast(source.StripToBareShape(), target.StripToBareShape()) ||
                    TryClassifyConstructedImportedReferenceConversion(
                    source.StripToBareShape(),
                    target.StripToBareShape(),
                    clrArgumentBoundary: true
                )
            )
        )

        /// Classifies only pre-ADR-0148 conversions. Projection planning uses this
        /// to keep member conversion non-recursive.
        /// @param from The source type.
        /// @param to The target type.
        /// @returns The non-structural conversion.
        internal func ClassifyNonStructural(from TypeSymbol, to TypeSymbol) Conversion -> ClassifyCore(
            from,
            to,
            allowStructuralProjection: false
        )

        /// Classifies a conversion, optionally including structural projection.
        /// @param from The source type.
        /// @param to The target type.
        /// @param allowStructuralProjection Whether structural projection is eligible.
        /// @param allowExplicitReference Whether checked reference downcasts are eligible.
        /// @returns The classified conversion.
        internal func ClassifyCore(
            from TypeSymbol?,
            to TypeSymbol?,
            allowStructuralProjection bool,
            allowExplicitReference bool = true
        ) Conversion {
            var from = from
            var to = to
            if to != nil && NativeProtocolMetadata.IsProtocol(to) &&
                from != TypeSymbol.Null &&
                from != TypeSymbol.Error &&
                from is not NullableTypeSymbol &&
                from is not PlatformTypeSymbol &&
                from is not ByRefTypeSymbol &&
                !TypeSymbol.IsByRefLike(from!!) {
                return Implicit
            }
            if NativeSliceTypes.HaveIncompatibleElements(from, to) || ManagedReferenceTypes.HaveIncompatibleElements(
                from!!,
                to!!
            ) {
                return None
            }
            // ADR-0186 §3 rule 3, the container half: `C[T!]`, `C[T]` and `C[T?]`
            // are three DISTINCT constructed types, and exactly one implicit
            // conversion exists between them — `C[T!] -> C[T?]`, recursively.
            //
            // This runs FIRST, ahead of the annotation strip immediately below,
            // because that strip is exactly what would hide the question: a
            // constructed imported generic carries its per-argument nullability on
            // a `NullabilityAnnotatedTypeSymbol` wrapper, and the strip discards it
            // on the documented ground that "inner generic nullability metadata
            // does not change the outer CLR type's conversion rules." For an inner
            // `T?` that is this compiler's long-standing (and separately
            // questionable — see the note on the helper) choice; for an inner `T!`
            // it is the aliasing unsoundness ADR-0186 §3 is written to reject,
            // because `C[T!] -> C[T]` hands a non-null view of a container that may
            // hold nil to a holder who will read it back with no boundary anywhere.
            // The guard matters. When the OUTER type is itself platform-wrapped —
            // `List[string!]!`, which is what an oblivious method returning
            // `List<string>` produces — this arm would otherwise answer the whole
            // question from the type ARGUMENTS alone and hand back a plain
            // implicit conversion, skipping the top-level platform arm below and
            // with it §4's check. `let xs List[string?] = obliviousList()` would
            // then store a nil into a declared slot with no boundary fired
            // anywhere: HIGH-1's hole, one level up. Deferring to
            // `ClassifyPlatformType` instead is correct AND still applies this
            // rule, because its recursion re-enters `ClassifyCore` with the outer
            // wrapper stripped and reaches this arm then.
            if !(from is PlatformTypeSymbol) &&
                !(to is PlatformTypeSymbol) &&
                TryClassifyPlatformTypeArgumentMismatch(from, to, out var platformArgumentMismatch) {
                return platformArgumentMismatch
            }
            // #4479: the inference fix can produce the faithful target
            // `sequence[string!]` for a symbolic `List[string!]`, but the ordinary
            // CLR upcast below cannot prove the cross-context constructed interface
            // relation after nullability is erased. Reuse #4420's hierarchy
            // projection and accept only an exact symbolic argument vector; illegal
            // and variant projections were already decided by the mismatch arm.
            if !(from is NullableTypeSymbol) &&
                !(from is PlatformTypeSymbol) &&
                !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from, to) &&
                TryProjectPlatformArgumentsToSupertype(from, to, out var projectedArguments, out var targetArguments) &&
                projectedArguments.Length == targetArguments
                .Length {
                var exactProjection = true
                for var i = 0; i < projectedArguments.Length; i++ {
                    if RelatePlatformArguments(
                        projectedArguments[i],
                        targetArguments[i]
                    ) != PlatformArgumentRelation.Same {
                        exactProjection = false
                        break
                    }
                }
                if exactProjection {
                    return Conversion.Implicit
                }
            }
            // ADR-0186 §3: the platform type `T!` owns its whole conversion table,
            // and it must own it here, ahead of every arm below.
            //
            // Before this arm existed, `T! -> T` was admitted silently and
            // unconditionally. `PlatformTypeSymbol` relays its underlying's
            // `ClrType` (§1), so the two sides looked like one ordinary reference
            // type to the CLR-assignability arm near the end of this method, which
            // classified the coercion as a no-op reference upcast. The `T? -> T`
            // rejection further down (`from is NullableTypeSymbol
            // fromNullableUpcastSrc ... return None`) is what stops the identical
            // leak for a nullable source — issue #1627's `S? -> S` hole — and a
            // platform wrapper matches none of it. The consequence was not merely a
            // missing diagnostic: §4's check is inserted AT this boundary, so a
            // conversion admitted before the boundary is ever classified is a
            // conversion whose check can never be emitted, no matter where the
            // emission code is written.
            //
            // Placing the arm above the identity/equivalence arms rather than
            // beside the nullable ones is also what closes §3's generic-container
            // hole: `AreRuntimeEquivalentIgnoringReferenceNullability` strips a
            // platform wrapper by design (it answers a question about RUNTIME
            // shape, where `string!` and `string` genuinely are one type), and
            // three separate arms below consult it. Any of them would answer
            // "identity" for `List[string!] -> List[string]`.
            //
            // #4443: it also runs before either side's nullable-flags annotation
            // is stripped just below. The strip keeps
            // the outer CLR shape and drops the argument nullability the flags
            // carry, and the platform arm's rule-3 comparison needs exactly those
            // arguments. With the strip first, `List[string!]! -> List[string!]`
            // (an oblivious list whose top level inference stripped, the
            // destination held as the flags-annotated `List<string>`) compared its
            // `string!` element against the bare base's `string` and was rejected
            // as rule 3's `C[T!] -> C[T]`. The platform arm reads annotated
            // arguments itself (`TryGetConstructedGenericArguments`) and re-enters
            // this method for the underlying pair, which strips them then.
            if from is PlatformTypeSymbol || to is PlatformTypeSymbol {
                return ClassifyPlatformType(from!!, to!!, allowStructuralProjection, allowExplicitReference)
            }
            // Imported aggregates and explicit constructions must compare decoded arguments before the annotation carrier is removed.
            // Preserve invariant contracts, including nullable positions nested inside an argument.
            let aggregateFrom = UnwrapPlatformAndNullable(from)
            let aggregateTo = UnwrapPlatformAndNullable(to)
            if (aggregateFrom?.StripToBareShape() is StructSymbol || aggregateTo?.StripToBareShape() is StructSymbol) &&
                TryGetConstructedGenericShape(
                aggregateFrom,
                out var aggregateFromOpen,
                out var aggregateFromArguments
            ) &&
                TryGetConstructedGenericShape(aggregateTo, out var aggregateToOpen, out var aggregateToArguments) &&
                ClrTypeUtilities
                .AreSame(aggregateFromOpen, aggregateToOpen) {
                if from is NullableTypeSymbol && to is not NullableTypeSymbol {
                    return Conversion.None
                }
                if aggregateFromArguments.Length != aggregateToArguments.Length {
                    return Conversion.None
                }
                for var i = 0; i < aggregateFromArguments.Length; i++ {
                    if !HaveIdenticalTypeArgumentContracts(aggregateFromArguments[i], aggregateToArguments[i]) {
                        return InvariantArgumentMismatch
                    }
                }
                return if from is not NullableTypeSymbol && to is NullableTypeSymbol {
                    Conversion.Implicit
                } else {
                    Conversion.Identity
                }
            }
            // Inner generic nullability metadata does not change the outer CLR type's
            // conversion rules. Expose the symbolic generic/interface shape beneath
            // it before applying identity, hierarchy, and variance classification.
            while from is NullabilityAnnotatedTypeSymbol fromAnnotated {
                from = fromAnnotated.BaseType
            }
            while to is NullabilityAnnotatedTypeSymbol toAnnotated {
                to = toAnnotated.BaseType
            }
            from = Invariant.Required(from, "conversion classification always has a source type", expression: "from")
            to = Invariant.Required(to, "conversion classification always has a target type", expression: "to")
            if from == to {
                return Conversion.Identity
            }
            // Issue #3093: sequence[T] is an identity alias, not merely a
            // reference conversion, for the matching enumerable interface.
            //
            // Issue #3997: the arm must not also erase the `?`. Its shape probe
            // reaches a `NullableTypeSymbol` through the final `ClrType` fallback
            // (a nullable RELAYS its underlying's CLR type — the same relay that
            // produced issue #1627's leak), and
            // `AreRuntimeEquivalentIgnoringReferenceNullability` then answers
            // `true` for `sequence[int32]?` against `sequence[int32]` by
            // construction. So a nullable enumerable reaching a NON-nullable
            // enumerable slot was classified IDENTITY: measured on the parent
            // commit, `takes(s)` with `s (sequence[int32])?` at `sequence[int32]`
            // compiled silently, as did `IEnumerable[int32]?` at
            // `IEnumerable[int32]` — while `string?`, `List[int32]?`,
            // `Dictionary[string, int32]?` and `map[string, int32]?` all
            // correctly reported GS0154 at their own non-nullable forms. The
            // enumerable shapes were the only reference types in the language
            // exempt from Kotlin-model null safety, and only because this alias
            // arm ran before the rules that enforce it. Declining here lets the
            // conversion fall through to the ordinary explicit-reference arm,
            // which classifies the annotation-dropping `S? -> S` exactly as it
            // does for every other reference type.
            //
            // Only this direction is restricted. `sequence[T] -> IEnumerable[T]?`
            // and `sequence[T]? -> IEnumerable[T]?` keep the alias identity: they
            // ADD or PRESERVE the annotation and drop nothing.
            if SequenceTypeSymbol.TryGetEnumerableInterfaceShape(from, out _, out _) &&
                SequenceTypeSymbol.TryGetEnumerableInterfaceShape(to, out _, out _) &&
                !(from is NullableTypeSymbol && !(to is NullableTypeSymbol)) &&
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from, to) {
                return Conversion.Identity
            }
            // Issue #3566: IEnumerable<T> (and its sequence[T] alias) implements
            // the non-generic System.Collections.IEnumerable BY DEFINITION, but
            // the reflection walk cannot prove it when the element type is a
            // MetadataLoadContext type constructed onto the runtime
            // IEnumerable<> definition (a hybrid constructed type whose
            // interface set is unreadable). Answer semantically so the
            // non-generic self-parameter of OfType/Cast binds. IAsyncEnumerable
            // shapes are excluded — they do not implement IEnumerable.
            if SequenceTypeSymbol.TryGetEnumerableInterfaceShape(from, out var fromEnumerableDefinition, out _) &&
                fromEnumerableDefinition?.FullName == "System.Collections.Generic.IEnumerable`1" &&
                to
                .ClrType
                ?.FullName == "System.Collections.IEnumerable" {
                return Conversion.Implicit
            }
            // Issue #2290: a referenced (cross-assembly) type can be independently
            // re-minted into TWO non-reference-equal TypeSymbol wrappers for the
            // SAME underlying CLR type — e.g. an imported `data class`/`data
            // struct` resolves to its semantic-aggregate StructSymbol via one
            // binding path (issue #2263) but to a plain ImportedTypeSymbol via
            // another, or the very same ImportedTypeSymbol-eligible type is
            // reflected through two distinct (but metadata-equivalent) `Type`
            // instances — e.g. resolved via a fully-qualified name in one spot and
            // brought into scope via `import` in another, each hitting the
            // per-Type cache with a different `Type` object when the two lookups
            // do not share reference identity. Only the two symbol kinds that
            // ever wrap a REAL referenced CLR type (`ImportedTypeSymbol`, and a
            // `StructSymbol` semantic aggregate built for an imported data type —
            // recognized by its non-null `ClrType`, since a same-compilation
            // user `struct`/`data struct` has none while binding) participate:
            // this deliberately excludes wrapper symbols (e.g.
            // `NullableTypeSymbol`) that merely borrow their underlying type's
            // `ClrType` without denoting the SAME type. Whenever both sides
            // qualify and their CLR types are the same underlying metadata type
            // (`ClrTypeUtilities.AreSame`, safe across a MetadataLoadContext
            // boundary), the two symbols denote one identical type — treat the
            // conversion as identity rather than reporting a confusing "Cannot
            // convert type 'X' to 'X'"-looking error.
            if IsImportedTypeIdentity(from) &&
                IsImportedTypeIdentity(to) &&
                (
                !(RequiresSymbolicTypeArgumentIdentity(from) || RequiresSymbolicTypeArgumentIdentity(to)) ||
                    TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from, to)
            ) &&
                ClrTypeUtilities.AreSame(from.ClrType, to.ClrType) {
                return Conversion.Identity
            }
            // Issue #2299: the #2290 check above only handles a DIRECT
            // ImportedTypeSymbol/StructSymbol-aggregate pair. The identical
            // cross-context split just as easily reaches one level down, through
            // a structural wrapper symbol that itself is deliberately excluded
            // from the direct check above (its `ClrType` is merely borrowed from
            // its element, so comparing the WRAPPER's `ClrType` would be wrong —
            // e.g. two `[]Series` wrappers whose CLR array types are already
            // reference-distinct even for the SAME element). Whenever both sides
            // are the SAME wrapper kind (`[]T` slice, `T?` nullable, `T&`/`T*`
            // byref/pointer, `seq[T]`, `chan[T]`, an async sequence, a
            // fixed-length array of matching length, or a `map[K]V`), recurse
            // into the wrapped element type(s) via `Classify` itself — reusing
            // the direct check (and this same recursive step, so nested wrappers
            // like `[]?Series` or `[][]Series` unwind depth-first) rather than
            // duplicating the cross-context comparison logic per wrapper kind.
            if from != nil && to != nil && from.GetType() == to.GetType() &&
                TryClassifyWrappedElementIdentity(from, to) {
                return Conversion.Identity
            }
            // Issue #3987: the arm above is guarded by `from.GetType() ==
            // to.GetType()` — the SAME wrapper kind on both sides. A `map[K, V]`
            // IS a `Dictionary<K, V>` and a G# tuple IS a `System.ValueTuple<…>`
            // (ADR-0104 / ADR-0158 identity), so the two spellings of one type are
            // routinely a `MapTypeSymbol`/`ImportedTypeSymbol` (or
            // `TupleTypeSymbol`/`ImportedTypeSymbol`) pair, which that guard
            // rejects. With CLOSED elements nothing noticed, because the
            // `ClrType` comparison at the top of this method answered first; once
            // an element is open those `ClrType`s stop identifying the types — the
            // structural side's is null (`MapTypeSymbol.MakeClrType` gives up the
            // moment a key or value has no CLR backing) and the imported side's is
            // the ADR-0004 type-ERASED `Dictionary<object, object>` — so there was
            // no rule left, and `makeMap[K, V](entries map[K, V])` could not pass
            // `entries` to a `Dictionary[K, V]` parameter that is the very same
            // type. This is
            // the same move #3976 made for channels — the lattice reads the types,
            // not the spelling.
            //
            // Like the channel lattice, this OWNS the pair it recognises when one
            // side's element is open: `Dictionary<K, V>` and `ValueTuple<…>` are
            // invariant, so over an open element the ONLY relation that exists is
            // element-wise identity, and anything else has no runtime conversion to
            // emit. Saying so here is what lets #3984's local canonicalization go:
            // that rewrite was rejecting `(int32, object)` at a `ValueTuple[int32,
            // T]` slot by restating it as a `TupleTypeSymbol` pair, and without a
            // rule of its own the general imported machinery quietly accepted the
            // pair and left ILVerify's StackUnexpected in the emitted constructor.
            if from != nil &&
                to != nil &&
                TryClassifyStructuralSpellingConversion(from, to, out var structuralSpelling) {
                return structuralSpelling
            }
            // Issue #4011: the arm above taught the lattice that `map[K, V]` IS
            // `Dictionary<K, V>` by SHAPE once an element is open. It stopped at
            // the concrete CLASS, so the INTERFACES that class implements —
            // `IDictionary[K, V]`, `IReadOnlyDictionary[K, V]`,
            // `ICollection`/`IReadOnlyCollection`/`IEnumerable` of
            // `KeyValuePair[K, V]` — kept reporting `GS0155` while the CLOSED
            // spelling of the very same conversion (`map[string, int32]` at an
            // `IDictionary[string, int32]`) was accepted. The closed one is
            // accepted because the map has a real `Dictionary<string, Int32>`
            // `ClrType` for the reflective assignability check to read;
            // `MapTypeSymbol.MakeClrType` gives up the moment a key or value has
            // no CLR backing, so the open one had nothing left to read and no rule
            // of its own. Same family as #3982 (a channel at an open imported
            // parameter) and #3877 (extension lookup through the same erasure):
            // the symbolic answer was simply never consulted.
            //
            // The conversion is IMPLICIT and one-way. A `map[K, V]` really is a
            // `Dictionary<K, V>` at run time and a `Dictionary<K, V>` really does
            // implement all five, so this is a plain reference upcast that emits
            // nothing — exactly what the closed spelling already does. The reverse
            // direction is deliberately absent: an `IDictionary[K, V]` is not
            // necessarily a `Dictionary[K, V]`, and this arm must not become the
            // identity rule that `MapTypeSymbol.TryGetMapShape` would have made it
            // had the interfaces been folded into the SHAPE probe instead.
            if from != nil && to != nil && TryClassifyMapInterfaceConversion(from, to, out var mapInterface) {
                return mapInterface
            }
            // ADR-0174 D1/D2: the channel lattice. `chan[T]` IS `Channel<T>` (and
            // the runtime's constructed `Chan<T>` is one too), so a same-direction
            // pair over an identical element is identity in either direction
            // (inbound: a foreign `Channel<T>`/`ChannelReader<T>` flows into
            // `chan[T]`/`in chan[T]` with no adapter; outbound: a `chan[T]` is
            // passed to a C# `Channel<T>` parameter). Narrowing a bidirectional
            // handle to `in`/`out` is implicit (emitted as `get_Reader`/`get_Writer`);
            // the reverse, and `in` <-> `out`, do not exist — this is what makes
            // channel ownership checkable (pattern 9).
            if TryClassifyChannelConversion(from, to, out var channelConversion) {
                return channelConversion
            }
            // Issue #2354 follow-up: a generic G# class's own `this` parameter is
            // bound with the OPEN generic definition as its type (`TypeArguments`
            // empty, `IsGenericDefinition == true` — see FunctionSymbol.ThisParameter
            // / DeclarationBinder's `receiverType: structSymbol`), while a
            // self-referential member-signature type written explicitly in source
            // (e.g. a method declared `func Self() Box[T]` inside `class Box[T]`)
            // is bound through the ordinary type-clause binder, which calls
            // `StructSymbol.Construct(definition, [T])` — a DIFFERENT StructSymbol
            // instance whose `TypeArguments` is the class's own type parameter list
            // spelled out explicitly. Both denote the exact same type (an open
            // self-instantiation), but `StructSymbol` has no structural
            // Equals/== override (reference identity only), so `return this` inside
            // such a method previously failed with a confusing self-referential
            // `GS0155 "Cannot convert type 'Box' to 'Box'"`. Recognize the two
            // shapes as identical here: same `Definition`, and each side's
            // "effective" type-argument list — defaulting an open definition's
            // (empty) `TypeArguments` to its own `TypeParameters` — pairwise
            // convert as identity (recursing through `Classify` itself so a nested
            // self-reference, e.g. `Wrapper[Box[T]]`, also unwinds correctly).
            if from is StructSymbol fromSelfStruct &&
                to is StructSymbol toSelfStruct &&
                AreSameConstructedStructIdentity(fromSelfStruct, toSelfStruct) {
                return Conversion.Identity
            }
            // Issue #1018: the bottom (`never`) type of a throw-expression is
            // implicitly convertible to ANY target type — a throw never yields a
            // value, so it satisfies any target without a runtime conversion.
            if from == TypeSymbol.Never {
                return Conversion.Implicit
            }
            // Issue #1196: a generic type parameter `T` is implicitly convertible
            // to any interface (or base class) in its (transitive) constraint set.
            // Mirrors C# §10.2.12 (implicit reference conversions involving type
            // parameters): an identity / implicit reference conversion exists from
            // `T` to its effective interface set and to any base-class constraint.
            // The interface/base-class rule above is materialised by the emitter
            // with `box T` (a no-op for reference `T`), so a value-type or
            // reference-type argument both satisfy the interface-typed slot.
            //
            // NOTE: the interface/base rule above deliberately does NOT cover
            // `T -> object`; that genuine-object case is handled by the dedicated
            // #1540 rule below, which is safe because erased `!0` slots are
            // substituted back to their real `T` before this classifier runs (see
            // the extended comment on that rule).
            if from is TypeParameterSymbol fromTypeParam &&
                to != nil &&
                !(to is TypeParameterSymbol) &&
                TypeParameterConvertsTo(fromTypeParam, to) {
                return Conversion.Implicit
            }
            // Issue #3421 review follow-up: C# permits an explicit conversion from
            // any type parameter to any interface. The runtime boxes the generic
            // value, then checks the boxed reference against the interface. The
            // constraint-proven implicit case returned above; this arm covers the
            // otherwise-unconstrained checked cast.
            if from is TypeParameterSymbol && IsInterfaceLikeType(to) {
                return Conversion.Explicit
            }
            // Issue #1540: a generic type parameter `T` is ALWAYS implicitly
            // convertible to a GENUINE `object` slot — a boxing conversion for a
            // value `T`, a reference conversion for a reference `T`, and `box !!T`
            // (valid for both) for an unconstrained `T`. Mirrors C# §10.2.12: an
            // implicit reference/boxing conversion exists from any `T` to `object`.
            // This covers the implicit forms (`return val` with an `object` return
            // type, `let o object = val`, passing `T` to an `object` parameter) and,
            // since the conversion `Exists`, the explicit form `object(val)` too.
            //
            // Why this does NOT re-break #1196 (the erased-slot spurious box):
            // an ERASED open generic parameter slot (e.g. the `!0` element type of
            // `List[T].Add(!0)`) is presented as `object` ONLY at the raw CLR
            // signature level. Before this classifier is consulted for such a call,
            // `ConversionClassifier.BindClrParameterConversions` substitutes the
            // receiver's type arguments back into the open `!0` slot, so the target
            // type is the REAL type parameter `T` (not `object`) and the argument is
            // classified as `T -> T` identity with NO conversion node and NO box.
            // A `T -> object` conversion node is therefore only ever created for a
            // GENUINE `System.Object` destination, where boxing is correct. The
            // emitter materialises it with `box !!T` (see MethodBodyEmitter.
            // Conversions.cs), verifier-correct for value, reference and
            // unconstrained `T` alike.
            if from is TypeParameterSymbol && !(to is TypeParameterSymbol) && to?.ClrType?.IsSameAs(
                typeof(object)
            ) == true {
                return Conversion.Implicit
            }
            // ADR-0122 / issue #1014: unmanaged pointer conversions.
            // * pointer -> pointer: explicit reinterpret (e.g. `(byte*)p`).
            // * pointer <-> nint/nuint: explicit round-trip (IntPtr.ToPointer()).
            // * nil -> pointer: implicit null pointer.
            // These share the native-int CLR representation, so emit is a no-op
            // (or `conv.i` for narrower integer sources).
            if from is PointerTypeSymbol || to is PointerTypeSymbol {
                if from == TypeSymbol.Null && to is PointerTypeSymbol {
                    return Conversion.Implicit
                }
                if from is PointerTypeSymbol && to is PointerTypeSymbol {
                    return Conversion.Explicit
                }
                let nativeIntPartner TypeSymbol? = if to is PointerTypeSymbol {
                    from
                } else {
                    to
                }
                if nativeIntPartner != nil &&
                    (
                    nativeIntPartner == TypeSymbol.NInt ||
                        nativeIntPartner == TypeSymbol.NUInt ||
                        nativeIntPartner == TypeSymbol.Int32 ||
                        nativeIntPartner == TypeSymbol.UInt32 ||
                        nativeIntPartner == TypeSymbol.Int64 ||
                        nativeIntPartner == TypeSymbol.UInt64 ||
                        TypeSymbol.IsLegalPointeeType(nativeIntPartner)
                ) {
                    return Conversion.Explicit
                }
                return Conversion.None
            }
            // ADR-0122 §9 / issue #1035: function-pointer conversions.
            // * fnptr -> fnptr: explicit reinterpret.
            // * fnptr <-> nint/nuint/IntPtr/integer: explicit round-trip (an
            //   unmanaged function pointer is just an address-sized integer).
            // * nil -> fnptr: implicit null pointer.
            if from is FunctionPointerTypeSymbol || to is FunctionPointerTypeSymbol {
                if from == TypeSymbol.Null && to is FunctionPointerTypeSymbol {
                    return Conversion.Implicit
                }
                if from is FunctionPointerTypeSymbol && to is FunctionPointerTypeSymbol {
                    return Conversion.Explicit
                }
                let fpPartner = if to is FunctionPointerTypeSymbol {
                    from
                } else {
                    to
                }
                if fpPartner == TypeSymbol.NInt ||
                    fpPartner == TypeSymbol.NUInt ||
                    fpPartner == TypeSymbol.Int32 ||
                    fpPartner == TypeSymbol.UInt32 ||
                    fpPartner == TypeSymbol.Int64 ||
                    fpPartner == TypeSymbol.UInt64 ||
                    fpPartner is PointerTypeSymbol {
                    return Conversion.Explicit
                }
                return Conversion.None
            }
            // Issue #813: a G# `TupleTypeSymbol` and an imported CLR
            // `System.ValueTuple<…>` instantiation denote the same type when
            // their closed CLR backings agree. The former is produced by tuple
            // literals (`yield (idx, v)`) and tuple type syntax; the latter
            // appears when a fully-closed tuple element is recovered from a
            // generic signature like `IEnumerable[(int32, string)]` whose
            // element type round-trips through `TypeSymbol.FromClrType`. Treat
            // them as identity so iterators returning tuple element types
            // accept tuple literals.
            if IsTupleClrEquivalent(from, to) {
                return Conversion.Identity
            }
            // ADR-0172: element names are metadata over the positional shape —
            // two tuples whose shapes agree (recursively ignoring names) denote
            // the SAME type, related by an identity conversion, exactly like C#.
            // `WithoutNames()` returns the canonical unnamed interned symbol, so
            // reference equality decides shape identity. The name-mismatch
            // warning (GS0541) is reported at conversion-binding time, not here —
            // classification is pure.
            if from is TupleTypeSymbol fromNamedTuple && to is TupleTypeSymbol toNamedTuple && !object.ReferenceEquals(
                fromNamedTuple,
                toNamedTuple
            ) &&
                object.ReferenceEquals(fromNamedTuple.WithoutNames(), toNamedTuple.WithoutNames()) {
                return Conversion.Identity
            }
            // Issue #1256: element-wise tuple conversion. A tuple `(T1, …, Tn)`
            // converts implicitly to `(U1, …, Un)` when both are tuple types of
            // the SAME arity and EACH element `Ti → Ui` has an implicit conversion
            // (identity, reference/interface upcast, nullable-reference upcast,
            // numeric widening, boxing, …). Mirrors C# §10.2.13 implicit tuple
            // conversions — the element conversions are classified recursively via
            // `Classify`, so this composes with every existing implicit rule
            // (including the #1255 lifted nullable-reference upcast). Identical
            // tuples are already returned as identity by the `from == to`
            // short-circuit (tuple symbols are cached per element sequence), so a
            // match here is always a NON-identity implicit conversion: the emitter
            // (via binder lowering in ConversionClassifier) rebuilds the target
            // `ValueTuple<…>` from per-element converted accesses, because two
            // distinct `ValueTuple<…>` instantiations are not IL-reinterpretable.
            // When any element lacks an implicit conversion (e.g. a downcast
            // `Base → Derived`, or `int32 → string`) or the arities differ, this
            // branch declines and the conversion falls through to `None`, so such
            // tuples remain errors exactly as C# requires.
            if from is TupleTypeSymbol fromTuple && to is TupleTypeSymbol toTuple && fromTuple.Arity == toTuple.Arity {
                var allElementsImplicit = true
                for var i = 0; i < fromTuple.Arity; i++ {
                    let elementConversion = Classify(fromTuple.ElementTypes[i], toTuple.ElementTypes[i])
                    if !elementConversion.Exists || !elementConversion.IsImplicit {
                        allElementsImplicit = false
                        break
                    }
                }
                if allElementsImplicit {
                    return Conversion.Implicit
                }
            }
            // #313: two erased generics constructed over the same open definition
            // with structurally-equivalent symbolic arguments (e.g. the `List[T]`
            // parameter type and the `List[T]` declared return type) are distinct
            // symbol instances but denote the same type. Treat them as identity so
            // `return items` inside a generic function binds.
            // Issue #1088 extends this to the same-compilation user-type-argument
            // case (e.g. `Channel[BufferEntry]`), where one side's `ClrType` erases
            // to `Channel`1[object]` (or is null entirely) while both carry the
            // same symbolic argument. Comparing the SYMBOLIC type arguments — rather
            // than the erased `ClrType` — lets `let ch Channel[BufferEntry] = ...`
            // bind even though `BufferEntry` has a null `ClrType` during binding.
            if from is ImportedTypeSymbol fromGeneric &&
                to is ImportedTypeSymbol toGeneric &&
                fromGeneric.OpenDefinition != nil &&
                toGeneric.OpenDefinition != nil &&
                (fromGeneric.HasSubstitutableTypeArgument || toGeneric.HasSubstitutableTypeArgument) &&
                AreConstructedGenericsIdentical(fromGeneric, toGeneric) {
                return Conversion.Identity
            }
            // Issue #1420: identity between a CLR-backed closed constructed generic
            // (e.g. `Span<System.Int32>` recovered from a BCL signature such as
            // `CollectionsMarshal.AsSpan`, whose symbolic `TypeArguments` are empty
            // because the closed shape is fully described by its `ClrType`) and a
            // SYMBOLICALLY constructed generic produced by substituting an
            // extension's open receiver (e.g. `Span[T]` with `{T: int32}` →
            // `Span[int32]`). Substitution cannot rebuild the real closed CLR type
            // via `MakeGenericType` because the primitive alias `int32` carries the
            // RUNTIME `System.Int32` while the open `Span<>` came from a
            // MetadataLoadContext (mixing the two throws), so the substituted form
            // stays symbolic with an erased `ClrType`. Comparing the two structurally
            // — normalizing the CLR-backed side's generic arguments through
            // `TypeSymbol.FromClrType` so a BCL `System.Int32` and the alias `int32`
            // collapse to the SAME `TypeSymbol` — lets the generic-extension receiver
            // bind instead of failing GS0155.
            if from is ImportedTypeSymbol fromImported &&
                to is ImportedTypeSymbol toImported &&
                AreConstructedGenericShapesIdentical(fromImported, toImported) {
                return Conversion.Identity
            }
            // Issue #2523: a constructed imported reference type may carry
            // symbolic arguments that its erased CLR shape cannot represent. For
            // example, imported generic inference can surface
            // IIncludableQueryable<TEntity, TProperty?> symbolically while its
            // reflection probe shape is IIncludableQueryable<object, object>.
            // Testing that erased shape against IQueryable<TEntity> loses the
            // declared base-interface substitution and rejects a valid upcast.
            //
            // Project the source's open interface/base hierarchy through its
            // symbolic arguments, then classify the resulting constructed target
            // with ordinary CLR variance rules. This is framework-independent and
            // applies equally to imported interfaces/classes, inferred or explicit
            // method arguments, nested generic arguments, and cross-context CLR
            // identities.
            if (from is ImportedTypeSymbol || from is SequenceTypeSymbol || from is AsyncSequenceTypeSymbol) &&
                TryClassifyConstructedImportedReferenceConversion(from, to) {
                return Conversion.Implicit
            }
            // Phase 3.C.1 / ADR-0001: T → T? is an implicit widening; T? → T?
            // when underlyings match is identity. T? → T requires the bang
            // operator (Phase 3.C.3) and is not implicit here.
            if to is NullableTypeSymbol toNullable {
                if from == TypeSymbol.Null {
                    return Conversion.Implicit
                }
                if from is NullableTypeSymbol fromNullable {
                    if fromNullable.UnderlyingType == toNullable.UnderlyingType {
                        return Conversion.Identity
                    }
                    // Issues #1236/#2616: lift both implicit and explicit numeric
                    // conversions through Nullable<T>. Compound char assignment
                    // uses the explicit int32? -> char? direction; ordinary
                    // widening remains implicit.
                    if fromNullable
                        .UnderlyingType
                        ?.ClrType is {IsValueType: true} fromNullableClr &&
                        toNullable
                        .UnderlyingType
                        ?.ClrType is {IsValueType: true} toNullableClr &&
                        NumericWideningLattice.IsNumericPrimitive(fromNullableClr.FullName) &&
                        NumericWideningLattice
                        .IsNumericPrimitive(toNullableClr.FullName) {
                        let liftedUnderlying = Classify(fromNullable.UnderlyingType, toNullable.UnderlyingType)
                        if liftedUnderlying.Exists && !liftedUnderlying.IsIdentity {
                            return if liftedUnderlying.IsImplicit {
                                Conversion.Implicit
                            } else {
                                Conversion.Explicit
                            }
                        }
                    }
                    // Issue #1255: lifted nullable reference upcast — `T? → U?` is an
                    // implicit conversion whenever the underlying `T → U` is an
                    // implicit reference/interface upcast (T derives from or
                    // implements U). This mirrors the non-null #1121 rule (`T → U?`)
                    // for the nullable-source case so the two stay consistent. For
                    // reference-type underlyings a nullable wrapper shares the CLR
                    // representation of the bare reference (null stays null, a
                    // non-null value reference-upcasts), so this is a representation-
                    // preserving no-op conversion — never boxing or wrapping. The
                    // value-type underlying case is handled by the lifted numeric
                    // rule above and intentionally excluded here. Note this never
                    // makes `T? → U` (non-nullable target, handled below) implicit,
                    // so the narrowing null-dropping conversion still errors.
                    let fromUnderlying = Invariant.Required(
                        fromNullable.UnderlyingType,
                        "a nullable source has an underlying type",
                        expression: "fromNullable.UnderlyingType"
                    )
                    let toUnderlying = Invariant.Required(
                        toNullable.UnderlyingType,
                        "a nullable target has an underlying type",
                        expression: "toNullable.UnderlyingType"
                    )
                    if IsReferenceLikeTarget(fromUnderlying) && IsReferenceLikeTarget(toUnderlying) {
                        let underlyingConversion = ClassifyCore(
                            fromUnderlying,
                            toUnderlying,
                            allowStructuralProjection: false,
                            allowExplicitReference
                        )
                        if underlyingConversion.Exists && underlyingConversion.IsImplicit {
                            return Conversion.Implicit
                        }
                        if allowExplicitReference && HasCheckedReferenceConversion(fromUnderlying, toUnderlying) {
                            return Conversion.Explicit
                        }
                    }
                    // Issue #2229: lifted boxing — `T? → U?` where `T` is a value
                    // type and `U` is reference-like (e.g. `int32? → object?`) is
                    // implicit whenever the bare `T → U` boxing conversion is
                    // implicit. Unlike the reference-upcast arm above, this DOES
                    // change representation: a `HasValue == false` source becomes an
                    // actual `null` reference and a `HasValue == true` source boxes
                    // its underlying value. `BindConversion` materialises this as a
                    // `BoundConversionExpression` so emit inserts the box.
                    if fromNullable.UnderlyingType?.ClrType is {IsValueType: true} {
                        let boxedConversion = Classify(fromUnderlying, toUnderlying)
                        if boxedConversion.Exists && boxedConversion.IsImplicit {
                            return Conversion.Implicit
                        }
                    }
                    // Issue #2492: nullable annotations on boxed/reference sources
                    // do not remove C#'s explicit unboxing conversion to a nullable
                    // value type. `object?` / `I?` -> `T?` lowers to
                    // `unbox.any Nullable<T>`: null becomes an empty nullable, a
                    // boxed T becomes a present nullable, and a mismatched box
                    // throws InvalidCastException. Keep this explicit-only and
                    // symbol-aware so primitive/imported/user enum or struct
                    // targets and `[T struct] T?` all share the same rule.
                    if HasExplicitUnboxingConversion(fromUnderlying, toNullable) {
                        return Conversion.Explicit
                    }
                    return Conversion.None
                }
                // Issue #1283 cycle 5: imports in separate source files can mint
                // distinct symbols for the same referenced CLR type. Compare the
                // bare source with the nullable underlying through the ordinary
                // identity classifier instead of reference equality.
                if ClassifyNonStructural(
                    Invariant.Required(from, "conversion classification has a source type", expression: "from"),
                    Invariant.Required(
                        toNullable.UnderlyingType,
                        "a nullable target has an underlying type",
                        expression: "toNullable.UnderlyingType"
                    )
                ).IsIdentity {
                    return Conversion.Implicit
                }
                // Issue #1121: a non-nullable T is implicitly convertible to U?
                // whenever T is implicitly convertible to its underlying U. This
                // combines a reference upcast (to a base class or an implemented
                // interface of T) with nullable wrapping into a single implicit
                // conversion — a non-null reference is always a valid U?. For a
                // reference-type underlying U the nullable wrap is a representation
                // no-op, so we defer to the full implicit-conversion classification
                // of `T → U` (identity, reference/upcast, interface implementation,
                // boxing-to-object). Restricted to reference-like underlying targets
                // so numeric nullable lifting (e.g. int32 → int64?) is unaffected.
                if IsReferenceLikeTarget(toNullable.UnderlyingType) {
                    // Issue #3218: honor the caller's structural-projection
                    // eligibility and PRESERVE the projection classification when
                    // the underlying `T → U` conversion is one. Returning a plain
                    // Implicit here erased the IsStructuralProjection flag, so
                    // BindConversion skipped the ADR-0148 bind-time lowering and
                    // emitted a raw BoundConversionExpression the emitter has no
                    // arm for (NotSupportedException at emit for e.g.
                    // `Source → System.Uri?`). ClassifyNonStructural callers now
                    // also stop classifying a projection-only pair as implicit.
                    let underlyingConversion = ClassifyCore(
                        Invariant.Required(from, "conversion classification has a source type", expression: "from"),
                        Invariant.Required(
                            toNullable.UnderlyingType,
                            "a nullable target has an underlying type",
                            expression: "toNullable.UnderlyingType"
                        ),
                        allowStructuralProjection,
                        allowExplicitReference
                    )
                    if underlyingConversion.Exists && underlyingConversion.IsImplicit {
                        return if underlyingConversion.IsStructuralProjection {
                            Conversion.StructuralProjection
                        } else {
                            Conversion.Implicit
                        }
                    }
                    if allowExplicitReference && HasCheckedReferenceConversion(from, toNullable.UnderlyingType) {
                        return Conversion.Explicit
                    }
                }
            }
            // Issue #1455 / #1701: a nullable wrapper over an open type parameter
            // (`T?`) boxes implicitly to `object` (and reference-upcasts to any
            // interface in `T`'s effective constraint set) for EVERY constraint
            // shape EXCEPT the ones where `T` is PROVABLY a reference type: bare
            // `class` (`HasReferenceTypeConstraint`, e.g. `[T class]`) and
            // class-base constraints (`ClassConstraint`, e.g. `[T Box]` where
            // `Box` is a reference type). Both shapes are genuine nullable
            // REFERENCES per the Kotlin-model null-safety invariant, so implicit
            // boxing would erase a possibly-null `T?` into a non-nullable
            // `object`/interface target — the residual crack tracked by #1701.
            // Those cases must fall through to `Conversion.None` here so the
            // caller is forced to target `object?` (or any nullable interface
            // target, handled by the nullable-target arms above) or use `!!`.
            //
            // Every other shape — value-type-constrained (`[T struct]`, `T?`
            // erases to genuine `Nullable<T>`), interface-only-constrained, and
            // unconstrained — boxes via the CLR's ordinary generic `box !!T`
            // rule: a `null` value boxes to an actual null reference (for
            // reference instantiations) or to a boxed `Nullable<T>` (for value
            // instantiations), so no non-null value is ever fabricated. Blocking
            // those shapes regresses #1455.
            //
            // Unlike the bare `T -> object` case — deliberately excluded above
            // because an erased `!0` parameter slot is indistinguishable from a
            // genuine `object` and would inject a spurious box (#1196 regression)
            // — a `T?` argument is NEVER identity with an erased `!0`/`T` slot, so
            // the boxing here is always genuine and unambiguous. This wraps the
            // implicit-boxing argument/return/delegate-covariance positions (where
            // no explicit cast is written) in a BoundConversionExpression so emit
            // materialises the appropriate `box` instruction. Scoped to `object`
            // and constraint-satisfying interface targets so no narrowing or
            // otherwise-invalid conversion is admitted.
            if from is NullableTypeSymbol fromNullableTypeParam && !(to is NullableTypeSymbol) {
                let nullableUnderlyingTypeParam TypeParameterSymbol? = fromNullableTypeParam.UnderlyingType as TypeParameterSymbol
                if nullableUnderlyingTypeParam != nil &&
                    !nullableUnderlyingTypeParam.HasReferenceTypeConstraint &&
                    nullableUnderlyingTypeParam.ClassConstraint == nil {
                    if to?.ClrType.IsSameAs(typeof(object)) == true {
                        return Conversion.Implicit
                    }
                    if IsInterfaceLikeType(to) &&
                        TypeParameterConvertsTo(
                        nullableUnderlyingTypeParam,
                        Invariant.Required(to, "a conversion target is present", expression: "to")
                    ) {
                        return Conversion.Implicit
                    }
                }
            }
            // Phase 3.C.2 (generalized by issue #2354 follow-up): nil literal is
            // never assignable to a non-nullable VALUE type — a struct/value-kind
            // type genuinely needs an explicit `T?` (CLR `Nullable<T>`) wrapper to
            // carry a null, and that diagnostic must be preserved. A non-nullable
            // G#-DECLARED reference type — a `class` or an interface — or a
            // reference-constrained type parameter is ALWAYS nullable at the CLR
            // level regardless of whether the source spells its slot with an
            // explicit `?` — the IL value is already `ldnull` either way (see
            // MethodBodyEmitter.EmitConversion). Previously every one of these
            // reference-capable targets rejected a bare `return nil` /
            // `let x T = nil` with a misleading `GS0155`, forcing callers to widen
            // to `T?` even when the declared type was already a reference type.
            //
            // Deliberately narrower than `IsReferenceLikeTarget` (which also
            // matches ANY CLR-backed reference type, e.g. `string`, `object`, or a
            // function/delegate/sequence type): those already participate in G#'s
            // dedicated nullable-narrowing / smart-cast tracking (issue #2159) and
            // its explicit-`?`-required arrow-function-type rule (issue #715),
            // both of which rely on a bare (non-`?`) slot of one of THOSE kinds
            // still rejecting `nil` outright. Widening the rule to cover them too
            // would silently defeat that narrowing-invalidation diagnostic and the
            // arrow-function-type's deliberate strictness — so only the
            // G#-declared-type-or-constraint arm below is relaxed.
            if from == TypeSymbol.Null && !(to is NullableTypeSymbol) {
                return if IsNilAssignableWithoutNullableWrapper(
                    Invariant.Required(to, "a conversion classification has a target type", expression: "to")
                ) {
                    Conversion.Implicit
                } else {
                    Conversion.None
                }
            }
            // ADR-0102 follow-up / issue #818: two anonymous function types that
            // share parameter types and return type but differ only in the
            // per-parameter variadic flag tuple convert implicitly. The variadic
            // flag is a call-site directive (pack / pass-through) — it does not
            // change the parameter storage shape or the underlying CLR delegate
            // erasure, so a `(int32, ...string) -> int32` value can flow into a
            // `(int32, []string) -> int32` slot and vice versa. Identity (i.e.
            // exact same FunctionTypeSymbol cache instance) was already handled
            // by the early reference-equality short circuit at the top.
            //
            // Issue #1150: also allow the conversion when the parameter types match
            // but the source's numeric return type implicitly, losslessly widens to
            // the target's return type (e.g. `(int32) -> uint16` flowing into a
            // `(int32) -> int64` slot) — mirroring C#'s implicit numeric conversion
            // of a lambda body to an expected delegate return type.
            if from is FunctionTypeSymbol fnFrom &&
                to is FunctionTypeSymbol fnTo &&
                IsFunctionShapeAssignable(fnFrom, fnTo) {
                return Conversion.Implicit
            }
            // Issue #2375: a constructed CLR delegate (`Func`/`Action`/named
            // delegate) closed over one or more same-compilation classes/structs
            // reports a type-erased (widened to `object`) `Invoke` signature via
            // plain CLR reflection on `to.ClrType` — the real backing type may
            // still be an in-flight `TypeBuilder` (#313/#939), and separately a
            // same-compilation parameter/return TypeSymbol has no `ClrType` at
            // all until emit. Both defeat the purely-reflective
            // `IsFunctionToDelegateConvertible` check below even though the
            // shapes are, symbolically, an exact match. When the target's
            // symbolic `FunctionTypeSymbol` shape can be recovered without
            // reflection (via `MemberLookup.TryGetDelegateFunctionTypeFromSymbol`,
            // which substitutes the delegate's own open generic definition against
            // its recorded symbolic type arguments instead of reflecting on the
            // possibly-erased `ClrType`), compare structurally against THAT
            // shape first — this is a strict generalization of the
            // `fnFrom`/`fnTo` check just above, not an EF- or class-specific
            // special case, and simply widens which delegate targets can be
            // resolved without depending on reflection over `ClrType`.
            if from is FunctionTypeSymbol fnFromSymbolic &&
                !(to is FunctionTypeSymbol) &&
                MemberLookup
                .TryGetDelegateFunctionTypeFromSymbol(
                Invariant.Required(to, "a delegate conversion has a target type", expression: "to"),
                out var toFnSymbolic
            ) &&
                IsFunctionShapeAssignable(fnFromSymbolic, toFnSymbolic) {
                return Conversion.Implicit
            }
            // Issue #295: a GSharp function value (a `func` literal or any
            // function-typed value) implicitly converts to ANY compatible CLR
            // delegate type — one deriving from System.MulticastDelegate whose
            // `Invoke` signature is assignment-compatible. This lifts the
            // materialization that previously only happened in argument position
            // into a general rule, so assignment, return, and cast positions all
            // accept func → delegate conversions (Action/Func/Predicate and named
            // delegate types alike).
            if from is FunctionTypeSymbol fnSource &&
                to?.ClrType != nil &&
                IsFunctionToDelegateConvertible(fnSource, to.ClrType!!, to) {
                return Conversion.Implicit
            }
            // ADR-0059 / issue #255: same rule for user-declared named delegate
            // types. They have no ClrType during binding, so the func→delegate
            // path above does not fire — classify the conversion structurally
            // against the delegate's parameter/return signature instead.
            if from is FunctionTypeSymbol fnSource2 &&
                to is DelegateTypeSymbol toDelegate &&
                IsFunctionStructurallyAssignable(fnSource2, toDelegate) {
                return Conversion.Implicit
            }
            // ADR-0059: a named delegate VALUE (variable typed as a
            // DelegateTypeSymbol) is structurally a delegate; widening to
            // System.Delegate / System.MulticastDelegate follows the existing
            // rule and is handled below. Conversions BETWEEN two distinct
            // DelegateTypeSymbol instances are explicitly *not* implicit, per
            // CLR rules — the user must round-trip through a func value.
            // Issue #323: any delegate-typed value widens implicitly to
            // System.Delegate (and System.MulticastDelegate), since every CLR
            // delegate derives from those base types. This covers both a GSharp
            // `func` literal (FunctionTypeSymbol, which materializes as a delegate
            // instance) and a named/generic CLR delegate value such as
            // `Func[string]`. At the IL level this is a plain reference upcast,
            // so EMIT needs no conversion opcode.
            if to?.ClrType != nil && IsSystemDelegateBaseType(to.ClrType!!) {
                if from is FunctionTypeSymbol {
                    return Conversion.Implicit
                }
                if from?.ClrType != nil && ClrTypeUtilities.IsDelegateType(from.ClrType) {
                    return Conversion.Implicit
                }
                if from is DelegateTypeSymbol {
                    return Conversion.Implicit
                }
            }
            // Issue #421 P2-5: user-defined and imported enums convert to/from
            // their underlying numeric primitive, and one enum converts to
            // another. Mirrors C# §10.2.4: every enum⇄numeric direction is an
            // explicit conversion (even enum→its own underlying), since enum
            // identity is intentionally distinct from the integral identity.
            if TryClassifyEnumConversion(from, to, out var enumConversion) {
                return enumConversion
            }
            // ADR-0044 numeric lattice. Both operands must be CLR primitives in
            // the numeric set; the widening map decides implicit vs. explicit.
            // Decimal narrowings (decimal → int etc.) and signed/unsigned
            // mismatches at the same width (int ↔ uint) are explicit per C#.
            let fromClr string? = from?.ClrType?.FullName
            let toClr string? = to?.ClrType?.FullName
            if fromClr != nil && toClr != nil && NumericWideningLattice.IsNumericPrimitive(fromClr) &&
                NumericWideningLattice
                .IsNumericPrimitive(toClr) {
                // Issue #5400: numeric widening does not implicitly discard value optionality.
                if !NullableLifting.IsAnyValueTypeNullable(from as NullableTypeSymbol) &&
                    NumericWideningLattice.IsWidening(fromClr, toClr) {
                    return Conversion.Implicit
                }
                return Conversion.Explicit
            }
            // Issue #3288: parsing text is not an explicit CLR conversion.
            // String-to-primitive code must use Parse/TryParse instead.
            // Issues #3245/#3246: the legacy builtin `string(T)` conversion
            // ("any value backed by a CLR type converts to string via
            // ToString()") was retired — CLR interop (`.ToString()`) is the
            // supported story. The `[]char → string` conversion (#1441, the G#
            // rendering of C# `new string(char[])`) is a real conversion with a
            // dedicated emit path and remains.
            if to == TypeSymbol.String {
                let fromCharArray = from?.ClrType
                if fromCharArray?.IsArray == true {
                    let fromCharElement = fromCharArray!!.GetElementType()
                    if fromCharElement?.IsSameAs(typeof(char)) == true {
                        return Conversion.Explicit
                    }
                }
            }
            // ADR-0045: every value-type primitive (and every user struct)
            // boxes implicitly to `object`. Reference types convert to
            // `object` as a plain reference widening.
            if to?.ClrType.IsSameAs(typeof(object)) == true && from?.ClrType != nil {
                return Conversion.Implicit
            }
            // A symbolic element does not change the array's reference representation.
            if (from is SliceTypeSymbol || from is ArrayTypeSymbol) && to?.ClrType.IsSameAs(typeof(object)) == true {
                return Conversion.Implicit
            }
            // Issue #3303: a `map[K, V]` is unconditionally a CLR reference type
            // (`System.Collections.Generic.Dictionary<K, V>`), but its `ClrType`
            // is null when the key or value structurally references an in-scope
            // type parameter (e.g. a `map[K, V]` field of a generic class) or a
            // same-compilation struct, so the general CLR-backed widening rule
            // above cannot fire. Widening such a reference to `object` is still a
            // no-op at the IL level — the emitter's #1481 arm in
            // MethodBodyEmitter.IsReferenceCompatible already recognizes exactly
            // this shape. Without this, `Console.WriteLine(items)` and `object`-typed
            // parameter/return positions reported GS0155/GS0159 for open maps
            // while the monomorphic equivalent bound fine.
            if from is MapTypeSymbol && (to == TypeSymbol.Object || to?.ClrType.IsSameAs(typeof(object)) == true) {
                return Conversion.Implicit
            }
            // Issue #3748: a tuple is unconditionally a CLR value type
            // (`System.ValueTuple<…>`) and therefore always boxes to `object`, but
            // `TupleTypeSymbol.BuildClrType` deliberately leaves `ClrType` null
            // whenever an element requires symbolic projection — most commonly a
            // nullable-reference element such as `(A int32, B string?)`, but also a
            // type parameter or a same-compilation user type. The general
            // CLR-backed rule above needs a non-null `from.ClrType`, so those
            // tuples were rejected with GS0155 in every `object` / `object?`
            // position (argument, return, assignment) while the all-CLR-backed
            // same-shape tuple boxed fine. Element names are irrelevant here.
            if from is TupleTypeSymbol && (to == TypeSymbol.Object || to?.ClrType.IsSameAs(typeof(object)) == true) {
                return Conversion.Implicit
            }
            // Issue #3310 / ADR-0159: same-element `[]T → sequence[T]` for the
            // OPEN (null-ClrType) shapes — e.g. `q = []K{}` inside a generic
            // class, and the synthesized empty-sequence zero value for a bare
            // `sequence[K]` slot. Monomorphic slices already convert through the
            // CLR-backed rules below (T[] implements IEnumerable<T>), which
            // cannot fire when the element structurally references an in-scope
            // type parameter or same-compilation struct. At the IL level this is
            // a no-op reference conversion (array-to-interface); the emitter's
            // matching arm lives in MethodBodyEmitter.IsReferenceCompatible.
            if from is SliceTypeSymbol fromSliceToSeq &&
                to is SequenceTypeSymbol toSeqFromSlice &&
                fromSliceToSeq.ElementType == toSeqFromSlice.ElementType &&
                (from.ClrType == nil || to.ClrType == nil) {
                return Conversion.Implicit
            }
            // Boxing conversion for user value types to System.Object.
            if from is StructSymbol fromStruct && !fromStruct.IsClass && to?.ClrType.IsSameAs(typeof(object)) == true {
                return Conversion.Implicit
            }
            // Issue #2390: a nullable over a same-compilation value type has no
            // ClrType during binding, but its CLR storage is still Nullable<T> and
            // therefore has the standard nullable boxing conversion to object.
            if from is NullableTypeSymbol fromUserValueNullable && NullableLifting.IsAnyValueTypeNullable(
                fromUserValueNullable
            ) &&
                to
                ?.ClrType
                .IsSameAs(typeof(object)) == true {
                return Conversion.Implicit
            }
            // Issues #1218/#3280: value types box implicitly to System.ValueType,
            // while enum values additionally box to System.Enum. A same-compilation
            // EnumSymbol has no ClrType yet, so retain its object-boxing path too.
            if to?.ClrType is Type valueTypeBaseTarget &&
                (
                (IsValueTypeLikeFrom(from) && valueTypeBaseTarget.IsSameAs(typeof(ValueType))) ||
                    (IsEnumLikeType(from) && valueTypeBaseTarget.IsSameAs(typeof(Enum))) ||
                    (from is EnumSymbol && valueTypeBaseTarget.IsSameAs(typeof(object)))
            ) {
                return Conversion.Implicit
            }
            // ADR-0045 / issue #421: explicit unboxing from object, ValueType,
            // Enum, or a compatible interface to a value type. Issue #2492
            // includes nullable value-type targets whose real CLR storage is
            // `Nullable<T>` even when T is a same-compilation symbol without a
            // ClrType yet.
            if HasExplicitUnboxingConversion(from, to) {
                return Conversion.Explicit
            }
            // Issue #1532: an explicit cast from `object` (or `object?`) to a type
            // parameter `T` — written `T(o)` — is an explicit reference/unboxing
            // conversion checked at runtime, valid for ANY `T` (unconstrained,
            // `class`-, `struct`-, or interface/base-constrained). C# §10.3.5
            // lowers `(T)o` to `unbox.any <T>`, which the JIT specialises per
            // instantiation: a checked reference cast for reference `T`, an unbox
            // for value `T` (a null source throwing at runtime is expected). This
            // is EXPLICIT only — an implicit `object -> T` is still rejected
            // (GS0155) — and does not disturb the reverse `T -> object` erasure
            // rule (excluded above) because `from` here is a genuine `object`, not
            // a type parameter. `object?` reaches this via its `object` ClrType.
            // The emitter materialises this with `unbox.any T`.
            if from?.ClrType.IsSameAs(typeof(object)) == true && to is TypeParameterSymbol {
                return Conversion.Explicit
            }
            // Issue #421 P2-5: a value-typed expression implicitly boxes to any
            // interface it implements. The IL is a single `box <T>` followed by
            // a reference-level interface upcast (which is a no-op since the
            // boxed object's type implements the interface). User-declared
            // value structs reach this path once they participate in the
            // interface relation; imported value types (e.g. `int32`
            // implementing `System.IComparable`) use the CLR's
            // `IsAssignableFrom` check.
            if IsValueTypeLikeFrom(from) &&
                IsInterfaceLikeType(to) &&
                IsValueTypeAssignableToInterface(
                Invariant.Required(from, "a value-type conversion has a source type", expression: "from"),
                Invariant.Required(to, "a value-type conversion has a target type", expression: "to")
            ) {
                return Conversion.Implicit
            }
            // Issue #1302: a constructed BCL value struct (e.g.
            // `List[T].Enumerator`) whose element `T` is a same-compilation user
            // type has a null `ClrType` during binding — `MakeGenericType` could
            // not close the type because the argument lives in the assembly being
            // emitted — so `IsValueTypeLikeFrom`/`IsInterfaceLikeType` cannot fire
            // and the value-type → interface box above is skipped. The target
            // generic interface (`IEnumerator[T]`) is likewise unclosed. Match the
            // target interface's open definition against the generic interfaces the
            // struct's open definition implements, substituting the struct's
            // symbolic type arguments by generic-parameter position and comparing
            // each element via `AreTypeArgumentsEquivalent`, so
            // `List[Ch].Enumerator -> IEnumerator[Ch]` boxes implicitly while a
            // genuine element mismatch still reports GS0155.
            if from is ImportedTypeSymbol fromCtorStruct &&
                fromCtorStruct.OpenDefinition is {IsValueType: true} &&
                to is ImportedTypeSymbol toCtorIface &&
                toCtorIface.OpenDefinition is {IsInterface: true} &&
                ConstructedValueTypeImplementsInterfaceSymbolically(fromCtorStruct, toCtorIface) {
                return Conversion.Implicit
            }
            // Reference upcast: a class implicitly converts to any interface in
            // its (transitive) implements-list or to any of its (transitive)
            // base classes. The interpreter stores instances as objects of the
            // concrete class, and on the CLR the upcast is a no-op reference
            // conversion, so no representation change is needed.
            if from is StructSymbol fromClass && fromClass.IsClass {
                // Issue #1229: every user-declared `class` is a reference type
                // whose implicit root base is System.Object. The class carries no
                // ClrType during binding (its TypeDef only exists in the assembly
                // being emitted), so the general object-widening rule above (which
                // requires `from.ClrType != null`) cannot fire. This is a plain
                // reference upcast — NO boxing, since classes are reference types —
                // mirroring the user-to-user-base case below; the emitter lowers it
                // to a no-op (Issue #990). The nullable `object?` target is routed
                // through this same path by the #1121 nullable-wrapping rule above.
                if to == TypeSymbol.Object || to?.ClrType?.IsSameAs(typeof(object)) == true {
                    return Conversion.Implicit
                }
                if to is InterfaceSymbol toInterface {
                    for c in GetStructHierarchy(fromClass) {
                        for i in c.Interfaces {
                            // Issue #2535: lift declaration-site variance through a
                            // class's implemented interface (e.g. C : IOut<object>
                            // converts to IOut<object?>). Direct interface values
                            // already use this same safe, reference-only check below.
                            if i == toInterface || IsVarianceCompatibleInterfaceConversion(i, toInterface) {
                                return Conversion.Implicit
                            }
                        }
                    }
                }
                // Issue #525: a G# class implicitly upcasts to any imported CLR
                // interface that appears in its base-type clause (or any base
                // class's base-type clause). The G# class has no ClrType during
                // binding, so the general #521 rule below cannot fire — match
                // structurally against `ImplementedClrInterfaces` and use the
                // CLR's IsAssignableFrom to cover interface inheritance from the
                // imported side (e.g. implementing `IList<T>` also satisfies
                // `IEnumerable<T>`).
                if to != nil && !(to is InterfaceSymbol) && IsInterfaceLikeType(to) {
                    for c in GetStructHierarchy(fromClass) {
                        for iface in c.ImplementedClrInterfaces {
                            let ifaceClr Type? = iface?.ClrType
                            if ifaceClr == nil {
                                continue
                            }
                            // Issue #2135: `to.ClrType` may be a
                            // TypeBuilderInstantiation (a same-compilation generic
                            // user interface instantiated concretely) whose
                            // IsAssignableFrom throws NotSupportedException at emit.
                            // Route through the reference-context-independent
                            // by-name helper, which guards that call and falls back
                            // to the interface/base-class name walk.
                            if ifaceClr == to.ClrType || ClrTypeUtilities.IsAssignableByName(to.ClrType, ifaceClr) {
                                return Conversion.Implicit
                            }
                        }
                    }
                }
                if to is StructSymbol toClass && toClass.IsClass {
                    if DerivesFromConstructed(fromClass, toClass) {
                        return Conversion.Implicit
                    }
                }
                // Preserve symbolic arguments when an imported base has no faithful CLR probe.
                // Classes and interfaces share this nominal conversion path (#5388, #4731).
                for c in GetStructHierarchy(fromClass) {
                    if to != nil &&
                        c.ImportedBaseType is {} importedBase &&
                        IsRepresentationPreservingImplicit(importedBase, to) {
                        return Conversion.Implicit
                    }
                }
            }
            // Issue #1421: a user-declared interface value is a CLR reference type
            // whose implicit root base is System.Object, so it converts implicitly
            // to `object`/`object?` as a plain reference upcast (no IL op, no box —
            // an interface reference already IS an object reference). It also
            // upcasts to any of its (transitive) base interfaces, whether
            // user-declared (`BaseInterfaces`) or imported CLR (`BaseClrInterfaces`,
            // including interfaces those transitively inherit). An InterfaceSymbol
            // carries no ClrType during binding (its TypeDef only exists in the
            // assembly being emitted), so the general object-widening rule and the
            // #521 reference-upcast arm — both of which require `from.ClrType != null`
            // — cannot fire. Without this, passing an interface-typed value to a
            // `ThrowIfNull(object?, …)`-style overload failed to bind (GS0159). The
            // `object?` target is routed here by the #1121 nullable-wrapping rule.
            if from is InterfaceSymbol fromInterface {
                if to == TypeSymbol.Object || to?.ClrType?.IsSameAs(typeof(object)) == true {
                    return Conversion.Implicit
                }
                if to is InterfaceSymbol toBaseInterface {
                    for baseInterface in fromInterface.SelfAndAllBaseInterfaces() {
                        if baseInterface == toBaseInterface {
                            return Conversion.Implicit
                        }
                        // Issue #1927 / ECMA-334 §13.1.3.2: declaration-site
                        // variance. A constructed generic interface
                        // `IFoo[A1, .., An]` converts to `IFoo[B1, .., Bn]`
                        // (same generic definition, same arity) when EVERY
                        // type-argument slot is variance-compatible:
                        //   * a type parameter with no `out`/`in` modifier
                        //     requires the argument to be identical on both
                        //     sides (invariant);
                        //   * an `out` (covariant) parameter requires the
                        //     source argument to implicitly convert to the
                        //     target argument (e.g. `ISource[string]` ->
                        //     `ISource[object]`);
                        //   * an `in` (contravariant) parameter requires the
                        //     TARGET argument to implicitly convert to the
                        //     SOURCE argument (e.g. `ISink[object]` ->
                        //     `ISink[string]`).
                        // This generalizes to any arity/definition/argument
                        // combination, and applies transitively through
                        // `SelfAndAllBaseInterfaces()` so a variance-annotated
                        // base interface of a non-generic (or differently
                        // generic) derived interface still participates.
                        if IsVarianceCompatibleInterfaceConversion(baseInterface, toBaseInterface) {
                            return Conversion.Implicit
                        }
                    }
                }
                if to?.ClrType is {IsInterface: true} toClrInterface {
                    for iface in fromInterface.SelfAndAllBaseInterfaces() {
                        for baseClrInterface in iface.BaseClrInterfaces {
                            let clr Type? = baseClrInterface?.ClrType
                            // Issue #2135: `toClrInterface` may be a
                            // TypeBuilderInstantiation whose IsAssignableFrom throws
                            // NotSupportedException at emit; use the guarded by-name
                            // helper instead of calling IsAssignableFrom directly.
                            if clr != nil &&
                                (
                                clr.IsSameAs(toClrInterface) || ClrTypeUtilities.IsAssignableByName(toClrInterface, clr)
                            ) {
                                return Conversion.Implicit
                            }
                        }
                    }
                }
            }
            // Issue #528: a G# slice `[]T` is backed by a CLR `T[]` at runtime
            // (`SliceTypeSymbol.ClrType` is built via `MakeArrayType()` on the
            // element's `ClrType`). The reverse direction (`T[] → []T`) is
            // already classified above; this branch documents and enforces the
            // forward direction (`[]T → T[]`) explicitly so it survives any
            // future refactor of the generic #521 reference upcast below.
            // Element-type identity is required (matched by CLR full name to
            // bridge live ↔ MetadataLoadContext types), preserving slice
            // invariance: `[]string` does NOT convert to `object[]` even though
            // the CLR allows array reference covariance, because G# slices are
            // invariant in their element type. The IL is a no-op since the
            // runtime representation is identical.
            // Issue #3998: `to is not ArrayTypeSymbol` — a `[N]T` target's CLR
            // backing is the same `T[]`, so without this guard every slice reached
            // every fixed length implicitly. Narrowing an unknown length to a
            // declared one is not implicit; the pair falls through to the #2516
            // guard below, which offers it as an explicit `cast[[N]T](s)`.
            if from is SliceTypeSymbol sliceSrc && !(to is ArrayTypeSymbol) {
                let targetArray = to?.ClrType
                let sourceElement Type? = sliceSrc.ElementType?.ClrType
                if targetArray?.IsArray == true && targetArray!!.GetArrayRank() == 1 && sourceElement != nil {
                    let targetElement Type? = targetArray!!.GetElementType()
                    if targetElement != nil && string.Equals(
                        targetElement.FullName,
                        sourceElement.FullName,
                        StringComparison.Ordinal
                    ) {
                        return Conversion.Implicit
                    }
                }
            }
            // Issue #1162: same forward slice-to-array conversion when the
            // slice element is a same-compilation user type whose backing
            // ClrType is still null during binding (so the CLR-backed arm
            // above cannot fire). The target may itself be a SliceTypeSymbol
            // or ArrayTypeSymbol with a null ClrType; match symbolically by
            // element equivalence. Slice invariance is preserved because
            // `AreTypeArgumentsEquivalent` requires the elements to match.
            if from is SliceTypeSymbol sliceSrcSym && sliceSrcSym.ClrType == nil {
                // Issue #3998: the `ArrayTypeSymbol` arm this switch used to carry
                // is the symbolic-element twin of the CLR-backed hole closed just
                // above — `[]Foo -> [3]Foo` was implicit whenever `Foo` was a
                // same-compilation type. Dropped for the same reason.
                let targetElementSym TypeSymbol? = switch to {
                    case toSlice is SliceTypeSymbol: toSlice.ElementType
                    default: default(TypeSymbol?)
                }
                if targetElementSym != nil && AreTypeArgumentsEquivalent(targetElementSym, sliceSrcSym.ElementType) {
                    return Conversion.Implicit
                }
            }
            // Issue #2516: the exact-element branches above are the only implicit
            // slice-to-slice/array conversions G# permits. Stop here before the
            // general CLR reference-upcast rule can admit unsafe array covariance.
            if from is SliceTypeSymbol &&
                (to is SliceTypeSymbol || to is ArrayTypeSymbol || to?.ClrType?.IsArray == true) {
                return if allowExplicitReference &&
                    (HasCheckedReferenceConversion(from, to) || IsCovariantArrayUpcast(from, to)) {
                    Conversion.Explicit
                } else {
                    Conversion.None
                }
            }
            // Issue #3998: the same guard for a FIXED-ARRAY source. `[N]T`'s CLR
            // backing is the plain `T[]` shared by `[]T` and by every other
            // length, so without this arm the pair fell through to the general
            // #521 reference-assignability rule and `[3]int32` converted to
            // `[4]int32` — the bare rule underneath #3962's generic-argument case.
            //
            // The only implicit conversions out of a `[N]T` into another G#-native
            // array shape are:
            //   * `[N]T -> [N]T` — identity, already answered at the top of
            //     `ClassifyCore` by `TryClassifyWrappedElementIdentity`;
            //   * `[N]T -> []T`  — dropping a KNOWN length for an unknown one is a
            //     widening, and a representation no-op, so it stays implicit and
            //     a fixed array still reaches every `[]T` parameter.
            // A different length, a different element, or a rectangular target is
            // a different type and stops here.
            //
            // Deliberately NOT guarded: an imported SZ-array target
            // (`ImportedTypeSymbol(T[])`, i.e. a C# `int[]` parameter). Reflection
            // records no length to disagree with, so that pair keeps the lenient
            // comparison — the same metadata-recovery line #3924's
            // `IsMetadataRecoveredElement` and #3962's `interop-*` cases draw.
            //
            // `cast[…]` remains available for an author asserting a shape the
            // compiler cannot see, exactly as it is for slice covariance.
            if from is ArrayTypeSymbol fromFixedArray &&
                (to is SliceTypeSymbol || to is ArrayTypeSymbol || to is RectangularArrayTypeSymbol) {
                let fixedTargetElement TypeSymbol? = switch to {
                    case toSliceTarget is SliceTypeSymbol: toSliceTarget.ElementType
                    case toArrayTarget is ArrayTypeSymbol: toArrayTarget.ElementType
                    default: default(TypeSymbol?)
                }
                // Review finding 1 (#4018): this gate uses the SAME element
                // comparison the identity path uses (`TryClassifyWrappedElementIdentity`
                // -> `IsCrossContextIdenticalElement`), never the looser
                // `AreTypeArgumentsEquivalent`. That helper falls back to symbol
                // kind plus simple NAME when both elements have a null `ClrType`,
                // so two distinct same-compilation homonyms — `A.Item` and
                // `B.Item`, legal per the spec's dotted-qualifier rule — compared
                // equal and `[1]A.Item` became assignable to `[1]B.Item`. That is
                // the very failure mode this issue exists to remove, one level
                // down, and it type-confuses at run time (reading `B.Item`'s field
                // off an `A.Item` value threw `NullReferenceException`).
                // `IsCrossContextIdenticalElement` compares user types by their
                // `Definition`, while still answering `true` for the cross-context
                // and reference-nullability pairs the CLR-backed elements need.
                let sameElement = fixedTargetElement != nil &&
                    IsCrossContextIdenticalElement(fromFixedArray.ElementType, fixedTargetElement)
                if sameElement &&
                    (
                    to is SliceTypeSymbol ||
                        (to is ArrayTypeSymbol matchingLength && matchingLength.Length == fromFixedArray.Length)
                ) {
                    return Conversion.Implicit
                }
                // Review finding 2 (#4018): the cast the diagnostic and the spec
                // promise has to exist for a same-compilation element too. Both
                // `[3]Foo` and `[4]Foo` have a null `ClrType` while binding, so
                // `HasCheckedReferenceConversion` cannot see that they share one
                // runtime representation and the pair fell out as `None` — the
                // escape hatch existed for `[3]int32` and not for `[3]Foo`.
                // Answer it from the symbols instead: identical element, differing
                // declared length, one CLR array type underneath.
                if sameElement && to is ArrayTypeSymbol {
                    return if allowExplicitReference {
                        Conversion.Explicit
                    } else {
                        Conversion.None
                    }
                }
                // Everything else — a different element, or a rectangular target —
                // is explicit-only, the same disposition slice covariance already
                // has (`GS0156` points at `cast[…]`). The cast is a
                // representation-level reinterpretation and does NOT change the
                // value: a `[3]int32` cast to `[4]int32` still reports
                // `.Length == 3`. That is the author asserting a shape, exactly as
                // `cast[[]Base]` asserts an element; the implicit conversion is
                // what G# withdraws.
                return if allowExplicitReference &&
                    (HasCheckedReferenceConversion(from, to) || IsCovariantArrayUpcast(from, to)) {
                    Conversion.Explicit
                } else {
                    Conversion.None
                }
            }
            // Imported CLR methods/properties can surface an SZ-array as a plain
            // ImportedTypeSymbol rather than a SliceTypeSymbol. Apply the same
            // element-invariance guard to that metadata path.
            if from is ImportedTypeSymbol{ClrType: {IsArray: true} importedArray} &&
                importedArray.GetArrayRank() == 1 &&
                (
                to is SliceTypeSymbol ||
                    to is ArrayTypeSymbol ||
                    (to?.ClrType is {IsArray: true} targetClrArray && targetClrArray.GetArrayRank() == 1)
            ) {
                let sourceElement = TypeSymbol.FromClrTypeWithoutNullability(
                    importedArray.GetElementType(),
                    NullabilityFreeReason.TypeStructure
                )
                let importedTargetElement = switch to {
                    case targetSlice is SliceTypeSymbol: targetSlice.ElementType
                    case targetArray is ArrayTypeSymbol: targetArray.ElementType
                    default: TypeSymbol.FromClrTypeWithoutNullability(
                        Invariant.Required(
                            to.ClrType,
                            "an imported array target has a CLR representation",
                            expression: "to.ClrType"
                        )
                            .GetElementType(),
                        NullabilityFreeReason.TypeStructure
                    )
                }
                if AreTypeArgumentsEquivalent(sourceElement, importedTargetElement) {
                    return Conversion.Implicit
                }
                return if allowExplicitReference &&
                    (HasCheckedReferenceConversion(from, to) || IsCovariantArrayUpcast(from, to)) {
                    Conversion.Explicit
                } else {
                    Conversion.None
                }
            }
            if from is RectangularArrayTypeSymbol rectangularSource &&
                to is RectangularArrayTypeSymbol rectangularTarget {
                if rectangularSource.Rank != rectangularTarget.Rank {
                    return Conversion.None
                }
                if AreTypeArgumentsEquivalent(rectangularSource.ElementType, rectangularTarget.ElementType) {
                    return Conversion.Implicit
                }
                let elementConversion = ClassifyNonStructural(
                    rectangularSource.ElementType,
                    rectangularTarget.ElementType
                )
                return if IsReferenceLikeTarget(rectangularSource.ElementType) &&
                    IsReferenceLikeTarget(rectangularTarget.ElementType) &&
                    elementConversion.Exists &&
                    elementConversion.IsImplicit {
                    Conversion.Implicit
                } else {
                    (
                        if allowExplicitReference && HasCheckedReferenceConversion(from, to) {
                            Conversion.Explicit
                        } else {
                            Conversion.None
                        }
                    )
                }
            }
            if from is RectangularArrayTypeSymbol{ClrType: nil} symbolicRectangular &&
                to?.ClrType != nil &&
                MemberLookup.TryProjectErasedClrType(symbolicRectangular, out var erasedRectangular) &&
                ClrTypeUtilities.IsAssignableByName(to.ClrType, erasedRectangular) {
                return Conversion.Implicit
            }
            // Issue #2140: a G# slice `[]T` is backed at runtime by a CLR
            // one-dimensional array, which derives from the base class
            // `System.Array`. This upcast is element-INDEPENDENT and a no-op
            // reference upcast at IL level. The concrete-element case already
            // flows through the general #521 CLR reference-upcast arm below;
            // this arm additionally accepts the generic-type-parameter /
            // same-compilation-user element case whose backing `ClrType` is
            // null during binding (so the #521 arm cannot fire). Use the
            // cross-context-safe `IsSameAs` (reference identity is forbidden,
            // guard test #835).
            if from is SliceTypeSymbol && to?.ClrType?.IsSameAs(typeof(Array)) == true {
                return Conversion.Implicit
            }
            // Slice-to-interface: `[]T` implements the five CLR array interfaces
            // at the exact element type. A distinct target element is allowed only
            // when that interface declares its parameter `out` and T converts to
            // the target element by an implicit reference conversion. This composes
            // array interface implementation with ordinary generic variance:
            // `[]Dog -> IEnumerable[Dog] -> IEnumerable[Animal]`. IList/ICollection
            // remain invariant, while IEnumerable/IReadOnlyList/
            // IReadOnlyCollection widen safely. This guard prevents CLR array
            // covariance from admitting any broader mutable conversion below.
            if from is SliceTypeSymbol sliceForIface && to?.ClrType != nil && to.ClrType!!.IsInterface {
                if (sliceForIface.ClrType != nil && SliceImplementsInterface(sliceForIface, to)) ||
                    SliceConvertsToInterfaceSymbolically(sliceForIface, to) {
                    return Conversion.Implicit
                }
                return Conversion.None
            }
            // Fixed arrays have the same CLR interface surface as slices. Their
            // element type can remain symbolic while binding, so use the symbolic
            // element check instead of the erased array's object-based interface.
            if from is ArrayTypeSymbol arrayForIface && to?.ClrType != nil && to.ClrType!!.IsInterface {
                return if ArrayElementConvertsToInterfaceSymbolically(arrayForIface.ElementType, to) {
                    Conversion.Implicit
                } else {
                    Conversion.None
                }
            }
            // Same rule for an SZ-array returned from imported metadata. Reflection
            // exposes that value as ImportedTypeSymbol(T[]) rather than []T, but G#
            // must not gain broader CLR array covariance because of symbol shape.
            if from is ImportedTypeSymbol{ClrType: {IsArray: true} importedArrayForIface} &&
                importedArrayForIface.GetArrayRank() == 1 && to?.ClrType is {IsInterface: true} {
                if ClrTypeUtilities.ImplementsInterfaceByName(importedArrayForIface, to.ClrType) ||
                    ArrayElementConvertsToInterfaceSymbolically(
                    TypeSymbol.FromClrTypeWithoutNullability(
                        importedArrayForIface.GetElementType(),
                        NullabilityFreeReason.TypeStructure
                    ),
                    to
                ) {
                    return Conversion.Implicit
                }
                return Conversion.None
            }
            // Issue #521: standard CLR identity / reference upcast — a
            // reference-typed expression of CLR type `from` widens implicitly
            // to any base class or implemented interface `to`. The CLR
            // satisfies the contract at the reference level (no IL op
            // required), so the emitter treats this as a no-op. Restricted to
            // genuine reference types on both sides to avoid colliding with
            // the boxing / unboxing / value-type-to-interface rules above.
            //
            // Issue #1627: this arm only checks CLR-level assignability, and
            // `NullableTypeSymbol` relays its underlying CLR type (see
            // `NullableTypeSymbol.ClrType`), so an imported nullable-reference
            // source `S?` and its non-nullable form `S` looked like two ordinary
            // non-value-type CLR types — misclassifying `S? -> S` as an implicit
            // no-op upcast (Kotlin-model null safety requires GS0154/GS0155 there
            // instead; the caller must write `!!`). User-declared classes/
            // interfaces carry a null ClrType during binding and were never
            // affected by that leak. Guard this arm specifically (rather than
            // rejecting earlier in the function) so it does not disturb any later
            // EXPLICIT conversion arm — e.g. the #1532 `object?/object -> T`
            // explicit unboxing cast — which must still see a genuine `S?` source
            // and classify it on its own terms. Every `S? -> U?` (nullable
            // target) case was already handled above and never reaches this arm.
            if allowExplicitReference &&
                from is NullableTypeSymbol nullableReferenceSource &&
                IsReferenceLikeTarget(nullableReferenceSource.UnderlyingType) &&
                to != nil &&
                !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                nullableReferenceSource.UnderlyingType,
                to
            ) &&
                HasCheckedReferenceConversion(nullableReferenceSource, to) {
                return Conversion.Explicit
            }
            if from is NullableTypeSymbol fromNullableUpcastSrc &&
                IsReferenceLikeTarget(fromNullableUpcastSrc.UnderlyingType) {
                return Conversion.None
            }
            // Issue #2735: an object-erased constructed generic must not fall
            // through to the CLR assignability check below after its symbolic
            // arguments failed the hierarchy/variance checks above. For example,
            // NullLogger<Other>'s probe type NullLogger<object> implements the
            // probe ILogger<object>, but it does not implement ILogger<Store>.
            //
            // Issue #3962: the same leak exists for a type argument whose closed
            // CLR type is real but NOT injective — a fixed-length array `[N]T`,
            // whose length lives only in the symbol (see
            // `RequiresSymbolicTypeArgumentIdentity`). `List[[3]int32]` and
            // `List[[4]int32]` are both backed by `List<System.Int32[]>`, so
            // without this the CLR assignability check below would readmit the
            // very conversion the identity gate at the top of `ClassifyCore`
            // just declined.
            //
            // Issue #4024: that guard reads `from` ALONE, which sufficed while only
            // `[N]T` was retained — every pair it had to stop carried a fixed array
            // on BOTH sides. Once `[]T` is retained too the pair can be
            // ASYMMETRIC: `List[[]int32]` -> `List[[3]int32]` has nothing
            // length-bearing on the `from` side, so
            // `RequiresSymbolicTypeArgumentIdentity` said no and the CLR
            // assignability check below readmitted the exact conversion this issue
            // is about (the mirror direction was already rejected, which is how the
            // one-sidedness showed up). `IsRejectedFixedArrayShapeMismatch` is the
            // already-established TWO-sided predicate — "both sides know their
            // array shape and those shapes disagree" — and is shared with the
            // #3962 variance guard, so the two cannot drift apart.
            //
            // Review finding 1: that predicate is written for the VARIANCE call
            // site, where the two operands are already known to be corresponding
            // type arguments. Read literally it is satisfied by any pair whose
            // TARGET alone bears a fixed array — `object` against
            // `List[[3]int32]`, say — because "known on both sides" only excludes
            // metadata-recovered arrays; it does not require the other side to
            // have an array shape at all. No program was found that reaches this
            // line that way (an `object` source is classified by an earlier arm,
            // and `cast[List[[3]int32]](o)` still compiles and runs — measured),
            // so this is hardening rather than a fix. But the disjunct only ever
            // needs to fire when BOTH sides carry a G#-native array spelling, so
            // it says so, and cannot start swallowing a checked reference
            // conversion if an earlier arm is ever reordered.
            if (
                RequiresSymbolicTypeArgumentIdentity(from) ||
                    (
                    TypeSymbol.ContainsSourceArrayShape(from) && TypeSymbol.ContainsSourceArrayShape(to) &&
                        IsRejectedFixedArrayShapeMismatch(from, to)
                )
            ) &&
                TryGetConstructedGenericShape(to, out _, out _) {
                return Conversion.None
            }
            if from?.ClrType != nil &&
                to?.ClrType != nil &&
                !from.ClrType!!.IsValueType &&
                !to.ClrType!!.IsValueType &&
                !from.ClrType!!.IsPointer &&
                !to.ClrType!!.IsPointer &&
                !from.ClrType!!.IsByRef &&
                !to.ClrType!!.IsByRef &&
                ClrTypeUtilities.IsAssignableByName(to.ClrType, from.ClrType) {
                return Conversion.Implicit
            }
            if allowExplicitReference && HasCheckedReferenceConversion(from, to) {
                return Conversion.Explicit
            }
            if allowStructuralProjection && StructuralProjectionPlanner.CanProject(from, to) {
                return Conversion.StructuralProjection
            }
            return Conversion.None
        }

        /// Issue #1927 / ECMA-334 §13.1.3.2: true when [`from`](paramref)
        /// (a constructed generic interface, e.g. `ISource[string]`)
        /// implicitly converts to [`to`](paramref) (e.g.
        /// `ISource[object]`) purely via declaration-site variance —
        /// same generic (cref:InterfaceSymbol.Definition), same arity,
        /// and every type-argument slot honoring its declared
        /// (cref:TypeParameterVariance). Works for any interface
        /// definition/arity/argument combination, not just a single hardcoded
        /// pair.
        /// @param from The source constructed interface.
        /// @param to The target constructed interface.
        /// @returns `true` when the conversion is variance-compatible.
        internal func IsVarianceCompatibleInterfaceConversion(from InterfaceSymbol?, to InterfaceSymbol?) bool {
            if from == nil || to == nil || from.Definition != to.Definition {
                return false
            }
            let typeParameters = from.Definition!!.TypeParameters
            let fromArgs = from.TypeArguments
            let toArgs = to.TypeArguments
            if typeParameters.IsDefaultOrEmpty ||
                fromArgs.IsDefaultOrEmpty ||
                toArgs.IsDefaultOrEmpty ||
                typeParameters.Length != fromArgs.Length ||
                typeParameters.Length != toArgs.Length {
                return false
            }
            for var i = 0; i < typeParameters.Length; i++ {
                let fromArg = fromArgs[i]
                let toArg = toArgs[i]
                if fromArg == toArg {
                    continue
                }
                switch typeParameters[i].Variance {
                    case TypeParameterVariance.Out {
                        // CLR generic-interface variance (ECMA-335 II.9.7) is
                        // defined only for REFERENCE-typed type arguments; the
                        // emitter (MethodBodyEmitter.IsReferenceCompatible, which
                        // calls back into this same method) emits no cast/box for
                        // a variance conversion, so a value-type argument (a
                        // primitive, enum, or user struct) would produce
                        // unverifiable/unsound IL even though it boxes implicitly
                        // to `object` (ADR-0045). Reject before considering
                        // `Classify` at all — a value-type argument on either
                        // side means the two constructed interfaces are genuinely
                        // different CLR types, not variance-compatible ones.
                        // Covariant: the source argument must implicitly
                        // convert to the target argument (string -> object).
                        // #4420: an element conversion that needs ADR-0186 §4's
                        // nil check (`string!` -> `object`) is not variance: a
                        // variance conversion reads every element through the
                        // target view with no per-element check point.
                        if !IsVarianceArgumentCompatible(fromArg, toArg, allowPlatformNilCheck: false) {
                            return false
                        }
                    }
                    case TypeParameterVariance.In {
                        // Same reference-type-only restriction as the `Out` case
                        // above, applied symmetrically to the contravariant slot.
                        // Contravariant: the TARGET argument must implicitly
                        // convert to the SOURCE argument (object -> string),
                        // so the narrower interface accepts the wider one.
                        // #4420: symmetric to the covariant arm. A view that
                        // writes `string!` (possibly nil) into a sink declared
                        // non-null `object` has no per-element check point.
                        if !IsVarianceArgumentCompatible(toArg, fromArg, allowPlatformNilCheck: false) {
                            return false
                        }
                    }
                    default {
                        // Invariant: the arguments must be identical (already
                        // ruled out above by the `fromArg == toArg` fast path).
                        return false
                    }
                }
            }
            return true
        }

        /// Issue #1162/#2516: symbolic slice-to-interface conversion shared by
        /// binding and emission. A one-dimensional `[]T` implements
        /// `IEnumerable<T>`, `IReadOnlyList<T>`,
        /// `IReadOnlyCollection<T>`, `IList<T>`, and
        /// `ICollection<T>`. Exact element matches always convert.
        /// Distinct reference elements convert only when the target interface's
        /// CLR generic parameter is declared covariant and the element conversion
        /// is implicit; invariant mutable interfaces therefore remain exact-only.
        ///
        /// Issue #2323: made `internal` (rather than
        /// `private`) so `MethodBodyEmitter.IsReferenceCompatible`
        /// can call this SAME symbolic rule instead of maintaining a divergent
        /// copy — the binder accepted these conversions, but the emitter's
        /// reference-compatibility check only mirrored the element-INDEPENDENT
        /// #2140 array interfaces, throwing (cref:NotSupportedException)
        /// for the five generic single-type-argument interfaces when the slice
        /// element is a generic type parameter or same-compilation user type.
        /// @param slice The source slice type `[]T`.
        /// @param targetInterface The candidate target interface type.
        /// @returns `true` when [`slice`](paramref) converts to
        /// [`targetInterface`](paramref) under the symbolic slice-to-
        /// interface rule; otherwise `false`.
        internal func SliceConvertsToInterfaceSymbolically(
            slice SliceTypeSymbol,
            targetInterface TypeSymbol
        ) bool -> ArrayElementConvertsToInterfaceSymbolically(slice.ElementType, targetInterface)

        internal func ArrayElementConvertsToInterfaceSymbolically(
            sourceElement TypeSymbol,
            targetInterface TypeSymbol
        ) bool {
            // Issue #2140: element-INDEPENDENT non-generic array interfaces.
            // Every one-dimensional array implements these regardless of its
            // element type, so a `[]T` (generic-type-parameter or same-
            // compilation-user element, null backing ClrType) converts to them
            // unconditionally. Match by the target's full name.
            if IsElementIndependentArrayInterface(targetInterface) {
                return true
            }
            if targetInterface is not ImportedTypeSymbol imported ||
                !TryGetConstructedGenericShape(imported, out var openDefinition, out var targetArguments) ||
                targetArguments.Length != 1 {
                return false
            }
            let openName string? = openDefinition!!.FullName
            if openName == nil {
                return false
            }
            let isArrayInterface = string.Equals(
                openName,
                typeof(System.Collections.Generic.IEnumerable[_]).FullName,
                StringComparison.Ordinal
            ) ||
                string.Equals(
                openName,
                typeof(System.Collections.Generic.IReadOnlyList[_]).FullName,
                StringComparison.Ordinal
            ) ||
                string.Equals(
                openName,
                typeof(System.Collections.Generic.IReadOnlyCollection[_]).FullName,
                StringComparison.Ordinal
            ) ||
                string.Equals(
                openName,
                typeof(System.Collections.Generic.IList[_]).FullName,
                StringComparison.Ordinal
            ) ||
                string.Equals(
                openName,
                typeof(System.Collections.Generic.ICollection[_]).FullName,
                StringComparison.Ordinal
            )
            if !isArrayInterface {
                return false
            }
            let targetElement = targetArguments[0]
            if AreTypeArgumentsEquivalent(targetElement, sourceElement) {
                return true
            }
            let genericParameters = openDefinition!!.GetGenericArguments()
            if genericParameters.Length != 1 ||
                (
                genericParameters[0].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            ) != GenericParameterAttributes.Covariant ||
                !IsReferenceTypeArgument(sourceElement) ||
                !IsReferenceTypeArgument(targetElement) {
                return false
            }
            let elementConversion = Classify(sourceElement, targetElement)
            return elementConversion.Exists && elementConversion.IsImplicit
        }

        /// Issue #3505: true when [`from`](paramref) implicitly converts to
        /// [`to`](paramref) AND both ends are reference-like — the only
        /// variance a directly-created delegate can honor. Boxing, numeric
        /// widening, and nullable lifts ride the general implicit lattice but
        /// require a real coercion at the boundary, which neither CLR delegate
        /// variance nor a target-typed `ldftn`+`newobj` binding can
        /// perform. Reference nullability and platform wrappers are ignored only
        /// when deciding whether each slot is reference-like; the annotated types
        /// still drive conversion classification so nullable-to-non-nullable stays
        /// rejected.
        /// @param from The value-producing side of the slot.
        /// @param to The value-consuming side of the slot.
        /// @returns `true` for a strict implicit reference conversion.
        internal func IsImplicitReferenceVariantSlot(from TypeSymbol?, to TypeSymbol?) bool {
            if from == nil || to == nil {
                return false
            }
            let referenceFrom TypeSymbol? = UnwrapPlatformAndNullable(UnwrapReferenceNullable(from))
            let referenceTo TypeSymbol? = UnwrapPlatformAndNullable(UnwrapReferenceNullable(to))
            if from == TypeSymbol.Void ||
                to == TypeSymbol.Void ||
                referenceFrom == nil ||
                referenceTo == nil ||
                !IsReferenceLikeTarget(referenceFrom) ||
                !IsReferenceLikeTarget(referenceTo) {
                return false
            }
            let conversion = ClassifyNonStructural(from, to)
            return conversion.Exists && conversion.IsImplicit && !conversion.IsStructuralProjection
        }

        internal func IsRepresentationPreservingImplicit(source TypeSymbol, target TypeSymbol) bool {
            let conversion = Classify(source, target)
            if conversion.IsIdentity {
                return true
            }
            if !conversion.Exists ||
                !conversion.IsImplicit ||
                conversion.IsStructuralProjection ||
                conversion.RequiresPlatformNilCheck ||
                !IsReferenceLikeTarget(source) ||
                !IsReferenceLikeTarget(target) {
                return false
            }
            // Symbolic imported owners must prove nominal inheritance, not a conversion that constructs a different reference.
            if source is ImportedTypeSymbol && TryGetConstructedGenericShape(target, out _, out _) {
                return TryClassifyConstructedImportedReferenceConversion(source, target)
            }
            return if source.ClrType is {} sourceClr && target.ClrType is {} targetClr {
                ClrTypeUtilities.IsAssignableByName(targetClr, sourceClr)
            } else {
                IsImplicitReferenceVariantSlot(source, target)
            }
        }

        /// True when [`type`](paramref) is a reference-capable type for
        /// conversion purposes — a G# interface, a G# `class` (as opposed to
        /// a value-kind `struct`), a reference-constrained type parameter, or
        /// any other CLR-backed reference type (e.g. `object`, an imported
        /// class). Shared by (cref:Classify) (to admit an implicit
        /// `nil ->` conversion for issue #2354's follow-up — a
        /// non-nullable reference-capable type is always nullable at the CLR
        /// level, unlike a genuine value type which still requires an explicit
        /// `T?`) and by `MethodBodyEmitter.EmitConversion` (so emission
        /// recognizes exactly the same set of targets as an `ldnull` no-op,
        /// instead of re-deriving its own narrower subset).
        /// @param type The candidate type.
        /// @returns `true` when [`type`](paramref) is reference-capable.
        internal func IsReferenceLikeTarget(type TypeSymbol) bool {
            if type is ImportedTypeSymbol{OpenDefinition: {IsValueType: false}} {
                return true
            }
            if type is InterfaceSymbol {
                return true
            }
            if type is StructSymbol && type.IsClass == true {
                return true
            }
            // Slices/fixed arrays are CLR array references even while a
            // same-compilation element leaves their ClrType unavailable.
            if type is SliceTypeSymbol || type is ArrayTypeSymbol || type is RectangularArrayTypeSymbol {
                return true
            }
            // Issue #3985 / ADR-0174 D2: a channel is a CLR class in every
            // direction — `Chan<T>`/`Channel<T>` and the `ChannelReader<T>` /
            // `ChannelWriter<T>` views are all reference types — but
            // `ChannelTypeSymbol.MakeClrType` returns null the moment the element
            // has no CLR backing (a type parameter, or a same-compilation user
            // type), so the `ClrType` fallback below reported `chan[T]` as NOT
            // reference-like. That is the identical hole this arm's slice/array
            // neighbour closes for `[]T`, and the delegate/function arm below
            // closes for a named delegate. The consequence was an asymmetry with
            // no defensible reading: a `chan[int32]?` argument reached a
            // non-nullable imported `Channel[int32]` parameter as an
            // explicit reference conversion that drops the annotation (the #1627
            // arm, via `HasCheckedReferenceConversion`), exactly as a `string?`
            // reaches a `string` parameter, while the SAME call with an open
            // element fell through every arm to `Conversion.None` and reported
            // GS0155 — so `chan[T]?` and `chan[int32]?` disagreed purely on
            // whether the element happened to be CLR-backed. Recognising the
            // channel here restores one answer for both spellings; the Kotlin-model
            // null-safety rules are untouched, because the #1627 arm still
            // requires an EXPLICIT conversion and a G#-declared parameter still
            // reports GS0154.
            if type is ChannelTypeSymbol {
                return true
            }
            // Issue #3997, the same drift as the two arms above: a
            // `map[K, V]` IS a `Dictionary<K, V>`, a
            // `sequence[T]` IS an `IEnumerable<T>` and an `async sequence[T]` IS
            // an `IAsyncEnumerable<T>` — a class and two interfaces, reference
            // types in every instantiation. Each one's `MakeClrType` returns null
            // the moment a key/value/element has no CLR backing (a type
            // parameter, or a same-compilation user type), so the `ClrType`
            // fallback below answered `true` for the CLOSED spelling and `false`
            // for the OPEN one — the identical hole the slice/array arm above
            // closes for `[]T` and the channel arm closes for `chan[T]`. The
            // consequence, measured on the parent commit, was that
            // `takes[K, V](m)` with an `m (map[K, V])?` compiled with no
            // diagnostic at all while its closed sibling correctly reported
            // GS0154: the Kotlin-model null-safety gate in
            // `OverloadResolver.CallBinding` bottoms out here (via
            // `IsNullableReferenceGateRejected`), and a shape it does not
            // recognise as a reference is a shape it declines to gate.
            //
            // `AsyncSequenceTypeSymbol` is a THIRD kind the issue did not name;
            // it is included because it fails and succeeds for exactly the same
            // reason as its synchronous sibling. `TupleTypeSymbol` and
            // `FunctionPointerTypeSymbol` are deliberately NOT here — a tuple is
            // a `System.ValueTuple<…>` and a function pointer is a value type, so
            // the `ClrType` fallback's `IsValueType` answer is already the right
            // one for both spellings.
            if type is MapTypeSymbol || type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol {
                return true
            }
            // Issue #2841: a user-declared named delegate (ADR-0059 / issue #255) is
            // emitted as a sealed class deriving from `System.MulticastDelegate`, so
            // it is unconditionally a reference type. Like `StructSymbol`/
            // `InterfaceSymbol` above it carries NO `ClrType` at bind time (its
            // TypeDef only exists after emit), so the CLR-backing fallback below
            // cannot recognise it. Without this arm the `T -> U?` reference-wrap arm
            // (issue #1121) never ran for a `D?` target, and every delegate
            // conversion path downstream tested the still-wrapped
            // `NullableTypeSymbol`, so a lambda bound fine against `D` but not `D?`.
            //
            // Issue #2840: a structural function type `(P…) -> R` is likewise always
            // a reference type — it materialises as a delegate instance. Its
            // `ClrType` is only available when EVERY type in its signature is
            // CLR-backed, so a single source-declared class anywhere in the
            // parameter or return list (e.g. `(Src) -> void`) leaves it null and the
            // fallback below reported it as non-reference. That silently disabled
            // the `T? -> U?` reference arm, so `((Src) -> void)?` would not convert
            // to `Action[Src]?` even though the bare, non-nullable conversion was
            // fine.
            if type is DelegateTypeSymbol || type is FunctionTypeSymbol {
                return true
            }
            // Issue #2188: a reference-constrained type parameter (`[T class …]`,
            // i.e. `HasReferenceTypeConstraint`, or a class-base constraint such as
            // `[T Box]`) is PROVABLY a reference type. It therefore participates in
            // the reference-conversion arms exactly like any other reference type:
            // `T -> object`/`T? -> object?`, `T -> Base`/`T? -> Base?`, and
            // `T -> IFace`/`T? -> IFace?` for any interface in its constraint set.
            // The type parameter carries no `ClrType` during binding (it is an open
            // VAR/MVAR), so the CLR-backing check below cannot recognise it — this
            // arm supplies the missing classification. Unconstrained and
            // value-type-constrained parameters are intentionally excluded (their
            // `T?` erases to `Nullable<T>`, a value type), so they keep their
            // value-type conversion rules.
            if IsReferenceConstrainedTypeParameter(type) {
                return true
            }
            // Imported / CLR-backed types are reference-like when the CLR backing
            // is a class or interface (not a value type, pointer, or by-ref). User
            // value structs carry a null ClrType during binding and fall through.
            if type?.ClrType is {} clrBacking {
                return !clrBacking.IsValueType && !clrBacking.IsPointer && !clrBacking.IsByRef
            }
            return false
        }

        /// Returns whether `to(fromValue)` is a checked CLR <em>unboxing</em>
        /// cast — the value-type mirror of
        /// (cref:HasCheckedReferenceConversion). Issue #3684 (family F8):
        /// the conversion-call spelling `T(expr)` over a value-typed `T`
        /// (e.g. `ImmutableArray[P](method.Invoke(…))`, the G# form of a C#
        /// `(ImmutableArray<P>)` cast) needs this alongside the
        /// reference case, because the constructor-overload fallback in
        /// `ExpressionBinder` can only offer a conversion it can name.
        /// @param from Static source type.
        /// @param to Requested target type.
        /// @returns `true` for an explicit checked unboxing conversion.
        internal func HasCheckedUnboxingConversion(
            from TypeSymbol?,
            to TypeSymbol?
        ) bool -> HasExplicitUnboxingConversion(from, to)

        /// Returns whether `to(fromValue)` is a checked CLR reference cast.
        /// The conversion preserves a null reference, returns the target reference
        /// on success, and throws (cref:InvalidCastException) for an
        /// incompatible non-null runtime value.
        /// @param from Static source type.
        /// @param to Requested target type.
        /// @returns `true` for an explicit checked reference conversion.
        internal func HasCheckedReferenceConversion(from TypeSymbol?, to TypeSymbol?) bool {
            var from = from
            var to = to
            let removesReferenceNullability = from is NullableTypeSymbol nullableFrom &&
                IsReferenceLikeTarget(nullableFrom.UnderlyingType) &&
                !(to is NullableTypeSymbol)
            from = UnwrapReferenceNullable(from)
            to = UnwrapReferenceNullable(to)
            if from == nil || to == nil || !IsReferenceLikeTarget(from) || !IsReferenceLikeTarget(to) {
                return false
            }
            if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from, to) {
                return removesReferenceNullability
            }
            // Slice covariance must be explicitly spelled, including when either
            // array reference is nullable. Reuse the same element relationship as
            // the bare-array cast; lifting it preserves nil and reference identity.
            if IsCovariantArrayUpcast(from, to) {
                return true
            }
            // A checked downcast exists whenever the target widens back to the
            // source. Disable this same explicit-reference fallback during the
            // reverse probe so unrelated reference pairs cannot recurse forever.
            if ClassifyCore(to, from, allowStructuralProjection: false, allowExplicitReference: false).IsImplicit {
                return true
            }
            // Issue #3843: the UPCAST direction of the same checked reference
            // conversion, reached only when the source is reference-nullable and
            // the target is not — `cast[Node](blockOrNil)`, the G# rendering of
            // C# `(Node)node.Body`. The reverse probe above only admits the
            // DOWNCAST direction (`Base? -> Derived`), and the identity case is
            // already answered by `removesReferenceNullability` above, so a plain
            // widening that also drops the `?` had no checked-conversion
            // classification at all and reported GS0155. The runtime story is the
            // same one ADR-0167 already guarantees for the other two directions:
            // the value is a managed reference, `castclass`/no-op preserves nil,
            // and a non-nil value of an incompatible runtime type still throws
            // `InvalidCastException` — for a widening target the incompatible case
            // is simply unreachable.
            //
            // BOTH SIDES MUST BE NOMINAL. This restriction is load-bearing, not
            // decorative: "is `from -> to` implicit?" on its own also admits
            // conversions that are not REFERENCE conversions at all — above all
            // the issue #2850 structural-function -> named-delegate
            // MATERIALISATION, which emits `newobj`, not `castclass`. Without the
            // guard, `Do(Cancel(), nullableStructuralFunction)` — an IMPLICIT
            // argument conversion with no cast written anywhere — stopped
            // reporting GS0155 ("no conversion") and reported GS0156 ("an
            // explicit conversion exists, are you missing a cast?"), because
            // `Conversion.Classify(...).Exists` decides between those two
            // regardless of whether the context permits an explicit conversion.
            // Note this predicate is a TYPE-PAIR question consulted from implicit
            // paths too, so "only reachable behind a written cast" is not a
            // property the caller can supply — the shape restriction has to live
            // here.
            if removesReferenceNullability &&
                IsNominalReferenceShape(from) &&
                IsNominalReferenceShape(to) &&
                ClassifyCore(from, to, allowStructuralProjection: false, allowExplicitReference: false).IsImplicit {
                return true
            }
            if from.ClrType is {} fromClr &&
                to.ClrType is {} toClr &&
                !fromClr.IsValueType &&
                !toClr.IsValueType &&
                ClrTypeUtilities.IsAssignableByName(fromClr, toClr) {
                return true
            }
            let fromInterface = IsInterfaceLikeType(from)
            let toInterface = IsInterfaceLikeType(to)
            if fromInterface && toInterface {
                return true
            }
            // CLR permits a cross-cast between an interface and an open class.
            // A sealed class is eligible only when it implements the interface,
            // which the reverse implicit-conversion probe above already proved.
            if fromInterface && IsClassLikeReferenceType(to) {
                return !IsSealedReferenceType(to)
            }
            if toInterface && IsClassLikeReferenceType(from) {
                return !IsSealedReferenceType(from)
            }
            return false
        }

        /// Issue #3685: reports whether a one-dimensional array/slice pair forms a
        /// CLR-covariant reference UPCAST — the source element is a reference type
        /// that converts to the target element by an implicit reference conversion
        /// (`[]DirectoryInfo` → `[]FileSystemInfo`).
        /// @remarks G# slices stay INVARIANT for IMPLICIT conversions (issue #2516): an
        /// unannounced covariant assignment is the classic
        /// (cref:ArrayTypeMismatchException) hazard, and no implicit branch
        /// consults this predicate. But the runtime representation of `[]T` is
        /// exactly a CLR `T[]` (ADR-0016), which the CLR already treats as a
        /// `B[]` for any base `B` of `T`, so the conversion cannot
        /// fail — it is a no-op reference upcast. Requiring it to be SPELLED
        /// (`cast[[]FileSystemInfo](dirs)`) keeps the hazard visible at the
        /// use site while giving migrated C# (whose array covariance is implicit)
        /// a faithful, identity-preserving target — the alternative, a projecting
        /// copy, would silently change reference identity.
        /// @param from Static source type.
        /// @param to Requested target type.
        /// @returns `true` for a covariant one-dimensional array upcast.
        internal func IsCovariantArrayUpcast(from TypeSymbol?, to TypeSymbol?) bool {
            let sourceElement TypeSymbol? = UnwrapReferenceNullable(OneDimensionalArrayElement(from))
            let targetElement TypeSymbol? = UnwrapReferenceNullable(OneDimensionalArrayElement(to))
            if sourceElement == nil ||
                targetElement == nil ||
                !IsReferenceLikeTarget(sourceElement) ||
                !IsReferenceLikeTarget(targetElement) ||
                AreTypeArgumentsEquivalent(sourceElement, targetElement) {
                return false
            }
            // The relationship must be a genuine CLR REFERENCE widening, not merely
            // "some implicit conversion exists". When both elements are CLR-backed,
            // metadata assignability is the authority — it excludes an imported
            // `op_Implicit` between two unrelated classes, which converts values but
            // establishes no array relationship, so treating it as a no-op upcast
            // would hand out a type-unsafe array. Only when an element's `ClrType`
            // is still unavailable (a same-compilation class during binding) does
            // the symbolic probe stand in; owned reference types cannot declare
            // conversion operators (those require an owned STRUCT), so no
            // user-defined conversion can slip through that arm.
            //
            // The probe runs WITHOUT the explicit-reference fallback either way:
            // only a widening (upcast) element relationship is covariant.
            if sourceElement.ClrType is {} sourceClr && targetElement.ClrType is {} targetClr {
                return ClrTypeUtilities.IsAssignableByName(targetClr, sourceClr)
            }
            let element = ClassifyCore(
                sourceElement,
                targetElement,
                allowStructuralProjection: false,
                allowExplicitReference: false
            )
            return element.Exists && element.IsImplicit
        }

        /// Returns the element type of a one-dimensional array-like type
        /// ((cref:SliceTypeSymbol), (cref:ArrayTypeSymbol), or an
        /// imported SZ-array surfaced through metadata), or `null`
        /// when [`type`](paramref) is not one.
        /// @param type The candidate array-like type.
        /// @returns The element type, or `null`.
        internal func OneDimensionalArrayElement(type TypeSymbol?) TypeSymbol? -> switch type {
            case slice is SliceTypeSymbol: slice.ElementType
            case array is ArrayTypeSymbol: array.ElementType
            case _ is RectangularArrayTypeSymbol: default(TypeSymbol?)
            case {
                ClrType: {IsArray: true} clrArray
            } when clrArray.GetArrayRank() == 1: TypeSymbol.FromClrTypeWithoutNullability(
                clrArray.GetElementType(),
                NullabilityFreeReason.TypeStructure
            )
            default: default(TypeSymbol?)
        }

        /// Issue #2354 follow-up: true when a bare (non-`?`) [`type`](paramref) should accept an implicit
        /// `nil ->` conversion
        /// without requiring an explicit `T?` wrapper. Deliberately
        /// NARROWER than (cref:IsReferenceLikeTarget): only a G#-declared
        /// reference type — a `class` ((cref:StructSymbol) with
        /// (cref:StructSymbol.IsClass)) or an (cref:InterfaceSymbol)
        /// — or a reference-constrained type parameter qualifies. A general
        /// CLR-backed reference type reached only through
        /// (cref:IsReferenceLikeTarget)'s final `ClrType` fallback
        /// (e.g. `string`, `object`, or a function/delegate/sequence
        /// type) is intentionally EXCLUDED here: those already participate in
        /// G#'s dedicated nullable-narrowing / smart-cast tracking (issue #2159)
        /// and the arrow-function-type's deliberate explicit-`?`-required
        /// rule (issue #715), both of which rely on a bare slot of one of those
        /// kinds still rejecting `nil` to detect narrowing invalidation /
        /// enforce the annotation. Only the new G#-declared-type-or-constraint
        /// case was ever spuriously over-restrictive.
        /// @param type The candidate (non-nullable-wrapper) target type.
        /// @returns `true` when `nil` converts to [`type`](paramref) without a `T?` wrapper.
        internal func IsNilAssignableWithoutNullableWrapper(type TypeSymbol?) bool {
            if type != nil && NativeProtocolMetadata.IsProtocol(type) {
                return false
            }
            return type is InterfaceSymbol ||
                type is StructSymbol &&
                type.IsClass == true ||
                IsReferenceConstrainedTypeParameter(type) ||
                type is TypeParameterSymbol &&
                type.DependentBoundProvesReferenceType == true
        }

        /// Issue #2354 follow-up: true when [`from`](paramref) and
        /// [`to`](paramref) denote the exact same (possibly self-referential,
        /// possibly open-generic) G# (cref:StructSymbol) type, even though
        /// they may be two non-reference-equal instances. This normalizes the
        /// asymmetry between an OPEN generic definition (whose
        /// (cref:StructSymbol.TypeArguments) is empty by construction —
        /// e.g. the type used for a generic class's own `this` parameter) and
        /// the SAME type spelled out explicitly with its own type parameters as
        /// arguments (e.g. a member signature written `Box[T]` inside
        /// `class Box[T]`, which binds through
        /// (cref:StructSymbol.Construct)). Both must share the same
        /// (cref:StructSymbol.Definition), and every type-argument slot
        /// (defaulting an open definition's missing arguments to its own
        /// (cref:StructSymbol.TypeParameters)) must itself convert as
        /// identity — recursing through (cref:Classify) so a nested
        /// self-reference (e.g. `Wrapper[Box[T]]`) also unwinds correctly.
        /// @param from The source struct/class type.
        /// @param to The target struct/class type.
        /// @returns `true` when both sides denote the same type.
        internal func AreSameConstructedStructIdentity(from StructSymbol?, to StructSymbol?) bool {
            if from == nil || to == nil || !object.ReferenceEquals(from.Definition, to.Definition) {
                return false
            }
            let fromArgs = if from.TypeArguments.IsDefaultOrEmpty {
                from.TypeParameters.CastArray[TypeSymbol]()
            } else {
                from.TypeArguments
            }
            let toArgs = if to.TypeArguments.IsDefaultOrEmpty {
                to.TypeParameters.CastArray[TypeSymbol]()
            } else {
                to.TypeArguments
            }
            if fromArgs.IsDefaultOrEmpty && toArgs.IsDefaultOrEmpty {
                // Non-generic struct/class: same Definition already suffices.
                return true
            }
            if fromArgs.Length != toArgs.Length {
                return false
            }
            for var i = 0; i < fromArgs.Length; i++ {
                if (fromArgs[i] == toArgs[i]) {
                    continue
                }
                let slotConversion = Classify(fromArgs[i], toArgs[i])
                if !slotConversion.Exists || !slotConversion.IsIdentity {
                    return false
                }
            }
            return true
        }

        internal func IsClassLikeReferenceType(type TypeSymbol) bool -> type is StructSymbol &&
            type.IsClass == true ||
            type.ClrType is {IsClass: true}

        /// Issue #4011: whether the pair is a `map[K, V]` flowing into one of
        /// the interfaces its `Dictionary<K, V>` backing implements.
        /// @remarks The emitter's counterpart to
        /// (cref:TryClassifyMapInterfaceConversion). A
        /// `Dictionary<K, V>` reference already IS every one of these
        /// interfaces at run time, so the conversion is representation-preserving
        /// and emits no IL — the same disposition the identity arm beside it takes.
        /// Exposed rather than re-derived so the two cannot drift apart.
        /// @param from The source type.
        /// @param to The target type.
        /// @returns `true` when the pair is that upcast.
        internal func IsMapInterfaceReferenceUpcast(from TypeSymbol?, to TypeSymbol?) bool -> from != nil &&
            to != nil &&
            TryClassifyMapInterfaceConversion(from, to, out _)

        internal func IsSealedReferenceType(type TypeSymbol) bool {
            if type is StructSymbol{IsClass: true} userClass {
                // ADR-0078: `sealed class` denotes a CLOSED HIERARCHY, not a
                // CLR-sealed type — same-package subclasses remain legal, and
                // TypeDefEmitter.ResolveStructTypeShape deliberately omits
                // TypeAttributes.Sealed for it (only a plain, non-open,
                // non-sealed-hierarchy class gets the CLR flag). Mirror that
                // exact condition here so a known subclass implementing the
                // tested interface is neither rejected by a checked cast nor by
                // smart-cast narrowing.
                return !userClass.IsOpen && !userClass.IsSealedHierarchy
            }
            return type.ClrType is {IsClass: true, IsSealed: true}
        }

        /// Issue #3843: whether [`type`](paramref) is a NOMINAL reference
        /// shape — a class or interface a CLR `castclass` can name. G#'s
        /// STRUCTURAL shapes are deliberately excluded even when they look
        /// class-like: a (cref:FunctionTypeSymbol) carries a
        /// `Func<…>`/`Action<…>` CLR backing, so
        /// (cref:IsClassLikeReferenceType) answers `true`
        /// for it, but its conversion to a named delegate is a MATERIALISATION
        /// (issue #2850) that emits `newobj` rather than a reference
        /// conversion; slices, arrays, rectangular arrays and function pointers
        /// likewise convert by element/signature rules of their own, each with a
        /// dedicated arm in (cref:ClassifyCore). Only the
        /// nullable-source WIDENING arm of
        /// (cref:HasCheckedReferenceConversion) consults this — the
        /// pre-existing identity and downcast arms are unchanged.
        /// @param type The type to test.
        /// @returns `true` for a nominal class/interface shape.
        private func IsNominalReferenceShape(type TypeSymbol?) bool -> type != nil &&
            (
            type is ChannelTypeSymbol ||
                (
                !(type is FunctionTypeSymbol) &&
                    !(type is FunctionPointerTypeSymbol) &&
                    !(type is SliceTypeSymbol) &&
                    !(type is ArrayTypeSymbol) &&
                    !(type is RectangularArrayTypeSymbol) &&
                    !(type is TupleTypeSymbol) &&
                    !(type is SequenceTypeSymbol) &&
                    !(type is AsyncSequenceTypeSymbol) &&
                    !(type is TypeParameterSymbol) &&
                    (IsClassLikeReferenceType(type) || IsInterfaceLikeType(type))
            )
        )

        private func UnwrapReferenceNullable(type TypeSymbol?) TypeSymbol? {
            var type = type
            while type is NullabilityAnnotatedTypeSymbol annotated {
                type = annotated.BaseType
            }
            while type is NullableTypeSymbol nullable && IsReferenceLikeTarget(nullable.UnderlyingType) {
                type = nullable.UnderlyingType
            }
            return type
        }

        /// Review follow-up (#1927/PR #1955): reports whether a variance type
        /// argument is a CLR reference type. CLR generic-interface variance
        /// (ECMA-335 II.9.7) only applies to reference-typed arguments; a value
        /// type (primitive, enum, or user struct) boxes to satisfy `Classify`'s
        /// implicit-conversion check but the emitter's variance path emits no
        /// box/cast, so it must never be treated as variance-eligible.
        private func IsReferenceTypeArgument(type TypeSymbol) bool {
            return switch type {
                case nil: false
                case _ is EnumSymbol: false
                case s is StructSymbol: s.IsClass
                case tp is TypeParameterSymbol: tp.HasReferenceTypeConstraint || tp.ClassConstraint != nil
                default: type.ClrType is not{IsValueType: true}
            }
        }

        /// Issue #1196: determines whether a generic type parameter
        /// [`typeParam`](paramref) is implicitly convertible (identity /
        /// implicit reference conversion) to [`target`](paramref) on the
        /// strength of its declared constraints alone. Returns `true`
        /// when [`target`](paramref) is (transitively) contained in the type
        /// parameter's effective interface set, or is a (transitive) base class of
        /// its class constraint. Mirrors C# §10.2.12.
        /// @remarks Deliberately excludes `object`: the binder erases open generic
        /// parameter slots (such as the `!0` element type of
        /// `List[T].Add(!0)`) to the `object` singleton, so a
        /// `T -> object` rule here cannot be distinguished from the identity
        /// argument conversion `T -> !0` and would cause the emitter to box
        /// the argument, yielding invalid IL.
        private func TypeParameterConvertsTo(typeParam TypeParameterSymbol, target TypeSymbol) bool {
            // `object` (and any target whose CLR type erases to `object`) is
            // excluded: an erased open generic parameter slot is represented as the
            // `object` singleton, so converting `T -> object` here is ambiguous with
            // the identity argument conversion `T -> !0` and would cause a spurious
            // box. `T -> object` needs no special-casing — it is a plain reference
            // conversion handled by the value-type/box paths in the emitter.
            if target == TypeSymbol.Object || target?.ClrType?.IsSameAs(typeof(object)) == true {
                return false
            }
            // G#-declared interface bound: include the bound and all of its
            // transitive base interfaces (plus any imported CLR base interfaces).
            if typeParam.InterfaceConstraint is InterfaceSymbol gInterface {
                for iface in gInterface.SelfAndAllBaseInterfaces() {
                    if iface == target || ClrInterfaceMatches(iface, target) {
                        return true
                    }
                    if !iface.BaseClrInterfaces.IsDefaultOrEmpty {
                        for clrBase in iface.BaseClrInterfaces {
                            if ClrAssignableTarget(clrBase, target) {
                                return true
                            }
                        }
                    }
                }
            }
            // Imported CLR interface bound: a `T : ISomeClrInterface` constraint.
            if typeParam.ClrInterfaceConstraint is TypeSymbol clrInterface &&
                ClrAssignableTarget(clrInterface, target) {
                return true
            }
            // Base-class constraint: include the class, its transitive base
            // classes, and every interface it (transitively) implements.
            if typeParam.ClassConstraint is TypeSymbol classConstraint {
                if classConstraint == target {
                    return true
                }
                let underlyingConversion = Classify(
                    classConstraint,
                    Invariant.Required(target, "a type-parameter conversion has a target type", expression: "target")
                )
                if underlyingConversion.Exists && underlyingConversion.IsImplicit {
                    return true
                }
            }
            return false
        }

        /// Issue #1196: matches a G#-declared interface symbol against a target that
        /// may itself be an imported CLR interface (e.g. when the interface bound's
        /// own `ClrType` is populated during a later phase).
        private func ClrInterfaceMatches(iface InterfaceSymbol, target TypeSymbol?) bool {
            return iface?.ClrType != nil && target?.ClrType != nil && ClrTypeUtilities.IsAssignableByName(
                target!!.ClrType,
                iface.ClrType
            )
        }

        /// Issue #1196: determines whether an imported CLR-typed constraint source is
        /// assignable to the target via the cross-context-safe by-name check.
        private func ClrAssignableTarget(source TypeSymbol?, target TypeSymbol?) bool {
            if source == target {
                return true
            }
            return source?.ClrType != nil && target?.ClrType != nil && ClrTypeUtilities.IsAssignableByName(
                target!!.ClrType,
                source!!.ClrType
            )
        }

        /// Issue #1420: determines whether two (cref:ImportedTypeSymbol)
        /// instances denote the same closed constructed generic when ONE side
        /// carries symbolic (cref:ImportedTypeSymbol.TypeArguments) (produced
        /// by substituting an extension's open generic receiver) while the OTHER is a
        /// plain CLR-backed closed generic whose arguments are described only by its
        /// (cref:TypeSymbol.ClrType). The CLR-backed side's generic arguments
        /// are normalized through (cref:TypeSymbol.FromClrType) so a BCL
        /// primitive (e.g. `System.Int32`) and the corresponding G# alias (e.g.
        /// `int32`) resolve to the SAME (cref:TypeSymbol). Requires at
        /// least one side to be symbolic so genuinely CLR-backed comparisons keep
        /// flowing through the existing (variance-aware) rules.
        private func AreConstructedGenericShapesIdentical(from ImportedTypeSymbol, to ImportedTypeSymbol) bool {
            let fromSymbolic = !from.TypeArguments.IsDefaultOrEmpty
            let toSymbolic = !to.TypeArguments.IsDefaultOrEmpty
            // Scope to the asymmetric case: the symmetric symbolic/symbolic and the
            // symmetric CLR/CLR paths are already handled above and elsewhere.
            if fromSymbolic == toSymbolic {
                return false
            }
            if !TryGetConstructedGenericShape(from, out var fromOpen, out var fromArgs) ||
                !TryGetConstructedGenericShape(to, out var toOpen, out var toArgs) {
                return false
            }
            if !fromOpen.IsSameAs(toOpen) || fromArgs.Length != toArgs.Length {
                return false
            }
            for var i = 0; i < fromArgs.Length; i++ {
                if !AreTypeArgumentsEquivalent(fromArgs[i], toArgs[i]) {
                    return false
                }
            }
            return true
        }

        /// Extracts the open CLR definition and semantic arguments of an imported generic, aggregate, or sequence alias.
        /// Reuses (cref:TryGetConstructedGenericArguments) to preserve annotation-backed contracts and CLR argument slots.
        private func TryGetConstructedGenericShape(
            symbol TypeSymbol?,
            @NotNullWhen(true) out openDefinition Type?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool {
            var shape = symbol
            while shape is NullabilityAnnotatedTypeSymbol annotatedShape {
                shape = annotatedShape.BaseType
            }
            // #4731: aliases must use the same symbolic relation AND rejection
            // guard as their imported interface spellings, never erased CLR probes.
            if (symbol is SequenceTypeSymbol or AsyncSequenceTypeSymbol) &&
                SequenceTypeSymbol
                .TryGetEnumerableInterfaceShape(symbol!!, out openDefinition, out var elementType) {
                typeArguments = ImmutableArray.Create(elementType)
                return openDefinition != nil
            }
            if shape is not ImportedTypeSymbol && shape is not StructSymbol{ClrType: not nil} {
                openDefinition = nil
                typeArguments = ImmutableArray[TypeSymbol].Empty
                return false
            }
            if shape is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                openDefinition = imported.OpenDefinition
                return TryGetConstructedGenericArguments(symbol!!, out typeArguments, out _)
            }
            let clr Type? = shape?.ClrType
            if clr != nil && clr.IsGenericType && !clr.IsGenericTypeDefinition {
                openDefinition = clr.GetGenericTypeDefinition()
                return TryGetConstructedGenericArguments(symbol!!, out typeArguments, out _)
            }
            openDefinition = nil
            typeArguments = ImmutableArray[TypeSymbol].Empty
            return false
        }

        private func IsTupleTypeArgumentPair(from TypeSymbol, to TypeSymbol) bool ->
        TupleTypeSymbol.TryGetTupleShape(from, out _) && TupleTypeSymbol.TryGetTupleShape(to, out _)

        private func TryGetIdenticalTypeArgumentPositions(
            from TypeSymbol,
            to TypeSymbol,
            out fromPositions ImmutableArray[TypeSymbol],
            out toPositions ImmutableArray[TypeSymbol]
        ) bool {
            fromPositions = ImmutableArray[TypeSymbol].Empty
            toPositions = ImmutableArray[TypeSymbol].Empty
            // Only native tuples need logical positions; the recognizer proves the imported ValueTuple layout.
            if (from.StripToBareShape() is TupleTypeSymbol || to.StripToBareShape() is TupleTypeSymbol) &&
                IsTupleTypeArgumentPair(from, to) {
                fromPositions = from.GetElementPositions()
                toPositions = to.GetElementPositions()
                return true
            }
            // Imported generic contracts retain annotated physical slots, including TRest.
            let fromGeneric = TryGetConstructedGenericShape(
                UnwrapPlatformAndNullable(from),
                out var fromOpen,
                out fromPositions
            )
            let toGeneric = TryGetConstructedGenericShape(
                UnwrapPlatformAndNullable(to),
                out var toOpen,
                out toPositions
            )
            if fromGeneric && toGeneric {
                return ClrTypeUtilities.AreSame(fromOpen, toOpen)
            }
            if !HaveSameTypeArgumentDefinition(from, to) {
                return false
            }
            if !fromGeneric {
                fromPositions = from.GetElementPositions()
            }
            if !toGeneric {
                toPositions = to.GetElementPositions()
            }
            return true
        }

        private func HaveSameTypeArgumentDefinition(from TypeSymbol, to TypeSymbol) bool {
            let a = from.StripToBareShape()
            let b = to.StripToBareShape()
            if a.ClrType != nil || b.ClrType != nil {
                return AreTypeArgumentsEquivalent(a, b)
            }
            if a is StructSymbol fromStruct && b is StructSymbol toStruct {
                return object.ReferenceEquals(fromStruct.Definition ?? fromStruct, toStruct.Definition ?? toStruct)
            }
            if a is InterfaceSymbol fromInterface && b is InterfaceSymbol toInterface {
                return object.ReferenceEquals(
                    fromInterface.Definition ?? fromInterface,
                    toInterface.Definition ?? toInterface
                )
            }
            if a is DelegateTypeSymbol fromDelegate && b is DelegateTypeSymbol toDelegate {
                return object.ReferenceEquals(
                    fromDelegate.Definition ?? fromDelegate,
                    toDelegate.Definition ?? toDelegate
                )
            }
            return AreTypeArgumentsEquivalent(a, b)
        }

        private func HaveIdenticalTypeArgumentContracts(from TypeSymbol, to TypeSymbol) bool {
            // Value optionality changes storage even when the symbol relays its underlying CLR type.
            if from.ReferenceNullability != to.ReferenceNullability || NullableLifting.IsAnyValueTypeNullable(
                from.StripToBareShape() as NullableTypeSymbol
            ) !=
            NullableLifting.IsAnyValueTypeNullable(to.StripToBareShape() as NullableTypeSymbol) ||
                !TryGetIdenticalTypeArgumentPositions(from, to, out var fromPositions, out var toPositions) {
                return false
            }
            if fromPositions.Length != toPositions.Length {
                return false
            }
            for var i = 0; i < fromPositions.Length; i++ {
                if !HaveIdenticalTypeArgumentContracts(fromPositions[i], toPositions[i]) {
                    return false
                }
            }
            return true
        }

        /// Issue #1088: determines whether two constructed generic
        /// imported types or sequence aliases denote the same closed type
        /// by comparing their open definitions and SYMBOLIC type arguments, rather
        /// than their (possibly erased) (cref:TypeSymbol.ClrType). A
        /// same-compilation user type used as a CLR generic argument has a
        /// `null` `ClrType` and erases to `object` on the
        /// closed shape, so a purely CLR-based comparison spuriously fails for
        /// otherwise identical instantiations (e.g. the declared variable type
        /// `Channel[BufferEntry]` vs. a factory method's return type).
        private func AreConstructedGenericsIdentical(from TypeSymbol, to TypeSymbol) bool {
            if !TryGetConstructedGenericShape(from, out var fromOpen, out var fromArguments) ||
                !TryGetConstructedGenericShape(to, out var toOpen, out var toArguments) ||
                !fromOpen.IsSameAs(toOpen) {
                return false
            }
            if fromArguments.IsDefaultOrEmpty ||
                toArguments.IsDefaultOrEmpty ||
                fromArguments.Length != toArguments.Length {
                return false
            }
            for var i = 0; i < fromArguments.Length; i++ {
                if !AreTypeArgumentsEquivalent(fromArguments[i], toArguments[i]) {
                    return false
                }
            }
            return true
        }

        /// Issue #2523: classifies a reference conversion between constructed
        /// imported generic types from their symbolic open-definition hierarchy
        /// instead of their possibly-erased CLR probe types.
        /// @param from The actual source shape.
        /// @param to The actual target shape.
        /// @param clrArgumentBoundary Whether CLR applicability already admitted reference annotations.
        /// @returns Whether the symbolic hierarchy and variance admit the relation.
        private func TryClassifyConstructedImportedReferenceConversion(
            from TypeSymbol?,
            to TypeSymbol?,
            clrArgumentBoundary bool = false
        ) bool {
            if from == nil ||
                !TryGetConstructedGenericShape(to, out var targetOpen, out var targetArguments) ||
                targetOpen == nil ||
                targetOpen.IsValueType {
                return false
            }
            // Issue #3501 (Track A6 keystone): a VALUE-TYPE source converting to a
            // variant INTERFACE target is C#'s boxing conversion composed with
            // interface variance (`ImmutableArray[IMethodSymbol]` →
            // `IEnumerable[ISymbol]`); the emitter's struct→interface arm already
            // boxes, and the boxed reference is runtime-assignment-compatible with
            // the variant interface, so only classification was missing. Non-
            // interface targets keep the value-type exclusion.
            // Closed CLR signatures have no symbolic owner vector to map.
            // Project their real interface closure; symbolic sources must
            // keep the owner-aware path and never fall back to erased probes.
            var sourceArguments ImmutableArray[TypeSymbol]
            if TryGetConstructedGenericShape(from, out var sourceOpen, out var sourceTypeArguments) &&
                (!sourceOpen!!.IsValueType || targetOpen.IsInterface) {
                if ClrTypeUtilities.AreSame(sourceOpen, targetOpen) {
                    sourceArguments = sourceTypeArguments
                } else if from is not ImportedTypeSymbol importedSource ||
                    (
                    if importedSource.OpenDefinition != nil && !importedSource.TypeArguments.IsDefaultOrEmpty {
                        !MemberLookup.TryMapConstructedTypeArgumentsThroughHierarchy(
                            importedSource,
                            targetOpen,
                            out sourceArguments
                        )
                    } else {
                        !TryProjectClrInterfaceArguments(importedSource, targetOpen, out sourceArguments)
                    }
                ) {
                    return false
                }
            } else if from is not ImportedTypeSymbol importedSource ||
                !TryProjectClrInterfaceArguments(importedSource, targetOpen, out sourceArguments) {
                // Issue #3501: a NON-generic imported class (e.g. Roslyn's
                // `SymbolEqualityComparer : IEqualityComparer<ISymbol?>`) has no
                // symbolic type arguments to map, but its CLR interface closure
                // still names the target's open definition; project that closed
                // interface's CLR arguments so the variance loop below can accept
                // `SymbolEqualityComparer -> IEqualityComparer[IMethodSymbol]`
                // exactly as C# does.
                return false
            }
            if sourceArguments.Length != targetArguments.Length {
                return false
            }
            let genericParameters = targetOpen.GetGenericArguments()
            if genericParameters.Length != sourceArguments.Length {
                return false
            }
            let isDelegateConformanceBoundary = ClrTypeUtilities.IsDelegateType(targetOpen)
            for var i = 0; i < sourceArguments.Length; i++ {
                let sourceArgument = sourceArguments[i]
                let targetArgument = targetArguments[i]
                if AreTypeArgumentsEquivalent(sourceArgument, targetArgument) {
                    continue
                }
                // Issue #3962: variance must not readmit a fixed-length mismatch
                // that the identity comparison above just rejected. `[3]int32` and
                // `[4]int32` are one CLR type, so the bare pair classifies as an
                // implicit conversion (issue #3998) and a COVARIANT slot would
                // accept it — `IEnumerable[[3]int32] -> IEnumerable[[4]int32]`.
                // Variance exists to relate two DIFFERENT runtime types through a
                // real reference conversion; here there is no reference conversion
                // to lean on, only two spellings of one `int32[]` that the language
                // says are different types. A contravariant slot is rejected for
                // the same reason. A metadata-recovered array keeps the leniency,
                // as everywhere else in this issue.
                if IsRejectedFixedArrayShapeMismatch(sourceArgument, targetArgument) {
                    return false
                }
                // Variance eligibility is about CLR reference-ness, NOT the
                // `where T : class` constraint: a nullable-annotated reference
                // argument (`ISymbol?` in `IEqualityComparer[ISymbol?]`) is
                // reference-shaped and variance-convertible (the annotation has no
                // runtime representation), while `Binder.IsReferenceTypeForConstraint`
                // deliberately rejects `T?`. Use the same `IsReferenceTypeArgument`
                // gate as the source-interface variance path (#1927) so
                // `IEqualityComparer[ISymbol?] -> IEqualityComparer[IMethodSymbol]`
                // classifies, matching C# (issue #3501 Translator burn-down).
                let variance = genericParameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
                let clrReferenceArguments = clrArgumentBoundary &&
                    IsReferenceTypeArgument(sourceArgument) &&
                    IsReferenceTypeArgument(targetArgument)
                let compatible = switch variance {
                    case GenericParameterAttributes.Covariant: IsVarianceArgumentCompatible(
                        sourceArgument,
                        targetArgument,
                        isDelegateConformanceBoundary
                    ) ||
                        (clrReferenceArguments && HasClrArgumentRuntimeRelation(sourceArgument, targetArgument))
                    case GenericParameterAttributes.Contravariant: IsVarianceArgumentCompatible(
                        targetArgument,
                        sourceArgument,
                        isDelegateConformanceBoundary
                    ) ||
                        (clrReferenceArguments && HasClrArgumentRuntimeRelation(targetArgument, sourceArgument))
                    default: false
                }
                if !compatible {
                    return false
                }
            }
            return true
        }

        /// Issue #3501: projects the CLR generic arguments a (possibly non-generic)
        /// imported reference type supplies for [`targetOpenDefinition`](paramref)
        /// by walking its CLR interface closure. This is the CLR-level counterpart
        /// to (cref:MemberLookup.TryMapConstructedTypeArgumentsThroughHierarchy)
        /// for sources with no symbolic type-argument vector (e.g. Roslyn's
        /// non-generic `SymbolEqualityComparer : IEqualityComparer<ISymbol?>`).
        /// Nullable annotations are erased at this level, which only widens the
        /// source side — exactly the C#/CLR variance behaviour.
        private func TryProjectClrInterfaceArguments(
            from ImportedTypeSymbol,
            targetOpenDefinition Type,
            out sourceArguments ImmutableArray[TypeSymbol]
        ) bool {
            sourceArguments = default(ImmutableArray[TypeSymbol])
            let clr Type? = from.ClrType
            if clr == nil || clr.IsArray {
                return false
            }
            for candidate in ClrTypeUtilities.EnumerateSelfAndInterfaces(clr, true) {
                var candidateDefinition Type
                var candidateArguments[]Type
                try {
                    if !candidate.IsGenericType || candidate.IsGenericTypeDefinition {
                        continue
                    }
                    candidateDefinition = candidate.GetGenericTypeDefinition()
                    candidateArguments = candidate.GetGenericArguments()
                } catch (NotSupportedException) {
                    continue
                }
                if !ClrTypeUtilities.AreSame(candidateDefinition, targetOpenDefinition) {
                    continue
                }
                let builder = ImmutableArray.CreateBuilder[TypeSymbol](candidateArguments.Length)
                for argument in candidateArguments {
                    builder.Add(TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure))
                }
                sourceArguments = builder.MoveToImmutable()
                return true
            }
            return false
        }

        // Issue #4172: this used to be its own unguarded copy of the hierarchy
        // walk. Forwards to StructSymbol's single guarded walk (fixed by #4162,
        // and the pattern PR #4170 already applied to ExternalClrOverrideResolver's
        // near-identical duplicate) instead of keeping a second copy that can
        // drift out of sync with its fix again.
        private func GetStructHierarchy(type StructSymbol) List[StructSymbol] -> type.GetHierarchy()

        /// Issue #1248: determines whether a (possibly constructed generic) class
        /// [`fromClass`](paramref) implicitly upcasts to a constructed generic
        /// base class [`toClass`](paramref) by walking the inheritance chain
        /// while substituting type arguments at each level.
        ///
        /// A base-type reference is declared in terms of the derived class's OWN
        /// type parameters (e.g. `TransformBase[TIn, TOut] : FilterBase[TIn]`),
        /// and a constructed instance keeps that base reference unsubstituted
        /// ((cref:StructSymbol.BaseClass) is the open definition's base). A
        /// naive reference-equality walk therefore compares `FilterBase[TIn]`
        /// against the target `FilterBase[int32]` and fails. This walk threads
        /// a substitution map mapping each class's declaration type parameters onto
        /// the concrete type arguments seen at the most-derived level, composing the
        /// map down every hop, so the base reference is fully substituted before the
        /// comparison. Handles multi-level chains (concrete leaf → generic mid →
        /// generic base), type-parameter renaming, and partial type-parameter flow
        /// (only some of the derived's parameters reaching the base). A wrong type
        /// argument or an unrelated definition still fails (GS0155).
        private func DerivesFromConstructed(fromClass StructSymbol, toClass StructSymbol) bool {
            if !TryProjectConstructedBaseArguments(fromClass, toClass, out var projected) ||
                projected.Length != toClass
                .TypeArguments
                .Length {
                return false
            }
            for var i = 0; i < projected.Length; i++ {
                if !AreTypeArgumentsEquivalent(projected[i], toClass.TypeArguments[i]) {
                    return false
                }
            }
            return true
        }

        /// Projects a constructed G# class onto a same-compilation generic base,
        /// preserving symbolic type arguments through every inheritance hop.
        private func TryProjectConstructedBaseArguments(
            fromClass StructSymbol,
            toClass StructSymbol,
            out projected ImmutableArray[TypeSymbol]
        ) bool {
            projected = ImmutableArray[TypeSymbol].Empty
            // Maps each visited class's declaration type parameters onto concrete
            // type arguments resolved in fromClass's context, composed across hops.
            var running Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            for c in GetStructHierarchy(fromClass) {
                // The most-derived class itself is the identity case (handled by the
                // caller); only its base chain is an upcast target.
                if !object.ReferenceEquals(c, fromClass) && object.ReferenceEquals(c.Definition, toClass.Definition) {
                    if c.TypeArguments.IsDefaultOrEmpty {
                        return toClass.TypeArguments.IsDefaultOrEmpty
                    }
                    let builder = ImmutableArray.CreateBuilder[TypeSymbol](c.TypeArguments.Length)
                    for argument in c.TypeArguments {
                        builder.Add(
                            if running == nil {
                                argument
                            } else {
                                Binder.SubstituteType(argument, running)
                            }
                        )
                    }
                    projected = builder.MoveToImmutable()
                    return true
                }
                // Extend the running map with this class's own declaration
                // parameters -> (resolved) arguments, so a deeper base whose type
                // arguments reference these parameters can be substituted.
                if c.Definition != nil &&
                    !c
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    !c.Definition!!
                    .TypeParameters
                    .IsDefaultOrEmpty {
                    let defParams = c.Definition!!.TypeParameters
                    let count = Math.Min(defParams.Length, c.TypeArguments.Length)
                    for var i = 0; i < count; i++ {
                        let arg = if running == nil {
                            c.TypeArguments[i]
                        } else {
                            Binder.SubstituteType(c.TypeArguments[i], running)
                        }
                        running ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                        running!![defParams[i]] = arg
                    }
                }
            }
            return false
        }

        /// ADR-0186 §3: the whole conversion table for the platform type
        /// `T!`, in one place.
        ///
        /// The governing rule is a single line — <em>a check is inserted exactly
        /// when a platform value flows into a destination whose declared type is a
        /// non-null reference type</em> — and every row below is its expansion.
        /// Stating it over the DESTINATION's nullability rather than over the
        /// literal type `T` is what makes the upcast rows
        /// (`T! -> object`, `T! -> BaseClass`,
        /// `T! -> IFace`) check rather than silently storing a nil into a
        /// slot the program may read back as non-null indefinitely.
        /// @param from The source type, possibly platform-wrapped.
        /// @param to The target type, possibly platform-wrapped.
        /// @param allowStructuralProjection Whether ADR-0148 projection is eligible.
        /// @param allowExplicitReference Whether checked reference downcasts are eligible.
        /// @returns The classified conversion.
        private func ClassifyPlatformType(
            from TypeSymbol,
            to TypeSymbol,
            allowStructuralProjection bool,
            allowExplicitReference bool
        ) Conversion {
            // `nil -> T!`: an ordinary null store, no check. Small and
            // load-bearing — an oblivious position admits nil BY CONSTRUCTION, so
            // depositing one is not a forgiveness at all, and without this row
            // ADR-0186 §9's oblivious scope would be unusable (ADR-0155 A9 records
            // that `!!` cannot bridge a literal `nil`).
            if from == TypeSymbol.Null {
                return if to is PlatformTypeSymbol {
                    Conversion.Implicit
                } else {
                    Conversion.None
                }
            }
            if to is PlatformTypeSymbol toPlatform {
                // `T -> T!` and `T? -> T!`, both implicit and representation-free.
                // `T? -> T!` is the row that looks alarming and is in fact the
                // point: an oblivious parameter genuinely admits nil — that is
                // what oblivious MEANS — so passing a `T?` to it is exactly
                // correct, and requiring `!!` there is the ceremony that produced
                // ADR-0186's 12,100-assertion ceiling.
                let source = if from is PlatformTypeSymbol sourcePlatform {
                    sourcePlatform.UnderlyingType
                } else {
                    (
                        if from is NullableTypeSymbol sourceNullable &&
                            IsReferenceLikeTarget(sourceNullable.UnderlyingType) {
                            sourceNullable.UnderlyingType
                        } else {
                            from
                        }
                    )
                }
                let toTarget = ClassifyCore(
                    source,
                    toPlatform.UnderlyingType,
                    allowStructuralProjection,
                    allowExplicitReference
                )
                // Never a check: the destination is not a non-null reference type.
                return if toTarget.IsIdentity || !toTarget.Exists {
                    toTarget
                } else {
                    Conversion(
                        toTarget.Exists,
                        isIdentity: false,
                        toTarget.IsImplicit,
                        toTarget.IsStructuralProjection,
                        requiresPlatformNilCheck: false
                    )
                }
            }
            let fromPlatform = cast[PlatformTypeSymbol](from)
            let underlying = fromPlatform.UnderlyingType
            // ADR-0186 §3 rule 3, for the shape the top-level arm would otherwise
            // swallow: a platform-wrapped CONTAINER.
            //
            // `C[T!]` does not always arrive spelled that way. An oblivious
            // `string[]` arrives as `[]string!` — the wrapper on the container,
            // the element carried by the reader's nullable-flags subtree — and
            // rule 5 says a read through it yields `T!`, which the reader agrees
            // with: `obliviousArray()[0]` really is `string!`. Converting that to
            // a bare `[]string` therefore IS `C[T!] -> C[T]` in substance, and
            // rule 3 gives it no conversion.
            //
            // Getting this wrong was strictly worse than the status quo rather
            // than merely incomplete: the container check fired, passed (the
            // array is not nil), and the ELEMENT's obliviousness was erased by
            // the conversion, so `b[0].Length` threw an unattributed NRE on a
            // program the pre-ADR-0186 model rejects outright.
            //
            // A pair this cannot compare — `[]string! -> object`,
            // `[]string! -> IEnumerable[string]`, anything that is not the same
            // container shape — is DECLINED here, not rejected, and falls
            // through to the ordinary rows below. A supertype view that promises
            // non-null elements (`IEnumerable[string]`) is then rejected by
            // `TryClassifyPlatformTypeArgumentMismatch` when the underlying pair
            // is classified (#4420); `object` and a nilable element view are not.
            if TryGetPlatformArgumentPairs(underlying, to, out var elementSource, out var elementTarget) {
                for var i = 0; i < elementSource.Length; i++ {
                    if IsIllegalPlatformArgumentRelation(RelatePlatformArguments(elementSource[i], elementTarget[i])) {
                        return Conversion.None
                    }
                }
            }
            // `T! -> T?` (and `T! -> U?` for any nilable destination): implicit,
            // no check — no conversion to non-null occurs, so interop-to-interop
            // flow costs nothing.
            //
            // Deliberately NOT classified as identity even when the underlyings
            // match. See `Conversion.PlatformChecked`: an identity here would beat
            // the checked `T! -> T` row in the overload ranker and invert §3's
            // tie-break, which says `T` wins.
            if to is NullableTypeSymbol {
                let nilable = ClassifyCore(underlying, to, allowStructuralProjection, allowExplicitReference)
                return if nilable.Exists && nilable.IsIdentity {
                    Conversion.Implicit
                } else {
                    nilable
                }
            }
            // Everything else: classify `T -> to` exactly as it would be for a
            // plain `T` source — an unrelated target keeps whatever answer `T`
            // gets — and add the check when the destination is a non-null
            // REFERENCE type. A value-type destination (a boxing/unboxing pair, an
            // enum conversion) needs no platform check: there is no reference to
            // be nil.
            let classified = ClassifyCore(underlying, to, allowStructuralProjection, allowExplicitReference)
            if !classified.Exists || !IsNonNullReferenceDestination(to) {
                return classified
            }
            return if classified.IsImplicit && !classified.IsStructuralProjection {
                Conversion.PlatformChecked
            } else {
                Conversion(
                    classified.Exists,
                    isIdentity: false,
                    classified.IsImplicit,
                    classified.IsStructuralProjection,
                    requiresPlatformNilCheck: true
                )
            }
        }

        /// ADR-0186 §3/§4: whether [`destination`](paramref) is a destination
        /// "whose declared type is a non-null reference type" — the exact phrase
        /// §4's rule turns on.
        /// @param destination The conversion target.
        /// @returns `true` when a platform source must be checked into it.
        private func IsNonNullReferenceDestination(destination TypeSymbol?) bool {
            var destination = destination
            if destination == nil ||
                destination is NullableTypeSymbol ||
                destination is PlatformTypeSymbol ||
                destination == TypeSymbol.Error ||
                destination == TypeSymbol.Void {
                return false
            }
            while destination is NullabilityAnnotatedTypeSymbol annotated {
                destination = annotated.BaseType
            }
            // A value-type destination boxes or unboxes; a nil source cannot reach
            // it as a non-null reference, so there is nothing for a check to add.
            return destination is {ClrType: {IsValueType: false}} || IsReferenceLikeTarget(destination!!)
        }

        /// ADR-0186 §3 rule 3: `C[T!]`, `C[T]` and `C[T?]` are three
        /// distinct constructed types, and exactly one implicit conversion exists
        /// between them — `C[T!] -> C[T?]`, recursively for nested
        /// arguments.
        ///
        /// <b>Why a dedicated arm rather than a tweak to the equivalence
        /// helpers.</b> Every existing comparison this pair would otherwise reach
        /// answers a question about RUNTIME shape, and for that question
        /// `string!` and `string` genuinely <em>are</em> one type:
        /// `PlatformTypeSymbol` relays its underlying's `ClrType`,
        /// `AreRuntimeEquivalentIgnoringReferenceNullability` strips the
        /// wrapper on purpose, and `AreTypeArgumentsEquivalent` compares CLR
        /// types by name. Teaching each of them about the wrapper would be wrong
        /// (they would then disagree with the emitter, which erases it) and is the
        /// per-site-predicate shape ADR-0186 removes. The conversion question is a
        /// different question, so it gets its own answer, once.
        ///
        /// <b>Scope.</b> This arm is inert unless a `PlatformTypeSymbol`
        /// appears somewhere in one of the two types, which — while
        /// `--nullability=platform-types` is off — is never. In particular it
        /// deliberately does <b>not</b> touch `C[T] ↔ C[T?]`, which ADR-0186
        /// §3 rule 4 leaves "unchanged by this ADR". (Measured on this baseline
        /// that pair converts freely in both directions, for imported and
        /// G#-declared generics alike, because the annotation strip at the top of
        /// (cref:ClassifyCore) discards inner nullability before any
        /// conversion rule runs. That is a real pre-existing aliasing hole of
        /// exactly the shape ADR-0186 §3 describes — and the ADR's assertion that
        /// "plain invariance has always and correctly rejected" it does not hold
        /// for this compiler — but closing it is a change to `T?`'s own
        /// semantics, which this ADR puts explicitly out of scope.)
        /// @param from The source type, before the annotation strip.
        /// @param to The target type, before the annotation strip.
        /// @param conversion The decided conversion when this arm owns the pair.
        /// @returns `true` when this arm decides the pair.
        private func TryClassifyPlatformTypeArgumentMismatch(
            from TypeSymbol?,
            to TypeSymbol?,
            out conversion Conversion
        ) bool -> TryClassifyPlatformTypeArgumentMismatch(from, to, out conversion, out _)

        private func TryClassifyPlatformTypeArgumentMismatch(
            from TypeSymbol?,
            to TypeSymbol?,
            out conversion Conversion,
            out rejectsImportedParameter bool
        ) bool {
            conversion = Conversion.None
            rejectsImportedParameter = false
            if from == nil || to == nil {
                return false
            }
            // ADR-0186 open question 13: function and delegate conversions are
            // conformance boundaries, not container value conversions. They have
            // no expression-level point at which rule 3's nested nil check could
            // be inserted, so this arm must consistently decline them whether the
            // delegate is represented as a FunctionTypeSymbol, DelegateTypeSymbol,
            // or imported CLR type.
            if IsDelegateConformanceBoundary(from) || IsDelegateConformanceBoundary(to) {
                return false
            }
            // #4420: an UPCAST (`List[string!]` to `IEnumerable[string]`,
            // `[]string!` to `IReadOnlyList[string]`) is the same aliasing hazard
            // through a supertype view: the callee reads non-null elements from a
            // container that may hold nil, and no check point exists. The pair
            // has two different generic definitions, so the same-shape comparison
            // below declines it, and the ordinary upcast rules strip the nested
            // annotation and admit it. Project the source's own positions onto
            // the destination's definition through its bases and interfaces and
            // apply rule 3 there. It runs before the platform-presence gate
            // because that gate does not look inside a flags-annotated array
            // (`[]!string!`); the projection reads positions itself. Only the
            // illegal direction is decided here; a legal pair falls through to
            // the rules below, unchanged. Function shapes and value-type
            // containers are excluded for the reasons given below.
            if !IsValueTypeLikeFrom(UnwrapPlatformAndNullable(from)) &&
                TryProjectPlatformArgumentsToSupertype(from, to, out var projected, out var supertypeArguments) {
                var hasIllegalProjection = false
                var hasUnrelatedProjection = false
                for var i = 0; i < projected.Length; i++ {
                    let directionalEscape = IsVariantPlatformEscape(projected[i], supertypeArguments[i])
                    if IsProjectedPlatformArgumentIllegal(
                        projected[i],
                        supertypeArguments[i],
                        out var projectedRejectsImported,
                        out var projectedIsUnrelated
                    ) ||
                        IsCovariantPlatformEscape(projected[i], supertypeArguments[i]) {
                        hasIllegalProjection = true
                        rejectsImportedParameter |= projectedRejectsImported || directionalEscape
                    } else {
                        hasUnrelatedProjection |= projectedIsUnrelated
                    }
                }
                if hasUnrelatedProjection {
                    rejectsImportedParameter = false
                    return false
                }
                if hasIllegalProjection {
                    return true
                }
            }
            if !ContainsPlatformType(from) && !ContainsPlatformType(to) {
                return false
            }
            // A FUNCTION SHAPE is a conformance boundary, not a container, and
            // rule 3 must not answer for it in either direction.
            //
            // Rule 3's soundness argument is entirely about ALIASING: two views
            // of one existing object, where a write through one view is read
            // through the other. A function type has no such object — it is a
            // signature, and converting to or from one is a *signature relation*
            // whose parameter/return compatibility is decided by CLR delegate
            // variance (`IsFunctionToDelegateConvertible`,
            // `IsFunctionShapeAssignable`), a different question with a
            // different answer.
            //
            // Letting it through was not academic. A `FunctionTypeSymbol`'s
            // `ClrType` is its materialized delegate type, so
            // `TryGetPlatformArgumentPairs`' `AreSame` check passed and
            // `(ViewModel) -> void` against an oblivious event's
            // `Action[ViewModel!]!` was read as `C[T] -> C[T!]` — rule 3's
            // illegal write direction — and rejected outright:
            // `Issue2585SemanticQualificationTests` reported *"Cannot convert
            // type '(Oahu.App.ViewModel) -> void' to
            // 'System.Action[Oahu.App.ViewModel!]!'"* for an ordinary lambda
            // subscribed to an ordinary oblivious event.
            //
            // <b>Both sides, and that is deliberate rather than an oversight.</b>
            // Copilot review on this PR pointed out that gating only the source
            // still leaves, say, `(List[string!]) -> void -> (List[string]) -> void`
            // admitted by `IsFunctionShapeAssignable`, whose runtime-equivalence
            // test erases nested platform annotations — the callee could write
            // nil through a view whose caller expects non-null elements. That is
            // true, and it is <b>ADR-0186 open question 13</b>, which states the
            // hole and accepts it: *"Interface implementation, delegate
            // conversion and generic-constraint substitution are signature
            // relations, not value conversions, so there is no expression at
            // which a `T! -> T` check could be inserted … Kotlin has the
            // identical hole."* Rule 3 catching a subset of those pairs — only
            // the shapes `TryGetPlatformArgumentPairs` happens to recognise, and
            // only when a platform type is present somewhere — is an accident,
            // not a design, and an accident that rejects the ordinary
            // lambda-to-oblivious-event case while missing the interface one is
            // worse than a consistently open boundary. Pinned as the status quo
            // by `Adr0186PlatformTypeConversionTests.Section3_AFunctionShape_Is_AConformanceBoundary_Not_AContainer`,
            // so closing open question 13 flips a deliberate assertion rather
            // than silently changing untested behaviour.
            //
            // Declining hands the pair back to the rules that already answer it,
            // which is what this arm does for every pair it cannot speak to.
            // A VALUE-TYPE container is copied, not aliased, so rule 3's argument
            // does not reach it either.
            //
            // Rule 3 exists because "two views alias one object": a `nil` written
            // through the `C[T?]` view is read as non-null through the `C[T]`
            // view. Assigning a struct copies it — the destination is a different
            // object — so there is no second view to read through and nothing to
            // be unsound about. §2 already says value types are unaffected by
            // this ADR; this is that statement applied to the container position.
            //
            // Measured, and it is not hypothetical: `samples/NestedTypeOfConstructedGeneric.gs`
            // stopped compiling under `/nullability:platform-types` with
            // *"Cannot convert type 'Dictionary[string, int32].Enumerator' to
            // 'Dictionary[string, int32].Enumerator'"* — the two sides differ
            // only in an enclosing type argument's obliviousness, which the
            // nested type's display does not render, so the diagnostic named one
            // type twice. `List[int32].Enumerator` on the line above was
            // unaffected because `int32` contributes no reference position.
            //
            // The obliviousness there is itself spurious — `counts` is a
            // G#-constructed `Dictionary[string, int32]`, so §2's open-type-
            // parameter rule says the argument's own nullability wins and
            // `ProjectNullableFlags` should not be stamping an absent byte over
            // it. That is a separate defect in the projection path, tracked
            // rather than fixed here; this gate is correct on its own terms and
            // holds whether or not the projection is corrected.
            if IsValueTypeLikeFrom(UnwrapPlatformAndNullable(from)) {
                return false
            }
            if !TryGetPlatformArgumentPairs(from, to, out var fromArguments, out var toArguments) {
                return false
            }
            var widens = false
            var hasIllegal = false
            var hasUnrelated = false
            for var i = 0; i < fromArguments.Length; i++ {
                // #4420: a same-definition variant view is decided here too. A
                // metadata-backed `IEnumerable[string!]!` reaches the ordinary
                // variance check only after its argument flags are stripped, so
                // the guard there never sees the `!`. A pair of DIFFERENT types
                // at an invariant position is rejected by the ordinary rules
                // anyway, so rejecting the escape here costs nothing.
                if IsCovariantPlatformEscape(fromArguments[i], toArguments[i]) {
                    conversion = Conversion.None
                    if IsVariantPlatformEscape(fromArguments[i], toArguments[i]) {
                        rejectsImportedParameter = true
                    }
                    hasIllegal = true
                    continue
                }
                switch RelatePlatformArguments(fromArguments[i], toArguments[i]) {
                    case PlatformArgumentRelation.Same { }
                    case PlatformArgumentRelation.Unrelated {
                        // A platform-free position that does not agree. This arm
                        // has no opinion about such a pair; the ordinary rules do.
                        hasUnrelated = true
                    }
                    case PlatformArgumentRelation.Widening {
                        widens = true
                    }
                    case PlatformArgumentRelation.IllegalFromPlatform {
                        rejectsImportedParameter = true
                        conversion = Conversion.None
                        hasIllegal = true
                    }
                    case PlatformArgumentRelation.IllegalToPlatform {
                        // A stated source reaches a platform target. The relation
                        // remains illegal, but imported CLR targets deliberately
                        // keep this direction lenient.
                        conversion = Conversion.None
                        hasIllegal = true
                    }
                    case PlatformArgumentRelation.IllegalUnknown {
                        conversion = Conversion.None
                        hasIllegal = true
                    }
                    case PlatformArgumentRelation.IllegalMixed {
                        rejectsImportedParameter = true
                        conversion = Conversion.None
                        hasIllegal = true
                    }
                    default {
                        throw InvalidOperationException("Unknown platform argument relation.")
                    }
                }
            }
            if hasUnrelated {
                rejectsImportedParameter = false
                return false
            }
            if hasIllegal {
                return true
            }
            if !widens {
                // Platform-ness present but identical on both sides: not this
                // arm's business, and the ordinary rules give the right answer.
                return false
            }
            // The arm may only ACCEPT when the OUTER nullability is acceptable on
            // its own terms. `TryGetPlatformArgumentPairs` strips a top-level `?`
            // from both sides — it has to, so that `C[T!] -> C[T?]?` can be
            // compared at all — and that strip was silently deciding a question
            // it had no business deciding: a `C[T!]?` source reached a non-null
            // `C[T?]` slot as an implicit conversion, because this arm answered
            // before the ordinary nullable-to-non-null rejection ever ran. A nil
            // CONTAINER then reaches a slot declared never to hold one.
            //
            // Rejecting is always safe, so only the accept path is guarded;
            // declining hands the pair to the rules that already answer it
            // correctly (measured: the same pair without platform-ness is
            // rejected there today).
            if from is NullableTypeSymbol && !(to is NullableTypeSymbol) {
                return false
            }
            conversion = Conversion.Implicit
            return true
        }

        /// Relates one pair of corresponding type arguments.
        /// @param a The source argument.
        /// @param b The target argument.
        /// @returns The relation.
        private func RelatePlatformArguments(a TypeSymbol?, b TypeSymbol?) PlatformArgumentRelation {
            if !ContainsPlatformType(a) && !ContainsPlatformType(b) {
                // Platform-free, so no check is needed here — but that is NOT the
                // same as the two types agreeing, and this arm may not accept an
                // aggregate conversion on the strength of a position it never
                // looked at. Validate it the ordinary way and hand the pair back
                // when it does not hold.
                return if a != nil && b != nil && AreTypeArgumentsEquivalent(a, b) {
                    PlatformArgumentRelation.Same
                } else {
                    PlatformArgumentRelation.Unrelated
                }
            }
            let sourcePlatform PlatformTypeSymbol? = a as PlatformTypeSymbol
            let targetPlatform PlatformTypeSymbol? = b as PlatformTypeSymbol
            if sourcePlatform != nil && targetPlatform == nil {
                // Rule 2: the only legal direction, and only into an explicitly
                // nilable destination argument. Sound because every read through
                // the destination view has type `T?` and must be narrowed before
                // non-null use, so no view of the object can produce an unchecked
                // non-null read.
                if b is NullableTypeSymbol nilableTarget && TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    sourcePlatform.UnderlyingType,
                    nilableTarget.UnderlyingType
                ) {
                    let nestedRelation = RelateNestedPlatformArguments(
                        sourcePlatform.UnderlyingType,
                        nilableTarget.UnderlyingType
                    )
                    return if IsIllegalPlatformArgumentRelation(nestedRelation) {
                        nestedRelation
                    } else {
                        PlatformArgumentRelation.Widening
                    }
                }
                // Rule 3's `C[T!] -> C[T]` — but only when the two positions
                // really are the same underlying type differing in reference
                // nullability, which is the only thing rule 3 is about.
                //
                // The sibling arm below already had this guard; this one did not,
                // and the asymmetry was a second Copilot review finding on the
                // flip PR. Without it, an UNRELATED pair such as
                // `List[object!] -> List[Payload]` (where a same-compilation
                // `Payload` erases to `object`) was rejected outright, though
                // rule 3 has no opinion on it and the reverse direction already
                // declined correctly. `Unrelated` means "this arm cannot decide"
                // and hands the pair back to the ordinary rules; `Illegal` means
                // "no conversion exists", and only the genuinely
                // nullability-differing pair earns that.
                return if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    sourcePlatform.UnderlyingType,
                    UnwrapPlatformAndNullable(b) ?? b!!
                ) {
                    PlatformArgumentRelation.IllegalFromPlatform
                } else {
                    PlatformArgumentRelation.Unrelated
                }
            }
            if targetPlatform != nil && sourcePlatform == nil {
                // `C[T] -> C[T!]` and `C[T?] -> C[T!]`: both would let §3's
                // `nil -> T!` row deposit a nil into a container another holder
                // reads as non-null.
                //
                // But ONLY when the two positions are the same underlying type
                // differing in reference nullability — which is the only thing
                // rule 3 is about. Without the equivalence test this arm answered
                // "illegal" for any pair whose target happened to be
                // platform-wrapped, including pairs it has no opinion on at all,
                // and the sibling arm above already tests exactly this before
                // admitting the legal direction. The asymmetry was the defect.
                //
                // Measured: `Issue2471DictionaryIndexerSameCompilationTypeTests`
                // reported *"Cannot convert type 'List[Payload2471]' to
                // 'List[object!]!'"*. `Payload2471` is a SAME-COMPILATION type,
                // so its closed generic erases to `List<object>` and the
                // conversion is the ordinary erased-identity one the rest of
                // `ClassifyCore` already admits; `Payload2471` and `object` are
                // simply different types, which is `Unrelated` — "this arm cannot
                // decide" — not `Illegal`.
                return if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    UnwrapPlatformAndNullable(a) ?? a!!,
                    targetPlatform.UnderlyingType
                ) {
                    PlatformArgumentRelation.IllegalToPlatform
                } else {
                    PlatformArgumentRelation.Unrelated
                }
            }
            return RelateNestedPlatformArguments(
                sourcePlatform?.UnderlyingType ?? a,
                targetPlatform?.UnderlyingType ?? b
            )
        }

        /// Applies rule 3 one level further in, for nested generic arguments.
        /// @param a The source type.
        /// @param b The target type.
        /// @returns The combined relation of the nested arguments.
        private func RelateNestedPlatformArguments(a TypeSymbol?, b TypeSymbol?) PlatformArgumentRelation {
            if !ContainsPlatformType(a) && !ContainsPlatformType(b) {
                return PlatformArgumentRelation.Same
            }
            if !TryGetPlatformArgumentPairs(a, b, out var nestedFrom, out var nestedTo) {
                // One side carries platform-ness at a position the other cannot be
                // compared against at all. Refuse rather than guess — but note
                // this is the NESTED walk, reached only after the two types were
                // already established as the same constructed shape, so it cannot
                // reject an ordinary upcast. The top-level entry point declines
                // (returns false, leaving the pair to the arms below) instead,
                // which is what keeps `[]string! -> object` and
                // `[]string! -> IEnumerable[string]` legal.
                return PlatformArgumentRelation.IllegalUnknown
            }
            var widens = false
            var hasIllegalFromPlatform = false
            var hasIllegalToPlatform = false
            var hasIllegalUnknown = false
            for var i = 0; i < nestedFrom.Length; i++ {
                switch RelatePlatformArguments(nestedFrom[i], nestedTo[i]) {
                    case PlatformArgumentRelation.Same { }
                    case PlatformArgumentRelation.Unrelated {
                        return PlatformArgumentRelation.Unrelated
                    }
                    case PlatformArgumentRelation.Widening {
                        widens = true
                    }
                    case PlatformArgumentRelation.IllegalFromPlatform {
                        hasIllegalFromPlatform = true
                    }
                    case PlatformArgumentRelation.IllegalToPlatform {
                        hasIllegalToPlatform = true
                    }
                    case PlatformArgumentRelation.IllegalUnknown {
                        hasIllegalUnknown = true
                    }
                    case PlatformArgumentRelation.IllegalMixed {
                        hasIllegalFromPlatform = true
                        hasIllegalToPlatform = true
                    }
                    default {
                        throw InvalidOperationException("Unknown platform argument relation.")
                    }
                }
            }
            if hasIllegalFromPlatform && (hasIllegalToPlatform || hasIllegalUnknown) {
                return PlatformArgumentRelation.IllegalMixed
            }
            if hasIllegalUnknown {
                return PlatformArgumentRelation.IllegalUnknown
            }
            if hasIllegalFromPlatform {
                return PlatformArgumentRelation.IllegalFromPlatform
            }
            if hasIllegalToPlatform {
                return PlatformArgumentRelation.IllegalToPlatform
            }
            return if widens {
                PlatformArgumentRelation.Widening
            } else {
                PlatformArgumentRelation.Same
            }
        }

        private func IsIllegalPlatformArgumentRelation(
            relation PlatformArgumentRelation
        ) bool -> relation == PlatformArgumentRelation.IllegalFromPlatform ||
            relation == PlatformArgumentRelation.IllegalToPlatform ||
            relation == PlatformArgumentRelation.IllegalUnknown ||
            relation == PlatformArgumentRelation.IllegalMixed

        /// #4420: whether a supertype view reads a platform element as a
        /// DIFFERENT non-null reference type through CLR variance
        /// (`List[string!]` to `IEnumerable[object]`).
        /// (cref:RelatePlatformArguments) only compares the same underlying
        /// type, so it calls this pair unrelated and hands it to the ordinary
        /// covariance rule, which admits it. The view is then a non-null read of
        /// an element that may be nil, which is rule 3's hazard. A nilable
        /// (`object?`) or platform target argument is not an escape.
        /// @param projected The source element, projected onto the target's definition.
        /// @param target The target's argument at the same position.
        /// @returns `true` when the view must be rejected.
        private func IsCovariantPlatformEscape(
            projected TypeSymbol?,
            target TypeSymbol?
        ) bool -> IsVariantPlatformEscape(projected, target) ||
            IsVariantPlatformEscape(target, projected)

        // One direction of the escape: a platform element on one side, a
        // different non-null reference type on the other, related by an implicit
        // conversion from the platform's underlying type. Read as covariance
        // (`List[string!]` -> `IEnumerable[object]`) or, reversed, as
        // contravariance (`IIn[object]` -> `IIn[string!]`, which writes a
        // possibly-nil `string!` into a sink declared non-null `object`).
        private func IsVariantPlatformEscape(
            platformSide TypeSymbol?,
            otherSide TypeSymbol?
        ) bool -> platformSide is PlatformTypeSymbol platform &&
            otherSide != nil &&
            !(otherSide is NullableTypeSymbol) &&
            !(otherSide is PlatformTypeSymbol) &&
            !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(platform.UnderlyingType, otherSide) &&
            IsNonNullReferenceDestination(otherSide) &&
            ClassifyCore(platform.UnderlyingType, otherSide, allowStructuralProjection: false).IsImplicit

        private func AnyContainsPlatformType(types ImmutableArray[TypeSymbol]) bool {
            for type in types {
                if ContainsPlatformType(type) {
                    return true
                }
            }
            return false
        }

        private func SupertypesOf(definition Type) sequence[Type] {
            // The repository's cached reader completes interfaces inherited
            // through a base class, which `GetInterfaces` does not under every
            // MetadataLoadContext.
            for candidate in ClrTypeUtilities.SafeGetInterfaces(definition) {
                yield candidate
            }
            for var current Type? = definition.BaseType;
                current != nil &&
                current.FullName != "System.Object";
                current = current!!.BaseType {
                yield current
            }
        }

        /// #4420: projects a same-compilation type's substituted imported
        /// supertype (an implemented CLR interface or an imported base class)
        /// onto [`to`](paramref). The supertype either IS the target's
        /// definition, or reaches it through its own CLR hierarchy, which the
        /// imported arm of (cref:TryProjectPlatformArgumentsToSupertype)
        /// walks; an imported symbol is never a same-compilation one, so that
        /// recursion is one level.
        /// @param implemented The substituted imported supertype.
        /// @param to The conversion target.
        /// @param targetDefinition The target's generic definition.
        /// @param targetArguments The target's arguments.
        /// @param projected The supertype's arguments at the target's definition.
        /// @param projectedTargetArguments The target arguments to compare against.
        /// @returns `true` when a projection was found.
        private func TryProjectOntoImportedSupertype(
            implemented TypeSymbol,
            to TypeSymbol,
            targetDefinition Type,
            targetArguments ImmutableArray[TypeSymbol],
            out projected ImmutableArray[TypeSymbol],
            out projectedTargetArguments ImmutableArray[TypeSymbol]
        ) bool {
            projectedTargetArguments = targetArguments
            if TryGetConstructedGenericArguments(implemented, out var implementedArguments, out var implementedClr) &&
                implementedClr != nil &&
                implementedClr.IsGenericType == true &&
                ClrTypeUtilities
                .AreSame(
                if implementedClr.IsGenericTypeDefinition {
                    implementedClr
                } else {
                    implementedClr.GetGenericTypeDefinition()
                },
                targetDefinition
            ) &&
                implementedArguments.Length == targetArguments.Length {
                projected = implementedArguments
                return true
            }
            projected = ImmutableArray[TypeSymbol].Empty
            return !(implemented is StructSymbol) &&
                !(implemented is InterfaceSymbol) &&
                TryProjectPlatformArgumentsToSupertype(implemented, to, out projected, out projectedTargetArguments)
        }

        /// #4420: projects [`from`](paramref)'s element positions onto the
        /// generic definition of [`to`](paramref), when that definition is a
        /// base type or interface of the source's (or an array-compatible
        /// interface of an array or slice source). The positions are the source's
        /// own, read through (cref:TypeSymbol.GetElementPositions), so a
        /// nested `T!` survives the projection; a CLR-shape projection would
        /// erase it.
        /// @param from The conversion source.
        /// @param to The conversion target.
        /// @param projected The source's arguments at the target's definition.
        /// @param targetArguments The target's arguments.
        /// @returns `true` when a projection was found.
        private func TryProjectPlatformArgumentsToSupertype(
            from TypeSymbol?,
            to TypeSymbol?,
            out projected ImmutableArray[TypeSymbol],
            out targetArguments ImmutableArray[TypeSymbol]
        ) bool {
            var from = from
            var to = to
            projected = ImmutableArray[TypeSymbol].Empty
            targetArguments = ImmutableArray[TypeSymbol].Empty
            from = UnwrapPlatformAndNullable(from)
            to = UnwrapPlatformAndNullable(to)
            if from == nil || to == nil {
                return false
            }
            // A same-compilation G# base class has no CLR type while binding.
            // Reuse the same symbolic hierarchy projection as the ordinary class
            // upcast so rule 3 sees `Parent[string!]`, not the erased match that
            // DerivesFromConstructed intentionally uses for runtime identity.
            if from is StructSymbol sourceClass &&
                to is StructSymbol targetClass &&
                !targetClass
                .TypeArguments
                .IsDefaultOrEmpty &&
                TryProjectConstructedBaseArguments(sourceClass, targetClass, out projected) &&
                projected.Length == targetClass
                .TypeArguments
                .Length &&
                (AnyContainsPlatformType(projected) || AnyContainsPlatformType(targetClass.TypeArguments)) {
                targetArguments = targetClass.TypeArguments
                return true
            }
            if !TryGetConstructedGenericArguments(to, out targetArguments, out var targetClr) ||
                targetArguments.IsDefaultOrEmpty ||
                !(targetClr != nil && targetClr.IsGenericType == true) {
                return false
            }
            let targetDefinition = if targetClr.IsGenericTypeDefinition {
                targetClr
            } else {
                targetClr.GetGenericTypeDefinition()
            }
            let positions = from.GetElementPositions()
            if positions.IsDefaultOrEmpty {
                return false
            }
            // Hot path: ordinary generic upcasts carry no platform position, so
            // decline before any hierarchy walk. The vectors are checked rather
            // than the outer types, because a flags-annotated array hides its
            // element from the outer-type test.
            if !AnyContainsPlatformType(positions) && !AnyContainsPlatformType(targetArguments) {
                return false
            }
            // A same-compilation G# interface has no ClrType either; its
            // substituted `BaseClrInterfaces` (across its base interfaces) are
            // what admit the ordinary upcast.
            if from is InterfaceSymbol sourceInterface {
                for level in sourceInterface.SelfAndAllBaseInterfaces() {
                    for implemented in level.BaseClrInterfaces {
                        if implemented != nil &&
                            TryProjectOntoImportedSupertype(
                            implemented,
                            to,
                            targetDefinition,
                            targetArguments,
                            out projected,
                            out var interfaceTargetArguments
                        ) {
                            targetArguments = interfaceTargetArguments
                            return true
                        }
                    }
                }
                return false
            }
            // A same-compilation G# class has no ClrType while binding. Its
            // substituted `ImplementedClrInterfaces` are what admit the ordinary
            // upcast, and they carry the symbolic arguments (a `Repo[string!]`'s
            // `IEnumerable[string!]`), so project through them.
            if from is StructSymbol sourceStruct {
                for level in GetStructHierarchy(sourceStruct) {
                    // The level's substituted imported supertypes: each directly
                    // implemented CLR interface, and the imported base class.
                    // Each either IS the target's definition or reaches it
                    // through its own CLR hierarchy (`IChild<T> : IEnumerable<T>`,
                    // `Base<T> : List<T>`), which the imported arm below walks;
                    // they are imported symbols, so this recursion is one level.
                    let importedSupertypes = if level.ImportedBaseType is {} importedBase {
                        level.ImplementedClrInterfaces.Add(importedBase)
                    } else {
                        level.ImplementedClrInterfaces
                    }
                    for implemented in importedSupertypes {
                        if implemented != nil &&
                            TryProjectOntoImportedSupertype(
                            implemented,
                            to,
                            targetDefinition,
                            targetArguments,
                            out projected,
                            out var classTargetArguments
                        ) {
                            targetArguments = classTargetArguments
                            return true
                        }
                    }
                }
                return false
            }
            let sourceIsArray = (from is SliceTypeSymbol or ArrayTypeSymbol) ||
                (
                (from is NullabilityAnnotatedTypeSymbol and {ClrType: {IsArray: true}}) &&
                    from
                    .ClrType
                    ?.GetArrayRank() == 1
            )
            if sourceIsArray {
                if targetArguments.Length == 1 && positions.Length == 1 && IsArrayElementInterface(targetDefinition) {
                    projected = positions
                    return true
                }
                return false
            }
            let sourceClr = if from is ImportedTypeSymbol{OpenDefinition: {} importedOpen} {
                importedOpen
            } else {
                from.ClrType
            }
            if !(sourceClr != nil && sourceClr.IsGenericType == true) {
                return false
            }
            let sourceDefinition = if sourceClr.IsGenericTypeDefinition {
                sourceClr
            } else {
                sourceClr.GetGenericTypeDefinition()
            }
            if sourceDefinition.GetGenericArguments().Length != positions.Length {
                return false
            }
            // The source's own definition is a valid projection too: a
            // metadata-backed `IEnumerable[string!]!` against `IEnumerable[object]`
            // compares closed CLR types that differ (`<string>` vs `<object>`),
            // so the same-shape comparison declines it, and the variance check
            // below only ever sees the flag-stripped `string`.
            if ClrTypeUtilities.AreSame(sourceDefinition, targetDefinition) {
                // Compare against the target's own positions: a magic collection
                // (`map[K, V?]`) reports nullability-erased constructed arguments,
                // which would turn rule 2's legal `string! -> string?` into an
                // apparent `string! -> string`.
                projected = positions
                targetArguments = to.GetElementPositions()
                return positions.Length == targetArguments.Length
            }
            for candidate in SupertypesOf(sourceDefinition) {
                var candidateDefinition Type
                var candidateArguments[]Type
                try {
                    if !candidate.IsGenericType {
                        continue
                    }
                    candidateDefinition = if candidate.IsGenericTypeDefinition {
                        candidate
                    } else {
                        candidate.GetGenericTypeDefinition()
                    }
                    candidateArguments = candidate.GetGenericArguments()
                } catch (NotSupportedException) {
                    continue
                }
                if !ClrTypeUtilities.AreSame(candidateDefinition, targetDefinition) ||
                    candidateArguments.Length != targetArguments.Length {
                    continue
                }
                // Project every supertype argument through the source's symbolic
                // positions. The nullability-free funnel is appropriate here:
                // these are hierarchy shapes, not signature positions with
                // declaration nullability to merge. It also recursively preserves
                // platform holes inside composite arguments such as `List<T>`.
                let builder = ImmutableArray.CreateBuilder[TypeSymbol](candidateArguments.Length)
                for argument in candidateArguments {
                    builder.Add(
                        MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
                            argument,
                            sourceDefinition,
                            positions,
                            NullabilityFreeReason.TypeStructure
                        )
                    )
                }
                projected = builder.MoveToImmutable()
                return true
            }
            return false
        }

        private func IsProjectedPlatformArgumentIllegal(
            projected TypeSymbol,
            target TypeSymbol,
            out rejectsImportedParameter bool,
            out isUnrelated bool
        ) bool {
            let relation = RelatePlatformArguments(projected, target)
            isUnrelated = relation == PlatformArgumentRelation.Unrelated
            rejectsImportedParameter = relation == PlatformArgumentRelation.IllegalFromPlatform ||
                relation == PlatformArgumentRelation.IllegalMixed
            if !IsIllegalPlatformArgumentRelation(relation) {
                return false
            }
            // Same-shape arguments are rule 3's direct aliasing case. Different
            // shapes need their own supertype projection: `List<string!>` to
            // `IReadOnlyList<string>` exposes the platform element and is unsafe,
            // while `List<string!>` to `object` hides it and is an ordinary safe
            // covariance step.
            if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(projected, target) {
                return true
            }
            return TryClassifyPlatformTypeArgumentMismatch(
                projected,
                target,
                out var nested,
                out rejectsImportedParameter
            ) &&
                !nested.IsImplicit
        }

        /// The corresponding <b>argument positions</b> of two types, when the two
        /// are the same constructed shape, with their reference nullability
        /// intact.
        ///
        /// Both sides are taken together on purpose. The question ADR-0186 §3
        /// rule 3 asks is not "what are this type's arguments" but "are these two
        /// the same container, and if so which positions correspond" — and
        /// answering it one type at a time is what made the first version of this
        /// arm miss every <b>magic collection</b>. A slice, a fixed array, a
        /// rectangular array and a map are containers with element positions
        /// exactly as a constructed generic is, but none of them carries
        /// (cref:TypeSymbol.ConstructedTypeArguments) or
        /// (cref:ImportedTypeSymbol.TypeArguments), so the per-type helper
        /// declined for all four and the pair fell through to an equivalence arm
        /// that answered <em>identity</em>. The measured consequence: an oblivious
        /// `string[]` holding a null assigned into a bare `[]string`
        /// compiled with no check at all — strictly worse than the status quo,
        /// where the same program is rejected outright.
        ///
        /// Requiring the same <em>kind</em> on both sides, not merely the same
        /// CLR type, is load-bearing: `[]T` and `[N]T` are both backed
        /// by `T[]` (issue #3962), so a CLR comparison alone would treat
        /// `[3]string!` and `[]string` as one container.
        ///
        /// A pair this cannot compare is <b>declined</b>, never rejected. That is
        /// the difference between the caller that decides a whole conversion —
        /// which must leave `[]string! -> object` and
        /// `[]string! -> IEnumerable[string]` to the ordinary upcast arms
        /// — and the nested walk, which has already established that the two
        /// types are the same shape before it recurses.
        ///
        /// Scope is deliberately the four <em>invariant, mutable</em> container
        /// kinds plus constructed generics. `sequence[T]`,
        /// `asyncSequence[T]` and `chan[T]` are omitted: their element
        /// positions are read-only or direction-typed, so §3's write-direction
        /// soundness argument does not apply to them and applying it anyway would
        /// reject legitimate covariant conversions.
        /// @param from The source type.
        /// @param to The target type.
        /// @param fromArguments The source's argument positions.
        /// @param toArguments The target's corresponding positions.
        /// @returns `true` when the two are the same constructed shape.
        private func TryGetPlatformArgumentPairs(
            from TypeSymbol?,
            to TypeSymbol?,
            out fromArguments ImmutableArray[TypeSymbol],
            out toArguments ImmutableArray[TypeSymbol]
        ) bool {
            var from = from
            var to = to
            fromArguments = ImmutableArray[TypeSymbol].Empty
            toArguments = ImmutableArray[TypeSymbol].Empty
            from = UnwrapPlatformAndNullable(from)
            to = UnwrapPlatformAndNullable(to)
            if from == nil || to == nil {
                return false
            }
            let fromKind = TryGetCompositeContainerElements(from, out var fromElements)
            let toKind = TryGetCompositeContainerElements(to, out var toElements)
            if fromKind != CompositeContainerKind.None && toKind != CompositeContainerKind.None {
                if fromKind != toKind ||
                    fromElements.Length != toElements.Length ||
                    !HaveSameCompositeContainerShape(from, to) {
                    return false
                }
                fromArguments = fromElements
                toArguments = toElements
                return true
            }
            if !TryGetConstructedGenericArguments(from, out var fromGeneric, out var fromClr) ||
                !TryGetConstructedGenericArguments(to, out var toGeneric, out var toClr) ||
                fromGeneric.Length == 0 ||
                fromGeneric.Length != toGeneric.Length ||
                !ClrTypeUtilities.AreSame(fromClr, toClr) {
                return false
            }
            fromArguments = fromGeneric
            toArguments = toGeneric
            return true
        }

        /// Strips the two top-level reference-nullability wrappers.
        ///
        /// Both come off because this walk answers a question about ARGUMENT
        /// positions only; the outer wrapper is decided by the surrounding arms,
        /// which have already run or are about to. Leaving a `T?` on would
        /// make `C[T!] -> C[T?]?` look like a pair with no comparable
        /// arguments and so reject the one conversion §3 permits.
        /// @param type The type to strip.
        /// @returns The type beneath any platform/nullable wrappers.
        private func UnwrapPlatformAndNullable(type TypeSymbol?) TypeSymbol? {
            var type = type
            while (type is PlatformTypeSymbol or NullableTypeSymbol) {
                type = if type is PlatformTypeSymbol platform {
                    platform.UnderlyingType
                } else {
                    (cast[NullableTypeSymbol](type!!)).UnderlyingType
                }
            }
            return type
        }

        private func IsDelegateConformanceBoundary(type TypeSymbol?) bool {
            var type = type
            type = UnwrapPlatformAndNullable(type)
            return (type is FunctionTypeSymbol or DelegateTypeSymbol) || ClrTypeUtilities.IsDelegateType(type?.ClrType)
        }

        private func IsVarianceArgumentCompatible(
            source TypeSymbol,
            target TypeSymbol,
            allowPlatformNilCheck bool
        ) bool {
            if !IsReferenceTypeArgument(source) || !IsReferenceTypeArgument(target) {
                return false
            }
            let conversion = Classify(source, target)
            return conversion.Exists &&
                conversion.IsImplicit &&
                (allowPlatformNilCheck || !conversion.RequiresPlatformNilCheck)
        }

        /// The element positions of a magic collection, <b>with the nullability
        /// the reader gives them</b>.
        ///
        /// The array arms deliberately go through
        /// (cref:NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType)
        /// rather than reconstructing the element from the CLR type, because that
        /// accessor is <em>the same one an element READ uses</em>. It is what
        /// makes `obliviousArray()[0]` come back as `string!`, and this
        /// comparison has to agree with it: the whole question rule 3 asks is
        /// whether a read through the destination view would produce an unchecked
        /// non-null element, so the two must not derive the element type by
        /// different routes. (`GetTypeArgumentSymbol` is the GENERIC
        /// accessor and answers `TypeSymbol.Error` for an array — using it
        /// here is how the first attempt at this arm silently compared nothing.)
        /// @param type The candidate container.
        /// @param elements Its element positions, in order.
        /// @returns The container kind, or (cref:CompositeContainerKind.None).
        private func TryGetCompositeContainerElements(
            type TypeSymbol,
            out elements ImmutableArray[TypeSymbol]
        ) CompositeContainerKind {
            switch type {
                case slice is SliceTypeSymbol {
                    elements = ImmutableArray.Create(slice.ElementType)
                    return CompositeContainerKind.Slice
                }
                case array is ArrayTypeSymbol {
                    elements = ImmutableArray.Create(array.ElementType)
                    return CompositeContainerKind.FixedArray
                }
                case rectangular is RectangularArrayTypeSymbol {
                    elements = ImmutableArray.Create(rectangular.ElementType)
                    return CompositeContainerKind.Rectangular
                }
                case map_ is MapTypeSymbol {
                    elements = ImmutableArray.Create(map_.KeyType, map_.ValueType)
                    return CompositeContainerKind.Map
                }
                case TupleTypeSymbol {
                    elements = type.GetElementPositions()
                    return CompositeContainerKind.Tuple
                }
                case annotated is NullabilityAnnotatedTypeSymbol when IsSingleDimensionArray(
                    annotated.ClrType,
                    out var annotatedElement
                ) {
                    elements = ImmutableArray.Create(annotated.GetTypeArgumentSymbolForClrType(annotatedElement))
                    return CompositeContainerKind.Slice
                }
                case imported is ImportedTypeSymbol when IsSingleDimensionArray(
                    imported.ClrType,
                    out var importedElement
                ) {
                    elements = ImmutableArray.Create(
                        TypeSymbol.FromClrTypeWithoutNullability(importedElement, NullabilityFreeReason.TypeStructure)
                    )
                    return CompositeContainerKind.Slice
                }
                default {
                    elements = ImmutableArray[TypeSymbol].Empty
                    return CompositeContainerKind.None
                }
            }
        }

        /// Whether a CLR type is a rank-1 (SZ) array, and its element type.
        /// @param clrType The candidate CLR type.
        /// @param elementType The element type when it is.
        /// @returns `true` for a rank-1 array.
        private func IsSingleDimensionArray(clrType Type?, @NotNullWhen(true) out elementType Type?) bool {
            if clrType is {IsArray: true} array && array.GetArrayRank() == 1 && array.GetElementType() is {} element {
                elementType = element
                return true
            }
            elementType = nil
            return false
        }

        /// Whether two same-kind containers agree on the part of their shape that
        /// is not an element type — a fixed array's length and a rectangular
        /// array's rank.
        /// @param from The source container.
        /// @param to The target container.
        /// @returns `true` when the non-element shape matches.
        private func HaveSameCompositeContainerShape(from TypeSymbol, to TypeSymbol) bool -> switch (from, to) {
            case {Item1: a is ArrayTypeSymbol, Item2: b is ArrayTypeSymbol}: a.Length == b.Length
            case {Item1: a is RectangularArrayTypeSymbol, Item2: b is RectangularArrayTypeSymbol}: a.Rank == b.Rank
            default: true
        }

        /// The constructed type arguments of [`type`](paramref) <b>with their
        /// reference nullability intact</b>, which is the one thing
        /// (cref:TypeSymbol.ConstructedTypeArguments) cannot supply (it
        /// rebuilds each argument from the erased CLR shape).
        /// @param type The constructed generic type.
        /// @param arguments The per-argument symbols.
        /// @param definition The outer CLR type, for the same-definition check.
        /// @returns `true` when the arguments could be read.
        private func TryGetConstructedGenericArguments(
            type TypeSymbol,
            out arguments ImmutableArray[TypeSymbol],
            out definition Type?
        ) bool {
            arguments = ImmutableArray[TypeSymbol].Empty
            definition = type.ClrType
            if (type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol) &&
                SequenceTypeSymbol
                .TryGetEnumerableInterfaceShape(type, out definition, out var elementType) {
                arguments = ImmutableArray.Create(elementType)
                return true
            }
            if type is NullabilityAnnotatedTypeSymbol annotated {
                if annotated.ClrType is not{IsGenericType: true, IsGenericTypeDefinition: false} annotatedClr {
                    return false
                }
                let count = annotatedClr.GetGenericArguments().Length
                let builder = ImmutableArray.CreateBuilder[TypeSymbol](count)
                for var i = 0; i < count; i++ {
                    builder.Add(annotated.GetTypeArgumentSymbol(i))
                }
                arguments = builder.MoveToImmutable()
                return true
            }
            if type is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                arguments = imported.TypeArguments
                return true
            }
            if type.ConstructedTypeArguments.IsDefaultOrEmpty {
                return false
            }
            arguments = type.ConstructedTypeArguments
            return true
        }

        /// Whether a (cref:PlatformTypeSymbol) appears anywhere in
        /// [`type`](paramref)'s structure. This is the gate that makes every
        /// ADR-0186 §3 container arm provably inert while
        /// `--nullability=platform-types` is off, since nothing constructs a
        /// platform wrapper in that mode.
        /// @param type The type to scan.
        /// @returns `true` when the type mentions a platform type.
        private func ContainsPlatformType(type TypeSymbol?) bool {
            if type == nil {
                return false
            }
            // Iterative with cycle detection, not recursion with a depth cap.
            //
            // The cap was the bug: answering `false` at depth 17 means "no
            // platform type here", and every caller reads that as "this arm has
            // no business with this pair" — so a `C[...[T!]...]` nested deeply
            // enough fell straight through to the ordinary rules, which erase
            // inner nullability, and the container check silently switched off.
            // A guard against pathological input must not be spelled as a
            // negative ANSWER when the caller cannot tell the two apart.
            //
            // The real hazard the cap was reaching for is a cyclic symbol graph
            // (CRTP: `class C[T] : Base[C[T]]`), and a visited set handles that
            // exactly, with no arbitrary limit and no wrong answers below it.
            let pending = Stack[TypeSymbol]()
            let visited = HashSet[TypeSymbol](ReferenceEqualityComparer.Instance)
            pending.Push(type)
            while pending.Count > 0 {
                let current = pending.Pop()
                if !visited.Add(current) {
                    continue
                }
                if current is PlatformTypeSymbol {
                    return true
                }
                if current is NullabilityAnnotatedTypeSymbol annotated {
                    if annotated.ClrType is {IsGenericType: true, IsGenericTypeDefinition: false} annotatedClr {
                        let count = annotatedClr.GetGenericArguments().Length
                        for var i = 0; i < count; i++ {
                            if annotated.GetTypeArgumentSymbol(i) is {} argument {
                                pending.Push(argument)
                            }
                        }
                    }
                    if annotated.BaseType is {} annotatedBase {
                        pending.Push(annotatedBase)
                    }
                    continue
                }
                // `GetWrappedTypes` already yields an `ImportedTypeSymbol`'s type
                // arguments (its own arm does exactly that), so there is no
                // second loop here. There used to be, and while the visited set
                // now makes it merely redundant rather than exponential, a
                // duplicate traversal that looks load-bearing is worse than none.
                for wrapped in TypeSymbol.GetWrappedTypes(current) {
                    if wrapped != nil {
                        pending.Push(wrapped)
                    }
                }
            }
            return false
        }

        /// Issue #1088: compares two symbolic generic type arguments for identity,
        /// recovering same-compilation user types whose (cref:TypeSymbol.ClrType)
        /// has erased to `object` (or is `null`). Same-compilation
        /// symbols are identified by their defining symbols, not their simple names,
        /// so genuine negative conversions (e.g. `Channel[A]` → `Channel[B]`)
        /// still report GS0155.
        private func AreTypeArgumentsEquivalent(a TypeSymbol?, b TypeSymbol?) bool {
            var a = a
            var b = b
            if object.ReferenceEquals(a, b) {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            // Native and imported ValueTuple spellings share identity, not conversions of their invariant elements.
            if IsTupleTypeArgumentPair(a, b) {
                return HaveIdenticalTypeArgumentContracts(a, b)
            }
            a = a.StripToBareShape()
            b = b.StripToBareShape()
            // Nested generic arguments retain their symbolic shape through aliases
            // and annotation carriers instead of comparing erased CLR envelopes.
            if TryGetConstructedGenericShape(a, out _, out _) && TryGetConstructedGenericShape(b, out _, out _) {
                return AreConstructedGenericsIdentical(a, b)
            }
            // Issue #3962: a fixed-length array `[N]T` is backed by the plain
            // SZ-array `T[]` — the SAME CLR type as `[]T` and as every other
            // length — so the CLR comparison below cannot tell `[3]int32`,
            // `[4]int32` and `[]int32` apart and would collapse three distinct G#
            // types into one. Whenever BOTH sides still carry their G#-native
            // array-shaped symbol (so the length, and array-vs-slice, is actually
            // known on both sides), compare them symbolically instead.
            //
            // The "both sides" requirement is the #3924 metadata-recovery rule: an
            // array that came back through reflection is an
            // `ImportedTypeSymbol(T[])`, and its length is gone beyond recovery —
            // no downstream comparison can reconstruct it, so such a pair keeps the
            // lenient CLR comparison rather than being rejected on information
            // neither side has.
            if IsFixedArrayShapeKnownOnBothSides(a, b) {
                return TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(a, b)
            }
            // Both arguments resolve to a real CLR type: compare those by name.
            if a.ClrType != nil && b.ClrType != nil {
                return ClrTypeUtilities.AreSame(a.ClrType, b.ClrType)
            }
            // Same-named source types can belong to different owners or declarations.
            if a.ClrType == nil && b.ClrType == nil {
                return TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(a, b)
            }
            return false
        }

        /// Issue #2375: structural (symbol-identity-based) shape comparison
        /// shared by the plain (cref:FunctionTypeSymbol)-to-(cref:FunctionTypeSymbol)
        /// conversion check and the symbolically-resolved delegate-target check —
        /// this is safe to use even when one or both sides wrap a same-compilation
        /// type with no (or an erased) CLR backing.
        /// @param from The source function-type shape.
        /// @param to The target function-type shape.
        /// @returns `true` when the shapes are assignment-compatible.
        private func IsFunctionShapeAssignable(from FunctionTypeSymbol?, to FunctionTypeSymbol?) bool {
            if from == nil ||
                to == nil ||
                from.Arity != to.Arity ||
                !(
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(from.ReturnType, to.ReturnType) ||
                    ReturnTypeWidens(from.ReturnType, to.ReturnType)
            ) {
                return false
            }
            for var i = 0; i < from.Arity; i++ {
                // Function parameters are contravariant: every value the target
                // may supply must be accepted by the source callable. Issue #3505:
                // the relaxation is restricted to REFERENCE conversions — CLR
                // delegate variance cannot box, so a value-type difference (e.g.
                // `(object) -> R` into an `(int32) -> R` slot) used to compile
                // and then NRE at runtime. Value-typed slots must match exactly.
                if !IsImplicitReferenceVariantSlot(to.ParameterTypes[i], from.ParameterTypes[i]) &&
                    !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    to.ParameterTypes[i],
                    from.ParameterTypes[i]
                ) {
                    return false
                }
            }
            return true
        }

        /// Issue #4165: erases reference nullability before a CLR delegate
        /// (cref:IsImplicitReferenceVariantSlot) query. That method now
        /// looks through nullable wrappers for reference-like eligibility while
        /// preserving its original annotated operands for conversion
        /// classification. This CLR fallback intentionally pre-erases those
        /// operands too: CLR delegate variance does not distinguish
        /// `Base` from `Base?` (every reference type is nullable at the
        /// CLR level regardless of G#'s own annotation).
        ///
        /// ADR-0186: a (cref:PlatformTypeSymbol) comes off for exactly the
        /// same reason and with more force — `Base!` and `Base` are one
        /// runtime type by construction (§1), and §3 makes `T -> T!` an
        /// implicit identity conversion, so a delegate slot declared
        /// `Action[Base!]` must accept a lambda whose parameter is
        /// `Base`. Found by the full suite rather than by reading:
        /// `Issue2585SemanticQualificationTests` reported <em>"Cannot
        /// convert type '(ViewModel) -&gt; void' to
        /// 'System.Action[ViewModel!]!'"</em> — an oblivious event's handler
        /// type, which is an entirely ordinary interop shape.
        /// @param type The type to unwrap, possibly `null`.
        /// @returns The underlying type when [`type`](paramref) is nullable- or platform-wrapped; otherwise
        /// [`type`](paramref) itself.
        private func UnwrapNullableForVariance(type TypeSymbol?) TypeSymbol? -> switch type {
            case nullable is NullableTypeSymbol: nullable.UnderlyingType
            case platform is PlatformTypeSymbol: platform.UnderlyingType
            default: type
        }

        /// Issue #4184 (and its return-side sibling, #4186): true when accepting
        /// [`source`](paramref) for [`target`](paramref) would rely
        /// SOLELY on (cref:Type.IsAssignableFrom)'s CLR-level special case
        /// for value types — `Nullable<T>.IsAssignableFrom(T)` returns
        /// `true` even though no G#/C# implicit conversion
        /// permits a bare `T` to satisfy a `T?` method-group parameter
        /// or delegate-return slot (identity is required for a value-type slot;
        /// see this method's callers). (cref:ClrTypeUtilities.IsAssignableByName)
        /// is a shared utility used for many other assignability probes where
        /// that CLR lift IS the wanted behavior, so this gates the two narrow
        /// call sites that must reject it rather than narrowing the shared
        /// utility itself. Uses (cref:NullableLifting.IsValueTypeNullableClr)
        /// — the single seam for every `Nullable<T>` probe — rather than
        /// a second by-name detector.
        /// @param target The delegate-side (Invoke parameter or return) CLR type.
        /// @param source The function's effective CLR type for the same slot.
        /// @returns `true` when this pairing is only assignable via the CLR's implicit-nullable-lift special
        /// case.
        private func IsClrNullableWideningMismatch(
            target Type,
            source Type
        ) bool -> NullableLifting.IsValueTypeNullableClr(target) && !ClrTypeUtilities.AreSame(target, source)

        /// Determines whether a GSharp function type is convertible to a CLR
        /// delegate type by matching parameter arity / assignability and the
        /// return type. Uses metadata-safe (name-based) checks so it works for
        /// delegate types loaded through a MetadataLoadContext.
        /// @param fn The candidate function shape.
        /// @param delegateType The target delegate's CLR type.
        /// @param delegateTypeSymbol Issue #4165: the target delegate's own (cref:TypeSymbol), when
        /// available. A delegate closed over a same-compilation type argument
        /// (e.g. `Func[Derived, string]`) erases that argument to
        /// `object` in [`delegateType`](paramref)'s reflected generic
        /// arguments (its `TypeBuilder` doesn't exist as a real CLR type
        /// yet) — (cref:TypeSymbol.ConstructedTypeArguments) on the
        /// SYMBOL, not the erased CLR shape, is the only place the real argument
        /// (e.g. `Derived`) survives mid-binding, and is needed to classify
        /// a same-compilation base/derived contravariant parameter correctly.
        private func IsFunctionToDelegateConvertible(
            fn FunctionTypeSymbol,
            delegateType Type,
            delegateTypeSymbol TypeSymbol? = nil
        ) bool {
            if !ClrTypeUtilities.IsDelegateType(delegateType) {
                return false
            }
            // Issue #1100: a constructed generic delegate closed over a
            // same-compilation user type (e.g. `Action[Entry]`) surfaces as a
            // `System.Reflection.Emit.TypeBuilderInstantiation` whose
            // `GetMethod("Invoke")` throws `NotSupportedException` ("TypeBuilder
            // generic instantiation does not support resolving members"). Recover
            // the `Invoke` signature from the open generic definition and
            // substitute the type arguments by position so convertibility is
            // decided without resolving a member directly off the instantiation.
            if !TryGetDelegateInvokeSignature(delegateType, out var invokeParamTypes, out var invokeReturnType) {
                return false
            }
            if invokeParamTypes.Length != fn.ParameterTypes.Length {
                return false
            }
            // Issue #4165: when the delegate is closed over a same-compilation
            // type argument, `invokeParamTypes`/`invokeReturnType` above are the
            // ERASED CLR shape (the argument's `TypeBuilder` isn't a real,
            // reflectible closed type mid-binding — see the #1100 note above),
            // so a downstream `TypeSymbol.FromClrType` call on them can only ever
            // recover `object`. Recover the REAL per-position symbolic type
            // arguments from `delegateTypeSymbol.ConstructedTypeArguments`
            // (which prefers the symbolic — same-compilation-aware — arguments
            // over the erased CLR ones, see `ImportedTypeSymbol.ConstructedTypeArguments`)
            // by matching each Invoke parameter/return position, on the OPEN
            // delegate definition, to the generic-parameter position it
            // directly is — true for every single-purpose CLR delegate shape
            // (`Func[...]`, `Action[...]`, and any named delegate whose `Invoke`
            // signature is spelled directly in terms of its own type parameters).
            let symbolicParamTypes = [invokeParamTypes.Length]TypeSymbol?
            var symbolicReturnType TypeSymbol? = nil
            let symbolicArgs = delegateTypeSymbol?.ConstructedTypeArguments ?? ImmutableArray[TypeSymbol].Empty
            if !symbolicArgs.IsDefaultOrEmpty && delegateType.IsGenericType {
                var openDef Type? = nil
                try {
                    openDef = if delegateType.IsGenericTypeDefinition {
                        delegateType
                    } else {
                        delegateType.GetGenericTypeDefinition()
                    }
                } catch (NotSupportedException) {
                    // TypeBuilderInstantiation — fall through with openDef null.

                }
                let openInvoke MethodInfo? = openDef?.GetMethodSafe("Invoke")
                if openInvoke != nil {
                    let openParams = openInvoke.GetParameters()
                    if openParams.Length == symbolicParamTypes.Length {
                        for var i = 0; i < openParams.Length; i++ {
                            let openParamType = openParams[i].ParameterType
                            if openParamType.IsGenericParameter &&
                                uint32(openParamType.GenericParameterPosition) < uint32(symbolicArgs.Length) {
                                symbolicParamTypes[i] = symbolicArgs[openParamType.GenericParameterPosition]
                            }
                        }
                    }
                    let openReturnType = openInvoke.ReturnType
                    if openReturnType.IsGenericParameter &&
                        uint32(openReturnType.GenericParameterPosition) < uint32(symbolicArgs.Length) {
                        symbolicReturnType = symbolicArgs[openReturnType.GenericParameterPosition]
                    }
                }
            }
            for var i = 0; i < invokeParamTypes.Length; i++ {
                if fn.ParameterTypes[i] is FunctionTypeSymbol nestedFunction &&
                    IsFunctionToDelegateConvertible(nestedFunction, invokeParamTypes[i]) {
                    continue
                }
                let fnParamType TypeSymbol? = fn.ParameterTypes[i]
                // Issue #4184: `fnParamType?.ClrType` erases a nullable VALUE
                // type (`int32?`) to its bare underlying type (`int32`) -- see
                // `NullableTypeSymbol`'s own constructor -- so comparing that
                // erased shape against the delegate's declared parameter type
                // (also bare `int32`) reported an exact match and silently
                // accepted a method-group parameter mismatch `csc` rejects with
                // `CS0123` (a method declaring `T?` does not satisfy a delegate
                // slot declared as bare `T`). `NullableLifting.GetEffectiveClrType`
                // re-wraps a value-type underlying in `Nullable[T]` (identity for
                // every other shape, including reference types, so existing
                // reference-covariance/contravariance behavior below is
                // unchanged) -- the same helper already used for the analogous
                // RETURN-type erasure fixed for issue #4165, applied here to keep
                // both sides of this check symmetric.
                let fnParamEffectiveClr Type? = NullableLifting.GetEffectiveClrType(fnParamType)
                // Issue #4184 (reverse direction, found while building this
                // fix's own csc-measured T/T? matrix): `Type.IsAssignableFrom`
                // has its own CLR-level special case where
                // `Nullable<T>.IsAssignableFrom(T) == true` (measured directly --
                // `typeof(int?).IsAssignableFrom(typeof(int))` is `true` even
                // though `typeof(int).IsAssignableFrom(typeof(int?))` is
                // `false`), which exists to support the implicit `T -> T?` lift
                // used in ordinary expression contexts. C#'s method-group
                // parameter matching does NOT honor that lift for value types --
                // a method declaring bare `T` does not satisfy a delegate slot
                // declared `T?` either (`csc` rejects this with `CS0123` too,
                // the same diagnostic as the forward direction) -- so
                // `IsAssignableByName` below would silently re-introduce this
                // issue's exact bug in the opposite direction once the erasure
                // above stopped masking it. `IsClrNullableWideningMismatch`
                // detects precisely this shape (delegate slot is `Nullable<X>`,
                // the method's effective type is anything other than that same
                // `Nullable<X>`) and gates it out here rather than widening
                // `IsAssignableByName` itself, which is a shared utility used
                // for many unrelated assignability probes across the binder and
                // emitter where this CLR nullable-lift behavior may be exactly
                // what's wanted.
                if fnParamEffectiveClr != nil &&
                    !IsClrNullableWideningMismatch(invokeParamTypes[i], fnParamEffectiveClr) &&
                    ClrTypeUtilities.IsAssignableByName(invokeParamTypes[i], fnParamEffectiveClr) {
                    continue
                }
                // Issue #4165: a bare method group's own declared parameter type
                // may be a BASE class/interface of the delegate's declared
                // (DERIVED) element type — a legal contravariant method-group
                // conversion `csc` accepts (the callee only ever supplies a
                // DERIVED-typed argument, and a method that accepts the wider
                // BASE naturally accepts that). The CLR-type check above can
                // only ever fire when `fnParamEffectiveClr` is non-null, but a
                // same-compilation `class`/`interface` parameter type has NO
                // `ClrType` mid-binding (its `TypeBuilder` doesn't exist yet),
                // so it bailed out here unconditionally — matching `csc` only by
                // accident, for CLR-imported parameter types. Classify the slot
                // symbolically instead: `IsImplicitReferenceVariantSlot` already
                // knows how to walk a same-compilation class/interface hierarchy
                // (via `Conversion.Classify`'s own upcast rules) as well as a
                // CLR one, and is restricted to reference-only conversions —
                // exactly what a direct `ldftn`+`newobj` delegate creation can
                // honor. Prefer the recovered symbolic delegate-side type (the
                // real `Derived`) over the erased CLR one (`object`) so this
                // works for a same-compilation delegate element type too.
                // `IsImplicitReferenceVariantSlot` preserves nullability during
                // classification; this CLR delegate path intentionally erases it.
                if fnParamType != nil &&
                    IsImplicitReferenceVariantSlot(
                    UnwrapNullableForVariance(symbolicParamTypes[i]) ?? TypeSymbol.FromClrTypeWithoutNullability(
                        invokeParamTypes[i],
                        NullabilityFreeReason.IdentityComparison
                    ),
                    UnwrapNullableForVariance(fnParamType)!!
                ) {
                    continue
                }
                return false
            }
            let invokeReturnIsVoid = invokeReturnType == nil || string.Equals(
                invokeReturnType.FullName,
                "System.Void",
                StringComparison.Ordinal
            )
            if fn.ReturnType == TypeSymbol.Never {
                return true
            }
            if fn.ReturnType == TypeSymbol.Void || fn.ReturnType == nil {
                return invokeReturnIsVoid
            }
            if invokeReturnIsVoid {
                return false
            }
            let fnReturnClr Type? = fn.ReturnType.ClrType
            // Identity / reference-assignable return (covers exact match and
            // reference covariance).
            //
            // Issue #4165 regression (caught by the pre-existing
            // Issue1518NullableDelegateInferenceEmitTests suite): `NullableTypeSymbol.ClrType`
            // is the bare underlying VALUE type (see that type's own constructor),
            // so `bool?` and `bool` are indistinguishable through `fnReturnClr`
            // alone -- comparing that erased shape against `invokeReturnType`
            // let a lambda that actually returns `bool?` satisfy a delegate
            // candidate declared to return the bare `bool` during output-type
            // inference (e.g. `Select`'s `TResult` being probed against `Func[S,
            // bool]` as well as `Func[S, bool?]`), which used to be unreachable
            // here only because the PARAMETER loop above unconditionally
            // rejected any same-compilation parameter type before this return
            // check ever ran -- this fix's own parameter-side fallback removed
            // that accidental guard. `NullableLifting.GetEffectiveClrType`
            // re-wraps a value-type underlying in `Nullable[T]` (identity for
            // every other shape, including reference types, so the existing
            // reference-covariance behavior is unchanged), which is exactly what
            // `FunctionTypeSymbol.BuildClrType` already uses to avoid this same
            // erasure for the emitted delegate shape itself -- using it here too
            // makes this probe agree with what the emitter actually builds.
            // Issue #4186: the return-side, reverse-direction sibling of #4184's
            // parameter-side guard, for this method's REFLECTIVE fallback path
            // (this whole method only runs when the earlier, preferred symbolic
            // route — `Conversion.Classify`'s `TryGetDelegateFunctionTypeFromSymbol`
            // + `IsFunctionShapeAssignable` — cannot recover a symbolic delegate
            // shape, e.g. no `delegateTypeSymbol`, or an `Invoke` shape that
            // doesn't map directly onto the delegate's own type parameters; the
            // #4186 repro's own RED witness was actually caught by that earlier
            // symbolic route's `ReturnTypeWidens`, guarded separately below).
            // `IsAssignableByName` here would otherwise accept a bare
            // `T`-returning method group against a delegate slot declared `T?`,
            // relying solely on `Type.IsAssignableFrom`'s CLR special case
            // (`Nullable<T>.IsAssignableFrom(T) == true`) — `csc` rejects this
            // with `CS0407`. Safe for the legitimate lambda shape `csc` DOES
            // accept (`x => x != 0` target-typed against `Func<int, bool?>`):
            // measured directly against `LambdaBinder.BindLambdaExpression`/
            // `InferLambdaReturnType`, such a lambda's own `FunctionTypeSymbol.ReturnType`
            // is ALREADY `bool?` (the delegate's exact return type) by the time
            // this method runs, not the body's bare `bool` — so it satisfies the
            // identity comparison inside `IsClrNullableWideningMismatch`
            // (`AreSame(target, source)`) and never reaches the CLR quirk this
            // guard closes. No method-group/lambda discriminator is needed here.
            let fnReturnEffectiveClr Type? = NullableLifting.GetEffectiveClrType(fn.ReturnType)
            if fnReturnEffectiveClr != nil &&
                !IsClrNullableWideningMismatch(
                Invariant.Required(
                    invokeReturnType,
                    "a resolved delegate Invoke method has a return type",
                    expression: "invokeReturnType"
                ),
                fnReturnEffectiveClr
            ) &&
                ClrTypeUtilities.IsAssignableByName(invokeReturnType, fnReturnEffectiveClr) {
                return true
            }
            // Issue #4165's sibling gap: a same-compilation class/interface
            // return type has no `ClrType` mid-binding either, so a method
            // group returning a same-compilation DERIVED type could not convert
            // to a delegate declared over its BASE return type (covariant
            // return — legal, `csc` accepts it) even though the reference-only
            // symbolic check below already knows how to classify it. Prefer the
            // recovered symbolic delegate-side return type over the erased CLR
            // one, same as the parameter loop above.
            let effectiveReturnType = symbolicReturnType ?? TypeSymbol.FromClrTypeWithoutNullability(
                Invariant.Required(
                    invokeReturnType,
                    "a resolved delegate Invoke method has a return type",
                    expression: "invokeReturnType"
                ),
                NullabilityFreeReason.IdentityComparison
            )
            if fnReturnClr == nil &&
                IsImplicitReferenceVariantSlot(
                UnwrapNullableForVariance(fn.ReturnType)!!,
                UnwrapNullableForVariance(effectiveReturnType)!!
            ) {
                return true
            }
            if fnReturnClr == nil {
                return false
            }
            // Issue #1150: the function's numeric return type implicitly, losslessly
            // widens to the delegate's numeric return type (e.g. a `uint16`-returning
            // lambda flowing into a `Func<int32,int64>` parameter). Mirrors C#'s
            // implicit numeric conversion of a lambda body to the expected delegate
            // return type. Consulted by CLR full name so it is safe across reflection
            // contexts. Narrowing and signed/unsigned same-width mismatches are not
            // accepted here; they still require an explicit cast.
            return WidensNumerically(
                fnReturnClr,
                Invariant.Required(
                    invokeReturnType,
                    "a resolved delegate Invoke method has a return type",
                    expression: "invokeReturnType"
                )
            )
        }

        /// Issue #1100: resolves a delegate type's `Invoke` parameter and
        /// return types without resolving a member directly off a
        /// `System.Reflection.Emit.TypeBuilderInstantiation`. A
        /// constructed generic delegate closed over a same-compilation user type
        /// (whose CLR backing is an in-flight emit `TypeBuilder`) cannot serve
        /// (cref:Type.GetMethod(string)) — it throws
        /// (cref:NotSupportedException). In that case the `Invoke`
        /// signature is recovered from the open generic definition and each
        /// generic parameter is substituted by position with the constructed type's
        /// actual type argument. Returns `false` when no usable
        /// `Invoke` can be resolved.
        private func TryGetDelegateInvokeSignature(
            delegateType Type,
            out parameterTypes[]Type,
            @NotNullWhen(true) out returnType Type?
        ) bool {
            parameterTypes = Array.Empty[Type]()
            returnType = nil
            try {
                let invoke MethodInfo? = delegateType.GetMethodSafe("Invoke")
                if invoke == nil {
                    return false
                }
                let parms = invoke.GetParameters()
                parameterTypes = [parms.Length]Type
                for var i = 0; i < parms.Length; i++ {
                    parameterTypes[i] = parms[i].ParameterType
                }
                returnType = invoke.ReturnType
                return true
            } catch (NotSupportedException) {
                // delegateType is a TypeBuilderInstantiation; fall through to the
                // open-definition resolution below.

            }
            if !delegateType.IsGenericType || delegateType.IsGenericTypeDefinition {
                return false
            }
            var definition Type
            var typeArguments[]Type
            try {
                definition = delegateType.GetGenericTypeDefinition()
                typeArguments = delegateType.GetGenericArguments()
            } catch (NotSupportedException) {
                return false
            }
            let openInvoke MethodInfo? = definition.GetMethodSafe("Invoke")
            if openInvoke == nil {
                return false
            }
            let Substitute = func (t Type?) Type? {
                if t != nil && t.IsGenericParameter {
                    let pos = t.GenericParameterPosition
                    if uint32(pos) < uint32(typeArguments.Length) {
                        return typeArguments[pos]
                    }
                }
                return t
            }
            let openParms = openInvoke.GetParameters()
            parameterTypes = [openParms.Length]Type
            for var i = 0; i < openParms.Length; i++ {
                parameterTypes[i] = Invariant.Required(
                    Substitute(openParms[i].ParameterType),
                    "a delegate Invoke parameter type is present",
                    expression: "Substitute(openParms[i].ParameterType)"
                )
            }
            returnType = Invariant.Required(
                Substitute(openInvoke.ReturnType),
                "a delegate Invoke method has a return type",
                expression: "Substitute(openInvoke.ReturnType)"
            )
            return true
        }

        /// Determines whether a CLR type is the System.Delegate or
        /// System.MulticastDelegate base type (the common bases of every delegate),
        /// using name-based checks so it works under a MetadataLoadContext.
        private func IsSystemDelegateBaseType(type Type) bool {
            let fullName = type.FullName
            return string.Equals(fullName, "System.Delegate", StringComparison.Ordinal) || string.Equals(
                fullName,
                "System.MulticastDelegate",
                StringComparison.Ordinal
            )
        }

        /// ADR-0059 / issue #255: structural compatibility check between a
        /// G# function-typed value and a user-declared named delegate
        /// ((cref:DelegateTypeSymbol)). Used in lieu of the CLR-Type-based
        /// (cref:IsFunctionToDelegateConvertible) because the delegate has
        /// no `ClrType` during binding — its TypeDef is materialized at emit.
        private func IsFunctionStructurallyAssignable(fn FunctionTypeSymbol, target DelegateTypeSymbol) bool {
            let parameters = target.Parameters
            if parameters.Length != fn.ParameterTypes.Length {
                return false
            }
            for var i = 0; i < parameters.Length; i++ {
                if parameters[i].RefKind != RefKind.None {
                    return false
                }
                let fromType TypeSymbol? = fn.ParameterTypes[i]
                let toType TypeSymbol? = parameters[i].Type
                if fromType == nil || toType == nil {
                    return false
                }
                // Parameter types are contravariant in C#; G# v1 mirrors the
                // existing CLR-typed func→delegate rule, which is name-based
                // assignability — i.e., identity or an implicit conversion.
                let conv = Classify(fromType, toType)
                if (!conv.Exists || !conv.IsImplicit) && !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                    fromType,
                    toType
                ) {
                    return false
                }
            }
            let fnReturn = fn.ReturnType ?? TypeSymbol.Void
            let targetReturn = target.ReturnType ?? TypeSymbol.Void
            if fnReturn == TypeSymbol.Void {
                return targetReturn == TypeSymbol.Void
            }
            if targetReturn == TypeSymbol.Void {
                return false
            }
            let retConv = Classify(fnReturn, targetReturn)
            return (retConv.Exists && retConv.IsImplicit) ||
                TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(fnReturn, targetReturn)
        }

        // Issue #2290: identifies the two symbol kinds that ever wrap a genuine
        // referenced CLR type — a plain `ImportedTypeSymbol`, or a `StructSymbol`
        // semantic aggregate built for an imported `data class`/`data struct`
        // (issue #2263). A same-compilation user `struct`/`data struct`
        // `StructSymbol` has a null `ClrType` while binding (its CLR shape is
        // still being built), so it is correctly excluded here — only an
        // ALREADY-imported aggregate's non-null `ClrType` qualifies.
        private func IsImportedTypeIdentity(type TypeSymbol) bool -> type is ImportedTypeSymbol ||
            (type is StructSymbol && type.ClrType != nil)

        // Issue #3962: true when a fixed-length array is involved AND both sides
        // still carry their G#-native array shape, so the length (and
        // array-vs-slice) is actually known on both sides and may be compared.
        //
        // The "both sides" requirement is the #3924 metadata-recovery rule: an
        // array that came back through reflection is an `ImportedTypeSymbol(T[])`
        // whose length is gone beyond recovery, so such a pair keeps the lenient
        // CLR comparison rather than being rejected on information neither side
        // has.
        private func IsFixedArrayShapeKnownOnBothSides(a TypeSymbol?, b TypeSymbol?) bool -> (
            TypeSymbol.ContainsFixedLengthArray(a) || TypeSymbol.ContainsFixedLengthArray(b)
        ) &&
            !TypeSymbol.ContainsMetadataRecoveredArray(a) && !TypeSymbol.ContainsMetadataRecoveredArray(b)

        // Issue #3962: true when both sides know their array shape and those shapes
        // DISAGREE — the pair is two different G# types however the CLR sees them.
        // Used to stop generic variance readmitting a mismatch the identity
        // comparison already rejected.
        private func IsRejectedFixedArrayShapeMismatch(a TypeSymbol?, b TypeSymbol?) bool -> a != nil &&
            b != nil &&
            IsFixedArrayShapeKnownOnBothSides(a, b) &&
            !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(a, b)

        // Issue #3962: the escalation gate for the #2290 identity rule. A
        // constructed generic's CLR shape is only a faithful stand-in for its
        // symbolic type arguments when every argument round-trips through its own
        // `ClrType`. When one does not, the two symbols must be compared
        // SYMBOLICALLY (`AreRuntimeEquivalentIgnoringReferenceNullability`) rather
        // than by the erased closed CLR type, or two genuinely different
        // instantiations collapse into one.
        //
        // `HasSubstitutableTypeArgument` already covers the arguments whose CLR
        // type is absent or a projection (a same-compilation user type, an
        // in-scope type parameter, a nested constructed generic, a named tuple).
        // It deliberately does NOT cover an argument that HAS a real, closed CLR
        // type which is simply not injective — see
        // <see cref="TypeSymbol.ContainsFixedLengthArray"/>.
        private func RequiresSymbolicTypeArgumentIdentity(type TypeSymbol?) bool {
            var type = type
            type = type?.StripToBareShape()
            if (type is SequenceTypeSymbol or AsyncSequenceTypeSymbol) &&
                SequenceTypeSymbol
                .TryGetEnumerableInterfaceShape(type!!, out _, out var elementType) {
                return RequiresSymbolicTypeArgumentIdentity(elementType)
            }
            if type is not ImportedTypeSymbol{OpenDefinition: not nil} imported {
                return false
            }
            if imported.HasSubstitutableTypeArgument {
                return true
            }
            for argument in if imported.TypeArguments.IsDefaultOrEmpty {
                ImmutableArray[TypeSymbol].Empty
            } else {
                imported.TypeArguments
            } {
                if TypeSymbol.ContainsFixedLengthArray(argument) {
                    return true
                }
            }
            return false
        }

        // Issue #2299: for a matching pair of structural wrapper symbols (see the
        // call site above), extracts and compares the wrapped element type(s).
        // `ArrayTypeSymbol` additionally requires the fixed lengths to match, and
        // `MapTypeSymbol` requires BOTH the key and the value types to compare
        // identical. Any other/mismatched symbol kind returns `false` so the
        // caller falls through to the ordinary (non-identity) classification
        // rules — this helper only ever WIDENS what counts as identity, never
        // narrows an existing rule.
        private func TryClassifyWrappedElementIdentity(from TypeSymbol, to TypeSymbol) bool {
            switch from {
                case fromSlice is SliceTypeSymbol when to is SliceTypeSymbol toSlice {
                    return IsCrossContextIdenticalElement(fromSlice.ElementType, toSlice.ElementType)
                }
                case fromNullable is NullableTypeSymbol when to is NullableTypeSymbol toNullable {
                    return IsCrossContextIdenticalElement(fromNullable.UnderlyingType, toNullable.UnderlyingType)
                }
                case fromByRef is ByRefTypeSymbol when to is ByRefTypeSymbol toByRef {
                    return IsCrossContextIdenticalElement(fromByRef.PointeeType, toByRef.PointeeType)
                }
                case fromPointer is PointerTypeSymbol when to is PointerTypeSymbol toPointer {
                    return IsCrossContextIdenticalElement(fromPointer.PointeeType, toPointer.PointeeType)
                }
                case fromSequence is SequenceTypeSymbol when to is SequenceTypeSymbol toSequence {
                    return IsCrossContextIdenticalElement(fromSequence.ElementType, toSequence.ElementType)
                }
                case fromChannel is ChannelTypeSymbol when to is ChannelTypeSymbol toChannel {
                    return fromChannel.Direction == toChannel.Direction &&
                        IsCrossContextIdenticalElement(fromChannel.ElementType, toChannel.ElementType)
                }
                case fromAsync is AsyncSequenceTypeSymbol when to is AsyncSequenceTypeSymbol toAsync {
                    return IsCrossContextIdenticalElement(fromAsync.ElementType, toAsync.ElementType)
                }
                case fromArray is ArrayTypeSymbol when to is ArrayTypeSymbol toArray {
                    return fromArray.Length == toArray.Length &&
                        IsCrossContextIdenticalElement(fromArray.ElementType, toArray.ElementType)
                }
                case fromArray is RectangularArrayTypeSymbol when to is RectangularArrayTypeSymbol toArray {
                    return fromArray.Rank == toArray.Rank &&
                        IsCrossContextIdenticalElement(fromArray.ElementType, toArray.ElementType)
                }
                case fromMap is MapTypeSymbol when to is MapTypeSymbol toMap {
                    return IsCrossContextIdenticalElement(fromMap.KeyType, toMap.KeyType) &&
                        IsCrossContextIdenticalElement(fromMap.ValueType, toMap.ValueType)
                }
                case fromTuple is TupleTypeSymbol when to is TupleTypeSymbol toTuple {
                    if fromTuple.Arity != toTuple.Arity {
                        return false
                    }
                    for var i = 0; i < fromTuple.Arity; i++ {
                        if !IsCrossContextIdenticalElement(fromTuple.ElementTypes[i], toTuple.ElementTypes[i]) {
                            return false
                        }
                    }
                    return true
                }
                default {
                    return false
                }
            }
        }

        // Issue #3987: classifies the two SPELLINGS of one structural type — G#'s
        // canonical symbol on one side and the imported CLR family it IS on the
        // other. Only the shapes whose identity is an ADR fact participate:
        // `map[K, V]` / `Dictionary<K, V>` (ADR-0104) and a tuple /
        // `System.ValueTuple<…>` (ADR-0158). Slices, sequences and channels
        // already have their own cross-spelling rules (`[]T -> T[]`,
        // `TryGetEnumerableInterfaceShape`, `TryClassifyChannelConversion`), so
        // they are deliberately not restated here.
        //
        // A same-kind pair is left entirely to `TryClassifyWrappedElementIdentity`
        // above (which has already run), and a nullable wrapper on either side is
        // declined so the lifted rules keep their say over the underlying pair.
        //
        // The helper takes ownership of a recognised pair only when one side's
        // `ClrType` is unreadable — that is, when an element is open. Both CLR
        // families are INVARIANT, so over an open element the only relation that
        // exists is element-wise identity and there is nothing else to emit; a
        // pair that is fully CLR-backed on both sides is left to the existing
        // rules, which can still read the two types and decide for themselves.
        private func TryClassifyStructuralSpellingConversion(
            from TypeSymbol,
            to TypeSymbol,
            out conversion Conversion
        ) bool {
            conversion = Conversion.None
            if from.GetType() == to.GetType() || from is NullableTypeSymbol || to is NullableTypeSymbol {
                return false
            }
            var identical bool
            if MapTypeSymbol.TryGetMapShape(from, out var fromKey, out var fromValue) && MapTypeSymbol.TryGetMapShape(
                to,
                out var toKey,
                out var toValue
            ) {
                identical = IsCrossContextIdenticalElement(fromKey, toKey) &&
                    IsCrossContextIdenticalElement(fromValue, toValue)
            } else if TupleTypeSymbol.TryGetTupleShape(from, out var fromElements) && TupleTypeSymbol.TryGetTupleShape(
                to,
                out var toElements
            ) {
                identical = fromElements.Length == toElements.Length
                for var i = 0; identical && i < fromElements.Length; i++ {
                    identical = IsCrossContextIdenticalElement(fromElements[i], toElements[i])
                }
            } else {
                return false
            }
            if identical {
                conversion = Conversion.Identity
                return true
            }
            // Not the same type. Decline the pair by name — rather than leaving it
            // to a rule that cannot see it is a `Dictionary`/`ValueTuple` at all —
            // exactly when an OPEN element is in play. Both CLR families are
            // invariant, and a substituted `ValueTuple<int32, !T0>` still reports a
            // (type-erased) `ClrType`, so a rule reading only CLR shapes sees
            // `ValueTuple<int32, object>` on both sides and says yes to a pair that
            // has no conversion to emit — which is how `(int32, object)` reached a
            // `(int32, T)` slot and left ILVerify's StackUnexpected behind.
            return ContainsOpenElement(from) || ContainsOpenElement(to)
        }

        // Issue #3987: whether a type structurally carries an element with no CLR
        // identity of its own — an open type parameter, or a type declared in this
        // compilation. Both are the cases in which a constructed imported symbol's
        // `ClrType` is the ADR-0004 type-ERASED shape rather than the real one, so
        // CLR-shape comparisons stop being able to tell two different types apart.
        private func ContainsOpenElement(type TypeSymbol) bool -> TypeSymbol.ContainsTypeParameter(type) ||
            TypeSymbol.ContainsSameCompilationUserType(type)

        /// Issue #4011: classifies a `map[K, V]` at one of the interfaces the
        /// `Dictionary<K, V>` it IS (ADR-0104) implements, when an open
        /// key or value has left the map with no (cref:TypeSymbol.ClrType)
        /// for the reflective assignability rules to read.
        /// @remarks The sibling of (cref:TryClassifyStructuralSpellingConversion),
        /// which recognises the concrete CLASS. Only the five interfaces
        /// `Dictionary<K, V>` actually implements over its OWN key and
        /// value participate, each matched element-wise by the same
        /// (cref:IsCrossContextIdenticalElement) comparison the class arm
        /// uses. `sequence[KeyValuePair[K, V]]` is included because it is the alias
        /// spelling of `IEnumerable<KeyValuePair<K, V>>`
        /// (ADR-0040), not a separate rule.
        ///
        /// One-way by construction: [`from`](paramref) must be
        /// map-shaped and [`to`](paramref) must be one of the interfaces, so
        /// nothing here can make an `IDictionary[K, V]` flow back into a
        /// `map[K, V]`. Declining (rather than owning) an unrecognised pair is
        /// deliberate — unlike the invariant class arm, an interface target has
        /// existing variance and boxing rules that must keep their say.
        /// @param from The source type.
        /// @param to The target type.
        /// @param conversion The classified conversion, when recognised.
        /// @returns `true` when the pair is recognised.
        private func TryClassifyMapInterfaceConversion(from TypeSymbol, to TypeSymbol, out conversion Conversion) bool {
            conversion = Conversion.None
            // A nullable wrapper on either side is not this conversion; the lifted
            // rules answer over the underlying pair, exactly as they do for the
            // class arm and for the channel lattice.
            if from is NullableTypeSymbol || to is NullableTypeSymbol {
                return false
            }
            if !MapTypeSymbol.TryGetMapShape(from, out var key, out var value) {
                return false
            }
            // Only the case nothing else can answer. With a fully CLR-backed map
            // the existing reference-assignability rules already read both sides
            // and decide for themselves; re-answering here would change which
            // conversion a closed call site picks.
            if !ContainsOpenElement(from) {
                return false
            }
            if to is SequenceTypeSymbol sequenceTarget {
                if !IsKeyValuePairOf(sequenceTarget.ElementType, key, value) {
                    return false
                }
                conversion = Conversion.Implicit
                return true
            }
            if !TryGetImportedGenericShape(to, out var openName, out var targetArguments) {
                return false
            }
            var matches bool
            switch openName {
                case "System.Collections.Generic.IDictionary`2", "System.Collections.Generic.IReadOnlyDictionary`2" {
                    matches = targetArguments.Length == 2 &&
                        IsCrossContextIdenticalElement(key, targetArguments[0]) &&
                        IsCrossContextIdenticalElement(value, targetArguments[1])
                }
                case "System.Collections.Generic.ICollection`1",
                "System.Collections.Generic.IReadOnlyCollection`1",
                "System.Collections.Generic.IEnumerable`1" {
                    matches = targetArguments.Length == 1 && IsKeyValuePairOf(targetArguments[0], key, value)
                }
                default {
                    return false
                }
            }
            if !matches {
                return false
            }
            conversion = Conversion.Implicit
            return true
        }

        /// Issue #4011: whether [`element`](paramref) is
        /// `KeyValuePair<key, value>` over exactly the map's own key and
        /// value types.
        /// @param element The candidate element type.
        /// @param key The map's key type.
        /// @param value The map's value type.
        /// @returns `true` on an exact match.
        private func IsKeyValuePairOf(element TypeSymbol?, key TypeSymbol, value TypeSymbol) bool -> element != nil &&
            TryGetImportedGenericShape(element, out var elementName, out var elementArguments) &&
            string.Equals(elementName, "System.Collections.Generic.KeyValuePair`2", StringComparison.Ordinal) &&
            elementArguments.Length == 2 &&
            IsCrossContextIdenticalElement(key, elementArguments[0]) &&
            IsCrossContextIdenticalElement(value, elementArguments[1])

        /// Issue #4011: recovers a constructed imported generic's open-definition
        /// full name and its SYMBOLIC type arguments.
        /// @remarks The same two-step recovery (cref:MapTypeSymbol.TryGetMapShape)
        /// performs: prefer the retained symbolic `TypeArguments` (the only
        /// place an open `K` survives — the (cref:TypeSymbol.ClrType)
        /// is the ADR-0004 type-ERASED shape), and fall back to reading the closed
        /// CLR arguments when a metadata-recovered symbol carries none.
        /// @param type The candidate type.
        /// @param openDefinitionName The open definition's full name.
        /// @param typeArguments The recovered type arguments.
        /// @returns `true` when a constructed generic was recovered.
        private func TryGetImportedGenericShape(
            type TypeSymbol?,
            out openDefinitionName string?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool {
            var type = type
            openDefinitionName = nil
            typeArguments = ImmutableArray[TypeSymbol].Empty
            while type is NullabilityAnnotatedTypeSymbol annotated {
                type = annotated.BaseType
            }
            if type is not ImportedTypeSymbol imported {
                return false
            }
            var openDefinition Type? = imported.OpenDefinition
            if openDefinition == nil && imported.ClrType is {IsGenericType: true} closedType {
                openDefinition = closedType.GetGenericTypeDefinition()
            }
            if openDefinition == nil {
                return false
            }
            openDefinitionName = openDefinition.FullName
            if !imported.TypeArguments.IsDefaultOrEmpty {
                typeArguments = imported.TypeArguments
                return true
            }
            if imported.ClrType is not{IsGenericType: true} closedShape {
                return false
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
            for argument in closedShape.GetGenericArguments() {
                let mapped TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
                    argument,
                    NullabilityFreeReason.TypeStructure
                )
                if mapped == nil {
                    return false
                }
                builder.Add(mapped)
            }
            typeArguments = builder.ToImmutable()
            return true
        }

        // ADR-0174 D2: classifies conversions where at least one side is a G#
        // channel type clause and the other is channel-shaped (a magic symbol,
        // the runtime's `Chan<T>`, or a foreign BCL channel/reader/writer).
        private func TryClassifyChannelConversion(from TypeSymbol?, to TypeSymbol?, out conversion Conversion) bool {
            conversion = Conversion.None
            // Issue #3976: the lattice is a fact about the TYPES, not about how the
            // author spelled them. It used to require at least one side to be a
            // `ChannelTypeSymbol` — a channel type clause written in this
            // compilation — which quietly made every channel assembly-local.
            // Neither side is a type clause once a channel has been through
            // metadata or through inference: errata 3 gives `let ch = chan[T](n)`
            // the static type of the runtime class `Chan[T]`, and a channel in an
            // imported signature comes back as the BCL type it binds to
            // (`chan[T]` -> `Channel<T>`, `out chan[T]` -> `ChannelWriter<T>`,
            // `in chan[T]` -> `ChannelReader<T>`). So an inferred channel local
            // could not be passed to any imported channel parameter, and errata 3's
            // promise that the class name "surfaces only in hovers" was false
            // wherever the target came from another assembly. Being channel-shaped
            // on both sides is the whole precondition; ADR-0158 identity says
            // `chan[T]` IS `Channel<T>`, so asking which name was used is the
            // inconsistency, not the safeguard. The lattice below is untouched: an
            // element mismatch, `in` <-> `out`, directional -> bidirectional, and
            // anything targeting the constructed class still decline.
            if !ChannelTypeSymbol.TryGetChannelShape(from, out var fromElement, out var fromDirection, out _) ||
                !ChannelTypeSymbol.TryGetChannelShape(
                to,
                out var toElement,
                out var toDirection,
                out var toIsConstructed
            ) {
                return false
            }
            // A nullable wrapper on either side is not a channel conversion; the
            // lifted rules handle it over the underlying pair.
            if from is NullableTypeSymbol || to is NullableTypeSymbol {
                return false
            }
            if !IsCrossContextIdenticalElement(fromElement, toElement) &&
                !AreSameRuntimeChannelElement(fromElement!!, toElement!!) {
                return false
            }
            // Nothing converts TO the runtime class except itself (it is a subtype).
            if toIsConstructed {
                return false
            }
            if fromDirection == toDirection {
                conversion = Conversion.Identity
                return true
            }
            if fromDirection == ChannelDirection.Both {
                conversion = Conversion.Implicit
                return true
            }
            // in -> out, out -> in, and directional -> bidirectional: no conversion.
            conversion = Conversion.None
            return true
        }

        // Issue #3924: the element of a channel recovered from CLR metadata — the
        // constructed `Chan<T>` that `chan[T](n)` builds, or a foreign
        // `Channel<T>`/`ChannelReader<T>`/`ChannelWriter<T>` — is whatever
        // `TypeSymbol.FromClrType` mints for the reflected type argument. For a
        // structural G# shape that has no CLR counterpart symbol (`[]int32` comes
        // back as an `ImportedTypeSymbol` over `int32[]`, `map[string,int32]` as
        // one over `Dictionary<string, int32>`) that is never the
        // `SliceTypeSymbol`/`MapTypeSymbol` the `chan[T]` type clause bound, so the
        // element check above — which compares symbol shapes — fails even though
        // both sides denote one runtime type. `Channel<T>` is invariant, so
        // sameness of the elements' CLR types is exactly the question the
        // direction lattice needs answered. Compare the EFFECTIVE CLR type
        // (`ProjectElement` projects the element the same way): a
        // `NullableTypeSymbol` borrows its underlying type's `ClrType`, and only
        // the lifted form keeps `chan[int32?]` distinct from `chan[int32]`.
        //
        // One side must BE that metadata-recovered form for this to apply. A CLR
        // type is coarser than the G# symbol above it — `[3]int32` and `[4]int32`
        // are both `int32[]`, which is why
        // `AreRuntimeEquivalentIgnoringReferenceNullability` compares the lengths
        // instead — so where both sides still carry their symbols (two `chan[T]`
        // type clauses) that finer answer is the right one and stands unchanged.
        // The erasure is only unavoidable once an element has been through
        // reflection: `chan[[3]int32](1)` and `chan[[4]int32](1)` construct the
        // same `Chan<int32[]>`, and no comparison downstream of that can tell them
        // apart.
        //
        // "Came back from reflection" means an imported symbol carrying NO
        // symbolic type arguments, which is precisely what `FromClrType` mints
        // (`ImportedTypeSymbol.Get`) and what `GetConstructed` — the
        // source-constructed form — does not. A source-constructed generic still
        // holds its arguments as symbols, and its own `ClrType` may have erased
        // them to close over `object`: `List[Foo]` and `List[Bar]` over two
        // same-compilation structs are one `List<object>`. Comparing THAT would
        // conflate elements that are not the same type at all, so a
        // source-constructed element is left to the symbol comparison above,
        // which reads the arguments it still has.
        private func AreSameRuntimeChannelElement(from TypeSymbol, to TypeSymbol) bool -> (
            IsMetadataRecoveredElement(from) || IsMetadataRecoveredElement(to)
        ) &&
            ClrTypeUtilities.AreSame(
            NullableTypeSymbol.GetEffectiveClrType(from),
            NullableTypeSymbol.GetEffectiveClrType(to)
        )

        private func IsMetadataRecoveredElement(type TypeSymbol) bool -> type is ImportedTypeSymbol &&
            type
            .TypeArguments
            .IsDefaultOrEmpty == true

        // Issue #2299: element-level identity check used by
        // `TryClassifyWrappedElementIdentity`. Reference-equal elements are
        // trivially identical; otherwise recurses through `Classify` itself so
        // the direct ImportedTypeSymbol/StructSymbol check (and, transitively,
        // this same wrapper check) applies to the element too — this is what
        // lets nested wrappers (e.g. `[]?Series`, `[][]Series`) unwind depth-first
        // without duplicating the cross-context comparison per level.
        private func IsCrossContextIdenticalElement(a TypeSymbol?, b TypeSymbol?) bool {
            if a == b {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(a, b) {
                return true
            }
            let elementConversion = Classify(a, b)
            return elementConversion.Exists && elementConversion.IsIdentity
        }

        // Issue #421 P2-5: enum⇄numeric and enum⇄enum conversions. Both
        // directions are explicit per C# §10.3.3 / §10.3.4 — the binder must
        // permit them so the cast syntax (`int32(myEnum)`) reaches the emitter,
        // which then routes them through the underlying numeric primitive.
        private func TryClassifyEnumConversion(from TypeSymbol?, to TypeSymbol?, out conversion Conversion) bool {
            let fromIsEnum = IsEnumLikeType(from)
            let toIsEnum = IsEnumLikeType(to)
            if !fromIsEnum && !toIsEnum {
                conversion = Conversion.None
                return false
            }
            // enum → enum (any pair, including the same enum). Identity already
            // returned above, so this only fires for distinct enum types.
            if fromIsEnum && toIsEnum {
                conversion = Conversion.Explicit
                return true
            }
            // enum → numeric primitive.
            if fromIsEnum && to?.ClrType?.FullName is string toName && NumericWideningLattice.IsNumericPrimitive(
                toName
            ) {
                conversion = Conversion.Explicit
                return true
            }
            // numeric primitive → enum.
            if toIsEnum && from?.ClrType?.FullName is string fromName && NumericWideningLattice.IsNumericPrimitive(
                fromName
            ) {
                conversion = Conversion.Explicit
                return true
            }
            conversion = Conversion.None
            return false
        }

        /// Issue #1150: determines whether the CLR type [`fromClr`](paramref)
        /// implicitly, losslessly widens to the CLR type [`toClr`](paramref)
        /// per the standard numeric-widening lattice (e.g. `uint16` →
        /// `int64`). Compared by (cref:Type.FullName) so it is safe
        /// across reflection contexts. Narrowing and signed/unsigned same-width
        /// mismatches return `false`.
        private func WidensNumerically(fromClr Type, toClr Type) bool {
            return NumericWideningLattice.IsWidening(fromClr, toClr)
        }

        /// Issue #1150: determines whether [`fromReturn`](paramref) implicitly,
        /// losslessly widens to [`toReturn`](paramref) per the numeric-widening
        /// lattice. Used for the function-type → function-type return-type
        /// relaxation. Both types must be non-void numeric CLR primitives.
        private func ReturnTypeWidens(fromReturn TypeSymbol?, toReturn TypeSymbol?) bool {
            // Issue #2716: `never` is the bottom type. A callable that cannot
            // return satisfies every result slot, including void.
            if fromReturn == TypeSymbol.Never && toReturn != nil {
                return true
            }
            if fromReturn == nil || toReturn == nil || fromReturn == TypeSymbol.Void || toReturn == TypeSymbol.Void {
                return false
            }
            if fromReturn.ClrType is {} fromClr && toReturn.ClrType is {} toClr && WidensNumerically(fromClr, toClr) {
                return true
            }
            // Issue #1356: a function returning a bare type `T` widens to a function
            // returning `T?` (the nullable form of the same type). This mirrors the
            // scalar `T → T?` implicit conversion and is the return-covariance
            // analogue that, until now, only `WidensNumerically` handled for
            // concrete numeric returns. It is essential for a return type that is a
            // bare type parameter `T` widening to `T?`: such a type parameter carries
            // no CLR backing during binding, so the numeric path never fires, yet
            // widening a non-null value to its nullable form is always safe.
            //
            // The reverse direction (`T? → T`, a null-dropping narrowing) is
            // intentionally NOT recognized here — it requires the bang operator — so
            // an unsafe `(T) -> T?` to `(T) -> T` conversion stays rejected.
            //
            // Issue #4186: restricted to an unconstrained type parameter or a
            // reference-type underlying (see this rule's own
            // Issue1356FuncReturnNullableWideningConversionTests /
            // Issue1356FuncReturnCovarianceEmitTests coverage — neither pins a
            // concrete VALUE-type case). A concrete value-type underlying (e.g.
            // `bool` → `bool?`) is exactly the shape #4186 rejects: a method
            // group's own `Invoke`-compatible signature is the method's bare
            // return type, and the CLR has no implicit `T` → `Nullable<T>`
            // delegate-return conversion for a direct `ldftn`+`newobj` binding
            // (`csc` measured: `CS0407`) — only a synthesized wrapper method
            // (e.g. a lambda's or a func-literal's compiler-generated body,
            // already target-typed to `T?` before it ever reaches this check —
            // see `IsFunctionShapeAssignable`'s
            // `AreRuntimeEquivalentIgnoringReferenceNullability` identity check,
            // which such a literal already satisfies before this widening rule
            // is even consulted) can perform that lift. Uses
            // `NullableLifting.IsAnyValueTypeNullable` rather than the narrower
            // `IsValueTypeNullable` alone: a same-compilation user `struct`/`enum`
            // underlying has no `ClrType` mid-binding, so `IsValueTypeNullable`'s
            // `ClrType.IsValueType` probe misses it, which would have left this
            // exact gap open for a same-compilation value type's bare-`S` return
            // (only a BCL/open-struct-constrained value type would have been
            // caught). `IsAnyValueTypeNullable` unifies both the CLR-backed and
            // the same-compilation user-struct/enum cases. `false` for an open
            // (non-struct-constrained) type-parameter underlying and for any
            // reference type, so both of this rule's own pinned cases are
            // unaffected.
            if toReturn is NullableTypeSymbol toNullable &&
                toNullable.UnderlyingType == fromReturn &&
                !NullableLifting.IsAnyValueTypeNullable(toNullable) {
                return true
            }
            // Issue #2542: same-compilation classes and interfaces have no CLR
            // backing while binding, so the CLR-only delegate checks cannot see a
            // safe concrete-to-interface (or derived-to-base) return covariance.
            // Reuse the scalar conversion rules, but require both ends to be
            // reference-like and exclude structural projection. Function
            // parameters remain exact in IsFunctionShapeAssignable.
            if !IsReferenceLikeTarget(fromReturn) || !IsReferenceLikeTarget(toReturn) {
                return false
            }
            let conversion = ClassifyNonStructural(fromReturn, toReturn)
            return conversion.Exists && conversion.IsImplicit
        }

        private func IsEnumLikeType(type TypeSymbol?) bool {
            if type is EnumSymbol {
                return true
            }
            // Issue #1100 / generalized by #2327: a constructed generic delegate
            // closed over a same-compilation user type (whose CLR backing is an
            // in-flight emit TypeBuilder) surfaces as a
            // System.Reflection.Emit.TypeBuilderInstantiation. Its reflection
            // predicates throw NotSupportedException ("TypeBuilder generic
            // instantiation does not support resolving members") — IsEnum probes
            // the base-type chain via IsSubclassOf, which is one of the
            // unsupported operations. Such a delegate type is never an enum, so
            // treat a throw as a definite "not enum-like". Routed through the
            // shared ClrTypeUtilities.IsEnumSafe helper so every enum-reflection
            // call site in the binder/emitter shares one guard.
            return type?.ClrType is {} clrType && clrType.IsEnumSafe()
        }

        /// Issue #2188: true when [`type`](paramref) is a type parameter that
        /// is provably a reference type — it carries an explicit reference-type
        /// (`class`) constraint or a base-class constraint. Such a parameter
        /// behaves as a reference type for conversion and equality purposes in both
        /// its nullable (`T?`) and non-nullable (`T`) forms.
        private func IsReferenceConstrainedTypeParameter(type TypeSymbol?) bool -> type is TypeParameterSymbol tp &&
            (tp.HasReferenceTypeConstraint || tp.ClassConstraint != nil)

        private func HasExplicitUnboxingConversion(from TypeSymbol?, to TypeSymbol?) bool {
            var from = from
            var to = to
            if from is NullableTypeSymbol nullableFrom {
                from = nullableFrom.UnderlyingType
            }
            if to is NullableTypeSymbol nullableTo {
                if !NullableLifting.IsAnyValueTypeNullable(nullableTo) {
                    return false
                }
                to = nullableTo.UnderlyingType
            } else if !IsValueTypeLikeFrom(to) {
                return false
            }
            if from?.ClrType.IsSameAs(typeof(object)) == true {
                return true
            }
            if from?.ClrType.IsSameAs(typeof(ValueType)) == true {
                return true
            }
            if from?.ClrType.IsSameAs(typeof(Enum)) == true {
                return IsEnumLikeType(to)
            }
            // C# only permits interface unboxing when the target value type is
            // known to implement that interface. Keep unrelated interface/value
            // pairs as genuine no-conversion diagnostics rather than deferring an
            // impossible cast to runtime.
            return IsInterfaceLikeType(from) && IsValueTypeAssignableToInterface(to, from)
        }

        private func IsValueTypeLikeFrom(type TypeSymbol?) bool {
            if type is TypeParameterSymbol && type.HasValueTypeConstraint == true {
                return true
            }
            if type is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) {
                return true
            }
            // User structs (non-class StructSymbol) and user enums are CLR value
            // types even though their symbols carry no ClrType.
            if type is StructSymbol s && !s.IsClass {
                return true
            }
            if type is EnumSymbol {
                return true
            }
            // Issue #3907: a tuple is always `ValueTuple<...>`, a struct — but
            // TupleTypeSymbol.BuildClrType returns null as soon as ONE element is a
            // same-compilation type, so the ClrType test below could not see it.
            // `cast[(A, B)](o)` therefore bound for BCL element types and failed for
            // the user's own, which is the same "symbols carry no ClrType" hole the
            // two cases above exist to close.
            if type is TupleTypeSymbol {
                return true
            }
            return type?.ClrType != nil && type!!.ClrType!!.IsValueType
        }

        private func IsValueTypeAssignableToInterface(from TypeSymbol?, to TypeSymbol?) bool {
            // Nullable<T> has the boxing conversions of its underlying value type:
            // a present value boxes as T and a missing value boxes as null.
            if from is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) {
                return IsValueTypeAssignableToInterface(nullable.UnderlyingType, to)
            }
            // A same-compilation enum has no ClrType yet, but its emitted base type
            // is System.Enum, so it implements the CLR interfaces exposed by Enum.
            if from is EnumSymbol &&
                to?.ClrType is {IsInterface: true} enumInterface &&
                ClrTypeUtilities.IsAssignableByName(enumInterface, typeof(Enum)) {
                return true
            }
            // User-declared struct → user-declared interface: walk the struct's
            // declared interface list.
            if from is StructSymbol fromStruct && to is InterfaceSymbol toInterface {
                for i in fromStruct.Interfaces {
                    if i == toInterface {
                        return true
                    }
                }
                return false
            }
            // Issue #976: a user-declared value-type struct → imported CLR
            // interface declared in its `: …` clause. The struct symbol has no
            // ClrType during binding, so the general CLR-assignability path below
            // cannot fire — match structurally against `ImplementedClrInterfaces`,
            // mirroring the class reference-upcast rule. This covers both plain
            // CLR interfaces (e.g. `IComparable`) and CLR generic interfaces closed
            // over a user G# type (e.g. `IEquatable[Money]`).
            if from is StructSymbol fromValueStruct &&
                !fromValueStruct.IsClass &&
                to?.ClrType != nil &&
                to!!.ClrType!!
                .IsInterface {
                for iface in fromValueStruct.ImplementedClrInterfaces {
                    let ifaceClr Type? = iface?.ClrType
                    if ifaceClr == nil {
                        continue
                    }
                    if ifaceClr == to!!.ClrType || ClrTypeUtilities.IsAssignableByName(to!!.ClrType, ifaceClr) {
                        return true
                    }
                }
            }
            if from is ImportedTypeSymbol &&
                RequiresSymbolicTypeArgumentIdentity(from) &&
                TryGetConstructedGenericShape(to, out _, out _) {
                return TryClassifyConstructedImportedReferenceConversion(from, to)
            }
            // Only faithful closed CLR shapes may decide interface boxing.
            let fromClr Type? = from?.ClrType
            let toClr Type? = to?.ClrType
            if fromClr != nil && toClr != nil {
                return ClrTypeUtilities.IsAssignableByName(toClr, fromClr)
            }
            return false
        }

        /// Issue #813: returns `true` when one side is a G#
        /// (cref:TupleTypeSymbol) and the other is the equivalent CLR
        /// `System.ValueTuple<…>` instantiation (with identical
        /// closed element types).
        private func IsTupleClrEquivalent(a TypeSymbol?, b TypeSymbol?) bool {
            if a == nil || b == nil {
                return false
            }
            // Issue #2051: a `NullableTypeSymbol` relays its UNDERLYING type's
            // `ClrType` (see `NullableTypeSymbol.ClrType` / ADR-0001 §Phase 3.C.1) —
            // for a value-type underlying, that is the bare `T`, NOT the actual CLR
            // runtime representation `System.Nullable<T>`. Without this guard, a
            // tuple-shaped `T` compared against `Nullable<T>` (e.g. `(int32,int32)`
            // vs `(int32,int32)?`) would satisfy `ta.ClrType == b.ClrType` below
            // purely because of that relay, misclassifying the true CLR-widening
            // `T -> Nullable<T>` lift (#504) as a same-representation `Identity`
            // conversion. That skips the `newobj Nullable<T>::.ctor(T)` wrap
            // entirely, leaving a raw `ValueTuple` on the stack where a
            // `Nullable<ValueTuple>` is expected (ilverify `StackUnexpected`).
            // Scalar value-type nullables (`int32?`) never reach this helper — it
            // only fires when one side is a `TupleTypeSymbol` — so this is scoped
            // to the ValueTuple-shaped case the issue describes.
            if a is NullableTypeSymbol || b is NullableTypeSymbol {
                return false
            }
            // Issue #3552: the two closed `ValueTuple<…>` shapes can live in
            // DIFFERENT reflection contexts (a live-runtime `MakeGenericType`
            // product on the TupleTypeSymbol vs a MetadataLoadContext signature
            // type recovered from an indexer/method parameter), so reference
            // equality spuriously failed and a tuple-keyed `Dictionary` rejected
            // its own key. Compare via the cross-context-safe identity helper.
            if a is TupleTypeSymbol ta && !(b is TupleTypeSymbol) {
                return ta.ClrType != nil && b.ClrType != nil && ta.ClrType.IsSameAs(b.ClrType)
            }
            if b is TupleTypeSymbol tb && !(a is TupleTypeSymbol) {
                return tb.ClrType != nil && a.ClrType != nil && tb.ClrType.IsSameAs(a.ClrType)
            }
            return false
        }

        /// Issue #821: cross-context-safe slice-to-interface check. When the
        /// target is a constructed (cref:ImportedTypeSymbol) whose
        /// `ClrType` is the type-erased open-definition form (because
        /// (cref:Type.MakeGenericType(Type[])) could not be closed at
        /// substitution time — typically because the open definition lives in a
        /// (cref:System.Reflection.MetadataLoadContext) while the
        /// substituted argument types live in the live runtime) the symbolic
        /// (cref:ImportedTypeSymbol.TypeArguments) carry the real
        /// substituted G# types. Match against those, not the erased CLR
        /// arguments, so the slice still classifies as implicitly convertible to
        /// the constructed interface.
        /// @param slice The source slice type.
        /// @param targetInterface The constructed interface target.
        /// @returns `true` when the slice's backing array
        /// implements the target interface.
        private func SliceImplementsInterface(slice SliceTypeSymbol, targetInterface TypeSymbol) bool {
            // Cheap path: the target's CLR generic arguments are already the
            // properly substituted closed form. Defer to the existing
            // by-name interface walk.
            if slice.ClrType is {} sliceClrType &&
                targetInterface.ClrType is {} targetClrType &&
                ClrTypeUtilities.ImplementsInterfaceByName(sliceClrType, targetClrType) {
                return true
            }
            if targetInterface is not ImportedTypeSymbol imported ||
                imported.OpenDefinition == nil ||
                imported
                .TypeArguments
                .IsDefaultOrEmpty {
                return false
            }
            // Cross-context fallback: walk the slice's backing CLR array
            // interfaces and match each generic argument against the symbolic
            // TypeArguments by ClrType FullName, which is assembly-qualifier
            // free for leaf types (System.Int32, System.String, …) and so
            // compares correctly across reflection contexts.
            let openDef = imported.OpenDefinition
            if slice.ClrType is not{} fallbackSliceClrType {
                return false
            }
            for iface in fallbackSliceClrType.GetInterfaces() {
                if !iface.IsGenericType {
                    continue
                }
                if !string.Equals(
                    iface.GetGenericTypeDefinition().FullName,
                    openDef.FullName,
                    StringComparison.Ordinal
                ) {
                    continue
                }
                let ifaceArgs = iface.GetGenericArguments()
                if ifaceArgs.Length != imported.TypeArguments.Length {
                    continue
                }
                var allMatch = true
                for var i = 0; i < ifaceArgs.Length; i++ {
                    let symbolic = imported.TypeArguments[i]
                    if symbolic?.ClrType == nil || !string.Equals(
                        ifaceArgs[i].FullName,
                        symbolic.ClrType!!.FullName,
                        StringComparison.Ordinal
                    ) {
                        allMatch = false
                        break
                    }
                }
                if allMatch {
                    return true
                }
            }
            return false
        }

        /// Issue #2140: true when [`target`](paramref) is one of the
        /// element-INDEPENDENT array supertype interfaces that EVERY one-
        /// dimensional array implements regardless of element type — the non-
        /// generic collection interfaces plus `ICloneable`,
        /// `IStructuralComparable` and `IStructuralEquatable`. Because
        /// they carry no element type argument, a slice `[]T` (any element)
        /// converts to them as a no-op reference upcast without loosening the
        /// invariance enforced for the generic element interfaces
        /// (`IEnumerable<T>` etc.). Uses the cross-context-safe
        /// `IsSameAs` (reference identity is forbidden, guard test #835).
        /// @param target The candidate target type.
        /// @returns `true` when [`target`](paramref) is an element-
        /// independent non-generic array supertype interface; otherwise
        /// `false`.
        private func IsElementIndependentArrayInterface(target TypeSymbol) bool {
            let clr Type? = target?.ClrType
            if clr == nil {
                return false
            }
            return clr.IsSameAs(typeof(IEnumerable)) || clr.IsSameAs(typeof(ICollection)) || clr.IsSameAs(
                typeof(IList)
            ) ||
                clr.IsSameAs(typeof(ICloneable)) || clr.IsSameAs(typeof(IStructuralComparable)) || clr.IsSameAs(
                typeof(IStructuralEquatable)
            )
        }

        /// Issue #1302: symbolic struct → generic-interface implementation check for
        /// a constructed BCL value struct (e.g. `List[T].Enumerator`) whose
        /// element `T` is a same-compilation user type, so its
        /// (cref:TypeSymbol.ClrType) (and the target interface's) is
        /// `null` during binding. Walk the generic interfaces the
        /// struct's OPEN definition implements, match the target interface's open
        /// definition by full name, then substitute each interface argument through
        /// the struct's symbolic (cref:ImportedTypeSymbol.TypeArguments) by
        /// generic-parameter position and compare to the target's arguments via
        /// (cref:AreTypeArgumentsEquivalent). A genuine element mismatch
        /// returns `false` (GS0155).
        private func ConstructedValueTypeImplementsInterfaceSymbolically(
            from ImportedTypeSymbol,
            toInterface ImportedTypeSymbol
        ) bool {
            let fromOpen Type? = from.OpenDefinition
            let toOpen = toInterface.OpenDefinition
            if fromOpen == nil || toOpen?.FullName == nil || toInterface.TypeArguments.IsDefaultOrEmpty {
                return false
            }
            for iface in fromOpen.GetInterfaces() {
                if !iface.IsGenericType {
                    continue
                }
                if !string.Equals(
                    iface.GetGenericTypeDefinition().FullName,
                    toOpen!!.FullName,
                    StringComparison.Ordinal
                ) {
                    continue
                }
                let ifaceArgs = iface.GetGenericArguments()
                if ifaceArgs.Length != toInterface.TypeArguments.Length {
                    continue
                }
                var allMatch = true
                for var i = 0; i < ifaceArgs.Length; i++ {
                    let ifaceArg = ifaceArgs[i]
                    var substituted TypeSymbol
                    if ifaceArg.IsGenericParameter &&
                        ifaceArg.GenericParameterPosition >= 0 &&
                        ifaceArg.GenericParameterPosition < from
                        .TypeArguments
                        .Length {
                        substituted = from.TypeArguments[ifaceArg.GenericParameterPosition]
                    } else {
                        substituted = TypeSymbol.FromClrTypeWithoutNullability(
                            ifaceArg,
                            NullabilityFreeReason.TypeStructure
                        )
                    }
                    if !AreTypeArgumentsEquivalent(substituted, toInterface.TypeArguments[i]) {
                        allMatch = false
                        break
                    }
                }
                if allMatch {
                    return true
                }
            }
            return false
        }
    }
}
