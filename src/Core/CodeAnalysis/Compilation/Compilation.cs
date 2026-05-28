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
        PreprocessorSymbols = previous?.PreprocessorSymbols ?? ImmutableHashSet<string>.Empty;
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
    /// Gets the global scope.
    /// </summary>
    public BoundGlobalScope GlobalScope
    {
        get
        {
            if (globalScope == null)
            {
                var globalScope = Binder.BindGlobalScope(Previous?.GlobalScope, SyntaxTrees, References, ImplicitSystemImport, PreprocessorSymbols);
                Interlocked.CompareExchange(ref this.globalScope, globalScope, null);
            }

            return globalScope;
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
        if (diagnostics.Any(d => d.IsError))
        {
            return new EvaluationResult(diagnostics, null);
        }

        var program = Binder.BindProgram(GlobalScope);

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

        // ADR-0047 Phase 6 / #141: combine all non-error diagnostics (warnings,
        // info) collected so far so they surface to the REPL alongside the
        // evaluated value, mirroring the emit pipeline's IsError filter.
        var allWarnings = diagnostics
            .Concat(program.Diagnostics)
            .Where(d => !d.IsError)
            .ToImmutableArray();

        if (program.Diagnostics.Any(d => d.IsError))
        {
            return new EvaluationResult(allWarnings.Concat(program.Diagnostics.Where(d => d.IsError)).ToImmutableArray(), null);
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
        var program = Binder.BindProgram(GlobalScope);

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
        if (syntaxDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, syntaxDiagnostics);
        }

        var program = Binder.BindProgram(GlobalScope);
        if (program.Diagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
        }

        var (lowered, lowerDiagnostics) = LowerForEmit(program, References ?? Symbols.ReferenceResolver.Default());
        if (lowerDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, lowerDiagnostics);
        }

        var allWarnings = syntaxDiagnostics
            .Concat(program.Diagnostics)
            .Concat(lowerDiagnostics)
            .Where(d => !d.IsError)
            .ToImmutableArray();

        try
        {
            using var stream = File.Create(program.PackageName + ".dll");
            EmitAssembly(program, stream, References, asyncRewriteResult: lowered.AsyncRewriteResult, iteratorRewriteResult: lowered.IteratorRewriteResult, asyncIteratorRewriteResult: lowered.AsyncIteratorRewriteResult, debugInformation: DebugInformation, pdbStream: null);
        }
        catch (Exception ex) when (ex is NotSupportedException || ex is InvalidOperationException)
        {
            var location = new TextLocation(SourceText.From(string.Empty), new TextSpan(0, 0));
            var diagnostic = new Diagnostic(location, "GS9998", DiagnosticSeverity.Error, ex.Message);
            return new EmitResult(success: false, ImmutableArray.Create(diagnostic));
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
    public EmitResult Emit(Stream peStream) => Emit(peStream, pdbStream: null, refStream: null, assemblyName: null);

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
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
        if (syntaxDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, syntaxDiagnostics);
        }

        var program = Binder.BindProgram(GlobalScope);
        if (program.Diagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
        }

        var (lowered, lowerDiagnostics) = LowerForEmit(program, References ?? Symbols.ReferenceResolver.Default());
        if (lowerDiagnostics.Any(d => d.IsError))
        {
            return new EmitResult(success: false, lowerDiagnostics);
        }

        var allWarnings = syntaxDiagnostics
            .Concat(program.Diagnostics)
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
        }
        catch (Exception ex) when (ex is NotSupportedException || ex is InvalidOperationException)
        {
            var location = new TextLocation(SourceText.From(string.Empty), new TextSpan(0, 0));
            var diagnostic = new Diagnostic(location, "GS9998", DiagnosticSeverity.Error, ex.Message);
            return new EmitResult(success: false, ImmutableArray.Create(diagnostic));
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
        Emit(peStream, pdbStream: null, refStream, assemblyName: null);

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
