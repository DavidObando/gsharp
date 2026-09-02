// <copyright file="EmittedSessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Repl.Engine;

/// <summary>
/// The emitted submission-chaining REPL engine (ADR-0156 Phase 2; the
/// interactive default since Phase 3a): every
/// submission compiles with the real emitter into an in-memory assembly
/// (<c>gsi$N</c>) that binds against all prior submissions' assemblies, loads
/// into one session-wide collectible <see cref="System.Runtime.Loader.AssemblyLoadContext"/>,
/// and runs its entry point in-process. Top-level variables live as static
/// fields on each submission's <c>&lt;Program&gt;</c> container so later
/// submissions read and write them as ordinary cross-assembly members; the
/// trailing expression value is captured into the synthesized
/// <c>&lt;Result&gt;$</c> field for the cell echo. Failed submissions never
/// advance the chain: diagnostics render, and the next submission binds
/// against the last good chain.
/// </summary>
public sealed class EmittedSessionEngine : ISessionEngine, IDisposable
{
    private readonly List<Cell> cells = new();
    private readonly List<SubmissionState> submissions = new(); // newest first
    private readonly List<ReferenceResolver> discardedResolvers = new();
    private readonly List<ImportSymbol> sessionImports = new();
    private readonly IReadOnlyList<string> userReferences;
    private readonly InteractiveSessionHost host;
    private readonly string submissionsDirectory;
    private ReferenceResolver? analysisResolver;
    private int analysisSubmissionCount = -1;
    private int submissionCounter;

    /// <summary>
    /// Initializes a new instance of the <see cref="EmittedSessionEngine"/> class.
    /// </summary>
    /// <param name="references">User-supplied reference assembly paths (<c>/r:</c>); may be <see langword="null"/>.</param>
    public EmittedSessionEngine(IReadOnlyList<string>? references = null)
    {
        userReferences = references?.Where(r => !string.IsNullOrWhiteSpace(r)).ToArray() ?? Array.Empty<string>();
        host = new InteractiveSessionHost(userReferences);
        submissionsDirectory = Path.Combine(Path.GetTempPath(), "gsi-session-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(submissionsDirectory);
    }

    /// <inheritdoc/>
    public IReadOnlyList<Cell> Cells => cells;

    /// <inheritdoc/>
    public bool CaptureConsole { get; set; }

    /// <inheritdoc/>
    public Func<string?>? InputProvider { get; set; }

    public bool CaptureSyntaxTree { get; set; }

    public bool CaptureIntermediateLanguage { get; set; }

    /// <inheritdoc/>
    public Cell Evaluate(string text) => EvaluateCore(text, CancellationToken.None);

    /// <inheritdoc/>
    public Task<Cell> EvaluateAsync(string text, CancellationToken cancellationToken)
        => Task.Run(() => EvaluateCore(text, cancellationToken));

    /// <inheritdoc/>
    public EditorAnalysis AnalyzeEditor(string text)
    {
        if (text.Length == 0)
        {
            return EditorAnalysis.Empty;
        }

        var baseline = AnalysisBridge.AnalyzeTokens(text);
        try
        {
            var tree = SyntaxTree.Parse(SourceText.From(text, string.Empty));
            var compilation = new Compilation(GetAnalysisResolver(), tree)
            {
                Submission = new SubmissionBindingOptions
                {
                    Imports = SubmissionImports.Create(
                        submissions.Select(s => new SubmissionReference(s.AssemblyName, s.PackageName, s.GlobalScope)).ToImmutableArray()),
                    DefaultPackageName = "gsi$analysis",
                    ReplayImports = sessionImports.ToImmutableArray(),
                    CaptureTrailingExpression = false,
                },
            };
            var diagnostics = tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics).Concat(compilation.BoundProgram.Diagnostics);
            return AnalysisBridge.WithDiagnostics(baseline, diagnostics, tree.Text);
        }
        catch
        {
            return baseline;
        }
    }

