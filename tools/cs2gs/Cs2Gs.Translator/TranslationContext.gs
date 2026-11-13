// <copyright file="TranslationContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Coverage
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.CompilerServices
import System.Security.Cryptography
import System.Threading

/// Carries the bound Roslyn state a translation pass needs and accumulates the
/// structured (cref:TranslationDiagnostic) records the later mapping
/// steps (6–8) emit. One context is created per file: it pins the active
/// (cref:SemanticModel) so mapping code can resolve symbols
/// (`GetDeclaredSymbol`, `GetSymbolInfo`, `GetTypeInfo`,
/// data-flow) without threading the model through every call (ADR-0115 §A).
/// Each context captures immutable compilation catalogs. Caller list changes require a new context.
class TranslationContext {
    private let suppliedModels Dictionary[(Owner Compilation, Tree SyntaxTree), SemanticModel] =
    Dictionary[(Owner Compilation, Tree SyntaxTree), SemanticModel]()
    private let diagnostics List[TranslationDiagnostic] = List[TranslationDiagnostic]()

    // Keyed by the syntax tree instance, so two in-memory trees without a file
    // path never collide.
    private let reportedOnce HashSet[
        (Id string?, Tree SyntaxTree?, Start int32, Length int32, Discriminator string?, Message string?)
    ] = HashSet[(Id string?, Tree SyntaxTree?, Start int32, Length int32, Discriminator string?, Message string?)]()

    private var suppressDiagnosticsDepth int32

    // Issue #2412: every project's own `Compilation` loaded alongside this one
    // in the same migration run (the app plus every transitively-referenced
    // sibling project — see `TranslateStage`), consulted by
    // `ObliviousNullabilityAnalyzer.IsTainted`'s multi-compilation overload
    // when a symbol's own compilation (`Compilation`) reports it untainted.
    // Null (default, and every existing single-compilation caller) means "no
    // sibling set is known", so only `Compilation` is ever consulted — the
    // exact prior behavior.
    private let siblingCompilations IReadOnlyList[CSharpCompilation]?

    private let repositoryCompilations IReadOnlyList[CSharpCompilation]?
    private let catalogSnapshot SourceCatalogSnapshot?

    private let rootCompilation CSharpCompilation
    private var sharedCatalogIdentity object?
    private var specialModelDomain SpecialModelDomain?

    private class SpecialModelDomain {
        init(model SemanticModel) {
            this.Model = model
        }
        let Model SemanticModel
        private let graphs ConditionalWeakTable[object, SpecialModelGraph] =
        ConditionalWeakTable[object, SpecialModelGraph]()

        func ForGraph(graph object) SpecialModelGraph -> this.graphs.GetOrCreateValue(graph)
    }

    private class SpecialModelGraph {
        let Effects StorageIndexes = StorageIndexes()
    }

    internal prop HasNonstandardSemanticModel bool -> this.specialModelDomain != nil
    internal prop SuppliedNonstandardModel SemanticModel? -> this.specialModelDomain?.Model

    // Special supplied models cannot share facts derived from normal binding.
    internal prop CatalogIdentity object -> this.specialModelDomain ??
        this.sharedCatalogIdentity ??
        if this.catalogSnapshot == nil {
        cast[object](this.rootCompilation)
    } else {
        cast[object](this.catalogSnapshot)
    }

    internal func CreateRelatedContext(
        compilation CSharpCompilation,
        model SemanticModel,
        path string
    ) TranslationContext {
        let related = TranslationContext(
            compilation,
            model,
            path,
            this.siblingCompilations,
            this.repositoryCompilations,
            this.CancellationToken
        )
        related.sharedCatalogIdentity = this.CatalogIdentity
        related.specialModelDomain = this.specialModelDomain ?? related.specialModelDomain
        return related
    }

    convenience init(
        compilation CSharpCompilation,
        semanticModel SemanticModel,
        filePath string,
        siblingCompilations IReadOnlyList[CSharpCompilation]?,
        repositoryCompilations IReadOnlyList[CSharpCompilation]?
    ) {
        init(
            compilation,
            semanticModel,
            filePath,
            siblingCompilations,
            repositoryCompilations,
            default(CancellationToken)
        )
    }

