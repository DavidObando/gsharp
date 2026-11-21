// <copyright file="GSharpAnalyzerDriver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Linq
import System.Threading

/// Runs (cref:GSharpDiagnosticAnalyzer)s over a bound compilation
/// (ADR-0169). Dispatch order: initialize → compilation-start actions →
/// syntax-tree actions and a kind-bucketed syntax walk per tree → symbol
/// actions over declared symbols → a kind-bucketed bound-tree walk per
/// function body → semantic-model actions per tree → compilation-end and
/// compilation actions. Execution is sequential; an analyzer that throws is
/// disabled for the rest of the run (GS9300), and one that exceeds the
/// optional time budget is disabled with GS9302.
class GSharpAnalyzerDriver {
    private let compilation Compilation
    private let options AnalyzerOptions
    private let cancellationToken CancellationToken
    private let registry AnalyzerRegistry = AnalyzerRegistry()
    private let diagnostics DiagnosticBag = DiagnosticBag()
    private let disabled HashSet[GSharpDiagnosticAnalyzer] = HashSet[GSharpDiagnosticAnalyzer]()
    private let elapsed Dictionary[GSharpDiagnosticAnalyzer, Stopwatch] = Dictionary[
        GSharpDiagnosticAnalyzer,
        Stopwatch
    ]()
    private let supportedIds Dictionary[GSharpDiagnosticAnalyzer, ImmutableHashSet[string]] = Dictionary[
        GSharpDiagnosticAnalyzer,
        ImmutableHashSet[string]
    ]()
    private let reportedUnsupported HashSet[(Owner GSharpDiagnosticAnalyzer, Id string)] = HashSet[
        (Owner GSharpDiagnosticAnalyzer, Id string)
    ]()
    private var suppressions DiagnosticSuppressionMap?
    // Issue #6165: the function or field whose body the driver is dispatching, and the diagnostics that
    // each such dispatch reported.
    private var origin Symbol? = nil
    private let origins Dictionary[Diagnostic, Symbol] = Dictionary[Diagnostic, Symbol](
        ReferenceEqualityComparer.Instance
    )

    private init(compilation Compilation, options AnalyzerOptions, cancellationToken CancellationToken) {
        this.compilation = compilation
        this.options = options
        this.cancellationToken = cancellationToken
    }

    private func RunCore(analyzers ImmutableArray[GSharpDiagnosticAnalyzer]) {
        InitializeAnalyzers(analyzers)
        for entry in registry.CompilationStartActions.ToArray() {
            let context = CompilationStartAnalysisContext(registry, entry.Owner, compilation, cancellationToken)
            Guarded(entry.Owner, () -> entry.Action(context))
        }
        // Force binding once; everything below reads the cached results.
        let _ = compilation.GlobalScope
        let program = compilation.BoundProgram
        DispatchSyntax()
        DispatchSymbols(program)
        DispatchBoundNodes(program)
        DispatchBoundBodies(program)
        DispatchSemanticModels()
        for entry in registry.CompilationEndActions.Concat(registry.CompilationActions) {
            let context = CompilationAnalysisContext(compilation, Sink(entry.Owner), cancellationToken)
            Guarded(entry.Owner, () -> entry.Action(context))
        }
    }

    // Issue #6165: the actions of a run on one function body, when every analyzer is body-local.
    private func RunOnBodyCore(
        analyzers ImmutableArray[GSharpDiagnosticAnalyzer],
        function FunctionSymbol,
        body BoundBlockStatement
    ) bool {
        InitializeAnalyzers(analyzers)
        if !registry.IsBodyLocal(analyzers) {
            return false
        }
        let provenance = ProvenanceTree(function, body)
        if registry.BoundNodeActions.Count > 0 {
            origin = function
            DispatchingBoundTreeWalker(this, function, provenance is {} tree && IsGeneratedTree(tree)).Visit(body)
            origin = nil
        }
        if registry.BoundBodyActions.Count > 0 {
            DispatchBoundBody(function, body, provenance)
        }
        return true
    }

    private func InitializeAnalyzers(analyzers ImmutableArray[GSharpDiagnosticAnalyzer]) {
        for analyzer in analyzers {
            elapsed[analyzer] = Stopwatch()
            supportedIds[analyzer] = Guarded(
                analyzer,
                () -> analyzer.SupportedDiagnostics.Select((d DiagnosticDescriptor) -> d.Id).ToImmutableHashSet()
            ) ??
                ImmutableHashSet[string].Empty
            Guarded(analyzer, () -> analyzer.Initialize(AnalysisContext(registry, analyzer)))
        }
    }

