// <copyright file="ObliviousNullabilityAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Runtime.CompilerServices

/// Issue #2113: a whole-program, symbol-keyed null-TAINT analysis for a
/// nullable-<em>oblivious</em> compilation (one whose
/// (cref:CSharpCompilationOptions.NullableContextOptions) is
/// (cref:NullableContextOptions.Disable)).
///
/// In oblivious C# Roslyn reports every reference type as
/// `NullableAnnotation.None` with no flow state, so the translator
/// cannot tell a "definitely non-null" declaration apart from a "maybe null"
/// one (`NullableAnnotation.None` with no flow state). Mapping every
/// oblivious reference `T` to a non-null G# `T` then collides
/// with the `T?` values cs2gs legitimately introduces (`?.`, `= null` defaults,
/// nullable-returning BCL members), producing a cluster of GS0154/0155/0156
/// "T? vs T" errors. Mapping every oblivious reference to `T?` instead over-
/// promotes and forces a use-site explosion of `!!` assertions and idiomatic
/// non-null decls become nullable.
///
/// This analyzer instead decides, per reference-type declaration symbol S
/// (field / auto-property / parameter / method-return / local), whether S is
/// null-TAINTED. A tainted S is rendered `T?`; an untainted S stays non-null
/// `T` (the idiomatic default). Taint is seeded from direct null evidence
/// (== null, = null, ??=, is null, `?.`, `= null|default` initializers,
/// nullable-returning BCL members, and `return null` paths) and then propagated
/// to a fixpoint along assignment / initializer / return edges: if S is
/// assigned/initialized/returned a value that reads a tainted symbol or calls a
/// tainted method's return, S becomes tainted too.
///
/// The whole result is keyed on the declaration's (cref:ISymbol) and is
/// consulted at declaration and corresponding value-sink sites (see
/// `CSharpToGSharpTranslator.DeclarationVisitor.IsPromotedToNullableReference`
/// and the method-return path). Tuple positions use their own declaration's
/// annotation and writable contract, including oblivious islands in enabled
/// projects; explicitly non-null leaves and frozen metadata stay unchanged.
internal shared class ObliviousNullabilityAnalyzer {
    // Which source expressions a transitive return/forwarding edge follows.
    private enum SourceScope {
        AllSources,
        CallsOnly,
        CallsAndNonPropertyDeclarations
    }

    private struct TupleElementKey {
        init(symbol ISymbol?, path string) {
            this.ContractSymbol = symbol
            this.ContractPath = path
            let (owner, projectedPath) = ObliviousNullabilityAnalyzer.ProjectTupleContractPosition(symbol, path)
            this.Symbol = if owner is INamedTypeSymbol named {
                cast[ISymbol](ObliviousNullabilityAnalyzer.NormalizeContractTupleNames(named))
            } else {
                ObliviousNullabilityAnalyzer.Canonical(owner)
            }
            this.Path = projectedPath
        }

        prop Symbol ISymbol? {
            get;
        }

        prop Path string {
            get;
        }

        prop ContractSymbol ISymbol? {
            get;
        }

        prop ContractPath string {
            get;
        }
    }

    private struct ScalarQuery {
        init(compilation CSharpCompilation?, symbol ISymbol?) {
            this.Compilation = compilation
            this.Symbol = ObliviousNullabilityAnalyzer.Canonical(symbol)
        }

        prop Compilation CSharpCompilation? {
            get;
        }

        prop Symbol ISymbol? {
            get;
        }
    }

    private struct TupleElementQuery {
        init(compilation CSharpCompilation?, key TupleElementKey) {
            this.Compilation = compilation
            this.Key = key
        }

        prop Compilation CSharpCompilation? {
            get;
        }

        prop Key TupleElementKey {
            get;
        }
    }

    private class TupleElementKeyComparer : IEqualityComparer[TupleElementKey] {
        func Equals(x TupleElementKey, y TupleElementKey) bool -> SymbolEqualityComparer.Default.Equals(
            x.Symbol,
            y.Symbol
        ) &&
            string.Equals(x.Path, y.Path, StringComparison.Ordinal)

        func GetHashCode(obj TupleElementKey) int32 {
            let symbolHash = if obj.Symbol == nil {
                0
            } else {
                SymbolEqualityComparer.Default.GetHashCode(obj.Symbol)
            }
            return HashCode.Combine(symbolHash, obj.Path)
        }

        shared {
            private let _instance TupleElementKeyComparer = TupleElementKeyComparer()

            prop Instance TupleElementKeyComparer {
                get {
                    return _instance
                }
            }
        }
    }

    private class TupleContractKeyComparer : IEqualityComparer[TupleElementKey] {
        func Equals(x TupleElementKey, y TupleElementKey) bool -> SymbolEqualityComparer.IncludeNullability.Equals(
            Owner(x),
            Owner(y)
        ) &&
            string.Equals(x.ContractPath, y.ContractPath, StringComparison.Ordinal)

        func GetHashCode(obj TupleElementKey) int32 {
            let owner ISymbol? = Owner(obj)
            return HashCode.Combine(
                if owner == nil {
                    0
                } else {
                    SymbolEqualityComparer.IncludeNullability.GetHashCode(owner)
                },
                obj.ContractPath
            )
        }

        shared {
            private let _instance2 TupleContractKeyComparer = TupleContractKeyComparer()

            prop Instance TupleContractKeyComparer {
                get {
                    return _instance2
                }
            }

            private func Owner(key TupleElementKey) ISymbol? -> if ObliviousNullabilityAnalyzer.OwningMember(
                key.ContractSymbol
            ) is INamedTypeSymbol named {
                cast[ISymbol](ObliviousNullabilityAnalyzer.NormalizeContractTupleNames(named))
            } else {
                ObliviousNullabilityAnalyzer.OwningMember(key.ContractSymbol)
            }
        }
    }

    private class ScalarQueryComparer : IEqualityComparer[ScalarQuery] {
        func Equals(x ScalarQuery, y ScalarQuery) bool -> object.ReferenceEquals(x.Compilation, y.Compilation) &&
            SymbolEqualityComparer
            .Default
            .Equals(x.Symbol, y.Symbol)

        func GetHashCode(obj ScalarQuery) int32 {
            let symbolHash = if obj.Symbol == nil {
                0
            } else {
                SymbolEqualityComparer.Default.GetHashCode(obj.Symbol)
            }
            return HashCode.Combine(RuntimeHelpers.GetHashCode(obj.Compilation), symbolHash)
        }

        shared {
            private let _instance3 ScalarQueryComparer = ScalarQueryComparer()

            prop Instance ScalarQueryComparer {
                get {
                    return _instance3
                }
            }
        }
    }

    private class TupleElementQueryComparer : IEqualityComparer[TupleElementQuery] {
        private let keys IEqualityComparer[TupleElementKey]

        private init(keys IEqualityComparer[TupleElementKey]) {
            this.keys = keys
        }

        func Equals(x TupleElementQuery, y TupleElementQuery) bool -> object.ReferenceEquals(
            x.Compilation,
            y.Compilation
        ) &&
            this
            .keys
            .Equals(x.Key, y.Key)

        func GetHashCode(obj TupleElementQuery) int32 -> HashCode.Combine(
            RuntimeHelpers.GetHashCode(obj.Compilation),
            this.keys.GetHashCode(obj.Key)
        )

        shared {
            private let _instance4 TupleElementQueryComparer = TupleElementQueryComparer(
                TupleElementKeyComparer.Instance
            )

            prop Instance TupleElementQueryComparer {
                get {
                    return _instance4
                }
            }

            private let _contractInstance TupleElementQueryComparer = TupleElementQueryComparer(
                TupleContractKeyComparer.Instance
            )

            prop ContractInstance TupleElementQueryComparer {
                get {
                    return _contractInstance
                }
            }
        }
    }

    private class TaintResult {
        init(
            tainted HashSet[ISymbol],
            tupleTainted HashSet[TupleElementKey],
            fixedTupleContracts HashSet[TupleElementKey],
            tupleContractEdges List[(Target TupleElementKey, Source TupleElementKey)],
            tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
            tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)],
            scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)],
            delegateReturnEdges List[(Target ISymbol, Source ISymbol)],
            paramsElementTainted HashSet[string],
            paramsElementEdges List[(Target string, Source ISymbol)]
        ) {
            this.Tainted = tainted
            this.TupleTainted = tupleTainted
            this.FixedTupleContracts = fixedTupleContracts
            this.TupleContractEdges = tupleContractEdges
            this.TupleEdges = tupleEdges
            this.TupleScalarEdges = tupleScalarEdges
            this.ScalarTupleEdges = scalarTupleEdges
            this.DelegateReturnEdges = delegateReturnEdges
            this.ParamsElementTainted = paramsElementTainted
            this.ParamsElementEdges = paramsElementEdges
        }

        prop Tainted HashSet[ISymbol] {
            get;
        }

        prop TupleTainted HashSet[TupleElementKey] {
            get;
        }

        prop FixedTupleContracts HashSet[TupleElementKey] {
            get;
        }

        prop TupleContractEdges List[(Target TupleElementKey, Source TupleElementKey)] {
            get;
        }

        prop TupleEdges List[(Target TupleElementKey, Source TupleElementKey)] {
            get;
        }

        prop TupleScalarEdges List[(Target TupleElementKey, Source ISymbol)] {
            get;
        }

        prop ScalarTupleEdges List[(Target ISymbol, Source TupleElementKey)] {
            get;
        }

        prop DelegateReturnEdges List[(Target ISymbol, Source ISymbol)] {
            get;
        }

        prop ParamsElementTainted HashSet[string] {
            get;
        }

        prop ParamsElementEdges List[(Target string, Source ISymbol)] {
            get;
        }
    }

    // Issue #5508: one compilation's null-ARGUMENT evidence. `Seeds` are the
    // declaration keys some call passes a `null` / `null!` literal into;
    // `Incoming` maps a declaration key to the keys of the PARAMETERS whose
    // value it receives unchanged (`Parent = parent`, `base(header, parent)`).
    // `Forwarding` is filled on first request (see `EnsureForwardingEdges`).
    private class NullArgumentGraph {
        init(owner Compilation, seeds HashSet[string]) {
            this.Owner = owner
            this.Seeds = seeds
            this.Incoming = Dictionary[string, List[string]](StringComparer.Ordinal)
        }

        prop Owner Compilation {
            get;
        }

        prop Seeds HashSet[string] {
            get;
        }

        prop Incoming Dictionary[string, List[string]] {
            get;
        }

        prop ForwardingBuilt bool {
            get;
            set;
        }
    }

    private class SourceAssemblySet {
        init(currentAssembly string) {
            this.Names = HashSet[string](StringComparer.Ordinal){currentAssembly}
        }

        prop Names HashSet[string] {
            get;
        }
    }

    // Issue #3694: the metadata name of the attribute that states "null is an
    // accepted input for this declaration" (`System.Diagnostics.CodeAnalysis`).
    // Matched by name rather than by symbol so the lookup needs no compilation
    // and answers identically in every compilation a migration run loads.
    private const AllowNullAttributeName string = "AllowNullAttribute"

    // Issue #3848: how far a promotion may travel along pure forwarding edges.
    // Four hops covers the real shapes — an overload chain forwarder → forwarder
    // → real method, plus the generated sink the last one flows into — while
    // keeping the relation a BOUNDED closure rather than the whole-graph
    // fixpoint #3676 rejected for nullable-enabled compilations. Raising it is a
    // deliberate widening, not a tuning knob.
    private const MaxForwardingHops int32 = 4

    // Keyed by Compilation identity so an edited/new compilation naturally gets
    // a fresh entry and stale ones are collectible — same pattern as the
    // subclassed-base-types / partial-type-parts caches in the translator.
    private let Cache ConditionalWeakTable[Compilation, TaintResult] = ConditionalWeakTable[Compilation, TaintResult]()

    private let SourceAssemblies ConditionalWeakTable[Compilation, SourceAssemblySet] = ConditionalWeakTable[
        Compilation,
        SourceAssemblySet
    ]()
    private let SourceTrees ConditionalWeakTable[Compilation, Dictionary[string, []SyntaxTree]] = ConditionalWeakTable[
        Compilation,
        Dictionary[string, []SyntaxTree]
    ]()

    // Issue #3676: `<auto-generated/>`-ness is a property of a whole syntax tree
    // and is asked once per declaration query, so the (root-materializing) trivia
    // scan is memoized per tree. Keyed on tree identity so a reparsed tree gets a
    // fresh entry and stale ones stay collectible, exactly like `Cache` above.
    private let GeneratedTrees ConditionalWeakTable[SyntaxTree, StrongBox[bool]] = ConditionalWeakTable[
        SyntaxTree,
        StrongBox[bool]
    ]()

    // Issue #3676: per-compilation set of members some source directly writes
    // `null` into, keyed like `Cache` above so it is computed at most once.
    private let NullTargets ConditionalWeakTable[Compilation, HashSet[string]] = ConditionalWeakTable[
        Compilation,
        HashSet[string]
    ]()

    // Issue #3848: per-compilation set of declarations a PURE FORWARDING chain
    // from a promoted generated declaration reaches. Cached like `NullTargets`.
    private let ForwardedTargets ConditionalWeakTable[Compilation, HashSet[string]] = ConditionalWeakTable[
        Compilation,
        HashSet[string]
    ]()

    // Issue #5508: per-compilation null-ARGUMENT evidence graph, cached like
    // `NullTargets`. The seeds are cheap (a syntactic scan for `null` / `null!`
    // arguments); the forwarding edges are built lazily, only once some
    // compilation of the run actually has a seed.
    private let NullArguments ConditionalWeakTable[Compilation, NullArgumentGraph] = ConditionalWeakTable[
        Compilation,
        NullArgumentGraph
    ]()

    // Issue #3848 (family B): per-compilation set of generated ARRAY-typed
    // declarations some source writes a maybe-null ELEMENT into. Cached like
    // `NullTargets`.
    private let NullElementTargets ConditionalWeakTable[Compilation, HashSet[string]] = ConditionalWeakTable[
        Compilation,
        HashSet[string]
    ]()

    /// Whether [`symbol`](paramref) (a declaration symbol: field / property
    /// / parameter / local, or a method whose RETURN is under test) is
    /// null-tainted in [`compilation`](paramref). Always returns
    /// `false` for a non-oblivious (nullable-enabled) compilation
    /// — the analysis never runs there, so enabled projects are untouched.
    /// @param compilation The C# compilation being translated.
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when the symbol is null-tainted.
    func IsTainted(compilation CSharpCompilation?, symbol ISymbol?) bool {
        if symbol == nil ||
            compilation == nil ||
            compilation
            .Options
            .NullableContextOptions != NullableContextOptions.Disable {
            return false
        }
        RegisterSourceAssemblies(compilation, nil)
        return Cache.GetValue(compilation, Compute).Tainted.Contains(Canonical(symbol)!!)
    }

    /// Issue #3676: whether [`symbol`](paramref)'s declaring source is
    /// marked `<auto-generated/>`. The C# compiler SUPPRESSES its
    /// nullable diagnostics (CS8600-CS8655) inside such a file — verified
    /// empirically: an identical `public string Get() => null;` reports
    /// CS8603 in a hand-authored file and reports NOTHING in one carrying the
    /// header — so a generated file's reference annotations are unenforced and
    /// routinely contradicted by the very code that declares them. gsc has no
    /// matching suppression, so translating those annotations at face value
    /// emits G# the C# compiler never had to justify.
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when any declaring tree carries the header.
    func IsDeclaredInGeneratedCode(symbol ISymbol?) bool {
        if symbol == nil {
            return false
        }
        for reference in symbol.DeclaringSyntaxReferences {
            if HasAutoGeneratedHeader(reference.SyntaxTree) {
                return true
            }
        }
        return false
    }

    /// Issue #3676: whether [`symbol`](paramref) is a generated-code
    /// declaration whose G# type this translator may decide from taint evidence
    /// instead of from its (compiler-unenforced) C# annotation.
    ///
    /// Being declared in generated code is necessary but not sufficient: a
    /// member that OVERRIDES or IMPLEMENTS another declaration does not own its
    /// own signature. Its parameter and return types are fixed by the base, and
    /// repainting one of them nullable produces a signature that no longer
    /// matches what it overrides — gsc's GS0185/GS0386/GS0387, which is how the
    /// `<auto-generated />` LSP `JsonConverter<T>` subclasses
    /// (`Read`/`Write`/`ReadAsPropertyName`) first failed. Those
    /// members keep their declared types and rely on the ordinary use-site
    /// forgiveness pass, exactly as they do today.
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when evidence, not the annotation, decides the symbol.
    func IsEvidenceDecidedGeneratedDeclaration(symbol ISymbol?) bool -> IsDeclaredInGeneratedCode(symbol) &&
        !IsSignatureFixedByAnotherDeclaration(symbol)

    /// Issue #3676: whether [`symbol`](paramref) is an evidence-decided
    /// generated-code declaration (see
    /// (cref:IsEvidenceDecidedGeneratedDeclaration)) that some source in
    /// [`compilation`](paramref) or [`siblingCompilations`](paramref)
    /// DIRECTLY writes `null` (or `default`) into — an assignment, an
    /// object-initializer member, a field/property initializer, or a
    /// `return`.
    ///
    /// Deliberately DIRECT evidence rather than #2113's transitive taint
    /// fixpoint. That fixpoint reasons about a compilation where every
    /// annotation is oblivious and it therefore has nothing else to go on;
    /// applied to a nullable-ENABLED compilation, whose
    /// graph is mostly annotated, its forwarding edges over-promote — it marked
    /// the LSP `LspJson.Options` chain nullable although
    /// `Create()` only ever returns a fresh `new
    /// JsonSerializerOptions`, which then failed to bind at the non-null
    /// StreamJsonRpc formatter property. The narrow rule states exactly what
    /// the suppression licenses and nothing more: where the compiler stopped
    /// checking, believe the code that writes `null`, not the annotation
    /// it silently contradicts.
    /// @param compilation The compilation being translated.
    /// @param symbol The declaration symbol to test.
    /// @param siblingCompilations Other projects loaded in the same run, or `null`.
    /// @returns `true` when null is written into the declaration.
    func IsGeneratedDeclarationAssignedNull(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if compilation == nil ||
            !IsEvidenceDecidedGeneratedDeclaration(symbol) ||
            symbol!!
            .OriginalDefinition
            .GetDocumentationCommentId() is not{} id {
            return false
        }
        // A declaration must translate identically no matter which project is
        // being emitted, so the evidence is the union over every compilation
        // known to the run — an existential OR, order-independent, each side
        // computed and cached once.
        if NullAssignmentTargets(compilation).Contains(id) {
            return true
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling != nil && NullAssignmentTargets(sibling).Contains(id) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #5508: whether [`symbol`](paramref) is a declaration that the
    /// author's own code writes `null` into by way of an ARGUMENT — a call that
    /// passes the literal `null` / `null!` (or `default`) to a parameter the C#
    /// declares non-nullable, or a parameter, field or property that such a
    /// parameter's value reaches unchanged.
    ///
    /// <b>Why the author's `null!` is evidence.</b> `Frame(Header header, Frame
    /// parent)` called as `base(header, null!)` is the C# author saying "null
    /// goes here": `!` silences exactly the CS8625 the compiler would have raised
    /// for the unannotated slot. G# has one nullability per declaration and gsc
    /// rejects `nil` at a non-nullable reference slot (#4316, GS0155/GS0154), so
    /// the only rendering that still admits the call is `parent Frame?`.
    ///
    /// <b>Direct evidence plus pure forwarding only.</b> Like #3676's rule this
    /// does not use #2113's transitive taint fixpoint (which over-promotes on an
    /// annotated graph). A seed is a syntactic null argument; the promotion then
    /// follows a value that is passed on UNCHANGED — `Parent = parent`,
    /// `: base(header, parent)` — because a promoted parameter stored into a
    /// slot that kept its non-null contract would be bridged with a `!!` that
    /// throws on the very null the C# stores. A forwarded read through `q!`, a
    /// local, or any expression is not forwarding: the author asserted or
    /// changed it.
    ///
    /// <b>Signature-fixed declarations are left alone.</b> A parameter or
    /// property of a virtual, abstract, overriding or interface-implementing
    /// member does not own its nullability (repainting it is gsc's
    /// GS0185/GS0386), so it keeps its declared type.
    ///
    /// The answer is the existential union over every compilation in the run,
    /// so a declaration translates identically whichever project is emitted.
    /// @param compilation The compilation being translated.
    /// @param symbol The parameter, field or property to test.
    /// @param siblingCompilations Other projects loaded in the same run, or `null`.
    /// @returns `true` when `null` is passed into the declaration.
    func IsNullArgumentTarget(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        // Only a declaration this migration emits can be repainted. The seed
        // side needs no such test: a sibling project that binds the callee
        // through its emitted reference assembly still records the call.
        let original ISymbol? = OriginalNullArgumentDeclaration(symbol)
        if compilation == nil ||
            original == nil ||
            original
            .DeclaringSyntaxReferences
            .Length == 0 ||
            !IsNullArgumentCandidate(original) {
            return false
        }
        let keys = NullArgumentKeys(original)
        if keys.Count == 0 {
            return false
        }
        // The compilation being translated first, then the siblings in the
        // order the run supplied them: the answer is an existential OR, so the
        // order cannot change it, and no hash order is ever iterated.
        let graphs = List[NullArgumentGraph]()
        graphs.Add(NullArguments.GetValue(compilation, ComputeNullArgumentSeeds))
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling != nil && !object.ReferenceEquals(sibling, compilation) {
                    graphs.Add(NullArguments.GetValue(sibling, ComputeNullArgumentSeeds))
                }
            }
        }
        if !graphs.Any((g NullArgumentGraph) -> g.Seeds.Count != 0) {
            return false
        }
        // Some compilation has a null argument, so the forwarding edges can
        // matter. They are built once per compilation and only now.
        for graph in graphs {
            EnsureNullArgumentForwarding(graph)
        }
        let visited = HashSet[string](StringComparer.Ordinal)
        let pending = Stack[string]()
        for key in keys {
            pending.Push(key)
        }
        while pending.Count != 0 {
            let current = pending.Pop()
            if !visited.Add(current) {
                continue
            }
            for graph in graphs {
                if graph.Seeds.Contains(current) {
                    return true
                }
                if graph.Incoming.TryGetValue(current, out var sources) {
                    for source in sources {
                        pending.Push(source)
                    }
                }
            }
        }
        return false
    }

    /// Issue #3848 (family B): whether [`symbol`](paramref) is an
    /// evidence-decided generated declaration of ARRAY type whose ELEMENT slot
    /// some source writes a maybe-null value into — `Command.Arguments`
    /// (a generated `object[]`) written `[uri, range.Start]` with
    /// `uri` a hand-authored `string?`.
    ///
    /// <b>This is #3676/#3851's rule at element granularity, NOT #3930's
    /// forwarding rule.</b> Nothing is forwarded here and nothing is seeded from
    /// a promoted declaration: `uri` is an ordinary, compiler-CHECKED
    /// `string?` parameter, and (cref:IsPromotedByPureForwarding)
    /// rejects a parameter read outright (clause 6). What makes the write
    /// admissible in C# and inadmissible in G# is the same single fact #3676
    /// found: the sink is declared in an `<auto-generated/>` file, so
    /// the compiler suppressed the CS8601 it would otherwise have raised for
    /// storing a maybe-null value into a non-null element slot, and the
    /// annotation was therefore never checked against this write. Believe the
    /// write.
    ///
    /// <b>The ELEMENT, never the array (ADR-0132).</b> The promotion this
    /// evidence licenses is `object[]` → `[]object?`, an
    /// element-nullable array. It is emphatically not `[]object` →
    /// `([]object)?`: the array reference itself is not null here, one of
    /// the values in it is. Declaration-level promotion
    /// ((cref:IsGeneratedDeclarationAssignedNull)) answers the other
    /// question and is deliberately left alone — a collection expression's own
    /// flow state is `NotNull`, so it never fires on this shape at all.
    ///
    /// <b>Scope.</b> Fields and properties only, whose declared type is an
    /// array of an unannotated REFERENCE element type, written by an
    /// array-shaped literal (a collection expression, or an array creation with
    /// an initializer) in an assignment — which is also the object-initializer
    /// member shape — or in a field/property initializer. That is exactly the
    /// node population (cref:IsGeneratedDeclarationAssignedNull) already
    /// collects; only the granularity of the evidence differs. A spread element
    /// (`[..xs]`) contributes no evidence: its elements are not visible
    /// here, so the conservative answer is "no".
    /// @param compilation The compilation being translated.
    /// @param symbol The declaration symbol to test.
    /// @param siblingCompilations Other projects loaded in the same run, or `null`.
    /// @returns `true` when a maybe-null element is written into the declaration.
    func IsGeneratedArrayElementAssignedNull(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if compilation == nil ||
            !((symbol is IFieldSymbol || symbol is IPropertySymbol)) ||
            !IsEvidenceDecidedGeneratedDeclaration(symbol) ||
            !HasPromotableArrayElement(symbol) ||
            symbol!!
            .OriginalDefinition
            .GetDocumentationCommentId() is not{} id {
            return false
        }
        // The same existential union `IsGeneratedDeclarationAssignedNull` takes,
        // and for the same reason: a declaration must translate identically
        // whichever project of the run is being emitted.
        if NullArrayElementTargets(compilation).Contains(id) {
            return true
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling != nil && NullArrayElementTargets(sibling).Contains(id) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #3848 (family B): whether [`symbol`](paramref) declares an
    /// array whose element type is an unannotated reference type — the only
    /// shape whose element slot there is anything to widen.
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when the element slot is promotable.
    func HasPromotableArrayElement(symbol ISymbol?) bool -> switch symbol {
        case field is IFieldSymbol: IsPromotableArrayElement(field.Type)
        case property is IPropertySymbol: IsPromotableArrayElement(property.Type)
        default: false
    }

    /// Issue #3848 (family A): whether [`symbol`](paramref) is promoted to
    /// `T?` because a promoted GENERATED declaration's nullability reaches
    /// it along one or more <em>pure forwarding edges</em>.
    ///
    /// <b>The rule, stated exactly.</b> A method `F` is a PURE
    /// FORWARDER of a promoted source when every one of the following holds.
    /// Each clause is a restriction; drop any one and the rule admits a shape
    /// whose value set is not the target's.
    ///
    /// 1. `F` is a `MethodDeclarationSyntax` in source — not a property getter (a property forwarding
    /// another property must keep its declared type; see the `SourceScope` remarks and #1354/#2167), not a
    /// lambda, not a local function.
    /// 2. `F`'s return type is an unannotated reference type: there is something to promote and it is not
    /// already `T?`.
    /// 3. `F` OWNS its signature — not an override, not an explicit or implicit interface implementation.
    /// Repainting an inherited return type desynchronises the two G# signatures (gsc GS0185/GS0386/GS0387),
    /// the same guard (cref:IsEvidenceDecidedGeneratedDeclaration) applies.
    /// 4. `F` is not `async`, does not return by `ref`, and contains no `yield`: in each of those the
    /// declared type is not the type of the forwarded value.
    /// 5. `F` has AT LEAST ONE exit — an arrow body, or `return` statements of its own (those inside a
    /// nested lambda or local function belong to that nested body, not to `F`). Without this clause a
    /// `=> throw new …` method would satisfy "every exit forwards" vacuously.
    /// 6. EVERY exit expression is, after stripping parentheses, DIRECTLY a call of, or a field/property
    /// read of, a symbol that is already promoted — a generated declaration with direct null evidence
    /// ((cref:IsGeneratedDeclarationAssignedNull)) or a pure forwarder found in an earlier hop. Nothing
    /// else qualifies. Not a local or parameter read (a different slot, written who-knows-where), not a
    /// conditional or switch expression (an arm may substitute a value), not `??` (which REMOVES null and
    /// would promote a method that provably never returns one), not an object creation, cast, or any other
    /// operation. If the body does anything to the value other than hand it straight back, the edge is not
    /// pure and promotion stops.
    ///
    /// <b>Multiple targets are allowed.</b> Clause 6 is per-exit, so a
    /// method with two `return`s forwarding two DIFFERENT promoted callees
    /// qualifies — its value set is the union of two promoted value sets, which
    /// is promoted. This is not a loosening: it is what the motivating site
    /// needs. `CodeLensComputer.GetDocumentUri` returns
    /// `DocumentUri.FromFileSystemPath(…)` on one path and
    /// `DocumentUri.From(fallback)` on the other, both generated and both
    /// promoted.
    ///
    /// <b>The second half: a promoted forward is write evidence, but only
    /// for GENERATED STORAGE sinks.</b> A pure-forward expression written into a
    /// FIELD or PROPERTY that (cref:IsEvidenceDecidedGeneratedDeclaration)
    /// accepts promotes that declaration too — this is what carries
    /// `GetDocumentUri`'s nullability into the generated
    /// `Location.Uri` slot instead of parking a `!!` one frame up.
    /// The generated restriction is the whole safety boundary: in generated
    /// code the C# compiler suppressed its nullable diagnostics, so the
    /// annotation was never checked against this write and the write is the
    /// better evidence. In hand-authored, nullable-ENABLED code the compiler
    /// DID check, so the annotation stands and the ordinary use-site
    /// forgiveness pass still emits its `!!` there.
    ///
    /// <b>Bounded, and seeded only from generated code.</b> The closure
    /// iterates at most (cref:MaxForwardingHops) times, so an overload
    /// chain forwarder→forwarder→real method propagates, and an arbitrarily
    /// long one does not. Every chain must terminate at a generated
    /// declaration with direct null evidence; nothing in a fully hand-authored
    /// graph can seed it. That is what keeps this from being #2113's
    /// whole-program taint fixpoint, which #3676 rejected for nullable-enabled
    /// compilations after it over-promoted the `LspJson.Options` chain
    /// across ordinary argument edges.
    /// @param compilation The compilation being translated.
    /// @param symbol The declaration symbol to test.
    /// @param siblingCompilations Other projects loaded in the same run, or `null`.
    /// @returns `true` when forwarded generated-null evidence promotes the symbol.
    func IsPromotedByPureForwarding(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if compilation == nil || symbol == nil || symbol.OriginalDefinition.GetDocumentationCommentId() is not{} id {
            return false
        }
        // Same existential union as `IsGeneratedDeclarationAssignedNull`: a
        // declaration must translate identically whichever project is being
        // emitted, so the answer is the OR over every compilation in the run.
        if ForwardingPromotions(compilation).Contains(id) {
            return true
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling != nil && ForwardingPromotions(sibling).Contains(id) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #3694: whether [`symbol`](paramref) declares — with
    /// (cref:AllowNullAttributeName) — that `null` is an accepted
    /// INPUT even though its type is annotated non-nullable. C# splits a
    /// declaration's nullability into an input and an output contract, so
    /// `[AllowNull] T P { get; set; }` means "the setter takes
    /// `T?`, the getter returns `T`". G#, like Kotlin, has ONE
    /// nullability per declaration, so the only rendering that admits the
    /// writes the C# genuinely accepts is `T?`.
    ///
    /// The answer is a property of the DECLARATION alone — no consumer
    /// evidence and no taint fixpoint — so every compilation in a run that
    /// sees the symbol computes the same result, which is what lets a
    /// cross-project write site trust that the referenced project's migrated
    /// declaration really will be nullable.
    ///
    /// The attribute is looked up on the symbol itself, on a property setter's
    /// `value` parameter (where the C# compiler also accepts it), and on
    /// the SOURCE base or interface declaration an overriding/implementing
    /// member inherits its signature from — a member whose base is
    /// `[AllowNull]` must be promoted with it or the two G# signatures no
    /// longer match (gsc GS0185/GS0386).
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when null is an accepted input for the declaration.
    func HasAllowNullWriteContract(symbol ISymbol?) bool {
        // Scoped to declarations this migration EMITS. A metadata-only symbol
        // (the BCL, a NuGet package) keeps whatever contract its assembly
        // already carries — gsc imports `[AllowNull] T` as plain `T` — so
        // widening the translator's view of it would only manufacture
        // mismatches at sites gsc still binds non-nullably.
        if symbol == nil || symbol.OriginalDefinition.DeclaringSyntaxReferences.Length == 0 {
            return false
        }
        for candidate in AllowNullContractSites(symbol.OriginalDefinition) {
            if candidate != nil && CarriesAllowNull(candidate) {
                return true
            }
        }
        return false
    }

    /// Issue #3726: whether [`symbol`](paramref) is a parameter some
    /// DATA-DRIVING attribute on its own method supplies `null` for. An
    /// xunit theory's `[InlineData(null, "x")]` states outright that the
    /// theory really is invoked with `null` for its first parameter, so
    /// the parameter is nullable however its type is spelled — and cs2gs emits
    /// the attribute with a literal `nil` beside the declaration it
    /// renders, so leaving the parameter non-nullable makes the two sides of
    /// one file contradict each other (gsc GS0274).
    ///
    /// The match is mechanical rather than xunit-specific: an attribute whose
    /// constructor is a single `params` array, applied to a method, lines
    /// its arguments up with that method's parameters positionally — the shape
    /// every data-row attribute has. `[MemberData]`/`[ClassData]`
    /// carry no literal arguments and are unaffected. A whole-array `null`
    /// (`[InlineData(null)]`, which C# binds as "the array itself is
    /// null") names no position and is likewise no evidence.
    ///
    /// Like (cref:HasAllowNullWriteContract) this is a property of the
    /// DECLARATION alone — no consumer evidence, no taint fixpoint — so every
    /// compilation in a run computes the same answer for it.
    /// @param symbol The declaration symbol to test.
    /// @returns `true` when a data attribute supplies null for the parameter.
    func HasNullDataRowArgument(symbol ISymbol?) bool {
        // Scoped to declarations this migration EMITS, for the same reason
        // HasAllowNullWriteContract is: a metadata-only method keeps whatever
        // contract its assembly already carries.
        if !(symbol is IParameterSymbol{ContainingSymbol: IMethodSymbol method} parameter) ||
            method
            .OriginalDefinition
            .DeclaringSyntaxReferences
            .Length == 0 {
            return false
        }
        // Issue #3804: not every IParameterSymbol hanging off a method occupies
        // a position in that method's parameter list. Roslyn models `this` as a
        // parameter of the enclosing method with Ordinal **-1** — and
        // SemanticModel.GetSymbolInfo hands back exactly that symbol for a
        // `this` expression, which the translator asks about whenever it
        // translates a `this.…` receiver. A data row lines its values up with
        // the declared parameters positionally, so the receiver is simply not a
        // row column and there is nothing to look up; without this guard the
        // row lookup below indexed at -1 and took the whole translate stage
        // down with an IndexOutOfRangeException (the ordinal test there guards
        // only the upper bound).
        if parameter.Ordinal < 0 {
            return false
        }
        for attribute in method.GetAttributes() {
            if attribute.AttributeConstructor is not{Parameters: {Length: 1}} constructor ||
                !constructor
                .Parameters[0]
                .IsParams ||
                attribute
                .ConstructorArguments
                .Length != 1 {
                continue
            }
            let row = attribute.ConstructorArguments[0]
            if row.Kind != TypedConstantKind.Array {
                continue
            }
            // Issue #3880: `[InlineData(null)]` is a WHOLE-ARRAY null — C#
            // binds the lone `null` as the params array itself rather than as
            // one element — and #3726 read that as naming no position and
            // therefore as no evidence. That left cs2gs and gsc contradicting
            // each other over the same source: gsc's GS0274 check reads the
            // EMITTED `@InlineData(nil)` positionally and flags parameter 0,
            // which is also what xunit does at run time for the single-column
            // theories this spelling is used on. Match gsc exactly — position
            // 0 only, so a longer parameter list gains no unsupported claim.
            if row.IsNull {
                if parameter.Ordinal == 0 {
                    return true
                }
                continue
            }
            // A data ROW never supplies more values than the method has
            // parameters; a params attribute that means something else — e.g.
            // `[MemberNotNull("Field")]`, whose strings name members rather
            // than line up with parameters — is filtered out by that shape
            // check plus the "the value must be a literal null" test below.
            if row.Values.Length > method.Parameters.Length || parameter.Ordinal >= row.Values.Length {
                continue
            }
            if row.Values[parameter.Ordinal].IsNull {
                return true
            }
        }
        return false
    }

    /// Whether [`tree`](paramref) opens with an `<auto-generated>`
    /// marker, matching the leading-trivia test the C# compiler itself uses to
    /// decide a tree is generated code. Memoized per tree.
    /// @param tree The syntax tree to test.
    /// @returns `true` when the tree is marked generated.
    func HasAutoGeneratedHeader(tree SyntaxTree?) bool {
        if tree == nil {
            return false
        }
        return GeneratedTrees.GetValue(
            tree,
            (scanned SyntaxTree) -> StrongBox[bool](
                scanned
                    .GetRoot()
                    .GetLeadingTrivia()
                    .Any(
                    (trivia SyntaxTrivia) -> trivia.ToString().Contains(
                        "<auto-generated",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
            )
        )
            .Value
    }

    /// Issue #2412: cross-project overload of (cref:IsTainted(CSharpCompilation, ISymbol)).
    /// [`compilation`](paramref)'s own whole-program taint fixpoint only
    /// walks ITS OWN syntax trees, so it never sees a referenced sibling
    /// project's tainting evidence — even for a symbol DECLARED in
    /// [`compilation`](paramref) itself, when that evidence is an
    /// interface-implementation edge (issue #2285) recorded only inside a
    /// sibling project's own fixpoint (the sibling's own source types are the
    /// ones implementing the interface). This tries [`compilation`](paramref)
    /// first (byte-identical to the two-argument overload for every existing,
    /// single-compilation caller — an empty or `null`
    /// [`siblingCompilations`](paramref) reduces to exactly that), then
    /// each of [`siblingCompilations`](paramref) in the supplied
    /// (deterministic) order, returning `true` on the first
    /// compilation whose OWN cached (cref:Compute) result proves the
    /// symbol tainted. A symbol declared in — or seeded/propagated from — ANY
    /// ONE known project's own source is a single global fact once true, so
    /// this is a plain existential OR: each candidate's result is computed
    /// (and cached, same (cref:Cache)) independently and exactly once
    /// regardless of how many times this overload is called, keeping repeated
    /// per-document queries within one run, and across a project translated
    /// both standalone and as a sibling, consistent and cheap.
    ///
    /// Deliberately scoped to [`symbol`](paramref) ITSELF (plus its
    /// remapped counterpart in each sibling) — never a same-compilation
    /// backward walk through ordinary assignment edges to some OTHER,
    /// indirectly-connected declaration. The sole exception is issue #2504's
    /// explicitly tracked named-delegate return-contract edge, whose source
    /// callable may be declared in a referenced sibling. Issue #2412's
    /// own worked example is explicit that the fix must insert `!!`
    /// forgiveness AT THE CONSUMPTION SITE while leaving the consuming
    /// project's OWN declarations (e.g. an object-initializer target
    /// property) untouched — confirmed empirically: even a fully MERGED
    /// single-compilation version of the exact LibA/LibB repro promotes the
    /// object-initializer TARGET property's own declared type too (the
    /// existing, pre-#2412 edge-based fixpoint already treats "declaration
    /// type is the join of every direct assignment" uniformly for locals,
    /// fields, AND properties alike) — a broader, transitively-propagating
    /// design here would branch further from that minimal, explicitly-scoped
    /// request than necessary, and would let ONE cross-project call site's
    /// taint silently repaint an unrelated declaration's own type everywhere
    /// else it is used in the consuming project.
    /// @param compilation The compilation of the translation unit asking about [`symbol`](paramref).
    /// @param symbol The declaration symbol to test.
    /// @param siblingCompilations Every other project's own compilation loaded in the same migration run
    /// ((cref:TranslationContext.SiblingCompilations)), or
    /// `null` when none is known.
    /// @returns `true` when any known compilation's own analysis proves the symbol null-tainted.
    func IsTainted(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        // Issue #4262: `compilation` is the ASKING translation unit's own
        // compilation, which may be nullable-ENABLED even when `symbol` is
        // declared in an oblivious SIBLING project loaded in the same
        // migration run (a nullable-enabled app calling into a
        // nullable-oblivious library project it references — e.g. Oahu's
        // nullable-enabled CLI app calling a delegate parameter declared in
        // its nullable-oblivious Core project). Bailing here purely on
        // `compilation`'s own nullable setting skipped `IsTaintedCore`'s
        // sibling walk entirely (that walk already remaps into, and checks
        // the obliviousness of, each SIBLING independently — see the loop
        // below), so a cross-project call into an oblivious sibling's
        // taint-promoted (but declared non-null) parameter never widened,
        // forcing a spurious `!!` onto a value the source legitimately
        // passes as null. Only bail when NEITHER `compilation` NOR any
        // sibling is oblivious: an oblivious-only fixpoint has nothing to
        // find anywhere in that set.
        let anyObliviousCompilation = compilation
            ?.Options
            .NullableContextOptions == NullableContextOptions.Disable ||
            siblingCompilations
            ?.Any(
            (sibling CSharpCompilation) -> sibling?.Options.NullableContextOptions == NullableContextOptions.Disable
        ) == true
        if symbol == nil || compilation == nil || !anyObliviousCompilation {
            return false
        }
        RegisterSourceAssemblies(compilation, siblingCompilations)
        return IsTaintedCore(
            compilation,
            Canonical(symbol),
            siblingCompilations,
            HashSet[ScalarQuery](ScalarQueryComparer.Instance),
            HashSet[TupleElementQuery](TupleElementQueryComparer.Instance)
        )
    }

    /// Issue #3888: whether a `params T[]` parameter's expanded ELEMENT
    /// position receives direct or transitive null evidence. This is deliberately
    /// separate from (cref:IsTainted(CSharpCompilation, ISymbol, IReadOnlyList{CSharpCompilation})),
    /// which describes the nullable array/carrier position.
    /// @param compilation The compilation containing the declaration or call evidence.
    /// @param parameter The params-array declaration whose element position is queried.
    /// @param siblingCompilations Other compilations loaded in the same translation run.
    /// @returns `true` when an expanded element can be null.
    func IsParamsElementTainted(
        compilation CSharpCompilation?,
        parameter IParameterSymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        // Issue #4262 (same shape as the sibling fix on `IsTainted` above): a
        // nullable-ENABLED consumer calling a `params T[]` declared in an
        // oblivious SIBLING must still see that sibling's own expanded-
        // element taint evidence. The candidate loop below already gates
        // each candidate — `compilation` included — on its OWN obliviousness
        // before ever touching `Cache.GetValue`, so (unlike `IsTainted`) no
        // further inner guard is needed; only this entry bail, which used to
        // fire purely on `compilation`'s own (enabled) setting before the
        // loop ran, needs widening.
        let anyObliviousCompilation = compilation
            ?.Options
            .NullableContextOptions == NullableContextOptions.Disable ||
            siblingCompilations
            ?.Any(
            (sibling CSharpCompilation) -> sibling?.Options.NullableContextOptions == NullableContextOptions.Disable
        ) == true
        if parameter == nil || compilation == nil || !anyObliviousCompilation {
            return false
        }
        // Issue #4262 follow-up: unlike `IsTainted`'s sibling walk (which
        // remaps `symbol` INTO each candidate compilation's own symbol table
        // by metadata identity before trusting that candidate's cache),
        // `ParamsElementId` matches candidates by a compilation-INDEPENDENT
        // documentation-comment-ID string. That means ANY oblivious candidate
        // in this run whose own syntax happens to call the SAME target
        // method with a literal `null` can answer this query — even an
        // oblivious project entirely unrelated to `parameter`'s actual
        // declaring project, and even when `parameter` itself is declared in
        // a nullable-ENABLED project with a genuinely non-nullable element
        // (`NullableAnnotation.NotAnnotated`, never `None` — #2113's taint
        // fixpoint is an oblivious-only heuristic with nothing trustworthy to
        // say about an explicitly-annotated declaration). Verified empirically:
        // an unrelated oblivious sibling calling an unrelated enabled
        // project's `params` method with `null` in its own source suppressed
        // the `!!` bridge (and would have repainted the enabled declaration's
        // own emitted element type nullable) for a completely different,
        // genuinely non-nullable caller elsewhere in the same run. `IsTainted`
        // avoids this by construction (a symbol query only ever resolves
        // against a candidate that remaps to the SAME declaration); mirror
        // that guarantee here the simple way, since `parameter`'s own
        // annotation is already known before any candidate is consulted:
        // only trust ANY candidate's evidence when `parameter`'s own declared
        // element position is itself oblivious.
        // Issue #4127/#4129/#4153: deliberately NOT a nested property pattern
        // (`is not IArrayTypeSymbol { ElementType.NullableAnnotation: ... }`)
        // — gsc's pattern matcher does not reliably evaluate an enum-constant
        // sub-pattern against an imported-interface-typed scrutinee
        // (`parameter.Type` is `ITypeSymbol`) once this file is itself
        // translated to G# and self-hosted; see `CSharpToGSharpTranslator
        // .Constructors.cs`'s own explicit decomposition for the identical
        // hazard. Decomposed into a plain cast plus an ordinary `!=` check.
        if parameter.Type is not IArrayTypeSymbol elementArrayType ||
            elementArrayType
            .ElementType
            .NullableAnnotation != Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .None {
            return false
        }
        let parameterId string? = ParamsElementId(parameter)
        if parameterId == nil {
            return false
        }
        RegisterSourceAssemblies(compilation, siblingCompilations)
        let candidates = []CSharpCompilation{compilation}.Concat(
            siblingCompilations ?? Enumerable.Empty[CSharpCompilation]()
        )
        for candidateCompilation in candidates.Distinct() {
            if candidateCompilation == nil ||
                candidateCompilation
                .Options
                .NullableContextOptions != NullableContextOptions.Disable {
                continue
            }
            let result = Cache.GetValue(candidateCompilation, Compute)
            if result.ParamsElementTainted.Contains(parameterId) || result.ParamsElementEdges.Any(
                (edge(Target string, Source ISymbol)) -> edge.Target == parameterId &&
                    IsTainted(candidateCompilation, edge.Source, siblingCompilations)
            ) {
                return true
            }
        }
        return false
    }

    /// Whether one reference-typed leaf inside a tuple-valued declaration is
    /// null-tainted. Tuple leaves are tracked independently so evidence for
    /// one element never widens its siblings. Only writable, genuinely
    /// oblivious source positions may be promoted.
    /// @param compilation The compilation containing the query.
    /// @param symbol The tuple-valued declaration symbol.
    /// @param elementPath Zero-based indexes from the outer tuple to the leaf.
    /// @param siblingCompilations Other compilations loaded in the same translation run.
    /// @returns `true` when the selected tuple leaf is null-tainted.
    func IsTupleElementTainted(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        elementPath IReadOnlyList[int32]?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if symbol == nil || elementPath == nil || elementPath.Count == 0 || compilation == nil {
            return false
        }
        RegisterSourceAssemblies(compilation, siblingCompilations)
        return IsTupleElementTaintedCore(
            compilation,
            symbol,
            EncodeTuplePath(elementPath),
            siblingCompilations,
            HashSet[ScalarQuery](ScalarQueryComparer.Instance),
            HashSet[TupleElementQuery](TupleElementQueryComparer.Instance)
        )
    }

    /// Whether [`expression`](paramref) reads a null-tainted tuple leaf.
    /// @param compilation The compilation containing the expression.
    /// @param expression A named or positional tuple-member expression.
    /// @param model The semantic model for the expression.
    /// @param siblingCompilations Other compilations loaded in the same translation run.
    /// @returns `true` when the selected tuple leaf is null-tainted.
    func IsTupleElementTainted(
        compilation CSharpCompilation?,
        expression ExpressionSyntax?,
        model SemanticModel?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if compilation == nil ||
            expression == nil ||
            model == nil ||
            !TryResolveTupleElementSource(expression, model, out var source) {
            return false
        }
        RegisterSourceAssemblies(compilation, siblingCompilations)
        return IsTupleElementTaintedCore(
            compilation,
            source.ContractSymbol,
            source.ContractPath,
            siblingCompilations,
            HashSet[ScalarQuery](ScalarQueryComparer.Instance),
            HashSet[TupleElementQuery](TupleElementQueryComparer.Instance)
        )
    }

    /// Issue #3663: whether [`expression`](paramref) reads a variable bound
    /// by a DECONSTRUCTING `foreach` header
    /// (`foreach ((A a, B b) in items)`) whose corresponding tuple leaf is
    /// null-tainted. Such a variable has no declared type of its own on the G#
    /// side — `for (a, b) in items` infers each name from the sequence's
    /// element tuple — so when #3641's nested-tuple promotion renders that
    /// element `A?`, every read of the variable is a nullable value the
    /// translator must bridge with `!!` at its non-null sinks. The sibling
    /// (cref:IsTupleElementTainted(CSharpCompilation, ExpressionSyntax, SemanticModel,
    /// IReadOnlyList{CSharpCompilation}))
    /// only recognizes an explicit member read (`pair.Item1`), which a
    /// deconstruction never writes.
    /// @param compilation The compilation containing the expression.
    /// @param expression A read of a deconstruction-bound variable.
    /// @param model The semantic model for the expression.
    /// @param siblingCompilations Other compilations loaded in the same translation run.
    /// @returns `true` when the bound tuple leaf is null-tainted.
    func IsDeconstructedForEachElementTainted(
        compilation CSharpCompilation?,
        expression ExpressionSyntax?,
        model SemanticModel?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) bool {
        if compilation == nil ||
            expression == nil ||
            model == nil ||
            !TryResolveForEachDeconstructionSource(expression, model, out var source) {
            return false
        }
        RegisterSourceAssemblies(compilation, siblingCompilations)
        return IsTupleElementTaintedCore(
            compilation,
            source.ContractSymbol,
            source.ContractPath,
            siblingCompilations,
            HashSet[ScalarQuery](ScalarQueryComparer.Instance),
            HashSet[TupleElementQuery](TupleElementQueryComparer.Instance)
        )
    }

    func CollectEfEntityTypes(compilation Compilation) HashSet[INamedTypeSymbol] {
        let entities = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
        for tree in compilation.SyntaxTrees {
            let model = compilation.GetSemanticModel(tree)
            for property in tree.GetRoot().DescendantNodes().OfType[PropertyDeclarationSyntax]() {
                let dbSet INamedTypeSymbol? = model.GetDeclaredSymbol(property)?.Type as INamedTypeSymbol
                if dbSet?.Name != "DbSet" ||
                    dbSet!!.Arity != 1 ||
                    dbSet!!
                    .ContainingNamespace
                    ?.ToDisplayString() != "Microsoft.EntityFrameworkCore" ||
                    dbSet!!.TypeArguments[0] is not INamedTypeSymbol entity {
                    continue
                }
                entities.Add(entity.OriginalDefinition)
            }
        }
        return entities
    }

    internal func TryGetGenericReceiverTuplePath(
        receiverType INamedTypeSymbol,
        parameter IParameterSymbol?,
        out tupleType INamedTypeSymbol?,
        out tuplePath IReadOnlyList[int32]?
    ) bool -> TryGetGenericReceiverTuplePath(
        receiverType,
        parameter?.OriginalDefinition.Type,
        out tupleType,
        out tuplePath
    )

    internal func TryGetGenericReceiverTuplePath(
        receiverType INamedTypeSymbol?,
        contractType ITypeSymbol?,
        out tupleType INamedTypeSymbol?,
        out tuplePath IReadOnlyList[int32]?
    ) bool {
        tupleType = nil
        tuplePath = nil
        if receiverType == nil ||
            contractType is not ITypeParameterSymbol typeParameter ||
            typeParameter.TypeParameterKind != TypeParameterKind.Type ||
            typeParameter.ContainingType is not INamedTypeSymbol declaringType {
            return false
        }
        if !TryResolveReceiverTypeParameterPath(
            receiverType,
            declaringType.OriginalDefinition,
            typeParameter.Ordinal,
            out var actualTuple,
            out var path
        ) {
            return false
        }
        tupleType = actualTuple
        tuplePath = path
        return true
    }

    /// The type of the value a declaration symbol denotes — a method's
    /// (awaited) return type, otherwise the declared type. Returns
    /// `null` for symbols that are not value declarations.
    /// @param symbol The candidate declaration symbol.
    /// @returns The denoted value type, or `null`.
    internal func SymbolValueType(symbol ISymbol?) ITypeSymbol? -> switch symbol {
        case method is IMethodSymbol: UnwrapAwaitedType(method.ReturnType)
        case property is IPropertySymbol: property.Type
        case field is IFieldSymbol: field.Type
        case local is ILocalSymbol: local.Type
        case parameter is IParameterSymbol: parameter.Type
        default: default(ITypeSymbol?)
    }

    internal func HasNestedTupleSlots(type ITypeSymbol?) bool -> NestedTupleSlots(type).Count != 0

    internal func GetResultConversion(expression ExpressionSyntax?, model SemanticModel) IConversionOperation? {
        if expression == nil {
            return nil
        }
        var value ExpressionSyntax? = expression
        while value is ParenthesizedExpressionSyntax || value is CheckedExpressionSyntax {
            value = if value is ParenthesizedExpressionSyntax parenthesized {
                parenthesized.Expression
            } else {
                (cast[CheckedExpressionSyntax](value)).Expression
            }
        }
        var operation IOperation? = model.GetOperation(value!!)
        while operation?.Parent is IConversionOperation parent &&
            (parent.Syntax == value || parent.Syntax == expression) {
            operation = parent
        }
        return if operation?.Syntax == value || operation?.Syntax == expression {
            operation as IConversionOperation
        } else {
            default(IConversionOperation?)
        }
    }

    internal func GetContextualOperator(
        expression ExpressionSyntax?,
        model SemanticModel,
        resultType ITypeSymbol?
    ) IMethodSymbol? {
        let operandType ITypeSymbol? = if expression == nil {
            default(ITypeSymbol?)
        } else {
            model.GetTypeInfo(expression).Type
        }
        if operandType == nil || resultType == nil {
            return nil
        }
        // Aggregate tuple conversions bind at the envelope, not each leaf.
        let conversion = model.Compilation.ClassifyConversion(operandType, resultType)
        return if conversion.IsUserDefined {
            conversion.MethodSymbol
        } else {
            default(IMethodSymbol?)
        }
    }

    internal func IsDirectlyNullable(value IOperation?, model SemanticModel, respectNullGuards bool) bool {
        if value is IConversionOperation conversion {
            // Read the converted result before the operand, including contextual
            // implicit operators. Only genuinely lifted inputs can bypass them.
            return conversion.IsTryCast ||
                (
                CanForwardCastOperandNullability(conversion) &&
                    IsDirectlyNullable(conversion.Operand, model, respectNullGuards)
            ) ||
                (
                conversion.OperatorMethod != nil &&
                    !IsNonNullableValueType(conversion.Type) &&
                    IsDeclaredNullablePosition(conversion.OperatorMethod!!.ReturnType)
            )
        }
        return value?.Syntax is ExpressionSyntax expression &&
            IsDirectlyNullable(expression, model, respectNullGuards, readConversion: false)
    }

    internal func IsSemanticallyNullableInitializer(expression ExpressionSyntax?, model SemanticModel) bool {
        if model
            .GetTypeInfo(expression!!)
            .Nullability
            .FlowState == Microsoft
            .CodeAnalysis
            .NullableFlowState
            .NotNull ||
            IsNullGuardDominatedRead(expression, model) {
            return false
        }
        let symbol ISymbol? = model.GetSymbolInfo(expression!!).Symbol
        return IsDirectlyNullable(expression, model, respectNullGuards: true) ||
            (symbol != nil && model.Compilation is CSharpCompilation compilation && IsTainted(compilation, symbol))
    }

    /// Reads the declared concrete-reference obliviousness used by imported contract readers.
    /// @param type The original signature position, before type-argument substitution.
    /// @returns Whether the position is oblivious; open slots retain their type argument's contract.
    internal func IsObliviousConcreteReferencePosition(type ITypeSymbol?) bool -> type != nil &&
        type.IsReferenceType == true &&
        !(type is ITypeParameterSymbol) &&
        type.NullableAnnotation == Microsoft
        .CodeAnalysis
        .NullableAnnotation
        .None

    // A disabled consumer reports every imported reference position as
    // Annotation.None, including metadata that explicitly says `T?`. Read the
    // top-level Nullable/NullableContext byte that gsc imports so ADR-0186's
    // `T!` shortcut applies only to genuinely oblivious values.
    internal func IsImportedStatedNullablePosition(symbol ISymbol?, compilation Compilation) bool {
        if symbol is IMethodSymbol constructorMethod && constructorMethod.MethodKind == MethodKind.Constructor {
            return false
        }
        if !((symbol is IMethodSymbol || symbol is IPropertySymbol || symbol is IFieldSymbol)) ||
            SymbolEqualityComparer
            .Default
            .Equals(symbol!!.ContainingAssembly, compilation.Assembly) {
            return false
        }
        if IsDeclaredNullablePosition(EffectiveImportedPositionType(symbol)) {
            return true
        }
        let positionAttributes = switch symbol {
            case method is IMethodSymbol: method.GetReturnTypeAttributes()
            case property is IPropertySymbol: property.GetAttributes()
            case field is IFieldSymbol: field.GetAttributes()
            default: default(ImmutableArray[AttributeData])
        }
        if MetadataNullabilityFlag(
            positionAttributes,
            "System.Runtime.CompilerServices.NullableAttribute"
        ) is uint8 positionFlag {
            return positionFlag == uint8(2)
        }
        for var current ISymbol? = symbol; current != nil; current = current!!.ContainingSymbol {
            if MetadataNullabilityFlag(
                current.GetAttributes(),
                "System.Runtime.CompilerServices.NullableContextAttribute"
            ) is uint8 contextFlag {
                return contextFlag == uint8(2)
            }
        }
        return false
    }

    internal func IsReturnSignatureFixedByAnotherDeclaration(
        method IMethodSymbol?
    ) bool -> IsSignatureFixedByAnotherDeclaration(method)

    private func EffectiveImportedPositionType(symbol ISymbol?) ITypeSymbol? {
        let type ITypeSymbol? = switch symbol {
            case method is IMethodSymbol: method.ReturnType
            case property is IPropertySymbol: property.Type
            case field is IFieldSymbol: field.Type
            default: default(ITypeSymbol?)
        }
        if IsDeclaredNullablePosition(type) {
            return type
        }
        let originalType ITypeSymbol? = switch symbol {
            case method is IMethodSymbol: method.OriginalDefinition.ReturnType
            case property is IPropertySymbol: property.OriginalDefinition.Type
            case field is IFieldSymbol: field.OriginalDefinition.Type
            default: default(ITypeSymbol?)
        }
        if originalType is not ITypeParameterSymbol parameter {
            return type
        }
        if parameter.TypeParameterKind == TypeParameterKind.Method &&
            symbol is IMethodSymbol methodSymbol &&
            parameter.Ordinal < methodSymbol
            .TypeArguments
            .Length {
            return methodSymbol.TypeArguments[parameter.Ordinal]
        }
        for var containingType INamedTypeSymbol? = symbol!!.ContainingType;
            containingType != nil;
            containingType = containingType!!
            .ContainingType {
            if parameter.TypeParameterKind == TypeParameterKind.Type && SymbolEqualityComparer.Default.Equals(
                containingType.OriginalDefinition,
                parameter.ContainingSymbol
            ) &&
                parameter.Ordinal < containingType
                .TypeArguments
                .Length {
                return containingType.TypeArguments[parameter.Ordinal]
            }
        }
        return type
    }

    private func MetadataNullabilityFlag(attributes ImmutableArray[AttributeData], attributeName string) uint8? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        let attribute AttributeData? = attributes.FirstOrDefault(
            (candidate AttributeData) -> candidate.AttributeClass?.ToDisplayString() == attributeName
        )
        if attribute == nil || attribute.ConstructorArguments.Length != 1 {
            return nil
        }
        let argument = attribute.ConstructorArguments[0]
        if argument.Kind != TypedConstantKind.Array && argument.Value is uint8 scalar {
            return scalar
        }
        return if argument.Kind == TypedConstantKind.Array &&
            argument
            .Values
            .Length > 0 &&
            argument
            .Values[0]
            .Value is uint8 first {
            first
        } else {
            nil
        }
    }

    private func IsTaintedCore(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?,
        scalarVisited HashSet[ScalarQuery],
        tupleVisited HashSet[TupleElementQuery]
    ) bool {
        let query = ScalarQuery(compilation, Canonical(symbol))
        if !scalarVisited.Add(query) {
            return false
        }
        // Issue #4262: `Compute`'s heuristics (a bare `= null` assignment
        // taints its target, an argument-to-parameter edge propagates that
        // taint into the callee) read raw SYNTAX because oblivious code
        // carries no trustworthy nullable annotation to read instead. Running
        // them against a nullable-ENABLED `compilation` is unsound — its own
        // `T?` locals are LEGITIMATELY, deliberately null-initialized (that is
        // what the annotation means), and an edge from such a local into a
        // cross-project call argument would self-taint the callee's
        // parameter from evidence that was never oblivious in the first
        // place, defeating the callee's OWN (correctly gated) taint result.
        // Only ever consult `compilation`'s own cached fixpoint when
        // `compilation` ITSELF is oblivious; an enabled `compilation` reaches
        // this frame only as the top-level query's asking compilation (see
        // `IsTainted`) — every RECURSIVE call below (`DelegateReturnEdges`,
        // `ScalarTupleEdges`, and the sibling walk's own re-entry) is already
        // nested inside this very `Disable` check, so only the SIBLING walk
        // further down can ever answer for an enabled `compilation`.
        if compilation!!.Options.NullableContextOptions == NullableContextOptions.Disable {
            let result = Cache.GetValue(compilation!!, Compute)
            if result.Tainted.Contains(query.Symbol!!) {
                return true
            }
            for (target, source) in result.ScalarTupleEdges {
                if SymbolEqualityComparer.Default.Equals(target, query.Symbol) &&
                    IsTupleElementTaintedCore(
                    compilation,
                    source.ContractSymbol,
                    source.ContractPath,
                    siblingCompilations,
                    scalarVisited,
                    tupleVisited
                ) {
                    return true
                }
            }
            for (target, source) in result.DelegateReturnEdges {
                if SymbolEqualityComparer.Default.Equals(target, query.Symbol) &&
                    IsTaintedCore(compilation, source, siblingCompilations, scalarVisited, tupleVisited) {
                    return true
                }
            }
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling == nil || object.ReferenceEquals(sibling, compilation) ||
                    sibling
                    .Options
                    .NullableContextOptions != NullableContextOptions.Disable {
                    continue
                }
                // Remap identical linked-source declarations first, then fall
                // back to stable metadata identity before testing the sibling
                // compilation's own cached graph.
                let remapped ISymbol? = RemapToCompilation(sibling, query.Symbol)
                if remapped != nil &&
                    IsTaintedCore(sibling, Canonical(remapped), siblingCompilations, scalarVisited, tupleVisited) {
                    return true
                }
            }
        }
        return false
    }

    private func IsTupleElementTaintedCore(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        path string,
        siblingCompilations IReadOnlyList[CSharpCompilation]?,
        scalarVisited HashSet[ScalarQuery],
        tupleVisited HashSet[TupleElementQuery]
    ) bool {
        var symbol = symbol
        symbol = OwningMember(symbol)
        if !CanPromoteTuplePosition(compilation, symbol, path) {
            return false
        }
        let key = TupleElementKey(symbol, path)
        if !tupleVisited.Add(TupleElementQuery(compilation, key)) {
            return false
        }
        let result = Cache.GetValue(compilation!!, Compute)
        let hasOtherSiblings = siblingCompilations != nil && siblingCompilations.Any(
            (sibling CSharpCompilation) -> sibling != nil && !object.ReferenceEquals(sibling, compilation)
        )
        if result.FixedTupleContracts.Contains(key) ||
            (
            hasOtherSiblings &&
                IsTupleContractFixedCore(
                compilation,
                symbol,
                path,
                siblingCompilations,
                HashSet[TupleElementQuery](TupleElementQueryComparer.ContractInstance)
            )
        ) {
            return false
        }
        if result.TupleTainted.Contains(key) {
            return true
        }
        for (target, source) in result.TupleScalarEdges {
            if TupleElementKeyComparer.Instance.Equals(target, key) &&
                IsTaintedCore(compilation, source, siblingCompilations, scalarVisited, tupleVisited) {
                return true
            }
        }
        for (target, source) in result.TupleEdges {
            if TupleElementKeyComparer.Instance.Equals(target, key) &&
                IsTupleElementTaintedCore(
                compilation,
                source.ContractSymbol,
                source.ContractPath,
                siblingCompilations,
                scalarVisited,
                tupleVisited
            ) {
                return true
            }
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling == nil || object.ReferenceEquals(sibling, compilation) {
                    continue
                }
                let remapped ISymbol? = RemapToCompilation(sibling, symbol)
                if remapped != nil &&
                    IsTupleElementTaintedCore(
                    sibling,
                    Canonical(remapped),
                    path,
                    siblingCompilations,
                    scalarVisited,
                    tupleVisited
                ) {
                    return true
                }
            }
        }
        return false
    }

    private func IsTupleContractFixedCore(
        compilation CSharpCompilation?,
        symbol ISymbol?,
        path string,
        siblingCompilations IReadOnlyList[CSharpCompilation]?,
        visited HashSet[TupleElementQuery]
    ) bool {
        var symbol = symbol
        symbol = OwningMember(symbol)
        let key = TupleElementKey(symbol, path)
        if !visited.Add(TupleElementQuery(compilation, key)) {
            return false
        }
        let result = Cache.GetValue(compilation!!, Compute)
        if result.FixedTupleContracts.Contains(key) {
            return true
        }
        for (target, source) in result.TupleContractEdges {
            if TupleContractKeyComparer.Instance.Equals(target, key) &&
                IsTupleContractFixedCore(
                compilation,
                source.ContractSymbol,
                source.ContractPath,
                siblingCompilations,
                visited
            ) {
                return true
            }
        }
        if siblingCompilations != nil {
            for sibling in siblingCompilations {
                if sibling == nil || object.ReferenceEquals(sibling, compilation) {
                    continue
                }
                let remapped ISymbol? = RemapToCompilation(sibling, symbol)
                if remapped != nil && IsTupleContractFixedCore(sibling, remapped, path, siblingCompilations, visited) {
                    return true
                }
            }
        }
        return false
    }

    /// Finds the symbol in [`targetCompilation`](paramref)'s own symbol
    /// table that is the "same" declaration as [`symbol`](paramref),
    /// which may have been resolved through an entirely different
    /// (cref:CSharpCompilation). A declaration from an identical linked
    /// source is matched first by path, file content and source span. Other
    /// symbols fall back to stable metadata identity (assembly, constructed
    /// containing type and original member signature). Cross-compilation
    /// matching never uses (cref:SymbolEqualityComparer) or CLR object
    /// identity, since those do not hold across independently bound
    /// compilations (see the long comment on the calling overload). Returns
    /// `null` when no matching declaration exists in
    /// [`targetCompilation`](paramref) (e.g. `symbol` is unrelated to it).
    private func RemapToCompilation(targetCompilation Compilation?, symbol ISymbol?) ISymbol? {
        if symbol is ITypeSymbol type {
            if type is IArrayTypeSymbol array {
                let element ITypeSymbol? = RemapToCompilation(targetCompilation, array.ElementType) as ITypeSymbol
                return if element == nil {
                    default(ITypeSymbol?)
                } else {
                    targetCompilation!!.CreateArrayTypeSymbol(element, array.Rank, array.ElementNullableAnnotation)
                        .WithNullableAnnotation(array.NullableAnnotation)
                }
            }
            let sourceDeclaration ISymbol? = RemapSourceDeclaration(targetCompilation, symbol)
            var remapped ITypeSymbol? = sourceDeclaration as ITypeSymbol
            if remapped == nil {
                let reference string? = DocumentationCommentId.CreateReferenceId(symbol)
                remapped = if reference == nil {
                    default(ITypeSymbol?)
                } else {
                    DocumentationCommentId
                        .GetSymbolsForReferenceId(reference, targetCompilation!!)
                        .OfType[ITypeSymbol]()
                        .FirstOrDefault(
                        (candidate ITypeSymbol) -> object.Equals(
                            candidate.ContainingAssembly?.Identity,
                            symbol.ContainingAssembly?.Identity
                        )
                    )
                }
            }
            if type is INamedTypeSymbol nested && nested.ContainingType is {IsDefinition: false} containing {
                let mappedOwner INamedTypeSymbol? = RemapToCompilation(
                    targetCompilation,
                    containing
                ) as INamedTypeSymbol
                remapped = mappedOwner?.GetTypeMembers(nested.Name, nested.Arity).FirstOrDefault()
            }
            if type is INamedTypeSymbol named &&
                !named.IsDefinition &&
                remapped is INamedTypeSymbol mappedNamed &&
                named.Arity != 0 {
                let arguments = [named.TypeArguments.Length]ITypeSymbol?
                for var index = 0; index < arguments.Length; index++ {
                    let mappedArgument ITypeSymbol? = RemapToCompilation(
                        targetCompilation,
                        named.TypeArguments[index]
                    ) as ITypeSymbol
                    if mappedArgument == nil {
                        return nil
                    }
                    arguments[index] = mappedArgument
                }
                remapped = mappedNamed.ConstructedFrom.Construct(
                    arguments.ToImmutableArray(),
                    named.TypeArgumentNullableAnnotations
                )
            }
            return remapped?.WithNullableAnnotation(type.NullableAnnotation)
        }
        if symbol is IParameterSymbol parameter {
            let sourceDeclaration ISymbol? = RemapSourceDeclaration(targetCompilation, symbol)
            let remappedOwner ISymbol? = RemapMemberOwner(targetCompilation, parameter.ContainingSymbol)
            // Issue #3804: the ordinal is bounded on BOTH sides, defensively.
            // Roslyn's `this` parameter hangs off its method with Ordinal -1
            // and holds no position in the parameter list, so there is nothing
            // to remap it to; an upper-bound-only test would index at -1, the
            // exact shape of the #3804 translate crash.
            if parameter.Ordinal < 0 {
                return nil
            }
            return switch remappedOwner {
                case method is IMethodSymbol when parameter.Ordinal < method
                    .Parameters
                    .Length: method.Parameters[parameter.Ordinal]
                case indexer is IPropertySymbol when parameter.Ordinal < indexer
                    .Parameters
                    .Length: indexer.Parameters[parameter.Ordinal]
                default: sourceDeclaration as IParameterSymbol
            }
        }
        return RemapMemberOwner(targetCompilation, symbol)
    }

    private func RemapSourceDeclaration(targetCompilation Compilation?, symbol ISymbol?) ISymbol? {
        let pathComparer = if OperatingSystem.IsWindows() {
            StringComparer.OrdinalIgnoreCase
        } else {
            StringComparer.Ordinal
        }
        let targetTrees = SourceTrees.GetValue(
            targetCompilation!!,
            func (compilation Compilation) Dictionary[string, []SyntaxTree] {
                return compilation
                    .SyntaxTrees
                    .Where((tree SyntaxTree) -> !string.IsNullOrEmpty(tree.FilePath))
                    .GroupBy((tree SyntaxTree) -> tree.FilePath, pathComparer)
                    .ToDictionary(
                    func (group IGrouping[string, SyntaxTree]) string {
                        return group.Key
                    },
                    (group IGrouping[string, SyntaxTree]) -> group.ToArray(),
                    pathComparer
                )
            }
        )
        for declaration in symbol!!.OriginalDefinition.DeclaringSyntaxReferences {
            let path = declaration.SyntaxTree.FilePath
            if string.IsNullOrEmpty(path) || !targetTrees.TryGetValue(path, out var candidates) {
                continue
            }
            for targetTree in candidates {
                if !declaration.SyntaxTree.GetText().ContentEquals(targetTree.GetText()) {
                    continue
                }
                let node = targetTree.GetRoot().FindNode(declaration.Span, getInnermostNodeForTie: true)
                let sourceNode = declaration.GetSyntax()
                if node.Span != declaration.Span || node.RawKind != sourceNode.RawKind {
                    continue
                }
                let remapped ISymbol? = targetCompilation!!.GetSemanticModel(targetTree).GetDeclaredSymbol(node)
                if remapped != nil {
                    return remapped
                }
            }
        }
        return nil
    }

    /// Remaps a field/property/method/local-owning member symbol (everything
    /// (cref:RemapToCompilation) handles other than parameters
    /// themselves) into [`targetCompilation`](paramref)'s own symbol
    /// table by identical linked source or by original signature and
    /// constructed containing type. Locals and local functions have no metadata
    /// identity, so only the linked-source path can remap them.
    private func RemapMemberOwner(targetCompilation Compilation?, symbol ISymbol?) ISymbol? {
        if symbol == nil {
            return nil
        }
        let sourceDeclaration ISymbol? = RemapSourceDeclaration(targetCompilation, symbol)
        let declarationId string? = symbol.OriginalDefinition.GetDocumentationCommentId()
        var remapped ISymbol?
        if sourceDeclaration != nil &&
            (
            declarationId == nil ||
                symbol is ILocalSymbol ||
                (symbol is IMethodSymbol localFunction && localFunction.MethodKind == MethodKind.LocalFunction)
        ) {
            remapped = sourceDeclaration
        } else {
            let containingType INamedTypeSymbol? = symbol.ContainingType
            if containingType == nil {
                return nil
            }
            let remappedType INamedTypeSymbol? = RemapToCompilation(
                targetCompilation,
                containingType
            ) as INamedTypeSymbol
            if remappedType == nil || declarationId == nil {
                return nil
            }
            remapped = remappedType.GetMembers(symbol.Name).FirstOrDefault(
                (candidate ISymbol) -> candidate.Kind == symbol.Kind &&
                    (
                    sourceDeclaration != nil || object.Equals(
                        candidate.ContainingAssembly?.Identity,
                        symbol.ContainingAssembly?.Identity
                    )
                ) &&
                    string.Equals(
                    candidate.OriginalDefinition.GetDocumentationCommentId(),
                    declarationId,
                    StringComparison.Ordinal
                )
            )
        }
        if remapped is IMethodSymbol remappedMethod &&
            symbol is IMethodSymbol method &&
            !SymbolEqualityComparer
            .Default
            .Equals(method, method.ConstructedFrom) {
            let arguments = [method.TypeArguments.Length]ITypeSymbol?
            for var index = 0; index < arguments.Length; index++ {
                let argument = method.TypeArguments[index]
                let mappedArgument ITypeSymbol? = RemapToCompilation(targetCompilation, argument) as ITypeSymbol
                if mappedArgument == nil {
                    return nil
                }
                arguments[index] = mappedArgument
            }
            return remappedMethod.Construct(arguments)
        }
        return remapped
    }

    // Every member of `compilation` that some source in it directly writes
    // `null`/`default` into, keyed by documentation-comment id so the answer is
    // comparable across the separate compilations one migration run loads.
    // Computed once per compilation.
    private func NullAssignmentTargets(compilation CSharpCompilation?) HashSet[string] -> NullTargets.GetValue(
        compilation!!,
        ComputeNullAssignmentTargets
    )

    private func ComputeNullAssignmentTargets(compilation Compilation) HashSet[string] {
        let targets = HashSet[string](StringComparer.Ordinal)
        for tree in compilation.SyntaxTrees {
            var model SemanticModel? = nil
            for node in tree.GetRoot().DescendantNodes() {
                let Model = func () SemanticModel {
                    return (
                        if model == nil {
                            (model = compilation.GetSemanticModel(tree))
                        } else {
                            model
                        }
                    )!!
                }
                let target ISymbol? = switch node {
                    case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                        SyntaxKind.SimpleAssignmentExpression
                    ) &&
                        WritesNull(Model(), assignment.Right): Model().GetSymbolInfo(assignment.Left).Symbol
                    case initializer is EqualsValueClauseSyntax when WritesNull(Model(), initializer.Value) &&
                        (
                        initializer.Parent is VariableDeclaratorSyntax or PropertyDeclarationSyntax
                    ): Model().GetDeclaredSymbol(initializer.Parent!!)
                    case returned is ReturnStatementSyntax when WritesNull(Model(), returned.Expression): OwningMember(
                        Model().GetEnclosingSymbol(returned.SpanStart)
                    )
                    case arrow is ArrowExpressionClauseSyntax when WritesNull(Model(), arrow.Expression): OwningMember(
                        Model().GetDeclaredSymbol(arrow.Parent!!)
                    )
                    default: default(ISymbol?)
                }
                if target?.OriginalDefinition.GetDocumentationCommentId() is {} id {
                    targets.Add(id)
                }
            }
        }
        return targets
    }

    // Issue #5508: the DECLARATION a null-argument decision is about. A call
    // binds the constructed member (`Box<string>(string value)`), whose
    // substituted `string` hides that the declaration is a bare `T` that can
    // never be repainted `T?`; every eligibility test reads the original.
    private func OriginalNullArgumentDeclaration(symbol ISymbol?) ISymbol? -> switch symbol {
        case parameter is IParameterSymbol: ReducedExtensionParameter(parameter).OriginalDefinition
        case method is IMethodSymbol: (method.ReducedFrom ?? method).OriginalDefinition
        case property is IPropertySymbol: property.OriginalDefinition
        case field is IFieldSymbol: field.OriginalDefinition
        default: default(ISymbol?)
    }

    // A call `receiver.Keep(value)` binds the REDUCED extension method, whose
    // parameter list drops the `this` parameter: its ordinal 0 is the
    // unreduced method's ordinal 1. The declaration (and its key) is the
    // unreduced one.
    private func ReducedExtensionParameter(parameter IParameterSymbol) IParameterSymbol {
        if parameter.ContainingSymbol is IMethodSymbol{ReducedFrom: {} unreduced} &&
            parameter.Ordinal +
            1 < unreduced
            .Parameters
            .Length {
            return unreduced.Parameters[parameter.Ordinal + 1]
        }
        return parameter
    }

    // Issue #5508: whether `symbol` (an ORIGINAL declaration) may be repainted
    // `T?` by null-argument evidence. It must own its signature (see
    // `IsSignatureFixedByAnotherDeclaration`) and — for a member another
    // declaration could override — not be virtual or abstract, because the
    // overrides keep the base's type and would stop matching it. A positional
    // record parameter is one declaration with its synthesized property, so the
    // property's contract (an interface it implements, a base it overrides)
    // fixes the parameter too. Whether the declaration is emitted by this
    // migration is NOT asked here: a call bound through a reference assembly is
    // still evidence about the source declaration in the sibling project.
    private func IsNullArgumentCandidate(symbol ISymbol?) bool {
        switch symbol {
            case parameter is IParameterSymbol {
                if parameter.Ordinal < 0 ||
                    !IsRepaintableReference(parameter.Type) ||
                    parameter.RefKind != RefKind.None ||
                    parameter.IsParams ||
                    parameter.ContainingSymbol is not IMethodSymbol{
                    MethodKind: MethodKind.Constructor or MethodKind.Ordinary
                } method ||
                    method.IsVirtual ||
                    method.IsAbstract {
                    return false
                }
                // A positional record's parameter and its synthesized property
                // are one declaration: the property's contract decides.
                if PositionalProperty(parameter, method) is {} positional {
                    return IsNullArgumentCandidate(positional)
                }
                return !IsSignatureFixedByAnotherDeclaration(parameter)
            }
            case method is IMethodSymbol {
                return method.MethodKind == MethodKind.Ordinary &&
                    !method.IsAsync &&
                    !method.IsVirtual &&
                    !method.IsAbstract &&
                    !method.ReturnsByRef &&
                    IsRepaintableReference(method.ReturnType) &&
                    !IsSignatureFixedByAnotherDeclaration(method)
            }
            case property is IPropertySymbol {
                return IsRepaintableReference(property.Type) &&
                    !property.IsVirtual &&
                    !property.IsAbstract &&
                    !IsSignatureFixedByAnotherDeclaration(property)
            }
            case field is IFieldSymbol {
                return IsRepaintableReference(field.Type)
            }
            default {
                return false
            }
        }
    }

    // The property a positional-record constructor parameter synthesizes: same
    // name, declared by the very `ParameterSyntax` the parameter is. Null for
    // every other parameter.
    private func PositionalProperty(parameter IParameterSymbol, method IMethodSymbol) IPropertySymbol? {
        if method.MethodKind != MethodKind.Constructor || !method.ContainingType.IsRecord {
            return default(IPropertySymbol?)
        }
        let syntax = parameter.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
        if syntax == nil {
            return default(IPropertySymbol?)
        }
        for member in method.ContainingType.GetMembers(parameter.Name) {
            if member is IPropertySymbol property &&
                property
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() == syntax {
                return property
            }
        }
        return default(IPropertySymbol?)
    }

    // Issue #5508 follow-up: a slot this rule can repaint `T?` is a reference type the C#
    // declares NOT annotated. An already-`T?` parameter is no seed (its null is
    // the declaration's own), and — the Adr0169 GSA0005 witness — it is no
    // forwarding source either: `FollowHelper(.., model, ..)` under
    // `when model != null` hands a value the C# flow proved non-null to a `T`
    // parameter, and widening that parameter would make its body read a `T?`.
    private func IsRepaintableReference(type ITypeSymbol?) bool -> type is {IsReferenceType: true} reference &&
        reference.NullableAnnotation != Microsoft
        .CodeAnalysis
        .NullableAnnotation
        .Annotated

    // Issue #5508: the compilation-independent identities of a candidate, every
    // one of which stands for the same declaration. The documentation id alone
    // is not an identity across a run — two unrelated projects can declare the
    // same fully qualified type and method — so the first key is qualified by
    // the declaring assembly's NAME (a project's source and its emitted
    // reference assembly agree on it). A declaration compiled from a LINKED
    // source file is one declaration in several assemblies and must decide the
    // same everywhere (the repository mirror rejects divergent outputs), so a
    // source declaration also answers to a key qualified by its file path.
    // A parameter is its method's id plus its ordinal; a method's RETURN is the
    // method id alone.
    private func NullArgumentKeys(symbol ISymbol?) List[string] {
        let keys = List[string]()
        let owner ISymbol? = if symbol is IParameterSymbol{ContainingSymbol: {} container} {
            container
        } else {
            symbol
        }
        let ownerId string? = owner?.OriginalDefinition.GetDocumentationCommentId()
        if symbol == nil || owner == nil || ownerId == nil {
            return keys
        }
        let id = if symbol is IParameterSymbol parameter {
            "P:" + ownerId + "#" + parameter.Ordinal.ToString(CultureInfo.InvariantCulture)
        } else {
            ownerId
        }
        keys.Add((symbol.ContainingAssembly?.Name ?? "") + "|" + id)
        let path string? = owner.OriginalDefinition.DeclaringSyntaxReferences.FirstOrDefault()?.SyntaxTree.FilePath
        if !string.IsNullOrEmpty(path) {
            keys.Add("@" + path + "|" + id)
        }
        return keys
    }

    // `null`, `null!`, `default`, a parenthesized form, or a conditional with
    // such an arm: the argument shapes in which the AUTHOR writes null. Purely
    // syntactic on purpose — a `T?`-typed local passed to a `T` parameter is
    // the C# compiler's warning to act on, not an author's declaration.
    private func ArgumentWritesNull(expression ExpressionSyntax?) bool {
        switch expression {
            case parenthesized is ParenthesizedExpressionSyntax {
                return ArgumentWritesNull(parenthesized.Expression)
            }
            case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                return ArgumentWritesNull(suppress.Operand)
            }
            case conditional is ConditionalExpressionSyntax {
                return ArgumentWritesNull(conditional.WhenTrue) || ArgumentWritesNull(conditional.WhenFalse)
            }
            case literal is LiteralExpressionSyntax {
                return literal.IsKind(SyntaxKind.NullLiteralExpression) || literal.IsKind(
                    SyntaxKind.DefaultLiteralExpression
                )
            }
            case _ is DefaultExpressionSyntax {
                return true
            }
            default {
                return false
            }
        }
    }

    private func CallArgumentList(node SyntaxNode) ArgumentListSyntax? -> switch node {
        case invocation is InvocationExpressionSyntax: invocation.ArgumentList
        case creation is BaseObjectCreationExpressionSyntax: creation.ArgumentList
        case initializer is ConstructorInitializerSyntax: initializer.ArgumentList
        default: default(ArgumentListSyntax?)
    }

    // `GetCallArguments` answers a DEFAULT array (not an empty one) when the node
    // binds to no call, and enumerating a default array throws.
    private func CallArgumentOperations(node SyntaxNode, model SemanticModel) ImmutableArray[IArgumentOperation] {
        let arguments = GetCallArguments(node, model)
        return if arguments.IsDefault {
            ImmutableArray[IArgumentOperation].Empty
        } else {
            arguments
        }
    }

    // Pass 1 (cheap): the declarations some call passes a null literal into.
    // The syntactic prefilter keeps `GetOperation` off every call that has no
    // such argument.
    private func ComputeNullArgumentSeeds(compilation Compilation) NullArgumentGraph {
        let seeds = HashSet[string](StringComparer.Ordinal)
        for tree in compilation.SyntaxTrees {
            let model = compilation.GetSemanticModel(tree)
            for node in tree.GetRoot().DescendantNodes() {
                let list = CallArgumentList(node)
                if list == nil || !list.Arguments.Any(
                    (a ArgumentSyntax) -> a.RefKindKeyword.IsKind(SyntaxKind.None) && ArgumentWritesNull(a.Expression)
                ) {
                    continue
                }
                for argument in CallArgumentOperations(node, model) {
                    if argument.Parameter is {} parameter &&
                        argument
                        .Value
                        ?.Syntax is ExpressionSyntax value &&
                        ArgumentWritesNull(value) &&
                        OriginalNullArgumentDeclaration(parameter) is {} original &&
                        IsNullArgumentCandidate(original) {
                        for key in NullArgumentKeys(original) {
                            seeds.Add(key)
                        }
                    }
                }
            }
        }
        return NullArgumentGraph(compilation, seeds)
    }

    // Pass 2: the pure-forwarding edges, built once per compilation, and only
    // when some compilation of the run has a seed. An edge `target <- source`
    // records that `source`, a PARAMETER, hands its value on unchanged to
    // `target` (a parameter, field or property).
    private func EnsureNullArgumentForwarding(graph NullArgumentGraph) {
        if graph.ForwardingBuilt {
            return
        }
        let owner = graph.Owner
        graph.ForwardingBuilt = true
        let AddEdge = func (target ISymbol?, source ISymbol?) {
            let targetOriginal = OriginalNullArgumentDeclaration(target)
            let sourceOriginal = OriginalNullArgumentDeclaration(source)
            if targetOriginal != nil &&
                sourceOriginal != nil &&
                IsNullArgumentCandidate(targetOriginal) &&
                IsNullArgumentCandidate(sourceOriginal) {
                let sourceKeys = NullArgumentKeys(sourceOriginal)
                for targetKey in NullArgumentKeys(targetOriginal) {
                    if !graph.Incoming.TryGetValue(targetKey, out var sources) {
                        sources = List[string]()
                        graph.Incoming[targetKey] = sources
                    }
                    for sourceKey in sourceKeys {
                        if !sources.Contains(sourceKey) {
                            sources.Add(sourceKey)
                        }
                    }
                }
            }
        }
        for tree in owner.SyntaxTrees {
            let model = owner.GetSemanticModel(tree)
            for node in tree.GetRoot().DescendantNodes() {
                if node is AssignmentExpressionSyntax assignment && assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    ReadsEnclosingParameterByName(assignment.Right) {
                    let target ISymbol? = model.GetSymbolInfo(assignment.Left).Symbol
                    if target is IFieldSymbol or IPropertySymbol {
                        AddEdge(target, model.GetSymbolInfo(Unwrap(assignment.Right)).Symbol)
                    }
                } else if (
                    node is ReturnStatementSyntax{Expression: {} returned} && ReadsEnclosingParameterByName(returned)
                ) {
                    // `return p;` hands the parameter's value on as the method's
                    // result: the result must be as nullable as the parameter.
                    if EnclosingNamedMethod(node) is {} declaration && model.GetDeclaredSymbol(
                        declaration
                    ) is {} method {
                        AddEdge(method, model.GetSymbolInfo(Unwrap(returned)).Symbol)
                    }
                } else if (
                    node is ArrowExpressionClauseSyntax{Parent: MethodDeclarationSyntax arrowMethod} arrow &&
                        ReadsEnclosingParameterByName(arrow.Expression)
                ) {
                    if model.GetDeclaredSymbol(arrowMethod) is {} method {
                        AddEdge(method, model.GetSymbolInfo(Unwrap(arrow.Expression)).Symbol)
                    }
                } else if CallArgumentList(node) is {} list && list.Arguments.Any(
                    (a ArgumentSyntax) -> a.RefKindKeyword.IsKind(SyntaxKind.None) &&
                        ReadsEnclosingParameterByName(a.Expression)
                ) {
                    for argument in CallArgumentOperations(node, model) {
                        if argument.Parameter is {} parameter &&
                            argument
                            .Value
                            ?.Syntax is ExpressionSyntax value &&
                            ReadsEnclosingParameterByName(value) {
                            AddEdge(parameter, model.GetSymbolInfo(Unwrap(value)).Symbol)
                        }
                    }
                }
            }
        }
    }

    // The method declaration whose body directly contains `node`: not a lambda
    // or a local function nested in it, whose `return` is not the method's.
    private func EnclosingNamedMethod(node SyntaxNode) MethodDeclarationSyntax? {
        let function = node.Ancestors().FirstOrDefault(
            (n SyntaxNode) -> n is BaseMethodDeclarationSyntax ||
                n is LocalFunctionStatementSyntax ||
                n is AnonymousFunctionExpressionSyntax
        )
        return function as MethodDeclarationSyntax
    }

    // The expression with its parentheses removed. A `q!` is NOT unwrapped: the
    // author asserted `q` non-null there, so the value is no longer "the
    // parameter unchanged".
    private func Unwrap(expression ExpressionSyntax) ExpressionSyntax {
        var current = expression
        while current is ParenthesizedExpressionSyntax parenthesized {
            current = parenthesized.Expression
        }
        return current
    }

    // Syntactic prefilter for a forwarding edge: a bare identifier that names a
    // parameter of the enclosing method or constructor. The semantic check that
    // follows decides; this only keeps the semantic model off other nodes.
    private func ReadsEnclosingParameterByName(expression ExpressionSyntax) bool {
        if Unwrap(expression) is not IdentifierNameSyntax name {
            return false
        }
        let method = name.Ancestors().OfType[BaseMethodDeclarationSyntax]().FirstOrDefault()
        return method
            ?.ParameterList
            .Parameters
            .Any((p ParameterSyntax) -> p.Identifier.ValueText == name.Identifier.ValueText) ??
            false
    }

    // Issue #3848 (family B): every generated ARRAY-typed member of
    // `compilation` that some source writes an array-shaped literal with a
    // maybe-null ELEMENT into. Keyed and cached exactly like `NullTargets`.
    private func NullArrayElementTargets(compilation CSharpCompilation?) HashSet[string] -> NullElementTargets.GetValue(
        compilation!!,
        ComputeNullArrayElementTargets
    )

    private func ComputeNullArrayElementTargets(compilation Compilation) HashSet[string] {
        let targets = HashSet[string](StringComparer.Ordinal)
        for tree in compilation.SyntaxTrees {
            var model SemanticModel? = nil
            for node in tree.GetRoot().DescendantNodes() {
                let Model = func () SemanticModel {
                    return (
                        if model == nil {
                            (model = compilation.GetSemanticModel(tree))
                        } else {
                            model
                        }
                    )!!
                }
                // The same two node shapes `ComputeNullAssignmentTargets`
                // collects — `x.Member = […]`, which is also the
                // object-initializer member `new T { Member = […] }`, and a
                // field/property initializer. Only the granularity of the
                // evidence read out of them differs.
                let write(Target ISymbol?, Value ExpressionSyntax?) = switch node {
                    case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                        SyntaxKind.SimpleAssignmentExpression
                    ): (Model().GetSymbolInfo(assignment.Left).Symbol, assignment.Right)
                    case EqualsValueClauseSyntax{
                        Parent: VariableDeclaratorSyntax or PropertyDeclarationSyntax
                    } initializer: (Model().GetDeclaredSymbol(initializer.Parent!!), initializer.Value)
                    default: (nil, nil)
                }
                if (write.Target is IFieldSymbol or IPropertySymbol) &&
                    IsEvidenceDecidedGeneratedDeclaration(write.Target) &&
                    HasPromotableArrayElement(write.Target) &&
                    write.Target!!
                    .OriginalDefinition
                    .GetDocumentationCommentId() is {} id && !targets.Contains(id) {
                    for element in ArrayLiteralElements(write.Value) {
                        if WritesNull(Model(), element) {
                            targets.Add(id)
                            break
                        }
                    }
                }
            }
        }
        return targets
    }

    // The element expressions of an array-shaped literal: a C# 12 collection
    // expression, or an explicit/implicit array creation carrying an
    // initializer. Nested initializers (a rectangular or jagged literal) are
    // flattened to their leaves. A SPREAD element contributes nothing — its
    // elements are not visible here, so it is no evidence either way.
    // Anything that is not one of those shapes yields no elements at all,
    // which is what keeps this evidence to writes whose element values this
    // translator can actually see.
    private func ArrayLiteralElements(value ExpressionSyntax?) sequence[ExpressionSyntax] {
        switch value {
            case parenthesized is ParenthesizedExpressionSyntax {
                for element in ArrayLiteralElements(parenthesized.Expression) {
                    yield element
                }
            }
            case collection is CollectionExpressionSyntax {
                for element in collection.Elements {
                    if element is ExpressionElementSyntax expression {
                        yield expression.Expression
                    }
                }
            }
            case ArrayCreationExpressionSyntax{Initializer: {} explicitInitializer} {
                for element in InitializerLeaves(explicitInitializer) {
                    yield element
                }
            }
            case implicitCreation is ImplicitArrayCreationExpressionSyntax {
                for element in InitializerLeaves(implicitCreation.Initializer) {
                    yield element
                }
            }
        }
    }

    private func InitializerLeaves(initializer InitializerExpressionSyntax) sequence[ExpressionSyntax] {
        for element in initializer.Expressions {
            if element is InitializerExpressionSyntax nested {
                for leaf in InitializerLeaves(nested) {
                    yield leaf
                }
            } else {
                yield element
            }
        }
    }

    // An array of an unannotated REFERENCE element type: the only shape whose
    // element slot there is anything to widen. A value-typed element never
    // receives a null, and an already-`T?` element already renders nullable.
    private func IsPromotableArrayElement(type ITypeSymbol) bool -> type is IArrayTypeSymbol{
        ElementType: {IsReferenceType: true} element
    } &&
        element.NullableAnnotation != Microsoft
        .CodeAnalysis
        .NullableAnnotation
        .Annotated

    // Issue #3848: the pure-forwarding closure for one compilation, keyed like
    // `NullTargets` above so it is computed at most once per compilation.
    private func ForwardingPromotions(compilation CSharpCompilation?) HashSet[string] -> ForwardedTargets.GetValue(
        compilation!!,
        ComputeForwardingPromotions
    )

    // Issue #3848: the closure described on `IsPromotedByPureForwarding`.
    //
    // Two node populations are collected once, then relaxed to a fixed point
    // bounded by `MaxForwardingHops`:
    //   * candidate FORWARDERS — methods that satisfy clauses 1-5 of the rule,
    //     paired with their own exit expressions;
    //   * candidate generated SINKS — writes into a declaration that
    //     `IsEvidenceDecidedGeneratedDeclaration` accepts, paired with the
    //     written expression.
    // Each round admits a forwarder whose every exit is now a pure forward, and
    // a generated sink whose written value is now a pure forward. The seed is
    // never computed here: it is `IsGeneratedDeclarationAssignedNull`, so every
    // member of the closure traces back to generated code the C# compiler
    // stopped checking.
    private func ComputeForwardingPromotions(compilation Compilation) HashSet[string] {
        let promoted = HashSet[string](StringComparer.Ordinal)
        if compilation is not CSharpCompilation csharp {
            return promoted
        }
        let forwarders = List[(Model SemanticModel, Id string, Exits IReadOnlyList[ExpressionSyntax])]()
        let sinks = List[(Model SemanticModel, Id string, Value ExpressionSyntax?)]()
        for tree in csharp.SyntaxTrees {
            var model SemanticModel? = nil
            for node in tree.GetRoot().DescendantNodes() {
                let Model = func () SemanticModel {
                    return (
                        if model == nil {
                            (model = csharp.GetSemanticModel(tree))
                        } else {
                            model
                        }
                    )!!
                }
                if node is MethodDeclarationSyntax method {
                    CollectForwarderCandidate(Model(), method, forwarders)
                    continue
                }
                // A generated STORAGE sink: an assignment (which is also the
                // object-initializer member shape, `Location { Uri = … }`) or a
                // field/property initializer.
                //
                // Deliberately fields and properties ONLY. A method's return
                // position is already covered, and covered more strictly, by
                // the forwarder path above — which requires EVERY exit to
                // forward and requires the method to own its signature. Letting
                // a `return`/arrow body in here as well would promote members
                // whose G# signature this translator does not actually repaint,
                // and the analysis and the emitted code would disagree: the
                // generated `public static implicit operator DocumentUri(string
                // value) => From(value)` is exactly that — a
                // ConversionOperatorDeclaration, whose G# `func operator
                // implicit(value string) DocumentUri` keeps its conversion
                // contract. Calling it promoted dropped the `!!` its return
                // still needed and produced GS0155 in migrated
                // `Protocol/Models.gs`.
                let target ISymbol? = switch node {
                    case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                        SyntaxKind.SimpleAssignmentExpression
                    ): Model().GetSymbolInfo(assignment.Left).Symbol
                    case EqualsValueClauseSyntax{
                        Parent: VariableDeclaratorSyntax or PropertyDeclarationSyntax
                    } initializer: Model().GetDeclaredSymbol(initializer.Parent!!)
                    default: default(ISymbol?)
                }
                if (target is IFieldSymbol || target is IPropertySymbol) &&
                    IsEvidenceDecidedGeneratedDeclaration(target) &&
                    target!!
                    .OriginalDefinition
                    .GetDocumentationCommentId() is {} sinkId {
                    let value ExpressionSyntax? = switch node {
                        case assignment is AssignmentExpressionSyntax: assignment.Right
                        case initializer is EqualsValueClauseSyntax: initializer.Value
                        default: default(ExpressionSyntax?)
                    }
                    if value != nil {
                        sinks.Add((Model(), sinkId, value))
                    }
                }
            }
        }
        for var hop = 0; hop < MaxForwardingHops; hop++ {
            // Each round is evaluated against a SNAPSHOT of the previous round's
            // result, never against the set being built. Without that, a chain
            // whose links happen to be visited in order collapses into a single
            // round and the hop bound measures nothing — and worse, the answer
            // would depend on syntax-tree and declaration ORDER, which a
            // translation that must be identical in every project cannot afford.
            let settled = HashSet[string](promoted, StringComparer.Ordinal)
            var changed = false
            for (model, id, exits) in forwarders {
                if !settled.Contains(id) && exits.All(
                    (exit ExpressionSyntax) -> IsPureForwardOfPromoted(csharp, model, exit, settled)
                ) {
                    changed |= promoted.Add(id)
                }
            }
            for (model, id, value) in sinks {
                if !settled.Contains(id) && IsPureForwardOfPromoted(csharp, model, value!!, settled) {
                    changed |= promoted.Add(id)
                }
            }
            if !changed {
                break
            }
        }
        return promoted
    }

    // Clauses 1-5 of the rule: whether `method` is even eligible to be a pure
    // forwarder, and if so what its own exit expressions are. Clause 6 (are
    // those exits actually forwards?) is re-evaluated every hop and lives in
    // `IsPureForwardOfPromoted`.
    private func CollectForwarderCandidate(
        model SemanticModel,
        method MethodDeclarationSyntax,
        forwarders List[(Model SemanticModel, Id string, Exits IReadOnlyList[ExpressionSyntax])]
    ) {
        if model.GetDeclaredSymbol(method) is not IMethodSymbol symbol ||
            symbol.ReturnsVoid ||
            symbol.ReturnsByRef ||
            symbol.ReturnsByRefReadonly ||
            symbol.IsAsync ||
            symbol.ReturnType is not{IsReferenceType: true} ||
            symbol
            .ReturnType
            .NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated ||
            IsSignatureFixedByAnotherDeclaration(symbol) ||
            symbol
            .OriginalDefinition
            .GetDocumentationCommentId() is not{} id {
            return
        }
        let exits = List[ExpressionSyntax]()
        if method.ExpressionBody is {Expression: {} arrow} {
            exits.Add(arrow)
        } else if method.Body is {} body {
            for node in body.DescendantNodes() {
                // A `yield` makes the declared type an enumerable of the
                // yielded values, not the type of anything forwarded.
                if node is YieldStatementSyntax {
                    return
                }
                if node is ReturnStatementSyntax{Expression: {} returned} && !IsInsideNestedBody(returned, body) {
                    exits.Add(returned)
                }
            }
        }
        if exits.Count > 0 {
            forwarders.Add((model, id, exits))
        }
    }

    // Whether `node` sits inside a lambda / anonymous method / local function
    // nested in `body`: such a `return` belongs to that nested body, not to the
    // method being tested.
    private func IsInsideNestedBody(node SyntaxNode, body SyntaxNode) bool {
        for var current SyntaxNode? = node.Parent; current != nil && current != body; current = current!!.Parent {
            if current is AnonymousFunctionExpressionSyntax || current is LocalFunctionStatementSyntax {
                return true
            }
        }
        return false
    }

    // Clause 6: `expression` hands an already-promoted value straight on. Only
    // a direct call or a direct field/property read qualifies — deliberately
    // NOT a local or parameter read (a different slot), a conditional or switch
    // (an arm may substitute a value), `??` (which REMOVES the null), or any
    // other operation.
    private func IsPureForwardOfPromoted(
        compilation CSharpCompilation,
        model SemanticModel,
        expression ExpressionSyntax,
        promoted HashSet[string]
    ) bool {
        var expression = expression
        while expression is ParenthesizedExpressionSyntax parenthesized {
            expression = parenthesized.Expression
        }
        if !(
            (
                expression is InvocationExpressionSyntax ||
                    expression is IdentifierNameSyntax ||
                    expression is MemberAccessExpressionSyntax
            )
        ) {
            return false
        }
        let source ISymbol? = model.GetSymbolInfo(expression).Symbol
        if !((source is IMethodSymbol || source is IPropertySymbol || source is IFieldSymbol)) ||
            source!!
            .OriginalDefinition
            .GetDocumentationCommentId() is not{} id {
            return false
        }
        // The seed — direct generated null evidence — or a promotion an earlier
        // hop already established. Siblings are deliberately not consulted
        // here: this closure is per-compilation and the run unions the results
        // in `IsPromotedByPureForwarding`.
        return promoted.Contains(id) || IsGeneratedDeclarationAssignedNull(compilation, source, nil)
    }

    // Issue #3851: the write evidence, widened from "the source spells `null`"
    // to "the C# compiler's own flow analysis says this value MAY be null".
    //
    // A declaration in an `<auto-generated/>` file is OBLIVIOUS — verified
    // empirically: an `<auto-generated/>` `class Node { public Node Parent
    // { get; set; } }` swallows the CS8601 for `new Node { Parent = maybeNull }`
    // written in a hand-authored, nullable-ENABLED file, while the identical
    // pair without the header reports it. So the writes that contradict a
    // generated declaration's annotation are not confined to literal `null`;
    // any maybe-null value flows in silently, which is exactly how migrated
    // `LspServer.pendingWorkspaceRootPath` (`request?.RootPath ?? …`) and
    // `SelectionRange.Parent` (a `SelectionRange?` local) reached gsc as
    // non-null declarations carrying a use-site `!!` that then threw at run
    // time on the null the C# quietly accepted.
    //
    // Flow state, not the taint fixpoint #3676 rejected: it is per-write,
    // computed by Roslyn itself, and is precisely the condition under which the
    // compiler WOULD have warned had the suppression not silenced it. In a
    // nullable-oblivious compilation Roslyn reports `FlowState.None`, so this
    // adds nothing there and #2113's analysis stays in charge.
    private func WritesNull(model SemanticModel, expression ExpressionSyntax?) bool -> WritesNull(expression) ||
        (
        expression != nil &&
            model
            .GetTypeInfo(expression)
            .Nullability
            .FlowState == Microsoft
            .CodeAnalysis
            .NullableFlowState
            .MaybeNull
    )

    // `null`, `default`, or either reachable through parentheses or a branch of
    // a conditional / switch expression — all of which make null one of the
    // values the C# actually writes into the target.
    private func WritesNull(expression ExpressionSyntax?) bool -> switch expression {
        case nil: false
        case parenthesized is ParenthesizedExpressionSyntax: WritesNull(parenthesized.Expression)
        case conditional is ConditionalExpressionSyntax: WritesNull(conditional.WhenTrue) ||
            WritesNull(conditional.WhenFalse)
        case switched is SwitchExpressionSyntax: switched.Arms.Any(
            (arm SwitchExpressionArmSyntax) -> WritesNull(arm.Expression)
        )
        case _ is DefaultExpressionSyntax: true
        case literal is LiteralExpressionSyntax: literal.IsKind(SyntaxKind.NullLiteralExpression) || literal.IsKind(
            SyntaxKind.DefaultLiteralExpression
        )
        default: false
    }

    // The declaration a `return`/arrow body belongs to: the method itself, or
    // the property behind a getter rather than the synthesized accessor.
    private func OwningMember(symbol ISymbol?) ISymbol? {
        if symbol is IMethodSymbol method &&
            method.MethodKind == MethodKind.PropertyGet &&
            method.AssociatedSymbol is {} property {
            return property
        }
        return symbol
    }

    // Every declaration whose `[AllowNull]` binds `symbol`'s write contract:
    // the symbol itself, a property setter's `value` parameter, and the base or
    // interface declaration an inherited signature comes from.
    private func AllowNullContractSites(symbol ISymbol) sequence[ISymbol] {
        switch symbol {
            case property is IPropertySymbol {
                yield property
                if property.SetMethod is {Parameters: {Length: > 0}} setter {
                    yield setter.Parameters[0]
                }
                for inherited in InheritedDeclarations(property) {
                    yield inherited
                    if inherited is IPropertySymbol{SetMethod: {Parameters: {Length: > 0}}} inheritedProperty {
                        yield inheritedProperty.SetMethod!!.Parameters[0]
                    }
                }
            }
            case parameter is IParameterSymbol {
                yield parameter
                if parameter.ContainingSymbol is IMethodSymbol owner {
                    for inherited in InheritedDeclarations(owner) {
                        // Issue #3804: `>= 0` as well as `<`, defensively. A
                        // `this` parameter (Ordinal -1) cannot reach here
                        // today — HasAllowNullWriteContract's
                        // DeclaringSyntaxReferences gate turns it away first,
                        // which is precisely the gate HasNullDataRowArgument
                        // applied to the METHOD rather than the parameter, and
                        // that is how the #3804 crash got in. An ordinal
                        // bounded on one side only is the bug shape; bound it
                        // on both.
                        if inherited is IMethodSymbol inheritedMethod &&
                            parameter.Ordinal >= 0 &&
                            parameter.Ordinal < inheritedMethod
                            .Parameters
                            .Length {
                            yield inheritedMethod.Parameters[parameter.Ordinal]
                        }
                    }
                }
            }
            case field is IFieldSymbol {
                yield field
            }
        }
    }

    // The base-class overrides and interface members `member` inherits its
    // signature from.
    private func InheritedDeclarations(member ISymbol?) sequence[ISymbol] {
        for var current ISymbol? = OverriddenDeclaration(member);
            current != nil;
            current = OverriddenDeclaration(current) {
            yield current
        }
        for explicitImplementation in ExplicitImplementations(member) {
            yield explicitImplementation
        }
        let containing INamedTypeSymbol? = member!!.ContainingType
        if containing == nil {
            yield break
        }
        for contract in containing.AllInterfaces {
            for candidate in contract.GetMembers(member!!.Name) {
                if SymbolEqualityComparer.Default.Equals(
                    containing.FindImplementationForInterfaceMember(candidate),
                    member
                ) {
                    yield candidate
                }
            }
        }
    }

    private func OverriddenDeclaration(member ISymbol?) ISymbol? -> switch member {
        case method is IMethodSymbol: (method.OverriddenMethod as ISymbol)
        case property is IPropertySymbol: (property.OverriddenProperty as ISymbol)
        default: nil
    }

    private func ExplicitImplementations(member ISymbol?) IEnumerable[ISymbol] -> switch member {
        case method is IMethodSymbol: method.ExplicitInterfaceImplementations
        case property is IPropertySymbol: property.ExplicitInterfaceImplementations
        default: Enumerable.Empty[ISymbol]()
    }

    private func CarriesAllowNull(symbol ISymbol?) bool {
        // A metadata base declaration is already emitted as plain `T`, so an
        // `[AllowNull]` there must not repaint a source override that has to
        // keep matching it.
        let declaring ISymbol? = if symbol is IParameterSymbol parameter {
            parameter.ContainingSymbol
        } else {
            symbol
        }
        if declaring == nil || declaring.DeclaringSyntaxReferences.Length == 0 {
            return false
        }
        for attribute in symbol!!.GetAttributes() {
            if attribute.AttributeClass?.Name == AllowNullAttributeName {
                return true
            }
        }
        return false
    }

    // Whether the member owning `symbol`'s type position inherits that position
    // from a base class or interface declaration, so its nullability is not the
    // member's own to restate. Covers the member itself and — since a parameter
    // list is matched as a whole — every parameter of such a member.
    private func IsSignatureFixedByAnotherDeclaration(symbol ISymbol?) bool {
        let member ISymbol? = if symbol is IParameterSymbol parameter {
            parameter.ContainingSymbol
        } else {
            symbol
        }
        return switch member {
            case method is IMethodSymbol: method.IsOverride ||
                method
                .ExplicitInterfaceImplementations
                .Length > 0 ||
                ImplementsInterfaceMember(method)
            case property is IPropertySymbol: property.IsOverride ||
                property
                .ExplicitInterfaceImplementations
                .Length > 0 ||
                ImplementsInterfaceMember(property)
            default: false
        }
    }

    // Whether `member` implicitly implements an interface member of its
    // containing type (the explicit form is tested directly by the caller).
    private func ImplementsInterfaceMember(member ISymbol) bool {
        let containing INamedTypeSymbol? = member.ContainingType
        if containing == nil {
            return false
        }
        for contract in containing.AllInterfaces {
            for candidate in contract.GetMembers(member.Name) {
                if SymbolEqualityComparer.Default.Equals(
                    containing.FindImplementationForInterfaceMember(candidate),
                    member
                ) {
                    return true
                }
            }
        }
        return false
    }

    private func Compute(compilation Compilation) TaintResult {
        let tainted = HashSet[ISymbol](SymbolEqualityComparer.Default)
        var tupleTainted = HashSet[TupleElementKey](TupleContractKeyComparer.Instance)
        // Transitive edges: (target <- source). If `source` is tainted then
        // `target` becomes tainted. Both are canonicalized declaration symbols
        // (field/property/parameter/local for a value target; method for a
        // return target; field/property/parameter/local/method for a source).
        let edges = List[(Target ISymbol, Source ISymbol)]()
        let tupleEdges = List[(Target TupleElementKey, Source TupleElementKey)]()
        let tupleContractEdges = List[(Target TupleElementKey, Source TupleElementKey)]()
        let tupleScalarEdges = List[(Target TupleElementKey, Source ISymbol)]()
        let scalarTupleEdges = List[(Target ISymbol, Source TupleElementKey)]()
        let delegateReturnEdges = List[(Target ISymbol, Source ISymbol)]()
        let paramsElementTainted = HashSet[string](StringComparer.Ordinal)
        let paramsElementEdges = List[(Target string, Source ISymbol)]()
        let constructedTypes = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
        for tree in compilation.SyntaxTrees {
            let model = compilation.GetSemanticModel(tree)
            let root = tree.GetRoot()
            for node in root.DescendantNodes() {
                if node is GenericNameSyntax generic && model.GetTypeInfo(generic)
                    .Type is INamedTypeSymbol constructed {
                    constructedTypes.Add(constructed)
                }
                SeedDirectTaint(node, model, tainted)
                CollectEdges(node, model, tainted, edges, scalarTupleEdges, paramsElementTainted, paramsElementEdges)
            }
            // Method / accessor / local-function RETURN taint: a `return null`,
            // `return default`, or `return <nullable-expr>` path taints the
            // enclosing member's return symbol; a non-directly-null `return`
            // records a transitive edge from the return symbol to the returned
            // value's source.
            SeedReturnTaint(root, model, tainted, edges, scalarTupleEdges)
            CollectTupleFlows(root, model, tainted, edges, tupleTainted, tupleEdges, tupleScalarEdges, scalarTupleEdges)
            CollectDelegateReturnContractEdges(
                compilation,
                root,
                model,
                tainted,
                edges,
                delegateReturnEdges,
                tupleTainted,
                tupleContractEdges
            )
        }
        // Issue #3060: EF entity properties are promoted by policy rather than
        // syntax evidence, so seed them before contract edges synchronize
        // interface and implementation nullability.
        SeedEfEntityPropertyTaint(compilation, tainted)
        // Issue #2285: an interface member and every member that implements it
        // (across the whole compilation) must reach the SAME tainted-ness, so
        // cs2gs never promotes one endpoint (e.g. a record's primary-ctor
        // parameter) to `T?` while leaving the other (the interface property it
        // satisfies) non-null `T` — see <see cref="CollectInterfaceImplementationEdges"/>.
        CollectInterfaceImplementationEdges(compilation, edges)
        CollectOverrideContractEdges(compilation, edges)
        CollectTupleContractEdges(compilation, tupleTainted, tupleContractEdges)
        CollectConstructedTupleContractEdges(compilation, constructedTypes, tupleTainted, tupleContractEdges)
        // A signature component shares one contract, even when only one
        // implementation inherits a fixed non-null metadata position.
        let fixedTupleContracts = HashSet[TupleElementKey](TupleContractKeyComparer.Instance)
        let CanPromote = func (key TupleElementKey) bool {
            return !fixedTupleContracts.Contains(key) &&
                CanPromoteTuplePosition(compilation, key.ContractSymbol, key.ContractPath)
        }
        let FreezeNonNullableContract = func (key TupleElementKey) {
            if TuplePositionType(key.ContractSymbol, key.ContractPath) is {IsReferenceType: true} &&
                !TupleContractPositionAcceptsNil(compilation, key.ContractSymbol, key.ContractPath) &&
                !CanPromoteTuplePosition(compilation, key.ContractSymbol, key.ContractPath) {
                fixedTupleContracts.Add(key)
            }
        }
        for (target, source) in tupleContractEdges {
            FreezeNonNullableContract(target)
            FreezeNonNullableContract(source)
        }
        var contractsChanged bool
        do {
            contractsChanged = false
            for (target, source) in tupleContractEdges {
                if fixedTupleContracts.Contains(source) && fixedTupleContracts.Add(target) {
                    contractsChanged = true
                }
            }
        } while contractsChanged
        tupleEdges.AddRange(tupleContractEdges)
        // Filter each declaration's seeds before sharing projected type-argument evidence.
        tupleTainted.RemoveWhere((key TupleElementKey) -> !CanPromote(key))
        tupleTainted = HashSet[TupleElementKey](tupleTainted, TupleElementKeyComparer.Instance)
        tupleEdges.RemoveAll((edge(Target TupleElementKey, Source TupleElementKey)) -> !CanPromote(edge.Target))
        tupleScalarEdges.RemoveAll((edge(Target TupleElementKey, Source ISymbol)) -> !CanPromote(edge.Target))
        // Fixpoint: propagate taint along the edge set until it stabilizes.
        var changed = true
        while changed {
            changed = false
            for (target, source) in edges {
                if !tainted.Contains(target) && tainted.Contains(source) {
                    tainted.Add(target)
                    changed = true
                }
            }
            for (target, source) in tupleScalarEdges {
                if !tupleTainted.Contains(target) && tainted.Contains(source) {
                    tupleTainted.Add(target)
                    changed = true
                }
            }
            for (target, source) in scalarTupleEdges {
                if !tainted.Contains(target) && CanPromote(source) && tupleTainted.Contains(source) {
                    tainted.Add(target)
                    changed = true
                }
            }
            for (target, source) in tupleEdges {
                if !tupleTainted.Contains(target) && CanPromote(source) && tupleTainted.Contains(source) {
                    tupleTainted.Add(target)
                    changed = true
                }
            }
        }
        return TaintResult(
            tainted,
            tupleTainted,
            fixedTupleContracts,
            tupleContractEdges,
            tupleEdges,
            tupleScalarEdges,
            scalarTupleEdges,
            delegateReturnEdges,
            paramsElementTainted,
            paramsElementEdges
        )
    }

    private func SeedEfEntityPropertyTaint(compilation Compilation, tainted HashSet[ISymbol]) {
        for entity in CollectEfEntityTypes(compilation) {
            for property in entity.GetMembers().OfType[IPropertySymbol]() {
                if IsEligibleScalarTarget(property) {
                    tainted.Add(Canonical(property)!!)
                }
            }
        }
    }

    // Seeds direct null evidence for a value declaration symbol (field /
    // property / parameter / local): the exact forms the translator's local
    // ComputeIsUsedAsNullable / IsNullableInitializer already recognize, applied
    // whole-program.
    private func SeedDirectTaint(node SyntaxNode, model SemanticModel, tainted HashSet[ISymbol]) {
        switch node {
            case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.EqualsExpression) || binary.IsKind(
                SyntaxKind.NotEqualsExpression
            ) {
                if IsNullLiteral(binary.Right) {
                    TaintTarget(binary.Left, model, tainted)
                } else if IsNullLiteral(binary.Left) {
                    TaintTarget(binary.Right, model, tainted)
                }
            }
            case assign is AssignmentExpressionSyntax when assign.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                IsNullOrSuppressedNull(assign.Right) {
                TaintTarget(assign.Left, model, tainted)
            }
            case coalesceAssign is AssignmentExpressionSyntax when coalesceAssign.IsKind(
                SyntaxKind.CoalesceAssignmentExpression
            ) {
                TaintTarget(coalesceAssign.Left, model, tainted)
            }
            case isPattern is IsPatternExpressionSyntax when IsNullConstantPattern(isPattern.Pattern) {
                TaintTarget(isPattern.Expression, model, tainted)
            }
            case conditionalAccess is ConditionalAccessExpressionSyntax {
                TaintTarget(conditionalAccess.Expression, model, tainted)
            }
            case declarator is VariableDeclaratorSyntax when declarator.Initializer != nil {
                if model.GetDeclaredSymbol(declarator) is ISymbol declared &&
                    IsValueDeclarationSymbol(declared) &&
                    IsDirectlyNullable(declarator.Initializer!!.Value, model) {
                    tainted.Add(Canonical(declared)!!)
                }
            }
            case property is PropertyDeclarationSyntax when property.Initializer != nil {
                if model.GetDeclaredSymbol(property) is IPropertySymbol propertySymbol &&
                    IsDirectlyNullable(property.Initializer!!.Value, model) {
                    tainted.Add(Canonical(propertySymbol)!!)
                }
            }
            case parameter is ParameterSyntax when parameter.Default != nil {
                if model.GetDeclaredSymbol(parameter) is IParameterSymbol parameterSymbol &&
                    IsDirectlyNullable(parameter.Default!!.Value, model) {
                    tainted.Add(Canonical(parameterSymbol)!!)
                }
            }
        }
    }

    // Records transitive taint edges for the assignment / initializer forms
    // whose RHS is not itself directly-null but reads another declaration.
    private func CollectEdges(
        node SyntaxNode,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)],
        paramsElementTainted HashSet[string],
        paramsElementEdges List[(Target string, Source ISymbol)]
    ) {
        // Interprocedural parameter taint: an argument that is directly null or
        // reads a (possibly tainted) declaration flows to the bound parameter, so
        // a parameter that ever receives null becomes `T?` too. This keeps a
        // pass-through call `Callee(maybeNull)` from demanding a non-null
        // parameter (GS0154) once `maybeNull` is promoted.
        //
        // Issue #914 (oblivious sink): a constructor initializer delegation
        // (`: this(...)` / `: base(...)`) is an argument-passing call site too.
        // A convenience initializer that forwards its own (possibly promoted)
        // parameters to the designated initializer — e.g. `LogMessage(string
        // context, string message) : this(DateTime.Now, threadId, context,
        // message)` where `context`/`message` are themselves promoted `string?`
        // — must promote the designated initializer's matching parameters, else
        // the delegating call demands a non-null value (GS0154). Roslyn models a
        // constructor initializer as an `IInvocationOperation`, so it flows
        // through the same argument→parameter edge collection.
        // Issue #3501: BaseObjectCreationExpressionSyntax covers BOTH explicit
        // `new Entry(null, …)` and target-typed `new(null, …)` creations — the
        // implicit form (C# 9) is a sibling syntax type, not an
        // ObjectCreationExpressionSyntax, so the RoslynAnalyzerApiMap-style
        // `[key] = new(null, "…")` initializer never flowed its null argument
        // into the record's positional parameter (GS0155 nil → string).
        if node is InvocationExpressionSyntax ||
            node is BaseObjectCreationExpressionSyntax ||
            node is ConstructorInitializerSyntax ||
            node is ElementAccessExpressionSyntax ||
            node is ElementBindingExpressionSyntax {
            CollectArgumentEdges(node, model, tainted, edges, scalarTupleEdges)
            CollectExpandedParamsElementEdges(node, model, paramsElementTainted, paramsElementEdges)
        }
        switch node {
            case assign is AssignmentExpressionSyntax when assign.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                let assignTarget ISymbol? = ResolveAssignable(assign.Left, model)
                if assignTarget != nil {
                    // A declaration's emitted type is the JOIN over its
                    // initializer AND every assignment to it. A later `lhs =
                    // <nullable>` (e.g. `id = mo["ProcessorID"]!!.ToString()`,
                    // where `object.ToString()` is declared `string?`) therefore
                    // promotes `lhs` even when the declaration's initializer was
                    // non-null (issue #2167, the `var` local-join case). A
                    // directly-nullable RHS taints immediately; any other RHS
                    // records a transitive edge so a nullable source propagates.
                    CollectScalarValueFlow(assignTarget, assign.Right, model, tainted, edges, scalarTupleEdges)
                }
            }
            case declarator is VariableDeclaratorSyntax when declarator.Initializer != nil {
                if model.GetDeclaredSymbol(declarator) is ISymbol declared && IsValueDeclarationSymbol(declared) {
                    CollectScalarValueFlow(
                        Canonical(declared),
                        declarator.Initializer!!.Value,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
            }
            case property is PropertyDeclarationSyntax when property.Initializer != nil {
                if model.GetDeclaredSymbol(property) is IPropertySymbol propertySymbol {
                    CollectScalarValueFlow(
                        Canonical(propertySymbol),
                        property.Initializer!!.Value,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
            }
        }
    }

    // Issue #3888: Roslyn represents an expanded params tail as one synthesized
    // array argument, so the ordinary argument→parameter pass above sees only
    // the carrier. Walk the source arguments positionally and record evidence
    // against the distinct element position. A normal-form array argument is
    // excluded by its conversion to the full carrier type.
    private func CollectExpandedParamsElementEdges(
        call SyntaxNode,
        model SemanticModel,
        paramsElementTainted HashSet[string],
        paramsElementEdges List[(Target string?, Source ISymbol)]
    ) {
        let argumentList BaseArgumentListSyntax? = switch call {
            case invocation is InvocationExpressionSyntax: cast[BaseArgumentListSyntax](invocation.ArgumentList)
            case creation is BaseObjectCreationExpressionSyntax: (creation.ArgumentList as BaseArgumentListSyntax)
            case initializer is ConstructorInitializerSyntax: cast[BaseArgumentListSyntax](initializer.ArgumentList)
            case elementAccess is ElementAccessExpressionSyntax: cast[BaseArgumentListSyntax](
                elementAccess.ArgumentList
            )
            case elementBinding is ElementBindingExpressionSyntax: cast[BaseArgumentListSyntax](
                elementBinding.ArgumentList
            )
            default: nil
        }
        let callable ISymbol? = model.GetSymbolInfo(call).Symbol
        let parameters = switch callable {
            case method is IMethodSymbol: method.Parameters
            case property is IPropertySymbol: property.Parameters
            default: default(ImmutableArray[IParameterSymbol])
        }
        if argumentList == nil ||
            parameters.IsDefaultOrEmpty ||
            !(parameters[^1] is {IsParams: true, Type: IArrayTypeSymbol array} parameter) ||
            array.ElementType is not{IsReferenceType: true} ||
            array
            .ElementType
            .NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated {
            return
        }
        let target string? = ParamsElementId(parameter)
        if target == nil {
            return
        }
        let firstExpandedPosition = parameters.Length - 1
        for var i = firstExpandedPosition; i < argumentList.Arguments.Count; i++ {
            let argument = argumentList.Arguments[i]
            if argument.NameColon != nil {
                continue
            }
            let convertedType ITypeSymbol? = model.GetTypeInfo(argument.Expression).ConvertedType
            if convertedType != nil && SymbolEqualityComparer.Default.Equals(convertedType, parameter.Type) {
                continue
            }
            if IsDirectlyNullable(argument.Expression, model) {
                paramsElementTainted.Add(target)
                continue
            }
            for source in ResolveSources(argument.Expression, model) {
                paramsElementEdges.Add((target, source!!))
            }
        }
    }

    private func IsUnreassignedNonNullLocal(value ExpressionSyntax, model SemanticModel) bool {
        if value is not IdentifierNameSyntax identifier || model.GetSymbolInfo(identifier)
            .Symbol is not ILocalSymbol local ||
            local
            .DeclaringSyntaxReferences
            .FirstOrDefault()
            ?.GetSyntax() is not VariableDeclaratorSyntax declarator ||
            declarator
            .Initializer
            ?.Value is not(
            BaseObjectCreationExpressionSyntax or
                ArrayCreationExpressionSyntax or
                ImplicitArrayCreationExpressionSyntax or
                AnonymousObjectCreationExpressionSyntax
        ) ||
            (
            GetResultConversion(declarator.Initializer!!.Value, model) is IConversionOperation and
                {OperatorMethod: not nil}
        ) ||
            declarator.SpanStart >= value.SpanStart {
            return false
        }
        let scope_ SyntaxNode? = value.Ancestors().FirstOrDefault(
            (node SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax
        )
        if scope_ == nil || !scope_.Span.Contains(declarator.Span) {
            return false
        }
        return !scope_.DescendantNodes().Any(
            (node SyntaxNode) -> node.SpanStart > declarator
                .Span
                .End &&
                CSharpToGSharpTranslator.SyntaxNodeWritesSymbol(node, local, model)
        )
    }

    // Parameters do not have documentation IDs of their own. The owning
    // method's ID includes its full parameter-type signature, and the ordinal
    // selects this declaration position without the overload ambiguity of the
    // general-purpose cross-compilation remapper.
    private func ParamsElementId(parameter IParameterSymbol?) string? -> if parameter
        ?.ContainingSymbol
        ?.OriginalDefinition
        .GetDocumentationCommentId() is {} ownerId {
        ownerId + ":" + parameter!!.Ordinal.ToString()
    } else {
        default(string?)
    }

    // Interprocedural: map each call argument to its bound parameter and add a
    // taint edge (or a direct taint for a directly-null argument), so a parameter
    // that ever receives a nullable value is itself promoted to `T?`.
    private func CollectArgumentEdges(
        call SyntaxNode,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol?, Source ISymbol?)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)]
    ) {
        let arguments = GetCallArguments(call, model)
        if arguments.IsDefaultOrEmpty {
            return
        }
        for argument in arguments {
            if argument.Parameter is not IParameterSymbol parameter ||
                argument
                .Value
                ?.Syntax is not ExpressionSyntax value {
                continue
            }
            let parameterSymbol ISymbol? = Canonical(parameter)
            // Issue #3501/#4816: a value that flow analysis proves non-null at
            // a CONSTRUCTOR argument does not carry its declaration's taint
            // into the parameter. This covers both a syntactic null guard and
            // a nullable local reassigned before storage. Tainting the record's
            // positional parameter would widen the DATA SHAPE (`Product` →
            // `Product?` on the positional property) for every consumer,
            // including deconstruction locals whose dereferences are not
            // receiver-bridged. gsc's own smart-cast narrows the same value at
            // the G# creation, so the suppressed edge never reintroduces a
            // `T? -> T` mismatch. A syntactically guarded concrete-reference
            // method argument is equally non-null at that call. Open type
            // parameters retain promotion consolidation because G# cannot
            // smart-cast them reliably (see PromotionConsolidationTests).
            let guardedArgument = (
                call is BaseObjectCreationExpressionSyntax &&
                    (IsNullGuardDominatedRead(value, model) || IsUnreassignedNonNullLocal(value, model))
            ) ||
                (
                (parameter.Type is {IsReferenceType: true} and not ITypeParameterSymbol) &&
                    (IsNullGuardDominatedRead(value, model) || IsNullGuardDominatedExpression(value, model))
            )
            if !guardedArgument {
                CollectScalarValueFlow(parameterSymbol, value, model, tainted, edges, scalarTupleEdges)
            }
            // A parameter forwarded unchanged into another parameter inherits
            // that downstream nullable contract. This lets a null-check at the
            // end of a pass-through chain widen every upstream declaration even
            // when the original null-producing caller lives in another project.
            for source in ResolveSources(value, model) {
                if source is IParameterSymbol sourceParameter &&
                    sourceParameter
                    .Type
                    .TypeKind == TypeKind.Delegate &&
                    parameter
                    .Type
                    .TypeKind == TypeKind.Delegate {
                    edges.Add((Canonical(source), parameterSymbol))
                }
            }
            // Issue #3501: an `out` argument flows the OPPOSITE way — the
            // callee writes the parameter's value into the caller's variable, so
            // a tainted out parameter (`bool TryGetTupleType(..., out
            // INamedTypeSymbol tupleType)` assigning an `as`-cast) makes the
            // receiving out-var local `T?` too. Without this edge the local's
            // symbol stayed untainted while gsc independently inferred the
            // out-var's type from the promoted parameter (`T?`), so downstream
            // reads passed a `T?` where the translator believed a `T` flowed
            // (GS0154) and never bridged with `!!`.
            //
            // `Deconstruct` is excluded: its out parameters feed positional
            // deconstruction locals (`for (item, comp) in pairs`) whose G#
            // types come from the tuple element rendering, not the parameter,
            // and whose oblivious dereferences are not receiver-bridged —
            // tainting them regressed the Oahu gate (member reads on a
            // now-`T?` deconstructed local). `ref` stays excluded too: the
            // caller's variable was initialized before the call, so its own
            // initializer/assignment edges already model its nullability.
            //
            // Issue #4482: `ref` now flows the same way. The caller's
            // initializer does model its own nullability, but a by-ref slot is
            // storage the callee writes through, and gsc requires it to match
            // the parameter's nullability exactly (GS0612): a `ref string?`
            // parameter needs `string?` storage however it was initialized.
            if (parameter.RefKind == RefKind.Out || parameter.RefKind == RefKind.Ref) &&
                (
                parameter.ContainingSymbol is not IMethodSymbol containingMethod ||
                    containingMethod.Name != "Deconstruct"
            ) {
                let receiver ISymbol? = if value is DeclarationExpressionSyntax{
                    Designation: SingleVariableDesignationSyntax designation
                } {
                    model.GetDeclaredSymbol(designation)
                } else {
                    ResolveAssignable(value, model)
                }
                if receiver != nil && IsValueDeclarationSymbol(receiver) {
                    edges.Add((Canonical(receiver), parameterSymbol))
                }
            }
        }
    }

    private func GetCallArguments(call SyntaxNode, model SemanticModel) ImmutableArray[
        IArgumentOperation
    ] -> switch model
        .GetOperation(call) {
        case invocation is IInvocationOperation: invocation.Arguments
        case creation is IObjectCreationOperation: creation.Arguments
        case property is IPropertyReferenceOperation: property.Arguments
        default: default(ImmutableArray[IArgumentOperation])
    }

    // Issue #2469: tuple-valued declarations need the same direct/transitive
    // evidence graph as scalar declarations, but keyed by an element path.
    // This pass covers tuple literals, nested tuples, conditionals/switches,
    // tuple locals/parameters/properties, calls, and deconstruction.
    private func CollectTupleFlows(
        root SyntaxNode,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)]
    ) {
        for node in root.DescendantNodes() {
            switch node {
                case method is MethodDeclarationSyntax {
                    CollectTupleReturnFlows(
                        model.GetDeclaredSymbol(method),
                        method.ExpressionBody?.Expression,
                        method.Body,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges
                    )
                }
                case localFunction is LocalFunctionStatementSyntax {
                    CollectTupleReturnFlows(
                        model.GetDeclaredSymbol(localFunction),
                        localFunction.ExpressionBody?.Expression,
                        localFunction.Body,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges
                    )
                }
                case lambda is AnonymousFunctionExpressionSyntax {
                    CollectTupleReturnFlows(
                        model.GetSymbolInfo(lambda).Symbol as IMethodSymbol,
                        lambda.Body as ExpressionSyntax,
                        lambda.Body as BlockSyntax,
                        model,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges
                    )
                }
                case property is PropertyDeclarationSyntax {
                    let propertySymbol IPropertySymbol? = model.GetDeclaredSymbol(property)
                    if propertySymbol != nil {
                        if property.Initializer?.Value is ExpressionSyntax initializer {
                            CollectDeclarationTupleFlow(
                                Canonical(propertySymbol),
                                propertySymbol.Type,
                                initializer,
                                model,
                                tupleTainted,
                                tupleEdges,
                                tupleScalarEdges
                            )
                        }
                        CollectTupleGetterFlows(
                            propertySymbol,
                            property.ExpressionBody?.Expression,
                            property.AccessorList,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges
                        )
                    }
                }
                case indexer is IndexerDeclarationSyntax {
                    let indexerSymbol IPropertySymbol? = model.GetDeclaredSymbol(indexer)
                    if indexerSymbol != nil {
                        CollectTupleGetterFlows(
                            indexerSymbol,
                            indexer.ExpressionBody?.Expression,
                            indexer.AccessorList,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges
                        )
                    }
                }
                case declarator is VariableDeclaratorSyntax when declarator
                    .Initializer
                    ?.Value is ExpressionSyntax initializer {
                    let declared ISymbol? = model.GetDeclaredSymbol(declarator)
                    if declared != nil && SymbolValueType(declared) is ITypeSymbol declaredType {
                        CollectDeclarationTupleFlow(
                            Canonical(declared),
                            declaredType,
                            initializer,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges
                        )
                    }
                }
                case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) {
                    CollectGenericReceiverTupleValueFlow(assignment, model, tupleTainted, tupleEdges, tupleScalarEdges)
                    let target ISymbol? = ResolveAssignable(assignment.Left, model)
                    if target != nil && SymbolValueType(target) is ITypeSymbol assignedType {
                        CollectDeclarationTupleFlow(
                            target,
                            assignedType,
                            assignment.Right,
                            model,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges
                        )
                    } else if (assignment.Left is TupleExpressionSyntax or DeclarationExpressionSyntax) {
                        CollectDeconstructionFlow(
                            assignment.Left,
                            assignment.Right,
                            model,
                            tainted,
                            edges,
                            scalarTupleEdges
                        )
                    }
                }
                case _ is InvocationExpressionSyntax or
                    _ is ObjectCreationExpressionSyntax or
                    _ is ConstructorInitializerSyntax or
                    _ is ElementAccessExpressionSyntax or
                    _ is ElementBindingExpressionSyntax {
                    CollectTupleArgumentFlows(node, model, tupleTainted, tupleEdges, tupleScalarEdges)
                }
            }
        }
    }

    // Dictionary-style indexer assignment sends the RHS through the receiver's
    // generic value slot, which is not one of the indexer's ordinary arguments.
    private func CollectGenericReceiverTupleValueFlow(
        assignment AssignmentExpressionSyntax,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        if assignment.Left is not ElementAccessExpressionSyntax elementAccess || model.GetSymbolInfo(
            elementAccess.Expression
        )
            .Symbol is not ISymbol target ||
            !(
            (
                target is IFieldSymbol ||
                    target is IPropertySymbol ||
                    target is ILocalSymbol ||
                    target is IParameterSymbol
            )
        ) ||
            SymbolValueType(target) is not INamedTypeSymbol receiverType ||
            model
            .GetSymbolInfo(elementAccess)
            .Symbol is not IPropertySymbol indexer ||
            !TryGetGenericReceiverTuplePath(
            receiverType,
            indexer.OriginalDefinition.Type,
            out var tupleType,
            out var tuplePath
        ) {
            return
        }
        CollectTupleValueFlow(
            Canonical(target),
            tupleType,
            assignment.Right,
            model,
            EncodeTuplePath(tuplePath),
            tupleTainted,
            tupleEdges,
            tupleScalarEdges
        )
    }

    private func CollectTupleReturnFlows(
        declaration ISymbol?,
        arrowBody ExpressionSyntax?,
        body BlockSyntax?,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        let returnType ITypeSymbol? = SymbolValueType(declaration)
        let returnsTuple = returnType is INamedTypeSymbol namedReturn && namedReturn.IsTupleType
        if !returnsTuple && NestedTupleSlots(returnType).Count == 0 {
            return
        }
        let target ISymbol? = Canonical(declaration)
        if arrowBody != nil {
            CollectDeclarationTupleFlow(
                target,
                returnType,
                arrowBody,
                model,
                tupleTainted,
                tupleEdges,
                tupleScalarEdges
            )
        }
        for statement in EnumerateOwnReturns(body) {
            if statement.Expression != nil {
                CollectDeclarationTupleFlow(
                    target,
                    returnType,
                    statement.Expression,
                    model,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges
                )
            }
        }
        // A yield flows into the envelope's element, not the envelope itself.
        // Keep its type-argument prefix so forwarding collections and projected
        // iterator signatures consult the same tuple-element keys.
        if returnType is INamedTypeSymbol{TypeArguments: {Length: 1}} envelope &&
            envelope.TypeArguments[0] is INamedTypeSymbol{IsTupleType: true} elementTuple {
            for statement in EnumerateOwnYields(body) {
                CollectTupleValueFlow(
                    target,
                    elementTuple,
                    statement.Expression,
                    model,
                    AppendTuplePath(string.Empty, 0),
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges,
                    respectNullGuards: true
                )
            }
        }
    }

    private func CollectTupleGetterFlows(
        property IPropertySymbol,
        arrowBody ExpressionSyntax?,
        accessorList AccessorListSyntax?,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        let getter AccessorDeclarationSyntax? = accessorList?.Accessors.FirstOrDefault(
            (a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.GetAccessorDeclaration)
        )
        CollectTupleReturnFlows(
            property,
            arrowBody ?? getter?.ExpressionBody?.Expression,
            getter?.Body,
            model,
            tupleTainted,
            tupleEdges,
            tupleScalarEdges
        )
    }

    private func CollectTupleArgumentFlows(
        call SyntaxNode,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        let arguments = GetCallArguments(call, model)
        if arguments.IsDefaultOrEmpty {
            return
        }
        for argument in arguments {
            if argument.Parameter is IParameterSymbol parameter &&
                argument
                .Value
                ?.Syntax is ExpressionSyntax value &&
                parameter.Type is ITypeSymbol parameterType {
                CollectDeclarationTupleFlow(
                    Canonical(parameter),
                    parameterType,
                    value,
                    model,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges
                )
            }
            CollectGenericReceiverTupleArgumentFlow(call, argument, model, tupleTainted, tupleEdges, tupleScalarEdges)
        }
    }

    // Issue #3564: Dictionary<TKey, TValue> indexer/method parameters use the
    // receiver's generic TKey slot. When a promoted tuple flows into that slot,
    // carry its per-element taint back to the source field/property type so all
    // uses share Dictionary[(T?, U), TValue] instead of asserting at each use.
    private func CollectGenericReceiverTupleArgumentFlow(
        call SyntaxNode,
        argument IArgumentOperation,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        let receiver ExpressionSyntax? = switch call {
            case InvocationExpressionSyntax{Expression: MemberAccessExpressionSyntax member}: member.Expression
            case elementAccess is ElementAccessExpressionSyntax: elementAccess.Expression
            default: default(ExpressionSyntax?)
        }
        let target ISymbol? = if receiver == nil {
            default(ISymbol?)
        } else {
            model.GetSymbolInfo(receiver).Symbol
        }
        // Issue #3641: a LOCAL collection is just as much a declaration sink as
        // a field/property — `var prepared = new List<(string, byte[])>();
        // prepared.Add((path, original))` is where the null-bearing element
        // enters the tuple that the enclosing method then returns.
        let targetType ITypeSymbol? = switch target {
            case field is IFieldSymbol: field.Type
            case property is IPropertySymbol: property.Type
            case local is ILocalSymbol: local.Type
            case receiverParameter is IParameterSymbol: receiverParameter.Type
            default: default(ITypeSymbol?)
        }
        // Scalar flow already treats out as callee-to-caller and deliberately
        // excludes ref, so neither is receiver-directed here.
        if !(
            (
                target is IFieldSymbol ||
                    target is IPropertySymbol ||
                    target is ILocalSymbol ||
                    target is IParameterSymbol
            )
        ) ||
            targetType is not INamedTypeSymbol receiverType ||
            argument.Parameter is not IParameterSymbol parameter ||
            parameter.RefKind == RefKind.Out ||
            parameter.RefKind == RefKind.Ref ||
            !TryGetGenericReceiverTuplePath(receiverType, parameter, out var tupleType, out var tuplePath) ||
            argument
            .Value
            ?.Syntax is not ExpressionSyntax value {
            return
        }
        CollectTupleValueFlow(
            Canonical(target),
            tupleType,
            value,
            model,
            EncodeTuplePath(tuplePath),
            tupleTainted,
            tupleEdges,
            tupleScalarEdges
        )
    }

    /// Issue #3641: routes a value flowing into a declaration to the bare-tuple
    /// collector or to the nested (generic type argument) one, so a tuple that
    /// lives under `List<T>` / `IReadOnlyList<T>` / `IEnumerable<T>` is the same
    /// declaration sink as a bare tuple. G# tuple types agree structurally, so a
    /// producer's return, the intermediate locals and the consumer's parameter
    /// must all render an element identically or none of them may.
    /// @param target The declaration receiving the value.
    /// @param targetType The declaration's declared (or awaited) type.
    /// @param value The flowing value expression.
    /// @param model The semantic model for [`value`](paramref).
    /// @param tupleTainted Directly tainted tuple leaves.
    /// @param tupleEdges Tuple-leaf to tuple-leaf edges.
    /// @param tupleScalarEdges Tuple-leaf to scalar-declaration edges.
    private func CollectDeclarationTupleFlow(
        target ISymbol?,
        targetType ITypeSymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol)]
    ) {
        if target == nil {
            return
        }
        if targetType is INamedTypeSymbol tuple && tuple.IsTupleType {
            CollectTupleValueFlow(target, tuple, value, model, string.Empty, tupleTainted, tupleEdges, tupleScalarEdges)
            return
        }
        CollectNestedTupleValueFlow(target, targetType, value, model, tupleTainted, tupleEdges)
    }

    // Issue #3641: pairs the nested tuple slots of the target's declared type
    // with those of the source's, positionally and only when both sides expose
    // the same number of slots with the same element arity. That keeps the
    // pairing sound across the covariant hand-offs the shape actually uses
    // (`List<T>` returned as `IReadOnlyList<T>`, passed as `IEnumerable<T>`)
    // without inventing a second cross-signature keying model: each side keeps
    // the element path of ITS OWN rendered type.
    private func CollectNestedTupleValueFlow(
        target ISymbol,
        targetType ITypeSymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        var value = value
        let targetSlots = NestedTupleSlots(targetType)
        if targetSlots.Count == 0 {
            return
        }
        value = UnwrapTupleValue(value)
        switch value {
            case nil {
                return
            }
            case conditional is ConditionalExpressionSyntax {
                CollectNestedTupleValueFlow(target, targetType, conditional.WhenTrue, model, tupleTainted, tupleEdges)
                CollectNestedTupleValueFlow(target, targetType, conditional.WhenFalse, model, tupleTainted, tupleEdges)
                return
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    CollectNestedTupleValueFlow(target, targetType, arm.Expression, model, tupleTainted, tupleEdges)
                }
                return
            }
        }
        let source ISymbol? = switch value {
            case _ is InvocationExpressionSyntax or
                _ is IdentifierNameSyntax or
                _ is MemberAccessExpressionSyntax: model
                .GetSymbolInfo(value!!).Symbol
            default: default(ISymbol?)
        }
        if source == nil {
            return
        }
        let sourceSlots = NestedTupleSlots(SymbolValueType(source))
        if sourceSlots.Count != targetSlots.Count {
            return
        }
        for var i = 0; i < targetSlots.Count; i++ {
            if targetSlots[i].Tuple.TupleElements.Length != sourceSlots[i].Tuple.TupleElements.Length {
                return
            }
        }
        for var i = 0; i < targetSlots.Count; i++ {
            AddTupleShapeEdges(
                target,
                targetSlots[i].Tuple,
                targetSlots[i].Path,
                source,
                sourceSlots[i].Tuple,
                sourceSlots[i].Path,
                tupleTainted,
                tupleEdges
            )
        }
    }

    private func CollectTupleValueFlow(
        target ISymbol?,
        targetTuple INamedTypeSymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        prefix string,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)],
        tupleScalarEdges List[(Target TupleElementKey, Source ISymbol?)],
        respectNullGuards bool = false
    ) {
        var value = value
        value = UnwrapTupleValue(value)
        switch value {
            case nil {
                return
            }
            case conditional is ConditionalExpressionSyntax {
                CollectTupleValueFlow(
                    target,
                    targetTuple,
                    conditional.WhenTrue,
                    model,
                    prefix,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges,
                    respectNullGuards
                )
                CollectTupleValueFlow(
                    target,
                    targetTuple,
                    conditional.WhenFalse,
                    model,
                    prefix,
                    tupleTainted,
                    tupleEdges,
                    tupleScalarEdges,
                    respectNullGuards
                )
                return
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    CollectTupleValueFlow(
                        target,
                        targetTuple,
                        arm.Expression,
                        model,
                        prefix,
                        tupleTainted,
                        tupleEdges,
                        tupleScalarEdges,
                        respectNullGuards
                    )
                }
                return
            }
            case tuple is TupleExpressionSyntax when tuple.Arguments.Count == targetTuple!!.TupleElements.Length {
                for var i = 0; i < targetTuple!!.TupleElements.Length; i++ {
                    let targetType = targetTuple!!.TupleElements[i].Type
                    let elementValue = tuple.Arguments[i].Expression
                    let path = AppendTuplePath(prefix, i)
                    if targetType is INamedTypeSymbol nestedTarget && nestedTarget.IsTupleType {
                        CollectTupleValueFlow(
                            target,
                            nestedTarget,
                            elementValue,
                            model,
                            path,
                            tupleTainted,
                            tupleEdges,
                            tupleScalarEdges,
                            respectNullGuards
                        )
                    } else if IsEligibleTupleLeaf(targetType) {
                        let targetKey = TupleElementKey(target, path)
                        let contextualOperator IMethodSymbol? = GetContextualOperator(elementValue, model, targetType)
                        let canForwardElement = contextualOperator == nil ||
                            CanForwardConversionOperandNullability(
                            targetType,
                            model.GetTypeInfo(elementValue).Type,
                            contextualOperator
                        )
                        if IsDirectlyNullable(elementValue, model, respectNullGuards, resultType: targetType) {
                            tupleTainted.Add(targetKey)
                        } else if canForwardElement &&
                            TryResolveTupleElementSource(elementValue, model, out var tupleSource) {
                            tupleEdges.Add((targetKey, tupleSource))
                        } else {
                            for scalarSource in ResolveSources(
                                elementValue,
                                model,
                                respectNullGuards: respectNullGuards,
                                resultType: targetType
                            ) {
                                // Issue #3615 (2026-08-28 nightly, Cs2Gs.Translator
                                // wall): only SOURCE-declared symbols propagate
                                // into a declaration's tuple element. An imported
                                // metadata member can enter the tainted set only
                                // through the defensive-use seeds (`x?.M` /
                                // `x == null` at some OTHER site) — its declared
                                // annotation is the contract for the value
                                // flowing HERE, and an annotated-nullable
                                // imported read is already caught by
                                // IsDirectlyNullable above. Letting the
                                // defensive-use heuristic rewrite a source
                                // field's element type widened
                                // `HashSet[(SyntaxTree, ...)]` to
                                // `(SyntaxTree?, ...)` and broke every
                                // deconstructing reader. Source-declared is
                                // tested via DeclaringSyntaxReferences (an
                                // imported metadata symbol has none); the null
                                // guard also keeps the self-migrated form of
                                // this loop well-typed — ResolveSources'
                                // iterator element is promoted to ISymbol? by
                                // the same analysis this file implements.
                                if scalarSource == nil {
                                    continue
                                }
                                if scalarSource.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                                    continue
                                }
                                tupleScalarEdges.Add((targetKey, scalarSource))
                            }
                        }
                    }
                }
                return
            }
        }
        if IsDefaultTupleValue(value, model) {
            TaintAllTupleLeaves(target, targetTuple, prefix, tupleTainted)
            return
        }
        if TryResolveTupleSource(value, model, out var source, out var sourceTuple) {
            AddTupleShapeEdges(target, targetTuple, prefix, source, sourceTuple, string.Empty, tupleTainted, tupleEdges)
        }
    }

    private func AddTupleShapeEdges(
        target ISymbol?,
        targetTuple INamedTypeSymbol?,
        targetPrefix string,
        source ISymbol?,
        sourceTuple INamedTypeSymbol?,
        sourcePrefix string,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        let count = Math.Min(targetTuple!!.TupleElements.Length, sourceTuple!!.TupleElements.Length)
        for var i = 0; i < count; i++ {
            let targetType = targetTuple!!.TupleElements[i].Type
            let sourceType = sourceTuple!!.TupleElements[i].Type
            let targetPath = AppendTuplePath(targetPrefix, i)
            let sourcePath = AppendTuplePath(sourcePrefix, i)
            if targetType is INamedTypeSymbol nestedTarget &&
                nestedTarget.IsTupleType &&
                sourceType is INamedTypeSymbol nestedSource &&
                nestedSource
                .IsTupleType {
                AddTupleShapeEdges(
                    target,
                    nestedTarget,
                    targetPath,
                    source,
                    nestedSource,
                    sourcePath,
                    tupleTainted,
                    tupleEdges
                )
            } else if IsEligibleTupleLeaf(targetType) {
                let targetKey = TupleElementKey(target, targetPath)
                if sourceType.IsReferenceType &&
                    sourceType.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    tupleTainted.Add(targetKey)
                } else {
                    tupleEdges.Add((targetKey, TupleElementKey(source, sourcePath)))
                }
            }
        }
    }

    private func TaintAllTupleLeaves(
        target ISymbol?,
        tupleType INamedTypeSymbol?,
        prefix string,
        tupleTainted HashSet[TupleElementKey]
    ) {
        for var i = 0; i < tupleType!!.TupleElements.Length; i++ {
            let elementType = tupleType!!.TupleElements[i].Type
            let path = AppendTuplePath(prefix, i)
            if elementType is INamedTypeSymbol nested && nested.IsTupleType {
                TaintAllTupleLeaves(target, nested, path, tupleTainted)
            } else if IsEligibleTupleLeaf(elementType) {
                tupleTainted.Add(TupleElementKey(target, path))
            }
        }
    }

    private func CollectDeconstructionFlow(
        targetPattern ExpressionSyntax,
        value ExpressionSyntax?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)]
    ) {
        var value = value
        value = UnwrapTupleValue(value)
        if value is ConditionalExpressionSyntax conditional {
            CollectDeconstructionFlow(targetPattern, conditional.WhenTrue, model, tainted, edges, scalarTupleEdges)
            CollectDeconstructionFlow(targetPattern, conditional.WhenFalse, model, tainted, edges, scalarTupleEdges)
            return
        }
        if value is SwitchExpressionSyntax switchExpression {
            for arm in switchExpression.Arms {
                CollectDeconstructionFlow(targetPattern, arm.Expression, model, tainted, edges, scalarTupleEdges)
            }
            return
        }
        if value is TupleExpressionSyntax tupleValue &&
            TryGetDeconstructionElements(targetPattern, out var targets) &&
            targets!!.Count == tupleValue
            .Arguments
            .Count {
            for var i = 0; i < targets!!.Count; i++ {
                CollectDeconstructionFlow(
                    targets!![i],
                    tupleValue.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges
                )
            }
            return
        }
        if value is TupleExpressionSyntax declarationTupleValue &&
            targetPattern is DeclarationExpressionSyntax{
            Designation: ParenthesizedVariableDesignationSyntax declarationPattern
        } &&
            declarationPattern
            .Variables
            .Count == declarationTupleValue
            .Arguments
            .Count {
            for var i = 0; i < declarationPattern.Variables.Count; i++ {
                CollectDesignationFlow(
                    declarationPattern.Variables[i],
                    declarationTupleValue.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges
                )
            }
            return
        }
        if TryResolveDeconstructionTarget(targetPattern, model, out var scalarTarget) {
            if IsDirectlyNullable(value, model) {
                tainted.Add(scalarTarget!!)
            } else if TryResolveTupleElementSource(value, model, out var elementSource) {
                scalarTupleEdges.Add((scalarTarget, elementSource))
            } else {
                AddEdges(scalarTarget, value, model, edges)
            }
            return
        }
        if TryResolveTupleSource(value, model, out var tupleSource, out var sourceTuple) {
            if targetPattern is DeclarationExpressionSyntax{
                Designation: ParenthesizedVariableDesignationSyntax forwardedPattern
            } {
                CollectDesignationPatternFromTupleSource(
                    forwardedPattern,
                    tupleSource,
                    sourceTuple,
                    string.Empty,
                    model,
                    scalarTupleEdges
                )
                return
            }
            CollectPatternFromTupleSource(
                targetPattern,
                tupleSource,
                sourceTuple,
                string.Empty,
                model,
                scalarTupleEdges
            )
        }
    }

    private func CollectDesignationFlow(
        target VariableDesignationSyntax,
        value ExpressionSyntax,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)]
    ) {
        if target is ParenthesizedVariableDesignationSyntax parenthesized &&
            value is TupleExpressionSyntax tuple &&
            parenthesized
            .Variables
            .Count == tuple
            .Arguments
            .Count {
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                CollectDesignationFlow(
                    parenthesized.Variables[i],
                    tuple.Arguments[i].Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges
                )
            }
            return
        }
        if target is not SingleVariableDesignationSyntax single || model.GetDeclaredSymbol(
            single
        ) is not ISymbol declared ||
            !IsValueDeclarationSymbol(declared) {
            return
        }
        let scalarTarget ISymbol? = Canonical(declared)
        if IsDirectlyNullable(value, model) {
            tainted.Add(scalarTarget!!)
        } else if TryResolveTupleElementSource(value, model, out var elementSource) {
            scalarTupleEdges.Add((scalarTarget, elementSource))
        } else {
            AddEdges(scalarTarget, value, model, edges)
        }
    }

    private func CollectPatternFromTupleSource(
        pattern ExpressionSyntax,
        source ISymbol?,
        sourceTuple INamedTypeSymbol?,
        prefix string,
        model SemanticModel,
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)]
    ) {
        if !TryGetDeconstructionElements(pattern, out var targets) {
            return
        }
        let count = Math.Min(targets!!.Count, sourceTuple!!.TupleElements.Length)
        for var i = 0; i < count; i++ {
            let sourceType = sourceTuple!!.TupleElements[i].Type
            let path = AppendTuplePath(prefix, i)
            if sourceType is INamedTypeSymbol nested && nested.IsTupleType {
                CollectPatternFromTupleSource(targets!![i], source, nested, path, model, scalarTupleEdges)
            } else if TryResolveDeconstructionTarget(targets!![i], model, out var scalarTarget) {
                scalarTupleEdges.Add((scalarTarget, TupleElementKey(source, path)))
            }
        }
    }

    private func CollectDesignationPatternFromTupleSource(
        pattern ParenthesizedVariableDesignationSyntax,
        source ISymbol?,
        sourceTuple INamedTypeSymbol?,
        prefix string,
        model SemanticModel,
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)]
    ) {
        let count = Math.Min(pattern.Variables.Count, sourceTuple!!.TupleElements.Length)
        for var i = 0; i < count; i++ {
            let target = pattern.Variables[i]
            let sourceType = sourceTuple!!.TupleElements[i].Type
            let path = AppendTuplePath(prefix, i)
            if target is ParenthesizedVariableDesignationSyntax nestedPattern &&
                sourceType is INamedTypeSymbol nestedTuple &&
                nestedTuple
                .IsTupleType {
                CollectDesignationPatternFromTupleSource(
                    nestedPattern,
                    source,
                    nestedTuple,
                    path,
                    model,
                    scalarTupleEdges
                )
            } else if target is SingleVariableDesignationSyntax single && model.GetDeclaredSymbol(
                single
            ) is ISymbol declared &&
                IsValueDeclarationSymbol(declared) {
                scalarTupleEdges.Add((Canonical(declared), TupleElementKey(source, path)))
            }
        }
    }

    private func TryGetDeconstructionElements(
        pattern ExpressionSyntax,
        out elements IReadOnlyList[ExpressionSyntax]?
    ) bool {
        if pattern is TupleExpressionSyntax tuple {
            elements = tuple.Arguments.Select((a ArgumentSyntax) -> a.Expression).ToList()
            return true
        }
        elements = nil
        return false
    }

    private func TryResolveDeconstructionTarget(
        target ExpressionSyntax,
        model SemanticModel,
        out symbol ISymbol?
    ) bool {
        symbol = switch target {
            case identifier is IdentifierNameSyntax: model.GetSymbolInfo(identifier).Symbol
            case DeclarationExpressionSyntax{
                Designation: SingleVariableDesignationSyntax single
            }: model.GetDeclaredSymbol(single)
            default: default(ISymbol?)
        }
        if symbol != nil && IsValueDeclarationSymbol(symbol) {
            symbol = Canonical(symbol)
            return true
        }
        symbol = nil
        return false
    }

    private func TryResolveTupleSource(
        expression ExpressionSyntax?,
        model SemanticModel?,
        out symbol ISymbol?,
        out tupleType INamedTypeSymbol?
    ) bool {
        var expression = expression
        expression = UnwrapTupleValue(expression)
        symbol = switch expression {
            case invocation is InvocationExpressionSyntax: model.GetSymbolInfo(invocation).Symbol
            case _ is IdentifierNameSyntax or _ is MemberAccessExpressionSyntax: model.GetSymbolInfo(expression!!)
                .Symbol
            default: default(ISymbol?)
        }
        if TryGetTupleType(symbol, out tupleType) {
            return true
        }
        symbol = nil
        tupleType = nil
        return false
    }

    private func TryResolveTupleElementSource(
        expression ExpressionSyntax?,
        model SemanticModel?,
        out source TupleElementKey
    ) bool {
        var expression = expression
        expression = UnwrapTupleValue(expression, model)
        if expression is MemberAccessExpressionSyntax member && model.GetSymbolInfo(member)
            .Symbol is IFieldSymbol field &&
            model
            .GetTypeInfo(member.Expression).Type is INamedTypeSymbol receiverTuple && receiverTuple.IsTupleType {
            let index = TupleElementIndex(receiverTuple, field)
            if index >= 0 {
                if TryResolveTupleElementSource(member.Expression, model, out var parent) {
                    source = TupleElementKey(parent.ContractSymbol, AppendTuplePath(parent.ContractPath, index))
                    return true
                }
                if TryResolveTupleSource(member.Expression, model, out var symbol, out _) {
                    source = TupleElementKey(symbol, index.ToString(CultureInfo.InvariantCulture))
                    return true
                }
            }
        }
        source = default(TupleElementKey)
        return false
    }

    // Issue #3663: resolves a read of a variable declared by a DECONSTRUCTING
    // `foreach` header back to the leaf it aliases — the enumerated collection's
    // declaration symbol plus the element path the type mapper walks when it
    // renders that declaration (`PromoteTupleTypeArguments`: type-argument
    // indexes first, tuple element indexes after). Both header spellings climb
    // the same way: `var (a, b)` nests SingleVariableDesignations inside a
    // ParenthesizedVariableDesignation, while the explicitly typed `(A a, B b)`
    // nests DeclarationExpressions inside a TupleExpression.
    private func TryResolveForEachDeconstructionSource(
        expression ExpressionSyntax?,
        model SemanticModel?,
        out source TupleElementKey
    ) bool {
        source = default(TupleElementKey)
        if model.GetSymbolInfo(expression!!)
            .Symbol is not ILocalSymbol local ||
            local
            .DeclaringSyntaxReferences
            .FirstOrDefault()
            ?.GetSyntax() is not SingleVariableDesignationSyntax designation {
            return false
        }
        let indexes = List[int32]()
        var current SyntaxNode = designation
        var climbing = true
        while climbing {
            switch current.Parent {
                case nested is ParenthesizedVariableDesignationSyntax when current is VariableDesignationSyntax variable {
                    let nestedIndex = nested.Variables.IndexOf(variable)
                    if nestedIndex < 0 {
                        return false
                    }
                    indexes.Insert(0, nestedIndex)
                    current = nested
                }
                case declaration is DeclarationExpressionSyntax {
                    current = declaration
                }
                case argument is ArgumentSyntax when argument.Parent is TupleExpressionSyntax tuple {
                    let tupleIndex = tuple.Arguments.IndexOf(argument)
                    if tupleIndex < 0 {
                        return false
                    }
                    indexes.Insert(0, tupleIndex)
                    current = tuple
                }
                default {
                    climbing = false
                }
            }
        }
        if indexes.Count == 0 ||
            current.Parent is not ForEachVariableStatementSyntax forEach ||
            forEach.Variable != current {
            return false
        }
        if model.GetForEachStatementInfo(forEach)
            .ElementType is not INamedTypeSymbol elementTuple ||
            !elementTuple.IsTupleType ||
            model
            .GetSymbolInfo(forEach.Expression)
            .Symbol is not{} collection ||
            SymbolValueType(collection) is not{} collectionType {
            return false
        }
        // The enumerated element tuple has to sit at exactly ONE position of the
        // collection's rendered type; an ambiguous match (two identical tuple
        // slots) would key the leaf arbitrarily, so leave those unbridged.
        let slots = NestedTupleSlots(collectionType).Where(
            (slot(Path string, Tuple INamedTypeSymbol)) -> SymbolEqualityComparer.Default.Equals(
                slot.Tuple,
                elementTuple
            )
        )
            .ToList()
        if slots.Count != 1 {
            return false
        }
        var path = slots[0].Path
        for index in indexes {
            path = AppendTuplePath(path, index)
        }
        source = TupleElementKey(Canonical(collection), path)
        return true
    }

    private func TupleElementIndex(tupleType INamedTypeSymbol, field IFieldSymbol) int32 {
        let canonicalField = field.CorrespondingTupleField ?? field
        for var i = 0; i < tupleType.TupleElements.Length; i++ {
            let candidate = tupleType.TupleElements[i].CorrespondingTupleField ?? tupleType.TupleElements[i]
            if SymbolEqualityComparer.Default.Equals(candidate, canonicalField) ||
                tupleType
                .TupleElements[i]
                .Name == field.Name {
                return i
            }
        }
        return -1
    }

    private func TryGetTupleType(symbol ISymbol?, out tupleType INamedTypeSymbol?) bool {
        tupleType = SymbolValueType(symbol) as INamedTypeSymbol
        return tupleType != nil && tupleType.IsTupleType == true
    }

    /// Issue #3641: the tuple positions reachable from [`type`](paramref)
    /// through generic type ARGUMENTS (`List<(string, byte[])>`), keyed by the
    /// very path the type mapper walks when it renders the declaration
    /// (`PromoteTupleTypeArguments`): type-argument indexes first, tuple
    /// element indexes after. Bare tuple types are excluded — those already own
    /// the empty-prefix key — so the two collectors never key the same leaf twice.
    /// @param type The declared type to scan.
    /// @returns The nested tuple slots, outermost type argument first.
    private func NestedTupleSlots(type ITypeSymbol?) List[(Path string, Tuple INamedTypeSymbol)] {
        let slots = List[(Path string, Tuple INamedTypeSymbol)]()
        if type is INamedTypeSymbol named && !named.IsTupleType {
            CollectNestedTupleSlots(type, string.Empty, slots)
        }
        return slots
    }

    private func CollectNestedTupleSlots(
        type ITypeSymbol?,
        prefix string,
        slots List[(Path string, Tuple INamedTypeSymbol)]
    ) {
        if type is not INamedTypeSymbol named {
            return
        }
        if named.IsTupleType {
            slots.Add((prefix, named))
            return
        }
        for var i = 0; i < named.TypeArguments.Length; i++ {
            CollectNestedTupleSlots(named.TypeArguments[i], AppendTuplePath(prefix, i), slots)
        }
    }

    private func TryResolveReceiverTypeParameterPath(
        receiverType INamedTypeSymbol?,
        declaringType INamedTypeSymbol,
        ordinal int32,
        out tupleType INamedTypeSymbol?,
        out path IReadOnlyList[int32]?
    ) bool {
        tupleType = nil
        path = nil
        if SymbolEqualityComparer.Default.Equals(receiverType!!.OriginalDefinition, declaringType) {
            if ordinal >= receiverType!!
                .TypeArguments
                .Length ||
                receiverType!!.TypeArguments[ordinal] is not INamedTypeSymbol directTuple ||
                !directTuple.IsTupleType {
                return false
            }
            tupleType = directTuple
            path = []int32{ordinal}
            return true
        }
        for (constructed, template) in EnumerateDirectReceiverTypes(receiverType) {
            if !TryResolveReceiverTypeParameterPath(
                constructed,
                declaringType,
                ordinal,
                out var inheritedTuple,
                out var inheritedPath
            ) ||
                !TryFollowTypeArgumentPath(template, inheritedPath, out var source) ||
                source is not ITypeParameterSymbol sourceParameter ||
                sourceParameter.ContainingType is not INamedTypeSymbol sourceOwner ||
                !SymbolEqualityComparer
                .Default
                .Equals(sourceOwner.OriginalDefinition, receiverType!!.OriginalDefinition) {
                continue
            }
            tupleType = inheritedTuple
            path = []int32{sourceParameter.Ordinal}
            return true
        }
        return false
    }

    private func EnumerateDirectReceiverTypes(receiverType INamedTypeSymbol?) sequence[
        (Constructed INamedTypeSymbol, Template INamedTypeSymbol)
    ] {
        let original = receiverType!!.OriginalDefinition
        if receiverType!!.BaseType is INamedTypeSymbol baseType && original.BaseType is INamedTypeSymbol baseTemplate {
            yield(baseType, baseTemplate)
        }
        for iface in receiverType!!.Interfaces {
            let template INamedTypeSymbol? = original.Interfaces.FirstOrDefault(
                (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                    candidate.OriginalDefinition,
                    iface.OriginalDefinition
                )
            )
            if template != nil {
                yield(iface, template)
            }
        }
    }

    private func TryFollowTypeArgumentPath(
        type INamedTypeSymbol,
        path IReadOnlyList[int32]?,
        out result ITypeSymbol?
    ) bool {
        result = type
        for index in path!! {
            if result is not INamedTypeSymbol named || index >= named.TypeArguments.Length {
                result = nil
                return false
            }
            result = named.TypeArguments[index]
        }
        return true
    }

    private func IsEligibleTupleLeaf(type ITypeSymbol?) bool -> type != nil &&
        type.IsReferenceType &&
        type.NullableAnnotation == Microsoft
        .CodeAnalysis
        .NullableAnnotation
        .None

    private func CanPromoteTuplePosition(
        compilation Compilation?,
        symbol ISymbol?,
        path string
    ) bool -> CanPromoteTuplePosition(compilation, symbol, path, HashSet[ISymbol](SymbolEqualityComparer.Default))

    private func CanPromoteTuplePosition(
        compilation Compilation?,
        symbol ISymbol?,
        path string,
        visited HashSet[ISymbol]
    ) bool {
        var symbol = symbol
        var path = path
        if symbol is IParameterSymbol{
            ContainingSymbol: IMethodSymbol{AssociatedSymbol: IPropertySymbol property} setter
        } parameter &&
            setter.MethodKind == MethodKind.PropertySet &&
            parameter.Ordinal == setter
            .Parameters
            .Length - 1 {
            symbol = property
        }
        symbol = OwningMember(symbol)
        let contractSymbol ISymbol? = symbol
        let contractPath = path
        let declaredPosition ITypeSymbol? = TuplePositionType(Canonical(symbol), path)
        symbol, path = ProjectTupleContractPosition(symbol, path)
        let sourceOwnedContract = contractSymbol != nil &&
            IsSourceAssembly(compilation, contractSymbol.ContainingAssembly)
        // A caller owns nested tuple leaves, not a native reference slot itself.
        let position ITypeSymbol? = TuplePositionType(
            symbol,
            path,
            requireTuple: symbol is INamedTypeSymbol && !sourceOwnedContract
        )
        if !IsEligibleTupleLeaf(position) || (declaredPosition != nil && !IsEligibleTupleLeaf(declaredPosition)) {
            return false
        }
        // Constructed type arguments belong to their source use, not to the
        // imported generic definition. Member signatures retain their owner.
        if contractSymbol is INamedTypeSymbol || (symbol is INamedTypeSymbol && !sourceOwnedContract) {
            return true
        }
        if !sourceOwnedContract {
            return false
        }
        if !visited.Add(contractSymbol!!) {
            return true
        }
        for contract in TupleContractDeclarations(compilation, contractSymbol) {
            if TupleContractPositionAcceptsNil(compilation, contract, contractPath) {
                continue
            }
            if !CanPromoteTuplePosition(compilation, contract, contractPath, visited) {
                return false
            }
        }
        return true
    }

    private func TupleContractPositionAcceptsNil(
        compilation Compilation?,
        symbol ISymbol?,
        path string
    ) bool -> IsDeclaredNullablePosition(TuplePositionType(symbol, path)) ||
        (
        !IsSourceAssembly(compilation, symbol!!.ContainingAssembly) &&
            IsObliviousConcreteReferencePosition(TuplePositionType(symbol!!.OriginalDefinition, path))
    )

    private func TuplePositionType(symbol ISymbol?, path string, requireTuple bool = false) ITypeSymbol? {
        var type ITypeSymbol? = SymbolValueType(symbol) ?? symbol as INamedTypeSymbol
        var crossesTuple = false
        for component in path.Split('.') {
            if type is not INamedTypeSymbol named || !int32.TryParse(component, out var index) || index < 0 {
                return nil
            }
            if named.IsTupleType && index < named.TupleElements.Length {
                crossesTuple = true
                type = named.TupleElements[index].Type
            } else if !named.IsTupleType && index < named.TypeArguments.Length {
                type = named.TypeArguments[index]
            } else {
                return nil
            }
        }
        return if !requireTuple || crossesTuple {
            type
        } else {
            default(ITypeSymbol?)
        }
    }

    private func TupleContractDeclarations(compilation Compilation?, symbol ISymbol?) sequence[ISymbol?] {
        if symbol is IParameterSymbol parameter {
            for contract in TupleContractDeclarations(compilation, OwningMember(parameter.ContainingSymbol)) {
                let inheritedParameter IParameterSymbol? = switch contract {
                    case method is IMethodSymbol when parameter.Ordinal >= 0 &&
                        parameter.Ordinal < method
                        .Parameters
                        .Length: method.Parameters[parameter.Ordinal]
                    case property is IPropertySymbol when parameter.Ordinal >= 0 &&
                        parameter.Ordinal < property
                        .Parameters
                        .Length: property.Parameters[parameter.Ordinal]
                    default: default(IParameterSymbol?)
                }
                if inheritedParameter != nil {
                    yield inheritedParameter
                }
            }
            yield break
        }
        if symbol is IMethodSymbol partial {
            if partial.MethodKind == MethodKind.AnonymousFunction {
                for reference in partial.DeclaringSyntaxReferences {
                    if reference.GetSyntax() is AnonymousFunctionExpressionSyntax lambda &&
                        compilation!!.ContainsSyntaxTree(lambda.SyntaxTree) &&
                        compilation!!
                        .GetSemanticModel(lambda.SyntaxTree)
                        .GetTypeInfo(lambda)
                        .ConvertedType is INamedTypeSymbol{DelegateInvokeMethod: {} invoke} {
                        yield invoke
                    }
                }
            }
            if partial.PartialDefinitionPart != nil {
                yield partial.PartialDefinitionPart!!
            }
            if partial.PartialImplementationPart != nil {
                yield partial.PartialImplementationPart!!
            }
        }
        if symbol is IPropertySymbol partialProperty {
            if partialProperty.PartialDefinitionPart != nil {
                yield partialProperty.PartialDefinitionPart!!
            }
            if partialProperty.PartialImplementationPart != nil {
                yield partialProperty.PartialImplementationPart!!
            }
        }
        if !((symbol is IMethodSymbol || symbol is IPropertySymbol)) {
            yield break
        }
        for inherited in InheritedDeclarations(symbol) {
            yield inherited
        }
    }

    private func IsEligibleScalarTarget(symbol ISymbol?) bool {
        let type ITypeSymbol? = SymbolValueType(symbol)
        return type != nil &&
            type.IsReferenceType &&
            type.NullableAnnotation != Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated
    }

    private func IsDefaultTupleValue(
        expression ExpressionSyntax?,
        model SemanticModel
    ) bool -> expression is DefaultExpressionSyntax ||
        (
        expression is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.DefaultLiteralExpression) &&
            (model.GetTypeInfo(literal).ConvertedType is INamedTypeSymbol and {IsTupleType: true})
    )

    private func UnwrapTupleValue(expression ExpressionSyntax?, model SemanticModel? = nil) ExpressionSyntax? {
        var expression = expression
        while true {
            if model != nil {
                for var conversion IConversionOperation? = GetResultConversion(expression, model);
                    conversion != nil;
                    conversion = conversion!!.Operand as IConversionOperation {
                    // Tuple envelopes preserve leaf flow, not scalar nulls.
                    if conversion.Type is not(INamedTypeSymbol and {IsTupleType: true}) &&
                        !CanForwardCastOperandNullability(conversion) {
                        return nil
                    }
                }
            }
            switch expression {
                case parenthesized is ParenthesizedExpressionSyntax {
                    expression = parenthesized.Expression
                    continue
                }
                case checkedExpression is CheckedExpressionSyntax {
                    expression = checkedExpression.Expression
                    continue
                }
                case cast is CastExpressionSyntax {
                    expression = cast.Expression
                    continue
                }
                case awaitExpression is AwaitExpressionSyntax {
                    expression = awaitExpression.Expression
                    continue
                }
                default {
                    return expression
                }
            }
        }
    }

    private func AppendTuplePath(prefix string, index int32) string -> if string.IsNullOrEmpty(prefix) {
        index.ToString(CultureInfo.InvariantCulture)
    } else {
        prefix + "." + index.ToString(CultureInfo.InvariantCulture)
    }

    private func EncodeTuplePath(path IReadOnlyList[int32]?) string -> string.Join(
        ".",
        path!!.Select((i int32) -> i.ToString(CultureInfo.InvariantCulture))
    )

    // Return taint: for each method / accessor / local function, examine every
    // `return` (or arrow expression body) that belongs to it (not to a nested
    // lambda / local function). A directly-null return taints the member's
    // return symbol immediately; any other return records a transitive edge.
    private func SeedReturnTaint(
        root SyntaxNode,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)]
    ) {
        for node in root.DescendantNodes() {
            switch node {
                case method is MethodDeclarationSyntax {
                    SeedMethodLikeReturnTaint(
                        model.GetDeclaredSymbol(method),
                        method.ExpressionBody?.Expression,
                        method.Body,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
                case localFunction is LocalFunctionStatementSyntax {
                    SeedMethodLikeReturnTaint(
                        model.GetDeclaredSymbol(localFunction),
                        localFunction.ExpressionBody?.Expression,
                        localFunction.Body,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
                case lambda is AnonymousFunctionExpressionSyntax {
                    SeedMethodLikeReturnTaint(
                        model.GetSymbolInfo(lambda).Symbol,
                        lambda.Body as ExpressionSyntax,
                        lambda.Body as BlockSyntax,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
                case property is PropertyDeclarationSyntax {
                    SeedPropertyLikeReturnTaint(
                        model.GetDeclaredSymbol(property),
                        property.ExpressionBody?.Expression,
                        property.AccessorList,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
                case indexer is IndexerDeclarationSyntax {
                    SeedPropertyLikeReturnTaint(
                        model.GetDeclaredSymbol(indexer),
                        indexer.ExpressionBody?.Expression,
                        indexer.AccessorList,
                        model,
                        tainted,
                        edges,
                        scalarTupleEdges
                    )
                }
            }
        }
    }

    private func SeedMethodLikeReturnTaint(
        returnSymbol ISymbol?,
        arrowBody ExpressionSyntax?,
        body BlockSyntax?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)]
    ) {
        if !(returnSymbol is IMethodSymbol && returnSymbol.ReturnsVoid == false) {
            return
        }
        let canonicalReturn ISymbol? = Canonical(returnSymbol)
        if arrowBody != nil {
            ApplyReturnValue(canonicalReturn, arrowBody, model, tainted, edges, scalarTupleEdges, transitive: true)
        }
        for statement in EnumerateOwnReturns(body) {
            if statement.Expression != nil {
                ApplyReturnValue(
                    canonicalReturn,
                    statement.Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges,
                    transitive: true
                )
            }
        }
        // Issue #3501: an ITERATOR'S yields are its returns for element-taint
        // purposes — `yield return null` (or yielding a promoted-nullable
        // value) makes the iterator's ELEMENT nullable, which the translator
        // renders as `sequence[T?]`. Without this, the signature stayed
        // `sequence[T]` while the yield-seam bridge stood down (the method
        // looked promoted), leaving a bare `T? -> T` at every guarded yield.
        for statement in EnumerateOwnYields(body) {
            let yielded ExpressionSyntax? = statement.Expression
            // Issue #3700: a yield that a syntactic null-check guard proves
            // non-null yields no evidence about the ELEMENT. The canonical
            // shape is `var child = (T)p.GetValue(o); if (child != null) {
            // yield return child; }` — the local is nullable because the
            // reflective read lowers to `as`, but the element never is.
            // Promoting it anyway widens the iterator's element to `T?`,
            // and that `T?` then escapes through every `foreach` variable
            // and recursive call the sequence feeds (gsc GS0154). The
            // repair belongs at the DECLARATION, exactly as it does for a
            // guarded constructor argument above: gsc's own smart-cast
            // narrows the same guarded read at the yield seam, so standing
            // the promotion down reintroduces no `T? -> T`.
            // The guard proves the operand, not a nullable operator result.
            if IsNullGuardDominatedRead(yielded, model) &&
                !IsDirectlyNullable(yielded, model, respectNullGuards: true) {
                continue
            }
            ApplyReturnValue(canonicalReturn, yielded, model, tainted, edges, scalarTupleEdges, transitive: true)
        }
    }

    private func SeedPropertyLikeReturnTaint(
        propertySymbol IPropertySymbol?,
        propertyArrowBody ExpressionSyntax?,
        accessorList AccessorListSyntax?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)]
    ) {
        // Only reference-typed, not-already-nullable property/indexer types are
        // governed by this analysis; value types and `T?` declarations are left
        // untouched.
        if !(propertySymbol != nil && propertySymbol.Type.IsReferenceType == true) ||
            propertySymbol
            .Type
            .NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated {
            return
        }
        let canonicalReturn ISymbol? = Canonical(propertySymbol)
        // A property/indexer getter is direct-taint always: a syntactically
        // nullable body (`?.` / `??`-with-nullable-fallback / ternary /
        // `return null`) promotes the property to `T?` (issue #2157).
        //
        // Issue #2167: it is ALSO transitive for a property that neither
        // overrides a base member nor implements an interface member — a getter
        // that returns a nullable-returning method / forwards a tainted
        // declaration (e.g. `MotherboardInfo.InstallDate` returning
        // `ConvertToDateTime(...)` whose own return is `string?`) must itself be
        // `T?`, otherwise gsc rejects the `T? -> T` return (GS0156). For an
        // OVERRIDE / interface implementation we keep the direct-taint-only
        // behavior and rely on the translator's null-forgiveness pass (issue
        // #1354) to assert the forwarded value non-null, preserving the property
        // contract with the base / interface declaration.
        //
        // Issue #914 (oblivious sink): a NON-CONTRACT getter that merely FORWARDS
        // a promoted-nullable field/local/parameter (e.g. `TextWriter Writer =>
        // logStreamWriter;` where the backing field is a promoted `StreamWriter?`
        // — null-assigned in `CloseWriter`) must itself be `T?`, otherwise the
        // `StreamWriter? -> TextWriter` getter return is rejected (GS0155). Such
        // a property genuinely can be null, so field/local/param forwarding is
        // followed (`SourceScope.CallsAndNonPropertyDeclarations`); every
        // downstream member use (`Writer.WriteLine(...)`) then gets its `!!`
        // assertion from the translator's null-forgiveness pass, which keys off
        // the same promotion. Forwarding ANOTHER PROPERTY is deliberately NOT
        // followed, so `string Forward => Work;` keeps its declared type and the
        // #1354 / #2167 property-contract guardrail is preserved. A contract
        // member stays direct-taint-only (transitive is false below, so the
        // forwarding edges are not recorded for it regardless).
        let transitive = !ImplementsBaseOrInterfaceMember(propertySymbol)
        // `Prop => expr;`
        if propertyArrowBody != nil {
            ApplyReturnValue(
                canonicalReturn,
                propertyArrowBody,
                model,
                tainted,
                edges,
                scalarTupleEdges,
                transitive,
                SourceScope.CallsAndNonPropertyDeclarations
            )
        }
        // Only the `get` accessor produces the property value; `set`/`init`
        // return void and are ignored.
        let getter AccessorDeclarationSyntax? = accessorList?.Accessors.FirstOrDefault(
            (a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.GetAccessorDeclaration)
        )
        if getter == nil {
            return
        }
        // `get => expr;`
        if getter.ExpressionBody?.Expression is ExpressionSyntax getterArrow {
            ApplyReturnValue(
                canonicalReturn,
                getterArrow,
                model,
                tainted,
                edges,
                scalarTupleEdges,
                transitive,
                SourceScope.CallsAndNonPropertyDeclarations
            )
        }
        // `get { ... return x; }`
        for statement in EnumerateOwnReturns(getter.Body) {
            if statement.Expression != nil {
                ApplyReturnValue(
                    canonicalReturn,
                    statement.Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges,
                    transitive,
                    SourceScope.CallsAndNonPropertyDeclarations
                )
            }
        }
    }

    // Whether the property/indexer overrides a base member or implements an
    // interface member (explicitly or implicitly). Such a member's emitted G#
    // return type must stay in lock-step with the base / interface declaration,
    // so it is excluded from TRANSITIVE return promotion (issue #2167 guardrail;
    // preserves issue #2157 / #1354 behavior for contract members).
    private func ImplementsBaseOrInterfaceMember(property IPropertySymbol?) bool {
        if property!!.IsOverride || !property!!.ExplicitInterfaceImplementations.IsDefaultOrEmpty {
            return true
        }
        let containingType INamedTypeSymbol? = property!!.ContainingType
        if containingType == nil {
            return false
        }
        for iface in containingType.AllInterfaces {
            for member in iface.GetMembers() {
                if member is IPropertySymbol && SymbolEqualityComparer.Default.Equals(
                    containingType.FindImplementationForInterfaceMember(member),
                    property
                ) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #2285: for every source-declared type in [`compilation`](paramref)
    /// that implements an interface, records BIDIRECTIONAL taint edges between
    /// each reference-typed interface property and the member that implements
    /// it, so the two endpoints of the same logical contract always reach the
    /// SAME tainted-ness in the fixpoint below — cs2gs must never promote only
    /// one side (the interface property's `T` vs. the implementation's `T?`),
    /// since gsc's Kotlin-style get-only-property variance rejects a non-null
    /// interface contract satisfied by a nullable member (GS0187, tightened by
    /// the #2150/#2284 follow-up). Both directions are recorded (not just the
    /// sound "impl nullable -> widen the interface" direction) so the two
    /// endpoints CONVERGE regardless of which side taint was originally seeded
    /// on (e.g. a caller might null-check through the INTERFACE-typed reference
    /// rather than the concrete type).
    ///
    /// A C# record's positional parameter is a distinct (cref:ISymbol)
    /// from its synthesized auto-property (the one
    /// `INamedTypeSymbol.FindImplementationForInterfaceMember`
    /// reports as the interface-member implementation) — yet cs2gs maps the
    /// PARAMETER's own type, not the property's, to the emitted G# primary-
    /// constructor parameter ((cref:CSharpToGSharpTranslator.DeclarationVisitor.MapParameter)).
    /// The synthesized property's declaring syntax reference IS the parameter
    /// syntax node itself for a positional record member, so the corresponding
    /// (cref:IParameterSymbol) is resolved from it and wired into the
    /// same edge set, generalizing this fix beyond ordinary classes/properties
    /// to record positional parameters.
    /// @param compilation The C# compilation being translated.
    /// @param edges The taint-edge list to append to.
    private func CollectInterfaceImplementationEdges(
        compilation Compilation,
        edges List[(Target ISymbol, Source ISymbol)]
    ) {
        for type in EnumerateSourceNamedTypes(compilation) {
            if (type.TypeKind != TypeKind.Class && type.TypeKind != TypeKind.Struct) ||
                type
                .AllInterfaces
                .IsDefaultOrEmpty {
                continue
            }
            for iface in type.AllInterfaces {
                for member in iface.GetMembers() {
                    switch member {
                        case interfaceProperty is IPropertySymbol {
                            CollectInterfacePropertyEdges(compilation, type, interfaceProperty, edges)
                        }
                        case interfaceMethod is IMethodSymbol {
                            CollectInterfaceMethodEdges(type, interfaceMethod, edges)
                        }
                    }
                }
            }
        }
    }

    private func CollectInterfacePropertyEdges(
        compilation Compilation,
        type INamedTypeSymbol,
        interfaceProperty IPropertySymbol,
        edges List[(Target ISymbol?, Source ISymbol?)]
    ) {
        if type.FindImplementationForInterfaceMember(interfaceProperty) is not IPropertySymbol implementingProperty {
            return
        }
        if IsEligibleScalarTarget(interfaceProperty) {
            let interfaceCanonical ISymbol? = Canonical(interfaceProperty)
            let implCanonical ISymbol? = Canonical(implementingProperty)
            edges.Add((interfaceCanonical, implCanonical))
            edges.Add((implCanonical, interfaceCanonical))
            let positionalParameter IParameterSymbol? = FindPositionalRecordParameter(compilation, implementingProperty)
            if positionalParameter != nil {
                let paramCanonical ISymbol? = Canonical(positionalParameter)
                edges.Add((interfaceCanonical, paramCanonical))
                edges.Add((paramCanonical, interfaceCanonical))
            }
        }
        AddParameterContractEdges(interfaceProperty.Parameters, implementingProperty.Parameters, edges)
    }

    // Issue #2423: the method-return analog of
    // <see cref="CollectInterfacePropertyEdges"/>. `CollectInterfaceImplementationEdges`
    // previously handled ONLY properties, so a method that implements an
    // interface member had no synchronization at all: `SeedMethodLikeReturnTaint`
    // (unlike its property counterpart) applies UNCONDITIONAL transitive
    // return-taint promotion to every method, including one that implements an
    // interface — so an implementation whose body forwards a tainted call (e.g.
    // an `async Task&lt;T&gt;` method delegating to a sibling overload that can
    // return null) is correctly promoted to `T?`, but the interface declaration
    // it implements — which has no body of its own to seed taint from — never
    // is, producing an internally-inconsistent translation gsc's Kotlin-style
    // interface-conformance check rejects (GS0187: "does not implement interface
    // method"). Only an ORDINARY method member is considered (interface property
    // accessors surface as <see cref="IMethodSymbol"/> too via
    // <see cref="ITypeSymbol.GetMembers()"/> and are already handled by the
    // property edge above). The eligibility check is keyed off the UNWRAPPED
    // `async Task&lt;T&gt;`/`ValueTask&lt;T&gt;` result type (mirroring
    // <c>CSharpToGSharpTranslator.PromoteAwaitedReturnIfTainted</c>'s own
    // unwrap), since the interface method symbol's own <c>ReturnType</c> is the
    // `Task&lt;T&gt;` envelope regardless of the implementing method's `async`
    // modifier (a signature-level fact, not an implementation detail) — so a
    // value-typed `Task&lt;int&gt;` is correctly left untouched, exactly like the
    // synchronous case. Both directions are recorded (mirroring the property
    // fix) so the two endpoints always converge to the same tainted-ness
    // regardless of which side (interface or implementation) the taint was
    // originally seeded on.
    private func CollectInterfaceMethodEdges(
        type INamedTypeSymbol,
        interfaceMethod IMethodSymbol,
        edges List[(Target ISymbol, Source ISymbol)]
    ) {
        if interfaceMethod.MethodKind != MethodKind.Ordinary || type.FindImplementationForInterfaceMember(
            interfaceMethod
        ) is not IMethodSymbol implementingMethod {
            return
        }
        AddReturnContractEdges(interfaceMethod, implementingMethod, edges)
        AddParameterContractEdges(interfaceMethod.Parameters, implementingMethod.Parameters, edges)
    }

    private func CollectOverrideContractEdges(compilation Compilation, edges List[(Target ISymbol, Source ISymbol)]) {
        for type in EnumerateSourceNamedTypes(compilation) {
            for method in type.GetMembers().OfType[IMethodSymbol]() {
                if method.MethodKind == MethodKind.Ordinary && method.OverriddenMethod is IMethodSymbol overridden {
                    AddReturnContractEdges(method, overridden, edges)
                    AddParameterContractEdges(method.Parameters, overridden.Parameters, edges)
                }
            }
            for property in type.GetMembers().OfType[IPropertySymbol]() {
                if property.OverriddenProperty is IPropertySymbol overridden {
                    AddParameterContractEdges(property.Parameters, overridden.Parameters, edges)
                }
            }
        }
    }

    private func AddReturnContractEdges(
        first IMethodSymbol,
        second IMethodSymbol,
        edges List[(Target ISymbol?, Source ISymbol?)]
    ) {
        let effectiveReturnType = UnwrapAwaitedType(first.ReturnType)
        if first.ReturnsVoid ||
            second.ReturnsVoid ||
            !(effectiveReturnType != nil && effectiveReturnType.IsReferenceType == true) ||
            effectiveReturnType.NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated {
            return
        }
        let firstCanonical ISymbol? = Canonical(first)
        let secondCanonical ISymbol? = Canonical(second)
        edges.Add((firstCanonical, secondCanonical))
        edges.Add((secondCanonical, firstCanonical))
    }

    private func AddParameterContractEdges(
        first ImmutableArray[IParameterSymbol],
        second ImmutableArray[IParameterSymbol],
        edges List[(Target ISymbol?, Source ISymbol?)]
    ) {
        let count = Math.Min(first.Length, second.Length)
        for var i = 0; i < count; i++ {
            if !IsEligibleScalarTarget(first[i]) || !IsEligibleScalarTarget(second[i]) {
                continue
            }
            let firstCanonical ISymbol? = Canonical(first[i])
            let secondCanonical ISymbol? = Canonical(second[i])
            edges.Add((firstCanonical, secondCanonical))
            edges.Add((secondCanonical, firstCanonical))
        }
    }

    private func CollectTupleContractEdges(
        compilation Compilation,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        for type in EnumerateSourceNamedTypes(compilation) {
            for method in type.GetMembers().OfType[IMethodSymbol]() {
                if method.MethodKind != MethodKind.Ordinary {
                    continue
                }
                if method.OverriddenMethod is IMethodSymbol overridden {
                    AddTupleContractPair(
                        method,
                        SymbolValueType(method),
                        overridden,
                        SymbolValueType(overridden),
                        tupleTainted,
                        tupleEdges
                    )
                }
                if method.PartialImplementationPart is IMethodSymbol implementation {
                    AddTupleContractPair(
                        method,
                        SymbolValueType(method),
                        implementation,
                        SymbolValueType(implementation),
                        tupleTainted,
                        tupleEdges
                    )
                }
            }
            for iface in type.AllInterfaces {
                for interfaceMember in iface.GetMembers() {
                    if !((interfaceMember is IMethodSymbol || interfaceMember is IPropertySymbol)) ||
                        (
                        interfaceMember is IMethodSymbol interfaceMethod &&
                            interfaceMethod.MethodKind != MethodKind.Ordinary
                    ) ||
                        type.FindImplementationForInterfaceMember(interfaceMember) is not ISymbol implementation {
                        continue
                    }
                    AddTupleContractPair(
                        interfaceMember,
                        SymbolValueType(interfaceMember),
                        implementation,
                        SymbolValueType(implementation),
                        tupleTainted,
                        tupleEdges
                    )
                }
            }
            for property in type.GetMembers().OfType[IPropertySymbol]() {
                let positionalParameter IParameterSymbol? = FindPositionalRecordParameter(compilation, property)
                if positionalParameter != nil {
                    AddTupleContractPair(
                        property,
                        SymbolValueType(property),
                        positionalParameter,
                        SymbolValueType(positionalParameter),
                        tupleTainted,
                        tupleEdges
                    )
                }
                if property.PartialImplementationPart is IPropertySymbol implementation {
                    AddTupleContractPair(
                        property,
                        SymbolValueType(property),
                        implementation,
                        SymbolValueType(implementation),
                        tupleTainted,
                        tupleEdges
                    )
                }
                if property.OverriddenProperty is IPropertySymbol overridden {
                    AddTupleContractPair(
                        property,
                        SymbolValueType(property),
                        overridden,
                        SymbolValueType(overridden),
                        tupleTainted,
                        tupleEdges
                    )
                }
            }
        }
    }

    private func CollectConstructedTupleContractEdges(
        compilation Compilation,
        constructedTypes HashSet[INamedTypeSymbol],
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        let pending = Queue[INamedTypeSymbol](EnumerateSourceNamedTypes(compilation).Concat(constructedTypes))
        let visited = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
        while pending.Count > 0 {
            let type = pending.Dequeue()
            if !visited.Add(type) {
                continue
            }
            for (inherited, template) in EnumerateDirectReceiverTypes(type) {
                pending.Enqueue(inherited)
                for (path, tuple) in NestedTupleSlots(inherited) {
                    let leaves = List[(Target TupleElementKey, Source TupleElementKey)]()
                    AddTupleShapeEdges(inherited, tuple, path, inherited, tuple, path, tupleTainted, leaves)
                    for (leaf, _) in leaves {
                        let (owner, sourcePath) = ProjectTupleContractPosition(inherited, leaf.Path, template, type)
                        let projected = TupleElementKey(owner, sourcePath)
                        if TupleElementKeyComparer.Instance.Equals(leaf, projected) {
                            continue
                        }
                        tupleEdges.Add((leaf, projected))
                        tupleEdges.Add((projected, leaf))
                    }
                }
            }
        }
    }

    private func AddTupleContractPair(
        first ISymbol,
        firstType ITypeSymbol?,
        second ISymbol?,
        secondType ITypeSymbol?,
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        var comparisonType ITypeSymbol? = firstType
        if first is IMethodSymbol{Arity: > 0} firstMethod &&
            second is IMethodSymbol secondMethod &&
            firstMethod.Arity == secondMethod
            .Arity {
            // Compare method parameters by ordinal without changing tuple-key ownership.
            comparisonType = SymbolValueType(
                firstMethod.ConstructedFrom.Construct(secondMethod.TypeArguments.ToArray())
            )
        }
        // Covariant envelopes can reorder type arguments. Bare tuple
        // conversions still pair their elements directly, as before.
        if (
            !(firstType is INamedTypeSymbol && firstType.IsTupleType == true) ||
                !(secondType is INamedTypeSymbol && secondType.IsTupleType == true)
        ) &&
            !SymbolEqualityComparer
            .Default
            .Equals(comparisonType, secondType) {
            return
        }
        let firstSlots = NestedTupleSlots(firstType)
        let secondSlots = NestedTupleSlots(secondType)
        if firstType is INamedTypeSymbol{IsTupleType: true} firstTuple {
            firstSlots.Add((string.Empty, firstTuple))
        }
        if secondType is INamedTypeSymbol{IsTupleType: true} secondTuple {
            secondSlots.Add((string.Empty, secondTuple))
        }
        if firstSlots.Count == 0 || firstSlots.Count != secondSlots.Count {
            return
        }
        for var i = 0; i < firstSlots.Count; i++ {
            if firstSlots[i].Tuple.TupleElements.Length != secondSlots[i].Tuple.TupleElements.Length {
                return
            }
        }
        for var i = 0; i < firstSlots.Count; i++ {
            AddTupleShapeEdges(
                first,
                firstSlots[i].Tuple,
                firstSlots[i].Path,
                second,
                secondSlots[i].Tuple,
                secondSlots[i].Path,
                tupleTainted,
                tupleEdges
            )
            AddTupleShapeEdges(
                second,
                secondSlots[i].Tuple,
                secondSlots[i].Path,
                first,
                firstSlots[i].Tuple,
                firstSlots[i].Path,
                tupleTainted,
                tupleEdges
            )
        }
    }

    // Issue #2504: a source named delegate's Invoke return is a declaration
    // contract just like an interface/base method return. Roslyn exposes the
    // selected method group or synthesized lambda method and the converted
    // delegate type at every conversion seam, independent of whether that seam
    // is an initializer, assignment, argument, return, or multicast update.
    private func CollectDelegateReturnContractEdges(
        compilation Compilation,
        root SyntaxNode,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol?, Source ISymbol?)],
        delegateReturnEdges List[(Target ISymbol?, Source ISymbol?)],
        tupleTainted HashSet[TupleElementKey],
        tupleEdges List[(Target TupleElementKey, Source TupleElementKey)]
    ) {
        for expression in root.DescendantNodes().OfType[ExpressionSyntax]() {
            let isLambda = expression is AnonymousFunctionExpressionSyntax
            if !isLambda && model.GetMemberGroup(expression).IsDefaultOrEmpty {
                continue
            }
            if model.GetTypeInfo(expression)
                .ConvertedType is not INamedTypeSymbol delegateType ||
                delegateType.TypeKind != TypeKind.Delegate ||
                delegateType.DelegateInvokeMethod is not IMethodSymbol invoke ||
                invoke.ReturnsVoid {
                continue
            }
            let source IMethodSymbol? = model.GetSymbolInfo(expression).Symbol as IMethodSymbol
            if source == nil || source.ReturnsVoid {
                continue
            }
            AddTupleContractPair(
                invoke,
                SymbolValueType(invoke),
                source,
                SymbolValueType(source),
                tupleTainted,
                tupleEdges
            )
            if !IsSourceDelegateType(compilation, delegateType) || !IsEligibleScalarTarget(invoke) {
                continue
            }
            let invokeCanonical ISymbol? = Canonical(invoke)
            let sourceCanonical ISymbol? = Canonical(source)
            edges.Add((invokeCanonical, sourceCanonical))
            edges.Add((sourceCanonical, invokeCanonical))
            delegateReturnEdges.Add((invokeCanonical, sourceCanonical))
            delegateReturnEdges.Add((sourceCanonical, invokeCanonical))
            if UnwrapAwaitedType(source.ReturnType).NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                tainted.Add(invokeCanonical!!)
            }
        }
    }

    private func IsSourceDelegateType(compilation Compilation, delegateType INamedTypeSymbol) bool -> IsSourceAssembly(
        compilation,
        delegateType.ContainingAssembly
    )

    private func IsSourceAssembly(compilation Compilation?, assembly IAssemblySymbol?) bool {
        if assembly == nil {
            return false
        }
        let assemblies = SourceAssemblies.GetValue(
            compilation!!,
            (current Compilation) -> SourceAssemblySet(current.Assembly.Identity.GetDisplayName())
        )
        lock assemblies.Names {
            return assemblies.Names.Contains(assembly.Identity.GetDisplayName())
        }
    }

    private func RegisterSourceAssemblies(
        compilation CSharpCompilation?,
        siblingCompilations IReadOnlyList[CSharpCompilation]?
    ) {
        let compilations = List[CSharpCompilation]{compilation!!}
        if siblingCompilations != nil {
            compilations.AddRange(siblingCompilations.Where((candidate CSharpCompilation) -> candidate != nil))
        }
        let names = compilations
            .Select((candidate CSharpCompilation) -> candidate.Assembly.Identity.GetDisplayName())
            .Distinct(StringComparer.Ordinal)
            .ToArray()
        for candidate in compilations {
            let assemblies = SourceAssemblies.GetValue(
                candidate,
                (current Compilation) -> SourceAssemblySet(current.Assembly.Identity.GetDisplayName())
            )
            var changed = false
            lock assemblies.Names {
                for name in names {
                    changed |= assemblies.Names.Add(name)
                }
            }
            if changed {
                Cache.Remove(candidate)
            }
        }
    }

    // Unwraps a (non-generic-parameter) `System.Threading.Tasks.Task<T>` or
    // `System.Threading.Tasks.ValueTask<T>` return type to its awaited result
    // `T`, mirroring `CSharpToGSharpTranslator.PromoteAwaitedReturnIfTainted`'s
    // own unwrap so an interface method's `Task<T>`-declared signature is judged
    // on the SAME effective type an `async` implementation's return is. Any
    // other type (including the non-generic `Task`/`ValueTask`, and a
    // value-typed `Task<int>`, whose `T` is filtered out by the reference-type
    // eligibility check at the call site) is returned unchanged.
    private func UnwrapAwaitedType(returnType ITypeSymbol) ITypeSymbol {
        if returnType is INamedTypeSymbol{IsGenericType: true, TypeArguments: {Length: 1}} named &&
            named
            .OriginalDefinition
            .SpecialType != SpecialType.System_Nullable_T &&
            (named.Name == "Task" || named.Name == "ValueTask") &&
            named
            .ContainingNamespace
            ?.ToDisplayString() == "System.Threading.Tasks" {
            return named.TypeArguments[0]
        }
        return returnType
    }

    // A record's positional-parameter property has a declaring syntax
    // reference that IS the `ParameterSyntax` node itself (verified against
    // Roslyn's actual behavior), so the corresponding primary-constructor
    // `IParameterSymbol` — the symbol cs2gs's own primary-constructor mapping
    // promotes — is resolved by re-binding that same syntax node. Returns
    // `null` for an ordinary (non-positional) property.
    private func FindPositionalRecordParameter(compilation Compilation, property IPropertySymbol) IParameterSymbol? {
        for reference in property.DeclaringSyntaxReferences {
            if reference.GetSyntax() is ParameterSyntax parameterSyntax {
                let model = compilation.GetSemanticModel(parameterSyntax.SyntaxTree)
                if model.GetDeclaredSymbol(parameterSyntax) is IParameterSymbol parameterSymbol {
                    return parameterSymbol
                }
            }
        }
        return nil
    }

    // Every source-declared named type reachable from the compilation's
    // assembly, walking nested types too (mirrors
    // `CSharpToGSharpTranslator.EnumerateNamedTypes`, duplicated locally so
    // this analyzer stays a self-contained, independently testable unit).
    private func EnumerateSourceNamedTypes(compilation Compilation) sequence[INamedTypeSymbol] {
        for type in EnumerateNamespaceTypes(compilation.Assembly.GlobalNamespace) {
            yield type
        }
    }

    private func EnumerateNamespaceTypes(ns INamespaceSymbol) sequence[INamedTypeSymbol] {
        for type in ns.GetTypeMembers() {
            for typeOrNested in EnumerateTypeAndNested(type) {
                yield typeOrNested
            }
        }
        for nested in ns.GetNamespaceMembers() {
            for type in EnumerateNamespaceTypes(nested) {
                yield type
            }
        }
    }

    private func EnumerateTypeAndNested(type INamedTypeSymbol) sequence[INamedTypeSymbol] {
        yield type
        for nested in type.GetTypeMembers() {
            for nestedOrDeeper in EnumerateTypeAndNested(nested) {
                yield nestedOrDeeper
            }
        }
    }

    private func ApplyReturnValue(
        returnSymbol ISymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol, Source ISymbol)],
        scalarTupleEdges List[(Target ISymbol, Source TupleElementKey)],
        transitive bool,
        $scope SourceScope = SourceScope.AllSources
    ) {
        if IsDirectlyNullable(value, model) {
            tainted.Add(returnSymbol!!)
        } else if transitive {
            CollectScalarValueFlow(returnSymbol, value, model, tainted, edges, scalarTupleEdges, $scope)
        }
    }

    // The `return` statements that belong to <paramref name="body"/> itself,
    // excluding those inside a nested lambda / local function (which have their
    // own return contract).
    private func EnumerateOwnReturns(body BlockSyntax?) sequence[ReturnStatementSyntax] {
        if body == nil {
            yield break
        }
        for descendant in body.DescendantNodes(
            (n SyntaxNode) -> !((n is LocalFunctionStatementSyntax || n is AnonymousFunctionExpressionSyntax))
        ) {
            if descendant is ReturnStatementSyntax statement {
                yield statement
            }
        }
    }

    private func EnumerateOwnYields(body BlockSyntax?) sequence[YieldStatementSyntax] {
        if body == nil {
            yield break
        }
        for descendant in body.DescendantNodes(
            (n SyntaxNode) -> !((n is LocalFunctionStatementSyntax || n is AnonymousFunctionExpressionSyntax))
        ) {
            if descendant is YieldStatementSyntax{Expression: not nil} statement && statement.IsKind(
                SyntaxKind.YieldReturnStatement
            ) {
                yield statement
            }
        }
    }

    // Adds transitive edges `target <- source` for every declaration symbol the
    // value expression reads (identifier/member) or the method it calls
    // (invocation), unwrapping the compositional forms `??`, `?:`, `(cast)`.
    // <paramref name="scope"/> selects which forwarding sources are followed
    // (see <see cref="SourceScope"/>). This is the interprocedural edge used for
    // property/indexer getters (issue #2167 / #914): a getter returning a
    // nullable-returning method call is promoted; a non-contract getter that
    // forwards a tainted field/local/param is promoted; but a getter that merely
    // FORWARDS another PROPERTY keeps its declared type and relies on the
    // translator's null-forgiveness `!!` pass (issue #1354 / #2157), preserving
    // the property contract.
    private func AddEdges(
        target ISymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        edges List[(Target ISymbol?, Source ISymbol?)],
        $scope SourceScope = SourceScope.AllSources
    ) {
        for source in ResolveSources(value, model, $scope) {
            edges.Add((target, source!!))
        }
    }

    // Issue #2490: a scalar declaration/return/parameter can receive one
    // independently-tainted leaf from the tuple graph introduced for #2469.
    // Preserve the scalar expression-shape rules used by ResolveSources while
    // recording tuple-member reads as element-path edges instead of collapsing
    // them to the synthesized ValueTuple field symbol.
    private func CollectScalarValueFlow(
        target ISymbol?,
        value ExpressionSyntax?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol?, Source ISymbol?)],
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)],
        $scope SourceScope = SourceScope.AllSources,
        readConversion bool = true
    ) {
        if !IsEligibleScalarTarget(target) {
            return
        }
        // Issue #2504/#2496: assigning or returning a lambda/method group moves
        // the callable object, not the value produced by invoking it. Its result
        // taint is wired separately to the converted named delegate's Invoke
        // contract; it must never make the delegate envelope itself nullable.
        if IsCallableValueExpression(value, model) {
            return
        }
        if readConversion && GetResultConversion(value, model) is IConversionOperation conversion {
            CollectScalarValueFlow(target, conversion, model, tainted, edges, scalarTupleEdges, $scope)
            return
        }
        if IsDirectlyNullable(value, model, readConversion: false) {
            tainted.Add(target!!)
            return
        }
        switch value {
            case parenthesized is ParenthesizedExpressionSyntax {
                CollectScalarValueFlow(
                    target,
                    parenthesized.Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges,
                    $scope
                )
                return
            }
            case checkedExpression is CheckedExpressionSyntax {
                CollectScalarValueFlow(
                    target,
                    checkedExpression.Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges,
                    $scope
                )
                return
            }
            case awaitExpression is AwaitExpressionSyntax {
                CollectScalarValueFlow(
                    target,
                    awaitExpression.Expression,
                    model,
                    tainted,
                    edges,
                    scalarTupleEdges,
                    $scope
                )
                return
            }
            case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                return
            }
            case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                CollectScalarValueFlow(target, coalesce.Right, model, tainted, edges, scalarTupleEdges, $scope)
                return
            }
            case conditional is ConditionalExpressionSyntax {
                CollectScalarValueFlow(target, conditional.WhenTrue, model, tainted, edges, scalarTupleEdges, $scope)
                CollectScalarValueFlow(target, conditional.WhenFalse, model, tainted, edges, scalarTupleEdges, $scope)
                return
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    CollectScalarValueFlow(target, arm.Expression, model, tainted, edges, scalarTupleEdges, $scope)
                }
                return
            }
        }
        // Issue #3802: a `[return: NotNullIfNotNull(nameof(p))]` call FORWARDS
        // its named argument's nullability — it is exactly as nullable as `p`
        // is. Recording that as an EDGE rather than a verdict is what keeps
        // cs2gs and gsc agreeing: if the fixpoint later promotes the argument's
        // own declaration to `T?` (which is invisible to the syntactic
        // judgement in `IsDirectlyNullable`, since oblivious C# annotates
        // nothing), the target is promoted with it, exactly as gsc will refuse
        // to narrow a call whose argument it sees as `T?`.
        if ConditionalNotNullPostcondition.TryGetForwardedArgument(
            value!!,
            func (node ExpressionSyntax) ISymbol? {
                return model.GetSymbolInfo(node).Symbol
            },
            out var forwarded
        ) {
            CollectScalarValueFlow(target, forwarded, model, tainted, edges, scalarTupleEdges, $scope)
            return
        }
        if $scope != SourceScope.CallsOnly && TryResolveTupleElementSource(value, model, out var tupleSource) {
            scalarTupleEdges.Add((target, tupleSource))
            return
        }
        AddEdges(target, value, model, edges, $scope)
    }

    private func CollectScalarValueFlow(
        target ISymbol?,
        value IOperation?,
        model SemanticModel,
        tainted HashSet[ISymbol],
        edges List[(Target ISymbol?, Source ISymbol?)],
        scalarTupleEdges List[(Target ISymbol?, Source TupleElementKey)],
        $scope SourceScope
    ) {
        if value is IConversionOperation conversion {
            if IsDirectlyNullable(conversion, model, respectNullGuards: false) {
                tainted.Add(target!!)
                return
            }
            if CanForwardCastOperandNullability(conversion) {
                CollectScalarValueFlow(target, conversion.Operand, model, tainted, edges, scalarTupleEdges, $scope)
            }
            if conversion.OperatorMethod != nil && !IsNonNullableValueType(conversion.Type) {
                if IsDeclaredNullablePosition(conversion.OperatorMethod!!.ReturnType) {
                    tainted.Add(target!!)
                }
                edges.Add((target, Canonical(conversion.OperatorMethod)))
            }
        } else if value?.Syntax is ExpressionSyntax expression {
            CollectScalarValueFlow(
                target,
                expression,
                model,
                tainted,
                edges,
                scalarTupleEdges,
                $scope,
                readConversion: false
            )
        }
    }

    private func IsCallableValueExpression(expression ExpressionSyntax?, model SemanticModel) bool {
        var expression = expression
        while expression is ParenthesizedExpressionSyntax parenthesized {
            expression = parenthesized.Expression
        }
        return expression is AnonymousFunctionExpressionSyntax || !model.GetMemberGroup(expression!!).IsDefaultOrEmpty
    }

    private func ResolveSources(
        expression ExpressionSyntax?,
        model SemanticModel,
        $scope SourceScope = SourceScope.AllSources,
        respectNullGuards bool = false,
        readConversion bool = true,
        resultType ITypeSymbol? = nil
    ) sequence[ISymbol?] {
        if GetContextualOperator(expression, model, resultType) is IMethodSymbol contextualOperator {
            if CanForwardConversionOperandNullability(
                resultType,
                model.GetTypeInfo(expression!!).Type,
                contextualOperator
            ) {
                for source in ResolveSources(expression, model, $scope, respectNullGuards, readConversion: false) {
                    yield source
                }
            }
            if !IsNonNullableValueType(resultType) {
                yield Canonical(contextualOperator)
            }
            yield break
        }
        if readConversion && GetResultConversion(expression, model) is IConversionOperation conversion {
            for source in ResolveSources(conversion, model, $scope, respectNullGuards) {
                yield source
            }
            yield break
        }
        if respectNullGuards && IsNullGuardDominatedRead(expression, model) {
            yield break
        }
        switch expression {
            case nil {
                yield break
            }
            case paren is ParenthesizedExpressionSyntax {
                for source in ResolveSources(paren.Expression, model, $scope, respectNullGuards) {
                    yield source
                }
            }
            case checkedExpression is CheckedExpressionSyntax {
                for source in ResolveSources(checkedExpression.Expression, model, $scope, respectNullGuards) {
                    yield source
                }
            }
            case awaitExpression is AwaitExpressionSyntax {
                for source in ResolveSources(awaitExpression.Expression, model, $scope, respectNullGuards) {
                    yield source
                }
            }
            case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                yield break
            }
            case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                for source in ResolveSources(coalesce.Right, model, $scope, respectNullGuards) {
                    yield source
                }
            }
            case ternary is ConditionalExpressionSyntax {
                for source in ResolveSources(ternary.WhenTrue, model, $scope, respectNullGuards).Concat(
                    ResolveSources(ternary.WhenFalse, model, $scope, respectNullGuards)
                ) {
                    yield source
                }
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    for source in ResolveSources(arm.Expression, model, $scope, respectNullGuards) {
                        yield source
                    }
                }
            }
            case invocation is InvocationExpressionSyntax {
                if model.GetSymbolInfo(invocation).Symbol is IMethodSymbol called && !called.ReturnsVoid {
                    yield Canonical(called)
                }
            }
            case IdentifierNameSyntax, MemberAccessExpressionSyntax {
                if $scope == SourceScope.CallsOnly {
                    yield break
                }
                let symbol ISymbol? = model.GetSymbolInfo(expression!!).Symbol
                if symbol == nil {
                    break
                }
                // A NON-CONTRACT getter follows field/local/param forwarding but
                // never PROPERTY forwarding (that would regress the #1354 /
                // #2167 property-contract guardrail).
                if $scope == SourceScope.CallsAndNonPropertyDeclarations && symbol is IPropertySymbol {
                    yield break
                }
                if IsValueDeclarationSymbol(symbol) || symbol is IMethodSymbol {
                    yield Canonical(symbol)
                }
            }
        }
    }

    private func ResolveSources(
        value IOperation?,
        model SemanticModel,
        $scope SourceScope,
        respectNullGuards bool
    ) sequence[ISymbol?] {
        if value is IConversionOperation conversion {
            if CanForwardCastOperandNullability(conversion) {
                for source in ResolveSources(conversion.Operand, model, $scope, respectNullGuards) {
                    yield source
                }
            }
            if conversion.OperatorMethod != nil && !IsNonNullableValueType(conversion.Type) {
                yield Canonical(conversion.OperatorMethod)
            }
        } else if value?.Syntax is ExpressionSyntax expression {
            for source in ResolveSources(expression, model, $scope, respectNullGuards, readConversion: false) {
                yield source
            }
        }
    }

    // Taints the declaration symbol an lvalue-ish expression binds to (the
    // receiver of a null-check / null-assignment / `?.`).
    private func TaintTarget(expression ExpressionSyntax, model SemanticModel, tainted HashSet[ISymbol]) {
        let symbol ISymbol? = ResolveAssignable(expression, model)
        if symbol != nil {
            tainted.Add(symbol)
        }
    }

    // Resolves the field/property/parameter/local a reference expression binds
    // to (canonicalized), or null when the expression is not a simple binding to
    // one of those (e.g. an element access, a method group, a `this`).
    // Issue #3501: true when <paramref name="value"/> is a bare local/parameter
    // read that an enclosing syntactic null-check guard proves non-null at this
    // exact use — either a surrounding `if (x != null) { …use… }` /
    // `if (x == null) {…} else { …use… }` branch (and the ternary forms), or a
    // PRECEDING early-exit guard in an enclosing block
    // (`if (x is null) { continue/return/break/throw; } …use…`). Mirrors the
    // translator-side `IsDominatedByNullCheckGuard` walk, extended with the
    // early-exit form, so a guarded read doesn't propagate its declaration's
    // taint through argument edges (gsc's own smart-cast narrows the same
    // guarded read on the G# side).
    private func IsNullGuardDominatedRead(value ExpressionSyntax?, model SemanticModel) bool {
        var stripped ExpressionSyntax? = value
        while stripped is ParenthesizedExpressionSyntax paren {
            stripped = paren.Expression
        }
        if stripped is not IdentifierNameSyntax identifier {
            return false
        }
        let symbol ISymbol? = model.GetSymbolInfo(identifier).Symbol
        if !(symbol is ILocalSymbol) && !(symbol is IParameterSymbol) {
            return false
        }
        for var node SyntaxNode? = identifier; node != nil; node = node!!.Parent {
            switch node.Parent {
                case elseClause is ElseClauseSyntax when elseClause.Parent is IfStatementSyntax elseIf &&
                    node == elseClause.Statement &&
                    IsNullTestOf(elseIf.Condition, symbol, whenTrueIsNull: true) &&
                    GuardValueRemainsUnchanged(elseIf.Condition, node, identifier, symbol, model) {
                    return true
                }
                case ifStatement is IfStatementSyntax when node == ifStatement.Statement &&
                    IsNullTestOf(ifStatement.Condition, symbol, whenTrueIsNull: false) &&
                    GuardValueRemainsUnchanged(ifStatement.Condition, node, identifier, symbol, model) {
                    return true
                }
                case ternary is ConditionalExpressionSyntax when(
                    (node == ternary.WhenFalse && IsNullTestOf(ternary.Condition, symbol, whenTrueIsNull: true)) ||
                        (node == ternary.WhenTrue && IsNullTestOf(ternary.Condition, symbol, whenTrueIsNull: false))
                ) &&
                    GuardValueRemainsUnchanged(ternary.Condition, node, identifier, symbol, model) {
                    return true
                }
                case whileStatement is WhileStatementSyntax when node == whileStatement.Statement &&
                    IsNullTestOf(whileStatement.Condition, symbol, whenTrueIsNull: false) &&
                    GuardValueRemainsUnchanged(whileStatement.Condition, node, identifier, symbol, model) {
                    return true
                }
                case forStatement is ForStatementSyntax when node == forStatement.Statement &&
                    forStatement.Condition is {} forCondition &&
                    IsNullTestOf(forCondition, symbol, whenTrueIsNull: false) &&
                    GuardValueRemainsUnchanged(forCondition, node, identifier, symbol, model) {
                    return true
                }
            }
            // A preceding sibling `if (x == null) <always-exits>` in an
            // enclosing block proves non-null for everything after it.
            if node is StatementSyntax statement && node.Parent is BlockSyntax block {
                let index = block.Statements.IndexOf(statement)
                for var i = 0; i < index; i++ {
                    if block.Statements[i] is IfStatementSyntax guard_ &&
                        guard_.Else == nil &&
                        IsNullTestOf(guard_.Condition, symbol, whenTrueIsNull: true) &&
                        AlwaysExits(guard_.Statement) &&
                        GuardValueRemainsUnchanged(guard_, block, identifier, symbol, model) {
                        return true
                    }
                }
            }
            if node is AccessorDeclarationSyntax ||
                node is BaseMethodDeclarationSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax ||
                node is ArrowExpressionClauseSyntax {
                break
            }
        }
        return false
    }

    private func IsNullGuardDominatedExpression(value ExpressionSyntax, model SemanticModel) bool {
        var stripped = value
        while stripped is ParenthesizedExpressionSyntax parentheses {
            stripped = parentheses.Expression
        }
        if stripped is not MemberAccessExpressionSyntax member || model.GetSymbolInfo(member)
            .Symbol is not IPropertySymbol{SetMethod: nil} property ||
            !IsSourceGetOnlyAutoProperty(property) {
            return false
        }
        for var node SyntaxNode? = value; node != nil; node = node!!.Parent {
            if node.Parent is ConditionalExpressionSyntax conditional &&
                node == conditional.WhenTrue &&
                IsNullTestOfExpression(conditional.Condition, member) &&
                MemberReceiverRemainsUnchanged(member, conditional.Condition, conditional.WhenTrue, model) {
                return true
            }
        }
        return false
    }

    private func IsSourceGetOnlyAutoProperty(property IPropertySymbol) bool {
        let declarations = property.DeclaringSyntaxReferences
        if declarations.IsDefaultOrEmpty ||
            property.IsAbstract ||
            property.IsVirtual ||
            property.IsOverride ||
            property
            .ContainingType
            .TypeKind == TypeKind.Interface {
            return false
        }
        for reference in declarations {
            if reference.GetSyntax() is not PropertyDeclarationSyntax declaration ||
                declaration.AccessorList is not{} accessorList ||
                accessorList
                .Accessors
                .Count != 1 {
                return false
            }
            let getter = accessorList.Accessors[0]
            if !getter.IsKind(SyntaxKind.GetAccessorDeclaration) ||
                getter.Body != nil ||
                getter.ExpressionBody != nil ||
                !getter
                .SemicolonToken
                .IsKind(SyntaxKind.SemicolonToken) {
                return false
            }
        }
        return true
    }

    private func MemberReceiverRemainsUnchanged(
        value MemberAccessExpressionSyntax,
        $guard ExpressionSyntax,
        region ExpressionSyntax,
        model SemanticModel
    ) bool {
        var receiver = value.Expression
        while receiver is ParenthesizedExpressionSyntax parentheses {
            receiver = parentheses.Expression
        }
        return receiver is IdentifierNameSyntax identifier && model.GetSymbolInfo(identifier)
            .Symbol is ISymbol symbol &&
            (symbol is ILocalSymbol || symbol is IParameterSymbol) &&
            GuardValueRemainsUnchanged($guard, region, identifier, symbol, model)
    }

    private func IsNullTestOfExpression(condition ExpressionSyntax, value ExpressionSyntax) bool {
        var condition = condition
        var value = value
        while condition is ParenthesizedExpressionSyntax conditionParentheses {
            condition = conditionParentheses.Expression
        }
        while value is ParenthesizedExpressionSyntax valueParentheses {
            value = valueParentheses.Expression
        }
        if condition is BinaryExpressionSyntax conjunction && conjunction.IsKind(SyntaxKind.LogicalAndExpression) {
            return IsNullTestOfExpression(conjunction.Left, value) || IsNullTestOfExpression(conjunction.Right, value)
        }
        return condition is BinaryExpressionSyntax comparison && comparison.IsKind(SyntaxKind.NotEqualsExpression) &&
            (
            (
                SyntaxFactory.AreEquivalent(comparison.Left, value) && comparison.Right.IsKind(
                    SyntaxKind.NullLiteralExpression
                )
            ) ||
                (
                SyntaxFactory.AreEquivalent(comparison.Right, value) && comparison.Left.IsKind(
                    SyntaxKind.NullLiteralExpression
                )
            )
        )
    }

    private func GuardValueRemainsUnchanged(
        $guard SyntaxNode,
        region SyntaxNode,
        use IdentifierNameSyntax,
        symbol ISymbol?,
        model SemanticModel
    ) bool {
        let Descend = func (node SyntaxNode) bool {
            return !((node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax))
        }
        let Writes = func (node SyntaxNode) bool {
            return CSharpToGSharpTranslator.SyntaxNodeWritesSymbol(node, symbol, model)
        }
        let declaration SyntaxNode? = symbol!!.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
        let scope_ SyntaxNode? = declaration?.Ancestors().FirstOrDefault(
            (node SyntaxNode) -> node is AccessorDeclarationSyntax ||
                node is BaseMethodDeclarationSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax ||
                node is CompilationUnitSyntax
        )
        if scope_ == nil {
            return false
        }
        // ponytail: lexical freshness cannot prove unstructured control flow.
        // Retain nullable storage until a CFG-based proof can cover jumps.
        let useScope SyntaxNode? = use.Ancestors().FirstOrDefault(
            (node SyntaxNode) -> node is AccessorDeclarationSyntax ||
                node is BaseMethodDeclarationSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax ||
                node is CompilationUnitSyntax
        )
        if useScope == nil ||
            useScope
            .DescendantNodes((node SyntaxNode) -> object.ReferenceEquals(node, useScope) || Descend(node))
            .OfType[GotoStatementSyntax]()
            .Any() {
            return false
        }
        if !object.ReferenceEquals(scope_, useScope) && scope_.DescendantNodes().Any(
            (node SyntaxNode) -> !useScope.Span.Contains(node.Span) && Writes(node)
        ) {
            return false
        }
        // Writable captures and escaped references are not stable smart-cast
        // values. Without an interprocedural proof, never trust their storage.
        if scope_.DescendantNodes().Any(
            (node SyntaxNode) -> (
                (node is RefExpressionSyntax || node is ArgumentSyntax || node is InvocationExpressionSyntax) &&
                    Writes(node)
            ) ||
                (
                (node is LocalFunctionStatementSyntax || node is AnonymousFunctionExpressionSyntax) &&
                    node
                    .DescendantNodes().Any(Writes)
            )
        ) {
            return false
        }
        if $guard.DescendantNodesAndSelf(Descend).Any(Writes) || region.DescendantNodesAndSelf(Descend).Any(
            (node SyntaxNode) -> node.SpanStart >= $guard.Span.End && node.SpanStart < use.SpanStart && Writes(node)
        ) {
            return false
        }
        for var node SyntaxNode? = use.Parent; node != nil; node = node!!.Parent {
            if (
                node is WhileStatementSyntax ||
                    node is DoStatementSyntax ||
                    node is ForStatementSyntax ||
                    node is ForEachStatementSyntax ||
                    node is ForEachVariableStatementSyntax
            ) &&
                !node
                .Span
                .Contains($guard.Span) && node.DescendantNodes(Descend).Any(Writes) {
                return false
            }
            if node is AccessorDeclarationSyntax ||
                node is BaseMethodDeclarationSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax {
                break
            }
        }
        return true
    }

    private func AlwaysExits(statement StatementSyntax) bool -> switch statement {
        case _ is ReturnStatementSyntax or
            _ is ContinueStatementSyntax or
            _ is BreakStatementSyntax or
            _ is ThrowStatementSyntax: true
        case block is BlockSyntax: block.Statements.Count > 0 && AlwaysExits(block.Statements[^1])
        default: false
    }

    // Matches `x == null` / `x is null` (whenTrueIsNull: true) and
    // `x != null` / `x is not null` (whenTrueIsNull: false) against
    // <paramref name="symbol"/> by identifier name.
    private func IsNullTestOf(condition ExpressionSyntax, symbol ISymbol?, whenTrueIsNull bool) bool {
        var condition = condition
        while condition is ParenthesizedExpressionSyntax paren {
            condition = paren.Expression
        }
        let IsSymbolIdentifier = func (expression ExpressionSyntax, symbol ISymbol?) bool {
            var expression = expression
            while expression is ParenthesizedExpressionSyntax inner {
                expression = inner.Expression
            }
            return expression is IdentifierNameSyntax id && string.Equals(
                id.Identifier.ValueText,
                symbol!!.Name,
                StringComparison.Ordinal
            )
        }
        let IsNullLiteral = func (expression ExpressionSyntax) bool {
            return expression is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.NullLiteralExpression)
        }
        switch condition {
            case conjunction is BinaryExpressionSyntax when !whenTrueIsNull && conjunction.IsKind(
                SyntaxKind.LogicalAndExpression
            ) {
                return IsNullTestOf(conjunction.Left, symbol, whenTrueIsNull) ||
                    IsNullTestOf(conjunction.Right, symbol, whenTrueIsNull)
            }
            case binary is BinaryExpressionSyntax when binary.IsKind(
                if whenTrueIsNull {
                    SyntaxKind.EqualsExpression
                } else {
                    SyntaxKind.NotEqualsExpression
                }
            ) {
                return (IsSymbolIdentifier(binary.Left, symbol) && IsNullLiteral(binary.Right)) ||
                    (IsSymbolIdentifier(binary.Right, symbol) && IsNullLiteral(binary.Left))
            }
            case isPattern is IsPatternExpressionSyntax when IsSymbolIdentifier(isPattern.Expression, symbol) {
                if whenTrueIsNull {
                    return isPattern.Pattern is ConstantPatternSyntax{
                        Expression: LiteralExpressionSyntax nullPattern
                    } &&
                        nullPattern.IsKind(SyntaxKind.NullLiteralExpression)
                }
                return isPattern.Pattern is UnaryPatternSyntax{
                    Pattern: ConstantPatternSyntax{Expression: LiteralExpressionSyntax notNullPattern}
                } &&
                    notNullPattern.IsKind(SyntaxKind.NullLiteralExpression)
            }
            default {
                return false
            }
        }
    }

    private func ResolveAssignable(expression ExpressionSyntax, model SemanticModel) ISymbol? {
        switch expression {
            case paren is ParenthesizedExpressionSyntax {
                return ResolveAssignable(paren.Expression, model)
            }
            case IdentifierNameSyntax, MemberAccessExpressionSyntax {
                let symbol ISymbol? = model.GetSymbolInfo(expression).Symbol
                return if symbol != nil && IsValueDeclarationSymbol(symbol) {
                    Canonical(symbol)
                } else {
                    default(ISymbol?)
                }
            }
            default {
                return nil
            }
        }
    }

    // Whether an expression is directly (syntactically or by its declared
    // result contract) nullable, independent of any other declaration's taint.
    // Mirrors the translator's IsNullableInitializer, plus the `null`/`default`
    // literal forms used in initializer/return positions.
    private func IsDirectlyNullable(
        expression ExpressionSyntax?,
        model SemanticModel,
        respectNullGuards bool = false,
        readConversion bool = true,
        resultType ITypeSymbol? = nil
    ) bool {
        if GetContextualOperator(expression, model, resultType) is IMethodSymbol contextualOperator {
            return (
                CanForwardConversionOperandNullability(
                    resultType,
                    model.GetTypeInfo(expression!!).Type,
                    contextualOperator
                ) &&
                    IsDirectlyNullable(expression, model, respectNullGuards, readConversion: false)
            ) ||
                (!IsNonNullableValueType(resultType) && IsDeclaredNullablePosition(contextualOperator.ReturnType))
        }
        if readConversion && GetResultConversion(expression, model) is IConversionOperation conversion {
            return IsDirectlyNullable(conversion, model, respectNullGuards)
        }
        if respectNullGuards && IsNullGuardDominatedRead(expression, model) {
            return false
        }
        switch expression {
            case nil {
                return false
            }
            case paren is ParenthesizedExpressionSyntax {
                return IsDirectlyNullable(paren.Expression, model, respectNullGuards)
            }
            case checkedExpression is CheckedExpressionSyntax {
                return IsDirectlyNullable(checkedExpression.Expression, model, respectNullGuards)
            }
            case awaitExpression is AwaitExpressionSyntax {
                return IsDirectlyNullable(awaitExpression.Expression, model, respectNullGuards)
            }
            case suppress is PostfixUnaryExpressionSyntax when suppress.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                return false
            }
            case literal is LiteralExpressionSyntax {
                return literal.IsKind(SyntaxKind.NullLiteralExpression) ||
                    (
                    literal.IsKind(SyntaxKind.DefaultLiteralExpression) &&
                        (
                        IsReferenceLike(model.GetTypeInfo(literal).ConvertedType) ||
                            IsNullableValueType(model.GetTypeInfo(literal).ConvertedType)
                    )
                )
            }
            case defaultExpression is DefaultExpressionSyntax {
                return IsReferenceLike(model.GetTypeInfo(defaultExpression).Type) ||
                    IsNullableValueType(model.GetTypeInfo(defaultExpression).Type)
            }
            case ConditionalAccessExpressionSyntax {
                return true
            }
            case asExpression is BinaryExpressionSyntax when asExpression.IsKind(SyntaxKind.AsExpression) {
                return true
            }
            case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                return IsDirectlyNullable(coalesce.Right, model, respectNullGuards)
            }
            case ternary is ConditionalExpressionSyntax {
                return IsDirectlyNullable(ternary.WhenTrue, model, respectNullGuards) ||
                    IsDirectlyNullable(ternary.WhenFalse, model, respectNullGuards)
            }
            case switchExpression is SwitchExpressionSyntax {
                for arm in switchExpression.Arms {
                    if IsDirectlyNullable(arm.Expression, model, respectNullGuards) {
                        return true
                    }
                }
                return false
            }
        }
        // Flow nullability when the context happens to be enabled (inert in a
        // truly oblivious compilation, but harmless).
        let info = model.GetTypeInfo(expression!!)
        if info.Nullability.Annotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated {
            return true
        }
        // Issue #3802: `[return: NotNullIfNotNull(nameof(p))]` makes that
        // declared `string?` CONDITIONAL — `Path.GetExtension(source)` is
        // exactly as nullable as `source` is, so answer for the ARGUMENT
        // instead of reading the declared `string?` below. Promoting it
        // unconditionally is what widened RepositoryMirror's iterator to
        // `sequence[string?]` and left a `string?` dictionary key gsc rightly
        // rejected. When the argument is not DIRECTLY nullable the answer here
        // is "no", and `CollectScalarValueFlow` records a forwarding edge so
        // the fixpoint can still promote both together.
        if ConditionalNotNullPostcondition.TryGetForwardedArgument(
            expression!!,
            func (node ExpressionSyntax) ISymbol? {
                return model.GetSymbolInfo(node).Symbol
            },
            out var conditionalSource
        ) {
            return IsDirectlyNullable(conditionalSource, model, respectNullGuards)
        }
        // Otherwise consult the bound symbol's DECLARED annotation, which
        // survives in BCL/source metadata regardless of the consuming context
        // (e.g. `AssemblyName.Name` and `Path.GetFileNameWithoutExtension(...)`
        // are declared `string?`).
        let symbol ISymbol? = model.GetSymbolInfo(expression!!).Symbol
        let symbolType ITypeSymbol? = switch symbol {
            case m is IMethodSymbol: m.ReturnType
            case p is IPropertySymbol: p.Type
            case f is IFieldSymbol: f.Type
            case l is ILocalSymbol: l.Type
            case pr is IParameterSymbol: pr.Type
            default: default(ITypeSymbol?)
        }
        return IsImportedStatedNullablePosition(symbol, model.Compilation) ||
            IsDeclaredNullablePosition(symbolType ?? info.Type)
    }

    private func IsDeclaredNullablePosition(type ITypeSymbol?) bool -> IsNullableValueType(type) ||
        (
        type != nil &&
            type.IsReferenceType == true &&
            type.NullableAnnotation == Microsoft
            .CodeAnalysis
            .NullableAnnotation
            .Annotated
    )

    private func IsReferenceLike(type ITypeSymbol?) bool -> (type != nil && type.IsReferenceType) ||
        type is ITypeParameterSymbol

    private func IsNullableValueType(type ITypeSymbol?) bool -> type
        ?.OriginalDefinition
        .SpecialType == SpecialType.System_Nullable_T

    private func IsNonNullableValueType(type ITypeSymbol?) bool -> type != nil &&
        type.IsValueType == true &&
        !IsNullableValueType(type)

    private func CanForwardCastOperandNullability(
        conversion IConversionOperation
    ) bool -> CanForwardConversionOperandNullability(
        conversion.Type,
        conversion.Operand.Type,
        conversion.OperatorMethod
    )

    private func CanForwardConversionOperandNullability(
        resultType ITypeSymbol?,
        operandType ITypeSymbol?,
        operatorMethod IMethodSymbol?
    ) bool -> !IsNonNullableValueType(resultType) &&
        !IsNonNullableValueType(operandType) &&
        (
        operatorMethod == nil ||
            (
            IsNullableValueType(operandType) &&
                operatorMethod
                .Parameters
                .Length == 1 &&
                IsNonNullableValueType(operatorMethod.Parameters[0].Type)
        )
    )

    // The declaration kinds whose emitted reference type this analysis governs.
    private func IsValueDeclarationSymbol(symbol ISymbol?) bool -> symbol is IFieldSymbol ||
        symbol is IPropertySymbol ||
        symbol is IParameterSymbol ||
        symbol is ILocalSymbol

    private func Canonical(symbol ISymbol?) ISymbol? {
        // Constructed type-argument sinks must not merge unrelated instantiations.
        if symbol is INamedTypeSymbol {
            return symbol
        }
        // A reduced extension-method invocation (`value.Ext(...)`) binds to the
        // REDUCED method symbol, whereas the extension's own declaration node
        // binds to the UNREDUCED static method; normalize to the unreduced
        // original so a return-taint keyed on the declaration matches a call-site
        // edge that reads it (issue #2113 — otherwise chained extension methods
        // like `values.FirstEtAlImpl(...)` never propagate their nullable return).
        if symbol is IMethodSymbol method {
            return (method.ReducedFrom ?? method).OriginalDefinition
        }
        return symbol?.OriginalDefinition ?? symbol
    }

    // `x is null` / `x is not null` constant pattern.
    private func IsNullConstantPattern(pattern PatternSyntax) bool {
        var pattern = pattern
        if pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern) {
            pattern = unary.Pattern
        }
        return pattern is ConstantPatternSyntax constant && IsNullLiteral(constant.Expression)
    }

    private func IsNullLiteral(expression ExpressionSyntax) bool -> expression is LiteralExpressionSyntax literal &&
        literal.IsKind(SyntaxKind.NullLiteralExpression)

    // `null` or `null!` (a SuppressNullableWarning over a null literal).
    private func IsNullOrSuppressedNull(expression ExpressionSyntax) bool {
        var expression = expression
        if expression is PostfixUnaryExpressionSyntax suppress && suppress.IsKind(
            SyntaxKind.SuppressNullableWarningExpression
        ) {
            expression = suppress.Operand
        }
        return IsNullLiteral(expression)
    }

    private func ProjectTupleContractPosition(
        symbol ISymbol?,
        path string,
        template ITypeSymbol? = nil,
        receiver INamedTypeSymbol? = nil
    )(Owner ISymbol?, Path string) {
        var template = template
        template ??= SymbolValueType(Canonical(symbol))
        let indexes = path.Split('.')
        for var offset = 0; offset <= indexes.Length; offset++ {
            if template is ITypeParameterSymbol parameter && parameter.TypeParameterKind == TypeParameterKind.Type {
                var owner INamedTypeSymbol? = receiver ?? symbol!!.ContainingType
                while owner != nil && !SymbolEqualityComparer.Default.Equals(
                    owner.OriginalDefinition,
                    parameter.ContainingType
                ) {
                    owner = owner.ContainingType
                }
                if owner != nil {
                    let suffix = string.Join(".", indexes.Skip(offset))
                    let prefix = parameter.Ordinal.ToString(CultureInfo.InvariantCulture)
                    return (
                        owner,
                        if suffix.Length == 0 {
                            prefix
                        } else {
                            prefix + "." + suffix
                        }
                    )
                }
            }
            if offset == indexes.Length || template is not INamedTypeSymbol named || !int32.TryParse(
                indexes[offset],
                out var index
            ) {
                break
            }
            if named.IsTupleType && index < named.TupleElements.Length {
                template = named.TupleElements[index].Type
            } else if !named.IsTupleType && index < named.TypeArguments.Length {
                template = named.TypeArguments[index]
            } else {
                break
            }
        }
        return (symbol, path)
    }

    private func NormalizeContractTupleNames(type ITypeSymbol) ITypeSymbol {
        var named INamedTypeSymbol? = type as INamedTypeSymbol
        if named == nil {
            return type
        }
        // Tuple labels are rendered at each use, not part of contract identity.
        named = named.TupleUnderlyingType ?? named
        let arguments = named.TypeArguments.Select(NormalizeContractTupleNames).ToArray()
        return if arguments.SequenceEqual(named.TypeArguments, SymbolEqualityComparer.IncludeNullability) {
            cast[ITypeSymbol](named)
        } else {
            named
                .ConstructedFrom
                .Construct(arguments.ToImmutableArray(), named.TypeArgumentNullableAnnotations)
                .WithNullableAnnotation(named.NullableAnnotation)
        }
    }
}