    /// Initializes a new instance of the (cref:TranslationContext) class.
    /// @param compilation The owning C# compilation.
    /// @param semanticModel The active semantic model for the file being translated.
    /// @param filePath The originating file path, used to tag diagnostics.
    /// @param siblingCompilations Issue #2412: every project's own (cref:CSharpCompilation) loaded
    /// alongside [`compilation`](paramref) in the same migration run (the
    /// app plus its transitively-referenced sibling projects — under the
    /// default SDK-backed (`CompileViaSdk`) path, loaded independently
    /// purely for this taint lookup by `TranslateStage`, since
    /// [`compilation`](paramref) itself resolves siblings as
    /// (cref:PortableExecutableReference) metadata there instead of
    /// same-workspace source compilations). A whole-program
    /// fact computed only from one compilation's own syntax trees (e.g.
    /// (cref:Translator.ObliviousNullabilityAnalyzer)'s taint fixpoint)
    /// can be TRUE in a sibling project's own result for a symbol this
    /// compilation cannot prove tainted on its own — not only because the
    /// symbol is declared there, but also because that sibling's own
    /// interface-implementation edges (issue #2285) can record taint for a
    /// symbol declared in a THIRD project (an interface member implemented by
    /// one of the sibling's own types). Pass `null` (default)
    /// for a single-compilation translation (in-memory tests, a standalone
    /// project with no references) — only [`compilation`](paramref) is
    /// then ever consulted, the exact prior behavior.
    /// @param repositoryCompilations All repository projects, including reverse dependents. This is used
    /// only
    /// for stored-member nullability evidence; signatures keep dependency-only
    /// analysis so consumer calls cannot rewrite upstream contracts.
    init(
        compilation CSharpCompilation,
        semanticModel SemanticModel,
        filePath string,
        siblingCompilations IReadOnlyList[CSharpCompilation]? = nil,
        repositoryCompilations IReadOnlyList[CSharpCompilation]? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) {
        this.Compilation = compilation ?? throw ArgumentNullException("compilation")
        this.rootCompilation = this.Compilation
        this.SemanticModel = semanticModel ?? throw ArgumentNullException("semanticModel")
        if semanticModel.IgnoresAccessibility || semanticModel.IsSpeculativeSemanticModel {
            this.specialModelDomain = SpecialModelDomain(semanticModel)
        }
        this.suppliedModels[(semanticModel.Compilation, semanticModel.SyntaxTree)] = semanticModel
        CacheSemanticModel(this.Compilation, this.SemanticModel)
        this.FilePath = filePath
        this.CancellationToken = cancellationToken
        this.catalogSnapshot = CaptureSourceCatalog(
            compilation,
            siblingCompilations,
            repositoryCompilations,
            cancellationToken
        )
        this.siblingCompilations = this.catalogSnapshot?.Siblings
        this.repositoryCompilations = this.catalogSnapshot?.Repository
    }

    /// Gets the root C# compilation this context was created for.
    prop RootCompilation CSharpCompilation -> this.rootCompilation

    prop CancellationToken CancellationToken {
        get;
    }
    internal var StorageEffectBodyVisits int32
    internal var BeforeStorageEffectBody Action?
    internal var AfterStorageComparerFactory Action?
    internal var BeforeOwnershipTree Action?
    internal var BeforeRefStoragePublication Action?
    internal var AfterRefStorageConnection Action[ISymbol, ISymbol]?

    internal class DeferredCallbackIndex {
        init(
            factories List[
                (Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax, Owner CSharpCompilation)
            ],
            comparers List[
                (Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax, Owner CSharpCompilation)
            ]
        ) {
            Factories = factories.ToImmutableArray()
            Comparers = comparers.ToImmutableArray()
        }
        let Factories IReadOnlyList[
            (Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax, Owner CSharpCompilation)
        ]
        let Comparers IReadOnlyList[
            (Syntax Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax, Owner CSharpCompilation)
        ]
    }

