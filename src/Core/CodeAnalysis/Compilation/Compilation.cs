// <copyright file="Compilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Binder = GSharp.Core.CodeAnalysis.Binding.Binder;

namespace GSharp.Core.CodeAnalysis.Compilation;

/// <summary>
/// Chained compilation facilities.
/// </summary>
public class Compilation
{
    private BoundGlobalScope globalScope;
    private BoundProgram boundProgram;
    private ImmutableHashSet<string> preprocessorSymbols = ImmutableHashSet<string>.Empty;
    private DebugInformationOptions debugInformation = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="Compilation"/> class.
    /// </summary>
    /// <param name="syntaxTrees">The syntax trees.</param>
    public Compilation(params SyntaxTree[] syntaxTrees)
        : this(null, references: null, syntaxTrees)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Compilation"/> class with
    /// an explicit reference resolver.
    /// </summary>
    /// <param name="references">The reference resolver to use for imported CLR type lookups.</param>
    /// <param name="syntaxTrees">The syntax trees.</param>
    public Compilation(ReferenceResolver references, params SyntaxTree[] syntaxTrees)
        : this(null, references, syntaxTrees)
    {
    }

    private Compilation(Compilation previous, ReferenceResolver references, SyntaxTree[] syntaxTrees)
    {
        Previous = previous;
        SyntaxTrees = syntaxTrees.ToImmutableArray();
        References = references ?? previous?.References;
        ImplicitSystemImport = previous?.ImplicitSystemImport ?? true;
        IsLibrary = previous?.IsLibrary ?? false;
        PreprocessorSymbols = previous?.PreprocessorSymbols ?? ImmutableHashSet<string>.Empty;
        WarnOnMissingDocumentation = previous?.WarnOnMissingDocumentation ?? false;
        debugInformation = CloneDebugInformation(previous?.DebugInformation);
    }

    /// <summary>
    /// Gets the previous compilation.
    /// </summary>
    public Compilation Previous { get; }

    /// <summary>
    /// Gets the syntax trees.
    /// </summary>
    public ImmutableArray<SyntaxTree> SyntaxTrees { get; }

    /// <summary>
    /// Gets the reference resolver used to look up imported CLR types.
    /// </summary>
    public ReferenceResolver References { get; }