    /// <inheritdoc/>
    public ReplState Snapshot()
    {
        if (submissions.Count == 0)
        {
            return ReplState.Empty;
        }

        try
        {
            var imports = new List<ReplSymbol>();
            var functions = new List<ReplSymbol>();
            var vars = new List<ReplSymbol>();
            var types = new List<ReplSymbol>();
            var seenImports = new HashSet<string>(StringComparer.Ordinal);
            var seenFunctions = new HashSet<string>(StringComparer.Ordinal);
            var seenVars = new HashSet<string>(StringComparer.Ordinal);
            var seenTypes = new HashSet<string>(StringComparer.Ordinal);

            // Walk submissions newest-to-oldest so redeclarations show their
            // latest form, mirroring the evaluator engine's scope-chain walk.
            foreach (var submission in submissions)
            {
                var scope = submission.GlobalScope;
                foreach (var import in scope.Imports)
                {
                    if (seenImports.Add(import.Name))
                    {
                        imports.Add(Describe("import", import, submission));
                    }
                }

                foreach (var fn in scope.Functions)
                {
                    if (ReferenceEquals(fn, scope.EntryPoint) || fn.IsSpecialName || fn.IsTopLevelEntryPoint || !seenFunctions.Add(fn.Name))
                    {
                        continue;
                    }

                    functions.Add(Describe("func", fn, submission));
                }

                foreach (var v in scope.Variables)
                {
                    if (v is not GlobalVariableSymbol
                        || string.Equals(v.Name, SubmissionImports.ResultFieldName, StringComparison.Ordinal)
                        || !seenVars.Add(v.Name))
                    {
                        continue;
                    }

                    var value = host.ReadStaticField(
                        submission.RuntimeAssembly,
                        submission.PackageName + "." + SubmissionImports.ProgramTypeName,
                        v.Name);
                    vars.Add(Describe(v.IsReadOnly ? "let" : "var", v, submission, Truncate(ReplValueFormatter.Format(value), 20)));
                }

                foreach (var s in scope.Structs)
                {
                    if (seenTypes.Add(s.Name))
                    {
                        types.Add(Describe("struct", s, submission));
                    }
                }

                foreach (var i in scope.Interfaces)
                {
                    if (seenTypes.Add(i.Name))
                    {
                        types.Add(Describe("interface", i, submission));
                    }
                }

                foreach (var e in scope.Enums)
                {
                    if (seenTypes.Add(e.Name))
                    {
                        types.Add(Describe("enum", e, submission));
                    }
                }

                foreach (var d in scope.Delegates)
                {
                    if (seenTypes.Add(d.Name))
                    {
                        types.Add(Describe("delegate", d, submission));
                    }
                }
            }

            return new ReplState(imports, functions, vars, types);
        }
        catch
        {
            return ReplState.Empty;
        }
    }

    /// <summary>Whether the text is a complete submission (balanced, parses fully).</summary>
    /// <param name="text">The submission source.</param>
    /// <returns><see langword="true"/> when the text parses as a complete submission.</returns>
    public static bool IsComplete(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        var tree = SyntaxTree.Parse(text);
        return tree.Root.Members.Length > 0 && !tree.Root.Members[^1].GetLastToken().IsMissing;
    }