    internal class StorageIndexes {
        var AliasedFields HashSet[IFieldSymbol]?
        var Methods Dictionary[string, List[IMethodSymbol]]?
        var DeferredIndex DeferredCallbackIndex?
        let Iterators HashSet[IMethodSymbol] = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        var TreeVisits int32
        var ImportedComparers List[INamedTypeSymbol]?
        var IncompleteImportedComparers bool
        let TrustedAssemblies Dictionary[IAssemblySymbol, bool] = Dictionary[IAssemblySymbol, bool](
            SymbolEqualityComparer.Default
        )
    }

    internal prop EffectIndexes StorageIndexes -> if this.specialModelDomain is {} domain {
        domain.ForGraph(this.SourceOwners(true)).Effects
    } else {
        this.SourceOwners(true).Effects
    }

    /// Gets the owning C# compilation.
    prop Compilation CSharpCompilation {
        get;
        private set;
    }

    /// Gets every project's own (cref:CSharpCompilation) loaded
    /// alongside (cref:Compilation) in the same migration run (issue
    /// #2412), or `null` when no sibling set is known (a
    /// single-compilation translation).
    prop SiblingCompilations IReadOnlyList[CSharpCompilation]? -> this.siblingCompilations

    /// Gets all repository compilations, including reverse dependents, for
    /// stored-member nullability evidence.
    prop RepositoryCompilations IReadOnlyList[CSharpCompilation]? -> this.repositoryCompilations

    /// Gets the active semantic model for the file being translated.
    prop SemanticModel SemanticModel {
        get;
        private set;
    }

    /// Gets the originating file path.
    prop FilePath string {
        get;
    }

    /// Gets or sets the analyzer-test snippet translator (ADR-0169 M5, issue
    /// #3778): given a marked C# snippet it returns the equivalent G# snippet
    /// with its `[|…|]` markers re-placed. The implementation
    /// (`Cs2Gs.Translator.Analyzers.SnippetTranslator`) needs a C# project
    /// loader and therefore lives in `Cs2Gs.ProjectLoading`, which
    /// references this assembly — so the pipeline injects it here rather than
    /// the translator taking a dependency the wrong way round. Left
    /// `null` (the default, and every in-memory unit test that
    /// does not opt in) snippet dispatch is disabled and marked sources are
    /// translated as ordinary string literals, exactly as before.
    prop TranslateAnalyzerSnippet((string) -> SnippetTranslationResult)?

    /// Gets the diagnostics recorded so far, in insertion order.
    prop Diagnostics IReadOnlyList[TranslationDiagnostic] -> this.diagnostics.ToImmutableArray()

    /// Issue #1910: temporarily makes the semantic model bound to
    /// [`tree`](paramref) the active (cref:SemanticModel), so nodes
    /// belonging to a different partial-declaration part (in another file) can
    /// be resolved through the usual (cref:GetDeclaredSymbol)/
    /// (cref:GetSymbolInfo)/(cref:GetTypeInfo) seams. Dispose the
    /// returned scope to restore the previous model.
    /// @param tree The syntax tree the next node(s) to resolve belong to.
    /// @returns A scope that restores the previous active model on (cref:IDisposable.Dispose).
    func UseSemanticModelFor(tree SyntaxTree?) IDisposable -> this.UseSemanticModelFor(tree, nil)