    /// <summary>
    /// Gets or sets a value indicating whether an implicit <c>import System</c>
    /// should be seeded before user imports are processed. Defaults to
    /// <see langword="true"/>.
    /// </summary>
    public bool ImplicitSystemImport { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this compilation produces a
    /// library (a <c>.dll</c> with no entry point) as opposed to an
    /// executable. When <see langword="true"/>, top-level statements are an
    /// error (ADR-0066 deferred decision D4 — mirrors C#'s CS8805), since
    /// the synthesized <c>&lt;Main&gt;$</c> would never run from a library
    /// assembly. Defaults to <see langword="false"/>. Inherits from
    /// <see cref="Previous"/> when chained, matching the inheritance shape
    /// of <see cref="ImplicitSystemImport"/>.
    /// </summary>
    public bool IsLibrary { get; set; } = false;

    /// <summary>
    /// Gets or sets the active preprocessor symbol set used by
    /// <c>[Conditional("SYMBOL")]</c> call-site elision (ADR-0047 §6 /
    /// issue #176). A call to a function marked
    /// <c>[Conditional("SYMBOL")]</c> is elided when *none* of the named
    /// symbols is in this set; if any named symbol is present, the call is
    /// emitted normally. Defaults to <see cref="ImmutableHashSet{T}.Empty"/>
    /// — equivalent to "no preprocessor symbols defined" — so
    /// conditional methods are elided by default unless the embedder opts
    /// in. Setting <c>null</c> is normalised to the empty set. Inherits
    /// from <see cref="Previous"/> when chained, matching the inheritance
    /// shape of <see cref="ImplicitSystemImport"/>.
    /// </summary>
    public ImmutableHashSet<string> PreprocessorSymbols
    {
        get => preprocessorSymbols;
        set => preprocessorSymbols = value ?? ImmutableHashSet<string>.Empty;
    }

    /// <summary>
    /// Gets or sets the PDB-related emit options. Defaults to a fresh
    /// <see cref="DebugInformationOptions"/> instance with
    /// <see cref="DebugInformationOptions.Format"/> set to
    /// <see cref="DebugInformationFormat.None"/>, so callers that do not
    /// opt in produce bit-for-bit identical PE output. Inherits from
    /// <see cref="Previous"/> when chained, mirroring
    /// <see cref="ImplicitSystemImport"/> / <see cref="PreprocessorSymbols"/>.
    /// Setting <see langword="null"/> is normalised to a fresh default
    /// instance.
    /// </summary>
    public DebugInformationOptions DebugInformation
    {
        get => debugInformation;
        set => debugInformation = value ?? new DebugInformationOptions();
    }

    /// <summary>
    /// Gets or sets a value indicating whether public source symbols missing
    /// documentation comments should produce GS0228 warnings during emit.
    /// Defaults to <see langword="false"/>.
    /// </summary>
    public bool WarnOnMissingDocumentation { get; set; }

    /// <summary>
    /// Gets or sets the optional per-project bound-body cache (ADR-0105
    /// Phase 1). When set, <see cref="BoundProgram"/> threads it through
    /// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache)"/>
    /// so unchanged member bodies can be reused across compilations <em>when
    /// reuse is provably sound</em> (see <see cref="BoundBodyCache"/>). The
    /// cache is owned externally (by the language server's per-project
    /// <c>ProjectState</c>) and lives across the immutable, per-edit
    /// <see cref="Compilation"/> instances; it never changes emitted IL or
    /// diagnostics relative to the full-rebuild path. Defaults to
    /// <see langword="null"/>, which is exactly the historical behavior.
    /// </summary>
    public BoundBodyCache BodyCache { get; set; }

    /// <summary>
    /// Gets or sets a pre-bound <see cref="BoundGlobalScope"/> to reuse instead
    /// of re-binding from the syntax trees (ADR-0105 Phase 2). The language
    /// server sets this when a single-file, body-only edit lets the previous
    /// compilation's global scope (and therefore every symbol instance) be
    /// reused — the prerequisite for the <see cref="BoundBodyCache"/>'s
    /// symbol-identity soundness gate to hit and for the emitter, which keys
    /// members by reference, to remain correct. When set, <see cref="GlobalScope"/>
    /// returns it verbatim instead of re-binding from the syntax trees.
    /// The edited file's symbols are expected to have been re-pointed at the new
    /// syntax via <see cref="IncrementalGlobalScopeReuse.TryRepointBodyOnlyEdit"/>
    /// before this is set. Defaults to <see langword="null"/> (full rebuild).
    /// </summary>
    public BoundGlobalScope ReusedGlobalScope { get; set; }

    /// <summary>
    /// Gets or sets the set of syntax trees whose member bodies must be re-bound
    /// from source rather than served from the <see cref="BoundBodyCache"/>
    /// (ADR-0105 Phase 2). For a body-only edit this is the single re-parsed
    /// file: its unchanged-but-shifted members would otherwise cache-hit and
    /// return bodies bound at stale spans, so they are forced to rebind (which
    /// then refreshes their cached entry). Unchanged files are absent and hit
    /// the cache. Defaults to <see langword="null"/> (no forced re-bind).
    /// </summary>
    public System.Collections.Immutable.ImmutableHashSet<SyntaxTree> DirtyBodyTrees { get; set; }

    /// <summary>
    /// Gets the global scope.
    /// </summary>
    public BoundGlobalScope GlobalScope
    {
        get
        {
            if (globalScope == null)
            {
                var globalScope = ReusedGlobalScope
                    ?? Binder.BindGlobalScope(Previous?.GlobalScope, SyntaxTrees, References, ImplicitSystemImport, PreprocessorSymbols, IsLibrary);
                Interlocked.CompareExchange(ref this.globalScope, globalScope, null);
            }

            return globalScope;
        }
    }

    /// <summary>
    /// Gets the fully-bound program — all function/method bodies and top-level
    /// statements, plus any diagnostics surfaced during binding.
    /// </summary>
    /// <remarks>
    /// Like <see cref="GlobalScope"/> this is lazily computed and cached on
    /// the compilation. <see cref="BoundProgram"/> is a pure function of
    /// <see cref="GlobalScope"/> and <see cref="References"/>; because both
    /// are immutable on a given <see cref="Compilation"/> instance, the cache
    /// invalidates naturally whenever a new <see cref="Compilation"/> is
    /// constructed (e.g. when the language server replaces its cached
    /// compilation after a file edit). Hot paths such as the language server's
    /// per-keystroke diagnostics, hover, definition, and semantic-token
    /// requests should reuse this cached instance rather than re-invoking
    /// <see cref="Binder.BindProgram(BoundGlobalScope, Symbols.ReferenceResolver)"/>, which can take hundreds of
    /// milliseconds on projects with large reference graphs.
    /// </remarks>
    public BoundProgram BoundProgram
    {
        get
        {
            if (boundProgram == null)
            {
                var bp = Binder.BindProgram(GlobalScope, References, BodyCache, DirtyBodyTrees);
                Interlocked.CompareExchange(ref this.boundProgram, bp, null);
            }

            return boundProgram;
        }
    }

    /// <summary>
    /// Continue the compilation with the specified syntax tree chained to the
    /// current compilation.
    /// </summary>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <returns>The chained compilation.</returns>
    public Compilation ContinueWith(params SyntaxTree[] syntaxTrees)
    {
        return new Compilation(this, references: null, syntaxTrees);
    }

    /// <summary>
    /// Evaluates the current compilation provided a symbol table with actual values.
    /// </summary>
    /// <param name="variables">The symbol table with actual values.</param>
    /// <returns>An evaluation result.</returns>
    public EvaluationResult Evaluate(Dictionary<VariableSymbol, object> variables)
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var diagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();

        var program = Binder.BindProgram(GlobalScope, References);

        var allErrors = diagnostics
            .Concat(program.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();

        var allWarnings = diagnostics
            .Concat(program.Diagnostics)
            .Where(d => !d.IsError)
            .ToImmutableArray();

        if (allErrors.Any())
        {
            return new EvaluationResult(allWarnings.Concat(allErrors).ToImmutableArray(), null);
        }

        var appPath = Environment.GetCommandLineArgs()[0];
        var appDirectory = Path.GetDirectoryName(appPath);
        var cfgPath = Path.Combine(appDirectory, "cfg.dot");
        var cfgStatement = !program.Statement.Statements.Any() && program.Functions.Any()
                              ? program.Functions.Last().Value
                              : program.Statement;
        var cfg = ControlFlowGraph.Create(cfgStatement);
        using (var streamWriter = new StreamWriter(cfgPath))
        {
            cfg.WriteTo(streamWriter);
        }

        var evaluator = new Evaluator(program, variables);
        try
        {
            var value = evaluator.Evaluate();
            return new EvaluationResult(allWarnings, value);
        }
        catch (EvaluatorException ex)
        {
            using var textWriter = new StringWriter();
            ex.Node?.WriteTo(textWriter);
            var sourceText = SourceText.From(textWriter.ToString());
            var location = new TextLocation(sourceText, new TextSpan(0, sourceText.Length));
            var message = ex.Message;
            var diagnostic = new Diagnostic(location, "GS9999", DiagnosticSeverity.Error, message);
            return new EvaluationResult(allWarnings.Add(diagnostic), null);
        }
    }

    /// <summary>
    /// Emits a tree for this program to the specified writer.
    /// </summary>
    /// <param name="writer">The writer.</param>
    public void EmitTree(TextWriter writer)
    {
        var program = Binder.BindProgram(GlobalScope, References);

        if (program.Statement.Statements.Any())
        {
            program.Statement.WriteTo(writer);
        }
        else
        {
            foreach (var functionBody in program.Functions)
            {
                if (!GlobalScope.Functions.Contains(functionBody.Key))
                {
                    continue;
                }

                functionBody.Key.WriteTo(writer);
                functionBody.Value.WriteTo(writer);
            }
        }
    }

    /// <summary>
    /// Compiles the current syntax tree into a compilation result. The
    /// resulting assembly is written to <c>{PackageName}.dll</c> in the
    /// current working directory.
    /// </summary>
    /// <returns>An emit result.</returns>
    public EmitResult Emit()
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();

        var program = Binder.BindProgram(GlobalScope, References);

        var allDiagnostics = syntaxDiagnostics.Concat(program.Diagnostics).ToImmutableArray();
        if (allDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, allDiagnostics);
        }

