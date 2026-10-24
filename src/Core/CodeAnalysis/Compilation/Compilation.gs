// <copyright file="Compilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Compilation

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Threading
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Diagnostics
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Binder = GSharp.Core.CodeAnalysis.Binding.Binder
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import System.Globalization
import System.Runtime.CompilerServices

/// Chained compilation facilities.
open class Compilation {
    private let semanticModels ConditionalWeakTable[SyntaxTree, SemanticModel] = ConditionalWeakTable[
        SyntaxTree,
        SemanticModel
    ]()
    private var globalScope BoundGlobalScope?
    private var boundProgram BoundProgram?
    private var diagnosticSuppressions DiagnosticSuppressionMap?
    private var preprocessorSymbols ImmutableHashSet[string] = ImmutableHashSet[string].Empty
    private var assemblyName string?
    private var debugInformation DebugInformationOptions = DebugInformationOptions()
    // ADR-0212 §8: one gate serialises the lazy builds (single flight) and the repoint that
    // ReplaceSyntaxTree performs on this compilation's symbols. Waiters take it with their
    // request token; the build itself runs under WorkBudget.CancellationToken only.
    private let buildGate SemaphoreSlim = SemaphoreSlim(1, 1)
    private var bodyCache BoundBodyCache?
    private var incrementalBodyReuse bool
    // Set when ReplaceSyntaxTree re-points this compilation's symbols at a successor's tree.
    // A second re-point would map the wrong declarations, so a retired compilation never reuses.
    private var retired bool

    /// Initializes a new instance of the (cref:Compilation) class.
    /// @param syntaxTrees The syntax trees.
    convenience init(syntaxTrees ...SyntaxTree) {
        init(nil, syntaxTrees)
    }

    /// Initializes a new instance of the (cref:Compilation) class with
    /// an explicit reference resolver.
    /// @param references The reference resolver to use for imported CLR type lookups.
    /// @param syntaxTrees The syntax trees.
    init(references ReferenceResolver?, syntaxTrees ...SyntaxTree) {
        SyntaxTrees = syntaxTrees.ToImmutableArray()
        References = references
        ImplicitSystemImport = true
        EmbeddedResources = ImmutableArray[(Name string, Data[]uint8, IsPublic bool)].Empty
        debugInformation = CloneDebugInformation(nil)
    }

    /// Gets the syntax trees.
    prop SyntaxTrees ImmutableArray[SyntaxTree] {
        get;
    }

    /// Gets the reference resolver used to look up imported CLR types.
    prop References ReferenceResolver? {
        get;
    }

    /// Gets or sets the managed resources embedded in the runtime assembly.
    prop EmbeddedResources ImmutableArray[(Name string, Data[]uint8, IsPublic bool)]

    /// Gets or sets a value indicating whether an implicit `import System`
    /// should be seeded before user imports are processed. Defaults to
    /// `true`.
    prop ImplicitSystemImport bool

    /// Gets or sets how this compilation reads nullability-<em>oblivious</em>
    /// imported reference positions (ADR-0186, `--nullability=<mode>`).
    /// <b>Defaults to <see cref="NullabilityMode.PlatformTypes" /> since
    /// ADR-0186 step 3</b> — an oblivious imported reference position is the
    /// platform type `T!`. (cref:NullabilityMode.Enabled) selects
    /// ADR-0136's older `T?` reading and stays available.
    /// @remarks The default is read from `NullabilityOptions.DefaultMode`, which
    /// the `GSHARP_NULLABILITY` environment variable can set back to
    /// (cref:NullabilityMode.Enabled). That override exists so the
    /// full test suite can be run <em>both</em> ways from one tree, which is
    /// how the flip's before/after was measured. An embedder that sets this
    /// property always wins over it.
    ///
    /// The mode is installed as an ambient scope around binding and emit
    /// ((cref:NullabilityOptions)) because the metadata reader that
    /// consults it, `ClrNullability`, is a static leaf with no
    /// (cref:Compilation) in reach. Note that the interning caches in
    /// the `Symbols` namespace are process-wide: two compilations that
    /// disagree about this mode in one process should not share a
    /// (cref:ReferenceResolver).
    private var _nullability NullabilityMode = NullabilityOptions.DefaultMode

    prop Nullability NullabilityMode {
        get {
            return _nullability
        }
        set {
            _nullability = value
        }
    }

    /// Gets or sets a value indicating whether ADR-0186 §4's runtime nil check
    /// is inserted wherever a platform value `T!` is coerced into a
    /// non-null reference destination. Defaults to `true`.
    /// @remarks Only observable under (cref:NullabilityMode.PlatformTypes) —
    /// nothing constructs a `PlatformTypeSymbol` otherwise, so no such
    /// coercion exists to check. Turning it off
    /// (`--platform-nil-checks=off`) is a measurement and escape-hatch
    /// switch and is <b>strictly weaker than either the old or the new
    /// model</b>, not a supported mode: today many of the silenced sites are
    /// compile errors, and with checks off they are neither an error nor a
    /// check.
    private var _platformNilChecks bool = true

    prop PlatformNilChecks bool {
        get {
            return _platformNilChecks
        }
        set {
            _platformNilChecks = value
        }
    }

    /// Gets or sets a value indicating whether this compilation produces a
    /// library (a `.dll` with no entry point) as opposed to an
    /// executable. When `true`, top-level statements are an
    /// error (ADR-0066 deferred decision D4 — mirrors C#'s CS8805), since
    /// the synthesized `<Main>$` would never run from a library
    /// assembly. Defaults to `false`.
    private var _isLibrary bool = false

    prop IsLibrary bool {
        get {
            return _isLibrary
        }
        set {
            _isLibrary = value
        }
    }

    /// Gets or sets a value indicating whether emitted runtime assemblies
    /// allow JIT optimization. Defaults to `true`.
    private var _optimize bool = true

    prop Optimize bool {
        get {
            return _optimize
        }
        set {
            _optimize = value
        }
    }