    private func DispatchSyntax() {
        for tree in compilation.SyntaxTrees {
            cancellationToken.ThrowIfCancellationRequested()
            let isGenerated = IsGeneratedTree(tree)
            for entry in registry.SyntaxTreeActions {
                if SkipsGenerated(entry.Owner, isGenerated) {
                    continue
                }
                let context = SyntaxTreeAnalysisContext(tree, Sink(entry.Owner), cancellationToken)
                Guarded(entry.Owner, () -> entry.Action(context))
            }
            if registry.SyntaxNodeActions.Count == 0 {
                continue
            }
            let model = compilation.GetSemanticModel(tree)
            let walker = DispatchingSyntaxWalker(this, model, isGenerated)
            walker.Visit(tree.Root)
        }
    }

    private func DispatchSymbols(program BoundProgram) {
        if registry.SymbolActions.Count == 0 {
            return
        }
        for symbol in EnumerateDeclaredSymbols(program).Concat(compilation.GlobalScope.DeclaredTypeAliases) {
            cancellationToken.ThrowIfCancellationRequested()
            if !registry.SymbolActions.TryGetValue(symbol.Kind, out var entries) {
                continue
            }
            for entry in entries {
                let context = SymbolAnalysisContext(symbol, compilation, Sink(entry.Owner), cancellationToken)
                Guarded(entry.Owner, () -> entry.Action(context))
            }
        }
    }

    private func DispatchBoundNodes(program BoundProgram) {
        if registry.BoundNodeActions.Count == 0 {
            return
        }
        var dispatchedStatement = false
        for (function, body) in program.Functions {
            cancellationToken.ThrowIfCancellationRequested()
            let isGenerated = if object.ReferenceEquals(body, program.Statement) {
                IsEntirelyGenerated(program.Statement)
            } else {
                ProvenanceTree(function, body) is {} tree && IsGeneratedTree(tree)
            }
            origin = function
            DispatchingBoundTreeWalker(this, function, isGenerated).Visit(body)
            origin = nil
            dispatchedStatement |= object.ReferenceEquals(body, program.Statement)
        }
        if !dispatchedStatement {
            let isGenerated = IsEntirelyGenerated(program.Statement)
            DispatchingBoundTreeWalker(this, containingFunction: nil, isGenerated).Visit(program.Statement)
        }
    }

    private func DispatchBoundBodies(program BoundProgram) {
        if registry.BoundBodyActions.Count == 0 {
            return
        }
        for (function, body) in program.Functions {
            cancellationToken.ThrowIfCancellationRequested()
            DispatchBoundBody(function, body, ProvenanceTree(function, body))
        }
        // Roslyn runs operation-block actions on field-initializer blocks too,
        // owned by the field. G# keeps them on the declaring type, outside any
        // function body (not even the constructor's).
        for declaredStruct in program.Structs {
            // The owning field must answer ContainingType/ContainingNamespace,
            // as the symbol-action path anchors them (idempotent).
            SymbolContainment.AnchorMembers(declaredStruct)
            for (field, initializer) in declaredStruct.StaticFieldInitializers.Concat(
                declaredStruct.InstanceFieldInitializers
            ) {
                cancellationToken.ThrowIfCancellationRequested()
                let tree = field.Declaration?.SyntaxTree ?? initializer.FirstAnchoredSyntax()?.SyntaxTree
                DispatchBoundBody(field, initializer, tree)
            }
        }
    }

    private func DispatchBoundBody(owner Symbol, body BoundNode, provenance SyntaxTree?) {
        let isGenerated = provenance is {} tree && IsGeneratedTree(tree)
        origin = owner
        for entry in registry.BoundBodyActions {
            if SkipsGenerated(entry.Owner, isGenerated) {
                continue
            }
            let context = BoundBodyAnalysisContext(owner, body, compilation, Sink(entry.Owner), cancellationToken)
            Guarded(entry.Owner, () -> entry.Action(context))
        }
        origin = nil
    }