        var documentationDiagnostics = new DiagnosticBag();
        DocumentationValidator.Validate(
            SyntaxTrees,
            program.Functions.Keys.ToImmutableArray(),
            program.Structs,
            documentationDiagnostics,
            WarnOnMissingDocumentation);

        // ADR-0055 / issue #368: lower interpolated strings to the
        // DefaultInterpolatedStringHandler pattern on the emit path only, before
        // the async/iterator rewriters and IL emission. The interpreter path is
        // untouched and renders the interpolation node directly.
        program = Lowering.InterpolatedStringHandlerLowerer.Lower(program);

        // Issue #452: spill side-effecting sub-expressions that sit in
        // emit-pipeline contexts which historically re-emitted them more
        // than once (compound index / property assignments, etc.). Run
        // after interpolated-string lowering and before the async /
        // iterator state machine rewriters so the spilled temps
        // participate in hoist-set computation.
        program = Lowering.SideEffectSpiller.Lower(program);

        // Issue #523: hoist captured locals/parameters into per-variable
        // box classes so function literals see writes to the variable cell
        // (Go/C# closure semantics). Must run after side-effect spilling
        // and before the async / iterator state-machine lowerers so they
        // see the boxed captures rather than the snapshot-by-value pattern.
        program = Lowering.CaptureBoxingRewriter.Lower(program);

