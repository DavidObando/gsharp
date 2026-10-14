// <copyright file="CSharpTypeMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection.Metadata
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Coverage
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Cs2Gs.Translator.Analyzers
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Diagnostics.CodeAnalysis
import System.Runtime.CompilerServices

/// Converts a Roslyn (cref:ITypeSymbol) into the canonical G# type
/// reference ((cref:GTypeReference)) following ADR-0115 §B.7, §B.8, and
/// §B.12. The mapper is driven by the bound (cref:ITypeSymbol) (not the
/// raw syntax) so width-bearing primitive names, generic instantiations,
/// delegate arrow forms, and nullability are resolved semantically.
///
/// A C# type with no established canonical G# form (e.g. a value tuple /
/// named-tuple type) is <b>never</b> approximated with non-parsing text: the
/// mapper records a structured (cref:TranslationSeverity.Unsupported)
/// (cref:TranslationDiagnostic) and emits the nearest parseable
/// placeholder ((cref:UnsupportedPlaceholderType)) so the file still
/// round-trips while the gap is surfaced for triage (ADR-0115 §B/§D).
class CSharpTypeMapper {
    /// Issue #2211: every namespace this mapper has shortened a type reference
    /// into (via (cref:QualifiedTypeName)), collected so the translator
    /// can synthesize a matching `import` for a namespace with no
    /// corresponding `using` directive in the source file — the shape
    /// Roslyn source generators emit (fully-qualified references, no
    /// `using`s at all). Without this, a short-named reference to a type
    /// whose namespace has no `using` directive round-trips to unresolvable
    /// G# (GS0113/GS0157). The translator filters out the file's own package
    /// and any namespace already covered by an explicit `using` before
    /// emitting the rest as synthesized imports.
    private let shortenedNamespaces HashSet[string] = HashSet[string]()

    /// Issue #2282: every distinct anonymous-type SHAPE (an ordered list of
    /// member name + fully-qualified type) already mapped to a synthesized
    /// `data class`, keyed structurally so two syntactically-identical
    /// anonymous types declared at different source locations share one
    /// synthesized declaration instead of each minting its own (which would
    /// combinatorially explode across a large file). See
    /// (cref:GetOrCreateAnonymousDataClass).
    ///
    /// The (cref:AnonymousTypeRegistry) is shared by every mapper for a
    /// package so identical shapes are declared once (#2292). Names are derived
    /// from the complete ordered shape rather than a translation-local counter,
    /// keeping distinct declarations unambiguous across packages and projects
    /// even when one package imports another (#2598).
    private let anonymousTypeRegistry AnonymousTypeRegistry

    private let nameAllocator EmittedNameAllocator?

    /// Issue #2282: the synthesized anonymous-type `data class`
    /// declarations first minted by THIS mapper (i.e. this source file),
    /// in first-seen order, collected here (rather than emitted inline)
    /// because (cref:Map) is called from many contexts (a
    /// parameter type, a field type, a generic argument, ...) that have no
    /// direct way to append a new top-level type declaration to the
    /// compilation unit being built. `CSharpToGSharpTranslator.TranslateDocument`
    /// drains this list into the compilation unit's members once, after every
    /// member has been translated (mirroring how (cref:ShortenedNamespaces)
    /// is drained into synthesized imports).
    ///
    /// Issue #2292: a shape already declared by an EARLIER file sharing this
    /// mapper's (cref:anonymousTypeRegistry) is intentionally NOT
    /// re-added here (see (cref:GetOrCreateAnonymousDataClass)) so the
    /// data class is declared exactly once per package, in the first file
    /// that needed it, instead of once per file (which would itself be a
    /// GS0102 duplicate-declaration collision even for an IDENTICAL shape).
    private let pendingAnonymousDataClasses List[TypeDeclaration] = List[TypeDeclaration]()

    // Shapes this mapper (one document translation) has declared, so an owner
    // document re-translated for ADR-0192 pair reconciliation declares each
    // of its shapes exactly once.
    private let declaredAnonymousShapes HashSet[string] = HashSet[string](StringComparer.Ordinal)