    /// Gets or sets the active preprocessor symbol set used by
    /// `[Conditional("SYMBOL")]` call-site elision (ADR-0047 §6 /
    /// issue #176). A call to a function marked
    /// `[Conditional("SYMBOL")]` is elided when *none* of the named
    /// symbols is in this set; if any named symbol is present, the call is
    /// emitted normally. Defaults to (cref:ImmutableHashSet{T}.Empty)
    /// — equivalent to "no preprocessor symbols defined" — so
    /// conditional methods are elided by default unless the embedder opts
    /// in. Setting `null` is normalised to the empty set.
    @AllowNull
    prop PreprocessorSymbols ImmutableHashSet[string]? {
        get -> preprocessorSymbols
        set -> preprocessorSymbols = value ?? ImmutableHashSet[string].Empty
    }

    /// Gets or sets the PDB-related emit options. Defaults to a fresh
    /// (cref:DebugInformationOptions) instance with
    /// (cref:DebugInformationOptions.Format) set to
    /// (cref:DebugInformationFormat.None), so callers that do not
    /// opt in produce bit-for-bit identical PE output. Setting
    /// `null` is normalised to a fresh default instance.
    @AllowNull
    prop DebugInformation DebugInformationOptions? {
        get -> debugInformation
        set -> debugInformation = value ?? DebugInformationOptions()
    }

    /// Gets or sets a value indicating whether public source symbols missing
    /// documentation comments should produce GS0228 diagnostics during emit.
    /// Defaults to `false`.
    prop WarnOnMissingDocumentation bool

    /// Gets or sets the optional (cref:ILogger) instance used for
    /// host-level diagnostic logging. Defaults to (cref:NullLogger)
    /// so there is zero overhead when the host does not configure one.
    private var _logger ILogger = NullLogger.Instance

    prop Logger ILogger {
        get {
            return _logger
        }
        set {
            _logger = value
        }
    }

    /// Gets or sets a value indicating whether this compilation chain keeps a body cache so that
    /// successors built by (cref:ReplaceSyntaxTree) reuse unchanged member bodies (ADR-0105,
    /// ADR-0212). Defaults to `false`, which is the batch path: no cache, no reuse. Set it before
    /// the first query, like every other option. A successor copies the flag and shares the cache of
    /// its predecessor; (cref:WithReplacedSyntaxTree) never does.
    prop IncrementalBodyReuse bool {
        get -> incrementalBodyReuse
        set {
            incrementalBodyReuse = value
            bodyCache = if value {
                bodyCache ?? BoundBodyCache()
            } else {
                default(BoundBodyCache?)
            }
        }
    }

    /// Gets the body cache of this compilation chain, or `null` when (cref:IncrementalBodyReuse) is off.
    /// Internal for tests (ADR-0212 §9).
    internal prop BodyCache BoundBodyCache? -> bodyCache

    /// Gets or sets the shared budget for independent parse, binding, and emit work. Defaults to sequential execution.
    private var workBudget CompilationWorkBudget = CompilationWorkBudget()

    prop WorkBudget CompilationWorkBudget {
        get -> workBudget
        set -> workBudget = value
    }

    /// Gets or sets a pre-bound (cref:BoundGlobalScope) to reuse instead of re-binding from the
    /// syntax trees (ADR-0105 Phase 2). Only (cref:ReplaceSyntaxTree) sets it, after it has
    /// re-pointed the edited file's symbols at the new syntax. Internal for tests (ADR-0212 §9).
    internal prop ReusedGlobalScope BoundGlobalScope?

    /// Gets or sets the set of syntax trees whose member bodies must be re-bound from source rather
    /// than served from the body cache (ADR-0105 Phase 2). For a body-only edit this is the single
    /// re-parsed file: its unchanged-but-shifted members would otherwise cache-hit and return bodies
    /// bound at stale spans. Defaults to `null` (no forced re-bind). Internal for tests (ADR-0212 §9).
    internal prop DirtyBodyTrees ImmutableHashSet[SyntaxTree]?

    /// Runs inside the body bind while the build gate is held. Tests use it to hold a build open.
    internal prop BodyBindProbe Action?

    /// Gets or sets the assembly-identity override (e.g. from MSBuild's
    /// `AssemblyName` or the SDK). Setting this immediately pushes the
    /// value onto (cref:References)'s
    /// (cref:ReferenceResolver.CurrentAssemblyName) so binding-time
    /// internal-visibility checks ((cref:Symbols.ImportedAssemblySemantics.GrantsInternalAccessTo))
    /// see the correct consumer name regardless of whether the caller reads
    /// (cref:Diagnostics)/(cref:GlobalScope) before or after
    /// calling `Emit`. Previously this was only set inside `Emit`,
    /// so any earlier access to the lazy (cref:GlobalScope) (which
    /// caches per-consumer-assembly visibility, see
    /// `ImportedTypeSymbol.AggregateCache`) would freeze visibility with
    /// an empty assembly name. Callers that know the target assembly name
    /// up front (the gsc CLI, the language server) should set this before
    /// touching (cref:GlobalScope) or (cref:Diagnostics).
    prop AssemblyName string? {
        get -> assemblyName
        set {
            assemblyName = value
            PrepareReferencesForBinding(value)
        }
    }

    /// Gets or sets the interactive submission options (ADR-0156 Phase 2).
    /// When set, the compilation binds as one REPL submission: prior
    /// submissions' functions, globals, and types resolve as metadata-backed
    /// imports over their emitted assemblies, syntax trees without a
    /// `package` declaration fall into the submission's own package,
    /// session imports are replayed, and the trailing expression value is
    /// captured into the synthesized
    /// (cref:SubmissionImports.ResultFieldName) global for the cell
    /// echo. Defaults to `null` (ordinary compilation).
    prop Submission SubmissionBindingOptions?

    /// Gets the ADR-0175 `@SuppressDiagnostic` scopes declared in this
    /// compilation's syntax trees, built once. The analyzer driver filters
    /// analyzer diagnostics through it, and
    /// (cref:ApplySourceSuppressions) filters the compiler's own.
    prop DiagnosticSuppressions DiagnosticSuppressionMap {
        get {
            if diagnosticSuppressions == nil {
                Interlocked.CompareExchange(&diagnosticSuppressions, DiagnosticSuppressionMap.Build(SyntaxTrees), nil)
            }
            return diagnosticSuppressions!!
        }
    }

    /// Gets the global scope.
    /// @remarks The first read binds the declarations; concurrent first readers wait for that one
    /// bind instead of binding again (ADR-0212 §8).
    prop GlobalScope BoundGlobalScope -> GetGlobalScope(default(CancellationToken))