    func UseSemanticModelFor(tree SyntaxTree?, owner CSharpCompilation?) IDisposable {
        if tree == nil {
            return NoOpScope.Instance
        }
        // The active model is already owned. A shared tree is not evidence that
        // a different compilation (including the root) owns this invocation.
        if tree == this
            .SemanticModel
            .SyntaxTree &&
            (owner == nil || object.ReferenceEquals(this.SemanticModel.Compilation, owner)) {
            return NoOpScope.Instance
        }
        let currentKey(Owner Compilation, Tree SyntaxTree) = (this.Compilation, tree)
        let ownerCompilation = owner ?? if this.suppliedModels.ContainsKey(currentKey) ||
            this
            .Compilation
            .ContainsSyntaxTree(tree) {
            this.Compilation
        } else {
            (
                if this.rootCompilation.ContainsSyntaxTree(tree) {
                    this.rootCompilation
                } else {
                    default(CSharpCompilation?)
                }
            ) ??
                this
                .SourceOwners(false).UniqueTreeOwner(tree) ?? this.SourceOwners(true).UniqueTreeOwner(tree) ??
                throw InvalidOperationException("A source tree requires an explicit compilation owner.")
        }
        let key(Owner Compilation, Tree SyntaxTree) = (ownerCompilation, tree)
        let model = if this.suppliedModels.TryGetValue(key, out var supplied) {
            supplied
        } else if this.specialModelDomain is {} domain && object.ReferenceEquals(
            domain.Model.Compilation,
            ownerCompilation
        ) &&
            object.ReferenceEquals(domain.Model.SyntaxTree, tree) {
            domain.Model
        } else {
            GetSemanticModel(ownerCompilation, tree)
        }
        let previousCompilation = this.Compilation
        let previousModel = this.SemanticModel
        this.Compilation = ownerCompilation
        this.SemanticModel = model
        return RestoreModelScope(this, previousCompilation, previousModel)
    }

    private var actualOwners SourceOwnershipIndex?
    private var catalogOwners SourceOwnershipIndex?

    internal func SourceCompilations(includeSiblingLookup bool = true) IReadOnlyList[CSharpCompilation] ->
    this.SourceOwners(includeSiblingLookup).Compilations

    internal func GetOwnedSemanticModel(tree SyntaxTree, owner CSharpCompilation? = nil) SemanticModel {
        using let modelScope = this.UseSemanticModelFor(tree, owner)
        return this.SemanticModel
    }

    internal func SourceCompilation(symbol ISymbol) CSharpCompilation? {
        let assembly = symbol as IAssemblySymbol ?? symbol.ContainingAssembly
        if assembly != nil && SymbolEqualityComparer.Default.Equals(assembly, this.Compilation.Assembly) {
            return this.Compilation
        }
        return if assembly == nil {
            nil
        } else {
            this.SourceOwners(true).Owner(assembly)
        }
    }

    internal func UseSemanticModelForSymbol(tree SyntaxTree, symbol ISymbol?) IDisposable? {
        let owner = if symbol == nil {
            nil
        } else {
            this.SourceCompilation(symbol)
        }
        return if owner == nil || !owner.ContainsSyntaxTree(tree) {
            nil
        } else {
            this.UseSemanticModelFor(tree, owner)
        }
    }

    private func SourceOwners(includeCatalog bool) SourceOwnershipIndex {
        if this.actualOwners == nil {
            let publication = SourceOwnershipByCompilation.GetOrCreateValue(this.rootCompilation)
            lock publication {
                if publication.Index == nil {
                    publication.Index = SourceOwnershipIndex(
                        []CSharpCompilation{this.rootCompilation},
                        this.CancellationToken,
                        this.BeforeOwnershipTree
                    )
                }
                this.actualOwners = publication.Index
            }
        }
        let actual = this.actualOwners ?? throw InvalidOperationException("Missing source graph.")
        let snapshot = this.catalogSnapshot
        if !includeCatalog || snapshot == nil {
            return actual
        }
        if this.catalogOwners == nil {
            lock snapshot {
                if snapshot.Index == nil {
                    let index = SourceOwnershipIndex(
                        actual
                            .Compilations
                            .Concat(snapshot.Repository ?? Array.Empty[CSharpCompilation]())
                            .Concat(snapshot.Siblings ?? Array.Empty[CSharpCompilation]()),
                        this.CancellationToken,
                        this.BeforeOwnershipTree
                    )
                    this.CancellationToken.ThrowIfCancellationRequested()
                    snapshot.Index = index
                }
                this.catalogOwners = snapshot.Index
            }
        }
        return this.catalogOwners ?? throw InvalidOperationException("Missing source catalog.")
    }