    /// <inheritdoc/>
    public void Reset()
    {
        host.Reset();
        ReleaseCompilations();
        sessionImports.Clear();
        cells.Clear();
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        host.Dispose();
        ReleaseCompilations();
        try
        {
            Directory.Delete(submissionsDirectory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static string Truncate(string? text, int max)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        var oneLine = text.Replace("\r", " ").Replace("\n", " ");
        return oneLine.Length <= max ? oneLine : oneLine[..(max - 1)] + "…";
    }

    private string Display(Symbol symbol, SubmissionState submission)
        => SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature, submission.Compilation);

    private ReplSymbol Describe(string kind, Symbol symbol, SubmissionState submission, string value = "")
    {
        var display = Display(symbol, submission);
        return new ReplSymbol(kind, symbol.Name, display, value, display + (value.Length == 0 ? string.Empty : " = " + value));
    }

    private ReferenceResolver GetAnalysisResolver()
    {
        if (analysisResolver is not null && analysisSubmissionCount == submissions.Count)
        {
            return analysisResolver;
        }

        if (analysisResolver is not null)
        {
            discardedResolvers.Add(analysisResolver);
        }

        var paths = submissions.Select(s => s.DllPath).Concat(userReferences).ToArray();
        analysisResolver = paths.Length > 0 ? ReferenceResolver.WithReferences(paths) : ReferenceResolver.Default();
        analysisSubmissionCount = submissions.Count;
        return analysisResolver;
    }

    private Cell EvaluateCore(string text, CancellationToken cancellationToken)
    {
        var index = cells.Count + 1;

        var originalOut = Console.Out;
        var originalError = Console.Error;
        var originalIn = Console.In;
        StringWriter? stdout = null;
        StringWriter? stderr = null;

        if (CaptureConsole)
        {
            stdout = new StringWriter { NewLine = "\n" };
            stderr = new StringWriter { NewLine = "\n" };
            Console.SetOut(stdout);
            Console.SetError(stderr);
        }

        if (InputProvider is not null)
        {
            Console.SetIn(new CallbackTextReader(InputProvider));
        }

        Cell cell;
        try
        {
            try
            {
                cell = CompileAndRun(text, index, cancellationToken, stdout, stderr);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                var diag = new Diagnostic(default, "GSI001", DiagnosticSeverity.Error, $"Evaluation error: {ex.Message}");
                cell = new Cell(index, text, null, ImmutableArray.Create(diag), true, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty);
            }
        }
        finally
        {
            if (CaptureConsole)
            {
                Console.SetOut(originalOut);
                Console.SetError(originalError);
            }

            if (InputProvider is not null)
            {
                Console.SetIn(originalIn);
            }
        }

        cells.Add(cell);
        return cell;
    }

    private Cell CompileAndRun(string text, int index, CancellationToken cancellationToken, StringWriter? stdout, StringWriter? stderr)
    {
        // Submission identities are monotonic and never reused: a submission
        // that failed at runtime was already loaded into the session context,
        // so its assembly name is burned even though its declarations are
        // discarded from the chain.
        var n = ++submissionCounter;
        var assemblyName = "gsi$" + n;
        var packageName = "gsi" + n;

        var tree = SyntaxTree.Parse(SourceText.From(text, string.Empty));
        var syntaxTree = CaptureSyntaxTree ? tree.Root.ToString() : string.Empty;
        var referencePaths = submissions.Select(s => s.DllPath).Concat(userReferences).ToArray();
        var resolver = referencePaths.Length > 0
            ? ReferenceResolver.WithReferences(referencePaths)
            : ReferenceResolver.Default();

        string? dllPath = null;
        var ownershipTransferred = false;
        try
        {
            var compilation = new Compilation(resolver, tree)
            {
                Submission = new SubmissionBindingOptions
                {
                    Imports = SubmissionImports.Create(
                        submissions.Select(s => new SubmissionReference(s.AssemblyName, s.PackageName, s.GlobalScope)).ToImmutableArray()),
                    DefaultPackageName = packageName,
                    ReplayImports = sessionImports.ToImmutableArray(),
                },
            };

            using var peStream = new MemoryStream();
            var emitResult = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: assemblyName);
            var hasError = emitResult.Diagnostics.Any(d => d.IsError) || !emitResult.Success;
            if (hasError)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return new Cell(index, text, null, emitResult.Diagnostics, true, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty, syntaxTree);
            }

            // Flush the PE to the session directory before running: future
            // submissions' reference resolvers read it from disk.
            var peImage = peStream.ToArray();
            var intermediateLanguage = CaptureIntermediateLanguage ? IlDump.Create(peImage) : string.Empty;
            dllPath = Path.Combine(submissionsDirectory, assemblyName + ".dll");
            File.WriteAllBytes(dllPath, peImage);

            // A cell that declares its own `package X` emits its members (and the
            // synthesized `<Program>` holding `<Result>$` and the globals) under
            // that namespace, not under the session default. Track the package the
            // members were actually emitted under so the echo read below and the
            // chain's SubmissionReference stay truthful (Phase 3d follow-up to the
            // 3c note "a package-declaring cell succeeds silently with no echo").
            var emittedPackageName = compilation.GlobalScope.Package?.Name ?? packageName;

            // assemblyName is assigned for every submission before emit.
            var runResult = host.RunSubmission(peImage, assemblyName!);
            if (runResult.UnhandledException is not null)
            {
                // Runtime failure: the submission's declarations are discarded
                // (the chain stays at the last good submission), but side effects
                // it already applied to earlier submissions' state persist —
                // matching the evaluator engine's partial-state behavior.
                var ex = runResult.UnhandledException;
                var diag = new Diagnostic(default, "GSI002", DiagnosticSeverity.Error, $"Unhandled exception. {ex.GetType().Name}: {ex.Message}");
                cancellationToken.ThrowIfCancellationRequested();
                return new Cell(index, text, null, emitResult.Diagnostics.Add(diag), true, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty, syntaxTree, intermediateLanguage);
            }

            var value = host.ReadStaticField(
                runResult.Assembly,
                emittedPackageName + "." + SubmissionImports.ProgramTypeName,
                SubmissionImports.ResultFieldName)
                ?? runResult.ReturnValue;

            // The only cancellation checkpoint: if the caller interrupted before
            // this (possibly long-running) submission finished, discard the result
            // instead of committing it to the transcript or the chain.
            cancellationToken.ThrowIfCancellationRequested();

            submissions.Insert(0, new SubmissionState(compilation, compilation.GlobalScope, assemblyName, emittedPackageName, dllPath, runResult.Assembly));
            ownershipTransferred = true;
            foreach (var import in compilation.GlobalScope.Imports)
            {
                if (!sessionImports.Any(i =>
                    string.Equals(i.Name, import.Name, StringComparison.Ordinal)
                    && string.Equals(i.Target, import.Target, StringComparison.Ordinal)))
                {
                    sessionImports.Add(new ImportSymbol(import.Name, import.Target, declaration: null));
                }
            }

            return new Cell(index, text, value, emitResult.Diagnostics, false, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty, syntaxTree, intermediateLanguage);
        }
        finally
        {
            if (!ownershipTransferred)
            {
                if (dllPath is not null)
                {
                    TryDeleteFile(dllPath);
                }

                // Disposing a resolver clears process-wide symbol caches. Keep
                // failed/cancelled resolvers until this session ends so a live
                // prior submission never observes a mid-chain cache reset.
                discardedResolvers.Add(resolver);
            }
        }
    }

    private void ReleaseCompilations()
    {
        if (analysisResolver is not null)
        {
            analysisResolver.Dispose();
            analysisResolver = null;
            analysisSubmissionCount = -1;
        }

        foreach (var submission in submissions)
        {
            TryDeleteFile(submission.DllPath);
            submission.Compilation.References?.Dispose();
        }

        submissions.Clear();
        foreach (var resolver in discardedResolvers)
        {
            resolver.Dispose();
        }

        discardedResolvers.Clear();
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private sealed record SubmissionState(
        Compilation Compilation,
        BoundGlobalScope GlobalScope,
        string AssemblyName,
        string PackageName,
        string DllPath,
        Assembly RuntimeAssembly);
}