    /// Gets the fully-bound program — all function/method bodies and top-level
    /// statements, plus any diagnostics surfaced during binding.
    /// @remarks Like (cref:GlobalScope) this is lazily computed and cached on
    /// the compilation. (cref:BoundProgram) is a pure function of
    /// (cref:GlobalScope) and (cref:References); because both
    /// are immutable on a given (cref:Compilation) instance, the cache
    /// invalidates naturally whenever a new (cref:Compilation) is
    /// constructed (e.g. when the language server replaces its cached
    /// compilation after a file edit). Hot paths such as the language server's
    /// per-keystroke diagnostics, hover, definition, and semantic-token
    /// requests should reuse this cached instance rather than re-invoking
    /// (cref:Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)), which can take hundreds of
    /// milliseconds on projects with large reference graphs.
    prop BoundProgram BoundProgram -> GetBoundProgram(default(CancellationToken))

    /// Returns the global scope, binding it first when no caller has.
    /// @param cancellationToken Cancels this caller's wait for a build in flight. It never cancels the build,
    /// which runs under (cref:WorkBudget)'s token (ADR-0212 §8).
    internal func GetGlobalScope(cancellationToken CancellationToken) BoundGlobalScope {
        let published = Volatile.Read[BoundGlobalScope?](&this.globalScope)
        if published != nil {
            return published
        }
        buildGate.Wait(cancellationToken)
        try {
            return BuildGlobalScope_Locked()
        } finally {
            buildGate.Release()
        }
    }

    /// Returns the bound program, binding it first when no caller has.
    /// @param cancellationToken Cancels this caller's wait for a build in flight, never the build itself.
    internal func GetBoundProgram(cancellationToken CancellationToken) BoundProgram {
        let published = Volatile.Read[BoundProgram?](&this.boundProgram)
        if published != nil {
            return published
        }
        // The declaration bind takes the gate itself, so it must finish before this thread holds it.
        let declarations = GetGlobalScope(cancellationToken)
        buildGate.Wait(cancellationToken)
        try {
            if boundProgram != nil {
                return boundProgram!!
            }
            using let measurement = CompilationMeasurements.BeginPhase("bodies")
            // ADR-0186: body binding reads imported member signatures too.
            using let nullabilityScope = NullabilityOptions.Enter(Nullability, PlatformNilChecks)
            WorkBudget.CancellationToken.ThrowIfCancellationRequested()
            BodyBindProbe?.Invoke()
            let bp = Binder.BindProgram(declarations, References, BodyCache, DirtyBodyTrees, WorkBudget)
            CompilationMeasurements.Count("input.methods", bp.Functions.Count)
            // A cancelled build publishes nothing: the compilation is dead (ADR-0212 §8).
            WorkBudget.CancellationToken.ThrowIfCancellationRequested()
            Volatile.Write[BoundProgram?](&this.boundProgram, bp)
            return bp
        } finally {
            buildGate.Release()
        }
    }

    // Must run while the build gate is held.
    private func BuildGlobalScope_Locked() BoundGlobalScope {
        if globalScope != nil {
            return globalScope!!
        }
        WorkBudget.CancellationToken.ThrowIfCancellationRequested()
        let reused = if ReusedGlobalScope is {} candidate && !candidate.HasNativeProtocols {
            candidate
        } else {
            default(BoundGlobalScope?)
        }
        using let measurement = CompilationMeasurements.BeginPhase("declarations", reused == nil)
        if reused != nil {
            CompilationMeasurements.Count("declarations.reuses")
        }
        // Belt-and-braces: make sure References sees the current
        // assembly name before the (possibly cached, see
        // ImportedTypeSymbol.AggregateCache) binding pass runs, even
        // if the caller only ever set AssemblyName and never called
        // Emit.
        PrepareReferencesForBinding(assemblyName)
        // ADR-0186: metadata import happens under this bind, and the
        // reader that decides what an oblivious byte means is a static
        // leaf with no Compilation in reach.
        using let nullabilityScope = NullabilityOptions.Enter(Nullability, PlatformNilChecks)
        let bound = reused ?? Binder.BindGlobalScope(
            previous: nil,
            EmbeddedAttributeSource.AddEmbeddedAttributes(SyntaxTrees, References),
            References,
            ImplicitSystemImport,
            PreprocessorSymbols,
            IsLibrary,
            Submission
        )
        WorkBudget.CancellationToken.ThrowIfCancellationRequested()
        Volatile.Write[BoundGlobalScope?](&this.globalScope, bound)
        return bound
    }

    /// Returns a successor compilation in which [`newTree`](paramref) replaces [`oldTree`](paramref)
    /// (ADR-0212 §7a). The successor copies every option of this compilation except
    /// (cref:WorkBudget), which the host sets before the first query because it owns the token.
    /// @remarks When the edit changes only member bodies of one file, the successor reuses this
    /// compilation's global scope and binds only the edited file's bodies. This **retires** the
    /// predecessor: its symbols are re-pointed at [`newTree`](paramref) in place. The factory takes
    /// the build gate first, so the re-point never overlaps a build of this compilation. When
    /// (cref:IncrementalBodyReuse) is set the successor shares this compilation's body cache.
    /// Any other edit binds from scratch.
    /// @param oldTree A tree of this compilation.
    /// @param newTree The tree that replaces it.
    /// @returns The successor compilation.
    func ReplaceSyntaxTree(oldTree SyntaxTree, newTree SyntaxTree) Compilation {
        ArgumentNullException.ThrowIfNull(oldTree, paramName: "oldTree")
        ArgumentNullException.ThrowIfNull(newTree, paramName: "newTree")
        let index = SyntaxTrees.IndexOf(oldTree)
        if index < 0 {
            throw ArgumentException("The syntax tree is not part of this compilation.", "oldTree")
        }
        let successor = CreateSuccessor(SyntaxTrees.SetItem(index, newTree), shareBodyCache: true)
        // The re-point mutates this compilation's symbols, so no build may be running (ADR-0212 §8).
        // The host cancels the token of a compilation it retires; a dead compilation cannot bind, so
        // the successor then binds from scratch.
        buildGate.Wait()
        try {
            if Submission == nil && !retired {
                var declarations BoundGlobalScope? = globalScope
                if declarations == nil && !WorkBudget.CancellationToken.IsCancellationRequested {
                    declarations = BuildGlobalScope_Locked()
                }
                if IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit(declarations, oldTree, newTree) {
                    successor.ReusedGlobalScope = declarations
                    successor.DirtyBodyTrees = ImmutableHashSet.Create(newTree)
                    retired = true
                }
            }
        } finally {
            buildGate.Release()
        }
        return successor
    }

