// <copyright file="EmittedSessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks

/// The emitted submission-chaining REPL engine (ADR-0156 Phase 2; the
/// interactive default since Phase 3a): every
/// submission compiles with the real emitter into an in-memory assembly
/// (`gsi$N`) that binds against all prior submissions' assemblies, loads
/// into one session-wide collectible (cref:System.Runtime.Loader.AssemblyLoadContext),
/// and runs its entry point in-process. Top-level variables live as static
/// fields on each submission's `<Program>` container so later
/// submissions read and write them as ordinary cross-assembly members; the
/// trailing expression value is captured into the synthesized
/// `<Result>$` field for the cell echo. Failed submissions never
/// advance the chain: diagnostics render, and the next submission binds
/// against the last good chain.
class EmittedSessionEngine : ISessionEngine, IDisposable {
    private let cells List[Cell] = List[Cell]()
    private let submissions List[SubmissionState] = List[SubmissionState]()
    private let discardedResolvers List[ReferenceResolver] = List[ReferenceResolver]()
    private let sessionImports List[ImportSymbol] = List[ImportSymbol]()
    private let userReferences IReadOnlyList[string]
    private let host InteractiveSessionHost
    private let submissionsDirectory string
    private var submissionCounter int32

    /// Initializes a new instance of the (cref:EmittedSessionEngine) class.
    /// @param references User-supplied reference assembly paths (`/r:`); may be `null`.
    init(references IReadOnlyList[string]? = nil) {
        userReferences = references?.Where((r string) -> !string.IsNullOrWhiteSpace(r)).ToArray() ??
            Array.Empty[string]()
        host = InteractiveSessionHost(userReferences)
        submissionsDirectory = Path.Combine(Path.GetTempPath(), "gsi-session-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(submissionsDirectory)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop Cells IReadOnlyList[Cell] -> cells

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop CaptureConsole bool

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    prop InputProvider(() -> string?)?

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Evaluate(text string) Cell -> Evaluate(SourceText.From(text))

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Evaluate(source SourceText) Cell -> EvaluateCore(source, CancellationToken.None)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func EvaluateAsync(text string, cancellationToken CancellationToken) Task[Cell] -> Task.Run[Cell](
        () -> EvaluateCore(SourceText.From(text), cancellationToken)
    )

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Snapshot() ReplState {
        if submissions.Count == 0 {
            return ReplState.Empty
        }
        try {
            let imports = List[ReplSymbol]()
            let functions = List[ReplSymbol]()
            let vars = List[ReplSymbol]()
            let types = List[ReplSymbol]()
            let seenImports = HashSet[string](StringComparer.Ordinal)
            let seenFunctions = HashSet[string](StringComparer.Ordinal)
            let seenVars = HashSet[string](StringComparer.Ordinal)
            let seenTypes = HashSet[string](StringComparer.Ordinal)
            // Walk submissions newest-to-oldest so redeclarations show their
            // latest form, mirroring the evaluator engine's scope-chain walk.
            for submission in submissions {
                let scope_ = submission.GlobalScope
                for import_ in scope_.Imports {
                    if seenImports.Add(import_.Name) {
                        imports.Add(ReplSymbol(Display(import_, submission)))
                    }
                }
                for fn in scope_.Functions {
                    if object.ReferenceEquals(fn, scope_.EntryPoint) ||
                        fn.IsSpecialName ||
                        fn.IsTopLevelEntryPoint ||
                        !seenFunctions.Add(fn.Name) {
                        continue
                    }
                    functions.Add(ReplSymbol(Display(fn, submission)))
                }
                for v in scope_.Variables {
                    if !(v is GlobalVariableSymbol) || string.Equals(
                        v.Name,
                        SubmissionImports.ResultFieldName,
                        StringComparison.Ordinal
                    ) ||
                        !seenVars.Add(v.Name) {
                        continue
                    }
                    var display = Display(v, submission)
                    let value object? = host.ReadStaticField(
                        submission.RuntimeAssembly,
                        submission.PackageName + "." + SubmissionImports.ProgramTypeName,
                        v.Name
                    )
                    if value != nil {
                        // ADR-0157: display-side pretty rendering for the
                        // sidebar values column, same contract as the echo.
                        display += " = ${Truncate(ReplValueFormatter.Format(value), 20)}"
                    }
                    vars.Add(ReplSymbol(display))
                }
                for s in scope_.Structs {
                    if seenTypes.Add(s.Name) {
                        types.Add(ReplSymbol(Display(s, submission)))
                    }
                }
                for i in scope_.Interfaces {
                    if seenTypes.Add(i.Name) {
                        types.Add(ReplSymbol(Display(i, submission)))
                    }
                }
                for e in scope_.Enums {
                    if seenTypes.Add(e.Name) {
                        types.Add(ReplSymbol(Display(e, submission)))
                    }
                }
                for d in scope_.Delegates {
                    if seenTypes.Add(d.Name) {
                        types.Add(ReplSymbol(Display(d, submission)))
                    }
                }
            }
            return ReplState(imports, functions, vars, types)
        } catch {
            return ReplState.Empty
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Reset() {
        host.Reset()
        ReleaseCompilations()
        sessionImports.Clear()
        cells.Clear()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        host.Dispose()
        ReleaseCompilations()
        try {
            Directory.Delete(submissionsDirectory, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private func Display(symbol Symbol, submission SubmissionState) string -> SymbolDisplay.ToDisplayString(
        symbol,
        SymbolDisplayFormat.Signature,
        submission.Compilation
    )

    private func EvaluateCore(source SourceText, cancellationToken CancellationToken) Cell {
        let text = source.ToString()
        let index = cells.Count + 1
        let originalOut = Console.Out
        let originalError = Console.Error
        let originalIn = Console.In
        var stdout StringWriter? = nil
        var stderr StringWriter? = nil
        if CaptureConsole {
            stdout = StringWriter{NewLine: "\n"}
            stderr = StringWriter{NewLine: "\n"}
            Console.SetOut(stdout)
            Console.SetError(stderr)
        }
        if InputProvider != nil {
            Console.SetIn(CallbackTextReader(InputProvider!!))
        }
        var cell Cell
        try {
            try {
                cell = CompileAndRun(source, index, cancellationToken, stdout, stderr)
            } catch (ex Exception) when !(ex is OperationCanceledException) {
                let diag = GSharp
                    .Core
                    .CodeAnalysis
                    .Diagnostic(
                    default(TextLocation),
                    "GSI001",
                    GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error,
                    "Evaluation error: ${ex.Message}"
                )
                cell = Cell(
                    index,
                    text,
                    nil,
                    ImmutableArray.Create(diag),
                    true,
                    stdout?.ToString() ?? string.Empty,
                    stderr?.ToString() ?? string.Empty
                )
            }
        } finally {
            if CaptureConsole {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            if InputProvider != nil {
                Console.SetIn(originalIn)
            }
        }
        cells.Add(cell)
        return cell
    }

    private func CompileAndRun(
        source SourceText,
        index int32,
        cancellationToken CancellationToken,
        stdout StringWriter?,
        stderr StringWriter?
    ) Cell {
        // Submission identities are monotonic and never reused: a submission
        // that failed at runtime was already loaded into the session context,
        // so its assembly name is burned even though its declarations are
        // discarded from the chain.
        let n = (submissionCounter += 1)
        let assemblyName = "gsi$$" + n.ToString()
        let packageName = "gsi" + n.ToString()
        let text = source.ToString()
        let tree = SyntaxTree.Parse(source)
        // ADR-0174 D1: a later cell's resolver is rebuilt from the prior
        // submissions, so it must re-append the bundled driver references
        // (Gsharp.Extensions, Gsharp.Runtime.Channels) the first cell got from
        // ReferenceResolver.Default(); otherwise a channel constructed in cell
        // one cannot be sent on in cell two ("Chan`1 ... not provided").
        let referencePaths = submissions.Select((s SubmissionState) -> s.DllPath).Concat(userReferences).ToArray()
        let resolver = if referencePaths.Length > 0 {
            ReferenceResolver.WithReferences(ReferenceResolver.ResolveDriverReferencePaths(referencePaths))
        } else {
            ReferenceResolver.Default()
        }
        var dllPath string? = nil
        var ownershipTransferred = false
        try {
            let compilation = Compilation(resolver, tree){
                Submission = SubmissionBindingOptions{
                    Imports: SubmissionImports.Create(
                        submissions.Select(
                            (s SubmissionState) -> SubmissionReference(s.AssemblyName, s.PackageName, s.GlobalScope)
                        )
                            .ToImmutableArray()
                    ),
                    DefaultPackageName: packageName,
                    ReplayImports: sessionImports.ToImmutableArray()
                }
            }
            using let peStream = MemoryStream()
            let emitResult = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            let hasError = emitResult.Diagnostics.Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError) ||
                !emitResult.Success
            if hasError {
                cancellationToken.ThrowIfCancellationRequested()
                return Cell(
                    index,
                    text,
                    nil,
                    emitResult.Diagnostics,
                    true,
                    stdout?.ToString() ?? string.Empty,
                    stderr?.ToString() ?? string.Empty
                )
            }
            // Flush the PE to the session directory before running: future
            // submissions' reference resolvers read it from disk.
            let peImage = peStream.ToArray()
            dllPath = Path.Combine(submissionsDirectory, assemblyName + ".dll")
            File.WriteAllBytes(dllPath, peImage)
            // A cell that declares its own `package X` emits its members (and the
            // synthesized `<Program>` holding `<Result>$` and the globals) under
            // that namespace, not under the session default. Track the package the
            // members were actually emitted under so the echo read below and the
            // chain's SubmissionReference stay truthful (Phase 3d follow-up to the
            // 3c note "a package-declaring cell succeeds silently with no echo").
            let emittedPackageName = compilation.GlobalScope.Package?.Name ?? packageName
            // assemblyName is assigned for every submission before emit.
            let runResult = host.RunSubmission(peImage, assemblyName)
            if runResult.UnhandledException != nil {
                // Runtime failure: the submission's declarations are discarded
                // (the chain stays at the last good submission), but side effects
                // it already applied to earlier submissions' state persist —
                // matching the evaluator engine's partial-state behavior.
                let ex = runResult.UnhandledException
                let diag = GSharp
                    .Core
                    .CodeAnalysis
                    .Diagnostic(
                    default(TextLocation),
                    "GSI002",
                    GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error,
                    "Unhandled exception. ${ex.GetType().Name}: ${ex.Message}"
                )
                cancellationToken.ThrowIfCancellationRequested()
                return Cell(
                    index,
                    text,
                    nil,
                    emitResult.Diagnostics.Add(diag),
                    true,
                    stdout?.ToString() ?? string.Empty,
                    stderr?.ToString() ?? string.Empty
                )
            }
            let value = host.ReadStaticField(
                runResult.Assembly,
                emittedPackageName + "." + SubmissionImports.ProgramTypeName,
                SubmissionImports.ResultFieldName
            ) ??
                runResult.ReturnValue
            // The only cancellation checkpoint: if the caller interrupted before
            // this (possibly long-running) submission finished, discard the result
            // instead of committing it to the transcript or the chain.
            cancellationToken.ThrowIfCancellationRequested()
            submissions.Insert(
                0,
                SubmissionState(
                    compilation,
                    compilation.GlobalScope,
                    assemblyName,
                    emittedPackageName,
                    dllPath,
                    runResult.Assembly
                )
            )
            ownershipTransferred = true
            for import_ in compilation.GlobalScope.Imports {
                if !sessionImports.Any(
                    (i ImportSymbol) -> string.Equals(i.Name, import_.Name, StringComparison.Ordinal) && string.Equals(
                        i.Target,
                        import_.Target,
                        StringComparison.Ordinal
                    )
                ) {
                    sessionImports.Add(ImportSymbol(import_.Name, import_.Target, declaration: nil))
                }
            }
            return Cell(
                index,
                text,
                value,
                emitResult.Diagnostics,
                false,
                stdout?.ToString() ?? string.Empty,
                stderr?.ToString() ?? string.Empty
            )
        } finally {
            if !ownershipTransferred {
                if dllPath != nil {
                    TryDeleteFile(dllPath)
                }
                // Disposing a resolver clears process-wide symbol caches. Keep
                // failed/cancelled resolvers until this session ends so a live
                // prior submission never observes a mid-chain cache reset.
                discardedResolvers.Add(resolver)
            }
        }
    }

    private func ReleaseCompilations() {
        for submission in submissions {
            TryDeleteFile(submission.DllPath)
            submission.Compilation.References?.Dispose()
        }
        submissions.Clear()
        for resolver in discardedResolvers {
            resolver.Dispose()
        }
        discardedResolvers.Clear()
    }

    private data class SubmissionState(
        Compilation Compilation,
        GlobalScope BoundGlobalScope,
        AssemblyName string,
        PackageName string,
        DllPath string,
        RuntimeAssembly Assembly
    ) : IEquatable[SubmissionState] { }

    shared {
        /// Whether the text is a complete submission (balanced, parses fully).
        /// @param text The submission source.
        /// @returns `true` when the text parses as a complete submission.
        func IsComplete(text string) bool {
            if string.IsNullOrEmpty(text) {
                return true
            }
            let tree = SyntaxTree.Parse(text)
            return tree.Root.Members.Length > 0 && !tree.Root.Members[^1].GetLastToken().IsMissing
        }

        private func Truncate(text string?, max int32) string {
            if string.IsNullOrEmpty(text) {
                return string.Empty
            }
            let oneLine = text.Replace("\r", " ").Replace("\n", " ")
            return if oneLine.Length <= max {
                oneLine
            } else {
                oneLine[.. (max - 1)] + "…"
            }
        }

        private func TryDeleteFile(path string) {
            try {
                File.Delete(path)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
