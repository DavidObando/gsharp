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
class TranslationContext {
    private let diagnostics List[TranslationDiagnostic] = List[TranslationDiagnostic]()

    // Keyed by the syntax tree instance, so two in-memory trees without a file
    // path never collide.
    private let reportedOnce HashSet[
        (Id string?, Tree SyntaxTree?, Start int32, Length int32, Discriminator string?, Message string?)
    ] = HashSet[(Id string?, Tree SyntaxTree?, Start int32, Length int32, Discriminator string?, Message string?)]()

    private var suppressDiagnosticsDepth int32

    // Issue #1910: a partial type's other declarations live in different
    // `SyntaxTree`s than the one this context was created for, so resolving a
    // symbol on one of their members requires a `SemanticModel` bound to THAT
    // tree — the active model throws "node is not within syntax tree"
    // otherwise. `UseSemanticModelFor` temporarily swaps the active model
    // while a partial declaration's own members are translated; this cache
    // avoids re-creating a `SemanticModel` per member for the same tree.
    private let modelsByTree Dictionary[SyntaxTree, SemanticModel] = Dictionary[SyntaxTree, SemanticModel]()

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

    private let rootCompilation CSharpCompilation

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
        this.modelsByTree[this.SemanticModel.SyntaxTree] = this.SemanticModel
        CacheSemanticModel(this.Compilation, this.SemanticModel)
        this.FilePath = filePath
        this.CancellationToken = cancellationToken
        this.siblingCompilations = siblingCompilations
        this.repositoryCompilations = repositoryCompilations
        ObliviousNullabilityAnalyzer.RegisterSourceAssemblies(
            this.Compilation,
            this.repositoryCompilations ?? this.siblingCompilations
        )
    }

    /// Gets the root C# compilation this context was created for.
    prop RootCompilation CSharpCompilation -> this.rootCompilation

    prop CancellationToken CancellationToken {
        get;
    }
    internal var StorageEffectBodyVisits int32

    internal class StorageIndexes {
        var AliasedFields HashSet[IFieldSymbol]?
        var Methods Dictionary[string, List[IMethodSymbol]]?
        var DeferredFactories List[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]?
        let Iterators HashSet[IMethodSymbol] = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
        let ComparerFactories List[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax] =
        List[Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax]()
        var TreeVisits int32
    }

    internal prop EffectIndexes StorageIndexes -> StorageIndexesByCompilation.GetOrCreateValue(this.rootCompilation)

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
    func UseSemanticModelFor(tree SyntaxTree?) IDisposable {
        if tree == nil || tree == this.SemanticModel.SyntaxTree {
            return NoOpScope.Instance
        }
        this.modelsByTree.TryAdd(this.SemanticModel.SyntaxTree, this.SemanticModel)
        var ownerCompilation CSharpCompilation = this.Compilation
        if this.modelsByTree.TryGetValue(tree, out var model) {
            ownerCompilation = (model.Compilation as CSharpCompilation) ?? ownerCompilation
        } else {
            if !ownerCompilation.ContainsSyntaxTree(tree) {
                if this.rootCompilation.ContainsSyntaxTree(tree) {
                    ownerCompilation = this.rootCompilation
                } else {
                    for candidate in this.SourceCompilations() {
                        if candidate != nil && candidate.ContainsSyntaxTree(tree) {
                            ownerCompilation = candidate
                            break
                        }
                    }
                }
            }
            model = GetSemanticModel(ownerCompilation, tree)
            this.modelsByTree[tree] = model
        }
        let previousCompilation = this.Compilation
        let previousModel = this.SemanticModel
        this.Compilation = ownerCompilation
        this.SemanticModel = model
        return RestoreModelScope(this, previousCompilation, previousModel)
    }

    internal func SourceCompilations(includeSiblingLookup bool = true) IReadOnlyList[CSharpCompilation] {
        let result = List[CSharpCompilation]()
        let pending = Queue[CSharpCompilation]()
        let seen = HashSet[CSharpCompilation](ReferenceEqualityComparer.Instance)
        pending.Enqueue(this.rootCompilation)
        if includeSiblingLookup {
            for compilation in(this.repositoryCompilations ?? Array.Empty[CSharpCompilation]()).Concat(
                this.siblingCompilations ?? Array.Empty[CSharpCompilation]()
            ) {
                pending.Enqueue(compilation)
            }
        }
        while pending.Count > 0 {
            this.CancellationToken.ThrowIfCancellationRequested()
            let compilation = pending.Dequeue()
            if !seen.Add(compilation) {
                continue
            }
            result.Add(compilation)
            for reference in compilation.References.OfType[CompilationReference]() {
                if reference.Compilation is CSharpCompilation source {
                    pending.Enqueue(source)
                }
            }
        }
        return result
    }

    internal func GetOwnedSemanticModel(tree SyntaxTree) SemanticModel {
        using let owner = this.UseSemanticModelFor(tree)
        return this.SemanticModel
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
        private let StorageIndexesByCompilation ConditionalWeakTable[CSharpCompilation, StorageIndexes] =
        ConditionalWeakTable[CSharpCompilation, StorageIndexes]()
        private let OwnedEffectImages ConditionalWeakTable[PortableExecutableReference, StrongBox[string]] =
        ConditionalWeakTable[PortableExecutableReference, StrongBox[string]]()

        /// Bind and verify the same immutable bytes; a caller-supplied path is not image provenance.
        func CreateOwnedMetadataReference(
            path string,
            properties MetadataReferenceProperties = default(MetadataReferenceProperties),
            snapshots Dictionary[string, PortableExecutableReference]? = nil
        ) PortableExecutableReference {
            let key = Path.GetFullPath(path)
            if snapshots != nil && snapshots.TryGetValue(key, out var snapshot) && OwnedEffectImages.TryGetValue(
                snapshot,
                out var fingerprint
            ) {
                if snapshot.Properties.Equals(properties) {
                    return snapshot
                }
                let projected = snapshot.WithProperties(properties)
                OwnedEffectImages.Add(projected, fingerprint)
                return projected
            }
            let image = ImmutableArray.CreateRange(File.ReadAllBytes(path))
            let reference = MetadataReference.CreateFromImage(image, properties: properties, filePath: path)
            OwnedEffectImages.Add(reference, StrongBox[string](Convert.ToHexString(SHA256.HashData(image.AsSpan()))))
            if snapshots != nil {
                snapshots[key] = reference
            }
            return reference
        }

        internal func HasTrustedEffectImage(reference PortableExecutableReference, identity string) bool ->
        OwnedEffectImages.TryGetValue(reference, out var fingerprint) &&
            GSharp
            .Core
            .CodeAnalysis
            .Symbols
            .ReferenceResolver
            .IsTrustedEffectImage(System.Reflection.AssemblyName(identity), fingerprint.Value)

        private let SemanticModelsByCompilation ConditionalWeakTable[
            Compilation,
            Dictionary[SyntaxTree, SemanticModel]
        ] = ConditionalWeakTable[Compilation, Dictionary[SyntaxTree, SemanticModel]]()

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

        internal func CacheSemanticModel(compilation Compilation, model SemanticModel) {
            if model.IgnoresAccessibility || !object.ReferenceEquals(model.Compilation, compilation) {
                return
            }
            let models = SemanticModelsByCompilation.GetOrCreateValue(compilation)
            lock models {
                models.TryAdd(model.SyntaxTree, model)
            }
        }
    }
}