        var (lowered, lowerDiagnostics) = LowerForEmit(program, References ?? Symbols.ReferenceResolver.Default());
        if (lowerDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, lowerDiagnostics);
        }

        var allWarnings = syntaxDiagnostics
            .Concat(program.Diagnostics)
            .Concat(documentationDiagnostics)
            .Concat(lowerDiagnostics)
            .Where(d => !d.IsError)
            .ToImmutableArray();

        try
        {
            using var stream = File.Create(program.PackageName + ".dll");
            EmitAssembly(program, stream, References, asyncRewriteResult: lowered.AsyncRewriteResult, iteratorRewriteResult: lowered.IteratorRewriteResult, asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult, debugInformation: DebugInformation, pdbStream: null);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            var diagnostic = BuildEmitFailureDiagnostic(ex);
            var combined = allWarnings.Add(diagnostic);
            return new EmitResult(success: false, combined);
        }

        return new EmitResult(success: true, diagnostics: allWarnings);
    }

    /// <summary>
    /// Compiles the current syntax tree and writes the resulting assembly to
    /// <paramref name="peStream"/>. Useful for tests that don't want to touch
    /// the filesystem.
    /// </summary>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    /// <returns>An emit result.</returns>
    public EmitResult Emit(Stream peStream) => Emit(peStream, pdbStream: null, refStream: null, docStream: null, assemblyName: null);

    /// <summary>
    /// Compiles the current syntax tree and writes the resulting assembly to
    /// <paramref name="peStream"/>, optionally writing a Portable PDB stream
    /// to <paramref name="pdbStream"/> when <see cref="DebugInformation"/>
    /// requests a sidecar format. When <paramref name="refStream"/> is
    /// supplied, also writes a metadata-only sibling assembly to it.
    /// </summary>
    /// <param name="peStream">Destination stream for the PE bytes. May be <c>null</c> when only a reference assembly is desired.</param>
    /// <param name="pdbStream">Destination stream for the Portable PDB sidecar. Only consumed when <see cref="DebugInformation"/>'s <see cref="DebugInformationOptions.Format"/> is <see cref="DebugInformationFormat.Portable"/>. May be <c>null</c> in all other cases.</param>
    /// <param name="refStream">Optional destination stream for the metadata-only reference assembly.</param>
    /// <param name="assemblyName">Optional override for the assembly identity. When null, the entry-point package name is used.</param>
    /// <param name="assemblyVersion">Optional informational version string stamped as <c>AssemblyInformationalVersionAttribute</c>.</param>
    /// <returns>An emit result.</returns>
    public EmitResult Emit(Stream peStream, Stream pdbStream, Stream refStream, string assemblyName = null, string assemblyVersion = null)
        => Emit(peStream, pdbStream, refStream, docStream: null, assemblyName, assemblyVersion);

    /// <summary>
    /// Compiles the current syntax tree and writes the resulting assembly to
    /// <paramref name="peStream"/>, optionally writing a Portable PDB stream
    /// to <paramref name="pdbStream"/>, a metadata-only sibling assembly to
    /// <paramref name="refStream"/>, and an XML documentation file to
    /// <paramref name="docStream"/>.
    /// </summary>
    /// <param name="peStream">Destination stream for the PE bytes. May be <c>null</c> when only non-PE sidecars are desired.</param>
    /// <param name="pdbStream">Destination stream for the Portable PDB sidecar. Only consumed when <see cref="DebugInformation"/>'s <see cref="DebugInformationOptions.Format"/> is <see cref="DebugInformationFormat.Portable"/>.</param>
    /// <param name="refStream">Optional destination stream for the metadata-only reference assembly.</param>
    /// <param name="docStream">Optional destination stream for the XML documentation file.</param>
    /// <param name="assemblyName">Optional override for the assembly identity. When null, the entry-point package name is used.</param>
    /// <param name="assemblyVersion">Optional informational version string stamped as <c>AssemblyInformationalVersionAttribute</c>.</param>
    /// <returns>An emit result.</returns>
    public EmitResult Emit(Stream peStream, Stream pdbStream, Stream refStream, Stream docStream, string assemblyName = null, string assemblyVersion = null)
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();

        var program = Binder.BindProgram(GlobalScope, References);

        var allDiagnostics = syntaxDiagnostics.Concat(program.Diagnostics).ToImmutableArray();
        if (allDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, allDiagnostics);
        }

        var documentationDiagnostics = new DiagnosticBag();
        DocumentationValidator.Validate(
            SyntaxTrees,
            program.Functions.Keys.ToImmutableArray(),
            program.Structs,
            documentationDiagnostics,
            WarnOnMissingDocumentation);

        // ADR-0055 / issue #368: lower interpolated strings to the
        // DefaultInterpolatedStringHandler pattern on the emit path only, before
        // the async/iterator rewriters and IL emission. The interpreter path is
        // untouched and renders the interpolation node directly.
        program = Lowering.InterpolatedStringHandlerLowerer.Lower(program);

        // Issue #452: spill side-effecting sub-expressions that sit in
        // emit-pipeline contexts which historically re-emitted them more
        // than once (compound index / property assignments, etc.). Run
        // after interpolated-string lowering and before the async /
        // iterator state machine rewriters so the spilled temps
        // participate in hoist-set computation.
        program = Lowering.SideEffectSpiller.Lower(program);

        // Issue #523: hoist captured locals/parameters into per-variable
        // box classes so function literals see writes to the variable cell
        // (Go/C# closure semantics). Must run after side-effect spilling
        // and before the async / iterator state-machine lowerers so they
        // see the boxed captures rather than the snapshot-by-value pattern.
        program = Lowering.CaptureBoxingRewriter.Lower(program);

        var (lowered, lowerDiagnostics) = LowerForEmit(program, References ?? Symbols.ReferenceResolver.Default());
        if (lowerDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, lowerDiagnostics);
        }

        var allWarnings = syntaxDiagnostics
            .Concat(program.Diagnostics)
            .Concat(documentationDiagnostics)
            .Concat(lowerDiagnostics)
            .Where(d => !d.IsError)
            .ToImmutableArray();

        try
        {
            if (peStream is not null)
            {
                EmitAssembly(program, peStream, References, assemblyName, assemblyVersion, metadataOnly: false, asyncRewriteResult: lowered.AsyncRewriteResult, iteratorRewriteResult: lowered.IteratorRewriteResult, asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult, debugInformation: DebugInformation, pdbStream: pdbStream);
            }

            if (refStream is not null)
            {
                // Reference assemblies never carry debug info — pass an explicit
                // None override so we don't accidentally write a CodeView entry
                // pointing at a sidecar that doesn't describe this PE.
                EmitAssembly(program, refStream, References, assemblyName, assemblyVersion, metadataOnly: true, asyncRewriteResult: lowered.AsyncRewriteResult, iteratorRewriteResult: lowered.IteratorRewriteResult, asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult, debugInformation: null, pdbStream: null);
            }

            if (docStream is not null)
            {
                DocumentationFileEmitter.Emit(docStream, assemblyName ?? program.PackageName, program.Structs, program.Functions.Keys);
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            // 6.2 SilentEmitFailure invariant: widen the catch to all non-fatal
            // exceptions so that any emit-time failure (regardless of exception
            // type) produces a structured GS9998 diagnostic anchored at the
            // offending source construct. Previously this only caught
            // NotSupportedException and InvalidOperationException (#519).
            var diagnostic = BuildEmitFailureDiagnostic(ex);
            var combined = allWarnings.Add(diagnostic);
            return new EmitResult(success: false, combined);
        }

        return new EmitResult(success: true, diagnostics: allWarnings);
    }

    /// <summary>
    /// Compiles the current syntax tree and writes the resulting assembly to
    /// <paramref name="peStream"/>. When <paramref name="refStream"/> is
    /// supplied, also writes a metadata-only sibling assembly (a reference
    /// assembly) to it.
    /// </summary>
    /// <param name="peStream">Destination stream for the PE bytes. May be <c>null</c> when only a reference assembly is desired.</param>
    /// <param name="refStream">Optional destination stream for the metadata-only reference assembly.</param>
    /// <returns>An emit result.</returns>
    public EmitResult Emit(Stream peStream, Stream refStream) =>
        Emit(peStream, pdbStream: null, refStream, docStream: null, assemblyName: null);

    // Issue #519 + 6.2 SilentEmitFailure invariant: anchor the synthetic
    // GS9998 at the best available source location. Preference order:
    // 1. EmitDiagnosticException.Anchor (precise node that triggered the failure)
    // 2. First syntax tree root (file-level fallback)
    // 3. File-named empty SourceText (guarantees the SDK regex matches)
    // The message includes the exception type name so the user can distinguish
    // different ICE flavors without needing a stack trace.
    private Diagnostic BuildEmitFailureDiagnostic(Exception ex)
    {
        // Unwrap EmitDiagnosticException to get the original exception type
        // name in the message and the precise anchor.
        var anchor = (ex as Emit.EmitDiagnosticException)?.Anchor
            ?? (ex.InnerException as Emit.EmitDiagnosticException)?.Anchor;

        TextLocation location;
        if (anchor != null)
        {
            location = new TextLocation(anchor.SyntaxTree.Text, anchor.Span);
        }
        else
        {
            var firstTree = SyntaxTrees.FirstOrDefault();
            var sourceText = firstTree?.Text
                ?? SourceText.From(string.Empty, fileName: "gsc");
            location = new TextLocation(sourceText, new TextSpan(0, 0));
        }

        // Build the message: include the root-cause exception type and message.
        var rootEx = ex is Emit.EmitDiagnosticException ede && ede.InnerException != null
            ? ede.InnerException
            : ex;
        var typeName = rootEx.GetType().Name;
        var message = $"{typeName}: {rootEx.Message}";

        return new Diagnostic(location, "GS9998", DiagnosticSeverity.Error, message);
    }

    /// <summary>
    /// The canonical async/iterator lowering pipeline. Runs all rewriter
    /// passes in the correct order and gates unsupported constructs via
    /// <see cref="Lowering.Async.AsyncEmitPrecheck"/>.
    /// </summary>
    /// <remarks>
    /// <para>Ordering: the rewriters run first because
    /// <see cref="Lowering.Async.AsyncEmitPrecheck.Check"/> inspects
    /// <see cref="FunctionSymbol.StateMachineType"/> which is populated by
    /// <see cref="Lowering.Async.AsyncStateMachineRewriter.Rewrite"/>. The
    /// precheck cannot move before the rewriters without losing the ability
    /// to distinguish successfully-lowered async methods from those that
    /// failed builder resolution.</para>
    /// </remarks>
    private static (LoweredProgram Lowered, ImmutableArray<Diagnostic> Diagnostics) LowerForEmit(
        BoundProgram program, ReferenceResolver references)
    {
        // Run the rewriter passes.
        var asyncRewriteResult = Lowering.Async.AsyncStateMachineRewriter.Rewrite(program, references);
        var iteratorRewriteResult = IteratorRewriter.Rewrite(program);
        var asyncIteratorRewriteResult = AsyncIteratorRewriter.Rewrite(program);

        // Gate: fail fast on unsupported async constructs after lowering.
        // This runs after the rewriters because it inspects StateMachineType
        // which is set during AsyncStateMachineRewriter.Rewrite.
        var diagnostics = Lowering.Async.AsyncEmitPrecheck.Check(program);

        var lowered = new LoweredProgram(asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult);
        return (lowered, diagnostics);
    }

    private static DebugInformationOptions CloneDebugInformation(DebugInformationOptions source)
    {
        if (source is null)
        {
            return new DebugInformationOptions();
        }

        return new DebugInformationOptions
        {
            Format = source.Format,
            PdbFilePath = source.PdbFilePath,
            SourceLinkFilePath = source.SourceLinkFilePath,
            Deterministic = source.Deterministic,
        };
    }

    private static void EmitAssembly(BoundProgram program, Stream peStream, ReferenceResolver references, string assemblyName = null, string assemblyVersion = null, bool metadataOnly = false, Lowering.Async.AsyncStateMachineRewriteResult asyncRewriteResult = null, IteratorRewriteResult iteratorRewriteResult = null, AsyncIteratorRewriteResult asyncIteratorRewriteResult = null, DebugInformationOptions debugInformation = null, Stream pdbStream = null)
    {
        ReflectionMetadataEmitter.Emit(program, peStream, references, assemblyName, metadataOnly, asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult, debugInformation, pdbStream, assemblyVersion);
    }

    /// <summary>
    /// Bundle holding the results of the lowering pipeline passes.
    /// </summary>
    private sealed class LoweredProgram
    {
        public LoweredProgram(
            Lowering.Async.AsyncStateMachineRewriteResult asyncRewriteResult,
            IteratorRewriteResult iteratorRewriteResult,
            AsyncIteratorRewriteResult asyncIteratorRewriteResult)
        {
            AsyncRewriteResult = asyncRewriteResult;
            IteratorRewriteResult = iteratorRewriteResult;
            AsyncIteratorRewriteResult = asyncIteratorRewriteResult;
        }

        public Lowering.Async.AsyncStateMachineRewriteResult AsyncRewriteResult { get; }

        public IteratorRewriteResult IteratorRewriteResult { get; }

        public AsyncIteratorRewriteResult AsyncIteratorRewriteResult { get; }
    }
}