    /// Returns a successor compilation with [`trees`](paramref) added. It binds from scratch and
    /// shares this compilation's body cache when (cref:IncrementalBodyReuse) is set. This compilation
    /// is not changed.
    /// @param trees The trees to add. None may already be part of this compilation.
    /// @returns The successor compilation.
    func AddSyntaxTrees(trees ...SyntaxTree) Compilation {
        ArgumentNullException.ThrowIfNull(trees, paramName: "trees")
        var next = SyntaxTrees
        for tree in trees {
            ArgumentNullException.ThrowIfNull(tree, paramName: "trees")
            if next.Contains(tree) {
                throw ArgumentException("The syntax tree is already part of this compilation.", "trees")
            }
            next = next.Add(tree)
        }
        return CreateSuccessor(next, shareBodyCache: true)
    }

    /// Returns a successor compilation with [`trees`](paramref) removed. It binds from scratch and
    /// shares this compilation's body cache when (cref:IncrementalBodyReuse) is set. This compilation
    /// is not changed.
    /// @param trees The trees to remove. All must be part of this compilation.
    /// @returns The successor compilation.
    func RemoveSyntaxTrees(trees ...SyntaxTree) Compilation {
        ArgumentNullException.ThrowIfNull(trees, paramName: "trees")
        var next = SyntaxTrees
        for tree in trees {
            ArgumentNullException.ThrowIfNull(tree, paramName: "trees")
            let index = next.IndexOf(tree)
            if index < 0 {
                throw ArgumentException("The syntax tree is not part of this compilation.", "trees")
            }
            next = next.RemoveAt(index)
        }
        return CreateSuccessor(next, shareBodyCache: true)
    }

    /// Returns a one-shot compilation in which [`newTree`](paramref) replaces [`oldTree`](paramref),
    /// for a buffer that is not saved (ADR-0212 §7a). It binds from scratch, never re-points this
    /// compilation's symbols, and has no body cache, so it cannot evict this chain's cache entries.
    /// @param oldTree A tree of this compilation.
    /// @param newTree The tree that replaces it.
    /// @returns The snapshot compilation.
    func WithReplacedSyntaxTree(oldTree SyntaxTree, newTree SyntaxTree) Compilation {
        ArgumentNullException.ThrowIfNull(oldTree, paramName: "oldTree")
        ArgumentNullException.ThrowIfNull(newTree, paramName: "newTree")
        let index = SyntaxTrees.IndexOf(oldTree)
        if index < 0 {
            throw ArgumentException("The syntax tree is not part of this compilation.", "oldTree")
        }
        return CreateSuccessor(SyntaxTrees.SetItem(index, newTree), shareBodyCache: false)
    }

    /// Returns the declared type whose metadata name is [`fullyQualifiedMetadataName`](paramref), or
    /// `null` (ADR-0212 §7a). The name is the one the emitter writes: the package, a dot, then the
    /// type name with its own generic arity (`Box`1`); a nested type follows its enclosing type after
    /// `+`. A type without a package has no prefix.
    /// @param fullyQualifiedMetadataName The metadata name, for example `Shapes.Outer+Inner`.
    /// @param cancellationToken Cancels this caller's wait for the declaration bind, never the bind.
    /// @returns The type symbol, or `null` when this compilation declares no such type.
    func GetTypeByMetadataName(
        fullyQualifiedMetadataName string,
        cancellationToken CancellationToken = default(CancellationToken)
    ) TypeSymbol? {
        ArgumentNullException.ThrowIfNull(fullyQualifiedMetadataName, paramName: "fullyQualifiedMetadataName")
        let declarations = GetGlobalScope(cancellationToken)
        for candidate in declarations.Structs {
            if MetadataNameMatches(candidate, fullyQualifiedMetadataName) {
                return candidate
            }
        }
        for candidate in declarations.Enums {
            if MetadataNameMatches(candidate, fullyQualifiedMetadataName) {
                return candidate
            }
        }
        for candidate in declarations.Interfaces {
            if MetadataNameMatches(candidate, fullyQualifiedMetadataName) {
                return candidate
            }
        }
        for candidate in declarations.Delegates {
            if MetadataNameMatches(candidate, fullyQualifiedMetadataName) {
                return candidate
            }
        }
        return nil
    }

    // Builds a compilation over [`trees`](paramref) with this compilation's options (ADR-0212 §8).
    private func CreateSuccessor(trees ImmutableArray[SyntaxTree], shareBodyCache bool) Compilation {
        let successor = Compilation(References, trees.ToArray())
        successor.ImplicitSystemImport = ImplicitSystemImport
        successor.Nullability = Nullability
        successor.PlatformNilChecks = PlatformNilChecks
        successor.IsLibrary = IsLibrary
        successor.Optimize = Optimize
        successor.PreprocessorSymbols = PreprocessorSymbols
        successor.DebugInformation = CloneDebugInformation(DebugInformation)
        successor.WarnOnMissingDocumentation = WarnOnMissingDocumentation
        successor.Logger = Logger
        successor.Submission = Submission
        successor.EmbeddedResources = EmbeddedResources
        if assemblyName != nil {
            successor.AssemblyName = assemblyName
        }
        if shareBodyCache && incrementalBodyReuse {
            successor.incrementalBodyReuse = true
            successor.bodyCache = bodyCache
        }
        return successor
    }

    /// ADR-0175 amendment (issue #4422): removes the compiler warnings that a
    /// source `@SuppressDiagnostic("GS####")` scope covers. Every
    /// (cref:EmitResult) this compilation produces is already filtered;
    /// a host that assembles diagnostics from (cref:GlobalScope) and
    /// (cref:BoundProgram) itself (the language server) calls this so it
    /// reports exactly what gsc does. Errors are never suppressed.
    /// @param diagnostics Diagnostics produced for this compilation.
    /// @returns The diagnostics that remain visible.
    func ApplySourceSuppressions(diagnostics ImmutableArray[Diagnostic]) ImmutableArray[
        Diagnostic
    ] -> DiagnosticSuppressions.FilterCompilerDiagnostics(diagnostics)