    private func DispatchSemanticModels() {
        if registry.SemanticModelActions.Count == 0 {
            return
        }
        for tree in compilation.SyntaxTrees {
            cancellationToken.ThrowIfCancellationRequested()
            let isGenerated = IsGeneratedTree(tree)
            let model = compilation.GetSemanticModel(tree)
            for entry in registry.SemanticModelActions {
                if SkipsGenerated(entry.Owner, isGenerated) {
                    continue
                }
                let context = SemanticModelAnalysisContext(model, Sink(entry.Owner), cancellationToken)
                Guarded(entry.Owner, () -> entry.Action(context))
            }
        }
    }

    private func SkipsGenerated(owner GSharpDiagnosticAnalyzer, isGenerated bool) bool -> isGenerated &&
        (
        !registry.GeneratedCodeFlags.TryGetValue(owner, out var flags) ||
            (flags & GeneratedCodeAnalysisFlags.Analyze) == 0
    )

    private func Sink(owner GSharpDiagnosticAnalyzer)(Diagnostic) -> void -> (diagnostic Diagnostic) -> Report(
        owner,
        diagnostic
    )

    private func Report(owner GSharpDiagnosticAnalyzer, diagnostic Diagnostic) {
        if disabled.Contains(owner) {
            return
        }
        if !supportedIds[owner].Contains(diagnostic.Id) {
            if reportedUnsupported.Add((owner, diagnostic.Id)) {
                diagnostics.Report(
                    Diagnostic.Create(
                        DiagnosticDescriptors.AnalyzerUnsupportedDiagnosticId,
                        default(TextLocation),
                        owner.GetType().Name,
                        diagnostic.Id
                    )
                )
            }
            return
        }
        if diagnostic.Descriptor is {IsEnabledByDefault: false} {
            return
        }
        if diagnostic.Location.Text is {FileName: {} fileName} && fileName.EndsWith(
            ".g.gs",
            StringComparison.OrdinalIgnoreCase
        ) &&
            (
            !registry.GeneratedCodeFlags.TryGetValue(owner, out var flags) ||
                (flags & GeneratedCodeAnalysisFlags.ReportDiagnostics) == 0
        ) {
            return
        }
        // ADR-0175 (#3820/#3824): a source `@SuppressDiagnostic("ID")` scope
        // covering this diagnostic's primary location drops it. The check sits
        // here, in the driver, so gsc, the language server, and
        // GSharpAnalyzerVerifier all honour the same scoping rule.
        suppressions ??= compilation.DiagnosticSuppressions
        if suppressions!!.IsSuppressed(diagnostic) {
            return
        }
        diagnostics.Report(diagnostic)
        if origin is {} source {
            origins[diagnostic] = source
        }
    }

    private func Result() AnalyzerRun {
        let produced = diagnostics.ToImmutableArray()
        let sources = ImmutableArray.CreateBuilder[Symbol?](produced.Length)
        for d in produced {
            sources.Add(
                if origins.TryGetValue(d, out var source) {
                    source
                } else {
                    default(Symbol?)
                }
            )
        }
        return AnalyzerRun(produced, sources.MoveToImmutable())
    }

    private func Guarded(owner GSharpDiagnosticAnalyzer, action() -> void) -> Guarded[object?](
        owner,
        () -> {
            action()
            return nil
        }
    )