    internal prop OwnershipTreeEntries int32 -> this.SourceOwners(true).TreeEntries
    internal prop OwnershipIndexIdentity object -> if this.specialModelDomain is {} domain {
        cast[object](domain.ForGraph(this.SourceOwners(true)))
    } else {
        cast[object](this.SourceOwners(true))
    }
    internal prop HasOwnershipIndex bool -> this.actualOwners != nil

    private class SourceOwnershipIndex {
        let Compilations IReadOnlyList[CSharpCompilation]
        let Effects StorageIndexes = StorageIndexes()
        var TreeEntries int32
        private let assemblies Dictionary[IAssemblySymbol, CSharpCompilation] =
        Dictionary[IAssemblySymbol, CSharpCompilation](SymbolEqualityComparer.Default)
        private let trees Dictionary[SyntaxTree, CSharpCompilation?] =
        Dictionary[SyntaxTree, CSharpCompilation?](ReferenceEqualityComparer.Instance)

        init(roots IEnumerable[CSharpCompilation], cancellationToken CancellationToken, beforeTree Action?) {
            let result = List[CSharpCompilation]()
            let pending = Queue[CSharpCompilation](roots)
            let seen = HashSet[CSharpCompilation](ReferenceEqualityComparer.Instance)
            while pending.Count > 0 {
                cancellationToken.ThrowIfCancellationRequested()
                let compilation = pending.Dequeue()
                if !seen.Add(compilation) {
                    continue
                }
                result.Add(compilation)
                this.assemblies.TryAdd(compilation.Assembly, compilation)
                for tree in compilation.SyntaxTrees {
                    beforeTree?.Invoke()
                    cancellationToken.ThrowIfCancellationRequested()
                    this.TreeEntries++
                    if !this.trees.TryAdd(tree, compilation) && !object.ReferenceEquals(this.trees[tree], compilation) {
                        this.trees[tree] = nil
                    }
                }
                for reference in compilation.References.OfType[CompilationReference]() {
                    if reference.Compilation is CSharpCompilation source {
                        if compilation.GetAssemblyOrModuleSymbol(reference) is IAssemblySymbol boundAssembly {
                            this.assemblies.TryAdd(boundAssembly, source)
                        }
                        pending.Enqueue(source)
                    }
                }
            }
            cancellationToken.ThrowIfCancellationRequested()
            this.Compilations = result.ToImmutableArray()
        }

        func Owner(assembly IAssemblySymbol) CSharpCompilation? ->
        if this.assemblies.TryGetValue(assembly, out var owner) {
            owner
        } else {
            nil
        }

        func UniqueTreeOwner(tree SyntaxTree) CSharpCompilation? ->
        if this.trees.TryGetValue(tree, out var owner) {
            owner
        } else {
            nil
        }
    }

    private class SourceOwnershipPublication {
        var Index SourceOwnershipIndex?
        var Snapshot SourceCatalogSnapshot?
        let Catalogs ConditionalWeakTable[object, SourceCatalogs] = ConditionalWeakTable[object, SourceCatalogs]()
    }

    private class SourceCatalogs {
        let Siblings ConditionalWeakTable[object, SourceOwnershipPublication] =
        ConditionalWeakTable[object, SourceOwnershipPublication]()
    }

    private class SourceCatalogSnapshot {
        init(siblings IReadOnlyList[CSharpCompilation]?, repository IReadOnlyList[CSharpCompilation]?) {
            this.Siblings = siblings
            this.Repository = repository
        }
        let Siblings IReadOnlyList[CSharpCompilation]?
        let Repository IReadOnlyList[CSharpCompilation]?
        var Index SourceOwnershipIndex?
    }

    /// Resolves the declared symbol for a declaration node via the active model.
    /// @param node The declaration syntax node.
    /// @returns The declared symbol, or `null` if none.
    func GetDeclaredSymbol(node SyntaxNode?) ISymbol? -> this.SemanticModel.GetDeclaredSymbol(node!!)

    /// Resolves symbol information for an expression or reference via the active model.
    /// @param node The expression or reference node.
    /// @returns The resolved symbol info.
    func GetSymbolInfo(node SyntaxNode?) SymbolInfo -> this.SemanticModel.GetSymbolInfo(node!!)