    private let anonymousShapeContracts Dictionary[string, IReadOnlyList[GTypeReference]] = Dictionary[
        string,
        IReadOnlyList[GTypeReference]
    ](StringComparer.Ordinal)
    private let synthesizedTypeAliases Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal)
    private let reservedTypeAliases Dictionary[string, HashSet[string]] = Dictionary[string, HashSet[string]](
        StringComparer.Ordinal
    )
    private let reservedImportedTypeNames HashSet[string] = HashSet[string](StringComparer.Ordinal)
    private let reservedTypeParameterNames HashSet[string] = HashSet[string](StringComparer.Ordinal)
    private let reservedInvokedLocalNames HashSet[string] = HashSet[string](StringComparer.Ordinal)

    // Issue #3471/#4302: source static members and allocated lifted helpers
    // can print bare inside their declaring aggregate. A file-scope import
    // alias shadows class members in gsc scope resolution, so a synthesized
    // readable alias must never take one of these names.
    private let reservedSiblingMemberNames HashSet[string] = HashSet[string](StringComparer.Ordinal)

    /// Issue #1174: cached per-compilation census of source-declared top-level
    /// type simple names (built lazily on first use), used to decide whether a
    /// bare type name is ambiguous and must be emitted in qualified form.
    /// Nested declarations are excluded because they are not imported by their
    /// simple names.
    private var sourceTopLevelSimpleNames Dictionary[CSharpCompilation, Dictionary[string, HashSet[string]]]?

    private var sourceNestedSimpleNames Dictionary[CSharpCompilation, Dictionary[string, HashSet[string]]]?

    /// Issue #3841: the constructed delegate types whose CLR identity is
    /// load-bearing in the compilation currently being translated, computed
    /// once per compilation by (cref:CollectIdentityCriticalDelegates(Compilation)).
    private var identityCriticalDelegates HashSet[INamedTypeSymbol]

    /// Issue #3841: the compilation (cref:identityCriticalDelegates) was
    /// computed for; a different one recomputes the set.
    private var identityCriticalDelegatesCompilation Compilation

    private var sourceDeclaredTypeNames HashSet[string]?

    /// Issue #2222: the current file's imported namespace names (`using`
    /// directives plus its own declared namespace), cached lazily since every
    /// top-level-type reference in a file shares the same import set. Used to
    /// detect a same-simple-name collision reachable via THIS file's imports,
    /// including one that lives in a referenced assembly (a translated sibling
    /// project) rather than in source.
    private var importedNamespaceNames HashSet[string]?

    /// Issue #3805: the semantic models of the file being translated, one per
    /// repository compilation that COMPILES that file. For an ordinary file
    /// that is just (cref:TranslationContext.SemanticModel); for a
    /// LINKED source (`<Compile Include="..\Shared\X.cs" />` in
    /// several projects) it is one model per linking project. See
    /// (cref:LinkedDocumentModels(TranslationContext)).
    private var linkedDocumentModels Dictionary[
        Microsoft.CodeAnalysis.SyntaxTree,
        IReadOnlyList[Microsoft.CodeAnalysis.SemanticModel]
    ]?

    /// Issue #2509: constraint slots must disambiguate metadata/metadata
    /// homonyms as well as source collisions. Ordinary type positions retain
    /// the existing source-authored collision policy to avoid gratuitously
    /// qualifying framework types that share a name across BCL namespaces.
    private var qualifyMetadataImportCollisions bool

    private var topLevelStatementsEntryPoint IMethodSymbol?

    /// Issue #4556: how many (cref:MapWithoutImportTracking) calls are
    /// active. While it is non-zero, a mapping records no namespace into
    /// (cref:shortenedNamespaces) and registers no new synthesized type
    /// alias, because nothing it returns is printed.
    private var importTrackingSuppression int32

    /// Initializes a new instance of the (cref:CSharpTypeMapper) class
    /// with a private, unshared anonymous-type registry (every prior call
    /// site's behavior — used by standalone/single-file callers such as
    /// existing tests that never span multiple documents in the same
    /// package).
    convenience init() {
        init(AnonymousTypeRegistry())
    }

    /// Initializes a new instance of the (cref:CSharpTypeMapper) class
    /// sharing [`anonymousTypeRegistry`](paramref) with every other
    /// mapper translating a document into the same G# package (issue #2292).
    /// @param anonymousTypeRegistry The package-scoped registry of already-synthesized anonymous-type
    /// shapes.
    convenience init(anonymousTypeRegistry AnonymousTypeRegistry) {
        init(anonymousTypeRegistry, nil)
    }

    internal init(anonymousTypeRegistry AnonymousTypeRegistry, nameAllocator EmittedNameAllocator?) {
        this.anonymousTypeRegistry = anonymousTypeRegistry ?? AnonymousTypeRegistry()
        this.nameAllocator = nameAllocator
    }

    /// Gets or sets a value indicating whether ADR-0169 analyzer translation
    /// mode is active: Microsoft.CodeAnalysis types are rewritten to the G#
    /// analyzer API via (cref:Analyzers.RoslynAnalyzerApiMap) instead
    /// of passing through as imported CLR types.
    prop AnalyzerApiMode bool

    /// Gets every namespace shortened into a bare/qualified-nested type name by
    /// this mapper so far (see (cref:shortenedNamespaces)).
    prop ShortenedNamespaces IReadOnlyCollection[string] -> this.shortenedNamespaces

    /// Gets type aliases synthesized to preserve unambiguous source or CLR type
    /// identity.
    prop SynthesizedTypeAliases IReadOnlyDictionary[string, string] -> this.synthesizedTypeAliases

    /// Gets the synthesized anonymous-type `data class` declarations
    /// collected so far by (cref:GetOrCreateAnonymousDataClass), in
    /// first-seen (deterministic) order.
    prop PendingAnonymousDataClasses IReadOnlyList[TypeDeclaration] -> this.pendingAnonymousDataClasses

    /// Records a G# namespace substituted for a Roslyn API namespace in
    /// analyzer translation mode (ADR-0169), so the compilation-unit import
    /// synthesis emits it even though no C# symbol carries it.
    /// @param gsNamespace The G# namespace to import.
    func TrackSubstitutedNamespace(gsNamespace string) {
        if !string.IsNullOrEmpty(gsNamespace) {
            this.shortenedNamespaces.Add(gsNamespace)
        }
    }

    /// Records a translated attribute type's containing namespace and any
    /// source alias so the compilation-unit import synthesis can resolve the
    /// attribute without changing its source spelling.
    /// @param attributeType The semantically resolved attribute type.
    /// @param alias The alias used by the attribute name, if any.
    func TrackAttributeType(attributeType INamedTypeSymbol?, alias IAliasSymbol?) {
        if attributeType != nil {
            this.TrackShortenedNamespace(attributeType)
        }
        let aliasTarget string? = switch alias?.Target {
            case ns is INamespaceSymbol when !ns.IsGlobalNamespace: this.nameAllocator?.GetNamespaceName(ns) ??
                ns.ToDisplayString()
            case type is INamedTypeSymbol: this.QualifiedAliasTarget(type)
            default: default(string?)
        }
        if !string.IsNullOrEmpty(aliasTarget) {
            let aliasName = this.nameAllocator?.GetName(alias) ??
                GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SyntaxFacts
                .GetEmittedIdentifier(alias!!.Name, IdentifierNameContext.Type)
            this.synthesizedTypeAliases[aliasName] = aliasTarget
        }
    }

    /// Records the declaring namespace of a resolved extension-method
    /// invocation or method-group reference into the same shortened-namespace
    /// tracking set used for type imports (see (cref:shortenedNamespaces)),
    /// so that an import is synthesized for it even though the call site
    /// itself names no type. Extension-method calls (reduced instance form,
    /// unreduced static form, or a bare method-group reference) never flow
    /// through (cref:TrackShortenedNamespace) because they don't
    /// reference a type name directly, so without this tracking a file that
    /// relies on a project-wide or implicit `using` for the extension's
    /// namespace (e.g. `<ImplicitUsings>enable</ImplicitUsings>`
    /// providing `System.Linq`) would translate to G# with no import for
    /// that namespace at all.
    /// @param method The resolved extension method symbol.
    func TrackExtensionMethodNamespace(method IMethodSymbol?) {
        let ns INamespaceSymbol? = GetExtensionMethodNamespace(method)
        if ns == nil {
            return
        }
        this.shortenedNamespaces.Add(this.nameAllocator?.GetNamespaceName(ns) ?? ns.ToDisplayString())
    }

    /// Maps a Roslyn type symbol to its canonical G# type reference, recording
    /// an unsupported-construct diagnostic on [`context`](paramref) for any
    /// type with no canonical G# form.
    /// @param type The bound C# type symbol.
    /// @param context The translation context that accumulates diagnostics.
    /// @param location The originating C# source location for diagnostics.
    /// @returns The canonical G# type reference (never `null`).
    func Map(type ITypeSymbol?, context TranslationContext, location Location?) GTypeReference? {
        if type == nil || type.TypeKind == TypeKind.Error {
            context.Report(
                TranslationDiagnostic(
                    type?.ToDisplayString() ?? "<unresolved-type>",
                    "Could not resolve a C# type symbol; emitted the placeholder type.",
                    location,
                    TranslationSeverity.Unsupported
                )
            )
            return NamedTypeReference(UnsupportedPlaceholderType)
        }
        // C# `dynamic` has the same CLR representation as `object`; dynamic
        // dispatch is already resolved by Roslyn at the source call sites.
        if type.TypeKind == TypeKind.Dynamic {
            return NamedTypeReference("object")
        }
        // A C# unsafe pointer type (`T*`, `void*`) maps to the canonical G#
        // PREFIX pointer form `*T` (spec §"Byref/pointer syntax exists as
        // `*T`"; grammar `'*' TypeClause '?'?`). A `void*` (no element type)
        // maps to the faithful void-element pointer `*void` (ADR-0122 §3 /
        // issue #1033) — distinct from a byte pointer `*uint8`: it round-trips
        // through `nint`/`IntPtr` and casts to/from typed pointers, but cannot
        // be dereferenced/indexed/advanced without a cast. The emitted form
        // round-trips through the parser; the binder steers callers to
        // ref/out/in (GS0243) and rejects pointer fields (GS9006) on the
        // excepted unsafe Win32-interop surface (ADR-0115 §G). A FUNCTION
        // pointer has no canonical managed G# form and stays Unsupported.
        if type is IPointerTypeSymbol pointer {
            let pointee ITypeSymbol? = pointer.PointedAtType
            let element GTypeReference? = if pointee == nil || pointee.SpecialType == SpecialType.System_Void {
                cast[GTypeReference](NamedTypeReference("void"))
            } else {
                this.Map(pointee, context, location)
            }
            context.Report(
                TranslationDiagnostic(
                    "PointerType",
                    "unsafe pointer type '${type.ToDisplayString()}' maps to the canonical G# prefix-pointer form; the binder steers callers to ref/out/in (GS0243) on the excepted unsafe Win32-interop surface (ADR-0115 §G).",
                    location,
                    TranslationSeverity.Info
                )
            )
            return PointerTypeReference(element)
        }
        // Issue #1906: a C# function pointer (`delegate*<...>`) maps to one of
        // G#'s two function-pointer forms — see MapFunctionPointer.
        if type is IFunctionPointerTypeSymbol functionPointer {
            return this.MapFunctionPointer(functionPointer, context, location)
        }
        // A nullable value type (Nullable<T>) carries its payload as the single
        // type argument; map the underlying type and mark the result nullable.
        if type is INamedTypeSymbol nullableValue &&
            nullableValue
            .OriginalDefinition
            .SpecialType == SpecialType
            .System_Nullable_T {
            let underlying GTypeReference? = this.Map(nullableValue.TypeArguments[0], context, location)
            return WithNullable(underlying, true)
        }
        // A `T?`-annotated type also covers an annotated type parameter (`T?`
        // where `T : IFoo` / unconstrained). Such a parameter reports
        // `IsReferenceType == false` (an interface/unconstrained type parameter is
        // not provably a reference type), so it must be recognised explicitly or
        // the `?` is silently dropped and the nullable return/field no longer
        // type-checks against `== nil`. A `T : struct` parameter's `T?` is modelled
        // by Roslyn as `Nullable<T>` and is handled above, so an annotated
        // ITypeParameterSymbol here is always the nullable-reference-like form.
        let nullableReference = type.NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated &&
            (type.IsReferenceType || type is ITypeParameterSymbol)
        // ADR-0169 analyzer mode: a declared INamespaceSymbol renders as G#'s
        // namespace display string, whose honest type is `string?` —
        // `Symbol.ContainingNamespace` is nil for symbols without a containing
        // namespace, while Roslyn annotates `INamespaceSymbol` members and
        // parameters non-nullable. Without the forced `?`, a null-tolerant C#
        // helper taking INamespaceSymbol translates to a non-nullable `string`
        // parameter and every `ContainingNamespace` argument gets bridged with
        // `!!` — an assert at a site where the C# never dereferences, i.e. a
        // runtime NRE the original could not produce (the migrated
        // EmitCacheKeyRemapScopeAnalyzer crashed exactly this way).
        let analyzerNamespaceString = this.AnalyzerApiMode && RoslynAnalyzerApiMap.IsNamespaceSymbolType(type)
        var mapped GTypeReference? = this.MapCore(type, context, location)
        if type is INamedTypeSymbol{IsGenericType: true} constructed && !constructed.IsTupleType {
            mapped = this.PromoteTupleTypeArguments(mapped, type, constructed, context, List[int32]())
        }
        return if nullableReference || analyzerNamespaceString {
            WithNullable(mapped, true)
        } else {
            mapped
        }
    }

    /// Issue #4556: maps [`type`](paramref) like (cref:Map) for a
    /// caller that only inspects the result's shape and never prints it, so it
    /// adds no namespace import and no synthesized type alias (an ambiguous
    /// type is spelled namespace-qualified instead). A printed reference is
    /// what needs an `import`; recording the namespace of an analysis-only
    /// mapping synthesizes an import no name uses, and that import can make an
    /// unrelated bare name ambiguous (GS0547:
    /// shape analysis of a `ParameterInfo[]` receiver imported
    /// `System.Reflection`, so the file's bare compiler `Binder`
    /// collided with `System.Reflection.Binder`).
    /// @param type The type to map.
    /// @param context The translation context.
    /// @param location The location for any diagnostic the mapping reports.
    /// @returns The mapped G# type reference.
    func MapWithoutImportTracking(type ITypeSymbol, context TranslationContext, location Location) GTypeReference? {
        this.importTrackingSuppression++
        try {
            return this.Map(type, context, location)
        } finally {
            this.importTrackingSuppression--
        }
    }

    /// Maps a type used in G#'s legacy generic-constraint slot. The slot uses
    /// the canonical semantic name/type arguments but does not accept an outer
    /// nullable marker, so a C# nullable constraint annotation is reported and
    /// dropped while nested nullable type arguments remain intact.
    /// @param type The bound C# constraint type.
    /// @param context The translation context that accumulates diagnostics.
    /// @param location The originating C# constraint location.
    /// @returns The canonical G# constraint type reference.
    func MapConstraintType(type ITypeSymbol, context TranslationContext, location Location?) GTypeReference {
        let mapped = this.WithMetadataImportCollisionQualification(() -> this.Map(type, context, location)!!)
        if !mapped.IsNullable {
            return mapped
        }
        let message = "constraint type '${type.ToDisplayString()}' has a nullable annotation; " +
            "G#'s generic-constraint slot has no nullable form, so the outer annotation is dropped."
        context.Report(
            TranslationDiagnostic("TypeParameterConstraintClause", message, location, TranslationSeverity.Info)
        )
        return WithNullable(mapped, false)!!
    }

    /// Maps an event's handler type without erasing its nominal delegate
    /// identity. Event metadata and add/remove signatures are ABI-sensitive:
    /// structurally equivalent delegates are not interchangeable in the CLR.
    /// @param type The event's declared handler type.
    /// @param context The translation context that accumulates diagnostics.
    /// @param location The originating C# source location for diagnostics.
    /// @returns The canonical G# type reference for the event's handler type.
    func MapEventType(type ITypeSymbol?, context TranslationContext, location Location?) GTypeReference? {
        // Issue #4127/#4129 (a #3841/#2835 self-hosting regression, #3501):
        // a property pattern containing an ENUM-constant sub-pattern
        // (`TypeKind: TypeKind.Delegate`) matched against a value whose
        // STATIC type is an imported interface (`ITypeSymbol`) silently
        // evaluates as non-matching once this exact translation source is
        // itself translated to G# and compiled by gsc — even though the
        // type test and every individual sub-property hold. #4153's own
        // repro isolates this to the enum sub-pattern ALONE: no other
        // sub-pattern (a null check or otherwise) is required to trigger
        // it, so every enum-containing property pattern over an
        // imported-interface-typed scrutinee is a candidate, not only ones
        // that also null-check. That is a gsc pattern-matcher defect
        // (issue #4153), not a cs2gs one, but self-hosting means cs2gs's
        // own source must avoid the shape gsc mishandles. The decomposed
        // form below — designated `is` narrowing, then plain `==`/`!=`
        // comparisons — is semantically identical in C# and is proven (by
        // regression test) to survive self-hosting.
        if type is INamedTypeSymbol named && named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod != nil {
            return this.MapNominalDelegate(named, context, location)
        }
        return this.Map(type, context, location)
    }

    /// Maps an explicitly written source type while preserving named CLR
    /// delegate identity. The canonical function delegates remain structural;
    /// other named delegates (for example `EventHandler`) are nominal.
    /// @param type The explicitly declared source type.
    /// @param context The translation context.
    /// @param location The originating source location.
    /// @returns The canonical G# type reference.
    func MapExplicitType(type ITypeSymbol, context TranslationContext, location Location?) GTypeReference? {
        if type is INamedTypeSymbol named &&
            named.TypeKind == TypeKind.Delegate &&
            named.DelegateInvokeMethod != nil &&
            (
            named.ContainingNamespace?.ToDisplayString() != "System" || (named.Name != "Func" && named.Name != "Action")
        ) {
            let mapped GTypeReference? = this.MapEventType(type, context, location)
            return if type.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
                WithNullable(mapped, true)
            } else {
                mapped
            }
        }
        // Issue #4113 follow-up (Copilot review of PR #4205): the delegate
        // check above only catches a nominal delegate written DIRECTLY as
        // the explicit type. One nested one level down — an array element
        // (`typeof(EventHandler[])`) or a non-tuple generic type argument
        // (`Observe<List<EventHandler>>()`) — still fell through to the
        // general Map() pipeline for that nested position, which collapses
        // it to the structural arrow form the same way the top-level case
        // used to. Map() first gives the CORRECT baseline shape (name,
        // namespace qualification, nested-containing-type handling, arity —
        // none of that changes here), and only the nested slot(s) are
        // rebuilt through MapExplicitType instead of Map.
        //
        // The guards on the generic branch are deliberate and each closes a
        // measured false-positive, not a hypothetical one: `Nullable<T>`
        // (`Memory<int>?`) is ITSELF a generic named type whose own single
        // type argument is the WRAPPED type, not a sibling type argument
        // list of the same shape — Map() special-cases it by unwrapping to
        // `T`'s own mapped shape before ever reaching the generic tail this
        // branch mirrors, so `structural` here is `T`'s reference (e.g.
        // `Memory[int32]`), and its TypeArguments correspond to `T`'s OWN
        // arguments, not `Nullable<T>`'s. Blindly zipping
        // `genericNamed.TypeArguments` (`[Memory<int>]`, Nullable's own
        // argument) onto that unrelated list — the count coincidentally
        // matched, both being length 1 — silently produced
        // `Memory[Memory[int32]]?`, corrupting an unrelated, correctly-typed
        // declaration. The `structural.Name` suffix check is the general
        // form of this same defense: it holds whenever Map() actually built
        // `structural` FROM `genericNamed`'s own qualified name (the
        // ordinary generic tail this substitution assumes), and fails
        // whenever Map() took some OTHER special-cased early exit (Nullable
        // unwrapping being the one this fix measured, not necessarily the
        // only one) that produced a reference naming a different type
        // entirely.
        //
        // A NESTED generic type (`Outer<T>.Inner<U>`) is excluded by the
        // count guard for a related reason: it splits its arguments between
        // TypeArguments and ContainingType in a way this substitution does
        // not attempt to reproduce, so it is skipped (falls through
        // unchanged) rather than risk zipping arguments against the wrong
        // slot — narrower coverage than a fully general fix, but never
        // wrong.
        if type is IArrayTypeSymbol array {
            let explicitElement GTypeReference? = this.MapExplicitType(array.ElementType, context, location)
            return CreateMappedArrayType(
                array,
                explicitElement,
                context,
                location,
                type.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated
            )
        }
        if type is INamedTypeSymbol genericNamed &&
            genericNamed.IsGenericType &&
            !genericNamed.IsTupleType &&
            !genericNamed.IsAnonymousType &&
            genericNamed
            .OriginalDefinition
            .SpecialType != SpecialType.System_Nullable_T &&
            this.Map(type, context, location) is NamedTypeReference structural && structural.Name.EndsWith(
            genericNamed.Name,
            StringComparison.Ordinal
        ) &&
            structural
            .TypeArguments
            .Count == genericNamed
            .TypeArguments
            .Length {
            let explicitArgs = genericNamed
                .TypeArguments
                .Select((a ITypeSymbol) -> this.MapExplicitType(a, context, location)!!)
                .ToList()
            let mapped GTypeReference = if explicitArgs.SequenceEqual(structural.TypeArguments) {
                structural
            } else {
                NamedTypeReference(structural.Name, explicitArgs, structural.ContainingType){
                    IsNullable = structural.IsNullable
                }
            }
            return this.PromoteTupleTypeArguments(mapped, type, genericNamed, context, List[int32]())
        }
        return this.Map(type, context, location)
    }

    /// Issue #2282: maps a C# anonymous type (`new { A = 1, B = "x" }`) to
    /// a synthesized G# `data class` whose primary-constructor parameters
    /// carry the SAME member names, instead of the earlier positional-tuple
    /// lowering (issue #1934) that discarded them (G# tuples have no
    /// named-element syntax — verified: no such syntax exists anywhere in the
    /// grammar/spec). The `object { }` anonymous-value literal (issue
    /// #2224) is not a substitute either: it is only a value-literal
    /// expression form with no corresponding TYPE-ANNOTATION spelling, so it
    /// cannot be written down as, say, a lambda parameter's type — which is
    /// exactly what issue #2282's repro needs (an EF-Core-style
    /// `CreateTable`/`PrimaryKey` pattern where the SAME anonymous
    /// type crosses from one lambda's inferred return type into another
    /// lambda's parameter type via generic inference). A synthesized data
    /// class is nameable at both the construction site and any type-position
    /// use, and supports named-member access (`x.A`) directly with no
    /// `.ItemN` rewrite. It is also legal inside an expression-tree
    /// lambda: a user-declared struct/class composite literal is explicitly
    /// permitted there (see `ExpressionTreeRestrictionValidator.ValidateExpression`,
    /// `BoundStructLiteralExpression` case), unlike the tuple literal the
    /// earlier lowering could have produced.
    ///
    /// Every distinct anonymous-type SHAPE (the ordered list of member name +
    /// fully-qualified property type) reuses the same synthesized type across
    /// the whole PACKAGE (issue #2292; formerly just the document) — keyed
    /// structurally via (cref:anonymousTypeRegistry), not by Roslyn
    /// symbol identity — so two syntactically-identical anonymous types
    /// declared in different places (even different files of the same
    /// package) still share one declaration, avoiding a combinatorial
    /// explosion of synthesized types and, just as importantly, avoiding two
    /// DISTINCT shapes across files ever minting the same synthetic name.
    /// @param anonymousType The anonymous type symbol.
    /// @param context The translation context that accumulates diagnostics.
    /// @param location The originating C# source location for diagnostics.
    /// @returns A reference to the synthesized (or already-cached) data class.
    func GetOrCreateAnonymousDataClass(
        anonymousType INamedTypeSymbol,
        context TranslationContext,
        location Location?
    ) NamedTypeReference -> this
        .GetOrCreateAnonymousDataClassShape(anonymousType, context, location).Type

    /// Records the retained top-level-statements entry point whose source body
    /// is emitted outside its containing `Program` type.
    /// @param entryPoint The retained program's synthesized entry point.
    internal func SetTopLevelStatementsEntryPoint(
        entryPoint IMethodSymbol?
    ) -> this.topLevelStatementsEntryPoint = entryPoint

    /// Reserves aliases and bare type names already present in the final
    /// translated import set.
    /// @param imports Imports collected from the active and merged source trees.
    /// @param contributingTrees Source trees whose declarations contribute to the emitted document.
    /// @param compilation The source compilation.
    internal func ReserveImportNames(
        imports IEnumerable[ImportDirective],
        contributingTrees IEnumerable[Microsoft.CodeAnalysis.SyntaxTree],
        compilation Compilation
    ) {
        let names = this.nameAllocator ?? EmittedNameAllocator.For(compilation)
        let importedNamespaces = HashSet[INamespaceSymbol](SymbolEqualityComparer.Default)
        let mappedMethods = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        let mappedTypes = HashSet[ITypeSymbol](SymbolEqualityComparer.Default)
        var AddMappedMethodSignatureNamespaces((IMethodSymbol?) -> void)? = nil
        var AddMappedTypeNamespaces((ITypeSymbol?) -> void)? = nil
        var AddSymbolNamespace((ISymbol?) -> void)? = nil
        AddSymbolNamespace = func (symbol ISymbol?) {
            var type INamedTypeSymbol? = symbol as INamedTypeSymbol
            if type != nil {
                while type!!.ContainingType != nil {
                    type = type!!.ContainingType
                }
                if type!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
                    importedNamespaces.Add(ns)
                }
            } else if symbol is IMethodSymbol method && GetExtensionMethodNamespace(method) is {} extensionNamespace {
                importedNamespaces.Add(extensionNamespace)
            }
        }
        AddMappedMethodSignatureNamespaces = func (method IMethodSymbol?) {
            if method == nil || !mappedMethods.Add(method) {
                return
            }
            if !method.ReturnsVoid {
                AddMappedTypeNamespaces!!(method.ReturnType)
            }
            for parameter in method.Parameters {
                AddMappedTypeNamespaces!!(parameter.Type)
            }
            for typeArgument in method.TypeArguments {
                AddMappedTypeNamespaces!!(typeArgument)
            }
        }
        AddMappedTypeNamespaces = func (type ITypeSymbol?) {
            if type == nil || type.TypeKind == TypeKind.Dynamic || type.TypeKind == TypeKind.Error || !mappedTypes.Add(
                type
            ) {
                return
            }
            switch type {
                case array is IArrayTypeSymbol {
                    AddMappedTypeNamespaces!!(array.ElementType)
                    return
                }
                case pointer is IPointerTypeSymbol {
                    AddMappedTypeNamespaces!!(pointer.PointedAtType)
                    return
                }
                case functionPointer is IFunctionPointerTypeSymbol {
                    AddMappedMethodSignatureNamespaces!!(functionPointer.Signature)
                    return
                }
                case ITypeParameterSymbol {
                    return
                }
            }
            if type is not INamedTypeSymbol named {
                return
            }
            if MapPredefinedName(named.SpecialType) != nil {
                return
            }
            if named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T {
                AddMappedTypeNamespaces!!(named.TypeArguments[0])
                return
            }
            if named.IsTupleType {
                for element in named.TupleElements {
                    AddMappedTypeNamespaces!!(element.Type)
                }
                return
            }
            if named.IsAnonymousType {
                for property in named.GetMembers().OfType[IPropertySymbol]() {
                    AddMappedTypeNamespaces!!(property.Type)
                }
                return
            }
            if named.TypeKind == TypeKind.Delegate &&
                named.DelegateInvokeMethod is {} invoke &&
                !IsSourceDeclaredDelegate(named) {
                AddMappedMethodSignatureNamespaces!!(invoke)
                return
            }
            for typeArgument in named.TypeArguments {
                AddMappedTypeNamespaces!!(typeArgument)
            }
            if named.ContainingType != nil {
                AddMappedTypeNamespaces!!(named.ContainingType)
            }
            if !this.AnalyzerApiMode || !RoslynAnalyzerApiMap.IsRoslynNamespace(
                named.ContainingNamespace?.ToDisplayString()
            ) {
                AddSymbolNamespace!!(named)
            }
        }
        let AddImportedNamespace = func (emittedNamespace string) {
            let importedNamespace INamespaceSymbol? = ResolveEmittedNamespace(compilation, emittedNamespace, names)
            if importedNamespace != nil {
                importedNamespaces.Add(importedNamespace)
            }
        }
        let AddMappedOperationTypeNamespaces = func (
            node Microsoft.CodeAnalysis.SyntaxNode,
            operation IOperation?,
            semanticModel Microsoft.CodeAnalysis.SemanticModel
        ) {
            AddMappedTypeNamespaces!!(operation?.Type)
            if node is Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax expression {
                let typeInfo = semanticModel.GetTypeInfo(expression)
                AddMappedTypeNamespaces!!(typeInfo.Type)
                AddMappedTypeNamespaces!!(typeInfo.ConvertedType)
            }
        }
        for import_ in imports {
            if import_.Alias != nil {
                if !this.reservedTypeAliases.TryGetValue(import_.Alias!!, out var targets) {
                    targets = HashSet[string](StringComparer.Ordinal)
                    this.reservedTypeAliases.Add(import_.Alias!!, targets)
                }
                targets.Add(import_.Name)
                continue
            }
            AddImportedNamespace(import_.Name)
        }
        // Analyzer rewrites can synthesize imports from member/attribute
        // shapes that carry no mapped G# type symbol in the C# syntax. Reserve
        // every possible mapped target namespace up front so alias allocation
        // cannot depend on which declaration happens to translate first.
        if this.AnalyzerApiMode {
            for targetNamespace in AnalyzerTargetTypeNames.Value {
                AddImportedNamespace(targetNamespace.Key)
                this.reservedImportedTypeNames.UnionWith(targetNamespace.Value)
            }
        }
        // Qualified references are shortened and synthesize namespace imports
        // after translation. Calls and selected operation-bound expressions can
        // also map types absent from syntax. Pre-scan only those emitted shapes
        // so future bare names reserve alias candidates before first use.
        for tree in contributingTrees {
            let semanticModel = compilation.GetSemanticModel(tree)
            for node in tree.GetRoot().DescendantNodes() {
                if node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .TypeParameterSyntax typeParameter &&
                    semanticModel.GetDeclaredSymbol(typeParameter) is ITypeParameterSymbol typeParameterSymbol {
                    this.reservedTypeParameterNames.Add(names.GetName(typeParameterSymbol)!!)
                }
                if node is TypeDeclarationSyntax memberCensusDeclaration && semanticModel.GetDeclaredSymbol(
                    memberCensusDeclaration
                ) is INamedTypeSymbol declaredAggregate &&
                    (declaredAggregate.TypeKind == TypeKind.Class || declaredAggregate.TypeKind == TypeKind.Struct) {
                    for member in declaredAggregate.GetMembers() {
                        if member.IsStatic &&
                            (
                            member is IFieldSymbol ||
                                member is IPropertySymbol ||
                                (member is IMethodSymbol method && method.MethodKind == MethodKind.Ordinary)
                        ) {
                            this.reservedSiblingMemberNames.Add(names.GetName(member)!!)
                        }
                    }
                }
                if node is InvocationExpressionSyntax{Expression: SimpleNameSyntax invokedName} {
                    let invokedSymbol ISymbol? = semanticModel.GetSymbolInfo(invokedName).Symbol
                    if invokedSymbol is ILocalSymbol ||
                        invokedSymbol is IParameterSymbol ||
                        invokedSymbol is IRangeVariableSymbol ||
                        (invokedSymbol is IMethodSymbol method && method.MethodKind == MethodKind.LocalFunction) {
                        this.reservedInvokedLocalNames.Add(names.GetName(invokedSymbol)!!)
                    }
                }
                if node is AnonymousFunctionExpressionSyntax anonymousFunction {
                    // Inferred lambda and anonymous-method signatures can emit
                    // target types that have no corresponding type syntax.
                    let targetInvoke IMethodSymbol? = (
                        semanticModel.GetTypeInfo(anonymousFunction).ConvertedType as INamedTypeSymbol
                    )?.DelegateInvokeMethod ??
                        (semanticModel.GetOperation(anonymousFunction) as IAnonymousFunctionOperation)?.Symbol
                    AddMappedMethodSignatureNamespaces(targetInvoke)
                }
                // These lowerings emit operation/type-info types explicitly.
                // Ordinary expressions remain unreserved to avoid alias churn.
                let mapsOperationType = switch node {
                    case _ is AnonymousObjectCreationExpressionSyntax or
                        _ is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ConditionalExpressionSyntax or
                        _ is CollectionExpressionSyntax or
                        _ is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .DefaultExpressionSyntax or
                        _ is ImplicitArrayCreationExpressionSyntax or
                        _ is ImplicitObjectCreationExpressionSyntax or
                        _ is ImplicitStackAllocArrayCreationExpressionSyntax or
                        _ is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .SwitchExpressionSyntax or
                        _ is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ThrowExpressionSyntax: true
                    case literal is Microsoft.CodeAnalysis.CSharp.Syntax.LiteralExpressionSyntax: literal.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression
                    )
                    default: false
                }
                let mapsSymbolNamespace = node is NameSyntax ||
                    node is MemberAccessExpressionSyntax ||
                    node is InvocationExpressionSyntax ||
                    node is BaseObjectCreationExpressionSyntax
                if !mapsOperationType && !mapsSymbolNamespace {
                    continue
                }
                let operation IOperation? = semanticModel.GetOperation(node)
                if mapsOperationType {
                    AddMappedOperationTypeNamespaces(node, operation, semanticModel)
                }
                if !mapsSymbolNamespace {
                    continue
                }
                let symbolInfo = semanticModel.GetSymbolInfo(node)
                AddSymbolNamespace(symbolInfo.Symbol)
                for candidate in symbolInfo.CandidateSymbols {
                    AddSymbolNamespace(candidate)
                }
                switch operation {
                    case invocation is IInvocationOperation {
                        AddSymbolNamespace(invocation.TargetMethod)
                        AddMappedMethodSignatureNamespaces(invocation.TargetMethod)
                    }
                    case creation is IObjectCreationOperation {
                        AddMappedTypeNamespaces(creation.Constructor?.ContainingType ?? creation.Type)
                        AddMappedMethodSignatureNamespaces(creation.Constructor)
                    }
                    case delegateCreation is IDelegateCreationOperation {
                        AddMappedTypeNamespaces(delegateCreation.Type)
                        if delegateCreation.Target is IMethodReferenceOperation delegateTarget {
                            AddSymbolNamespace(delegateTarget.Method)
                            AddMappedMethodSignatureNamespaces(delegateTarget.Method)
                        }
                    }
                    case methodReference is IMethodReferenceOperation {
                        AddSymbolNamespace(methodReference.Method)
                        AddMappedMethodSignatureNamespaces(methodReference.Method)
                        if semanticModel.GetTypeInfo(node)
                            .ConvertedType is INamedTypeSymbol{DelegateInvokeMethod: {} targetInvoke} {
                            AddMappedMethodSignatureNamespaces(targetInvoke)
                        }
                    }
                }
            }
        }
        for importedNamespace in importedNamespaces {
            for type in importedNamespace.GetTypeMembers() {
                this.reservedImportedTypeNames.Add(names.GetName(type)!!)
            }
        }
    }

    /// Issue #3471: whether a bare identifier at file scope would bind to an
    /// import alias, an imported type, a synthesized type alias, or a
    /// source-declared top-level type of the same name. All of these shadow a
    /// sibling static member reference inside its declaring aggregate (imports
    /// and type names win over members in gsc scope resolution), so such
    /// members keep their type qualifier instead of printing bare.
    /// @param name The emitted member simple name to probe.
    /// @param context The active translation context.
    /// @returns `true` when the name is claimed at file scope.
    internal func ClaimsDocumentScopeName(name string?, context TranslationContext) bool {
        this.sourceDeclaredTypeNames ??= BuildSourceDeclaredTypeNames(context.Compilation, this.Names(context))
        return this.reservedTypeAliases.ContainsKey(name!!) || this.reservedImportedTypeNames.Contains(name!!) ||
            this
            .synthesizedTypeAliases
            .ContainsKey(name!!) || this.sourceDeclaredTypeNames!!.Contains(name!!)
    }

    internal func ReserveSiblingMemberName(name string?) -> this.reservedSiblingMemberNames.Add(name!!)

    /// Maps an exact inferred contract while qualifying metadata homonyms
    /// reachable through the current file's imports.
    /// @typeparam T The mapped result type.
    /// @param map Mapping operation to run under collision qualification.
    /// @returns The mapped result.
    internal func WithMetadataImportCollisionQualification[T]($map() -> T) T {
        let previous = this.qualifyMetadataImportCollisions
        this.qualifyMetadataImportCollisions = true
        try {
            return $map()
        } finally {
            this.qualifyMetadataImportCollisions = previous
        }
    }

    internal func GetOrCreateImportedTypeAlias(
        named INamedTypeSymbol?,
        context TranslationContext,
        location Location?
    ) string? -> this.GetOrCreateImportedTypeAlias(named, context, location, reuseOnly: false, precomputedTarget: nil)

    internal func GetOrCreateImportedTypeAlias(
        named INamedTypeSymbol?,
        context TranslationContext,
        location Location?,
        reuseOnly bool,
        precomputedTarget string?
    ) string? {
        let HasVisibleSourceTypeName = func (name string, context TranslationContext, location Location?) bool {
            if location?.SourceTree == nil {
                return false
            }
            let position = Math.Min(location!!.SourceSpan.Start, location!!.SourceTree!!.GetRoot().FullSpan.End - 1)
            let semanticModel = if object.ReferenceEquals(context.SemanticModel.SyntaxTree, location!!.SourceTree) {
                context.SemanticModel
            } else {
                context.Compilation.GetSemanticModel(location!!.SourceTree!!)
            }
            return semanticModel
                .LookupNamespacesAndTypes(position, name: name)
                .OfType[INamedTypeSymbol]()
                .Any((type INamedTypeSymbol) -> type.Locations.Any((candidate Location) -> candidate.IsInSource))
        }
        let HasVisibleCallableName = func (
            name string,
            context TranslationContext,
            location Location?,
            names EmittedNameAllocator
        ) bool {
            if location?.SourceTree == nil {
                return false
            }
            let position = Math.Min(location!!.SourceSpan.Start, location!!.SourceTree!!.GetRoot().FullSpan.End - 1)
            let semanticModel = if object.ReferenceEquals(context.SemanticModel.SyntaxTree, location!!.SourceTree) {
                context.SemanticModel
            } else {
                context.Compilation.GetSemanticModel(location!!.SourceTree!!)
            }
            return semanticModel
                .LookupSymbols(position)
                .OfType[IMethodSymbol]()
                .Any(
                (method IMethodSymbol) -> (
                    method.MethodKind == MethodKind.Ordinary || method.MethodKind == MethodKind.ReducedExtension
                ) &&
                    names.GetName(method) == name
            )
        }
        let names = this.Names(context)
        let simpleName string? = this.Names(context).GetName(named)
        let namespaceName string? = if named!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
            this.Names(context).GetNamespaceName(ns)
        } else {
            default(string?)
        }
        let target string? = precomputedTarget ??
            (
            if namespaceName != nil {
                "$namespaceName.$simpleName"
            } else {
                simpleName
            }
        )
        for reservedAlias in this.reservedTypeAliases {
            if reservedAlias.Value.Count == 1 && reservedAlias.Value.Contains(target!!) &&
                !this
                .reservedTypeParameterNames
                .Contains(reservedAlias.Key) && !this.reservedInvokedLocalNames.Contains(reservedAlias.Key) &&
                !HasVisibleCallableName(reservedAlias.Key, context, location, names) &&
                !HasVisibleSourceTypeName(reservedAlias.Key, context, location) {
                return reservedAlias.Key
            }
        }
        for existing in this.synthesizedTypeAliases {
            if existing.Value == target && !this.reservedTypeParameterNames.Contains(existing.Key) &&
                !this
                .reservedInvokedLocalNames
                .Contains(existing.Key) &&
                !HasVisibleCallableName(existing.Key, context, location, names) &&
                !HasVisibleSourceTypeName(existing.Key, context, location) {
                return existing.Key
            }
        }
        if reuseOnly {
            return nil
        }
        // Issue #4556: an analysis-only mapping prints nothing, so it must not
        // register an alias import either; the qualified target spells the
        // same type for whatever shape the caller inspects.
        if this.importTrackingSuppression != 0 {
            return target
        }
        this.sourceDeclaredTypeNames ??= BuildSourceDeclaredTypeNames(context.Compilation, this.Names(context))
        let reserved = HashSet[string](this.synthesizedTypeAliases.Keys, StringComparer.Ordinal)
        reserved.UnionWith(this.reservedTypeAliases.Keys)
        reserved.UnionWith(this.reservedImportedTypeNames)
        reserved.UnionWith(this.reservedTypeParameterNames)
        reserved.UnionWith(this.reservedInvokedLocalNames)
        reserved.UnionWith(this.sourceDeclaredTypeNames!!)
        reserved.UnionWith(this.reservedSiblingMemberNames)
        let namespaceQualifier = namespaceName?.Split('.').Last() ?? "Global"
        let alias = LiftedLocalFunctionNameAllocator.For(context.Compilation).ClaimAlias(
            target,
            "$namespaceQualifier$simpleName",
            (candidate string) -> reserved.Contains(candidate) ||
                HasVisibleCallableName(candidate, context, location, names)
        )
        this.synthesizedTypeAliases.Add(alias, target!!)
        return alias
    }

    internal func GetOrCreateAnonymousDataClassShape(
        anonymousType INamedTypeSymbol?,
        context TranslationContext,
        location Location?,
        mappedPropertyTypes IReadOnlyList[GTypeReference]? = nil
    )(
        Type NamedTypeReference,
        Properties IReadOnlyList[IPropertySymbol],
        PropertyTypes IReadOnlyList[GTypeReference]?
    ) {
        var mappedPropertyTypes = mappedPropertyTypes
        let properties = anonymousType!!.GetMembers().OfType[IPropertySymbol]().ToList()
        mappedPropertyTypes ??= properties.Select(
            (property IPropertySymbol) -> this.Map(property.Type, context, location)!!
        )
            .ToList()
        mappedPropertyTypes = this.MergeAnonymousShapeContracts(properties, mappedPropertyTypes, context)
        let shapeKey = AnonymousShapeKey(properties)
        // A shape synthesized by an earlier file in the same package is reused
        // without redeclaration. A new shape gets the same deterministic name
        // in every document or project that translates it (#2598).
        //
        // ADR-0192 partial-pair reconciliation re-translates a document with
        // the SAME translator (so its registry still holds this document's
        // shapes). The document that first declared a shape owns it and must
        // declare it again when it is re-translated — once per translation.
        if this.anonymousTypeRegistry.TryGetExisting(shapeKey, out var existing) &&
            (
            !this.anonymousTypeRegistry.IsOwnedBy(shapeKey, context.FilePath) || this.declaredAnonymousShapes.Contains(
                shapeKey
            )
        ) {
            return (existing, properties, mappedPropertyTypes)
        }
        let syntheticName = AnonymousTypeRegistry.SyntheticName(shapeKey, properties.Count)
        let parameters = properties.Select(
            (property IPropertySymbol, index int32) -> Cs2Gs
                .CodeModel
                .Ast
                .Parameter(
                this.Names(context).GetName(property, IdentifierNameContext.Parameter),
                mappedPropertyTypes!![index]
            )
        )
            .ToList()
        context.Report(
            TranslationDiagnostic(
                anonymousType!!.ToDisplayString(),
                "C# anonymous type mapped to a synthesized G# 'data class $syntheticName' preserving member names as primary-constructor parameters (issue #2282); supersedes the earlier name-dropping positional-tuple lowering (issue #1934) so named-member access ('x.${(if properties.Count > 0 { properties[0].Name } else { "Member" })}') resolves.",
                location,
                TranslationSeverity.Info
            )
        )
        let declaration = TypeDeclaration(
            TypeDeclarationKind.DataClass,
            syntheticName,
            primaryConstructorParameters: parameters,
            visibility: Visibility.Internal
        )
        let reference = NamedTypeReference(syntheticName)
        this.anonymousTypeRegistry.Register(shapeKey, reference, context.FilePath)
        this.declaredAnonymousShapes.Add(shapeKey)
        this.pendingAnonymousDataClasses.Add(declaration)
        return (reference, properties, mappedPropertyTypes)
    }

    internal func GetAnonymousPropertyType(
        property IPropertySymbol,
        context TranslationContext,
        location Location
    ) GTypeReference {
        let shape = this.GetOrCreateAnonymousDataClassShape(property.ContainingType, context, location)
        let index = shape
            .Properties
            .Select((candidate IPropertySymbol, candidateIndex int32) -> (candidate, candidateIndex))
            .First((pair(candidate IPropertySymbol, candidateIndex int32)) -> pair.Item1.Name == property.Name)
            .Item2
        return shape.PropertyTypes!![index]
    }

    internal func LiftedNestedDelegateName(named INamedTypeSymbol?, context TranslationContext) string {
        let parts = List[string]()
        for var current INamedTypeSymbol? = named; current != nil; current = current!!.ContainingType {
            parts.Insert(0, this.Names(context).GetName(current)!!)
        }
        return string.Join("_", parts)
    }

    // Issue #4113: a `typeof(...)` operand observes the CLR's actual runtime
    // Type identity, so it needs the same "preserve named-delegate identity"
    // treatment MapExplicitType already applies to an explicitly-typed
    // declaration (issue #2835/#3841) — not the general Map() pipeline, whose
    // structural-arrow canonicalization is a style choice appropriate for a
    // *declaration*, not for an expression whose entire purpose is to name an
    // exact runtime type. Routing through the general mapper silently turned
    // `typeof(EventHandler)` into `typeof(Action<object, EventArgs>)`: a
    // different CLR type, breaking every runtime identity comparison against
    // it (reflection-based ABI assertions, and — once this very method's own
    // source is self-hosted — gsc's own CanonicalizeWellKnownEventHandler,
    // which returns `TypeSymbol.FromClrType(typeof(EventHandler))`).
    internal func MapTypeOf(type ITypeSymbol, context TranslationContext, location Location) GTypeReference? {
        return this.MapExplicitType(type, context, location)
    }

    internal func MapNominalDelegate(
        type INamedTypeSymbol,
        context TranslationContext,
        location Location?
    ) GTypeReference? {
        // Imported owners remain constructed; source delegates are lifted to top level.
        let mapped = if !IsSourceDeclaredDelegate(type) && HasGenericContainingType(type) {
            this.MapConstructedNestedType(type, context, location)
        } else {
            cast[GTypeReference](
                if type.IsGenericType {
                    NamedTypeReference(
                        this.DelegateTypeName(type, context, location),
                        type
                            .TypeArguments
                            .Select((argument ITypeSymbol) -> this.Map(argument, context, location)!!)
                            .ToList()
                    )
                } else {
                    NamedTypeReference(this.DelegateTypeName(type, context, location))
                }
            )
        }
        return this.PromoteTupleTypeArguments(mapped, type, type, context, List[int32]())
    }

    internal func PromoteTupleTypeArguments(
        mapped GTypeReference?,
        declaredType ITypeSymbol?,
        symbol ISymbol?,
        context TranslationContext,
        path List[int32]
    ) GTypeReference? {
        var mapped = mapped
        if path.Count == 0 &&
            !(declaredType is INamedTypeSymbol && declaredType.IsTupleType == true) &&
            !ObliviousNullabilityAnalyzer.HasNestedTupleSlots(declaredType) {
            return mapped
        }
        if mapped is TupleTypeReference tuple &&
            declaredType is INamedTypeSymbol{IsTupleType: true} tupleType &&
            tuple
            .ElementTypes
            .Count == tupleType
            .TupleElements
            .Length {
            let elements = List[GTypeReference](tuple.ElementTypes.Count)
            var changed = false
            for var i = 0; i < tuple.ElementTypes.Count; i++ {
                path.Add(i)
                let element GTypeReference? = this.PromoteTupleTypeArguments(
                    tuple.ElementTypes[i],
                    tupleType.TupleElements[i].Type,
                    symbol,
                    context,
                    path
                )
                path.RemoveAt(path.Count - 1)
                changed |= !object.ReferenceEquals(element, tuple.ElementTypes[i])
                elements.Add(element!!)
            }
            return if changed {
                cast[GTypeReference](TupleTypeReference(elements, tuple.ElementNames){IsNullable = tuple.IsNullable})
            } else {
                mapped
            }
        }
        if mapped is NamedTypeReference named &&
            declaredType is INamedTypeSymbol declaredNamed &&
            named
            .TypeArguments
            .Count > 0 &&
            named
            .TypeArguments
            .Count == declaredNamed
            .TypeArguments
            .Length {
            let arguments = List[GTypeReference](named.TypeArguments.Count)
            var changed = false
            for var i = 0; i < named.TypeArguments.Count; i++ {
                path.Add(i)
                let argument GTypeReference? = this.PromoteTupleTypeArguments(
                    named.TypeArguments[i],
                    declaredNamed.TypeArguments[i],
                    symbol,
                    context,
                    path
                )
                path.RemoveAt(path.Count - 1)
                changed |= !object.ReferenceEquals(argument, named.TypeArguments[i])
                arguments.Add(argument!!)
            }
            if changed {
                mapped = NamedTypeReference(named.Name, arguments, named.ContainingType){IsNullable = named.IsNullable}
            }
        }
        return if path.Count > 0 && !mapped!!.IsNullable && ObliviousNullabilityAnalyzer.IsTupleElementTainted(
            context.Compilation,
            symbol,
            path,
            context.SiblingCompilations
        ) {
            WithNullable(mapped, true)
        } else {
            mapped
        }
    }

    private func MapConstructedNestedType(
        named INamedTypeSymbol,
        context TranslationContext,
        location Location?
    ) GTypeReference {
        let ownTypeArguments IReadOnlyList[ITypeSymbol] = if named.Arity == 0 {
            Array.Empty[ITypeSymbol]()
        } else {
            named.TypeArguments.Skip(named.TypeArguments.Length - named.Arity).ToArray()
        }
        let mappedOwnTypeArguments = ownTypeArguments.Select(
            (argument ITypeSymbol) -> this.Map(argument, context, location)!!
        )
            .ToList()
        // A source nested type used from inside its own generic
        // containing type remains directly in scope. Qualifying it
        // through Outer[T] makes gsc treat the inherited nested type
        // as an external constructed lookup and fail to resolve it.
        if named.Locations.Any((candidate Location) -> candidate.IsInSource) && !this.HasSourceHomonym(
            named,
            context
        ) &&
            IsWithinContainingType(named, context, location) {
            return NamedTypeReference(this.Names(context).GetName(named), mappedOwnTypeArguments)
        }
        return NamedTypeReference(
            this.Names(context).GetName(named),
            mappedOwnTypeArguments,
            this.Map(named.ContainingType, context, location)
        )
    }

    private func QualifiedAliasTarget(type INamedTypeSymbol) string {
        if this.nameAllocator == nil {
            return StripGlobalPrefix(type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat))
        }
        let nameAllocator = this.nameAllocator!!
        let parts = Stack[string]()
        var outermost INamedTypeSymbol? = type
        for var current INamedTypeSymbol? = type; current != nil; current = current!!.ContainingType {
            parts.Push(nameAllocator.GetName(current)!!)
            outermost = current
        }
        let typeName = string.Join(".", parts)
        return if outermost!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
            "${nameAllocator.GetNamespaceName(ns)}.$typeName"
        } else {
            typeName
        }
    }

    private func Names(context TranslationContext) EmittedNameAllocator -> this.nameAllocator ??
        EmittedNameAllocator.For(context.Compilation)

    /// Issue #1906: maps a C# function-pointer type (`delegate*<...>`)
    /// to a G# function-pointer type. A plain `delegate*<T, R>` or an
    /// explicit `delegate* managed<T, R>` is the <b>default</b>
    /// (managed) calling convention ((cref:SignatureCallingConvention.Default))
    /// and maps to G#'s managed form `*func(T) R` (ADR-0122 §9). A
    /// `delegate* unmanaged[Cdecl]<T, R>` (and the three other named
    /// single conventions) maps to G#'s raw form `unmanaged[CC] (T) -> R`
    /// (ADR-0095), whose `[CC]` slot only accepts one of the four fixed
    /// P/Invoke-style conventions. A bare `delegate* unmanaged<T, R>`
    /// (the platform-default ABI, which is Winapi/StdCall on Windows x86 and
    /// Cdecl elsewhere — genuinely platform-dependent, unlike the other four
    /// fixed conventions) and a combined/custom convention (e.g.
    /// `unmanaged[Cdecl, SuppressGCTransition]`) map to G#'s open
    /// calling-convention model (ADR-0095 v2 / issue #3611): bare
    /// `unmanaged (T) -> R` and `unmanaged[Name, ...] (T) -> R`
    /// respectively, with the `CallConv` short names in source order.
    /// @param type The C# function-pointer type symbol.
    /// @param context The translation context that accumulates diagnostics.
    /// @param location The originating C# source location for diagnostics.
    /// @returns The mapped G# function-pointer type, or the placeholder for the two unrepresentable
    /// calling-convention sub-cases.
    private func MapFunctionPointer(
        type IFunctionPointerTypeSymbol,
        context TranslationContext,
        location Location?
    ) GTypeReference {
        let signature = type.Signature
        let parameterTypes = signature
            .Parameters
            .Select((p IParameterSymbol) -> this.Map(p.Type, context, location)!!)
            .ToList()
        let returnType GTypeReference? = if signature.ReturnsVoid {
            default(GTypeReference?)
        } else {
            this.Map(signature.ReturnType, context, location)
        }
        if signature.CallingConvention == SignatureCallingConvention.Default {
            return FunctionPointerTypeReference(isManaged: true, default(CallingConvention), parameterTypes, returnType)
        }
        let callingConvention = switch signature.CallingConvention {
            case SignatureCallingConvention.CDecl: CallingConvention.Cdecl
            case SignatureCallingConvention.StdCall: CallingConvention.StdCall
            case SignatureCallingConvention.ThisCall: CallingConvention.ThisCall
            case SignatureCallingConvention.FastCall: CallingConvention.FastCall
            case SignatureCallingConvention.Unmanaged: MapSingleUnmanagedConvention(
                signature.UnmanagedCallingConventionTypes
            )
            default: nil
        }
        if callingConvention is {} resolved {
            return FunctionPointerTypeReference(isManaged: false, resolved, parameterTypes, returnType)
        }
        // ADR-0095 v2 / issue #3611: the two formerly by-design-gapped
        // shapes now map to G#'s open calling-convention model. A bare
        // `delegate* unmanaged<...>` (platform-default ABI, empty modopt
        // set) spells `unmanaged (T) -> R`; a combined or non-legacy
        // convention set spells `unmanaged[Name, ...] (T) -> R` with the
        // CallConv short names in source order — gsc encodes both
        // byte-identically to csc.
        if signature.CallingConvention == SignatureCallingConvention.Unmanaged {
            let conventionNames = signature
                .UnmanagedCallingConventionTypes
                .Select(
                (conventionType INamedTypeSymbol) -> if conventionType.Name.StartsWith(
                    "CallConv",
                    StringComparison.Ordinal
                ) {
                    conventionType.Name.Substring("CallConv".Length)
                } else {
                    conventionType.Name
                }
            )
                .ToList()
            return FunctionPointerTypeReference(conventionNames, parameterTypes, returnType)
        }
        context.Report(
            TranslationDiagnostic(
                "FunctionPointerType",
                "unsafe function-pointer type '${type.ToDisplayString()}' has no canonical G# form: its calling convention '${signature.CallingConvention}' has no G# spelling (issue #1906).",
                location,
                TranslationSeverity.Unsupported
            ){Classification = UnsupportedClassification.ByDesign, Rationale = UnsupportedRationale.NoGsharpConstruct}
        )
        return NamedTypeReference(UnsupportedPlaceholderType)
    }

    private func MapCore(type ITypeSymbol?, context TranslationContext, location Location?) GTypeReference? {
        // Width-bearing primitive names (ADR-0115 §B.12).
        let predefined string? = MapPredefinedName(type!!.SpecialType)
        if predefined != nil {
            return NamedTypeReference(predefined)
        }
        if type is IArrayTypeSymbol array {
            let element GTypeReference? = this.Map(array.ElementType, context, location)
            return CreateMappedArrayType(array, element, context, location, isNullable: false)
        }
        if type is ITypeParameterSymbol typeParameter {
            return NamedTypeReference(this.Names(context).GetName(typeParameter))
        }
        if type is INamedTypeSymbol named {
            if IsRecognizedManagedReferenceConsumerType(named, context.Compilation) {
                let readOnly = named.Name == "ReadOnlyManagedRef"
                let element GTypeReference? = this.Map(named.TypeArguments[0], context, location)
                if location == nil ||
                    !location.IsInSource ||
                    location.SourceTree != context
                    .SemanticModel
                    .SyntaxTree ||
                    context
                    .SemanticModel
                    .LookupSymbols(location.SourceSpan.Start, name: "managed")
                    .Any() ||
                    (
                    readOnly && context.SemanticModel.LookupSymbols(location.SourceSpan.Start, name: "readonly").Any()
                ) {
                    return NamedTypeReference("Gsharp.Values." + named.Name, []GTypeReference{element!!})
                }
                return ManagedReferenceTypeReference(element, readOnly)
            }
            if IsRecognizedRuntimeConsumerType(named, context.Compilation, "Slice", "ReadOnlySlice") {
                let element GTypeReference? = this.Map(named.TypeArguments[0], context, location)
                if location == nil ||
                    !location.IsInSource ||
                    location.SourceTree != context
                    .SemanticModel
                    .SyntaxTree ||
                    context
                    .SemanticModel
                    .LookupSymbols(location.SourceSpan.Start, name: "slice")
                    .Any() {
                    return NamedTypeReference("Gsharp.Values." + named.Name, []GTypeReference{element!!})
                }
                return NativeSliceTypeReference(element, named.Name == "ReadOnlySlice")
            }
            // Value tuples map to the native G# tuple type. ADR-0172: G#
            // now has named tuple elements, so C# element names are
            // PRESERVED name-first — `(int Line, int Column)` becomes
            // `(Line int32, Column int32)` — and named access stays by-name
            // at the use site (ADR-0115 §B.4 as amended). A default
            // positional name (`Item1` at position 1, …) counts as unnamed.
            // `(T)` is a parenthesized type, not System.ValueTuple<T>.
            if named.IsTupleType && named.TupleElements.Length > 1 {
                let elementTypes = named
                    .TupleElements
                    .Select((e IFieldSymbol) -> this.Map(e.Type, context, location)!!)
                    .ToList()
                let elementNames = named
                    .TupleElements
                    .Select(
                    (e IFieldSymbol, i int32) -> if e.IsImplicitlyDeclared || e.Name == "Item" + (i + 1).ToString() {
                        default(string?)
                    } else {
                        e.Name
                    }
                )
                    .ToList()
                return TupleTypeReference(elementTypes, elementNames)
            }
            // Issue #2282 (was #1934): an anonymous type (`new { A = 1, B = 2 }`)
            // maps to a synthesized, shape-deduplicated G# `data class` that
            // preserves member NAMES as primary-constructor parameters — see
            // <see cref="GetOrCreateAnonymousDataClass"/> for why the earlier
            // name-dropping positional-tuple lowering (issue #1934) was
            // insufficient (G# tuples have no named-element syntax) and why the
            // `object { }` anonymous-value literal (issue #2224) cannot replace
            // it either (no type-annotation spelling, so it cannot appear at a
            // TYPE position such as a lambda parameter whose type a generic
            // method infers from another lambda's anonymous-typed return
            // value).
            if named.IsAnonymousType {
                return this.GetOrCreateAnonymousDataClass(named, context, location)
            }
            // Delegate types (Func/Action/named delegates) render in arrow form
            // (ADR-0115 §B.8).
            //
            // Issue #2835: EXCEPT a delegate declared in the source being
            // translated. CLR delegates are nominally typed — structurally
            // equivalent delegates are not interchangeable — and cs2gs emits a
            // real `delegate X(…) ` declaration for every source;
            // delegate, so erasing its uses to `(string) -> void` (i.e.
            // `Action[string]`) makes the translated program fail at runtime the
            // moment a value crosses between the two spellings. This is the same
            // reasoning `MapEventType` already applies to an event's own handler
            // type, now extended to every type position.
            //
            // Issue #4679: imported delegates other than System.Func/Action
            // also have distinct CLR identities. Predicate<T> is NOT Func<T,
            // bool>. Preserve those names here so inferred types, casts,
            // patterns and nested arguments agree with explicit type positions.
            //
            // Issue #3841: ALSO except an imported delegate whose identity is
            // load-bearing in this compilation — one that discriminates an
            // overload set the arrow form would collapse into a single G#
            // signature (`Add(Predicate<T>)` / `Add(Func<T, bool>)`, GS0264).
            // Scoped to the exact CONSTRUCTED delegate types involved, so every
            // other Func/Action keeps the arrow form. See
            // IsIdentityCriticalDelegate.
            if named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod != nil {
                if IsSourceDeclaredDelegate(named) || named.ContainingNamespace?.ToDisplayString() != "System" ||
                    (named.Name != "Func" && named.Name != "Action") ||
                    this.IsIdentityCriticalDelegate(named, context) {
                    return this.MapNominalDelegate(named, context, location)
                }
                return this.MapDelegate(named.DelegateInvokeMethod, context, location)
            }
            if named.ContainingType != nil &&
                named.Name == "Builder" &&
                named
                .ContainingType
                .OriginalDefinition
                .ToDisplayString() == "System.Collections.Immutable.ImmutableArray<T>" {
                return NamedTypeReference("Builder", containingType: this.Map(named.ContainingType, context, location))
            }
            if HasGenericContainingType(named) {
                return this.MapConstructedNestedType(named, context, location)
            }
            if named.IsGenericType {
                let args = named.TypeArguments.Select((a ITypeSymbol) -> this.Map(a, context, location)!!).ToList()
                return NamedTypeReference(this.QualifiedTypeName(named, context, location), args)
            }
            return NamedTypeReference(this.QualifiedTypeName(named, context, location))
        }
        return NamedTypeReference(this.Names(context).GetName(type))
    }

    private func DelegateTypeName(named INamedTypeSymbol, context TranslationContext, location Location?) string? {
        return if IsLiftedNestedDelegate(named) {
            this.LiftedNestedDelegateName(named, context)
        } else {
            this.QualifiedTypeName(named, context, location)
        }
    }

    // A nested type is referenced through its containing type(s)
    // (`ConfiguredTaskAwaitable.ConfiguredTaskAwaiter`); emitting the innermost
    // name alone makes the reference unresolvable. Walk the containing-type chain
    // and join with '.' so nested types stay qualified (ADR-0115 §B.12).
    //
    // Metadata (BCL/external) nested types are ALWAYS qualified. A source-declared
    // nested type is emitted by the translator as a directly-nested G# member and
    // is normally referenced by its simple name within the package. However, when
    // another source type shares its simple name (issue #1174 / #914: e.g. a
    // top-level `class SampleEntry` alongside `class SttsBox { data struct
    // SampleEntry(...) }`), the bare name binds to the homonym that holds the
    // simple key — so the nested type must be qualified `Container.Nested` to
    // resolve correctly. This is now safe to emit in every position (generic
    // arguments, type clauses, struct literals) thanks to the issue #1174
    // language fix, so the qualified form round-trips under gsc. Issue #2509
    // additionally prefixes the namespace when the OUTERMOST containing type
    // itself collides across imported packages.
    private func QualifiedTypeName(named INamedTypeSymbol, context TranslationContext, location Location?) string? {
        // ADR-0169 analyzer translation mode: Microsoft.CodeAnalysis types are
        // rewritten to the G# analyzer API instead of passing through as
        // imported CLR types (the one place the passthrough rule is wrong).
        // Unmapped Roslyn types fail loudly as CS2GS-GAP; Adapted mappings
        // carry a CS2GS-ANALYZER-SHAPE review warning.
        if this.AnalyzerApiMode && RoslynAnalyzerApiMap.IsRoslynNamespace(
            named.ContainingNamespace?.ToDisplayString()
        ) {
            let roslynName = "${named.ContainingNamespace.ToDisplayString()}.${named.Name}"
            if RoslynAnalyzerApiMap.TryMapType(roslynName, out var mapped) {
                if !string.IsNullOrEmpty(mapped.GsNamespace) && this.importTrackingSuppression == 0 {
                    this.shortenedNamespaces.Add(mapped.GsNamespace!!)
                }
                if mapped.AdaptationNote != nil {
                    context.Report(
                        TranslationDiagnostic(
                            "analyzer-api",
                            "'$roslynName' translated as '${mapped.GsNamespace}.${mapped.GsName}': ${mapped.AdaptationNote}",
                            location,
                            TranslationSeverity.Warning
                        ){DiagnosticId = "CS2GS-ANALYZER-SHAPE"}
                    )
                }
                return mapped.GsName
            }
            context.Report(
                TranslationDiagnostic(
                    "analyzer-api",
                    "Roslyn API type '$roslynName' has no G# analyzer-API mapping (ADR-0169).",
                    location
                )
            )
            return this.Names(context).GetName(named)
        }
        if named.ContainingType == nil {
            // Issue #3501: when the source file declares a `using Alias = …;`
            // for this exact type, render the ALIAS instead of shortening to
            // the bare name. The bare rendering forced a synthesized
            // whole-namespace import that could collide with another imported
            // namespace's simple names (EmittedNameAllocator's
            // `import GSharp.Core.CodeAnalysis.Syntax` made Roslyn's
            // `AssignmentExpressionSyntax`/`SyntaxKind` ambiguous, and gsc
            // silently bound the wrong one — surfacing as GS0532 on the
            // now-impossible patterns). The alias import is already emitted by
            // the ordinary using-directive translation, so the alias name
            // resolves without any synthesized namespace import.
            if this.TryReuseSourceUsingAlias(named, context, location, out var sourceAlias) {
                return sourceAlias
            }
            this.TrackShortenedNamespace(named)
            let simpleName string? = this.Names(context).GetName(named)
            let visibleNestedHomonym = this.HasVisibleSourceNestedHomonym(named, context, location)
            if IsDeclaredInContainingNamespace(named, context, location) && !visibleNestedHomonym {
                return simpleName
            }
            // Issue #2222: a bare top-level type name is ambiguous in G#'s flat
            // import scope when another top-level type of the SAME simple name
            // is reachable through this file's imports (a source homonym
            // anywhere in the compilation, per #1174's conservative census, OR a
            // distinct type of the same name sitting in one of the file's
            // actually-imported namespaces — including a referenced assembly,
            // i.e. a translated sibling project surfaced as a metadata
            // reference). Qualify source types with their namespace and alias
            // metadata types in that case so gsc binds the reference to the
            // right type instead of whichever homonym happens to resolve first.
            //
            // Issue #3554: the imported-namespace scan now runs for METADATA
            // types in ordinary positions too (previously constraint-mapping
            // only, #2509). The scan only fires when a DISTINCT same-named
            // type actually sits in another of this file's imported
            // namespaces, so common framework types still print bare; but a
            // genuine metadata/metadata collision — G#'s own
            // `GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts` referenced
            // fully-qualified in a file that also imports
            // `Microsoft.CodeAnalysis.CSharp` (Roslyn's `SyntaxFacts`) —
            // previously shortened to a bare name gsc silently bound to the
            // WRONG package (GS0159 "Cannot find function IsReservedIdentifier").
            let isSourceType = named.Locations.Any((l Location) -> l.IsInSource)
            let ambiguous = this.HasSourceHomonym(named, context) ||
                visibleNestedHomonym ||
                this.HasImportedNamespaceHomonym(named, context)
            if !ambiguous {
                return simpleName
            }
            return this.AmbiguousTopLevelTypeName(named, simpleName, isSourceType, context, location)
        }
        // A source nested type may use its simple name only from inside its
        // containing type. External references still require `Outer.Nested`
        // even when no homonym exists.
        if named.Locations.Any((l Location) -> l.IsInSource) && !this.HasSourceHomonym(named, context) &&
            !this.HasSourceNestedHomonym(named, context) && !this.HasImportedNamespaceHomonym(named, context) &&
            IsWithinContainingType(named, context, location) {
            return this.Names(context).GetName(named)
        }
        let parts = List[string]()
        var outermost INamedTypeSymbol? = named
        for var current INamedTypeSymbol? = named; current != nil; current = current!!.ContainingType {
            parts.Insert(0, this.Names(context).GetName(current)!!)
            outermost = current
        }
        this.TrackShortenedNamespace(outermost)
        let nestedName = string.Join(".", parts)
        // Issue #3554: same unconditional imported-namespace scan as the
        // top-level branch above — the containing type of a nested reference
        // can collide across imported metadata namespaces just as easily.
        let outermostAmbiguous = this.HasSourceHomonym(outermost, context) || this.HasVisibleSourceNestedHomonym(
            outermost,
            context,
            location
        ) ||
            this.HasImportedNamespaceHomonym(outermost, context)
        if !outermostAmbiguous {
            return nestedName
        }
        parts[0] = this.AmbiguousTopLevelTypeName(
            outermost,
            parts[0],
            outermost!!.Locations.Any((candidate Location) -> candidate.IsInSource),
            context,
            location
        )!!
        return string.Join(".", parts)
    }

    private func AmbiguousTopLevelTypeName(
        named INamedTypeSymbol?,
        simpleName string?,
        isSourceType bool,
        context TranslationContext,
        location Location?
    ) string? {
        if (!isSourceType && SupportsMetadataTypeAlias(named)) ||
            (isSourceType && named!!.ContainingNamespace is {IsGlobalNamespace: true}) {
            // ponytail: metadata aliases currently bind reliably for System.*;
            // source aliases also bind within the current compilation. Keep
            // other external metadata namespace-qualified until arbitrary CLR
            // alias imports bind.
            return this.GetOrCreateImportedTypeAlias(named, context, location)
        }
        return if named!!.ContainingNamespace is {IsGlobalNamespace: false} containingNamespace {
            "${this.Names(context).GetNamespaceName(containingNamespace)}.$simpleName"
        } else {
            simpleName
        }
    }

    private func IsWithinContainingType(
        nestedType INamedTypeSymbol,
        context TranslationContext,
        location Location?
    ) bool {
        let containingType INamedTypeSymbol? = nestedType.ContainingType
        if containingType == nil || location == nil || !location.IsInSource {
            return false
        }
        let enclosing ISymbol? = context.SemanticModel.GetEnclosingSymbol(location.SourceSpan.Start)
        for var current ISymbol? = enclosing; current != nil; current = current!!.ContainingSymbol {
            if SymbolEqualityComparer.Default.Equals(current, this.topLevelStatementsEntryPoint) {
                return false
            }
        }
        let currentType INamedTypeSymbol? = enclosing as INamedTypeSymbol ?? enclosing?.ContainingType
        for var current INamedTypeSymbol? = currentType; current != nil; current = current!!.ContainingType {
            if SymbolEqualityComparer.Default.Equals(current, containingType) {
                return true
            }
        }
        return false
    }

    /// Issue #2211: records [`outermostType`](paramref)'s namespace as one
    /// this mapper shortened a reference into, so the translator can synthesize
    /// a matching `import` when no `using` directive already covers it
    /// (see (cref:shortenedNamespaces)). The global namespace (no
    /// namespace at all) needs no import and is skipped.
    /// @param outermostType The outermost containing type of the reference (itself, if not nested).
    private func TrackShortenedNamespace(outermostType INamedTypeSymbol?) {
        if this.importTrackingSuppression == 0 && outermostType!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
            this.shortenedNamespaces.Add(this.nameAllocator?.GetNamespaceName(ns) ?? ns.ToDisplayString())
        }
    }

    /// Issue #1174: whether a source-declared top-level type shares the simple
    /// name of [`named`](paramref), making the bare name ambiguous in the
    /// flat G# package scope. Nested declarations are excluded from the census:
    /// they are reachable through their containing type, not through an import.
    /// The per-compilation simple-name census is built once and cached on this
    /// mapper instance.
    ///
    /// Issue #3805: for a LINKED source the census runs over every compilation
    /// that compiles the file. The census counts PROJECT-REFERENCED types too
    /// (a project reference is a source-bearing compilation reference), so its
    /// answer follows the project's reference graph:
    /// `test/Interpreter.Tests` references the Repl and through it
    /// `GSharp.LanguageServer.Protocol.Diagnostic`, while
    /// `test/Core.Tests` and `tools/cs2gs/Cs2Gs.Tests` — which link
    /// the very same `test/Shared/EmittedOracle.cs` — do not. That made
    /// one lambda parameter print `GSharp.Core.CodeAnalysis.Diagnostic`
    /// in one project and `Diagnostic` in the others, and the repository
    /// mirror (one `.gs` per source file) rejected the divergence.
    private func HasSourceHomonym(named INamedTypeSymbol?, context TranslationContext) bool {
        for compilation in this.LinkedDocumentCompilations(context) {
            if HasHomonym(this.SourceTopLevelSimpleNames(compilation), named, nested: false) {
                return true
            }
        }
        return false
    }

    private func HasSourceNestedHomonym(named INamedTypeSymbol, context TranslationContext) bool {
        for compilation in this.LinkedDocumentCompilations(context) {
            if HasHomonym(this.SourceNestedSimpleNames(compilation), named, nested: true) {
                return true
            }
        }
        return false
    }

    /// Issue #3805: [`compilation`](paramref)'s top-level source-declared
    /// type names, cached per compilation on this mapper (a linked source asks
    /// once per linking project, an ordinary file only once).
    /// @param compilation The compilation to census.
    /// @returns Simple name to the full names declared under it.
    private func SourceTopLevelSimpleNames(compilation CSharpCompilation) IReadOnlyDictionary[string, HashSet[string]] {
        this.sourceTopLevelSimpleNames ??= Dictionary[CSharpCompilation, Dictionary[string, HashSet[string]]]()
        if !this.sourceTopLevelSimpleNames!!.TryGetValue(compilation, out var census) {
            census = BuildSourceSimpleNames(compilation, nested: false)
            this.sourceTopLevelSimpleNames!![compilation] = census
        }
        return census
    }

    /// Issue #3805: [`compilation`](paramref)'s NESTED source-declared
    /// type names, the nested-declaration counterpart of
    /// (cref:SourceTopLevelSimpleNames).
    /// @param compilation The compilation to census.
    /// @returns Simple name to the full names declared under it.
    private func SourceNestedSimpleNames(compilation CSharpCompilation) IReadOnlyDictionary[string, HashSet[string]] {
        this.sourceNestedSimpleNames ??= Dictionary[CSharpCompilation, Dictionary[string, HashSet[string]]]()
        if !this.sourceNestedSimpleNames!!.TryGetValue(compilation, out var census) {
            census = BuildSourceSimpleNames(compilation, nested: true)
            this.sourceNestedSimpleNames!![compilation] = census
        }
        return census
    }

    private func HasVisibleSourceNestedHomonym(
        named INamedTypeSymbol?,
        context TranslationContext,
        location Location?
    ) bool {
        if location?.SourceTree == nil {
            return false
        }
        let position = Math.Min(location!!.SourceSpan.Start, location!!.SourceTree!!.GetRoot().FullSpan.End - 1)
        // Issue #3805: for a LINKED source, ask every linking project's
        // semantic model — the same lexical position, its own parse of the
        // file — so the answer does not depend on which project is being
        // translated. A location in some OTHER file is only the current
        // compilation's business.
        for semanticModel in this.LinkedDocumentModels(context, location!!.SourceTree) {
            for symbol in semanticModel.LookupNamespacesAndTypes(position, name: named!!.Name) {
                if symbol is INamedTypeSymbol candidate &&
                    candidate.Arity == named!!.Arity &&
                    candidate.ContainingType != nil &&
                    candidate
                    .Locations
                    .Any((candidateLocation Location) -> candidateLocation.IsInSource) &&
                    candidate
                    .OriginalDefinition
                    .ToDisplayString() != named!!.OriginalDefinition.ToDisplayString() {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #2222: whether a DIFFERENT top-level type sharing [`named`](paramref)'s simple name is
    /// reachable through one of the current
    /// file's imported namespaces (its `using` directives plus its own
    /// declared namespace). Unlike (cref:HasSourceHomonym)'s
    /// compilation-wide source-only census, this walks only the namespaces
    /// this file actually imports — cheap even when a referenced assembly
    /// (e.g. a translated sibling project) is huge — and covers a homonym
    /// declared in metadata rather than source. Issue #2509 extends this to a
    /// metadata type colliding with a different metadata type; symbols in the
    /// same namespace/package are not import collisions.
    private func HasImportedNamespaceHomonym(named INamedTypeSymbol?, context TranslationContext) bool {
        for namespaceName in this.GetImportedNamespaceNames(context)!! {
            // Issue #3805: for a LINKED source this scans every compilation
            // that compiles the file, not just the one being translated. The
            // mirror writes ONE .gs per source file, so the spelling chosen
            // here has to bind in every project that links it — and a rival
            // same-named type may sit in the reference set of only some of
            // them (`GSharp.LanguageServer.Protocol.Diagnostic` is visible to
            // test/Interpreter.Tests, which references the Repl, but not to
            // test/Compiler.Tests, which does not). Answering per-project made
            // test/Shared/EmittedOracle.cs translate two different ways and
            // fail the linked-source cross-check; answering over the union is
            // order-independent and safe in all of them.
            for compilation in this.LinkedDocumentCompilations(context) {
                if this.HasImportedNamespaceHomonym(named, compilation, namespaceName) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #3805: the single-compilation half of (cref:HasImportedNamespaceHomonym(INamedTypeSymbol,
    /// TranslationContext))
    /// — whether [`compilation`](paramref) declares a DIFFERENT type of
    /// [`named`](paramref)'s simple name in [`namespaceName`](paramref).
    /// @param named The type whose bare name is being considered.
    /// @param compilation The compilation to resolve the namespace in.
    /// @param namespaceName An imported namespace name.
    /// @returns `true` when a rival type of the same name and arity lives there.
    private func HasImportedNamespaceHomonym(
        named INamedTypeSymbol?,
        compilation CSharpCompilation,
        namespaceName string
    ) bool {
        let candidateNamespace INamespaceSymbol? = ResolveNamespace(compilation, namespaceName)
        if candidateNamespace == nil {
            return false
        }
        // `named` may be a CONSTRUCTED generic (e.g. `Box<Label>`), while
        // `GetTypeMembers` always yields the unbound generic definition
        // (`Box<T>`). Comparing them directly makes every reference to a
        // constructed generic type look like a homonym of itself — compare
        // original definitions so `Box<Label>` correctly matches `Box<T>`.
        // Symbol identity only answers WITHIN one compilation; across the
        // linked-document set the namespace comparison below carries that
        // weight (the same type reached from two compilations has the same
        // containing namespace).
        for candidate in candidateNamespace.GetTypeMembers(named!!.Name) {
            if SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, named!!.OriginalDefinition) {
                continue
            }
            // Issue #3554 follow-up: an arity-differing pair
            // (System.Collections.IEnumerator vs
            // System.Collections.Generic.IEnumerator<T>) is not a G#
            // ambiguity — gsc disambiguates a bare name by its type-argument
            // count, exactly like the same-namespace
            // IComparable/IComparable<T> case filtered below.
            if candidate.Arity != named!!.Arity {
                continue
            }
            // Types in the same namespace/package are not an import
            // collision. This also filters facade/implementation symbols
            // for the same forwarded metadata type, and same-namespace
            // generic-arity overloads such as IComparable/IComparable<T>
            // that the type arguments already disambiguate.
            if candidate.ContainingNamespace?.ToDisplayString() == named!!.ContainingNamespace?.ToDisplayString() {
                continue
            }
            return true
        }
        return false
    }

    /// Issue #2222: the namespace names in scope for the file backing
    /// (cref:TranslationContext.SemanticModel) — every `using` directive
    /// (skipping aliased/`using static` ones, which do not bring a type's bare
    /// simple name into scope the same way), the file's own declared
    /// namespace, AND the namespace of every top-level type referenced
    /// anywhere in the file, even one reached only via full qualification
    /// with no matching `using`.
    ///
    /// That last part fixes an ordering blindspot: (cref:TrackShortenedNamespace) records EVERY
    /// top-level-type
    /// reference's namespace (not just qualified ones), and
    /// `CSharpToGSharpTranslator.Translate` synthesizes a matching
    /// `import` for any such namespace not already covered by an explicit
    /// `using`, once the WHOLE file has been visited. So a namespace reached
    /// only via full qualification (e.g. `new Oahu.Audible.Json.ChapterInfo()`
    /// with no `using Oahu.Audible.Json;`) still ends up in scope in the final
    /// G# output. But references are qualified in a single forward pass — an
    /// EARLIER reference (e.g. bare `book.ChapterInfo`) cannot see that a
    /// LATER reference's namespace will land in scope this way, so it would
    /// wrongly stay bare and become ambiguous. Pre-scanning the whole file's
    /// type references up front (this method) makes the ambiguity check see
    /// the same namespace set the file will actually end up importing,
    /// regardless of visit order.
    ///
    /// Issue #3725 closes the other half of that blindspot: a lambda parameter
    /// has NO name node at all in C#, yet cs2gs manufactures one, so its
    /// inferred type's namespaces are collected from the symbol instead of the
    /// syntax.
    ///
    /// Cached per mapper instance: one mapper translates one file, so the
    /// import set never changes across calls.
    private func GetImportedNamespaceNames(context TranslationContext) HashSet[string]? {
        if this.importedNamespaceNames != nil {
            return this.importedNamespaceNames!!
        }
        // Issue #3805: a LINKED source is bound once per linking project, and
        // an inferred type (a lambda parameter, `var`) can name a namespace in
        // one project's binding that another project never sees. The import
        // set is therefore the UNION over the linking projects, so the
        // ambiguity answer — and the emitted spelling — is the same in all of
        // them.
        let names = HashSet[string]()
        for model in this.LinkedDocumentModels(context) {
            CollectImportedNamespaceNames(model, names)
        }
        this.importedNamespaceNames = names
        return names
    }

    /// Issue #3805: one semantic model of the file being translated per
    /// repository compilation that COMPILES it — normally just the context's
    /// own, but a LINKED source (`test/Shared/*.cs`, compiled into
    /// several projects) yields one per linking project.
    ///
    /// The repository mirror writes ONE `.gs` per source file and
    /// cross-checks that every project translates a linked file identically,
    /// so any decision that can differ between those projects has to be
    /// answered over the WHOLE set, converged and order-independent — the same
    /// rule the shared-document nullability taint already follows (issue
    /// #3501). Trees are matched by file path because each compilation parses
    /// the linked file into its own (cref:SyntaxTree) instance.
    /// @param context The translation context.
    /// @returns The semantic models, the context's own first.
    private func LinkedDocumentModels(context TranslationContext) IReadOnlyList[
        Microsoft.CodeAnalysis.SemanticModel
    ] -> this.LinkedDocumentModels(context, context.SemanticModel.SyntaxTree)

    /// Issue #3805: (cref:LinkedDocumentModels(TranslationContext)) for
    /// a specific tree — a type reference's location is not always in the
    /// document the context currently points at.
    /// @param context The translation context.
    /// @param tree The tree to find linking projects for.
    /// @returns The semantic models, this compilation's own first.
    private func LinkedDocumentModels(
        context TranslationContext,
        tree Microsoft.CodeAnalysis.SyntaxTree?
    ) IReadOnlyList[Microsoft.CodeAnalysis.SemanticModel] {
        this.linkedDocumentModels ??= Dictionary[
            Microsoft.CodeAnalysis.SyntaxTree,
            IReadOnlyList[Microsoft.CodeAnalysis.SemanticModel]
        ]()
        if this.linkedDocumentModels!!.TryGetValue(tree!!, out var cached) {
            return cached
        }
        let models = List[Microsoft.CodeAnalysis.SemanticModel]{
            if object.ReferenceEquals(context.SemanticModel.SyntaxTree, tree) {
                context.SemanticModel
            } else {
                context.Compilation.GetSemanticModel(tree!!)
            }
        }
        let path = tree!!.FilePath
        if !string.IsNullOrEmpty(path) &&
            context.RepositoryCompilations is {Count: > 1} repository &&
            LinkedDocumentIndex(repository).TryGetValue(path, out var linking) {
            // The same path is not automatically the same FILE: a project can
            // feed a generated document, or a differently-preprocessed parse,
            // through a path another project also uses. Only an identical
            // parse is the same linked source, and only identical text keeps
            // the position-based lookups below meaningful across compilations.
            let text = tree!!.GetText()
            for (compilation, linkedTree) in linking {
                if !object.ReferenceEquals(linkedTree, tree) && !object.ReferenceEquals(
                    compilation,
                    context.Compilation
                ) &&
                    linkedTree
                    .GetText().ContentEquals(text) {
                    models.Add(compilation.GetSemanticModel(linkedTree))
                }
            }
        }
        this.linkedDocumentModels!![tree!!] = models
        return models
    }

    /// Issue #3805: the compilations behind (cref:LinkedDocumentModels(TranslationContext)).
    /// @param context The translation context.
    /// @returns The compilations that compile the file being translated.
    private func LinkedDocumentCompilations(context TranslationContext) IEnumerable[CSharpCompilation] -> this
        .LinkedDocumentModels(context).Select(
        (model Microsoft.CodeAnalysis.SemanticModel) -> cast[CSharpCompilation](model.Compilation)
    )

    /// Issue #3841: whether [`named`](paramref) is a delegate type whose
    /// IDENTITY is load-bearing somewhere in the compilation being translated,
    /// i.e. it appears in a parameter position of an overload set that would
    /// otherwise erase to one G# signature (`Add(Predicate<T>)` /
    /// `Add(Func<T, bool>)`). Such a delegate keeps its nominal name
    /// in EVERY type position within that compilation.
    ///
    /// The set is keyed on the CONSTRUCTED type, not the definition: a
    /// compilation with a colliding `Func<int, bool>` overload keeps
    /// `Func[int32, bool]` nominal, while every other `Func`
    /// instantiation in that same compilation still renders in ADR-0115 §B.8
    /// arrow form. That is what keeps this from being a corpus-wide
    /// readability regression.
    ///
    /// The whole compilation is in scope (not just the colliding declarations)
    /// because the identity has to survive on the VALUE side too. Fixing only
    /// the declarations turns "does not compile (GS0264)" into "compiles and
    /// reaches the wrong overload": a local written
    /// `Predicate<int> p = Always;` that erased to
    /// `(int32) -> bool` makes gsc pick the `Func` member for both
    /// calls — verified by the executing regression test.
    /// @param named The candidate delegate type.
    /// @param context The translation context that owns the compilation.
    /// @returns `true` when the delegate's identity is load-bearing.
    private func IsIdentityCriticalDelegate(named INamedTypeSymbol, context TranslationContext?) bool {
        if context?.Compilation == nil {
            return false
        }
        if !object.ReferenceEquals(this.identityCriticalDelegatesCompilation, context!!.Compilation) {
            this.identityCriticalDelegatesCompilation = context!!.Compilation
            this.identityCriticalDelegates = CollectIdentityCriticalDelegates(context!!.Compilation)
        }
        return this.identityCriticalDelegates.Contains(named)
    }

    private func MapDelegate(invoke IMethodSymbol?, context TranslationContext, location Location?) ArrowTypeReference {
        let parameters = invoke!!
            .Parameters
            .Select((p IParameterSymbol) -> this.Map(p.Type, context, location)!!)
            .ToList()
        let declaredReturnType = invoke!!.ReturnType
        var returnType ITypeSymbol? = declaredReturnType
        var isAsync = false
        // A delegate returning Task / Task<T> maps to the async arrow form
        // (ADR-0115 §B.8): async () -> void / async () -> T.
        if returnType is INamedTypeSymbol returnNamed &&
            returnNamed.Name == "Task" &&
            returnNamed
            .ContainingNamespace
            ?.ToDisplayString() == "System.Threading.Tasks" {
            isAsync = true
            returnType = if returnNamed.IsGenericType {
                returnNamed.TypeArguments[0]
            } else {
                default(ITypeSymbol?)
            }
        }
        let returns = List[GTypeReference]()
        if returnType != nil && returnType.SpecialType != SpecialType.System_Void {
            var mappedReturn GTypeReference? = this.Map(returnType, context, location)
            // Issue #2504: every structural projection of a source named
            // delegate must consume the same Invoke-return taint as the named
            // declaration itself. Task<T> arrows expose the unwrapped T result;
            // ValueTask<T> remains an explicit envelope in the existing mapper,
            // so promote its inner result in place.
            if declaredReturnType is INamedTypeSymbol{IsGenericType: true, TypeArguments: {Length: 1}} taskLike &&
                taskLike.Name == "ValueTask" &&
                taskLike
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" &&
                mappedReturn is NamedTypeReference{TypeArguments: {Count: 1}} valueTaskMapped {
                let promotedInner GTypeReference? = this.PromoteDelegateReturnPosition(
                    valueTaskMapped.TypeArguments[0],
                    taskLike.TypeArguments[0],
                    invoke,
                    context,
                    List[int32]()
                )
                mappedReturn = if object.ReferenceEquals(promotedInner, valueTaskMapped.TypeArguments[0]) {
                    mappedReturn
                } else {
                    cast[GTypeReference](NamedTypeReference(valueTaskMapped.Name, []GTypeReference{promotedInner!!}))
                }
            } else {
                mappedReturn = this.PromoteDelegateReturnPosition(
                    mappedReturn,
                    returnType,
                    invoke,
                    context,
                    List[int32]()
                )
            }
            returns.Add(mappedReturn!!)
        }
        return ArrowTypeReference(parameters, returns, isAsync)
    }

    private func PromoteDelegateReturnPosition(
        mapped GTypeReference?,
        returnType ITypeSymbol,
        invoke IMethodSymbol?,
        context TranslationContext,
        tuplePath List[int32]
    ) GTypeReference? {
        if mapped is TupleTypeReference mappedTuple &&
            returnType is INamedTypeSymbol{IsTupleType: true} tupleType &&
            mappedTuple
            .ElementTypes
            .Count == tupleType
            .TupleElements
            .Length {
            var changed = false
            let elements = List[GTypeReference](mappedTuple.ElementTypes.Count)
            for var index = 0; index < mappedTuple.ElementTypes.Count; index++ {
                tuplePath.Add(index)
                let element GTypeReference? = this.PromoteDelegateReturnPosition(
                    mappedTuple.ElementTypes[index],
                    tupleType.TupleElements[index].Type,
                    invoke,
                    context,
                    tuplePath
                )
                tuplePath.RemoveAt(tuplePath.Count - 1)
                changed |= !object.ReferenceEquals(element, mappedTuple.ElementTypes[index])
                elements.Add(element!!)
            }
            return if changed {
                cast[GTypeReference](
                    TupleTypeReference(elements, mappedTuple.ElementNames){IsNullable = mappedTuple.IsNullable}
                )
            } else {
                mapped
            }
        }
        let tainted = if tuplePath.Count == 0 {
            ObliviousNullabilityAnalyzer.IsTainted(context.Compilation, invoke, context.SiblingCompilations)
        } else {
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                context.Compilation,
                invoke,
                tuplePath,
                context.SiblingCompilations
            )
        }
        return if tainted &&
            !mapped!!.IsNullable &&
            (returnType != nil && returnType.IsReferenceType == true) &&
            returnType.NullableAnnotation != Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated {
            WithNullable(mapped, true)
        } else {
            mapped
        }
    }

    private func MergeAnonymousShapeContracts(
        properties IReadOnlyList[IPropertySymbol],
        mappedPropertyTypes IReadOnlyList[GTypeReference]?,
        context TranslationContext
    ) IReadOnlyList[GTypeReference] {
        let shapeKey = AnonymousShapeKey(properties)
        if this.anonymousShapeContracts.TryGetValue(shapeKey, out var existing) {
            return existing
        }
        let merged = properties.Select(
            (property IPropertySymbol, index int32) -> NormalizeAnonymousProjectedStorage(
                property.Type,
                mappedPropertyTypes!![index]
            )
        )
            .ToList()
        let evidenceIndex = AnonymousShapeEvidenceIndexes.GetValue(
            context.Compilation,
            BuildAnonymousShapeEvidenceIndex
        )
        if evidenceIndex.TryGetValue(shapeKey, out var evidence) {
            for (propertyTypes, acceptsNil) in evidence {
                for var index = 0; index < merged.Count; index++ {
                    merged[index] = MergeAnonymousNullability(merged[index], propertyTypes[index])
                    if (acceptsNil[index]) {
                        merged[index] = WithNullable(merged[index], true)!!
                    }
                }
            }
        }
        this.anonymousShapeContracts[shapeKey] = merged
        return merged
    }

    /// Issue #3501: when the source file declares a `using Alias = Type;` for
    /// the exact NON-GENERIC top-level type being rendered, reuse that alias
    /// instead of shortening to the bare name — the bare rendering forces a
    /// synthesized whole-namespace import that can make OTHER simple names
    /// ambiguous across imports (EmittedNameAllocator's synthesized
    /// `import GSharp.Core.CodeAnalysis.Syntax` made Roslyn's
    /// `AssignmentExpressionSyntax`/`SyntaxKind` resolve to the wrong package,
    /// surfacing as GS0532 on the now-impossible patterns). Reuses the same
    /// uniqueness and shadowing gates as (cref:GetOrCreateImportedTypeAlias(INamedTypeSymbol,
    /// TranslationContext, Location))
    /// (#3466), and generic targets are excluded so constructed spellings keep
    /// their explicit type arguments (#2500).
    /// @param named The referenced top-level type.
    /// @param context The active translation context.
    /// @param location The reference location (shadowing probes).
    /// @param aliasName The reusable alias identifier, when one applies.
    /// @returns `true` when a source alias can be reused.
    private func TryReuseSourceUsingAlias(
        named INamedTypeSymbol,
        context TranslationContext,
        location Location?,
        out aliasName string?
    ) bool {
        aliasName = nil
        // Constraint mapping (issue #2509, WithMetadataImportCollisionQualification)
        // demands the EXACT qualified semantic identity — a homonym-safe
        // `A.IContract` — never an alias spelling, so alias reuse is skipped
        // there.
        if named.Arity != 0 || this.reservedTypeAliases.Count == 0 || this.qualifyMetadataImportCollisions {
            return false
        }
        let simpleName string? = this.Names(context).GetName(named)
        let namespaceName string? = if named.ContainingNamespace is {IsGlobalNamespace: false} ns {
            this.Names(context).GetNamespaceName(ns)
        } else {
            default(string?)
        }
        let target string? = if namespaceName != nil {
            "$namespaceName.$simpleName"
        } else {
            simpleName
        }
        let candidate string? = this.GetOrCreateImportedTypeAlias(named, context, location, reuseOnly: true, target)
        if candidate == nil {
            return false
        }
        aliasName = candidate
        return true
    }

    shared {
        /// The parseable placeholder type name emitted when a C# type has no
        /// canonical G# form. `object` is the universal upper bound (spec
        /// §Object) so the emitted file always re-parses; the real gap is carried by
        /// the accompanying (cref:TranslationSeverity.Unsupported) diagnostic.
        const UnsupportedPlaceholderType string = "object"

        /// Public top-level type names exposed by every namespace analyzer-mode
        /// rewrites may synthesize, cached from the G# core assembly.
        private let AnalyzerTargetTypeNames Lazy[IReadOnlyDictionary[string, List[string]]] = Lazy[
            IReadOnlyDictionary[string, List[string]]
        ](BuildAnalyzerTargetTypeNames)

        /// Issue #3805: the linked-source index (see (cref:LinkedDocumentIndex))
        /// per repository compilation set, cached weakly so it is built once per
        /// migration run instead of once per translated document.
        private let LinkedDocumentIndexes ConditionalWeakTable[
            object,
            Dictionary[string, List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]]
        ] = ConditionalWeakTable[
            object,
            Dictionary[string, List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]]
        ]()

        private let AnonymousShapeEvidenceIndexes ConditionalWeakTable[
            Compilation,
            Dictionary[string, List[(PropertyTypes[]ITypeSymbol, AcceptsNil[]bool)]]
        ] = ConditionalWeakTable[
            Compilation,
            Dictionary[string, List[(PropertyTypes[]ITypeSymbol, AcceptsNil[]bool)]]
        ]()

        /// The G# spelling of a C# predefined type keyword (ADR-0115 §B.12's
        /// width-bearing primitive names), or `null` when the
        /// special type has no predefined G# name.
        ///
        /// Exposed for issue #3797: the analyzer-snippet marker re-placer needs to
        /// know the ONE lexical rename translation applies inside expression text,
        /// so a `[|typeof(int) != type|]` marker can still be placed on the
        /// translated `typeof(int32) != type` instead of being dropped.
        /// @param specialType The C# special type.
        /// @returns The G# predefined name, or `null`.
        func GetPredefinedName(specialType SpecialType) string? -> MapPredefinedName(specialType)

        /// ADR-0187 §6: whether [`type`](paramref) is a compiler-recognized
        /// `Gsharp.Runtime.Values` type (one of [`names`](paramref)) seen
        /// through its native CONSUMER view.
        /// @remarks The native `slice[T]` / `managed T` spellings are views of the
        /// runtime assembly's metadata. The compilation that DECLARES those structs
        /// is implementing the nominal CLR types themselves, so inside it every
        /// reference — constructors, interfaces, operators, nested types and
        /// self-references — keeps its nominal spelling. Provenance comes from the
        /// Roslyn symbol, not from a project path or assembly-name mode.
        /// @param type The C# type symbol to classify.
        /// @param compilation The compilation being translated.
        /// @param names The recognized generic type names to match.
        /// @returns `true` when [`type`](paramref) should use its native G# spelling.
        internal func IsRecognizedRuntimeConsumerType(
            type ITypeSymbol?,
            compilation Compilation,
            names ...string
        ) bool -> IsRecognizedRuntimeType(type, names) &&
            !SymbolEqualityComparer
            .Default
            .Equals(type!!.OriginalDefinition.ContainingAssembly, compilation.Assembly)

        internal func IsRecognizedManagedReferenceConsumerType(
            type ITypeSymbol?,
            compilation Compilation
        ) bool -> IsRecognizedRuntimeConsumerType(type, compilation, "ManagedRef", "ReadOnlyManagedRef")

        /// ADR-0187 §6: whether [`type`](paramref) has the assembly, namespace
        /// and generic name of a compiler-recognized `Gsharp.Runtime.Values`
        /// type, regardless of which compilation declares it.
        /// @param type The C# type symbol to classify.
        /// @param names The recognized generic type names to match.
        /// @returns `true` when [`type`](paramref) has a recognized runtime identity.
        internal func IsRecognizedRuntimeType(type ITypeSymbol?, names ...string) bool -> type is INamedTypeSymbol{
            Arity: 1
        } named &&
            named
            .ContainingAssembly
            ?.Name == "Gsharp.Runtime.Values" &&
            named
            .ContainingNamespace
            .ToDisplayString() == "Gsharp.Values" && Array.IndexOf(names, named.Name) >= 0

        /// Issue #1894: whether [`type`](paramref) is the BCL `System.Index`
        /// or `System.Range` struct. ADR-0187 maps both as ordinary imported
        /// types; this only distinguishes a range bound's compiler-inserted
        /// Index conversion from its natural type.
        /// @param type The C# type symbol to check.
        /// @returns `true` when [`type`](paramref) is `System.Index` or `System.Range`.
        internal func IsSystemIndexOrRange(type ITypeSymbol?) bool -> type is INamedTypeSymbol{
            ContainingNamespace: {Name: "System", ContainingNamespace: {IsGlobalNamespace: true}}
        } named &&
            (named.Name == "Index" || named.Name == "Range")

        /// Whether a source delegate is emitted with a lifted top-level name.
        /// @param named The candidate type.
        /// @returns Whether the delegate's nominal containing chain is flattened.
        internal func IsLiftedNestedDelegate(named INamedTypeSymbol?) bool -> named != nil &&
            named.TypeKind == TypeKind.Delegate &&
            named.ContainingType != nil &&
            IsSourceDeclaredDelegate(named)

        /// Issue #2222: strips a leading `global::` alias-qualifier from a
        /// dotted namespace/type name (e.g. `using global::Foo.Bar;` yields
        /// `directive.Name.ToString()` == `"global::Foo.Bar"`).
        /// Splitting that text by `.` without stripping the prefix first
        /// silently fails to match any real namespace segment. Shared with
        /// (cref:CSharpToGSharpTranslator.TranslateImports) so the
        /// synthesized `import` list and the homonym scan agree on the same
        /// name.
        /// @param name The dotted namespace/type name text, possibly `global::`-prefixed.
        /// @returns [`name`](paramref) with any leading `global::` removed.
        internal func StripGlobalPrefix(name string) string -> if name.StartsWith(
            "global::",
            StringComparison.Ordinal
        ) {
            name.Substring("global::".Length)
        } else {
            name
        }

        private func GetExtensionMethodNamespace(method IMethodSymbol?) INamespaceSymbol? {
            if method == nil {
                return nil
            }
            // Reduced instance-form calls (key.All(predicate)) resolve to a
            // reduced symbol; unwrap it back to the original static-form method
            // so ContainingNamespace reflects the extension's declaring type.
            let original IMethodSymbol? = method.ReducedFrom ?? method
            if !original!!.IsExtensionMethod {
                return nil
            }
            // C# 14 extension blocks compile their members onto a synthetic
            // marker type nested inside the containing type; unwrap to the
            // enclosing (real, declared) type so the namespace we record is the
            // one the user would actually need to import.
            var containingType INamedTypeSymbol? = original!!.ContainingType
            if containingType != nil &&
                containingType.IsExtension == true &&
                containingType.ContainingType is {} declaringType {
                containingType = declaringType
            }
            return if containingType?.ContainingNamespace is {IsGlobalNamespace: false} ns {
                ns
            } else {
                default(INamespaceSymbol?)
            }
        }

        private func BuildAnalyzerTargetTypeNames() IReadOnlyDictionary[string, List[string]] {
            let targetNamespaces = HashSet[string](
                RoslynAnalyzerApiMap.EnumerateTargetNamespaces(),
                StringComparer.Ordinal
            )
            let result = targetNamespaces.ToDictionary(
                func (targetNamespace string) string {
                    return targetNamespace
                },
                (_ string) -> List[string](),
                StringComparer.Ordinal
            )
            for type in typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.GetTypes() {
                if type.IsNested || !type.IsPublic || type.Namespace is not{} typeNamespace || !result.TryGetValue(
                    typeNamespace,
                    out var names
                ) {
                    continue
                }
                let metadataName = type.Name
                let arityMarker = metadataName.IndexOf('`')
                let simpleName = if arityMarker >= 0 {
                    metadataName.Substring(0, arityMarker)
                } else {
                    metadataName
                }
                names.Add(
                    GSharp
                        .Core
                        .CodeAnalysis
                        .Syntax
                        .SyntaxFacts
                        .GetEmittedIdentifier(simpleName, IdentifierNameContext.Type)
                )
            }
            return result
        }

        /// Resolves the single well-known unmanaged calling convention named in a
        /// generic `delegate* unmanaged[Name]<...>` modopt list (issue
        /// #1906), or `null` when the list is empty (bare
        /// `unmanaged`) or names anything other than exactly one of
        /// Cdecl/Stdcall/Thiscall/Fastcall.
        /// @param unmanagedCallingConventionTypes The modopt types Roslyn resolved from the `[...]` list.
        /// @returns The matching (cref:CallingConvention), or `null` when none applies.
        private func MapSingleUnmanagedConvention(
            unmanagedCallingConventionTypes ImmutableArray[INamedTypeSymbol]
        ) CallingConvention? {
            if unmanagedCallingConventionTypes.Length != 1 {
                return nil
            }
            return switch unmanagedCallingConventionTypes[0].Name {
                case "CallConvCdecl": CallingConvention.Cdecl
                case "CallConvStdcall": CallingConvention.StdCall
                case "CallConvThiscall": CallingConvention.ThisCall
                case "CallConvFastcall": CallingConvention.FastCall
                default: nil
            }
        }

        @return: System.Diagnostics.CodeAnalysis.NotNullIfNotNull("reference")
        private func WithNullable(reference GTypeReference?, isNullable bool) GTypeReference? {
            switch reference {
                case slice is NativeSliceTypeReference {
                    return NativeSliceTypeReference(slice.ElementType, slice.IsReadOnly){IsNullable = isNullable}
                }
                case referenceType is ManagedReferenceTypeReference {
                    return ManagedReferenceTypeReference(referenceType.ElementType, referenceType.IsReadOnly){
                        IsNullable = isNullable
                    }
                }
                case named is NamedTypeReference {
                    return NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType){
                        IsNullable = isNullable
                    }
                }
                case array is ArrayTypeReference {
                    return ArrayTypeReference(array.ElementType, array.Rank){IsNullable = isNullable}
                }
                case pointer is PointerTypeReference {
                    return PointerTypeReference(pointer.ElementType){IsNullable = isNullable}
                }
                case tuple is TupleTypeReference {
                    return TupleTypeReference(tuple.ElementTypes, tuple.ElementNames){IsNullable = isNullable}
                }
                case arrow is ArrowTypeReference {
                    return ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync){
                        IsNullable = isNullable
                    }
                }
                default {
                    return reference
                }
            }
        }

        private func MapPredefinedName(specialType SpecialType) string? {
            switch specialType {
                case SpecialType.System_Boolean {
                    return "bool"
                }
                case SpecialType.System_Char {
                    return "char"
                }
                case SpecialType.System_SByte {
                    return "int8"
                }
                case SpecialType.System_Byte {
                    return "uint8"
                }
                case SpecialType.System_Int16 {
                    return "int16"
                }
                case SpecialType.System_UInt16 {
                    return "uint16"
                }
                case SpecialType.System_Int32 {
                    return "int32"
                }
                case SpecialType.System_UInt32 {
                    return "uint32"
                }
                case SpecialType.System_Int64 {
                    return "int64"
                }
                case SpecialType.System_UInt64 {
                    return "uint64"
                }
                case SpecialType.System_IntPtr {
                    return "nint"
                }
                case SpecialType.System_UIntPtr {
                    return "nuint"
                }
                case SpecialType.System_Single {
                    return "float32"
                }
                case SpecialType.System_Double {
                    return "float64"
                }
                case SpecialType.System_Decimal {
                    return "decimal"
                }
                case SpecialType.System_String {
                    return "string"
                }
                case SpecialType.System_Object {
                    return "object"
                }
                default {
                    return nil
                }
            }
        }

        private func CreateMappedArrayType(
            array IArrayTypeSymbol,
            element GTypeReference?,
            context TranslationContext,
            location Location?,
            isNullable bool
        ) ArrayTypeReference {
            var element = element
            element = ProjectDefaultInitializedManagedReferenceLeaves(array.ElementType, element, context, location)
            return ArrayTypeReference(element, array.Rank){IsNullable = isNullable}
        }

        private func ProjectDefaultInitializedManagedReferenceLeaves(
            type ITypeSymbol,
            mapped GTypeReference?,
            context TranslationContext,
            location Location?
        ) GTypeReference? {
            if IsRecognizedManagedReferenceConsumerType(type, context.Compilation) {
                return WithNullable(mapped, true)
            }
            if type is IArrayTypeSymbol nested {
                return if ContainsManagedReferenceStorage(
                    nested.ElementType,
                    context.Compilation,
                    HashSet[ITypeSymbol](SymbolEqualityComparer.Default)
                ) {
                    WithNullable(mapped, true)
                } else {
                    mapped
                }
            }
            if type is INamedTypeSymbol{IsTupleType: true} tuple &&
                mapped is TupleTypeReference mappedTuple &&
                tuple
                .TupleElements
                .Length == mappedTuple
                .ElementTypes
                .Count {
                var changed = false
                let elements = List[GTypeReference](mappedTuple.ElementTypes.Count)
                for var i = 0; i < mappedTuple.ElementTypes.Count; i++ {
                    let projected GTypeReference? = ProjectDefaultInitializedManagedReferenceLeaves(
                        tuple.TupleElements[i].Type,
                        mappedTuple.ElementTypes[i],
                        context,
                        location
                    )
                    changed |= !object.ReferenceEquals(projected, mappedTuple.ElementTypes[i])
                    elements.Add(projected!!)
                }
                return if changed {
                    cast[GTypeReference](
                        TupleTypeReference(elements, mappedTuple.ElementNames){IsNullable = mappedTuple.IsNullable}
                    )
                } else {
                    mapped
                }
            }
            if type is INamedTypeSymbol named &&
                named.IsValueType &&
                named
                .OriginalDefinition
                .SpecialType != SpecialType.System_Nullable_T &&
                ContainsManagedReferenceStorage(
                named,
                context.Compilation,
                HashSet[ITypeSymbol](SymbolEqualityComparer.Default)
            ) {
                context.Report(
                    TranslationDiagnostic(
                        "ArrayElementType",
                        "default-initialized array element type '${type.ToDisplayString()}' contains managed-reference storage outside a tuple; its nullable leaves have no exact G# type mapping.",
                        location,
                        TranslationSeverity.Unsupported
                    )
                )
            }
            return mapped
        }

        private func ContainsManagedReferenceStorage(
            type ITypeSymbol?,
            compilation Compilation,
            visited HashSet[ITypeSymbol]
        ) bool {
            if type == nil || !visited.Add(type) || type.TypeKind == TypeKind.Error {
                return false
            }
            if IsRecognizedManagedReferenceConsumerType(type, compilation) {
                return true
            }
            if type is IArrayTypeSymbol array {
                return ContainsManagedReferenceStorage(array.ElementType, compilation, visited)
            }
            if type is not INamedTypeSymbol named || !named.IsValueType {
                return false
            }
            if named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T {
                return ContainsManagedReferenceStorage(named.TypeArguments[0], compilation, visited)
            }
            return named
                .GetMembers()
                .OfType[IFieldSymbol]()
                .Any(
                (field IFieldSymbol) -> !field.IsStatic &&
                    ContainsManagedReferenceStorage(field.Type, compilation, visited)
            )
        }

        private func HasGenericContainingType(named INamedTypeSymbol) bool {
            for var containing INamedTypeSymbol? = named.ContainingType;
                containing != nil;
                containing = containing!!.ContainingType {
                if containing.Arity > 0 {
                    return true
                }
            }
            return false
        }

        private func IsDeclaredInContainingNamespace(
            named INamedTypeSymbol,
            context TranslationContext,
            location Location?
        ) bool {
            if location?.SourceTree == nil ||
                named.ContainingNamespace is not{IsGlobalNamespace: false} containingNamespace {
                return false
            }
            let position = Math.Min(location!!.SourceSpan.Start, location!!.SourceTree!!.GetRoot().FullSpan.End - 1)
            let currentNamespace INamespaceSymbol? = context
                .SemanticModel
                .GetEnclosingSymbol(position)
                ?.ContainingNamespace
            return SymbolEqualityComparer.Default.Equals(currentNamespace, containingNamespace)
        }

        private func SupportsMetadataTypeAlias(named INamedTypeSymbol?) bool {
            let namespaceName string? = named!!.ContainingNamespace?.ToDisplayString()
            return namespaceName == "System" || namespaceName?.StartsWith("System.", StringComparison.Ordinal) == true
        }

        /// Issue #2307/#3805: whether [`census`](paramref) holds a
        /// source-declared type of [`named`](paramref)'s simple name that is
        /// not [`named`](paramref) itself. Identity is compared by full name
        /// rather than by counting entries, so the answer is the same whichever
        /// compilation of a linked source asks it (symbols from two compilations
        /// are never reference-equal, and the same type is source-declared in one
        /// project's view and metadata in another's).
        /// @param census One compilation's simple-name census.
        /// @param named The type whose bare name is being considered.
        /// @param nested Whether the census covers nested declarations.
        /// @returns `true` when a distinct same-named declaration exists.
        private func HasHomonym(
            census IReadOnlyDictionary[string, HashSet[string]],
            named INamedTypeSymbol?,
            nested bool
        ) bool {
            if !census.TryGetValue(named!!.Name, out var declarations) {
                return false
            }
            let self string? = if (named!!.ContainingType != nil) == nested {
                named!!.OriginalDefinition.ToDisplayString()
            } else {
                default(string?)
            }
            for declaration in declarations {
                if declaration != self {
                    return true
                }
            }
            return false
        }

        /// Issue #2222: adds the namespace names in scope for [`semanticModel`](paramref)'s file to
        /// [`names`](paramref). Split out of
        /// (cref:GetImportedNamespaceNames) for issue #3805 so a linked
        /// source can union the answer over every project that compiles it.
        /// @param semanticModel One project's semantic model for the file.
        /// @param names The namespace-name set to add to.
        private func CollectImportedNamespaceNames(
            semanticModel Microsoft.CodeAnalysis.SemanticModel,
            names HashSet[string]
        ) {
            if semanticModel.SyntaxTree.GetRoot() is Microsoft.CodeAnalysis.CSharp.Syntax.CompilationUnitSyntax root {
                let usings = root.Usings.Concat(
                    root
                        .DescendantNodes()
                        .OfType[BaseNamespaceDeclarationSyntax]()
                        .SelectMany(
                        func (n BaseNamespaceDeclarationSyntax) IEnumerable[UsingDirectiveSyntax] {
                            return n.Usings
                        }
                    )
                )
                for directive in usings {
                    if directive.Alias != nil || !directive.StaticKeyword.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.None
                    ) ||
                        directive.Name == nil {
                        continue
                    }
                    names.Add(StripGlobalPrefix(directive.Name!!.ToString()))
                }
                for nsDecl in root.DescendantNodes().OfType[BaseNamespaceDeclarationSyntax]() {
                    names.Add(StripGlobalPrefix(nsDecl.Name.ToString()))
                }
                // Pre-scan every name/member-access node for a bound top-level-type
                // symbol, so a namespace reached only via full qualification (no
                // `using`) is already visible to the FIRST reference processed,
                // not just references processed after the synth-import-triggering
                // one (see the ordering note above).
                for node in root.DescendantNodes() {
                    // Issue #3725: a lambda parameter is the one type position cs2gs
                    // MANUFACTURES. C# infers it from the delegate target and writes
                    // no name at all (`d => d.Message`), while the canonical G# arrow
                    // lambda always spells it (ADR-0074), so `MapLambdaParameter`
                    // maps the inferred symbol, `TrackShortenedNamespace` records its
                    // namespace, and `Translate` synthesizes the matching `import` —
                    // all without a single name node for the scan below to find.
                    // Left out of this set, the homonym check cannot see that import:
                    // two same-named types reached ONLY through inferred lambda
                    // parameters both printed bare, and gsc's first-import-wins
                    // resolution silently bound both to whichever landed first
                    // (`GSharp.Core.CodeAnalysis.Diagnostic` shadowing
                    // `GSharp.LanguageServer.Protocol.Diagnostic`, surfacing as
                    // GS0159 on the enclosing generic call, never as an ambiguity).
                    if node is AnonymousFunctionExpressionSyntax lambda {
                        for parameter in EnumerateLambdaParameters(lambda) {
                            if semanticModel.GetDeclaredSymbol(parameter) is IParameterSymbol{Type: {} parameterType} {
                                AddReferencedNamespaces(parameterType, names)
                            }
                        }
                        continue
                    }
                    if !((node is NameSyntax || node is MemberAccessExpressionSyntax)) {
                        continue
                    }
                    if semanticModel.GetSymbolInfo(node).Symbol is not INamedTypeSymbol candidate {
                        continue
                    }
                    var outermost INamedTypeSymbol? = candidate
                    while outermost!!.ContainingType != nil {
                        outermost = outermost!!.ContainingType
                    }
                    if outermost!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
                        names.Add(ns.ToDisplayString())
                    }
                }
            }
        }

        /// Issue #3805: the repository's linked sources — every file path parsed
        /// by MORE THAN ONE repository compilation, with the compilations (and
        /// their own parse of the file) that share it. Ordinary files are absent,
        /// which is what keeps the union lookup free for them.
        ///
        /// Built once per repository compilation set rather than once per
        /// translated document: the index is a whole-run property, and one mapper
        /// exists per file.
        /// @param repository The run's repository compilations.
        /// @returns The linked-source index, keyed by file path.
        private func LinkedDocumentIndex(repository IReadOnlyList[CSharpCompilation]) Dictionary[
            string,
            List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]
        ] -> LinkedDocumentIndexes
            .GetValue(repository, (key object) -> BuildLinkedDocumentIndex(cast[IReadOnlyList[CSharpCompilation]](key)))

        private func BuildLinkedDocumentIndex(repository IReadOnlyList[CSharpCompilation]) Dictionary[
            string,
            List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]
        ] {
            let byPath = Dictionary[
                string,
                List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]
            ](StringComparer.OrdinalIgnoreCase)
            for compilation in repository {
                for tree in compilation.SyntaxTrees {
                    if string.IsNullOrEmpty(tree.FilePath) {
                        continue
                    }
                    if !byPath.TryGetValue(tree.FilePath, out var linking) {
                        linking = List[(CSharpCompilation, Microsoft.CodeAnalysis.SyntaxTree)]()
                        byPath[tree.FilePath] = linking
                    }
                    linking.Add((compilation, tree))
                }
            }
            for path in byPath
                .Where(
                (
                    entry KeyValuePair[
                        string,
                        List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]
                    ]
                ) -> entry
                    .Value
                    .Count < 2
            )
                .Select(
                (
                    entry KeyValuePair[
                        string,
                        List[(Compilation CSharpCompilation, Tree Microsoft.CodeAnalysis.SyntaxTree)]
                    ]
                ) -> entry.Key
            )
                .ToList() {
                byPath.Remove(path)
            }
            return byPath
        }

        /// Issue #3725: the parameters an anonymous function declares, whatever
        /// spelling it uses. A simple lambda (`d => …`) carries one bare
        /// parameter with no list; parenthesized lambdas and anonymous methods
        /// carry a (possibly absent) list.
        /// @param lambda The anonymous function to inspect.
        /// @returns The declared parameter syntax nodes.
        private func EnumerateLambdaParameters(lambda AnonymousFunctionExpressionSyntax) IEnumerable[
            Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax
        ] -> switch lambda {
            case simple is SimpleLambdaExpressionSyntax: cast[
                IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]
            ]([]Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax{simple.Parameter})
            case parenthesized is ParenthesizedLambdaExpressionSyntax: cast[
                IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]
            ](parenthesized.ParameterList.Parameters)
            case anonymousMethod is AnonymousMethodExpressionSyntax when anonymousMethod.ParameterList != nil: anonymousMethod.ParameterList!!.Parameters
            default: cast[IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]](
                Array.Empty[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]()
            )
        }

        /// Issue #3725: records the namespace of every top-level named type
        /// [`type`](paramref) is spelled out of — itself, its enclosing
        /// type chain, its type arguments, and the element type of an array or
        /// pointer. An inferred lambda-parameter type has no name nodes of its
        /// own, so its constituents are unreachable from the syntactic scan and
        /// have to be walked here instead.
        /// @param type The type to walk.
        /// @param names The namespace-name set to add to.
        private func AddReferencedNamespaces(type ITypeSymbol, names HashSet[string]) {
            switch type {
                case array is IArrayTypeSymbol {
                    AddReferencedNamespaces(array.ElementType, names)
                    return
                }
                case pointer is IPointerTypeSymbol {
                    AddReferencedNamespaces(pointer.PointedAtType, names)
                    return
                }
                case named is INamedTypeSymbol {
                    var outermost INamedTypeSymbol? = named
                    while outermost!!.ContainingType != nil {
                        outermost = outermost!!.ContainingType
                    }
                    if outermost!!.ContainingNamespace is {IsGlobalNamespace: false} ns {
                        names.Add(ns.ToDisplayString())
                    }
                    for argument in named.TypeArguments {
                        AddReferencedNamespaces(argument, names)
                    }
                    return
                }
                default {
                    return
                }
            }
        }

        private func ResolveNamespace(compilation Compilation, dottedName string) INamespaceSymbol? {
            var current INamespaceSymbol? = compilation.GlobalNamespace
            for part in StripGlobalPrefix(dottedName).Split('.') {
                current = current!!.GetNamespaceMembers().FirstOrDefault((n INamespaceSymbol) -> n.Name == part)
                if current == nil {
                    return nil
                }
            }
            return current
        }

        private func ResolveEmittedNamespace(
            compilation Compilation,
            dottedName string,
            names EmittedNameAllocator
        ) INamespaceSymbol? {
            var current INamespaceSymbol? = compilation.GlobalNamespace
            for part in StripGlobalPrefix(dottedName).Split('.') {
                current = current!!.GetNamespaceMembers().FirstOrDefault(
                    (candidate INamespaceSymbol) -> names.GetName(candidate) == part
                )
                if current == nil {
                    return nil
                }
            }
            return current
        }

        /// Issue #1174/#3805: [`compilation`](paramref)'s source-declared
        /// type names, simple name to the set of full names declared under it.
        /// Recording full names rather than a count (the pre-#3805 shape) is what
        /// lets a linked source ask the same question of several compilations: a
        /// type is identified by what it IS, not by how many entries a particular
        /// compilation contributed.
        /// @param compilation The compilation to census.
        /// @param nested Census nested declarations instead of top-level ones.
        /// @returns Simple name to the full names declared under it.
        private func BuildSourceSimpleNames(compilation Compilation, nested bool) Dictionary[string, HashSet[string]] {
            let names = Dictionary[string, HashSet[string]]()
            for type in EnumerateAllNamedTypes(compilation.GlobalNamespace) {
                if (type.ContainingType != nil) != nested || !type.Locations.Any(
                    (location Location) -> location.IsInSource
                ) {
                    continue
                }
                if !names.TryGetValue(type.Name, out var declarations) {
                    declarations = HashSet[string](StringComparer.Ordinal)
                    names[type.Name] = declarations
                }
                declarations.Add(type.OriginalDefinition.ToDisplayString())
            }
            return names
        }

        private func BuildSourceDeclaredTypeNames(compilation Compilation, names EmittedNameAllocator) HashSet[
            string
        ] -> EnumerateAllNamedTypes(compilation.GlobalNamespace)
            .Where((type INamedTypeSymbol) -> type.Locations.Any((location Location) -> location.IsInSource))
            .Select((type INamedTypeSymbol) -> names.GetName(type)!!)
            .ToHashSet(StringComparer.Ordinal)

        private func EnumerateAllNamedTypes(ns INamespaceSymbol) sequence[INamedTypeSymbol] {
            for member in ns.GetMembers() {
                if member is INamespaceSymbol childNs {
                    for nested in EnumerateAllNamedTypes(childNs) {
                        yield nested
                    }
                } else if member is INamedTypeSymbol type {
                    for nested in EnumerateNamedTypeAndNested(type) {
                        yield nested
                    }
                }
            }
        }

        private func EnumerateNamedTypeAndNested(type INamedTypeSymbol) sequence[INamedTypeSymbol] {
            yield type
            for nested in type.GetTypeMembers() {
                for deeper in EnumerateNamedTypeAndNested(nested) {
                    yield deeper
                }
            }
        }

        /// Issue #2835: whether [`named`](paramref) is a delegate type declared
        /// in the compilation being translated (as opposed to an imported/BCL
        /// delegate such as `Func`/`Action`). Source delegates are emitted
        /// by cs2gs as real `delegate X(…) ` declarations, so their;
        /// uses must keep the nominal name to preserve CLR delegate identity.
        /// @param named The candidate delegate type.
        /// @returns `true` when the delegate is source-declared.
        private func IsSourceDeclaredDelegate(named INamedTypeSymbol?) bool {
            let definition INamedTypeSymbol? = named!!.OriginalDefinition ?? named
            return definition!!.Locations.Any((l Location) -> l.IsInSource)
        }

        /// Issue #3841: walks every type declared in [`compilation`](paramref)
        /// and collects the delegate types that discriminate an otherwise-colliding
        /// overload set. See (cref:IsIdentityCriticalDelegate).
        /// @param compilation The compilation being translated.
        /// @returns The constructed delegate types whose identity must be preserved.
        private func CollectIdentityCriticalDelegates(compilation Compilation) HashSet[INamedTypeSymbol] {
            let critical = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            let pending = Stack[INamespaceOrTypeSymbol]()
            pending.Push(compilation.Assembly.GlobalNamespace)
            while pending.Count > 0 {
                let current = pending.Pop()
                for member in current.GetMembers() {
                    if (member is INamespaceOrTypeSymbol nested and (INamespaceSymbol or INamedTypeSymbol)) {
                        pending.Push(nested)
                    }
                }
                if current is INamedTypeSymbol type {
                    CollectIdentityCriticalDelegates(type, critical)
                }
            }
            return critical
        }

        /// Issue #3841: adds [`type`](paramref)'s erasure-colliding delegate
        /// parameter types to [`critical`](paramref).
        /// @param type The declared type to inspect.
        /// @param critical The accumulating set.
        private func CollectIdentityCriticalDelegates(type INamedTypeSymbol, critical HashSet[INamedTypeSymbol]) {
            // Only same-name members can be an overload set, so the quadratic
            // comparison below runs per NAME rather than per type — a type with
            // hundreds of distinctly-named members costs nothing here.
            let byName = Dictionary[string, List[IMethodSymbol]](StringComparer.Ordinal)
            for member in type.GetMembers() {
                if member is IMethodSymbol method && method.Parameters.Length > 0 {
                    if !byName.TryGetValue(method.Name, out var bucket) {
                        bucket = List[IMethodSymbol]()
                        byName[method.Name] = bucket
                    }
                    bucket.Add(method)
                }
            }
            for overloads in byName.Values {
                if overloads.Count < 2 {
                    continue
                }
                for var i = 0; i < overloads.Count; i++ {
                    for var j = i + 1; j < overloads.Count; j++ {
                        let left = overloads[i]
                        let right = overloads[j]
                        if left.MethodKind != right.MethodKind ||
                            left.Arity != right.Arity ||
                            left
                            .Parameters
                            .Length != right
                            .Parameters
                            .Length ||
                            !ParametersEraseAlike(left, right) {
                            continue
                        }
                        for var k = 0; k < left.Parameters.Length; k++ {
                            AddIfDistinctDelegates(left.Parameters[k].Type, right.Parameters[k].Type, critical)
                        }
                    }
                }
            }
        }

        /// Issue #3841: records a pair of DISTINCT delegate types that erase to the
        /// same arrow. Positions where the two overloads agree exactly carry no
        /// identity burden and are left alone.
        /// @param left The first overload's parameter type.
        /// @param right The second overload's parameter type.
        /// @param critical The accumulating set.
        private func AddIfDistinctDelegates(left ITypeSymbol, right ITypeSymbol, critical HashSet[INamedTypeSymbol]) {
            // Issue #4127/#4129 (self-hosting regression, #3501): decomposed —
            // not a nested `{ TypeKind: TypeKind.Delegate }` pattern — for the
            // same gsc pattern-matcher reason as <see cref="MapEventType"/>.
            // Verified by regression test to actually detect the collision once
            // this method is itself translated to G# and compiled by gsc.
            if SymbolEqualityComparer.Default.Equals(left, right) ||
                left is not INamedTypeSymbol leftDelegate ||
                leftDelegate.TypeKind != TypeKind.Delegate ||
                right is not INamedTypeSymbol rightDelegate ||
                rightDelegate.TypeKind != TypeKind.Delegate {
                return
            }
            critical.Add(leftDelegate)
            critical.Add(rightDelegate)
        }

        /// Issue #3841: whether two same-name, same-arity members' parameter lists
        /// print identically in G# once delegate types are erased to arrow form.
        /// @param left The first member.
        /// @param right The second member.
        /// @returns `true` when the two erase to one signature.
        private func ParametersEraseAlike(left IMethodSymbol, right IMethodSymbol) bool {
            var sawDelegateDifference = false
            for var i = 0; i < left.Parameters.Length; i++ {
                let a = left.Parameters[i]
                let b = right.Parameters[i]
                if a.RefKind != b.RefKind || a.IsParams != b.IsParams || !TypesEraseAlike(a.Type, b.Type) {
                    return false
                }
                sawDelegateDifference |= !SymbolEqualityComparer.Default.Equals(a.Type, b.Type)
            }
            // Two members that agree at every position are not an overload set at
            // all (C# would have rejected them); only a difference that erasure
            // hides makes this collision cs2gs's to repair.
            return sawDelegateDifference
        }

        /// Issue #3841: whether two C# types render as the SAME G# type once
        /// delegate types are erased to their arrow form. Identical types trivially
        /// qualify; two distinct delegate types qualify when their invoke
        /// signatures agree position by position (this is exactly what
        /// (cref:MapDelegate) prints), which is how `Predicate<T>`
        /// and `Func<T, bool>` collide.
        /// @param left The first type.
        /// @param right The second type.
        /// @returns `true` when both erase to one G# spelling.
        private func TypesEraseAlike(left ITypeSymbol, right ITypeSymbol) bool {
            if SymbolEqualityComparer.Default.Equals(left, right) {
                return true
            }
            // Issue #4127/#4129 (self-hosting regression, #3501): decomposed for
            // the same gsc pattern-matcher reason as <see cref="MapEventType"/>
            // and <see cref="AddIfDistinctDelegates"/> — a property pattern
            // containing an enum-constant sub-pattern against an
            // imported-interface-typed scrutinee does not reliably match once
            // this method is itself translated to G# and compiled by gsc; see
            // <see cref="MapEventType"/> for why no other sub-pattern (a null
            // check included) is needed to trigger it.
            if left is not INamedTypeSymbol leftDelegate ||
                leftDelegate.TypeKind != TypeKind.Delegate ||
                leftDelegate.DelegateInvokeMethod == nil ||
                right is not INamedTypeSymbol rightDelegate ||
                rightDelegate.TypeKind != TypeKind.Delegate ||
                rightDelegate.DelegateInvokeMethod == nil {
                return false
            }
            let leftInvoke IMethodSymbol? = leftDelegate.DelegateInvokeMethod
            let rightInvoke IMethodSymbol? = rightDelegate.DelegateInvokeMethod
            if leftInvoke!!
                .Parameters
                .Length != rightInvoke!!
                .Parameters
                .Length ||
                !TypesEraseAlike(leftInvoke!!.ReturnType, rightInvoke!!.ReturnType) {
                return false
            }
            for var i = 0; i < leftInvoke!!.Parameters.Length; i++ {
                if leftInvoke!!
                    .Parameters[i]
                    .RefKind != rightInvoke!!
                    .Parameters[i]
                    .RefKind ||
                    !TypesEraseAlike(leftInvoke!!.Parameters[i].Type, rightInvoke!!.Parameters[i].Type) {
                    return false
                }
            }
            return true
        }

        private func BuildAnonymousShapeEvidenceIndex(compilation Compilation) Dictionary[
            string,
            List[(PropertyTypes[]ITypeSymbol, AcceptsNil[]bool)]
        ] {
            let result = Dictionary[string, List[(PropertyTypes[]ITypeSymbol, AcceptsNil[]bool)]](
                StringComparer.Ordinal
            )
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                for creation in tree.GetRoot().DescendantNodes().OfType[AnonymousObjectCreationExpressionSyntax]() {
                    if model.GetTypeInfo(creation).Type is not INamedTypeSymbol candidateType {
                        continue
                    }
                    let properties = candidateType.GetMembers().OfType[IPropertySymbol]().ToArray()
                    let shapeKey = AnonymousShapeKey(properties)
                    if !result.TryGetValue(shapeKey, out var evidence) {
                        evidence = List[(PropertyTypes[]ITypeSymbol, AcceptsNil[]bool)]()
                        result.Add(shapeKey, evidence)
                    }
                    let acceptsNil = [properties.Length]bool
                    for var index = 0; index < properties.Length && index < creation.Initializers.Count; index++ {
                        acceptsNil[index] = AnonymousInitializerAcceptsNil(
                            creation.Initializers[index].Expression,
                            model
                        )
                    }
                    evidence.Add((properties.Select((property IPropertySymbol) -> property.Type).ToArray(), acceptsNil))
                }
            }
            return result
        }

        private func NormalizeAnonymousProjectedStorage(symbol ITypeSymbol?, mapped GTypeReference) GTypeReference {
            if symbol is IArrayTypeSymbol arraySymbol && mapped is ArrayTypeReference array {
                var element = NormalizeAnonymousProjectedStorage(arraySymbol.ElementType, array.ElementType)
                if arraySymbol.ElementType.IsReferenceType {
                    // The self-migrated helper return is promoted, but this storage is non-null.
                    element = WithNullable(element, true)!!
                }
                return ArrayTypeReference(element, array.Rank){IsNullable = array.IsNullable}
            }
            if symbol is INamedTypeSymbol{IsTupleType: true} tupleSymbol &&
                mapped is TupleTypeReference tuple &&
                tupleSymbol
                .TupleElements
                .Length == tuple
                .ElementTypes
                .Count {
                return TupleTypeReference(
                    tupleSymbol
                        .TupleElements
                        .Select(
                        (element IFieldSymbol, index int32) -> {
                            let normalized = NormalizeAnonymousProjectedStorage(element.Type, tuple.ElementTypes[index])
                            return if element.Type.IsReferenceType {
                                WithNullable(normalized, true)!!
                            } else {
                                normalized
                            }
                        }
                    )
                        .ToList(),
                    tuple.ElementNames
                ){IsNullable = tuple.IsNullable}
            }
            if symbol is INamedTypeSymbol namedSymbol &&
                mapped is NamedTypeReference named &&
                namedSymbol
                .TypeArguments
                .Length == named
                .TypeArguments
                .Count {
                let containingType GTypeReference? = if namedSymbol.ContainingType != nil &&
                    named.ContainingType != nil {
                    NormalizeAnonymousProjectedStorage(namedSymbol.ContainingType, named.ContainingType!!)
                } else {
                    named.ContainingType
                }
                return NamedTypeReference(
                    named.Name,
                    namedSymbol
                        .TypeArguments
                        .Select(
                        (argument ITypeSymbol, index int32) -> {
                            let normalized = NormalizeAnonymousProjectedStorage(argument, named.TypeArguments[index])
                            return if argument.IsReferenceType {
                                WithNullable(normalized, true)!!
                            } else {
                                normalized
                            }
                        }
                    )
                        .ToList(),
                    containingType
                ){IsNullable = named.IsNullable}
            }
            if symbol is INamedTypeSymbol{DelegateInvokeMethod: {} invoke} &&
                mapped is ArrowTypeReference arrow &&
                invoke
                .Parameters
                .Length == arrow
                .ParameterTypes
                .Count &&
                (
                if invoke.ReturnsVoid {
                    arrow.ReturnTypes.Count == 0
                } else {
                    arrow.ReturnTypes.Count == 1
                }
            ) {
                return MergeAnonymousDelegateNullability(arrow, invoke)
            }
            return mapped
        }

        private func AnonymousShapeKey(properties IReadOnlyList[IPropertySymbol]) string -> string.Join(
            "|",
            properties.Select(
                (property IPropertySymbol) -> property.Name + ":" + property.Type.ToDisplayString(
                    SymbolDisplayFormat.FullyQualifiedFormat
                )
            )
        )

        private func MergeAnonymousNullability(mapped GTypeReference, symbol ITypeSymbol?) GTypeReference {
            let nullable = mapped.IsNullable ||
                symbol!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
            var merged GTypeReference
            if symbol is IArrayTypeSymbol arraySymbol && mapped is ArrayTypeReference array {
                merged = ArrayTypeReference(
                    MergeAnonymousNullability(array.ElementType, arraySymbol.ElementType),
                    array.Rank
                )
            } else if symbol is INamedTypeSymbol{IsTupleType: true} tupleSymbol &&
                mapped is TupleTypeReference tuple &&
                tupleSymbol
                .TupleElements
                .Length == tuple
                .ElementTypes
                .Count {
                merged = TupleTypeReference(
                    tupleSymbol
                        .TupleElements
                        .Select(
                        (element IFieldSymbol, index int32) -> MergeAnonymousNullability(
                            tuple.ElementTypes[index],
                            element.Type
                        )
                    )
                        .ToList(),
                    tuple.ElementNames
                )
            } else if symbol is INamedTypeSymbol{DelegateInvokeMethod: {} invoke} &&
                mapped is ArrowTypeReference arrow &&
                invoke
                .Parameters
                .Length == arrow
                .ParameterTypes
                .Count &&
                (
                if invoke.ReturnsVoid {
                    arrow.ReturnTypes.Count == 0
                } else {
                    arrow.ReturnTypes.Count == 1
                }
            ) {
                merged = MergeAnonymousDelegateNullability(arrow, invoke)
            } else if symbol is INamedTypeSymbol namedSymbol &&
                mapped is NamedTypeReference named &&
                namedSymbol
                .TypeArguments
                .Length == named
                .TypeArguments
                .Count {
                merged = NamedTypeReference(
                    named.Name,
                    namedSymbol
                        .TypeArguments
                        .Select(
                        (argument ITypeSymbol, index int32) -> MergeAnonymousNullability(
                            named.TypeArguments[index],
                            argument
                        )
                    )
                        .ToList(),
                    MergeAnonymousContainingType(named, namedSymbol)
                )
            } else {
                merged = mapped
            }
            return WithNullable(merged, nullable)!!
        }

        private func MergeAnonymousContainingType(
            mapped NamedTypeReference,
            symbol INamedTypeSymbol
        ) GTypeReference? -> if symbol.ContainingType != nil &&
            mapped.ContainingType != nil {
            MergeAnonymousNullability(mapped.ContainingType!!, symbol.ContainingType)
        } else {
            mapped.ContainingType
        }

        private func MergeAnonymousDelegateNullability(
            arrow ArrowTypeReference,
            invoke IMethodSymbol
        ) ArrowTypeReference {
            let returnTypes = if invoke.ReturnsVoid {
                arrow.ReturnTypes
            } else {
                cast[IReadOnlyList[GTypeReference]](
                    []GTypeReference{MergeAnonymousNullability(arrow.ReturnTypes[0], invoke.ReturnType)}
                )
            }
            return ArrowTypeReference(
                invoke
                    .Parameters
                    .Select(
                    (parameter IParameterSymbol, index int32) -> MergeAnonymousNullability(
                        arrow.ParameterTypes[index],
                        parameter.Type
                    )
                )
                    .ToList(),
                returnTypes,
                arrow.IsAsync
            )
        }

        private func AnonymousInitializerAcceptsNil(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            model Microsoft.CodeAnalysis.SemanticModel
        ) bool {
            var expression = expression
            expression = if expression is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParenthesizedExpressionSyntax parenthesized {
                parenthesized.Expression
            } else {
                expression
            }
            return ObliviousNullabilityAnalyzer.IsSemanticallyNullableInitializer(expression, model) ||
                expression.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullLiteralExpression) ||
                expression is ConditionalAccessExpressionSyntax ||
                expression.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsExpression) ||
                (
                expression is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SuppressNullableWarningExpression
                ) &&
                    AnonymousInitializerAcceptsNil(suppression.Operand, model)
            ) ||
                (expression is CastExpressionSyntax cast && AnonymousInitializerAcceptsNil(cast.Expression, model)) ||
                (
                expression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConditionalExpressionSyntax conditional &&
                    (
                    AnonymousInitializerAcceptsNil(conditional.WhenTrue, model) ||
                        AnonymousInitializerAcceptsNil(conditional.WhenFalse, model)
                )
            ) ||
                (
                expression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionSyntax switchExpression &&
                    switchExpression
                    .Arms
                    .Any(
                    (
                        arm Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionArmSyntax
                    ) -> AnonymousInitializerAcceptsNil(arm.Expression, model)
                )
            ) ||
                (
                (
                    expression.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultLiteralExpression) ||
                        expression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .DefaultExpressionSyntax
                ) &&
                    (
                    model.GetTypeInfo(expression).ConvertedType ?? model.GetTypeInfo(expression).Type
                ) is ITypeSymbol type &&
                    (type.IsReferenceType || type.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            )
        }
    }
}