    private func Guarded[T class?](owner GSharpDiagnosticAnalyzer, action() -> T) T? {
        if disabled.Contains(owner) {
            return default(T?)
        }
        let watch = elapsed[owner]
        watch.Start()
        try {
            return action()
        } catch (OperationCanceledException) when cancellationToken.IsCancellationRequested {
            rethrow
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            disabled.Add(owner)
            diagnostics.Report(
                Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerThrewException,
                    default(TextLocation),
                    owner.GetType().Name,
                    ex.GetType().Name,
                    ex.Message
                )
            )
            return default(T?)
        } finally {
            watch.Stop()
            if options.TimeBudgetMilliseconds is {} budget && watch.ElapsedMilliseconds > int64(budget) && disabled.Add(
                owner
            ) {
                diagnostics.Report(
                    Diagnostic.Create(
                        DiagnosticDescriptors.AnalyzerExceededTimeBudget,
                        default(TextLocation),
                        owner.GetType().Name,
                        budget
                    )
                )
            }
        }
    }

    /// Walks a syntax tree dispatching node actions from the registry's
    /// kind buckets.
    private class DispatchingSyntaxWalker : GSharpSyntaxWalker {
        private let driver GSharpAnalyzerDriver
        private let model SemanticModel
        private let isGenerated bool

        init(driver GSharpAnalyzerDriver, model SemanticModel, isGenerated bool) {
            this.driver = driver
            this.model = model
            this.isGenerated = isGenerated
        }

        override func Visit(node SyntaxNode?) {
            if node != nil &&
                !(node is SyntaxToken) &&
                driver
                .registry
                .SyntaxNodeActions
                .TryGetValue(node.Kind, out var entries) {
                for entry in entries {
                    if driver.SkipsGenerated(entry.Owner, isGenerated) {
                        continue
                    }
                    let context = SyntaxNodeAnalysisContext(
                        node,
                        model,
                        driver.Sink(entry.Owner),
                        driver.cancellationToken
                    )
                    driver.Guarded(entry.Owner, () -> entry.Action(context))
                }
            }
            base.Visit(node)
        }
    }

    /// Walks a bound body dispatching bound-node actions from the registry's
    /// kind buckets.
    private class DispatchingBoundTreeWalker {
        private let driver GSharpAnalyzerDriver
        private let containingFunction FunctionSymbol?
        private let isGenerated bool
        private var root BoundNode?

        init(driver GSharpAnalyzerDriver, containingFunction FunctionSymbol?, isGenerated bool) {
            this.driver = driver
            this.containingFunction = containingFunction
            this.isGenerated = isGenerated
        }

        func Visit(node BoundNode?) {
            if node == nil {
                return
            }
            root ??= node
            Dispatch(node)
            for child in node.ChildNodes {
                Visit(child)
            }
        }

        private func Dispatch(node BoundNode?) {
            if node == nil || !driver.registry.BoundNodeActions.TryGetValue(node.Kind, out var entries) {
                return
            }
            for entry in entries {
                let nodeIsGenerated = if object.ReferenceEquals(node, root) {
                    isGenerated
                } else {
                    (
                        if node.Syntax?.SyntaxTree is {} tree {
                            GSharpAnalyzerDriver.IsGeneratedTree(tree)
                        } else {
                            isGenerated
                        }
                    )
                }
                if driver.SkipsGenerated(entry.Owner, nodeIsGenerated) {
                    continue
                }
                let context = BoundNodeAnalysisContext(
                    node,
                    containingFunction,
                    driver.compilation,
                    driver.Sink(entry.Owner),
                    driver.cancellationToken
                )
                driver.Guarded(entry.Owner, () -> entry.Action(context))
            }
        }
    }

    shared {
        /// Runs the given analyzers over the compilation and returns the
        /// diagnostics they produced (plus any GS93xx host diagnostics). The
        /// compilation's cached (cref:Compilation.Compilation.BoundProgram)
        /// is used, so running after emit does not re-bind.
        /// @param compilation The compilation to analyze.
        /// @param analyzers The analyzers to run.
        /// @param options Optional host options.
        /// @param cancellationToken Cancels the run between trees, symbols, and bodies.
        /// @returns The produced diagnostics, in dispatch order.
        func Run(
            compilation Compilation,
            analyzers ImmutableArray[GSharpDiagnosticAnalyzer],
            options AnalyzerOptions? = nil,
            cancellationToken CancellationToken = default(CancellationToken)
        ) ImmutableArray[Diagnostic] {
            if analyzers.IsDefaultOrEmpty {
                return ImmutableArray[Diagnostic].Empty
            }
            using let measurement = CompilationMeasurements.BeginPhase("analyzers")
            let driver = GSharpAnalyzerDriver(compilation, options ?? AnalyzerOptions(), cancellationToken)
            driver.RunCore(analyzers)
            return driver.diagnostics.ToImmutableArray()
        }

        // Issue #6165: a run that records, for each diagnostic, the function or field whose body's
        // dispatch reported it.
        internal func RunRecordingOrigins(
            compilation Compilation,
            analyzers ImmutableArray[GSharpDiagnosticAnalyzer],
            options AnalyzerOptions?,
            cancellationToken CancellationToken
        ) AnalyzerRun {
            if analyzers.IsDefaultOrEmpty {
                return AnalyzerRun(ImmutableArray[Diagnostic].Empty, ImmutableArray[Symbol?].Empty)
            }
            using let measurement = CompilationMeasurements.BeginPhase("analyzers")
            let driver = GSharpAnalyzerDriver(compilation, options ?? AnalyzerOptions(), cancellationToken)
            driver.RunCore(analyzers)
            return driver.Result()
        }

        // Issue #6165: runs the analyzers on one function body, as a run over the compilation would
        // dispatch them on it, with the given source suppressions. It returns `null` when an analyzer is
        // not body-local in scope (AnalyzerScope.MemberBody).
        internal func TryRunOnBody(
            compilation Compilation,
            analyzers ImmutableArray[GSharpDiagnosticAnalyzer],
            options AnalyzerOptions?,
            function FunctionSymbol,
            body BoundBlockStatement,
            suppressions DiagnosticSuppressionMap,
            cancellationToken CancellationToken
        ) AnalyzerRun? {
            let driver = GSharpAnalyzerDriver(compilation, options ?? AnalyzerOptions(), cancellationToken)
            driver.suppressions = suppressions
            if !driver.RunOnBodyCore(analyzers, function, body) {
                return nil
            }
            return driver.Result()
        }

        // Issue #6165: whether every analyzer is body-local in scope. It initializes the analyzers on a
        // registry of its own.
        internal func AreBodyLocal(analyzers ImmutableArray[GSharpDiagnosticAnalyzer], compilation Compilation) bool {
            let driver = GSharpAnalyzerDriver(compilation, AnalyzerOptions(), default(CancellationToken))
            driver.InitializeAnalyzers(analyzers)
            return driver.diagnostics.Count == 0 && driver.registry.IsBodyLocal(analyzers)
        }

        private func IsEntirelyGenerated(body BoundBlockStatement) bool {
            var sawTree = false
            for statement in body.Statements {
                if statement.Syntax?.SyntaxTree is not{} tree {
                    continue
                }
                sawTree = true
                if !IsGeneratedTree(tree) {
                    return false
                }
            }
            return sawTree
        }

        // The tree a function body came from. A property accessor is synthesized
        // with no declaration of its own, so it takes its property's; failing
        // that, the first anchored node in the body says where it was written.
        private func ProvenanceTree(function FunctionSymbol, body BoundBlockStatement) SyntaxTree? -> function
            .Declaration
            ?.SyntaxTree ??
            (function.AssociatedSymbol as PropertySymbol)
            ?.Declaration
            ?.SyntaxTree ??
            body
            .FirstAnchoredSyntax()?.SyntaxTree

        private func EnumerateDeclaredSymbols(program BoundProgram) sequence[Symbol] {
            for function in program.Functions.Keys {
                yield function
            }
            for global in program.Globals {
                yield global
            }
            for declaredEnum in program.Enums {
                yield declaredEnum
            }
            for declaredDelegate in program.Delegates {
                yield declaredDelegate
            }
            for declaredInterface in program.Interfaces {
                yield declaredInterface
            }
            for declaredStruct in program.Structs {
                // ADR-0169: anchor member containment as symbols surface, so
                // analyzers can walk ContainingType/ContainingNamespace the way
                // Roslyn analyzers do (fill-once, like syntax anchoring). Issue
                // #3795 moved the anchoring itself into SymbolContainment so the
                // SemanticModel — the surface a syntax-node analyzer actually uses
                // — anchors identically.
                SymbolContainment.AnchorMembers(declaredStruct)
                yield declaredStruct
                for field in declaredStruct
                    .Fields
                    .Concat(declaredStruct.StaticFields)
                    .Concat(declaredStruct.ConstFields) {
                    yield field
                }
                for property in declaredStruct.Properties.Concat(declaredStruct.StaticProperties) {
                    yield property
                }
                for declaredEvent in declaredStruct.Events.Concat(declaredStruct.StaticEvents) {
                    yield declaredEvent
                }
            }
        }

        private func IsGeneratedTree(tree SyntaxTree) bool -> tree
            .Text
            .FileName
            ?.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase) == true
    }
}

/// The diagnostics of an analyzer run, and for each one the function or field whose body's dispatch
/// reported it, or `null` (issue #6165).
internal class AnalyzerRun {
    init(diagnostics ImmutableArray[Diagnostic], origins ImmutableArray[Symbol?]) {
        Diagnostics = diagnostics
        Origins = origins
    }

    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    prop Origins ImmutableArray[Symbol?] {
        get;
    }
}
