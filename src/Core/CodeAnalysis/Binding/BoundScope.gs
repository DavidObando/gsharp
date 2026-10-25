// <copyright file="BoundScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Threading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import System.Globalization
import GSharp.Core.CodeAnalysis.Compilation

/// Bound scope.
class BoundScope {
    private var symbols ImmutableDictionary[string, Symbol].Builder?
    private var symbolKeys ImmutableArray[string].Builder?
    private var functions ImmutableDictionary[string, ImmutableArray[FunctionSymbol].Builder].Builder?
    private var functionKeys ImmutableArray[string].Builder?
    private var imports ImmutableArray[ImportSymbol].Builder?
    private var cachedImportIndex VisibleImportIndex?
    private var typeAliases ImmutableDictionary[string, TypeSymbol]?
    private var aliasCandidates ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]] =
    ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]].Empty
    private var aliasCandidatesByArity ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]] =
    ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]].Empty
    private var nestedAliasCandidates ImmutableDictionary[
        (Owner TypeSymbol, Name string),
        ImmutableDictionary[string, TypeSymbol]
    ] =
    ImmutableDictionary[(Owner TypeSymbol, Name string), ImmutableDictionary[string, TypeSymbol]].Empty
    private var sourcePackagePrefixes ImmutableDictionary[string, bool].Builder?

    // ADR-0156 Phase 2: registered on the root scope of an interactive
    // submission's scope chain; exposed via SubmissionImports.
    private var submissionImports SubmissionImports?

    private var typeAliasKeys ImmutableArray[string].Builder?
    private var extensionFunctions ImmutableArray[FunctionSymbol].Builder?

    // Issue #2342 follow-up: per-storage-key override recording the
    // DECLARING package of a plain `type Name = Target` alias (see
    // DeclarationBinder.BindTypeAliasDeclaration and
    // TryDeclareTypeAlias(string, TypeSymbol, string)), keyed by the exact
    // same key used in `typeAliases`. Populated only for plain alias
    // declarations that pass an explicit declaringPackageName; struct/enum/
    // interface/delegate declarations leave their key unregistered here since
    // their stored value already carries accurate package identity
    // intrinsically (see TypePackageName).
    private var aliasDeclaringPackages ImmutableDictionary[string, string].Builder?

    // Issue #2224: lazily created only on the root scope of whatever chain
    // this scope belongs to. Every Binder in a single BindGlobalScope/
    // BindProgram pass shares the same root-scope chain (it's threaded in as
    // "parent"/"parentScope"), so anonymous-class literals bound anywhere in
    // that pass — top-level statements, function bodies, method bodies,
    // lambdas — unify against one shape cache, mirroring Roslyn's
    // per-compilation anonymous-type cache.
    private var anonymousTypeCache AnonymousTypeCache?
    private var bindingServices BindingServices?

    // Issue #3501 A2: synthesized ref-kind delegate cache, held at the root
    // of the chain, exactly like anonymousTypeCache above.
    private var synthesizedRefDelegateCache SynthesizedRefDelegateCache?

    // Issue #2342: the ambient "current declaring package" (see
    // SetCurrentDeclaringPackage), lazily set/cleared only on the root scope
    // of the chain, exactly like anonymousTypeCache above.
    private var currentDeclaringPackageName AsyncLocal[string?] = AsyncLocal[string?]()

    // Issue #2456 (per-file import scoping / #2395 follow-up): the ambient
    // "current referencing syntax tree" (see SetCurrentReferencingSyntaxTree),
    // set for the duration of binding a single declaration's type clauses or a
    // single member body, mirroring currentDeclaringPackageName exactly.
    // Import enumeration consults this to expose only imports declared in the
    // same file as the reference being resolved, plus implicit imports.
    private var currentReferencingSyntaxTree AsyncLocal[SyntaxTree?] = AsyncLocal[SyntaxTree?]()

    // Explicit package preference for alias lookup, shared across the scope chain.
    // Qualified constructions resolve their complete identities without this hint.
    private var qualifiedConstructionPackageHint AsyncLocal[string?] = AsyncLocal[string?]()

    private var richAnonymousClassMap Dictionary[AnonymousClassExpressionSyntax, StructSymbol]?
    private var richAnonymousObjectPlans Dictionary[RichAnonymousObjectBindingKey, RichAnonymousObjectPlan]?
    private var latestRichAnonymousObjectPlans Dictionary[StructSymbol, RichAnonymousObjectPlan]?
    private var structuralAdapterRegistry StructuralAdapterRegistry?
    private var independentBodyRoot bool
    // Derived alias views are published as one immutable snapshot each (see
    // AliasDerivedSnapshot), so readers on different threads never pair a value
    // with inputs it was not built from.
    private var orderedTypeAliasSnapshot AliasDerivedSnapshot[ImmutableArray[KeyValuePair[string, TypeSymbol]]]?
    private var structSnapshot AliasDerivedSnapshot[ImmutableArray[StructSymbol]]?

    /// Creates a worker boundary over canonical declarations. Synthesis remains coordinator-owned.
    internal func CreateIndependentBodyScope() BoundScope -> BoundScope(this){independentBodyRoot = true}

    private prop SynthesisParent BoundScope? {
        get {
            if independentBodyRoot {
                throw System.InvalidOperationException(
                    "An independent body worker cannot access coordinator synthesis state."
                )
            }
            return Parent
        }
    }

    // Issues #4089/#4090: the declaration-phase queue of G#-declared generic
    // TYPE-CLAUSE constraint checks, and the latch that says a check must be
    // queued rather than answered where it is written. Both live on the ROOT
    // scope of the chain (like richAnonymousClassMap above) because every
    // binder in ONE binding pass shares that root, while each binder has its
    // own BinderContext and its own DiagnosticBag. `BindProgram` derives a
    // fresh chain for member bodies, which is exactly why the latch defaults to
    // "answer in place" — see IsDeferringUserGenericConstraintChecks.
    private var pendingUserGenericConstraintChecks List[Binder.PendingUserGenericConstraintCheck]?

    private var deferUserGenericConstraintChecks bool

    // Issue #1680: name-keyed index over extensionFunctions. Extension lookup is a
    // per-call-site hot path run for every member call that doesn't resolve as an
    // instance member, so a flat per-scope list forced an O(callsites x extensions)
    // scan (plus an O(E^2) inner pass in ReceiverConvertibilitySpecificity). Every
    // extension is bucketed by name here as it's declared; lookups probe the bucket
    // for the call-site name instead of the full list, then run the exact same
    // receiver-matching (identity/CLR, generic-unification, subtype-convertibility)
    // logic as before over the narrowed candidate set. This changes only how
    // candidates are FOUND, never which one wins: same receiver-matching rules, same
    // scope/shadowing order, so resolution and diagnostics are unchanged.
    private var extensionFunctionsByName ImmutableDictionary[string, ImmutableArray[FunctionSymbol].Builder].Builder?

    /// Initializes a new instance of the (cref:BoundScope) class.
    /// @param parent The parent scope, or `null` for a root scope.
    convenience init(parent BoundScope?) {
        init(parent, nil, nil)
    }

    /// Initializes a new instance of the (cref:BoundScope) class with
    /// an explicit reference resolver. Child scopes inherit the parent's
    /// resolver when one is not supplied.
    /// @param parent The parent scope, or `null` for a root scope.
    /// @param references The reference resolver; defaults to the parent's resolver, or
    /// (cref:ReferenceResolver.Default) if none.
    convenience init(parent BoundScope?, references ReferenceResolver?) {
        init(parent, references, nil)
    }

    /// Initializes a new instance of the (cref:BoundScope) class with
    /// an explicit reference resolver and an active preprocessor-symbol set
    /// (ADR-0047 §6 / issue #176). Child scopes inherit both from the parent
    /// when not supplied.
    /// @param parent The parent scope, or `null` for a root scope (see (cref:Binder.CreateRootScope)).
    /// @param references The reference resolver; defaults to the parent's resolver, or
    /// (cref:ReferenceResolver.Default) if none.
    /// @param preprocessorSymbols The active preprocessor symbol set; defaults to the parent's set, or an
    /// empty set if none.
    init(parent BoundScope?, references ReferenceResolver?, preprocessorSymbols ImmutableHashSet[string]?) {
        // Issue #1647: symbolKeys/functionKeys/imports/typeAliases/typeAliasKeys
        // are kept PER-SCOPE only (declared-here entries), just like the
        // `symbols`/`functions` dictionaries already were. Resolution walks
        // the Parent chain lazily instead of eagerly duplicating the parent's
        // entire state into every child scope (every block/loop/switch arm
        // created a BoundScope, making the old eager copy O(scopes x entries)).
        Parent = parent
        References = references ?? parent?.References ?? ReferenceResolver.Default()
        PreprocessorSymbols = preprocessorSymbols ?? parent?.PreprocessorSymbols ?? ImmutableHashSet[string].Empty
    }

    /// Gets the parent scope, or `null` for a root scope (see
    /// (cref:Binder.CreateRootScope), which passes `parent: null`).
    prop Parent BoundScope? {
        get;
    }

    /// Gets the reference resolver used to look up imported CLR types.
    prop References ReferenceResolver? {
        get;
    }

    /// Gets the active preprocessor symbol set (ADR-0047 §6 / issue #176).
    /// Empty by default. `[Conditional("SYMBOL")]` call-site elision
    /// keys off this set: a call is elided when *none* of the symbols named
    /// by the function's `[Conditional]` applications is in this set.
    prop PreprocessorSymbols ImmutableHashSet[string] {
        get;
    }

    /// Gets the interactive submission import set (ADR-0156 Phase 2) visible
    /// from this scope, walking the parent chain to the root scope it was
    /// registered on; `null` for ordinary compilations.
    prop SubmissionImports SubmissionImports? -> submissionImports ?? Parent?.SubmissionImports

    /// Returns the enclosing scope, for a pop that pairs with an earlier
    /// `scope = new BoundScope(scope)` push.
    /// @remarks Binders push and pop scopes in matched pairs, so a scope being popped
    /// always has a parent -- only the root from (cref:Binder.CreateRootScope)
    /// has none, and nothing pops the root. Stating that once here replaces the
    /// twenty identical `scope.Parent!` suppressions the binders carried,
    /// and upgrades the failure mode from a null that propagates into an NRE
    /// somewhere later into a GS9998 naming the cause at the pop itself.
    /// @returns The enclosing scope.
    func Pop() BoundScope -> Invariant.Required(
        Parent,
        "a scope being popped was pushed as a child of an enclosing scope; only the root scope has no parent, and the root is never popped",
        expression: "Parent"
    )

    /// Tries to add an import to this scope.
    /// @param import The import.
    /// @returns Whether the import was registered or not.
    func TryImport($import ImportSymbol) bool {
        imports ??= ImmutableArray.CreateBuilder[ImportSymbol]()
        imports!!.Add($import)
        return true
    }

    /// Tries to declare a variable in this scope.
    /// @param variable The variable to declare.
    /// @returns Wherther the variable was declared or not.
    func TryDeclareVariable(variable VariableSymbol) bool -> TryDeclareSymbol(variable)

    /// Tries to declare a function in this scope.
    /// @param function The function to declare.
    /// @returns Whether the function was declared or not.
    func TryDeclareFunction(function FunctionSymbol) bool {
        if function?.Name == nil {
            return false
        }
        // ADR-0063 §11: user-defined callable storage is name → overload set.
        // A name conflict with a non-function symbol (variable, etc.) is still a
        // hard duplicate. A second function with the same name is allowed if and
        // only if its signature differs from every existing overload.
        if symbols != nil && symbols!!.TryGetValue(function.Name, out var existing) && !(existing is FunctionSymbol) {
            return false
        }
        functions ??= ImmutableDictionary.CreateBuilder[string, ImmutableArray[FunctionSymbol].Builder]()
        functionKeys ??= ImmutableArray.CreateBuilder[string]()
        // Issue #2342 follow-up: a top-level function's overload set is scoped
        // to its DECLARING PACKAGE, mirroring TryDeclareTypeAlias. The plain
        // (unqualified) name key is a first-come-first-served slot: whichever
        // package's function is declared first under a given simple name
        // keeps it, so unrelated packages continue to resolve every OTHER
        // (non-colliding) function by simple name exactly as before (packages
        // are not real import boundaries — see the class-level scoping notes
        // on IsSameDeclarationScope). A second, same-simple-name function
        // declared by a DIFFERENT package is not a genuine duplicate overload;
        // it is retained under its own package-qualified bucket instead of
        // being merged into (and duplicate-checked against) a foreign
        // package's overload set. Two functions from the SAME package (or two
        // built-ins, both with a null Package) still share one bucket and
        // still enforce the existing signature-uniqueness rule.
        var key = function.Name
        let incomingPackage = function.Package?.Name
        if functions!!.TryGetValue(key, out var bucket) && bucket.Count > 0 && !string.Equals(
            bucket[0].Package?.Name,
            incomingPackage,
            StringComparison.Ordinal
        ) {
            key = PackageQualifiedName(incomingPackage, function.Name)
            functions!!.TryGetValue(key, out bucket)
        }
        if bucket == nil {
            bucket = ImmutableArray.CreateBuilder[FunctionSymbol]()
            functions!!.Add(key, bucket)
            functionKeys!!.Add(key)
        } else {
            for f in bucket {
                if FunctionSignaturesEqual(f, function) {
                    return false
                }
            }
        }
        bucket.Add(function)
        // Keep the first overload visible through the legacy `symbols` map so
        // existing TryLookupSymbol/Get*<FunctionSymbol> callers see the name.
        symbols ??= ImmutableDictionary.CreateBuilder[string, Symbol]()
        if !symbols!!.ContainsKey(function.Name) {
            AddSymbol(function.Name, function)
        }
        return true
    }

    /// ADR-0063 §11: returns every overload of the given function name visible
    /// from this scope (walks parent scopes). Empty when no function with that
    /// name is in scope.
    /// @param name The function name.
    /// @returns The overload set in declaration order (innermost scope first).
    func TryLookupFunctions(name string?) ImmutableArray[FunctionSymbol] {
        if name == nil {
            return ImmutableArray[FunctionSymbol].Empty
        }
        // Issue #2342 follow-up: when the body currently being bound belongs
        // to a known declaring package (see SetCurrentDeclaringPackage), and
        // that package declared its OWN function(s) under this simple name
        // (see TryDeclareFunction's package-qualified fallback bucket),
        // resolve to that package's own overload set rather than falling
        // through to whichever package's homonym happens to occupy the plain
        // name key. A package that does not declare its own function under
        // this name still sees every OTHER (non-colliding) function by simple
        // name via the plain-key fallback below, preserving the pre-existing
        // "one flat namespace" visibility for non-conflicting names.
        let currentPackage string? = GetCurrentDeclaringPackage()
        if currentPackage != nil {
            let ownKey = PackageQualifiedName(currentPackage, name)
            let ownBucket = CollectFunctionBucket(ownKey)
            if !ownBucket.IsDefaultOrEmpty {
                return ownBucket
            }
        }
        return CollectFunctionBucket(name)
    }

    /// Tries to declare an extension function (Phase 3.B.6 / ADR-0019). Extension
    /// functions live outside the normal symbol table because their identity is
    /// the triple (receiverType, name, signature).
    /// @remarks Issue #1188: extension functions support overloading exactly like ordinary
    /// methods and free functions. Two extensions that share a (receiver, name)
    /// pair but differ in parameter signature (by arity, parameter type, or
    /// generic arity) are legal overloads and both are registered. A collision is
    /// reported only when a candidate is overload-identical to an existing one
    /// (same name, same receiver type, same callable parameter signature). The
    /// receiver type participates in identity through the synthetic receiver slot
    /// at `Parameters[0]` (extension functions never set
    /// (cref:FunctionSymbol.ExplicitReceiverParameter), so
    /// (cref:FunctionSignaturesEqual) compares the receiver type too): two
    /// extensions with the same name and parameter list but different receiver
    /// types remain independent.
    /// @param function The extension function symbol. Must have (cref:FunctionSymbol.IsExtension) set.
    /// @returns True if the extension was registered; false if an overload-identical (receiver, name,
    /// signature) extension already exists in this scope.
    func TryDeclareExtensionFunction(function FunctionSymbol) bool {
        extensionFunctions ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
        extensionFunctionsByName ??= ImmutableDictionary.CreateBuilder[string, ImmutableArray[FunctionSymbol].Builder]()
        // Issue #2342 follow-up: mirror TryDeclareFunction's package-scoped
        // overload-bucket rule for extension functions. An extension's
        // identity triple (receiverType, name, signature) already keeps two
        // DIFFERENT user-defined receiver types from different packages from
        // ever colliding — they are distinct TypeSymbol instances even when
        // same-named (see #2342) — but two packages that both declare an
        // extension on a SHARED receiver type (a primitive, an imported/BCL
        // type, or any other type with no per-package identity of its own)
        // under the same simple name and signature previously collided as a
        // spurious GS0264 duplicate. The plain name key remains
        // first-come-first-served across packages — extensions, like free
        // functions, are broadly visible by design (packages are not import
        // boundaries) — so unrelated packages continue to resolve every
        // OTHER (non-colliding) extension by simple name exactly as before.
        // A same-name, same-signature extension declared by a DIFFERENT
        // package than the bucket's first entry is not a genuine duplicate;
        // it is retained under its own package-qualified bucket instead of
        // being merged into (and duplicate-checked against) a foreign
        // package's overload set. Two extensions from the SAME package (or
        // two with a null Package) still share one bucket and still enforce
        // the existing signature-uniqueness rule.
        var key = function.Name
        let incomingPackage = function.Package?.Name
        if extensionFunctionsByName!!.TryGetValue(key, out var bucket) && bucket.Count > 0 && !string.Equals(
            bucket[0].Package?.Name,
            incomingPackage,
            StringComparison.Ordinal
        ) {
            key = PackageQualifiedName(incomingPackage, function.Name)
            extensionFunctionsByName!!.TryGetValue(key, out bucket)
        }
        if bucket != nil {
            for existing in bucket {
                if FunctionSignaturesEqual(existing, function) &&
                    ExtensionTypeParameterConstraintsEqual(existing, function) {
                    return false
                }
            }
        } else {
            bucket = ImmutableArray.CreateBuilder[FunctionSymbol]()
            extensionFunctionsByName!!.Add(key, bucket)
        }
        extensionFunctions!!.Add(function)
        bucket.Add(function)
        return true
    }

    /// Tries to look up an extension function by receiver type and name (walks parent scopes).
    /// @remarks Two lookup paths are tried, in order:
    /// 1. <b>Exact-match fast path</b> — reference-equality on the declared receiver type. This is
    /// sufficient for non-generic receivers (`(self string)`, `(self int32)`) and for already-closed
    /// receiver spellings.
    /// 2. <b>Generic-receiver unification (issue #773)</b> — an extension whose receiver type references
    /// its own function-level type parameters (e.g. `func (self sequence[T]) FirstOrNil[T]() T?` or
    /// `func (self IEnumerable[T]) MyFirst[T any](fb T) T`) must dispatch when the call-site receiver type
    /// unifies with the open declared receiver. Inference is delegated to (cref:Binder.InferTypeArguments);
    /// the candidate qualifies when every type parameter mentioned in the receiver gets bound.
    /// 3. <b>Implicit-conversion (subtype) receivers (issue #1548)</b> — a declared receiver `R` is also
    /// applicable for a call-site receiver `S` when `S` is implicitly convertible to `R` (identity,
    /// implicit reference, or boxing conversion), matching C#/Kotlin extension-method semantics. Among
    /// several applicable convertible receivers the MOST specific (most-derived) one wins, so
    /// `(self string)` beats `(self object)` for a `string` receiver deterministically.
    /// @param receiverType The static type of the call receiver.
    /// @param name The method name at the call site.
    /// @param function The matching extension function, when found.
    /// @returns True when an extension function matches.
    func TryLookupExtensionFunction(
        receiverType TypeSymbol,
        name string,
        @NotNullWhen(true) out function FunctionSymbol?
    ) bool {
        function = nil
        // Issue #2342 follow-up: when the body currently being bound belongs
        // to a known declaring package (see SetCurrentDeclaringPackage), and
        // that package owns its OWN package-qualified bucket for `name` (see
        // TryDeclareExtensionFunction's package-qualified fallback bucket),
        // prefer a match from that bucket over a foreign package's same-name,
        // same-signature homonym that occupies the plain simple-name key. A
        // package that does not declare its own colliding extension under
        // this name still sees every extension by simple name via the plain
        // bucket fallback below, preserving the pre-existing "broadly
        // visible" behavior for non-conflicting extension names.
        let currentPackage string? = GetCurrentDeclaringPackage()
        if currentPackage != nil && extensionFunctionsByName != nil && extensionFunctionsByName!!.TryGetValue(
            PackageQualifiedName(currentPackage, name),
            out var ownBucket
        ) &&
            TryFindExtensionInBucket(ownBucket, receiverType, out function) {
            return true
        }
        // Issue #1680: probe the name-keyed bucket instead of scanning every
        // extension declared in this scope. A scope with no extensions named
        // `name` is skipped in O(1) instead of an O(extensions) miss.
        if extensionFunctionsByName != nil && extensionFunctionsByName!!.TryGetValue(name, out var bucket) &&
            TryFindExtensionInBucket(bucket, receiverType, out function) {
            return true
        }
        // Issue #2414: neither the caller's own package-qualified bucket nor
        // the plain (first-come) bucket matched. When a name collision
        // occurred (see TryDeclareExtensionFunction), every OTHER colliding
        // package's overloads live in THEIR OWN package-qualified buckets,
        // which the two checks above never probe unless the caller happens
        // to belong to that exact package. Extensions are broadly visible by
        // design — packages are not import boundaries — so a third package
        // (neither the plain bucket's first-come owner nor `currentPackage`)
        // must still be able to resolve every other package's same-name
        // extension. Scan every remaining qualified bucket for `name` before
        // giving up in this scope.
        let otherMatches = CollectExtensionFunctionMatchesFromOtherPackages(
            name,
            if currentPackage != nil {
                PackageQualifiedName(currentPackage, name)
            } else {
                default(string?)
            },
            receiverType
        )
        if !otherMatches.IsDefaultOrEmpty {
            function = otherMatches[0]
            return true
        }
        return Parent?.TryLookupExtensionFunction(receiverType, name, out function) ?? false
    }

    /// Issue #1188: returns every extension-function overload visible from this
    /// scope (walking parent scopes) that matches the (receiverType, name) pair.
    /// Extension functions support overloading, so a single call site may have
    /// several candidates differing only by parameter signature; the caller runs
    /// these through normal overload resolution to pick the best one.
    /// @remarks Both dispatch paths used by (cref:TryLookupExtensionFunction) are
    /// honoured: the reference-equality receiver fast path (issue #1103), the
    /// generic-receiver unification fallback (issue #773 / #775) and the
    /// implicit-conversion (subtype) receiver broadening (issue #1548).
    /// Candidates are returned in declaration order, innermost scope first; the
    /// caller's overload resolution scores the receiver as parameter 0 and so
    /// selects the most specific applicable receiver.
    /// @param receiverType The static type of the call receiver.
    /// @param name The method name at the call site.
    /// @returns The matching extension overloads, or an empty array when none match.
    func TryLookupExtensionFunctions(receiverType TypeSymbol, name string) ImmutableArray[FunctionSymbol] {
        // Issue #2342 follow-up: mirror TryLookupFunctions' ambient-package
        // preference. If the body currently being bound belongs to a known
        // declaring package and that package owns its OWN package-qualified
        // bucket for `name` (populated only when a cross-package collision
        // occurred — see TryDeclareExtensionFunction), resolve to that
        // package's own matching overloads rather than mixing in a foreign
        // package's same-name, same-signature homonym. A package with no
        // colliding extension under this name still sees every OTHER
        // extension by simple name via the plain-key fallback below.
        let currentPackage string? = GetCurrentDeclaringPackage()
        var ownKey string? = nil
        if currentPackage != nil {
            ownKey = PackageQualifiedName(currentPackage, name)
            let ownMatches = CollectExtensionFunctionMatches(ownKey, receiverType)
            if !ownMatches.IsDefaultOrEmpty {
                return ownMatches
            }
        }
        let plainMatches = CollectExtensionFunctionMatches(name, receiverType)
        if !plainMatches.IsDefaultOrEmpty {
            return plainMatches
        }
        // Issue #2414: neither the caller's own package-qualified bucket nor
        // the plain (first-come) bucket produced a match. When a name
        // collision occurred (see TryDeclareExtensionFunction), every OTHER
        // colliding package's overloads live in THEIR OWN package-qualified
        // buckets, which are otherwise invisible to any package that isn't
        // either the plain bucket's first-come owner or `currentPackage`
        // itself. Extensions are broadly visible by design — packages are
        // not import boundaries — so gather every remaining qualified
        // bucket's applicable overloads for `name` before giving up.
        return CollectExtensionFunctionMatchesFromOtherPackages(name, ownKey, receiverType)
    }

    /// Gets the extension functions declared in this scope (Phase 3.B.6).
    /// @returns An immutable array of extension functions.
    func GetDeclaredExtensionFunctions() ImmutableArray[FunctionSymbol] -> extensionFunctions?.ToImmutableArray() ??
        ImmutableArray[FunctionSymbol].Empty

    /// Tries to look up a symbol by its name in this scope.
    /// @param name The symbol name; `null` is accepted and always misses (see the recursive (cref:Parent)
    /// call below, which propagates whatever name was passed in).
    /// @returns The symbol, or `null` when not found.
    func TryLookupSymbol(name string?) Symbol? {
        if name != nil && symbols != nil && symbols!!.TryGetValue(name, out var symbol) {
            // Issue #2342 follow-up: `symbols[name]` only ever holds the
            // FIRST top-level function ever declared under this simple name
            // (see TryDeclareFunction), regardless of which package declared
            // it. When a body from a known declaring package is currently
            // being bound and that package owns its OWN overload bucket for
            // `name` (see TryLookupFunctions), prefer that package's own
            // function so a bare-name reference resolves to the caller's own
            // declaration rather than an unrelated package's same-named
            // function that merely happened to be declared first.
            if symbol is FunctionSymbol && GetCurrentDeclaringPackage() != nil {
                let ownOverloads = TryLookupFunctions(name)
                if !ownOverloads.IsDefaultOrEmpty && !object.ReferenceEquals(ownOverloads[0], symbol) {
                    return ownOverloads[0]
                }
            }
            return symbol
        }
        return Parent?.TryLookupSymbol(name)
    }

    /// Checks whether an imported ordinary type claims a name at any arity.
    /// @param name The unqualified identifier.
    /// @returns Whether ordinary lookup must take precedence over a native alias.
    func HasImportedTypeName(name string) bool {
        if SubmissionImports is {} submissions && submissions.TryResolveType(References!!, name, -1, out _) {
            return true
        }
        for import_ in EnumerateImports() {
            if (import_.IsAlias && import_.Name == name) || References!!.HasTypeNameAtAnyArity(
                import_.Target + "." + name
            ) {
                return true
            }
        }
        return GetCurrentDeclaringPackage() is {} package_ && References!!.HasTypeNameAtAnyArity(package_ + "." + name)
    }

    /// Tries to lookup an imported generic open type by simple name and arity (Phase 4.4 / ADR-0020).
    /// CLR generic types are stored under the mangled name `Name`N`; this overload
    /// searches each active import for `Target.Name`arity`.
    /// @param name The simple type name as written in source (without the backtick suffix).
    /// @param arity The number of type parameters.
    /// @param type The resolved open generic (cref:System.Type) on success.
    /// @returns Whether a matching open generic type was found.
    func TryLookupImportedGenericClass(
        name string,
        arity int32,
        @NotNullWhen(true) out type Type?
    ) bool -> TryLookupImportedGenericClass(name, arity, out type, out _)

    /// Issue #3734: same as (cref:TryLookupImportedGenericClass(string, int, out System.Type)),
    /// but also reports whether two or more explicitly written imports each
    /// resolve a DIFFERENT type under this name, so the caller can surface
    /// GS0547 instead of silently keeping the first-import-wins answer.
    /// @param name The simple type name as written in source (without the backtick suffix).
    /// @param arity The number of type parameters.
    /// @param type The resolved open generic (cref:System.Type) on success.
    /// @param ambiguity The colliding candidates when the name is ambiguous across imports; otherwise
    /// `null`.
    /// @returns Whether a matching open generic type was found.
    func TryLookupImportedGenericClass(
        name string,
        arity int32,
        @NotNullWhen(true) out type Type?,
        out ambiguity ImportedTypeAmbiguity?
    ) bool {
        type = nil
        ambiguity = nil
        if arity <= 0 {
            return false
        }
        // ADR-0156 Phase 2: a generic type declared by a prior interactive
        // submission resolves over that submission's emitted assembly,
        // newest submission first (see TryLookupImportedClass).
        if SubmissionImports is {} submissionImports && submissionImports.TryResolveType(
            References!!,
            name,
            arity,
            out var submissionType
        ) {
            type = submissionType
            return true
        }
        let mangled = name + "`" + arity.ToString()
        if TryResolveImportedTypeAlias(name, arity, out var aliasedType) {
            type = aliasedType
            return true
        }
        if TryScanImportsForClrType(mangled, requireNonGenericDefinition: false, out var scanned, out ambiguity) {
            type = scanned
            return true
        }
        // Issue #3595 (#3501): CLR namespaces merge across assemblies, and a
        // G# package is the same construct — a file in `package X` sees a
        // REFERENCED assembly's exported types in namespace X without
        // spelling `import X` (the C#→G# migration splits one namespace
        // across project boundaries). A fallback AFTER every explicit import
        // has failed: it can resolve previously-unresolvable names but never
        // introduces a new ambiguity or changes source-package
        // disambiguation.
        if GetCurrentDeclaringPackage() is {Length: > 0} declaringPackage && References!!.TryResolveType(
            declaringPackage + "." + mangled,
            out var selfPackageType
        ) {
            type = selfPackageType
            return true
        }
        return false
    }

    /// Tries to look up an imported class by simple name and preferred generic
    /// arity. Positive arities resolve the matching open generic definition;
    /// zero or negative arities retain the non-generic lookup behavior,
    /// including a direct `import Alias = Namespace.Type`.
    /// @param name The class name.
    /// @param preferredArity The preferred generic arity, or -1 for none.
    /// @param declaration The declaration.
    /// @param importedClass The result, if found.
    /// @returns Whether a class was found or not.
    func TryLookupImportedClassByArity(
        name string,
        preferredArity int32,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool -> TryLookupImportedClassByArity(name, preferredArity, declaration, out importedClass, out _)

    /// Issue #3734: same as
    /// (cref:TryLookupImportedClassByArity(string, int, ExpressionSyntax, out ImportedClassSymbol)),
    /// but also reports whether two or more explicitly written imports each
    /// resolve a DIFFERENT type under this name. The answer is unchanged —
    /// first-import-wins — so callers that ignore the ambiguity keep today's
    /// behavior; callers that surface it report GS0547 at the reference.
    /// @param name The class name.
    /// @param preferredArity The preferred generic arity, or -1 for none.
    /// @param declaration The declaration.
    /// @param importedClass The result, if found.
    /// @param ambiguity The colliding candidates when the name is ambiguous across imports; otherwise
    /// `null`.
    /// @returns Whether a class was found or not.
    func TryLookupImportedClassByArity(
        name string,
        preferredArity int32,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?,
        out ambiguity ImportedTypeAmbiguity?
    ) bool {
        ambiguity = nil
        if preferredArity > 0 {
            if TryLookupImportedGenericClass(name, preferredArity, out var importedGeneric, out ambiguity) {
                importedClass = ImportedClassSymbol(importedGeneric!!, declaration, references: References)
                return true
            }
            importedClass = nil
            return false
        }
        // ADR-0156 Phase 2: preserve prior-submission precedence, but reject
        // its lone-open-generic fallback at a non-generic use site.
        if SubmissionImports is {} submissionImports && submissionImports.TryResolveType(
            References!!,
            name,
            preferredArity,
            out var submissionType
        ) &&
            !submissionType!!
            .IsGenericTypeDefinition {
            importedClass = ImportedClassSymbol(submissionType!!, declaration, references: References)
            return true
        }
        if TryResolveImportedTypeAlias(name, preferredArity, out var aliasedType) {
            importedClass = ImportedClassSymbol(aliasedType!!, declaration, references: References)
            return true
        }
        if TryScanImportsForClrType(name, requireNonGenericDefinition: true, out var scanned, out ambiguity) {
            importedClass = ImportedClassSymbol(scanned!!, declaration, references: References)
            return true
        }
        // Issue #3595 (#3501): same self-package fallback as
        // TryLookupImportedGenericClass — a file in `package X` sees a
        // referenced assembly's namespace-X types after every explicit
        // import has failed to resolve the name.
        if GetCurrentDeclaringPackage() is {Length: > 0} declaringPackage && References!!.TryResolveType(
            declaringPackage + "." + name,
            out var selfPackageType
        ) &&
            !selfPackageType!!
            .IsGenericTypeDefinition {
            importedClass = ImportedClassSymbol(selfPackageType!!, declaration, references: References)
            return true
        }
        importedClass = nil
        return false
    }

    /// Tries to lookup an imported class.
    /// @param name The class name.
    /// @param declaration The declaration.
    /// @param importedClass The result, if found.
    /// @returns Whether a class was found or not.
    func TryLookupImportedClass(
        name string,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool -> TryLookupImportedClassByArity(name, preferredArity: 0, declaration, out importedClass)

    /// Issue #3734: same as
    /// (cref:TryLookupImportedClass(string, ExpressionSyntax, out ImportedClassSymbol)),
    /// but also reports a cross-import homonym collision.
    /// @param name The class name.
    /// @param declaration The declaration.
    /// @param importedClass The result, if found.
    /// @param ambiguity The colliding candidates when the name is ambiguous across imports; otherwise
    /// `null`.
    /// @returns Whether a class was found or not.
    func TryLookupImportedClass(
        name string,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?,
        out ambiguity ImportedTypeAmbiguity?
    ) bool -> TryLookupImportedClassByArity(name, preferredArity: 0, declaration, out importedClass, out ambiguity)

    /// Issue #3334 / ADR-0134: enumerates referenced-assembly CLR types brought
    /// into unqualified static scope by an import. A type import resolves the
    /// target itself; a package import resolves the package's synthetic
    /// `<Program>` type, which hosts public package-level functions
    /// and globals. Implicit (compiler-synthesized) and alias imports never
    /// hoist.
    /// @returns The distinct imported static-import CLR types, in import order.
    func EnumerateStaticImportClrTypes() sequence[Type] {
        if References == nil {
            yield break
        }
        var seen HashSet[Type]? = nil
        for import_ in EnumerateImports() {
            if (import_.IsImplicit && !import_.HoistsStatics) || import_.IsAlias {
                continue
            }
            if !References!!.TryResolveType(import_.Target, out var type) {
                References!!.TryResolveType(SubmissionImports.GetProgramTypeName(import_.Target), out type)
            }
            if type != nil {
                seen ??= HashSet[Type]()
                if seen!!.Add(type) {
                    yield type
                }
            }
        }
    }

    /// Tries to look up an imported namespace by the name the user references it with
    /// (the alias if one was declared, otherwise the import path).
    /// @param name The name as it appears in user code.
    /// @param import The matching import, when found.
    /// @returns Whether a matching import exists.
    func TryLookupImport(name string, @NotNullWhen(true) out $import ImportSymbol?) bool {
        $import = nil
        for candidate in EnumerateImports() {
            if string.Equals(candidate.Name, name, StringComparison.Ordinal) {
                $import = candidate
                return true
            }
        }
        return false
    }

    /// Issue #3907: resolves a package-qualified name — `Pkg.Sub.Name` —
    /// to a type <em>declared in this compilation</em>, in the package the
    /// qualifier segments spell, at the requested generic arity.
    /// @remarks This exists so a source declaration can be preferred over an
    /// imported one carrying the same fully-qualified name. C# resolves such a
    /// collision in favour of source (Roslyn reports `CS0436` and uses the
    /// source type); gsc's dotted-name binder used to reach the reflection
    /// prefix walk first and therefore chose the metadata type, silently
    /// re-pointing a base clause at another assembly's same-named type.
    ///
    /// Deliberately strict: the qualifier must match the candidate's
    /// declaring package EXACTLY, the simple name must match the candidate's
    /// containing-type-qualified name, and the arity must match. Two source
    /// candidates for the same qualified name yield no match rather than a
    /// guess, leaving the caller's existing resolution and diagnostics
    /// untouched.
    /// @param packageName The qualifier segments, dot-joined.
    /// @param name The final segment.
    /// @param preferredArity The requested generic arity, or -1/0 for none.
    /// @param type The matching source type, when unambiguous.
    /// @returns Whether exactly one source type matches.
    func TryLookupSourceTypeInPackage(
        packageName string,
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        if string.IsNullOrEmpty(packageName) || string.IsNullOrEmpty(name) {
            type = nil
            return false
        }
        return TryLookupQualifiedSourceType(packageName + "." + name, preferredArity, out type)
    }

    /// Expands the leading import of a qualified type name.
    /// @param segmentTexts The dotted name segments.
    /// @param length The number of segments to join.
    /// @returns The complete name after import expansion.
    func ExpandQualifiedTypeName(segmentTexts[]string, length int32) string {
        if TryLookupImport(segmentTexts[0], out var import_) {
            return import_!!.Target + "." + string.Join(".", segmentTexts, 1, length - 1)
        }
        return string.Join(".", segmentTexts, 0, length)
    }

    /// Resolves a dotted source type name by its exact package and possibly
    /// nested type identity.
    /// @param qualifiedName The package-qualified source type name.
    /// @param preferredArity The requested generic arity, or -1/0 for none.
    /// @param type The matching source type, when unambiguous.
    /// @returns Whether the qualified name resolves to exactly one source type.
    func TryLookupQualifiedSourceType(
        qualifiedName string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        type = nil
        if string.IsNullOrEmpty(qualifiedName) {
            return false
        }
        let wantedArity = if preferredArity > 0 {
            preferredArity
        } else {
            0
        }
        var match TypeSymbol? = nil
        let seen = HashSet[TypeSymbol]()
        for pair in EnumerateTypeAliasesInChain() {
            if TryGetAliasDeclaringPackageInChain(pair.Key, out var aliasPackage) {
                let aliasName = pair.Key.Substring(pair.Key.IndexOf('#') + 1)
                if GetTypeAliasArity(pair.Value) != wantedArity || !string.Equals(
                    aliasPackage + "." + aliasName,
                    MangleArity(qualifiedName, wantedArity),
                    StringComparison.Ordinal
                ) {
                    continue
                }
                if match != nil && !object.ReferenceEquals(match, pair.Value) {
                    return false
                }
                match = pair.Value
                continue
            }
            let candidate = TypeDefinition(pair.Value)
            if !seen.Add(candidate) ||
                GetTypeAliasArity(candidate) != wantedArity ||
                IsDeclaredInImplicitPackage(candidate) {
                continue
            }
            let package_ = TypePackageName(candidate)
            if string.IsNullOrEmpty(package_) || !string.Equals(
                package_ + "." + QualifiedTypeName(candidate),
                qualifiedName,
                StringComparison.Ordinal
            ) {
                continue
            }
            if match != nil && !object.ReferenceEquals(match, candidate) {
                return false
            }
            match = candidate
        }
        type = match
        return match != nil
    }

    /// Resolves an explicit import alias whose target is a same-compilation
    /// source type rather than a CLR type.
    /// @param name The visible alias name.
    /// @param preferredArity The requested generic arity.
    /// @param type The exact source target.
    /// @returns Whether the alias targets a source type of the requested arity.
    func TryResolveExplicitSourceTypeAlias(
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        type = nil
        if !TryLookupImport(name, out var import_) || !import_!!.IsAlias {
            return false
        }
        var match TypeSymbol? = nil
        let seen = HashSet[TypeSymbol]()
        for pair in EnumerateTypeAliasesInChain() {
            let candidate = TypeDefinition(pair.Value)
            if !seen.Add(candidate) {
                continue
            }
            let arity = GetTypeAliasArity(candidate)
            if (preferredArity > 0 && arity != preferredArity) || (preferredArity <= 0 && arity != 0) {
                continue
            }
            let package_ = TypePackageName(candidate)
            let qualifiedName = QualifiedTypeName(candidate)
            let fullName = if string.IsNullOrEmpty(package_) || string.Equals(
                package_,
                "Default",
                StringComparison.Ordinal
            ) ||
                IsDeclaredInImplicitPackage(candidate) {
                qualifiedName
            } else {
                package_ + "." + qualifiedName
            }
            if !string.Equals(fullName, import_!!.Target, StringComparison.Ordinal) {
                continue
            }
            if match != nil && !object.ReferenceEquals(match, candidate) {
                return false
            }
            match = candidate
        }
        type = match
        return match != nil
    }

    /// Gets an immutable array of all the declared variables.
    /// @returns The declared variables.
    func GetDeclaredVariables() ImmutableArray[VariableSymbol] -> GetDeclaredSymbols[VariableSymbol]()

    /// Gets an immutable array of all the declared functions, including every
    /// overload registered via (cref:TryDeclareFunction) (ADR-0063 §11).
    /// @returns The declared functions in declaration order.
    func GetDeclaredFunctions() ImmutableArray[FunctionSymbol] {
        if functions == nil || functions!!.Count == 0 {
            return ImmutableArray[FunctionSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        // functionKeys is always assigned together with functions, in the same
        // `functions ??= ...; functionKeys ??= ...;` pair at the top of
        // TryDeclareFunction — the only place either field is populated.
        // functions != null (checked above) therefore guarantees functionKeys
        // != null too.
        for key in functionKeys!! {
            if functions!!.TryGetValue(key, out var bucket) {
                builder.AddRange(bucket)
            }
        }
        return builder.ToImmutable()
    }

    /// Gets an immutable array of all the declared imports.
    /// @returns The declared imports.
    func GetDeclaredImports() ImmutableArray[ImportSymbol] -> EnumerateImports()

    /// Gets the imports declared directly in <em>this</em> scope only — unlike
    /// (cref:GetDeclaredImports), this does not walk (cref:Parent).
    /// Used by (cref:Binder.BindGlobalScope(BoundGlobalScope, ImmutableArray{SyntaxTree},
    /// ReferenceResolver, bool, ImmutableHashSet{string}, bool))
    /// to populate (cref:BoundGlobalScope.Imports) with only the current
    /// submission's own imports (issue #2101): that field is later re-seeded,
    /// one historical (cref:BoundGlobalScope) per chained REPL
    /// submission, into a fresh per-level (cref:BoundScope) by
    /// (cref:Binder.CreateParentScope(BoundGlobalScope, ReferenceResolver, ImmutableHashSet{string},
    /// bool)). Using the walking/cumulative
    /// (cref:GetDeclaredImports) there previously made every submission
    /// re-import the ENTIRE flattened history of every prior submission into
    /// its own scope layer, which was then itself re-flattened on the next
    /// call — an `I(k) = sum(I(0..k-1))` recurrence that doubles the
    /// import count (and binding time) on every single REPL submission.
    /// @returns This scope's own declared imports, in declaration order.
    func GetOwnDeclaredImports() ImmutableArray[ImportSymbol] -> imports?.ToImmutable() ??
        ImmutableArray[ImportSymbol].Empty

    /// Tries to declare a type alias.
    /// @param name The alias name.
    /// @param target The underlying type.
    /// @returns Whether the alias was declared (false if the name was already taken).
    func TryDeclareTypeAlias(name string, target TypeSymbol) bool -> TryDeclareTypeAlias(
        name,
        target,
        declaringPackageName: nil
    )

    /// Tries to declare a type alias, with an explicit declaring-package
    /// identity for the alias itself.
    /// @param name The alias name.
    /// @param target The underlying type.
    /// @param declaringPackageName Issue #2342 follow-up: the package that DECLARES this alias (see
    /// (cref:DeclarationBinder.BindTypeAliasDeclaration(GSharp.Core.CodeAnalysis.Syntax.TypeAliasDeclarationSyntax,
    /// PackageSymbol))),
    /// or `null`. A plain `type Name = Target` alias has
    /// no dedicated symbol of its own — `target` IS the aliased type —
    /// so, absent this override, its package identity would have to be
    /// inferred (best-effort) from whatever package `target` itself
    /// belongs to (see (cref:TypePackageName)), which is `null` for a primitive/imported/BCL/anonymous
    /// target and
    /// therefore indistinguishable between two unrelated packages that each
    /// alias such a target under the same simple name. Passing the alias's
    /// OWN declaring package here gives it a stable identity independent of
    /// the target, so two same-simple-name aliases in different packages
    /// coexist (like any other top-level declaration under #2342) even when
    /// their targets have no package identity of their own — or share one.
    /// Callers declaring a real symbol (struct/enum/interface/delegate) pass
    /// `null`: their [`target`](paramref) already
    /// carries accurate, stable package identity intrinsically.
    /// @returns Whether the alias was declared (false if the name was already taken).
    func TryDeclareTypeAlias(name string?, target TypeSymbol, declaringPackageName string?) bool {
        if name == nil {
            return false
        }
        // Issue #1051: key by (simple name, generic arity) so that a type and a
        // same-named generic of different arity coexist. A genuine duplicate —
        // same name AND same arity — still collides and reports GS0102.
        let arity = GetTypeAliasArity(target)
        let key = MangleArity(name, arity)
        if !TypeAliasVisible(key) {
            AddTypeAlias(key, target)
            RegisterAliasDeclaringPackage(key, declaringPackageName)
            return true
        }
        // Issue #1080 / #2342: a name clash on the simple (arity-bearing) key is
        // only a genuine duplicate — GS0102 — when both types live in the SAME
        // declaration scope: both nested in the SAME enclosing type, or both
        // top-level AND in the SAME package. A nested type must NOT collide with
        // a top-level type of the same simple name, nor with a nested type of a
        // DIFFERENT enclosing type (#1080); and two top-level types of the same
        // simple name in DIFFERENT packages/namespaces are not duplicates either
        // (#2342) — a single compilation-wide flat scope must not defeat package
        // isolation. Such non-conflicting types coexist: whichever type already
        // owns the simple key keeps it so it stays resolvable by simple name,
        // while the "loser" is retained under a distinct fallback key (the
        // containing-type-qualified key for a nested-vs-top-level clash, or a
        // package-qualified key for a top-level-vs-top-level clash across
        // packages) — emit, which enumerates all stored values regardless of
        // key, still produces its TypeDef.
        let existing = if TryGetTypeAliasInChain(key, out var existingValue) {
            existingValue
        } else {
            default(TypeSymbol?)
        }
        let targetEnclosing TypeSymbol? = TypeContainingType(target)
        let existingEnclosing TypeSymbol? = TypeContainingType(existing)
        if IsSameDeclarationScope(existing, target, key, declaringPackageName) {
            return false
        }
        // Issue #2342: both declarations reach here as TOP-LEVEL (no enclosing
        // type) — a same-package top-level clash was already rejected above by
        // IsSameDeclarationScope — so they belong to DIFFERENT packages. Neither
        // is more "top-level" than the other, so (unlike the nested-vs-top-level
        // case below) the already-declared type keeps the simple key undisturbed
        // and the incoming type is retained under a package-qualified key. Both
        // stay resolvable (the qualified key is still enumerated at emit time)
        // without moving state the first declaration may already be referenced
        // by.
        if targetEnclosing == nil && existingEnclosing == nil {
            let targetPackage = declaringPackageName ?? TypePackageName(target)
            let packageQualifiedKey = MangleArity(PackageQualifiedName(targetPackage, name), arity)
            if TypeAliasVisible(packageQualifiedKey) {
                // Same simple name AND same package-qualified key: a genuine
                // duplicate (e.g. three-plus same-named packages colliding).
                return false
            }
            AddTypeAlias(packageQualifiedKey, target)
            RegisterAliasDeclaringPackage(packageQualifiedKey, declaringPackageName)
            return true
        }
        // Prefer the top-level type as the owner of the simple key. If a nested
        // type currently occupies the simple key but the incoming type is
        // top-level, evict the nested type to its qualified key and install the
        // top-level type under the simple key.
        if targetEnclosing == nil && existingEnclosing != nil {
            let existingQualifiedKey = MangleArity(QualifiedTypeName(existing), arity)
            if TryGetTypeAliasInChain(existingQualifiedKey, out var occupant) && !object.ReferenceEquals(
                occupant,
                existing
            ) {
                return false
            }
            // existingEnclosing (= TypeContainingType(existing), checked non-null
            // above) can only be non-null when `existing` matched one of
            // TypeContainingType's StructSymbol/EnumSymbol/InterfaceSymbol type
            // patterns — a null `existing` always falls through to `_ => null`
            // (type patterns never match null) — so existing is non-null here.
            AddTypeAlias(existingQualifiedKey, existing!!)
            if TryGetAliasDeclaringPackageInChain(key, out var carriedOverPackage) {
                RegisterAliasDeclaringPackage(existingQualifiedKey, carriedOverPackage)
            }
            SetTypeAliasOverride(key, target)
            RegisterAliasDeclaringPackage(key, declaringPackageName)
            return true
        }
        // The incoming type is nested and clashes with a differently-scoped type
        // already holding the simple key. Retain it under its qualified key. A
        // clash on the qualified key means a genuine duplicate within the SAME
        // enclosing type — report GS0102.
        let qualifiedKey = MangleArity(QualifiedTypeName(target), arity)
        if TypeAliasVisible(qualifiedKey) {
            return false
        }
        AddTypeAlias(qualifiedKey, target)
        RegisterAliasDeclaringPackage(qualifiedKey, declaringPackageName)
        return true
    }

    /// Issue #1051: re-declares a type alias under its already-computed storage
    /// key (as returned by (cref:GetDeclaredTypeAliases)) without
    /// re-deriving the arity suffix. Used when threading aliases from a previous
    /// submission's global scope into a fresh scope so generic keys are not
    /// double-mangled.
    /// @param key The composite storage key.
    /// @param target The underlying type.
    /// @returns Whether the alias was declared (false if the key was already taken).
    func TryRedeclareTypeAlias(key string?, target TypeSymbol) bool {
        if key == nil {
            return false
        }
        if TypeAliasVisible(key) {
            return false
        }
        AddTypeAlias(key, target)
        return true
    }

    /// Tries to look up a type alias by name, preferring the arity-0 type.
    /// @param name The alias name.
    /// @param type The aliased type, when found.
    /// @returns Whether an alias exists.
    func TryLookupTypeAlias(name string, @NotNullWhen(true) out type TypeSymbol?) bool -> TryLookupTypeAlias(
        name,
        preferredArity: -1,
        out type
    )

    /// Issue #1051: tries to look up a type alias by (name, arity). When
    /// [`preferredArity`](paramref) is non-negative, the type with exactly
    /// that generic arity is returned if present; otherwise the lookup falls
    /// back to the arity-0 type (plain name) and then to the lowest-arity
    /// same-name variant. A negative [`preferredArity`](paramref) means
    /// "no arity preference" and resolves the arity-0 type first.
    /// @param name The alias name.
    /// @param preferredArity The exact generic arity, or -1 for none.
    /// @param type The aliased type, when found.
    /// @returns Whether an alias exists.
    func TryLookupTypeAlias(
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool -> TryLookupTypeAlias(name, preferredArity, out type, out _)

    /// Issue #2455: same as (cref:TryLookupTypeAlias(string, int, out TypeSymbol)),
    /// but also reports (via [`ambiguousAcrossImportedPackages`](paramref))
    /// when the simple name genuinely cannot be determined because two or more
    /// DIFFERENT packages that both declare a same-named top-level type are
    /// EACH visible via an explicit `import` in the referencing syntax
    /// tree. Callers that can surface a location-bearing diagnostic (e.g.
    /// (cref:Binder.BindNonNullableTypeClause)'s bare-name branch) should
    /// use this overload and report a dedicated ambiguity diagnostic instead of
    /// the generic "cannot find type"; every other caller keeps using the
    /// 3-argument overload, for which an ambiguous result is simply treated as
    /// "not found" (never silently resolved to the wrong package's type).
    /// @param name The alias name.
    /// @param preferredArity The preferred generic arity, or -1 for none.
    /// @param type The aliased type, when found.
    /// @param ambiguousAcrossImportedPackages Whether resolution failed specifically because two or more
    /// colliding
    /// packages are both imported by the referencing file (as opposed to no
    /// match at all).
    /// @returns Whether an alias exists.
    func TryLookupTypeAlias(
        name string?,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?,
        out ambiguousAcrossImportedPackages bool
    ) bool {
        type = nil
        ambiguousAcrossImportedPackages = false
        if name == nil {
            return false
        }
        // Issue #2455: an explicit qualified-construction package hint (see
        // SetQualifiedConstructionPackageHint) always wins outright — an
        // explicit package qualification (e.g. `Oahu.Audible.Json.Author{...}`)
        // already disambiguates the reference, so it must never be second-
        // guessed by the general import-based ambiguity check below, even when
        // the terminal simple name collides across two or more independently-
        // imported packages.
        let qualifiedConstructionHint string? = GetQualifiedConstructionPackageHint()
        if qualifiedConstructionHint != nil {
            if preferredArity > 0 &&
                TryResolveTypeAliasByExplicitPackageHint(name, preferredArity, qualifiedConstructionHint, out type) {
                return true
            }
            if TryResolveTypeAliasByExplicitPackageHint(name, arity: 0, qualifiedConstructionHint, out type) {
                return true
            }
        }
        // Issue #2342: when a "current declaring package" is set (the body of a
        // top-level declaration belonging to that package is being bound — see
        // <see cref="SetCurrentDeclaringPackage"/>), prefer that package's OWN
        // type over an unrelated package's same-named homonym occupying the
        // plain simple key. Without this, a package whose top-level type LOST
        // the plain-simple-key "race" against another package's same-named
        // type (see <see cref="TryDeclareTypeAlias(string, TypeSymbol, string)"/>) could never resolve ITS
        // OWN type by simple name from within its own code — the exact
        // "AnonymousType0 declared independently in two packages" shape from
        // the real Oahu.Data migration corpus.
        let currentPackage string? = GetCurrentDeclaringPackage()
        if currentPackage != nil {
            if preferredArity > 0 &&
                TryResolveTypeAliasByExplicitPackageHint(name, preferredArity, currentPackage, out type) {
                return true
            }
            if TryResolveTypeAliasByExplicitPackageHint(name, arity: 0, currentPackage, out type) {
                return true
            }
        }
        // Issue #2455: a bare simple name that collides across two or more
        // DIFFERENT top-level packages is stored under one arbitrary "first
        // declared wins" plain key (see TryDeclareTypeAlias) plus one or more
        // package-qualified fallback keys for the losing packages — an
        // ordering/tree-order-dependent choice that does not reflect what the
        // referencing code actually means. When the referencing scope isn't
        // either colliding package itself (the check above), consult the
        // referencing file's `import` set: if EXACTLY ONE colliding package is
        // imported by that file, its type is the only one the
        // reference could plausibly mean, so prefer it deterministically over
        // the order-dependent plain-key winner. If two or more colliding
        // packages are each imported, the reference is genuinely ambiguous.
        if preferredArity > 0 {
            if TryResolveCollidingTypeAliasByImport(
                name,
                preferredArity,
                out type,
                out ambiguousAcrossImportedPackages
            ) {
                return true
            }
            if ambiguousAcrossImportedPackages {
                return false
            }
            let key = MangleArity(name, preferredArity)
            if TryGetTypeAliasInChain(key, out type) {
                return true
            }
        }
        if TryResolveCollidingTypeAliasByImport(name, arity: 0, out type, out ambiguousAcrossImportedPackages) {
            return true
        }
        if ambiguousAcrossImportedPackages {
            return false
        }
        // Fall back to the arity-0 type (whose key is the plain simple name).
        if TryGetTypeAliasInChain(name, out type) {
            return true
        }
        // No arity-0 type: resolve the lowest-arity same-name generic variant
        // so a lone generic definition keeps resolving by simple name.
        var best TypeSymbol? = nil
        var bestArity = int32.MaxValue
        for pair in EnumerateTypeAliasCandidates(name, exactArity: false) {
            if TryParseAritySuffix(pair.Key, name, out var arity) && arity < bestArity {
                best = pair.Value
                bestArity = arity
            }
        }
        if best != nil {
            type = best
            return true
        }
        return false
    }

    /// Issue #1174: resolves a nested type by its enclosing [`container`](paramref)
    /// and simple [`simpleName`](paramref), rather than by global simple
    /// name. This is required when a top-level type shares the nested type's
    /// simple name: per (cref:TryDeclareTypeAlias(string, TypeSymbol, string)), the top-level homonym
    /// keeps the simple key while the nested type is retained under its
    /// containing-type-qualified key (e.g. `"C.E"`). A plain
    /// (cref:TryLookupTypeAlias(string, out TypeSymbol)) of the simple
    /// name would return the top-level homonym, so a qualified reference
    /// `Container.Nested` must look the nested type up by (container,
    /// simpleName).
    /// @param container The enclosing type the nested type must belong to.
    /// @param simpleName The nested type's simple name.
    /// @param preferredArity The preferred generic arity, or -1 for none.
    /// @param type The resolved nested type, when found.
    /// @returns Whether a nested type with that container and name exists.
    func TryLookupNestedTypeAlias(
        container TypeSymbol?,
        simpleName string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        type = nil
        if container == nil || string.IsNullOrEmpty(simpleName) {
            return false
        }
        let containerDefinition = TypeDefinition(container)
        // The nested type is stored under its containing-type-qualified key
        // (e.g. `Outer.Inner` for a doubly-nested type), arity-mangled the same
        // way as in TryDeclareTypeAlias.
        let qualifiedName = QualifiedTypeName(containerDefinition) + "." + simpleName
        if preferredArity >= 0 {
            let qualifiedKey = if preferredArity == 0 {
                qualifiedName
            } else {
                MangleArity(qualifiedName, preferredArity)
            }
            if TryGetTypeAliasInChain(qualifiedKey, out var qualifiedMatch) &&
                IsNestedDirectlyIn(qualifiedMatch, containerDefinition) {
                type = qualifiedMatch
                return true
            }
            let simpleKey = if preferredArity == 0 {
                simpleName
            } else {
                MangleArity(simpleName, preferredArity)
            }
            if TryGetTypeAliasInChain(simpleKey, out var simpleMatch) &&
                IsNestedDirectlyIn(simpleMatch, containerDefinition) {
                type = simpleMatch
                return true
            }
            return false
        }
        // Unknown arity: prefer the non-generic nested type.
        if TryGetTypeAliasInChain(qualifiedName, out var qualifiedExact) &&
            IsNestedDirectlyIn(qualifiedExact, containerDefinition) {
            type = qualifiedExact
            return true
        }
        if TryGetTypeAliasInChain(simpleName, out var simpleExact) &&
            IsNestedDirectlyIn(simpleExact, containerDefinition) {
            type = simpleExact
            return true
        }
        // No arity-0 match: resolve the lowest-arity generic variant.
        var best TypeSymbol? = nil
        var bestArity = int32.MaxValue
        for pair in EnumerateNestedTypeAliasCandidates(containerDefinition, simpleName) {
            if TryParseAritySuffix(pair.Key, qualifiedName, out var qualifiedArity) &&
                qualifiedArity < bestArity &&
                IsNestedDirectlyIn(pair.Value, containerDefinition) {
                best = pair.Value
                bestArity = qualifiedArity
            }
        }
        if best == nil {
            for pair in EnumerateNestedTypeAliasCandidates(containerDefinition, simpleName) {
                if TryParseAritySuffix(pair.Key, simpleName, out var simpleArity) &&
                    simpleArity < bestArity &&
                    IsNestedDirectlyIn(pair.Value, containerDefinition) {
                    best = pair.Value
                    bestArity = simpleArity
                }
            }
        }
        if best != nil {
            type = best
            return true
        }
        return false
    }

    /// Resolves an unqualified nested source type through the current lexical
    /// containing-type chain before global simple-name lookup.
    /// @param currentContainingType The source type containing the reference.
    /// @param simpleName The nested type's simple name.
    /// @param preferredArity The exact requested arity, or -1 when unspecified.
    /// @param type The resolved nested type, including enclosing generic substitutions.
    /// @returns Whether a lexically visible nested type was found.
    func TryLookupLexicalNestedTypeAlias(
        currentContainingType TypeSymbol,
        simpleName string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        for var current TypeSymbol? = currentContainingType; current != nil; current = TypeContainingType(current) {
            let currentDefinition = TypeDefinition(current)
            if TryLookupNestedTypeAlias(currentDefinition, simpleName, preferredArity, out var direct) {
                type = if current is StructSymbol directOwner {
                    ApplyEnclosingConstruction(direct!!, directOwner)
                } else {
                    direct
                }
                return true
            }
            if current is StructSymbol currentStruct &&
                TryLookupNestedTypeAliasIncludingInherited(
                currentStruct,
                simpleName,
                preferredArity,
                out var inherited,
                out var declaringContainer
            ) {
                type = ApplyEnclosingConstruction(inherited!!, declaringContainer!!)
                return true
            }
        }
        type = nil
        return false
    }

    /// Resolves a nested type through a source class and its base-class chain,
    /// returning the effective base construction that declares it.
    /// @param container The source class used to qualify the nested type.
    /// @param simpleName The nested type's simple name.
    /// @param preferredArity The preferred generic arity.
    /// @param type The nested type definition.
    /// @param declaringContainer The effective declaring construction.
    /// @returns Whether a nested type was found.
    func TryLookupNestedTypeAliasIncludingInherited(
        container StructSymbol,
        simpleName string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?,
        @NotNullWhen(true) out declaringContainer StructSymbol?
    ) bool {
        // Issue #4164: a genuine base-class cycle (e.g. `class B : C` / `class
        // C : B`) is normally caught by the post-bind cycle detector (#973),
        // but this walk runs earlier — during declaration binding, while
        // binding an explicit `init(...)` constructor parameter's type clause
        // (Binder.LookupType -> BinderContext.TryLookupSourceType ->
        // TryLookupLexicalNestedTypeAlias -> here), before that detector has
        // run. Without a guard, a cyclic BaseClass chain made this loop
        // forever (B -> C -> B -> C -> ...); unlike #4162's
        // StructSymbol.GetHierarchy() (which grew an unbounded List and OOMed
        // the process), this loop allocated nothing per iteration, so
        // unguarded it spun the CPU indefinitely at roughly stable RSS rather
        // than growing memory — measured ~80 MB RSS, no growth, over a 30s
        // hang. `container.GetHierarchy()` is the single guarded walk (fixed
        // by #4162, and the one every other #4164 call site now goes
        // through too); skip the first entry (`container` itself) to match
        // this loop's original `container.BaseClass` starting point.
        let baseChain = container.GetHierarchy()
        for var level = 1; level < baseChain.Count; level++ {
            let c = baseChain[level]
            let definition = c.Definition ?? c
            if !TryLookupNestedTypeAlias(definition, simpleName, preferredArity, out type) {
                if TypeMemberModel.DeclaresAnyStaticMember(c, simpleName) {
                    break
                }
                continue
            }
            if !AccessibilityChecker.IsAccessibleFromType(NestedTypeAccessibility(type!!), definition, container) {
                type = nil
                declaringContainer = nil
                return false
            }
            declaringContainer = TypeMemberModel.ResolveStaticMemberOwner(container, c)
            return true
        }
        type = nil
        declaringContainer = nil
        return false
    }

    /// Gets the set of declared type aliases.
    /// @returns The map of alias names to underlying types.
    func GetDeclaredTypeAliases() ImmutableDictionary[string, TypeSymbol] {
        let builder = ImmutableDictionary.CreateBuilder[string, TypeSymbol]()
        for pair in GetOrderedTypeAliases() {
            builder[pair.Key] = pair.Value
        }
        return builder.ToImmutable()
    }

    /// Gets the set of declared user-defined struct types in this scope chain.
    /// @returns The structs in declaration order.
    func GetDeclaredStructs() ImmutableArray[StructSymbol] {
        if typeAliases == nil && Parent != nil {
            return Parent!!.GetDeclaredStructs()
        }
        let aliases = GetOrderedTypeAliases()
        if AliasDerivedSnapshot[ImmutableArray[StructSymbol]].TryGet(&structSnapshot, nil, aliases, out var published) {
            return published
        }
        return AliasDerivedSnapshot[ImmutableArray[StructSymbol]].Publish(
            &structSnapshot,
            nil,
            aliases,
            "scope.declared-structs",
            GetDeclaredTypeSymbols[StructSymbol](aliases)
        )
    }

    /// Gets the set of declared user-defined interface types in this scope chain (Phase 3.B.4).
    /// @returns The interfaces in declaration order.
    func GetDeclaredInterfaces() ImmutableArray[InterfaceSymbol] -> GetDeclaredTypeSymbols[InterfaceSymbol]()

    /// Gets the set of declared user-defined enum types in this scope chain (#193).
    /// @returns The enums in declaration order.
    func GetDeclaredEnums() ImmutableArray[EnumSymbol] -> GetDeclaredTypeSymbols[EnumSymbol]()

    /// Gets the set of declared user-defined named delegate types in this scope chain (ADR-0059 / issue
    /// #255).
    /// @returns The named delegate types in declaration order.
    func GetDeclaredDelegates() ImmutableArray[DelegateTypeSymbol] -> GetDeclaredTypeSymbols[DelegateTypeSymbol]()

    /// Registers the interactive submission import set (ADR-0156 Phase 2) on
    /// this (root) scope; exposed to child scopes via (cref:SubmissionImports).
    /// @param imports The submission import set; may be `null`.
    internal func SetSubmissionImports(imports SubmissionImports?) -> submissionImports = imports

    /// Records a package declared by the source compilation.
    /// @param packageName The package's dotted name.
    internal func RegisterSourcePackage(packageName string) {
        sourcePackagePrefixes ??= ImmutableDictionary.CreateBuilder[string, bool](StringComparer.Ordinal)
        for var end = packageName.Length; end > 0; end = packageName.LastIndexOf('.', end - 1) {
            let prefix = packageName.Substring(0, end)
            let exact = end == packageName.Length
            if !sourcePackagePrefixes!!.TryGetValue(prefix, out var existingExact) || (exact && !existingExact) {
                sourcePackagePrefixes!![prefix] = exact
            }
        }
    }

    /// Returns whether a source package exactly matches, or descends from, the
    /// specified dotted prefix.
    /// @param packagePrefix The package prefix to probe.
    /// @param exactMatch Whether an exact package match was found.
    /// @returns Whether the prefix belongs to the source package hierarchy.
    internal func TryMatchSourcePackagePrefix(packagePrefix string, out exactMatch bool) bool {
        exactMatch = false
        if string.IsNullOrEmpty(packagePrefix) {
            return false
        }
        var matched = false
        for var current BoundScope? = this; current != nil; current = current!!.Parent {
            if current.sourcePackagePrefixes?.TryGetValue(packagePrefix, out var isExact) == true {
                if isExact {
                    exactMatch = true
                    return true
                }
                matched = true
            }
        }
        return matched
    }

    /// Gets the services of this binding pass (issue #5140), walking to the root of this
    /// scope's chain so every binder over the chain shares one instance. An independent-body
    /// worker scope is its own root: it owns worker-local services and never reaches the
    /// coordinator's (ADR-0203 section 4).
    /// @returns The (cref:BindingServices) for this scope's chain.
    internal func GetBindingServices() BindingServices -> if Parent != nil && !independentBodyRoot {
        Parent!!.GetBindingServices()
    } else {
        (
            if bindingServices == nil {
                (bindingServices = BindingServices())
            } else {
                bindingServices
            }
        )!!
    }

    /// Gets the per-compile-pass anonymous-class-literal type cache (issue
    /// #2224), walking to the root of this scope's chain so every scope in
    /// one bind pass shares the same cache instance.
    /// @returns The shared (cref:AnonymousTypeCache) for this scope's chain.
    internal func GetAnonymousTypeCache() AnonymousTypeCache -> if SynthesisParent != nil {
        Parent!!.GetAnonymousTypeCache()
    } else {
        (
            if anonymousTypeCache == nil {
                (anonymousTypeCache = AnonymousTypeCache())
            } else {
                anonymousTypeCache
            }
        )!!
    }

    /// Issue #5281: makes this scope's chain share an anonymous-type cache
    /// created by an earlier pass, so shapes and the `<>AnonymousTypeN` counter
    /// continue across the declaration and body passes.
    /// @param cache The cache to share.
    internal func InstallAnonymousTypeCache(cache AnonymousTypeCache) {
        if SynthesisParent != nil {
            Parent!!.InstallAnonymousTypeCache(cache)
            return
        }
        anonymousTypeCache = cache
    }

    /// Issue #3501 A2: gets the per-compile-pass synthesized ref-kind
    /// delegate cache (see (cref:SynthesizedRefDelegateCache)), walking
    /// to the root of this scope's chain so every scope in one bind pass
    /// shares the same cache instance — mirrors (cref:GetAnonymousTypeCache).
    /// @returns The shared (cref:SynthesizedRefDelegateCache) for this scope's chain.
    internal func GetSynthesizedRefDelegateCache() SynthesizedRefDelegateCache -> if SynthesisParent != nil {
        Parent!!.GetSynthesizedRefDelegateCache()
    } else {
        (
            if synthesizedRefDelegateCache == nil {
                (synthesizedRefDelegateCache = SynthesizedRefDelegateCache())
            } else {
                synthesizedRefDelegateCache
            }
        )!!
    }

    /// Issue #3501 A2: installs an existing ref-kind delegate cache on this
    /// chain's root — used by `BindProgram` to continue the global-scope
    /// pass's cache so shapes unify across the two binding passes.
    /// @param cache The cache to share.
    internal func InstallSynthesizedRefDelegateCache(cache SynthesizedRefDelegateCache) {
        if SynthesisParent != nil {
            Parent!!.InstallSynthesizedRefDelegateCache(cache)
            return
        }
        synthesizedRefDelegateCache = cache
    }

    /// Issue #3501 A2: gets the ambient declaring package name set by
    /// (cref:SetCurrentDeclaringPackage), used to place synthesized
    /// ref-kind delegates in the package whose declaration is being bound.
    /// @returns The ambient package name, or `null`.
    internal func GetCurrentDeclaringPackageName() string? -> if Parent != nil {
        Parent!!.GetCurrentDeclaringPackageName()
    } else {
        currentDeclaringPackageName.Value
    }

    /// Issue #2342: sets the package name of the top-level (or nested) type or
    /// function declaration whose body/initializers are CURRENTLY being bound,
    /// so (cref:TryLookupTypeAlias(string, int, out TypeSymbol)) can
    /// prefer that package's own type over a same-simple-name homonym declared
    /// in a different package. Stored at the root of this scope's chain
    /// (mirroring (cref:GetAnonymousTypeCache)) since one shared
    /// (cref:BoundScope) instance is used for the whole compilation.
    /// Pass `null` to clear (no ambient package preference —
    /// the pre-#2342 behavior). Returns the PREVIOUS value so a caller can
    /// restore it once the body finishes binding (nesting-safe: a top-level
    /// declaration's nested types/functions always share its own package, so
    /// they never need their own inner set/restore).
    /// @param packageName The package name to make ambient for lookup, or `null` to clear it.
    /// @returns The previous ambient package name.
    internal func SetCurrentDeclaringPackage(packageName string?) string? {
        if Parent != nil {
            return Parent!!.SetCurrentDeclaringPackage(packageName)
        }
        let previous = currentDeclaringPackageName.Value
        this.currentDeclaringPackageName.Value = packageName
        return previous
    }

    /// Issue #2456 (per-file import scoping / #2395 follow-up): sets the
    /// syntax tree (file) of the declaration whose type clauses, or member
    /// whose body, is CURRENTLY being bound, so
    /// (cref:TryResolveCollidingTypeAliasByImport(string, int, out TypeSymbol, out bool))
    /// and all other import-dependent lookup to imports declared in THIS file
    /// only — never a sibling file's import. Stored at the root of this
    /// scope's chain, exactly like (cref:currentDeclaringPackageName).
    /// The value is execution-context-local so concurrent binder operations
    /// sharing the same reconstructed scope cannot overwrite one another. Pass
    /// `null` to clear (falls back to the legacy
    /// order-dependent "first declared wins" behavior for that lookup,
    /// exactly as if this fix did not exist). Returns the PREVIOUS value so the caller can
    /// restore it once binding finishes.
    /// @param tree The syntax tree to make ambient for lookup, or `null` to clear it.
    /// @returns The previous ambient referencing syntax tree.
    internal func SetCurrentReferencingSyntaxTree(tree SyntaxTree?) SyntaxTree? {
        if Parent != nil {
            return Parent!!.SetCurrentReferencingSyntaxTree(tree)
        }
        let previous = currentReferencingSyntaxTree.Value
        this.currentReferencingSyntaxTree.Value = tree
        return previous
    }

    internal func GetCurrentReferencingSyntaxTreeForCache() SyntaxTree? -> GetCurrentReferencingSyntaxTree()

    /// Gets the per-compile-pass map from a "rich" anonymous-object literal
    /// (one carrying a base/interface clause, methods, or events — ADR-0146 /
    /// issue #2243) to its desugared, compiler-synthesized backing
    /// (cref:StructSymbol) (a class). Walks to the root of this scope's
    /// chain so the desugaring pass (which populates it) and the literal-site
    /// binder (which consumes it) share one instance.
    /// @returns The shared rich-anonymous-object map for this scope's chain.
    internal func GetRichAnonymousClassMap() Dictionary[
        AnonymousClassExpressionSyntax,
        StructSymbol
    ] -> if SynthesisParent != nil {
        Parent!!.GetRichAnonymousClassMap()
    } else {
        (
            if richAnonymousClassMap == nil {
                (richAnonymousClassMap = Dictionary[AnonymousClassExpressionSyntax, StructSymbol]())
            } else {
                richAnonymousClassMap
            }
        )!!
    }

    internal func GetRichAnonymousObjectPlans() Dictionary[
        RichAnonymousObjectBindingKey,
        RichAnonymousObjectPlan
    ] -> if SynthesisParent != nil {
        Parent!!.GetRichAnonymousObjectPlans()
    } else {
        (
            if richAnonymousObjectPlans == nil {
                (richAnonymousObjectPlans = Dictionary[RichAnonymousObjectBindingKey, RichAnonymousObjectPlan]())
            } else {
                richAnonymousObjectPlans
            }
        )!!
    }

    internal func GetLatestRichAnonymousObjectPlans() Dictionary[
        StructSymbol,
        RichAnonymousObjectPlan
    ] -> if SynthesisParent != nil {
        Parent!!.GetLatestRichAnonymousObjectPlans()
    } else {
        (
            if latestRichAnonymousObjectPlans == nil {
                (latestRichAnonymousObjectPlans = Dictionary[StructSymbol, RichAnonymousObjectPlan]())
            } else {
                latestRichAnonymousObjectPlans
            }
        )!!
    }

    internal func GetStructuralAdapterRegistry() StructuralAdapterRegistry -> if SynthesisParent != nil {
        Parent!!.GetStructuralAdapterRegistry()
    } else {
        (
            if structuralAdapterRegistry == nil {
                (structuralAdapterRegistry = StructuralAdapterRegistry())
            } else {
                structuralAdapterRegistry
            }
        )!!
    }

    /// Issues #4089/#4090: gets the queue of G#-declared generic TYPE-CLAUSE
    /// constraint checks recorded while the DECLARATION phase runs, shared
    /// across every binder in the chain. See
    /// `Binder.CheckUserGenericTypeClauseConstraints` for why the check
    /// cannot be answered at the construction site.
    /// @returns The shared pending-check queue for this scope's chain.
    internal func GetPendingUserGenericConstraintChecks() List[
        Binder.PendingUserGenericConstraintCheck
    ] -> if SynthesisParent != nil {
        Parent!!.GetPendingUserGenericConstraintChecks()
    } else {
        (
            if pendingUserGenericConstraintChecks == nil {
                (pendingUserGenericConstraintChecks = List[Binder.PendingUserGenericConstraintCheck]())
            } else {
                pendingUserGenericConstraintChecks
            }
        )!!
    }

    /// Issues #4089/#4090: whether a G#-declared generic type-clause constraint
    /// check must be QUEUED rather than answered where it is written, because
    /// same-compilation declarations may not have their type-parameter
    /// constraints resolved yet.
    /// @remarks Defaults to `false` — answer in place — and is set only
    /// for the DECLARATION phase's own scope chain, by `BindGlobalScope`.
    /// The default direction is load-bearing: `BindProgram` derives a
    /// FRESH scope chain (`CreateParentScope`) for member bodies, so a
    /// body binder never sees this flag, and a queue it could never flush would
    /// silently drop the check. Answering in place is exactly what those
    /// binders did before, and by then every constraint is resolved anyway.
    /// @returns `true` while the declaration phase is queuing.
    internal func IsDeferringUserGenericConstraintChecks() bool -> if Parent != nil {
        Parent!!.IsDeferringUserGenericConstraintChecks()
    } else {
        deferUserGenericConstraintChecks
    }

    /// Issues #4089/#4090: turns the queuing described by
    /// (cref:IsDeferringUserGenericConstraintChecks) on or off for this
    /// scope's whole chain.
    /// @param value Whether checks must be queued.
    internal func SetDeferUserGenericConstraintChecks(value bool) {
        if SynthesisParent != nil {
            Parent!!.SetDeferUserGenericConstraintChecks(value)
        } else {
            deferUserGenericConstraintChecks = value
        }
    }

    /// Sets a scope-wide preferred package for type alias lookup.
    /// Qualified constructions instead resolve their complete identities in
    /// (cref:ExpressionBinder.TryBindQualifiedSourceTypeConstruction).
    /// (cref:TryLookupTypeAlias(string, int, out TypeSymbol, out bool))
    /// consults this before the declaring-package preference and import ambiguity checks.
    /// Pass `null` to clear it. Restore the returned previous value after lookup.
    /// The root scope stores the preference, like
    /// (cref:currentDeclaringPackageName).
    /// @param packageName The explicitly-qualified package name to make ambient for lookup, or `null` to
    /// clear it.
    /// @returns The previous ambient qualified-construction package hint.
    internal func SetQualifiedConstructionPackageHint(packageName string?) string? {
        if Parent != nil {
            return Parent!!.SetQualifiedConstructionPackageHint(packageName)
        }
        let previous = qualifiedConstructionPackageHint.Value
        this.qualifiedConstructionPackageHint.Value = packageName
        return previous
    }

    private func ApplyEnclosingConstruction(nestedType TypeSymbol, declaringContainer StructSymbol) TypeSymbol {
        let enclosingArguments = FlattenConstructedTypeArguments(declaringContainer)
        if enclosingArguments.IsDefaultOrEmpty {
            return nestedType
        }
        return switch nestedType {
            case nestedStruct is StructSymbol: cast[TypeSymbol](
                StructSymbol.ConstructNested(
                    nestedStruct.Definition ?? nestedStruct,
                    enclosingArguments,
                    References!!.MapClrTypeToReferences
                )!!
            )
            case nestedEnum is EnumSymbol: cast[TypeSymbol](
                EnumSymbol.ConstructNested(nestedEnum.Definition ?? nestedEnum, enclosingArguments)!!
            )
            default: nestedType
        }
    }

    /// Issue #2342: gets the ambient "current declaring package" set by
    /// (cref:SetCurrentDeclaringPackage), or `null` when
    /// none is set.
    private func GetCurrentDeclaringPackage() string? -> if Parent != nil {
        Parent!!.GetCurrentDeclaringPackage()
    } else {
        currentDeclaringPackageName.Value
    }

    /// Issue #2456: gets the ambient "current referencing syntax tree" set by
    /// (cref:SetCurrentReferencingSyntaxTree), or `null`
    /// when none is set (no per-file import restriction available; the
    /// import-based disambiguation this fix adds simply does not fire).
    private func GetCurrentReferencingSyntaxTree() SyntaxTree? -> if Parent != nil {
        Parent!!.GetCurrentReferencingSyntaxTree()
    } else {
        currentReferencingSyntaxTree.Value
    }

    /// Issue #2455: gets the ambient qualified-construction package hint set
    /// by (cref:SetQualifiedConstructionPackageHint), or
    /// `null` when none is set.
    private func GetQualifiedConstructionPackageHint() string? -> if Parent != nil {
        Parent!!.GetQualifiedConstructionPackageHint()
    } else {
        qualifiedConstructionPackageHint.Value
    }

    /// Resolves an explicit CLR type alias by requested arity. Non-positive
    /// arities only accept a non-generic target.
    /// @param name The visible alias name.
    /// @param preferredArity The requested generic arity.
    /// @param type The resolved CLR type.
    /// @returns Whether the alias targets a type of the requested arity.
    private func TryResolveImportedTypeAlias(
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type Type?
    ) bool {
        type = nil
        if !TryLookupImport(name, out var import_) || !import_!!.IsAlias {
            return false
        }
        let target = if preferredArity > 0 {
            import_!!.Target + "`" + preferredArity.ToString()
        } else {
            import_!!.Target
        }
        return References!!.TryResolveType(target, out type) && (preferredArity > 0 || !type!!.IsGenericTypeDefinition)
    }

    /// Issue #2455: tries to resolve ([`name`](paramref), [`arity`](paramref))
    /// against the SPECIFIC package named by an explicit qualification hint
    /// (see (cref:SetQualifiedConstructionPackageHint)) — first via that
    /// package's dedicated package-qualified fallback key (the "losing"
    /// declaration of a same-simple-name collision, per
    /// (cref:TryDeclareTypeAlias(string, TypeSymbol, string))), then, if
    /// that misses, by checking whether the CURRENT plain-key "winner" is
    /// itself declared by the hinted package (a same-simple-name collision's
    /// winner has no package-qualified key of its own, only the plain one).
    /// @param name The simple type name.
    /// @param arity The generic arity (0 for a non-generic lookup).
    /// @param hintPackage The explicitly-qualified package name.
    /// @param type The type declared by exactly that package, when found.
    /// @returns Whether a type declared by the hinted package was found.
    private func TryResolveTypeAliasByExplicitPackageHint(
        name string,
        arity int32,
        hintPackage string,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        type = nil
        let qualifiedKey = MangleArity(PackageQualifiedName(hintPackage, name), arity)
        if TryGetTypeAliasInChain(qualifiedKey, out type) {
            return true
        }
        let plainKey = MangleArity(name, arity)
        if TryGetTypeAliasInChain(plainKey, out var plainValue) {
            let plainPackage = if TryGetAliasDeclaringPackageInChain(plainKey, out var overridePackage) {
                overridePackage!!
            } else {
                TypePackageName(plainValue)
            }
            if plainPackage == hintPackage {
                type = plainValue
                return true
            }
        }
        type = nil
        return false
    }

    /// Adds a brand-new type-alias key, not previously visible anywhere in the
    /// scope chain. Records the key in this scope's own (cref:typeAliasKeys)
    /// so its declaration-order position (root-first across the chain) is fixed
    /// the first time it is introduced.
    private func AddTypeAlias(key string, target TypeSymbol) {
        typeAliases = (typeAliases ?? ImmutableDictionary[string, TypeSymbol].Empty).Add(key, target)
        typeAliasKeys ??= ImmutableArray.CreateBuilder[string]()
        typeAliasKeys!!.Add(key)
        IndexTypeAlias(key, target)
    }

    /// Overrides the value of a type-alias key that already exists somewhere in
    /// the scope chain (the eviction/promotion case in (cref:TryDeclareTypeAlias(string, TypeSymbol,
    /// string))).
    /// Only overwrites the value at this scope; it does not move the key's
    /// declaration-order position (which was fixed when the key was first
    /// introduced by (cref:AddTypeAlias)) and does not mutate the
    /// ancestor scope that originally owns the key.
    private func SetTypeAliasOverride(key string, target TypeSymbol) {
        typeAliases = (typeAliases ?? ImmutableDictionary[string, TypeSymbol].Empty).SetItem(key, target)
        IndexTypeAlias(key, target)
    }

    private func IndexTypeAlias(key string, target TypeSymbol) {
        let separator = key.IndexOf('#')
        let nameWithArity = key.Substring(separator + 1)
        let aritySeparator = nameWithArity.LastIndexOf('`')
        let name = if aritySeparator < 0 {
            nameWithArity
        } else {
            nameWithArity.Substring(0, aritySeparator)
        }
        let byName = if aliasCandidates.TryGetValue(name, out var names) {
            names
        } else {
            ImmutableDictionary[string, TypeSymbol].Empty
        }
        aliasCandidates = aliasCandidates.SetItem(name, byName.SetItem(key, target))
        let byArity = if aliasCandidatesByArity.TryGetValue(nameWithArity, out var arities) {
            arities
        } else {
            ImmutableDictionary[string, TypeSymbol].Empty
        }
        aliasCandidatesByArity = aliasCandidatesByArity.SetItem(nameWithArity, byArity.SetItem(key, target))
        if TypeContainingType(target) is {} owner {
            let nestedKey = (TypeDefinition(owner), name.Substring(name.LastIndexOf('.') + 1))
            let nested = if nestedAliasCandidates.TryGetValue(nestedKey, out var existing) {
                existing
            } else {
                ImmutableDictionary[string, TypeSymbol].Empty
            }
            nestedAliasCandidates = nestedAliasCandidates.SetItem(nestedKey, nested.SetItem(key, target))
        }
    }

    private func EnumerateNestedTypeAliasCandidates(owner TypeSymbol, name string) sequence[
        KeyValuePair[string, TypeSymbol]
    ] {
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.nestedAliasCandidates.TryGetValue((owner, name), out var bucket) {
                for pair in bucket {
                    CompilationMeasurements.Count("alias.nested-candidate-visits")
                    if TryGetTypeAliasInChain(pair.Key, out var visible) && object.ReferenceEquals(
                        visible,
                        pair.Value
                    ) {
                        yield pair
                    }
                }
            }
            scope_ = scope_.Parent
        }
    }

    /// Captures immutable candidate buckets with nearest-scope key shadowing.
    /// Symbols retain their canonical identity. This does not freeze symbol bodies or synthesis state.
    func CaptureTypeAliasIndex() ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]] {
        var result = Parent?.CaptureTypeAliasIndex() ??
            ImmutableDictionary[string, ImmutableDictionary[string, TypeSymbol]].Empty
        for bucket in aliasCandidates {
            var merged = if result.TryGetValue(bucket.Key, out var inherited) {
                inherited
            } else {
                ImmutableDictionary[string, TypeSymbol].Empty
            }
            for pair in bucket.Value {
                merged = merged.SetItem(pair.Key, pair.Value)
            }
            result = result.SetItem(bucket.Key, merged)
        }
        return result
    }

    /// Captures nested candidates by canonical owner identity and source name after the declaration barrier.
    func CaptureNestedTypeAliasIndex() ImmutableDictionary[
        (Owner TypeSymbol, Name string),
        ImmutableDictionary[string, TypeSymbol]
    ] {
        var result = ImmutableDictionary[(Owner TypeSymbol, Name string), ImmutableDictionary[string, TypeSymbol]].Empty
        var scope_ BoundScope? = this
        while scope_ != nil {
            for bucket in scope_.nestedAliasCandidates {
                var merged = if result.TryGetValue(bucket.Key, out var existing) {
                    existing
                } else {
                    ImmutableDictionary[string, TypeSymbol].Empty
                }
                for pair in bucket.Value {
                    if TryGetTypeAliasInChain(pair.Key, out var visible) && object.ReferenceEquals(
                        visible,
                        pair.Value
                    ) {
                        merged = merged.SetItem(pair.Key, pair.Value)
                    }
                }
                result = result.SetItem(bucket.Key, merged)
            }
            scope_ = scope_.Parent
        }
        return result
    }

    private func EnumerateTypeAliasCandidates(name string, exactArity bool) sequence[KeyValuePair[string, TypeSymbol]] {
        var seen HashSet[string]? = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            let index = if exactArity {
                scope_.aliasCandidatesByArity
            } else {
                scope_.aliasCandidates
            }
            if index.TryGetValue(name, out var bucket) {
                seen ??= HashSet[string](StringComparer.Ordinal)
                for pair in bucket {
                    CompilationMeasurements.Count("alias.candidate-visits")
                    if seen!!.Add(pair.Key) {
                        yield pair
                    }
                }
            }
            scope_ = scope_.Parent
        }
    }

    /// Issue #2342 follow-up: records that the type-alias entry stored under
    /// [`key`](paramref) was declared by [`declaringPackageName`](paramref)
    /// (a plain `type Name = Target` alias — see
    /// (cref:TryDeclareTypeAlias(string, TypeSymbol, string))). A no-op
    /// when [`declaringPackageName`](paramref) is `null`
    /// (the caller is declaring a real symbol, not a plain alias).
    private func RegisterAliasDeclaringPackage(key string, declaringPackageName string?) {
        if declaringPackageName == nil {
            return
        }
        aliasDeclaringPackages ??= ImmutableDictionary.CreateBuilder[string, string]()
        aliasDeclaringPackages!![key] = declaringPackageName
    }

    /// Issue #2342 follow-up: looks up the recorded alias-declaring-package
    /// override for [`key`](paramref) (see (cref:RegisterAliasDeclaringPackage)),
    /// walking the Parent chain the same way (cref:TryGetTypeAliasInChain)
    /// does. Returns `false` when the entry at [`key`](paramref)
    /// is a real symbol (no override was ever registered for it) rather than a
    /// plain alias.
    private func TryGetAliasDeclaringPackageInChain(
        key string,
        @NotNullWhen(true) out declaringPackageName string?
    ) bool {
        declaringPackageName = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.aliasDeclaringPackages != nil && scope_.aliasDeclaringPackages!!.TryGetValue(
                key,
                out var foundPackage
            ) {
                declaringPackageName = foundPackage
                return true
            }
            scope_ = scope_.Parent
        }
        return false
    }

    /// Whether [`key`](paramref) is visible anywhere in this scope chain.
    private func TypeAliasVisible(key string) bool {
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.typeAliases != nil && scope_.typeAliases!!.ContainsKey(key) {
                return true
            }
            scope_ = scope_.Parent
        }
        return false
    }

    /// Looks up [`key`](paramref) from this scope outward through the
    /// Parent chain, so a nearer (child) scope's value shadows a farther
    /// (ancestor) scope's value for the same key.
    private func TryGetTypeAliasInChain(key string, @NotNullWhen(true) out value TypeSymbol?) bool {
        value = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.typeAliases != nil && scope_.typeAliases!!.TryGetValue(key, out var foundValue) {
                value = foundValue
                return true
            }
            scope_ = scope_.Parent
        }
        return false
    }

    /// Enumerates every (key, value) pair visible from this scope, nearest
    /// scope first, yielding each key only once (the nearest-scope value wins,
    /// matching (cref:TryGetTypeAliasInChain)).
    private func EnumerateTypeAliasesInChain() sequence[KeyValuePair[string, TypeSymbol]] {
        let seen = HashSet[string]()
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.typeAliases != nil {
                for pair in scope_.typeAliases!! {
                    if seen.Add(pair.Key) {
                        yield pair
                    }
                }
            }
            scope_ = scope_.Parent
        }
    }

    /// Issue #2455 (per-file-scoped since #2456's follow-up hardening):
    /// implements the same-file-import disambiguation described on
    /// (cref:TryLookupTypeAlias(string, int, out TypeSymbol, out bool)).
    /// Collects every package that stores a top-level type under the
    /// ([`name`](paramref), [`arity`](paramref)) key — both the
    /// plain-key "winner" and every package-qualified fallback entry (see
    /// (cref:PackageQualifiedName)) — then intersects that set against
    /// every package named by an `import` declaration that is either
    /// compiler-synthesized (implicit — visible everywhere) or declared in
    /// the SAME file as the reference currently being resolved (see
    /// (cref:GetCurrentReferencingSyntaxTree)). An import declared in
    /// any OTHER file is never consulted. Returns
    /// `false` with [`type`](paramref) null and
    /// [`ambiguous`](paramref) false when this name has no genuine
    /// cross-package collision at all (the ordinary plain-key fallback should
    /// run unmodified), when it collides but no SAME-FILE import disambiguates
    /// it, or when no referencing-file context is ambiently available
    /// (preserves the pre-#2455 "first declared wins" behavior exactly).
    /// @param name The simple type name.
    /// @param arity The generic arity (0 for a non-generic lookup).
    /// @param type The single imported-package-matched type, when unambiguous.
    /// @param ambiguous Whether two or more colliding packages are each imported.
    /// @returns Whether a single import-disambiguated type was found.
    private func TryResolveCollidingTypeAliasByImport(
        name string,
        arity int32,
        @NotNullWhen(true) out type TypeSymbol?,
        out ambiguous bool
    ) bool {
        type = nil
        ambiguous = false
        let suffix = "#" + MangleArity(name, arity)
        var byPackage Dictionary[string, TypeSymbol]? = nil
        for pair in EnumerateTypeAliasCandidates(MangleArity(name, arity), exactArity: true) {
            let key = pair.Key
            if key.Length <= suffix.Length || !key.EndsWith(suffix, StringComparison.Ordinal) || key.IndexOf(
                '#'
            ) != key.Length - suffix.Length {
                continue
            }
            let package_ = key.Substring(0, key.Length - suffix.Length)
            byPackage ??= Dictionary[string, TypeSymbol](StringComparer.Ordinal)
            byPackage!![package_] = pair.Value
        }
        if byPackage == nil {
            return false
        }
        // Fold in the plain-key winner's own package too: it is just as much a
        // genuine colliding declaration as the package-qualified "losers", and
        // omitting it would make a plain two-package collision look like it
        // only ever has one candidate package.
        let plainKey = MangleArity(name, arity)
        if TryGetTypeAliasInChain(plainKey, out var plainValue) {
            let plainPackage string? = if TryGetAliasDeclaringPackageInChain(plainKey, out var overridePackage) {
                overridePackage
            } else {
                TypePackageName(plainValue)
            }
            if plainPackage != nil {
                byPackage[plainPackage] = plainValue!!
            }
        }
        if byPackage == nil || byPackage.Count < 2 {
            // No genuine cross-package collision under this (name, arity) at
            // all — nothing for this helper to do.
            return false
        }
        // Issue #2456 (per-file import scoping / #2395 follow-up): only
        // imports declared in the SAME file as the reference being resolved
        // (plus compiler-synthesized implicit imports, which apply
        // everywhere) may disambiguate it. EnumerateImports already enforces
        // this boundary; the explicit declaration check remains defensive
        // for imports rehydrated from incremental scopes. When
        // the ambient referencing tree is unset (null — no per-file context
        // available at this call site), no import can disambiguate here.
        let referencingTree SyntaxTree? = GetCurrentReferencingSyntaxTree()
        if referencingTree == nil {
            return false
        }
        var matched TypeSymbol? = nil
        for import_ in GetDeclaredImports() {
            if import_.Target == nil || !byPackage.TryGetValue(import_.Target, out var candidate) {
                continue
            }
            let declaration = import_.Declaration
            if declaration != nil && declaration.SyntaxTree != referencingTree {
                // Declared in a different file than the reference.
                continue
            }
            if matched == nil {
                matched = candidate
            } else if !object.ReferenceEquals(matched, candidate) {
                ambiguous = true
            }
        }
        if ambiguous {
            type = nil
            return false
        }
        if matched != nil {
            type = matched
            return true
        }
        return false
    }

    /// Issue #2342 follow-up: collects every function stored under the exact
    /// storage [`key`](paramref) across this scope's Parent chain (the
    /// same walking behavior (cref:TryLookupFunctions) always used,
    /// factored out so it can be tried against either a package-qualified key
    /// or the plain simple-name key).
    /// @param key The exact function-table storage key.
    /// @returns The overload set stored under [`key`](paramref), or empty.
    private func CollectFunctionBucket(key string) ImmutableArray[FunctionSymbol] {
        var builder ImmutableArray[FunctionSymbol].Builder? = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.functions != nil && scope_.functions!!.TryGetValue(key, out var bucket) && bucket.Count > 0 {
                builder ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
                builder!!.AddRange(bucket)
            }
            scope_ = scope_.Parent
        }
        return if builder == nil {
            ImmutableArray[FunctionSymbol].Empty
        } else {
            builder.ToImmutable()
        }
    }

    /// Issue #2342 follow-up: runs the exact-match / generic-receiver-
    /// unification / implicit-conversion (subtype) three-phase extension
    /// match documented on (cref:TryLookupExtensionFunction) against a
    /// single already-resolved bucket, factored out so the same matching
    /// logic can be tried against either a package-qualified bucket or the
    /// plain simple-name bucket without duplicating the phases.
    /// @param bucket The extension-function bucket to search.
    /// @param receiverType The static type of the call receiver.
    /// @param function The matching extension function, when found.
    /// @returns True when an extension function in [`bucket`](paramref) matches.
    private func TryFindExtensionInBucket(
        bucket ImmutableArray[FunctionSymbol].Builder,
        receiverType TypeSymbol,
        @NotNullWhen(true) out function FunctionSymbol?
    ) bool {
        function = nil
        for ext in bucket {
            if ReceiverMatches(ext.ExtensionReceiverType, receiverType) {
                function = ext
                return true
            }
        }
        // Issue #773 / ADR-0084 §L2 follow-up: an extension whose receiver
        // type carries one of the function's own type parameters (e.g.
        // `(self sequence[T])`, `(self IEnumerable[T])`, `(self T?)`,
        // `(self Dictionary[K, V])`) is never reference-equal to a concrete
        // call-site receiver. Fall back to receiver inference: try to unify
        // the declared open receiver with the call-site type and accept the
        // candidate when every type parameter that appears in the receiver
        // gets bound.
        //
        // ADR-0097 / issue #775: when multiple candidates unify against the
        // same receiver type (e.g. one carrying `[T class]` and one carrying
        // `[T struct]`), the constraint check decides the winner. We collect
        // every unifiable candidate, drop those whose constraints are
        // violated by the inferred substitution, and prefer the most
        // specific (struct > class > unconstrained) surviving candidate.
        // Mutually-incomparable cases fall through to the first declared
        // candidate so the call site is not silently ambiguous (the existing
        // GS0160 will surface from the call-binding path if applicable).
        var candidate FunctionSymbol? = nil
        var candidateSpecificity = -1
        for ext in bucket {
            if ext.TypeParameters.IsDefaultOrEmpty {
                continue
            }
            if ext.ExtensionReceiverType == nil || ext.ExtensionReceiverType == TypeSymbol.Error {
                continue
            }
            if !ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters) {
                continue
            }
            if !TryUnifyAndCheckConstraints(ext, receiverType, out var specificity) {
                continue
            }
            if candidate == nil || specificity > candidateSpecificity {
                candidate = ext
                candidateSpecificity = specificity
            }
        }
        if candidate != nil {
            function = candidate
            return true
        }
        // Issue #1548: no exact and no generic-unification match in this
        // bucket. Broaden to implicitly-convertible (subtype) receivers: a
        // declared receiver `R` is applicable when the call-site receiver `S`
        // is implicitly convertible to `R` (identity/implicit-reference/
        // boxing). Among applicable candidates pick the MOST specific
        // (most-derived) declared receiver so this singular path stays
        // deterministic (e.g. `string` beats `object`); ties fall back to
        // declaration order.
        var subtypeCandidate FunctionSymbol? = nil
        var subtypeSpecificity = -1
        for ext in bucket {
            if !ext
                .TypeParameters
                .IsDefaultOrEmpty &&
                ext.ExtensionReceiverType != nil &&
                ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters) {
                // Open receivers are handled by the unification pass above.
                continue
            }
            if !ReceiverConvertible(ext.ExtensionReceiverType, receiverType) {
                continue
            }
            let specificity = ReceiverConvertibilitySpecificity(bucket, ext.ExtensionReceiverType)
            if subtypeCandidate == nil || specificity > subtypeSpecificity {
                subtypeCandidate = ext
                subtypeSpecificity = specificity
            }
        }
        if subtypeCandidate != nil {
            function = subtypeCandidate
            return true
        }
        return false
    }

    /// Issue #2342 follow-up: collects every extension-function overload
    /// stored under the exact storage [`key`](paramref) across this
    /// scope's Parent chain that matches [`receiverType`](paramref) (the
    /// same walking behavior (cref:TryLookupExtensionFunctions) always
    /// used, factored out so it can be tried against either a
    /// package-qualified key or the plain simple-name key). Honours the same
    /// three dispatch phases as (cref:TryFindExtensionInBucket) —
    /// exact-match, generic-receiver unification (issue #773/#775), and
    /// implicit-conversion (subtype) broadening (issue #1548) — but collects
    /// every applicable candidate instead of stopping at the first.
    /// @param key The exact extension-function table storage key.
    /// @param receiverType The static type of the call receiver.
    /// @returns The matching extension overloads, or an empty array when none match.
    private func CollectExtensionFunctionMatches(key string, receiverType TypeSymbol) ImmutableArray[FunctionSymbol] {
        var builder ImmutableArray[FunctionSymbol].Builder? = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.extensionFunctionsByName != nil && scope_.extensionFunctionsByName!!.TryGetValue(
                key,
                out var bucket
            ) {
                for ext in bucket {
                    var matches = ReceiverMatches(ext.ExtensionReceiverType, receiverType)
                    if !matches &&
                        !ext
                        .TypeParameters
                        .IsDefaultOrEmpty &&
                        ext.ExtensionReceiverType != nil &&
                        ext.ExtensionReceiverType != TypeSymbol.Error &&
                        ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters) &&
                        TryUnifyAndCheckConstraints(ext, receiverType, out _) {
                        matches = true
                    }
                    // Issue #1548: broaden to implicitly-convertible (subtype)
                    // receivers with a CONCRETE declared receiver type. Open
                    // receivers (those mentioning the function's own type
                    // parameters) are handled by the unification pass above; a
                    // concrete `R` is applicable whenever the call-site receiver is
                    // implicitly convertible to it. Every applicable candidate is
                    // collected so the caller's overload resolution — which scores
                    // the receiver as parameter 0 — picks the most specific one.
                    if !matches &&
                        (
                        ext
                            .TypeParameters
                            .IsDefaultOrEmpty ||
                            ext.ExtensionReceiverType == nil ||
                            !ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters)
                    ) &&
                        ReceiverConvertible(ext.ExtensionReceiverType, receiverType) {
                        matches = true
                    }
                    if matches {
                        builder ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
                        builder!!.Add(ext)
                    }
                }
            }
            scope_ = scope_.Parent
        }
        return if builder == nil {
            ImmutableArray[FunctionSymbol].Empty
        } else {
            builder.ToImmutable()
        }
    }

    /// Issue #2414: collects every extension-function overload visible from
    /// this scope's Parent chain that is stored under a package-qualified key
    /// for [`name`](paramref) OTHER than [`excludeKey`](paramref) (the
    /// caller's own package-qualified key, already tried) and matches
    /// [`receiverType`](paramref). A package-qualified bucket (storage
    /// key `"{package}#{name}"` — see (cref:PackageQualifiedName))
    /// is created only when two or more packages declare a same-simple-name
    /// extension (see (cref:TryDeclareExtensionFunction)); before this
    /// fallback existed, a package that neither owned the plain bucket nor
    /// had its own qualified bucket for that name could never see any other
    /// package's colliding overloads, silently breaking the documented
    /// "extensions are broadly visible; packages are not import boundaries"
    /// contract (e.g. a same-named extension declared by a consuming
    /// project's own package shadowed every sibling package's extension of
    /// the same name for every OTHER caller).
    /// @param name The method name at the call site.
    /// @param excludeKey The caller's own package-qualified key, already probed by the caller; skipped
    /// here.
    /// @param receiverType The static type of the call receiver.
    /// @returns The matching extension overloads from other packages' qualified buckets, or an empty array
    /// when none match.
    private func CollectExtensionFunctionMatchesFromOtherPackages(
        name string,
        excludeKey string?,
        receiverType TypeSymbol
    ) ImmutableArray[FunctionSymbol] {
        let suffix = "#" + name
        var otherKeys HashSet[string]? = nil
        var scope_ BoundScope? = this
        while scope_ != nil {
            if scope_.extensionFunctionsByName != nil {
                for key in scope_.extensionFunctionsByName!!.Keys {
                    if string.Equals(key, excludeKey, StringComparison.Ordinal) || !key.EndsWith(
                        suffix,
                        StringComparison.Ordinal
                    ) {
                        continue
                    }
                    otherKeys ??= HashSet[string](StringComparer.Ordinal)
                    otherKeys!!.Add(key)
                }
            }
            scope_ = scope_.Parent
        }
        if otherKeys == nil {
            return ImmutableArray[FunctionSymbol].Empty
        }
        var combined ImmutableArray[FunctionSymbol].Builder? = nil
        for key in otherKeys {
            let matches = CollectExtensionFunctionMatches(key, receiverType)
            if matches.IsDefaultOrEmpty {
                continue
            }
            combined ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
            combined!!.AddRange(matches)
        }
        return combined?.ToImmutable() ?? ImmutableArray[FunctionSymbol].Empty
    }

    /// Builds the full set of type aliases visible from this scope, ordered the
    /// way the old eager parent-to-child copy produced them: each key keeps the
    /// position it had when FIRST introduced (root-most scope first), while its
    /// value reflects the nearest (most specific) scope that declared or
    /// overrode it.
    private func GetOrderedTypeAliases() ImmutableArray[KeyValuePair[string, TypeSymbol]] {
        let parentAliases = Parent?.GetOrderedTypeAliases() ?? ImmutableArray[KeyValuePair[string, TypeSymbol]].Empty
        if typeAliases is not{} ownAliases {
            return parentAliases
        }
        if AliasDerivedSnapshot[ImmutableArray[KeyValuePair[string, TypeSymbol]]].TryGet(
            &orderedTypeAliasSnapshot,
            ownAliases,
            parentAliases,
            out var published
        ) {
            return published
        }
        return AliasDerivedSnapshot[ImmutableArray[KeyValuePair[string, TypeSymbol]]].Publish(
            &orderedTypeAliasSnapshot,
            ownAliases,
            parentAliases,
            "scope.ordered-type-aliases",
            BuildOrderedTypeAliases(parentAliases, ownAliases)
        )
    }

    private func BuildOrderedTypeAliases(
        parentAliases ImmutableArray[KeyValuePair[string, TypeSymbol]],
        ownAliases ImmutableDictionary[string, TypeSymbol]
    ) ImmutableArray[KeyValuePair[string, TypeSymbol]] {
        // ADR-0203: readers share canonical declarations until this scope or an ancestor changes its aliases.
        let merged = Dictionary[string, TypeSymbol]()
        let order = List[string]()
        for pair in parentAliases {
            merged.Add(pair.Key, pair.Value)
            order.Add(pair.Key)
        }
        if typeAliasKeys != nil {
            for key in typeAliasKeys!! {
                if !merged.ContainsKey(key) {
                    order.Add(key)
                }
            }
        }
        for pair in ownAliases {
            merged[pair.Key] = pair.Value
        }
        let result = ImmutableArray.CreateBuilder[KeyValuePair[string, TypeSymbol]](order.Count)
        for key in order {
            result.Add(KeyValuePair[string, TypeSymbol](key, merged[key]))
        }
        return result.MoveToImmutable()
    }

    private func GetDeclaredTypeSymbols[TSymbol TypeSymbol]() ImmutableArray[TSymbol] ->
    GetDeclaredTypeSymbols[TSymbol](GetOrderedTypeAliases())

    private func GetDeclaredTypeSymbols[TSymbol TypeSymbol](
        aliases ImmutableArray[KeyValuePair[string, TypeSymbol]]
    ) ImmutableArray[TSymbol] {
        let builder = ImmutableArray.CreateBuilder[TSymbol]()
        for pair in aliases {
            if pair.Value is TSymbol typed {
                builder.Add(typed)
            }
        }
        return builder.ToImmutable()
    }

    /// Issue #1080 / #2342: two type declarations share a declaration scope —
    /// and are therefore a genuine GS0102 duplicate on a simple-name clash —
    /// when both are nested directly in the SAME enclosing type, or both are
    /// top-level (no enclosing type) AND declared in the SAME package. Two
    /// top-level declarations of the same simple name in DIFFERENT packages no
    /// longer share a scope: package identity, not one flat compilation-wide
    /// table, decides top-level uniqueness. Package identity for the
    /// already-stored [`existing`](paramref) value prefers a registered
    /// alias-declaring-package override at [`key`](paramref) (see
    /// (cref:TryGetAliasDeclaringPackageInChain)) over the best-effort
    /// (cref:TypePackageName) inference from the value itself; package
    /// identity for the incoming [`target`](paramref) prefers the caller-
    /// supplied [`targetDeclaringPackageOverride`](paramref) the same way.
    /// This is what gives a plain `type Name = Target` alias a stable
    /// declaring-package identity independent of whatever package (if any) its
    /// target happens to belong to.
    private func IsSameDeclarationScope(
        existing TypeSymbol?,
        target TypeSymbol,
        key string,
        targetDeclaringPackageOverride string?
    ) bool {
        let existingEnclosing TypeSymbol? = TypeContainingType(existing)
        let targetEnclosing TypeSymbol? = TypeContainingType(target)
        if existingEnclosing == nil && targetEnclosing == nil {
            let existingPackage = if TryGetAliasDeclaringPackageInChain(key, out var existingOverride) {
                existingOverride!!
            } else {
                TypePackageName(existing)
            }
            let targetPackage = targetDeclaringPackageOverride ?? TypePackageName(target)
            return string.Equals(existingPackage, targetPackage, StringComparison.Ordinal)
        }
        return object.ReferenceEquals(existingEnclosing, targetEnclosing)
    }

    /// Enumerates every import visible from the currently referencing syntax
    /// tree: ancestor scopes' imports first (outermost first), then this
    /// scope's own. Compiler-synthesized imports are visible everywhere.
    ///
    /// Issue #3734: scans the imports visible from the referencing file for a
    /// CLR type named [`lookupName`](paramref) (already arity-mangled for
    /// generic lookups), preserving the historical FIRST-IMPORT-WINS answer
    /// while detecting whether two or more EXPLICITLY WRITTEN, non-alias
    /// imports each resolve a DIFFERENT type under that name.
    ///
    /// Compiler-synthesized imports (the implicit `System` and, since
    /// ADR-0174, `Gsharp.Concurrency`) and alias imports never make a name
    /// ambiguous: the first applies to every file and cannot be removed by the
    /// author, and the second already names its target explicitly. Two imports
    /// whose targets resolve to the SAME (cref:System.Type) are not a
    /// collision either — the choice does not matter.
    ///
    /// An implicit import is also a FALLBACK for resolution, not a competitor:
    /// it contributes a type only when no explicitly written import resolves
    /// the name. A namespace the author never asked for must not shadow one
    /// they did. `Gsharp.Concurrency.Context` is why this matters —
    /// `Context` is an ordinary name for a user type (an EF DbContext, an
    /// HTTP context, a parser context), and before this an implicit import
    /// carrying one both won first-import-wins and made the author's own
    /// `Context` ambiguous.
    /// @param lookupName The type name to append to each import target (mangled for generics).
    /// @param requireNonGenericDefinition Whether an open generic definition must be skipped (the arity-0
    /// lookup).
    /// @param type The first-import-wins resolved type.
    /// @param ambiguity The two colliding candidates, or `null` when the name is unambiguous.
    /// @returns Whether any import resolved the name.
    private func TryScanImportsForClrType(
        lookupName string,
        requireNonGenericDefinition bool,
        @NotNullWhen(true) out type Type?,
        out ambiguity ImportedTypeAmbiguity?
    ) bool {
        type = nil
        ambiguity = nil
        var firstExplicit Type? = nil
        var firstImplicit Type? = nil
        for import_ in EnumerateImports() {
            if !References!!.TryResolveType(import_.Target + "." + lookupName, out var candidate) {
                continue
            }
            if requireNonGenericDefinition && candidate!!.IsGenericTypeDefinition {
                continue
            }
            // An implicit import is a fallback, never a competitor: it is held
            // back and consulted only if no written import resolves the name,
            // so a namespace the author never asked for can neither shadow
            // theirs nor collide with it. `HoistsStatics` is about reaching
            // bare FUNCTION names (ADR-0174 D9's `after`, `merge`) and says
            // nothing about type resolution; conflating the two is what let
            // `Gsharp.Concurrency.Context` shadow a user's own `Context`.
            if import_.IsImplicit {
                firstImplicit ??= candidate
                continue
            }
            // First-import-wins among written imports: the answer is exactly
            // what it was before #3734, ambiguous or not.
            type ??= candidate
            if import_.IsAlias {
                continue
            }
            if firstExplicit == nil {
                firstExplicit = candidate
            } else if firstExplicit != candidate {
                // Both facts are settled — the winner and the collision — so
                // the remaining imports cannot change the answer.
                ambiguity = ImportedTypeAmbiguity(firstExplicit, candidate!!, type!!)
                break
            }
        }
        type ??= firstImplicit
        return type != nil
    }

    private func EnumerateImports() ImmutableArray[ImportSymbol] -> GetImportIndex()?.GetVisibleImports(
        GetCurrentReferencingSyntaxTree()
    ) ??
        ImmutableArray[ImportSymbol].Empty

    private func GetImportIndex() VisibleImportIndex? {
        let parentIndex = Parent?.GetImportIndex()
        if imports == nil {
            return parentIndex
        }
        let cached = cachedImportIndex
        if cached != nil && cached.OwnCount == imports!!.Count && object.ReferenceEquals(cached.Parent, parentIndex) {
            return cached
        }
        // Empty lexical scopes share their ancestor's index. Import additions replace the affected snapshots.
        let built = VisibleImportIndex(parentIndex, imports!!.ToImmutable())
        let previous = Interlocked.CompareExchange(&cachedImportIndex, built, cached)
        return if object.ReferenceEquals(previous, cached) {
            built
        } else {
            previous
        }
    }

    @MemberNotNull("symbols", "symbolKeys")
    private func AddSymbol(name string, symbol Symbol) {
        // Both callers (TryDeclareFunction, TryDeclareSymbol) already assign
        // `symbols ??= ...` immediately before calling AddSymbol; this mirrors
        // that so the method is correct standalone and the [MemberNotNull]
        // claim above is honest, not just assumed from the caller.
        symbols ??= ImmutableDictionary.CreateBuilder[string, Symbol]()
        symbols!!.Add(name, symbol)
        symbolKeys ??= ImmutableArray.CreateBuilder[string]()
        symbolKeys!!.Add(name)
    }

    private func TryDeclareSymbol[TSymbol Symbol](symbol TSymbol) bool {
        if symbol.Name == nil {
            return false
        }
        symbols ??= ImmutableDictionary.CreateBuilder[string, Symbol]()
        if symbols!!.ContainsKey(symbol.Name) {
            return false
        }
        AddSymbol(symbol.Name, symbol)
        return true
    }

    private func GetDeclaredSymbols[TSymbol Symbol]() ImmutableArray[TSymbol] {
        if symbols == nil {
            return ImmutableArray[TSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[TSymbol]()
        // symbolKeys is always populated together with symbols, in the same
        // call, by AddSymbol (marked [MemberNotNull] on both) — the only place
        // either field is ever assigned. symbols != null (checked above)
        // therefore guarantees symbolKeys != null too.
        for key in symbolKeys!! {
            if symbols!!.TryGetValue(key, out var symbol) && symbol is TSymbol typed {
                builder.Add(typed)
            }
        }
        return builder.ToImmutable()
    }

    shared {
        /// ADR-0063 §1: compares two function symbols for overload-identity equality —
        /// member name, callable parameter count, each parameter's type, and each
        /// parameter's ref-kind. Return type, parameter names, accessibility, and
        /// default values are deliberately not part of identity.
        /// @param a First function symbol.
        /// @param b Second function symbol.
        /// @returns Whether the two functions share an overload signature.
        func FunctionSignaturesEqual(a FunctionSymbol?, b FunctionSymbol?) bool {
            if a == nil || b == nil {
                return false
            }
            if !string.Equals(a.Name, b.Name, StringComparison.Ordinal) {
                return false
            }
            if object.ReferenceEquals(a.Declaration, b.Declaration) &&
                a.NullableSequenceSpecialization != NullableSequenceSpecializationKind.None &&
                b.NullableSequenceSpecialization != NullableSequenceSpecializationKind.None &&
                a.NullableSequenceSpecialization != b.NullableSequenceSpecialization {
                return false
            }
            let ap = SigCallableParameters(a)
            let bp = SigCallableParameters(b)
            if ap.Length != bp.Length {
                return false
            }
            let aTypeParams = if a.TypeParameters.IsDefault {
                0
            } else {
                a.TypeParameters.Length
            }
            let bTypeParams = if b.TypeParameters.IsDefault {
                0
            } else {
                b.TypeParameters.Length
            }
            if aTypeParams != bTypeParams {
                return false
            }
            for var i = 0; i < ap.Length; i++ {
                if ap[i].RefKind != bp[i].RefKind {
                    return false
                }
                if !SigTypesEquivalent(ap[i].Type, bp[i].Type, a, b) {
                    return false
                }
            }
            return true
        }

        private func FlattenConstructedTypeArguments(type StructSymbol) ImmutableArray[TypeSymbol] {
            if type.EnclosingTypeArguments.IsDefaultOrEmpty && type.TypeArguments.IsDefaultOrEmpty {
                return default(ImmutableArray[TypeSymbol])
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
            if !type.EnclosingTypeArguments.IsDefaultOrEmpty {
                builder.AddRange(type.EnclosingTypeArguments)
            }
            if !type.TypeArguments.IsDefaultOrEmpty {
                builder.AddRange(type.TypeArguments)
            }
            return builder.ToImmutable()
        }

        /// Issue #1051: computes the generic arity (number of type parameters) of a
        /// type used as the storage-key discriminator. C#/CLR allow two types that
        /// share a simple name but differ by generic arity (e.g. `Foo` and
        /// `Foo[T]`, mirroring `Task`/`Task<T>`) to coexist as
        /// distinct types keyed by (name, arity). Only open generic DEFINITIONS
        /// carry an arity; constructed instances and plain aliases are arity 0.
        /// @param target The type whose arity is requested.
        /// @returns The generic arity, or 0 for non-generic / constructed types.
        private func GetTypeAliasArity(target TypeSymbol) int32 {
            return switch target {
                case s is StructSymbol when s.IsGenericDefinition: s.TypeParameters.Length
                case i is InterfaceSymbol when i.IsGenericDefinition: i.TypeParameters.Length
                case d is DelegateTypeSymbol when d.IsGenericDefinition: d.TypeParameters.Length
                default: 0
            }
        }

        /// Issue #1051: builds the storage key for a type alias keyed by
        /// (simple name, generic arity). Arity-0 types keep their plain simple name
        /// as the key (so existing simple-name lookups keep working), while generic
        /// definitions are suffixed with the CLR backtick-arity convention
        /// (e.g. `Foo`1`), letting `Foo` and `Foo[T]` coexist.
        /// @param name The simple type name.
        /// @param arity The generic arity.
        /// @returns The composite storage key.
        private func MangleArity(name string, arity int32) string -> if arity <= 0 {
            name
        } else {
            name + "`" + arity.ToString(CultureInfo.InvariantCulture)
        }

        /// Determines whether an extension's declared receiver type matches the
        /// static type of the call receiver.
        /// @remarks Package-owned user struct/class/interface receivers are interned, so
        /// reference equality matches them exactly (and must remain the primary
        /// check so two distinct user types never collide). Imported/BCL and
        /// primitive receivers, however, are not interned: the
        /// (cref:FunctionSymbol.ExtensionReceiverType) captured at the
        /// extension declaration and the receiver's type symbol at the call site
        /// can be distinct `ImportedTypeSymbol` instances (or symbols
        /// materialised through a (cref:System.Reflection.MetadataLoadContext))
        /// that wrap the same logical CLR type (issue #1103). For those we fall
        /// back to an exact structural CLR-type identity comparison via
        /// (cref:ClrTypeUtilities.IsSameAs) — exact identity, never
        /// assignability, so genuinely different types do not match.
        /// @param declaredReceiverType The extension's declared receiver type.
        /// @param receiverType The static type of the call receiver.
        /// @returns `true` when the receiver types match.
        private func ReceiverMatches(declaredReceiverType TypeSymbol?, receiverType TypeSymbol) bool {
            if declaredReceiverType == receiverType {
                return true
            }
            if declaredReceiverType?.ClrType is Type declaredClr && receiverType?.ClrType is Type receiverClr {
                return declaredClr.IsSameAs(receiverClr)
            }
            return false
        }

        /// Issue #1548: determines whether a CONCRETE declared extension receiver
        /// type [`declaredReceiverType`](paramref) is applicable for a
        /// call-site receiver [`receiverType`](paramref) that is not an exact
        /// (identity / same-CLR-type) match, by classifying the implicit
        /// convertibility of the call-site receiver TO the declared receiver.
        /// @remarks Applicability requires an implicit conversion — identity, implicit
        /// reference (derived-to-base, class-to-implemented-interface,
        /// constructed-generic covariant reference), or boxing (value type to
        /// `object` / an implemented interface) — mirroring C#/Kotlin
        /// extension-method receiver semantics. Explicit (narrowing) conversions do
        /// NOT qualify, so a genuinely unrelated receiver still fails to bind. The
        /// exact/same-CLR fast path is checked by (cref:ReceiverMatches)
        /// before this method, so this only needs the conversion classification.
        /// @param declaredReceiverType The extension's declared receiver type.
        /// @param receiverType The static type of the call receiver.
        /// @returns `true` when the call receiver is implicitly convertible to the declared receiver.
        private func ReceiverConvertible(
            @NotNullWhen(true) declaredReceiverType TypeSymbol?,
            receiverType TypeSymbol?
        ) bool {
            if declaredReceiverType == nil ||
                receiverType == nil ||
                declaredReceiverType == TypeSymbol.Error ||
                receiverType == TypeSymbol.Error {
                return false
            }
            let conversion = Conversion.Classify(receiverType, declaredReceiverType)
            return conversion.Exists && conversion.IsImplicit
        }

        /// Issue #1548: ranks the specificity of a convertible extension receiver
        /// among the same-named extension candidates declared in THIS scope. The
        /// score is the number of those candidates' declared receiver types that
        /// [`declaredReceiverType`](paramref) is implicitly convertible to
        /// (counting itself). A more-derived receiver converts to more of its
        /// siblings' base/interface receivers, so it scores higher and wins on the
        /// singular deterministic lookup path (e.g. `string` beats
        /// `object` for a `string` receiver).
        /// @param extensionFunctions The same-scope, same-name extension candidates to rank against.
        /// @param declaredReceiverType The candidate's declared receiver type.
        /// @returns The specificity score (higher is more specific).
        private func ReceiverConvertibilitySpecificity(
            extensionFunctions ImmutableArray[FunctionSymbol].Builder?,
            declaredReceiverType TypeSymbol?
        ) int32 {
            if extensionFunctions == nil || declaredReceiverType == nil {
                return 0
            }
            var score = 0
            for ext in extensionFunctions {
                if ext.ExtensionReceiverType == nil {
                    continue
                }
                if declaredReceiverType == ext.ExtensionReceiverType {
                    score++
                    continue
                }
                let conversion = Conversion.Classify(declaredReceiverType, ext.ExtensionReceiverType!!)
                if conversion.Exists && conversion.IsImplicit {
                    score++
                }
            }
            return score
        }

        /// Issue #1080: returns the enclosing type of a (possibly nested) user type
        /// symbol — the value set via `SetContainingType` during declaration
        /// binding — or `null` for a top-level type or a non-aggregate symbol.
        private func TypeContainingType(type TypeSymbol?) TypeSymbol? -> switch type {
            case s is StructSymbol: s.ContainingType
            case e is EnumSymbol: e.ContainingType
            case i is InterfaceSymbol: i.ContainingType
            case d is DelegateTypeSymbol: d.ContainingType
            default: default(TypeSymbol?)
        }

        private func TypeDefinition(type TypeSymbol) TypeSymbol -> switch type {
            case s is StructSymbol: cast[TypeSymbol](s.Definition ?? s)
            case e is EnumSymbol: cast[TypeSymbol](e.Definition ?? e)
            case i is InterfaceSymbol: cast[TypeSymbol](i.Definition ?? i)
            case d is DelegateTypeSymbol: cast[TypeSymbol](d.Definition ?? d)
            default: type
        }

        private func NestedTypeAccessibility(type TypeSymbol) Accessibility -> switch type {
            case s is StructSymbol: s.Accessibility
            case e is EnumSymbol: e.Accessibility
            case i is InterfaceSymbol: i.Accessibility
            case d is DelegateTypeSymbol: d.Accessibility
            default: Accessibility.Private
        }

        /// Issue #1174: whether [`type`](paramref) is a user aggregate nested
        /// directly inside [`container`](paramref).
        private func IsNestedDirectlyIn(type TypeSymbol?, container TypeSymbol) bool -> object.ReferenceEquals(
            TypeContainingType(type),
            container
        )

        /// Issue #2342: returns the declaring package name of a top-level user type
        /// symbol, generalized across every symbol kind that shares the top-level
        /// type/alias tables (classes/data classes and structs via
        /// (cref:StructSymbol), enums, interfaces, and named delegates), or
        /// `null` when the symbol carries no package identity. A plain
        /// `type Name = ...` alias ((cref:DeclarationBinder.BindTypeAliasDeclaration))
        /// has no dedicated symbol of its own — `target` IS the aliased type —
        /// so its "package" for duplicate-detection purposes is, as a best effort,
        /// whatever package the aliased type itself belongs to (or `null` for
        /// an imported/BCL/primitive alias target, preserving prior same-scope
        /// behavior for those).
        private func TypePackageName(type TypeSymbol?) string? -> switch type {
            case s is StructSymbol: s.PackageName
            case e is EnumSymbol: e.PackageName
            case i is InterfaceSymbol: i.PackageName
            case d is DelegateTypeSymbol: d.PackageName
            default: default(string?)
        }

        private func IsDeclaredInImplicitPackage(type TypeSymbol) bool {
            let declaration SyntaxNode? = switch type {
                case s is StructSymbol: (s.Declaration as SyntaxNode?)
                case e is EnumSymbol: cast[SyntaxNode](e.Declaration)
                case i is InterfaceSymbol: cast[SyntaxNode](i.Declaration)
                case d is DelegateTypeSymbol: cast[SyntaxNode](d.Declaration)
                default: nil
            }
            return declaration != nil &&
                !declaration
                .SyntaxTree
                .Root
                .Members
                .Any((member MemberSyntax) -> member is PackageSyntax)
        }

        /// Issue #1080: builds the containing-type-qualified dotted name of a type
        /// (e.g. `Outer.Middle.Inner` for a doubly-nested type, or the plain
        /// simple name for a top-level type) by walking the enclosing-type chain.
        /// Used as the fallback storage key for a nested type whose simple name is
        /// already taken by a differently-scoped type, so it remains a distinct
        /// stored value without colliding.
        private func QualifiedTypeName(type TypeSymbol?) string {
            let parts = List[string]()
            for var current TypeSymbol? = type; current != nil; current = TypeContainingType(current) {
                parts.Add(current.Name)
            }
            parts.Reverse()
            return string.Join(".", parts)
        }

        /// Issue #2342: builds the package-qualified fallback storage-key segment
        /// for a top-level type — `packageName + "#" + simpleName` — used when
        /// two top-level declarations share a simple (arity-mangled) name but
        /// belong to different packages. `'#'` cannot appear in a gsharp
        /// identifier or in a package name (both are lexed from
        /// letter/digit/underscore identifier tokens — optionally dot-joined for a
        /// package name — see (cref:GSharp.Core.CodeAnalysis.Syntax.Lexer)),
        /// nor in the dotted containing-type-qualified key format produced by
        /// (cref:QualifiedTypeName), so this key space never collides with
        /// either of those.
        private func PackageQualifiedName(packageName string?, simpleName string) string -> (
            packageName ?? string.Empty
        ) +
            "#" +
            simpleName

        /// Issue #1051: parses a composite storage key, reporting whether it names
        /// the requested simple name as a generic-arity variant and, if so, the
        /// arity it encodes.
        /// @param key The composite storage key.
        /// @param name The simple type name to match.
        /// @param arity The parsed arity, when matched.
        /// @returns Whether the key encodes a generic variant of [`name`](paramref).
        private func TryParseAritySuffix(key string?, name string?, out arity int32) bool {
            arity = 0
            if key == nil || name == nil || key.Length <= name.Length + 1 {
                return false
            }
            if !key.StartsWith(name, StringComparison.Ordinal) || key[name.Length] != '`' {
                return false
            }
            return int32.TryParse(
                key.Substring(name.Length + 1),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out arity
            )
        }

        private func SigCallableParameters(f FunctionSymbol) ImmutableArray[
            ParameterSymbol
        ] -> if f.ExplicitReceiverParameter == nil {
            f.Parameters
        } else {
            f.Parameters.RemoveAt(0)
        }

        /// Issue #1188 / #775: compares the type-parameter constraints of two
        /// extension functions for overload-identity purposes. Two extensions that
        /// share a name, receiver type, and callable parameter signature are still
        /// distinct overloads when their generic type parameters carry different
        /// constraints (e.g. `FirstOrNil[T class]()` vs
        /// `FirstOrNil[T struct]()`), because receiver-constraint dispatch
        /// disambiguates them at the call site. Returns `true` only
        /// when every type parameter carries equivalent class/struct/new() and
        /// interface/base constraints.
        /// @param a First extension function.
        /// @param b Second extension function.
        /// @returns Whether the two functions' type-parameter constraints match.
        private func ExtensionTypeParameterConstraintsEqual(a FunctionSymbol, b FunctionSymbol) bool {
            let aTp = if a.TypeParameters.IsDefault {
                ImmutableArray[TypeParameterSymbol].Empty
            } else {
                a.TypeParameters
            }
            let bTp = if b.TypeParameters.IsDefault {
                ImmutableArray[TypeParameterSymbol].Empty
            } else {
                b.TypeParameters
            }
            if aTp.Length != bTp.Length {
                return false
            }
            for var i = 0; i < aTp.Length; i++ {
                let x = aTp[i]
                let y = bTp[i]
                if x.HasValueTypeConstraint != y.HasValueTypeConstraint ||
                    x.HasReferenceTypeConstraint != y.HasReferenceTypeConstraint ||
                    x.HasDefaultConstructorConstraint != y.HasDefaultConstructorConstraint ||
                    x.Constraint != y.Constraint {
                    return false
                }
                // Review finding (#4068): a DEPENDENT bound is compared POSITIONALLY,
                // never by name. `ConstraintReferenceType` folds it in with the
                // interface/base bounds, and those are named by stable type names
                // while a type PARAMETER's name is arbitrary — so comparing it by
                // name broke identity in both directions, measured:
                //   * `Ext[A, B A]` and `Ext[X, Y X]` are one overload spelled
                //     twice, and were treated as two (no GS0264, then ambiguous at
                //     the call site) purely because "A" != "X";
                //   * a bound on a type parameter named `Marker` and a bound on the
                //     CLASS `Marker` compared EQUAL, reporting a false GS0264 on
                //     two genuinely distinct overloads.
                // Ordinal plus owner-kind identifies the bound parameter exactly,
                // and is what the emitted VAR/MVAR encoding already keys on.
                if (x.TypeParameterBound == nil) != (y.TypeParameterBound == nil) {
                    return false
                }
                if x.TypeParameterBound is {} xBound &&
                    y.TypeParameterBound is {} yBound &&
                    (xBound.Ordinal != yBound.Ordinal || xBound.IsMethodTypeParameter != yBound.IsMethodTypeParameter) {
                    return false
                }
                // The interface / base-class bounds keep the name comparison they
                // have always had; only the dependent bound is excluded from it.
                let xRef = (x.ConstraintInterfaceType ?? x.ClassConstraint)?.Name
                let yRef = (y.ConstraintInterfaceType ?? y.ClassConstraint)?.Name
                if !string.Equals(xRef, yRef, StringComparison.Ordinal) {
                    return false
                }
            }
            return true
        }

        private func SigTypesEquivalent(x TypeSymbol?, y TypeSymbol?, fx FunctionSymbol, fy FunctionSymbol) bool {
            if object.ReferenceEquals(x, y) {
                return true
            }
            if x == nil || y == nil {
                return false
            }
            if x is TypeParameterSymbol xtp && y is TypeParameterSymbol ytp {
                let xi = SigIndexOfTypeParameter(fx, xtp)
                let yi = SigIndexOfTypeParameter(fy, ytp)
                return xi >= 0 && xi == yi
            }
            return x.Name == y.Name
        }

        private func SigIndexOfTypeParameter(f FunctionSymbol, tp TypeParameterSymbol) int32 {
            if f.TypeParameters.IsDefault {
                return -1
            }
            for var i = 0; i < f.TypeParameters.Length; i++ {
                if object.ReferenceEquals(f.TypeParameters[i], tp) {
                    return i
                }
            }
            return -1
        }

        /// True when at least one of the extension's own type parameters
        /// (the ones declared on the extension function itself) occurs
        /// somewhere inside [`receiverType`](paramref).
        private func ReceiverMentionsAnyTypeParameter(
            receiverType TypeSymbol?,
            functionTypeParameters ImmutableArray[TypeParameterSymbol]
        ) bool {
            if functionTypeParameters.IsDefaultOrEmpty || receiverType == nil {
                return false
            }
            let collected = HashSet[TypeParameterSymbol]()
            CollectTypeParameters(receiverType, collected, depth: 0)
            if collected.Count == 0 {
                return false
            }
            for tp in functionTypeParameters {
                if collected.Contains(tp) {
                    return true
                }
            }
            return false
        }

        private func CollectTypeParameters(type TypeSymbol?, sink HashSet[TypeParameterSymbol], depth int32) {
            if type == nil || depth > 32 {
                return
            }
            switch type {
                case tp is TypeParameterSymbol {
                    sink.Add(tp)
                    return
                }
                case n is NullableTypeSymbol {
                    CollectTypeParameters(n.UnderlyingType, sink, depth + 1)
                    return
                }
                case s is SliceTypeSymbol {
                    CollectTypeParameters(s.ElementType, sink, depth + 1)
                    return
                }
                case a is ArrayTypeSymbol {
                    CollectTypeParameters(a.ElementType, sink, depth + 1)
                    return
                }
                case a is RectangularArrayTypeSymbol {
                    CollectTypeParameters(a.ElementType, sink, depth + 1)
                    return
                }
                case seq is SequenceTypeSymbol {
                    CollectTypeParameters(seq.ElementType, sink, depth + 1)
                    return
                }
                case aseq is AsyncSequenceTypeSymbol {
                    CollectTypeParameters(aseq.ElementType, sink, depth + 1)
                    return
                }
                case f is FunctionTypeSymbol {
                    if !f.ParameterTypes.IsDefaultOrEmpty {
                        for p in f.ParameterTypes {
                            CollectTypeParameters(p, sink, depth + 1)
                        }
                    }
                    CollectTypeParameters(f.ReturnType, sink, depth + 1)
                    return
                }
                case it is ImportedTypeSymbol {
                    if !it.TypeArguments.IsDefaultOrEmpty {
                        for arg in it.TypeArguments {
                            CollectTypeParameters(arg, sink, depth + 1)
                        }
                    }
                    return
                }
                case ss is StructSymbol {
                    if !ss.TypeArguments.IsDefaultOrEmpty {
                        for arg in ss.TypeArguments {
                            CollectTypeParameters(arg, sink, depth + 1)
                        }
                    }
                    return
                }
                default {
                    return
                }
            }
        }

        /// ADR-0097 / issue #775: tries to unify the declared open receiver type
        /// with the call-site receiver and — when unification succeeds —
        /// validates that every receiver-mentioned type parameter's
        /// `class` / `struct` / `new()` constraint is satisfied
        /// by the inferred type argument. Returns the candidate's
        /// constraint-specificity score so the caller can prefer the most
        /// specific surviving overload.
        /// @param extension The extension-method candidate.
        /// @param receiverType The call-site receiver type.
        /// @param specificity The cumulative specificity score (struct=2, class=1, none=0) summed across the
        /// receiver-mentioned type parameters.
        /// @returns `true` when unification succeeds and every constraint is satisfied; otherwise `false`.
        private func TryUnifyAndCheckConstraints(
            extension FunctionSymbol,
            receiverType TypeSymbol,
            out specificity int32
        ) bool {
            specificity = 0
            // Both call sites (TryFindExtensionInBucket, CollectExtensionFunctionMatches)
            // already check ext.ExtensionReceiverType != null immediately before calling
            // this method. Mirroring that guard here — rather than asserting it — keeps
            // this helper correct standalone: unifying against an absent declared
            // receiver simply fails, exactly like the "skip and try the next candidate"
            // behavior both callers already implement around the null check.
            if extension.ExtensionReceiverType is not{} declaredReceiver {
                return false
            }
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            Binder.InferTypeArguments(declaredReceiver, receiverType, substitution)
            let mentioned = HashSet[TypeParameterSymbol]()
            CollectTypeParameters(declaredReceiver, mentioned, depth: 0)
            for tp in mentioned {
                if !substitution.TryGetValue(tp, out var arg) {
                    return false
                }
                if !Binder.SatisfiesConstraint(arg, tp, substitution) {
                    return false
                }
                if tp.HasValueTypeConstraint {
                    specificity += 2
                } else if tp.HasReferenceTypeConstraint {
                    specificity += 1
                }
            }
            return true
        }
    }
}