    /// Resolves type information for an expression via the active model.
    /// @param node The expression node.
    /// @returns The resolved type info.
    func GetTypeInfo(node SyntaxNode?) TypeInfo -> this.SemanticModel.GetTypeInfo(node!!)

    /// Records [`diagnostic`](paramref) unless one with the same id and
    /// generic-store metadata was already recorded at the same source span. A node that is translated
    /// more than once in one context (a speculative translation) then reports
    /// once. A diagnostic without a source location or a diagnostic id is
    /// always recorded.
    /// @param diagnostic The diagnostic to record.
    func ReportOnce(diagnostic TranslationDiagnostic) -> this.ReportOnce(diagnostic, nil)

    /// Records a diagnostic once per source span and distinct synthesized site.
    /// Repeated translations of the same site still collapse to one report.
    /// Generic-store reports also preserve distinct store metadata at that span.
    /// @param diagnostic The diagnostic to record.
    /// @param discriminator A stable synthesized-site identity, or null for the source span itself.
    func ReportOnce(diagnostic TranslationDiagnostic?, discriminator string?) {
        if diagnostic == nil {
            throw ArgumentNullException("diagnostic")
        }
        if this.suppressDiagnosticsDepth > 0 {
            return
        }
        let location Location? = diagnostic.Location
        if location?.SourceTree == nil || diagnostic.DiagnosticId == nil {
            this.diagnostics.Add(diagnostic)
            return
        }
        let key = (
            diagnostic.DiagnosticId,
            location!!.SourceTree,
            location!!.SourceSpan.Start,
            location!!.SourceSpan.Length,
            discriminator,
            if diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId {
                diagnostic.Message
            } else {
                string.Empty
            }
        )
        if this.reportedOnce.Add(key) {
            this.diagnostics.Add(diagnostic)
        }
    }

    /// Records a structured diagnostic for a construct the translator cannot map.
    /// @param diagnostic The diagnostic to record.
    func Report(diagnostic TranslationDiagnostic?) {
        if diagnostic == nil {
            throw ArgumentNullException("diagnostic")
        }
        if this.suppressDiagnosticsDepth > 0 {
            return
        }
        this.diagnostics.Add(diagnostic)
    }

    /// Records an (cref:TranslationSeverity.Unsupported) diagnostic anchored
    /// at a C# syntax node. This is the canonical "not yet translated" seam used
    /// by the visitor skeleton until steps 6–8 implement the real mapping.
    /// @param node The C# node that could not be translated.
    /// @param message A human-readable description of the gap.
    /// @param diagnosticId An explicit diagnostic id, or `null` (the default) for
    /// the classification-derived one. The classification is assigned here
    /// either way.
    func ReportUnsupported(node SyntaxNode?, message string?, diagnosticId string? = nil) {
        if node == nil {
            throw ArgumentNullException("node")
        }
        if this.suppressDiagnosticsDepth > 0 {
            return
        }
        // The exhaustiveness choke point (ADR-0138): a kind registered in
        // UnsupportedByDesign is a recorded design decision; anything else is
        // an accidental fallthrough classified as a gap, which the coverage
        // tests and the triage pipeline surface loudly until it is either
        // translated or registered with a rationale.
        let diagnostic = TranslationDiagnostic(
            node.Kind().ToString(),
            message,
            node.GetLocation(),
            TranslationSeverity.Unsupported
        ){DiagnosticId = diagnosticId}
        if UnsupportedByDesign.TryGetRationale(node.Kind(), out var rationale) {
            diagnostic.Classification = UnsupportedClassification.ByDesign
            diagnostic.Rationale = rationale
        }
        this.diagnostics.Add(diagnostic)
    }

    internal func SuspendDiagnostics() IDisposable {
        this.suppressDiagnosticsDepth++
        return RestoreDiagnosticsScope(this)
    }

    private class RestoreDiagnosticsScope : IDisposable {
        private let owner TranslationContext
        private var disposed bool

        init(owner TranslationContext) {
            this.owner = owner
        }