    /// Returns a (cref:SemanticModel) answering semantic queries for
    /// [`syntaxTree`](paramref) (ADR-0169). Models are cached per tree;
    /// the first query forces (cref:BoundProgram) and builds a lazy
    /// syntax→bound index, so repeated queries are dictionary lookups.
    /// @param syntaxTree A tree belonging to this compilation.
    /// @returns The semantic model for the tree.
    func GetSemanticModel(syntaxTree SyntaxTree) SemanticModel {
        if !SyntaxTrees.Contains(syntaxTree) {
            throw ArgumentException("The syntax tree is not part of this compilation.", "syntaxTree")
        }
        return semanticModels.GetValue(syntaxTree, (tree SyntaxTree) -> SemanticModel(this, tree))
    }

    /// Emits a tree for this program to the specified writer.
    /// @param writer The writer.
    func EmitTree(writer TextWriter) {
        let program = BoundProgram
        if program.Statement.Statements.Any() {
            BoundNodePrinter.WriteTo(program.Statement, writer)
        } else {
            for functionBody in program.Functions {
                if !GlobalScope.Functions.Contains(functionBody.Key) {
                    continue
                }
                functionBody.Key.WriteTo(writer)
                BoundNodePrinter.WriteTo(functionBody.Value, writer)
            }
        }
    }