/// Stores the anonymous shapes already declared in one G# package. The
/// registry is shared across that package's documents for declaration
/// deduplication (#2292), while (cref:SyntheticName) derives names from
/// complete ordered shapes so independent packages and projects agree (#2598).
class AnonymousTypeRegistry {
    private let byShape Dictionary[string, NamedTypeReference] = Dictionary[string, NamedTypeReference](
        StringComparer.Ordinal
    )

    // The document (file path) that first declared each shape.
    private let ownerByShape Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal)

    /// Looks up an already-synthesized data-class reference for
    /// [`shapeKey`](paramref) (an anonymous type's ordered
    /// member-name+type shape), reused verbatim regardless of which file
    /// (sharing this registry) first synthesized it.
    /// @param shapeKey The structural shape key.
    /// @param existing The reused reference, when found.
    /// @returns `true` when a data class already exists for this shape.
    func TryGetExisting(shapeKey string, out existing NamedTypeReference) bool -> this.byShape.TryGetValue(
        shapeKey,
        out existing
    )

    /// Records that [`shapeKey`](paramref) now resolves to
    /// [`reference`](paramref), so any later file sharing this registry
    /// reuses it instead of re-declaring an identical data class (which would
    /// itself be a same-name GS0102 collision even for an identical shape).
    /// @param shapeKey The structural shape key.
    /// @param reference The synthesized data class's type reference.
    /// @param ownerFilePath The document that declares the data class.
    func Register(shapeKey string, reference NamedTypeReference, ownerFilePath string?) {
        this.byShape[shapeKey] = reference
        if ownerFilePath != nil {
            this.ownerByShape.TryAdd(shapeKey, ownerFilePath)
        }
    }

    /// Whether [`filePath`](paramref) is the document that first declared
    /// [`shapeKey`](paramref)'s data class (and so declares it again when
    /// it is re-translated for ADR-0192 partial-pair reconciliation).
    /// @param shapeKey The structural shape key.
    /// @param filePath The document being translated.
    /// @returns `true` for the owning document.
    func IsOwnedBy(shapeKey string, filePath string?) bool -> filePath != nil && this.ownerByShape.TryGetValue(
        shapeKey,
        out var owner
    ) &&
        string.Equals(owner, filePath, StringComparison.Ordinal)

    shared {
        /// Produces a deterministic synthetic name from the complete ordered shape.
        /// The name is therefore identical wherever the same shape is translated
        /// and different for unrelated shapes even when separate documents,
        /// packages, projects, or translator instances are involved.
        /// @param shapeKey The ordered member-name/type shape.
        /// @param arity The number of members in the shape.
        /// @returns A stable shape-derived synthetic type name.
        func SyntheticName(shapeKey string, arity int32) string {
            let hash = SHA256.HashData(Encoding.UTF8.GetBytes(shapeKey))
            return "AnonymousType${arity}_${Convert.ToHexString(hash, 0, 8)}"
        }
    }
}