        func Dispose() {
            if !this.disposed {
                this.disposed = true
                this.owner.suppressDiagnosticsDepth--
            }
        }
    }

    private class RestoreModelScope : IDisposable {
        private let owner TranslationContext
        private let previousCompilation CSharpCompilation
        private let previousModel SemanticModel

        init(owner TranslationContext, previousCompilation CSharpCompilation, previousModel SemanticModel) {
            this.owner = owner
            this.previousCompilation = previousCompilation
            this.previousModel = previousModel
        }

        func Dispose() {
            this.owner.Compilation = this.previousCompilation
            this.owner.SemanticModel = this.previousModel
        }
    }

    private class NoOpScope : IDisposable {
        func Dispose() { }

        shared {
            let Instance NoOpScope = NoOpScope()
        }
    }

    shared {
        private let SourceOwnershipByCompilation ConditionalWeakTable[CSharpCompilation, SourceOwnershipPublication] =
        ConditionalWeakTable[CSharpCompilation, SourceOwnershipPublication]()
        private let NoCatalog object = System.Object()

        private func CaptureSourceCatalog(
            root CSharpCompilation,
            siblings IReadOnlyList[CSharpCompilation]?,
            repository IReadOnlyList[CSharpCompilation]?,
            cancellationToken CancellationToken
        ) SourceCatalogSnapshot? {
            if siblings == nil && repository == nil {
                return nil
            }
            let owner = SourceOwnershipByCompilation.GetOrCreateValue(root)
            let repositories = owner.Catalogs.GetOrCreateValue(
                if repository == nil {
                    NoCatalog
                } else {
                    cast[object](repository)
                }
            )
            let publication = repositories.Siblings.GetOrCreateValue(
                if siblings == nil {
                    NoCatalog
                } else {
                    cast[object](siblings)
                }
            )
            lock publication {
                let prior = publication.Snapshot
                if prior != nil &&
                    SameCompilations(prior.Repository, repository) &&
                    SameCompilations(prior.Siblings, siblings) {
                    return prior
                }
                let repositoryVersion IReadOnlyList[CSharpCompilation]? =
                if repository == nil {
                    nil
                } else {
                    repository.ToImmutableArray()
                }
                let siblingVersion IReadOnlyList[CSharpCompilation]? =
                if siblings == nil {
                    nil
                } else {
                    siblings.ToImmutableArray()
                }
                cancellationToken.ThrowIfCancellationRequested()
                let snapshot = SourceCatalogSnapshot(siblingVersion, repositoryVersion)
                publication.Snapshot = snapshot
                return snapshot
            }
        }

        private func SameCompilations(
            left IReadOnlyList[CSharpCompilation]?,
            right IReadOnlyList[CSharpCompilation]?
        ) bool {
            if (left?.Count ?? 0) != (right?.Count ?? 0) {
                return false
            }
            for var index = 0; index < (left?.Count ?? 0); index++ {
                if !object.ReferenceEquals(left!![index], right!![index]) {
                    return false
                }
            }
            return true
        }
        private let OwnedEffectImages ConditionalWeakTable[PortableExecutableReference, StrongBox[string]] =
        ConditionalWeakTable[PortableExecutableReference, StrongBox[string]]()
        private let OwnedEffectMetadata ConditionalWeakTable[MetadataId, StrongBox[string]] =
        ConditionalWeakTable[MetadataId, StrongBox[string]]()

        /// Bind and verify the same immutable bytes; a caller-supplied path is not image provenance.
        /// Linked-module references remain file-backed and untrusted.
        func CreateOwnedMetadataReference(
            path string,
            properties MetadataReferenceProperties = default(MetadataReferenceProperties),
            snapshots Dictionary[string, PortableExecutableReference]? = nil
        ) PortableExecutableReference {
            return if TryCreateOwnedMetadataReference(path, properties, snapshots, out var reference) {
                reference ?? throw InvalidOperationException("The owned reference was not created.")
            } else {
                MetadataReference.CreateFromFile(path, properties: properties)
            }
        }

        func TryCreateOwnedMetadataReference(
            path string,
            properties MetadataReferenceProperties,
            snapshots Dictionary[string, PortableExecutableReference]?,
            out reference PortableExecutableReference?
        ) bool {
            reference = nil
            let key = Path.GetFullPath(path)
            if snapshots != nil && snapshots.TryGetValue(key, out var snapshot) && OwnedEffectImages.TryGetValue(
                snapshot,
                out var fingerprint
            ) {
                if snapshot.Properties.Equals(properties) {
                    reference = snapshot
                    return true
                }
                let projected = snapshot.WithProperties(properties)
                OwnedEffectImages.Add(projected, fingerprint)
                reference = projected
                return true
            }
            let image = ImmutableArray.CreateRange(File.ReadAllBytes(path))
            let captured = MetadataReference.CreateFromImage(image, properties: properties, filePath: path)
            let metadata = captured.GetMetadata()
            if metadata is AssemblyMetadata assembly {
                for module in assembly.GetModules() {
                    let reader = module.GetMetadataReader()
                    for file in reader.AssemblyFiles {
                        if reader.GetAssemblyFile(file).ContainsMetadata {
                            return false
                        }
                    }
                }
            } else if metadata is ModuleMetadata module {
                let _ = module.GetMetadataReader()
            }
            let ownedFingerprint = StrongBox[string](Convert.ToHexString(SHA256.HashData(image.AsSpan())))
            OwnedEffectImages.Add(captured, ownedFingerprint)
            OwnedEffectMetadata.Add(metadata.Id, ownedFingerprint)
            if snapshots != nil {
                snapshots[key] = captured
            }
            reference = captured
            return true
        }

        internal func HasTrustedEffectImage(reference PortableExecutableReference, identity string) bool {
            if !OwnedEffectImages.TryGetValue(reference, out var fingerprint) {
                try {
                    if !OwnedEffectMetadata.TryGetValue(reference.GetMetadata().Id, out fingerprint) {
                        return false
                    }
                    OwnedEffectImages.GetValue(reference, (key PortableExecutableReference) -> fingerprint)
                } catch (error IOException) {
                    return false
                } catch (error UnauthorizedAccessException) {
                    return false
                } catch (error BadImageFormatException) {
                    return false
                }
            }
            return GSharp
                .Core
                .CodeAnalysis
                .Symbols
                .ReferenceResolver
                .IsTrustedEffectImage(System.Reflection.AssemblyName(identity), fingerprint.Value)
        }

        private let SemanticModelsByCompilation ConditionalWeakTable[
            Compilation,
            Dictionary[SyntaxTree, SemanticModel]
        ] = ConditionalWeakTable[Compilation, Dictionary[SyntaxTree, SemanticModel]]()

        /// Reads normal declaration facts without publishing privileged models.
        internal func GetSemanticModel(compilation Compilation, tree SyntaxTree) SemanticModel {
            let models = SemanticModelsByCompilation.GetOrCreateValue(compilation)
            lock models {
                if !models.TryGetValue(tree, out var model) {
                    model = compilation.GetSemanticModel(tree)
                    models[tree] = model
                }
                return model
            }
        }

        /// Reads the scoped supplied model only for its actual compilation and tree.
        internal func GetEffectiveSemanticModel(compilation Compilation, tree SyntaxTree) SemanticModel {
            let supplied = ObliviousNullabilityAnalyzer.ScopedSemanticModel
            return if supplied != nil && object.ReferenceEquals(supplied.Compilation, compilation) &&
                object.ReferenceEquals(supplied.SyntaxTree, tree) {
                supplied
            } else {
                GetSemanticModel(compilation, tree)
            }
        }

        internal func CacheSemanticModel(compilation Compilation, model SemanticModel) {
            if model.IgnoresAccessibility || model.IsSpeculativeSemanticModel || !object.ReferenceEquals(
                model.Compilation,
                compilation
            ) {
                return
            }
            let models = SemanticModelsByCompilation.GetOrCreateValue(compilation)
            lock models {
                models.TryAdd(model.SyntaxTree, model)
            }
        }
    }
}