    /// Compiles the current syntax tree into a compilation result. The
    /// resulting assembly is written to `{PackageName}.dll` in the
    /// current working directory.
    /// @returns An emit result.
    func Emit() EmitResult {
        // ADR-0186: see the stream-based overload.
        using let nullabilityScope = NullabilityOptions.Enter(Nullability, PlatformNilChecks)
        let (lowered, program, diagnostics) = PrepareForEmit()
        if lowered == nil {
            return CreateEmitResult(success: false, diagnostics)
        }
        try {
            using let staged = MemoryStream()
            EmitAssembly(
                program,
                staged,
                References,
                asyncRewriteResult: lowered.AsyncRewriteResult,
                iteratorRewriteResult: lowered.IteratorRewriteResult,
                asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult,
                debugInformation: DebugInformation,
                pdbStream: nil,
                embeddedResources: EmbeddedResources
            )
            WorkBudget.CancellationToken.ThrowIfCancellationRequested()
            using let stream = File.Create(program.PackageName + ".dll")
            staged.Position = 0
            staged.CopyTo(stream)
        } catch (ex Exception) when !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) &&
            !(ex is OperationCanceledException) {
            if Environment.GetEnvironmentVariable("GS_DEBUG_STACK") != nil {
                Console.Error.WriteLine(ex.ToString())
            }
            let diagnostic = CreateInternalErrorDiagnostic(ex)
            let combined = diagnostics.Add(diagnostic)
            return CreateEmitResult(success: false, combined)
        }
        return CreateEmitResult(success: true, diagnostics)
    }

    /// Compiles the current syntax tree and writes the resulting assembly to
    /// [`peStream`](paramref). Useful for tests that don't want to touch
    /// the filesystem.
    /// @param peStream Destination stream for the PE bytes.
    /// @returns An emit result.
    func Emit(peStream Stream) EmitResult -> Emit(
        peStream,
        pdbStream: nil,
        refStream: nil,
        docStream: nil,
        assemblyName: nil
    )

    /// Compiles the current syntax tree and writes the resulting assembly to
    /// [`peStream`](paramref), optionally writing a Portable PDB stream
    /// to [`pdbStream`](paramref) when (cref:DebugInformation)
    /// requests a sidecar format. When [`refStream`](paramref) is
    /// supplied, also writes a metadata-only sibling assembly to it.
    /// @param peStream Destination stream for the PE bytes. May be `null` when only a reference assembly is
    /// desired.
    /// @param pdbStream Destination stream for the Portable PDB sidecar. Only consumed when
    /// (cref:DebugInformation)'s (cref:DebugInformationOptions.Format) is
    /// (cref:DebugInformationFormat.Portable). May be `null` in all other cases.
    /// @param refStream Optional destination stream for the metadata-only reference assembly.
    /// @param assemblyName Optional override for the assembly identity. When null, the entry-point package
    /// name is used.
    /// @param assemblyVersion Optional informational version string stamped as
    /// `AssemblyInformationalVersionAttribute`.
    /// @returns An emit result.
    func Emit(
        peStream Stream,
        pdbStream Stream?,
        refStream Stream?,
        assemblyName string? = nil,
        assemblyVersion string? = nil
    ) EmitResult -> Emit(peStream, pdbStream, refStream, docStream: nil, assemblyName, assemblyVersion)

    /// Compiles the current syntax tree and writes the resulting assembly to
    /// [`peStream`](paramref), optionally writing a Portable PDB stream
    /// to [`pdbStream`](paramref), a metadata-only sibling assembly to
    /// [`refStream`](paramref), and an XML documentation file to
    /// [`docStream`](paramref).
    /// @param peStream Destination stream for the PE bytes. May be `null` when only non-PE sidecars are
    /// desired.
    /// @param pdbStream Destination stream for the Portable PDB sidecar. Only consumed when
    /// (cref:DebugInformation)'s (cref:DebugInformationOptions.Format) is
    /// (cref:DebugInformationFormat.Portable).
    /// @param refStream Optional destination stream for the metadata-only reference assembly.
    /// @param docStream Optional destination stream for the XML documentation file.
    /// @param assemblyName Optional override for the assembly identity. When null, the entry-point package
    /// name is used.
    /// @param assemblyVersion Optional informational version string stamped as
    /// `AssemblyInformationalVersionAttribute`.
    /// @param targetFrameworkMoniker Optional long target framework moniker stamped as
    /// `TargetFrameworkAttribute`.
    /// @returns An emit result.
    func Emit(
        peStream Stream?,
        pdbStream Stream?,
        refStream Stream?,
        docStream Stream?,
        assemblyName string? = nil,
        assemblyVersion string? = nil,
        targetFrameworkMoniker string? = nil
    ) EmitResult {
        AssemblyName = assemblyName ?? AssemblyName
        // ADR-0186: emit re-reads declaration nullability through
        // `NullableFlagsBuilder`, so the mode must still be installed here and
        // not only around the lazy binding properties above.
        using let nullabilityScope = NullabilityOptions.Enter(Nullability, PlatformNilChecks)
        let (lowered, program, diagnostics) = PrepareForEmit()
        if lowered == nil {
            return CreateEmitResult(success: false, diagnostics)
        }
        try {
            using let stagedPe = MemoryStream()
            using let stagedPdb = MemoryStream()
            using let stagedReference = MemoryStream()
            using let stagedDocumentation = MemoryStream()
            if peStream != nil {
                using let measurement = CompilationMeasurements.BeginPhase("emit.implementation")
                EmitAssembly(
                    program,
                    stagedPe,
                    References,
                    assemblyName,
                    assemblyVersion,
                    metadataOnly: false,
                    asyncRewriteResult: lowered.AsyncRewriteResult,
                    iteratorRewriteResult: lowered.IteratorRewriteResult,
                    asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult,
                    debugInformation: DebugInformation,
                    pdbStream: if pdbStream == nil {
                        nil
                    } else {
                        stagedPdb
                    },
                    targetFrameworkMoniker: targetFrameworkMoniker,
                    embeddedResources: EmbeddedResources
                )
            }
            if refStream != nil {
                using let measurement = CompilationMeasurements.BeginPhase("emit.reference")
                // Reference assemblies never carry debug info — pass an explicit
                // None override so we don't accidentally write a CodeView entry
                // pointing at a sidecar that doesn't describe this PE.
                EmitAssembly(
                    program,
                    stagedReference,
                    References,
                    assemblyName,
                    assemblyVersion,
                    metadataOnly: true,
                    asyncRewriteResult: lowered.AsyncRewriteResult,
                    iteratorRewriteResult: lowered.IteratorRewriteResult,
                    asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult,
                    debugInformation: nil,
                    pdbStream: nil,
                    targetFrameworkMoniker: targetFrameworkMoniker
                )
            }
            if docStream != nil {
                using let measurement = CompilationMeasurements.BeginPhase("documentation.emit")
                DocumentationFileEmitter.Emit(stagedDocumentation, assemblyName ?? program.PackageName, program)
            }
            WorkBudget.CancellationToken.ThrowIfCancellationRequested()
            using let publication = CompilationMeasurements.BeginPhase("emit.publication")
            PublishArtifact(stagedPe, peStream)
            PublishArtifact(stagedPdb, pdbStream)
            PublishArtifact(stagedReference, refStream)
            PublishArtifact(stagedDocumentation, docStream)
        } catch (ex Exception) when !(ex is OutOfMemoryException) &&
            !(ex is StackOverflowException) &&
            !(ex is OperationCanceledException) {
            // 6.2 SilentEmitFailure invariant: widen the catch to all non-fatal
            // exceptions so that any emit-time failure (regardless of exception
            // type) produces a structured GS9998 diagnostic anchored at the
            // offending source construct. Previously this only caught
            // NotSupportedException and InvalidOperationException (#519).
            if Environment.GetEnvironmentVariable("GS_DEBUG_STACK") != nil {
                Console.Error.WriteLine(ex.ToString())
            }
            let diagnostic = CreateInternalErrorDiagnostic(ex)
            let combined = diagnostics.Add(diagnostic)
            return CreateEmitResult(success: false, combined)
        }
        return CreateEmitResult(success: true, diagnostics)
    }

    /// Compiles the current syntax tree and writes the resulting assembly to
    /// [`peStream`](paramref). When [`refStream`](paramref) is
    /// supplied, also writes a metadata-only sibling assembly (a reference
    /// assembly) to it.
    /// @param peStream Destination stream for the PE bytes. May be `null` when only a reference assembly is
    /// desired.
    /// @param refStream Optional destination stream for the metadata-only reference assembly.
    /// @returns An emit result.
    func Emit(peStream Stream, refStream Stream?) EmitResult -> Emit(
        peStream,
        pdbStream: nil,
        refStream,
        docStream: nil,
        assemblyName: nil
    )

    // A missing lowering result marks a preparation failure.
    private func PrepareForEmit()(
        Lowered LoweredProgram?,
        Program BoundProgram,
        Diagnostics ImmutableArray[Diagnostic]
    ) {
        let parseDiagnostics = SyntaxTrees.SelectMany((st SyntaxTree) -> st.Diagnostics.AsEnumerable())
        let syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray()
        var program = BoundProgram
        let allDiagnostics = syntaxDiagnostics.Concat(program.Diagnostics).ToImmutableArray()
        if allDiagnostics.Any((d Diagnostic) -> d.IsError) {
            return (nil, program, allDiagnostics)
        }
        let documentationDiagnostics = DiagnosticBag()
        using let documentationValidationPhase = CompilationMeasurements.BeginPhase("documentation.validation")
        DocumentationValidator.Validate(
            SyntaxTrees,
            program.Functions.Keys.ToImmutableArray(),
            program.Structs,
            documentationDiagnostics,
            WarnOnMissingDocumentation
        )
        documentationValidationPhase?.Dispose()
        // ADR-0055 / issue #368: lower interpolated strings to the
        // DefaultInterpolatedStringHandler pattern on the emit path only, before
        // the async/iterator rewriters and IL emission. The interpreter path is
        // untouched and renders the interpolation node directly.
        using let interpolationPhase = CompilationMeasurements.BeginPhase("lowering.interpolated-strings")
        program = InterpolatedStringHandlerLowerer.Lower(program, References ?? ReferenceResolver.Default())
        interpolationPhase?.Dispose()
        // Issue #3730: the lowering above resolves the handler surface from the
        // compilation's reference closure. Keep its targeted GS0545 safety gate
        // for an unusable resolved handler shape; a missing handler now takes
        // #3769's target-compatible String.Format fallback.
        // Deliberately scoped to GS0545: GS0519's surfacing is long-established
        // and tested, and widening this to "any error" would change it.
        if program.Diagnostics.Any(
            (d Diagnostic) -> d.Id == DiagnosticDescriptors.InterpolatedStringHandlerUnavailable.Id
        ) {
            return (nil, program, syntaxDiagnostics.Concat(program.Diagnostics).ToImmutableArray())
        }
        // Issue #452: spill side-effecting sub-expressions that sit in
        // emit-pipeline contexts which historically re-emitted them more
        // than once (compound index / property assignments, etc.). Run
        // after interpolated-string lowering and before the async /
        // iterator state machine rewriters so the spilled temps
        // participate in hoist-set computation.
        using let initializationPhase = CompilationMeasurements.BeginPhase("lowering.initialization")
        program = InitializationPlanner.Prepare(program)
        initializationPhase?.Dispose()
        using let spillPhase = CompilationMeasurements.BeginPhase("lowering.side-effects")
        program = SideEffectSpiller.Lower(program)
        spillPhase?.Dispose()
        // Issue #523: hoist captured locals/parameters into per-variable
        // box classes so function literals see writes to the variable cell
        // (Go/C# closure semantics). On the emit path, this must run after
        // side-effect spilling and before the async / iterator state-machine
        // lowerers so they see boxed captures rather than snapshots.
        // Issue #2037: thread the MLC cross-reflection-context projector so
        // box classes hoisting an imported constructed generic over an
        // enclosing type parameter don't erase it under cs2gs.
        using let capturePhase = CompilationMeasurements.BeginPhase("lowering.capture-boxing")
        program = CaptureBoxingRewriter.Lower(
            program,
            (References ?? ReferenceResolver.Default()).MapClrTypeToReferences
        )
        capturePhase?.Dispose()
        using let managedReferencePhase = CompilationMeasurements.BeginPhase("lowering.managed-references")
        program = ManagedReferenceLowerer.Lower(program, References ?? ReferenceResolver.Default())
        managedReferencePhase?.Dispose()
        // Issue #2130: after capture-boxing has introduced the closure cells
        // expression trees must reference, rewrite lambda-to-expression-tree
        // conversions into ordinary bound calls to System.Linq.Expressions
        // factory methods.
        using let expressionTreePhase = CompilationMeasurements.BeginPhase("lowering.expression-trees")
        program = ExpressionTreeLowerer.Lower(program)
        expressionTreePhase?.Dispose()
        let (lowered, loweredProgram, lowerDiagnostics) = LowerForEmit(
            program,
            References ?? ReferenceResolver.Default()
        )
        if lowerDiagnostics.Any((d Diagnostic) -> d.IsError) {
            return (nil, program, lowerDiagnostics)
        }
        program = loweredProgram
        let allWarnings = syntaxDiagnostics
            .Concat(program.Diagnostics)
            .Concat(documentationDiagnostics)
            .Concat(lowerDiagnostics)
            .Where((d Diagnostic) -> !d.IsError)
            .ToImmutableArray()
        return (lowered, program, allWarnings)
    }

    private func EmitAssembly(
        program BoundProgram,
        peStream Stream,
        references ReferenceResolver?,
        assemblyName string? = nil,
        assemblyVersion string? = nil,
        metadataOnly bool = false,
        asyncRewriteResult AsyncStateMachineRewriteResult? = nil,
        iteratorRewriteResult IteratorRewriteResult? = nil,
        asyncIteratorRewriteResult AsyncIteratorRewriteResult? = nil,
        debugInformation DebugInformationOptions? = nil,
        pdbStream Stream? = nil,
        targetFrameworkMoniker string? = nil,
        embeddedResources IReadOnlyList[(Name string, Data[]uint8, IsPublic bool)]? = nil
    ) {
        // Emit asks the native protocol feature-marker question once per member
        // and type; declarations are complete here, so answer each type once.
        // Every Emit overload funnels through this method.
        NativeProtocolSafety.BeginMemo()
        try {
            ReflectionMetadataEmitter.Emit(
                program,
                peStream,
                references,
                assemblyName,
                metadataOnly,
                asyncRewriteResult,
                iteratorRewriteResult,
                asyncIteratorRewriteResult,
                debugInformation,
                pdbStream,
                assemblyVersion,
                targetFrameworkMoniker,
                embeddedResources,
                Optimize,
                WorkBudget
            )
        } finally {
            NativeProtocolSafety.EndMemo()
        }
    }

    private func CreateEmitResult(success bool, diagnostics ImmutableArray[Diagnostic]) EmitResult -> EmitResult(
        success,
        ApplySourceSuppressions(diagnostics)
    )

    private func PublishArtifact(staged MemoryStream, destination Stream?) {
        if destination != nil && staged.Length > 0 {
            staged.Position = 0
            staged.CopyTo(destination)
        }
    }

    private func PrepareReferencesForBinding(assemblyName string?) {
        if References == nil {
            return
        }
        let references = References!!
        this.References.CurrentAssemblyName = assemblyName ?? references.CurrentAssemblyName
    }

    /// Bundle holding the results of the lowering pipeline passes.
    private class LoweredProgram {
        init(
            asyncRewriteResult AsyncStateMachineRewriteResult,
            iteratorRewriteResult IteratorRewriteResult,
            asyncIteratorRewriteResult AsyncIteratorRewriteResult
        ) {
            AsyncRewriteResult = asyncRewriteResult
            IteratorRewriteResult = iteratorRewriteResult
            AsyncIteratorRewriteResult = asyncIteratorRewriteResult
        }

        prop AsyncRewriteResult AsyncStateMachineRewriteResult {
            get;
        }

        prop IteratorRewriteResult IteratorRewriteResult {
            get;
        }

        prop AsyncIteratorRewriteResult AsyncIteratorRewriteResult {
            get;
        }
    }

    shared {
        /// Creates a GS9998 diagnostic for an unexpected compiler exception.
        /// @param ex The exception that escaped the compiler pipeline.
        /// @returns A diagnostic anchored at an (cref:EmitDiagnosticException) source
        /// node when available; otherwise a location-less diagnostic.
        internal func CreateInternalErrorDiagnostic(ex Exception) Diagnostic {
            ArgumentNullException.ThrowIfNull(ex, paramName: "ex")
            var anchoredException EmitDiagnosticException? = nil
            var rootEx = ex
            var current Exception? = ex
            while current != nil {
                rootEx = current
                if current is EmitDiagnosticException{Anchor: not nil} emitException {
                    anchoredException = emitException
                }
                current = current.InnerException
            }
            let anchor SyntaxNode? = anchoredException?.Anchor
            let location = if anchor == nil {
                default(TextLocation)
            } else {
                TextLocation(anchor.SyntaxTree.Text, anchor.Span)
            }
            // Issue #3755: an emit failure that already knows which diagnostic it
            // is — today only GS0546, "the referenced target framework does not
            // declare a member this construct lowers onto" — reports as itself.
            // Dressing a property of the user's reference closure up as GS9998
            // ("internal compiler error") would tell the user to file a bug when
            // the actionable fix is to reference the framework or package that
            // declares the member. The scan walks the whole inner chain because
            // the emit pipeline wraps failures as it unwinds.
            var withId Exception? = ex
            while withId != nil {
                if withId is EmitDiagnosticException{DiagnosticId: {} id} identified {
                    let identifiedLocation = if identified.Anchor == nil {
                        location
                    } else {
                        TextLocation(identified.Anchor.SyntaxTree.Text, identified.Anchor.Span)
                    }
                    return Diagnostic(identifiedLocation, id, DiagnosticSeverity.Error, identified.Message)
                }
                withId = withId.InnerException
            }
            let typeName = rootEx.GetType().Name
            let message = "$typeName: ${rootEx.Message}"
            return Diagnostic(location, "GS9998", DiagnosticSeverity.Error, message)
        }

        /// The canonical async/iterator lowering pipeline. Runs all rewriter
        /// passes in the correct order and gates unsupported constructs via
        /// (cref:Lowering.Async.AsyncEmitPrecheck).
        /// @remarks Ordering: the rewriters run first because
        /// (cref:Lowering.Async.AsyncEmitPrecheck.Check) inspects
        /// (cref:FunctionSymbol.StateMachineType) which is populated by
        /// (cref:Lowering.Async.AsyncStateMachineRewriter.Rewrite). The
        /// precheck cannot move before the rewriters without losing the ability
        /// to distinguish successfully-lowered async methods from those that
        /// failed builder resolution.
        private func LowerForEmit(program BoundProgram, references ReferenceResolver?)(
            Lowered LoweredProgram,
            Program BoundProgram,
            Diagnostics ImmutableArray[Diagnostic]
        ) {
            var program = program
            // Run the rewriter passes.
            // Issue #1467: route base.M() calls inside async/iterator bodies through
            // synthesized non-virtual forwarders BEFORE the state-machine rewriters,
            // so the hoisted `<>4__this` receiver never reaches a non-virtual base
            // call (ilverify ThisMismatch).
            using let baseCallPhase = CompilationMeasurements.BeginPhase("lowering.base-calls")
            program = BaseCallForwarderRewriter.Rewrite(program)
            baseCallPhase?.Dispose()
            using let asyncPhase = CompilationMeasurements.BeginPhase("lowering.async")
            let asyncRewriteResult = AsyncStateMachineRewriter.Rewrite(program, references)
            asyncPhase?.Dispose()
            using let iteratorPhase = CompilationMeasurements.BeginPhase("lowering.iterators")
            let iteratorRewriteResult = IteratorRewriter.Rewrite(program)
            iteratorPhase?.Dispose()
            using let asyncIteratorPhase = CompilationMeasurements.BeginPhase("lowering.async-iterators")
            let asyncIteratorRewriteResult = AsyncIteratorRewriter.Rewrite(program, references)
            asyncIteratorPhase?.Dispose()
            // Gate: fail fast on unsupported async constructs after lowering.
            // This runs after the rewriters because it inspects StateMachineType
            // which is set during AsyncStateMachineRewriter.Rewrite.
            // Binder errors return before lowering; only lowerer-added errors can reach this gate.
            let diagnostics = program
                .Diagnostics
                .Where((d Diagnostic) -> d.IsError)
                .Concat(AsyncEmitPrecheck.Check(program))
                .ToImmutableArray()
            let lowered = LoweredProgram(asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult)
            return (lowered, program, diagnostics)
        }

        // The metadata name the emitter gives a declared type (TypeDefEmitter): package and dot, or the
        // enclosing type's name and `+`, then the name with the arity the type declares itself.
        private func MetadataNameMatches(symbol TypeSymbol, name string) bool -> string.Equals(
            GetMetadataName(symbol),
            name,
            StringComparison.Ordinal
        )

        private func GetMetadataName(symbol TypeSymbol) string? {
            var packageName string? = nil
            var simpleName string? = nil
            if symbol is StructSymbol declaredStruct {
                packageName = declaredStruct.PackageName
                let ownArity = if declaredStruct.Declaration == nil {
                    declaredStruct.TypeParameters.Length
                } else {
                    declaredStruct.Declaration!!.TypeParameterList?.Parameters.Count ?? 0
                }
                simpleName = if ownArity == 0 {
                    declaredStruct.Name
                } else {
                    declaredStruct.Name + "`" + ownArity.ToString(CultureInfo.InvariantCulture)
                }
            } else if symbol is EnumSymbol declaredEnum {
                packageName = declaredEnum.PackageName
                simpleName = TypeDefEmitter.MangleGenericName(declaredEnum.Name, declaredEnum.TypeParameters)
            } else if symbol is InterfaceSymbol declaredInterface {
                packageName = declaredInterface.PackageName
                simpleName = TypeDefEmitter.MangleGenericName(declaredInterface.Name, declaredInterface.TypeParameters)
            } else if symbol is DelegateTypeSymbol declaredDelegate {
                packageName = declaredDelegate.PackageName
                simpleName = TypeDefEmitter.MangleGenericName(declaredDelegate.Name, declaredDelegate.TypeParameters)
            }
            if simpleName == nil {
                return nil
            }
            if symbol.ContainingType is {} enclosing {
                let enclosingName = GetMetadataName(enclosing)
                return if enclosingName == nil {
                    default(string?)
                } else {
                    enclosingName + "+" + simpleName
                }
            }
            return if string.IsNullOrEmpty(packageName) {
                simpleName
            } else {
                packageName + "." + simpleName
            }
        }

        private func CloneDebugInformation(source DebugInformationOptions?) DebugInformationOptions {
            if source == nil {
                return DebugInformationOptions()
            }
            return DebugInformationOptions{
                Format: source.Format,
                PdbFilePath: source.PdbFilePath,
                SourceLinkFilePath: source.SourceLinkFilePath,
                Deterministic: source.Deterministic
            }
        }
    }
}
