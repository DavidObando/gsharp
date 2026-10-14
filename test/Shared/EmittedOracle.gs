// <copyright file="EmittedOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Execution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading
import SystemObject = System.Object

/// The ADR-0156 Phase 3b emitted test oracle: the drop-in replacement for the
/// historical `Compilation.Evaluate` semantic-oracle pattern
/// (`new Compilation(SyntaxTree.Parse(source)).Evaluate(new Dictionary<VariableSymbol, object>())`).
/// The source compiles as a one-shot REPL submission — which is what makes the
/// trailing-expression value observable, via the synthesized
/// `<Result>$` global the Phase 2 submission machinery emits — with
/// the real emitter into an in-memory PE, loads into a fresh one-shot
/// collectible (cref:AssemblyLoadContext), runs its entry point
/// in-process with both console streams captured, and returns the
/// (cref:EmittedOracleResult) assertion surface.
/// @remarks <b>Diagnostics short-circuit.</b> Compile-time errors return
/// immediately with the same warnings-then-errors diagnostic shape
/// `Compilation.Evaluate` produced, and the program never runs — tests
/// that assert diagnostics without execution keep their expectations
/// verbatim.
///
/// <b>Runtime failures.</b> An exception the program does not catch is
/// unwrapped from the reflection boundary and surfaces both as
/// (cref:EmittedOracleResult.UnhandledException) and as a synthesized
/// `GS9999` error diagnostic carrying the exception's
/// (cref:Exception.Message) — the historical evaluator's
/// uncaught-exception protocol, minus the interpreter-only source-node
/// location. The synthesized diagnostic carries a default location; the
/// evaluator-specific runtime-location assertions retired with that engine in
/// ADR-0156 Phase 3c.
///
/// <b>ALC lifetime.</b> Each call gets its own collectible context and
/// unload is initiated before the result is returned. Collectible unload is
/// cooperative: the context, its assembly, and any returned
/// (cref:EmittedOracleResult.Value) of a submission-declared type stay
/// fully usable for as long as the test holds them — assertions after return
/// are safe by construction, and the context is reclaimed when the last
/// reference dies.
///
/// <b>Concurrency.</b> The oracle keeps no per-call shared state (no
/// temp files — the PE never touches disk) and compiles concurrently; only the
/// execute window is serialized by a process-wide gate, because console
/// capture rides the process-global (cref:Console.SetOut(TextWriter)).
/// Suites additionally keep their existing `ConsoleIo` collection
/// discipline for tests that redirect the console themselves.
shared class EmittedOracle {
    private let EvaluationGate object = SystemObject()
    private let ConsoleGate object = SystemObject()
    private var submissionCounter int32

    /// Compiles [`source`](paramref) as a one-shot submission, runs it
    /// emitted and in-process, and returns the full assertion surface.
    /// @param source The G# source text.
    /// @returns The oracle result.
    func Evaluate(source string?) EmittedOracleResult -> Evaluate(source, references: nil)

    /// Compiles [`source`](paramref) as a one-shot submission against
    /// the given reference assemblies, runs it emitted and in-process, and
    /// returns the full assertion surface.
    /// @param source The G# source text.
    /// @param references Reference assembly paths resolvable at compile and run time (the `/r:` channel);
    /// may be `null`.
    /// @returns The oracle result.
    func Evaluate(source string?, references IReadOnlyList[string]?) EmittedOracleResult {
        if source == nil {
            throw ArgumentNullException("source")
        }
        return Evaluate([]string{source}, EmittedOracleOptions{References: references})
    }

    /// Compiles all [`sources`](paramref) as the syntax trees of one
    /// compilation — the multi-tree equivalent of
    /// `new Compilation(t1, t2, …).Evaluate(…)` — applying the given
    /// compilation [`options`](paramref), and returns the full assertion
    /// surface. Unless (cref:EmittedOracleOptions.IsLibrary) is set the
    /// sources compile as a one-shot submission and run emitted in-process;
    /// a library compilation emits and returns diagnostics without executing
    /// (there is no entry point to run — the historical evaluator likewise
    /// had nothing to execute for a library).
    /// @param sources The G# source texts, one per syntax tree, in compilation order.
    /// @param options Compilation-level knobs; `null` for defaults.
    /// @returns The oracle result.
    func Evaluate(sources IReadOnlyList[string], options EmittedOracleOptions? = nil) EmittedOracleResult {
        // ponytail: process-wide compiler symbol caches make independent
        // one-shot compilations share a lifetime; serialize this test oracle
        // so each run can release its resolver and caches without racing one
        // still binding.
        lock EvaluationGate {
            return EvaluateCore(sources, options)
        }
    }

    private func EvaluateCore(sources IReadOnlyList[string]?, options EmittedOracleOptions?) EmittedOracleResult {
        var options = options
        if sources == nil {
            throw ArgumentNullException("sources")
        }
        if sources.Count == 0 || sources.Any((s string) -> s == nil) {
            throw ArgumentException("At least one non-null source is required.", "sources")
        }
        options ??= EmittedOracleOptions()
        let referencePaths = options!!
            .References
            ?.Where((r string) -> !string.IsNullOrWhiteSpace(r))
            .ToArray() ??
            Array.Empty[string]()
        let n = Interlocked.Increment(&submissionCounter)
        let assemblyName = "oracle$$" + n.ToString()
        let packageName = "oracle" + n.ToString()
        let trees = sources.Select((s string) -> SyntaxTree.Parse(SourceText.From(s))).ToArray()
        // A fresh default resolver per call is safe: ReferenceResolver
        // excludes collectible-ALC assemblies from its host scan, so earlier
        // oracle runs' still-loaded emitted assemblies can never shadow this
        // compilation's source packages (issue #3235).
        using let resolver = if referencePaths.Length > 0 {
            ReferenceResolver.WithReferences(referencePaths)
        } else {
            ReferenceResolver.Default()
        }
        let compilation = Compilation(resolver, trees)
        if options!!.ImplicitSystemImport is bool implicitSystemImport {
            compilation.ImplicitSystemImport = implicitSystemImport
        }
        if options!!.IsLibrary {
            // A library has no entry point and forbids top-level statements,
            // so there is nothing to wrap in a submission — and nothing to
            // run afterwards.
            compilation.IsLibrary = true
        } else {
            compilation.Submission = SubmissionBindingOptions{
                Imports: SubmissionImports.Create(ImmutableArray[SubmissionReference].Empty),
                DefaultPackageName: packageName,
                RunUserEntryPoint: true
            }
        }
        using let peStream = MemoryStream()
        let emitResult = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
        // Mirror Compilation.Evaluate's compile-failure shape: warnings first,
        // then errors, value null, nothing executed.
        let warnings = emitResult
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> !d.IsError)
            .ToImmutableArray()
        let errors = emitResult
            .Diagnostics
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToImmutableArray()
        if !emitResult.Success || errors.Length > 0 {
            return EmittedOracleResult(
                warnings.Concat(errors).ToImmutableArray(),
                value: nil,
                output: string.Empty,
                errorOutput: string.Empty,
                exitCode: 1,
                unhandledException: nil,
                loadContext: nil
            )
        }
        if options!!.IsLibrary {
            return EmittedOracleResult(
                warnings,
                value: nil,
                output: string.Empty,
                errorOutput: string.Empty,
                exitCode: 0,
                unhandledException: nil,
                loadContext: nil
            )
        }
        return Execute(peStream, referencePaths, warnings)
    }

    /// Fully binds the caller's [`compilation`](paramref) — global scope
    /// plus every function/method body and top-level statement — and returns
    /// its diagnostics in `Compilation.Evaluate`'s pre-execution shape
    /// (parse, then global-scope, then body diagnostics; warnings before
    /// errors), without ever executing. The binder-inspection companion for
    /// Phase 3b.2 (issue #3176): tests that assert on the compilation's bound
    /// state afterwards (`GlobalScope`, `BoundProgram`) keep their
    /// own `Compilation` instance and stop running code they never
    /// observe. The interpreter-only diagnostics `Compilation.Evaluate`
    /// appended after this point (deinit GS0510, P/Invoke GS0514) never
    /// appear — those constructs simply work under emitted execution
    /// (ADR-0156); tests asserting them are evaluator-machinery pins.
    /// @param compilation The compilation to bind.
    /// @returns The full bind-time diagnostics, warnings first.
    func CompileDiagnostics(compilation Compilation?) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
        if compilation == nil {
            throw ArgumentNullException("compilation")
        }
        let all = compilation
            .SyntaxTrees
            .SelectMany(
            func (tree SyntaxTree) IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic] {
                return tree.Diagnostics
            }
        )
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray()
        return all
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> !d.IsError)
            .Concat(all.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
            .ToImmutableArray()
    }

    private func Execute(
        peStream MemoryStream,
        referencePaths IReadOnlyList[string],
        warnings ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic]
    ) EmittedOracleResult {
        let loadContext = AssemblyLoadContext("gsharp-oracle-" + Guid.NewGuid().ToString("N"), isCollectible: true)
        let weakContext = WeakReference(loadContext)
        loadContext.Resolving += (context AssemblyLoadContext, name AssemblyName) -> ResolveDependency(
            context,
            name,
            referencePaths
        )
        let stdout = StringWriter()
        let stderr = StringWriter()
        try {
            peStream.Position = 0
            let assembly = loadContext.LoadFromStream(peStream)
            let entryPoint MethodInfo? = assembly.EntryPoint
            var returnValue object? = nil
            var unhandledException Exception? = nil
            if entryPoint != nil {
                let arguments[]?object = if entryPoint.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
                // Serialize the redirected-console window across concurrent
                // oracle calls; compilation and emit stay parallel.
                lock ConsoleGate {
                    let originalOut = Console.Out
                    let originalError = Console.Error
                    Console.SetOut(stdout)
                    Console.SetError(stderr)
                    try {
                        returnValue = entryPoint.Invoke(nil, arguments)
                    } catch (ex TargetInvocationException) when ex.InnerException != nil {
                        unhandledException = ex.InnerException
                    } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                        unhandledException = ex
                    } finally {
                        Console.SetOut(originalOut)
                        Console.SetError(originalError)
                    }
                }
            }
            if unhandledException != nil {
                // The historical evaluator surfaced an uncaught exception as a
                // GS9999 error diagnostic with the exception's message; keep
                // that assertion surface (location is default — runtime code
                // has no bound-node context) and expose the exception itself.
                let runtimeDiagnostic = GSharp
                    .Core
                    .CodeAnalysis
                    .Diagnostic(
                    default(TextLocation),
                    "GS9999",
                    GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error,
                    unhandledException.Message
                )
                return EmittedOracleResult(
                    warnings.Add(runtimeDiagnostic),
                    value: nil,
                    stdout.ToString(),
                    stderr.ToString(),
                    EmittedProgramHost.UnhandledExceptionExitCode,
                    unhandledException,
                    weakContext,
                    assembly
                )
            }
            // Prefer the synthesized trailing-expression capture; fall back to
            // the entry point's return value (an explicit int/uint `main`),
            // mirroring EmittedSessionEngine's echo protocol.
            TryReadResultField(assembly, out var captured)
            let value object? = captured ?? returnValue
            let exitCode = switch returnValue {
                case intValue is int32: intValue
                case uintValue is uint32: unchecked(int32(uintValue))
                default: 0
            }
            return EmittedOracleResult(
                warnings,
                value,
                stdout.ToString(),
                stderr.ToString(),
                exitCode,
                unhandledException: nil,
                weakContext,
                assembly
            )
        } finally {
            // Initiate unload; reclamation waits for the last reference (the
            // returned result's Value included) to die, so returned values
            // remain safe to assert on.
            loadContext.Unload()
        }
    }

    private func TryReadResultField(assembly Assembly, out value object?) bool {
        value = nil
        var types[]Type
        try {
            types = assembly.GetTypes()
        } catch (ex ReflectionTypeLoadException) {
            types = ex.Types.Where((t Type) -> t != nil).ToArray()
        }
        for type in types {
            if !string.Equals(type.Name, SubmissionImports.ProgramTypeName, StringComparison.Ordinal) {
                continue
            }
            let field FieldInfo? = type.GetField(
                SubmissionImports.ResultFieldName,
                BindingFlags.Public | BindingFlags.Static
            )
            if field != nil {
                value = field.GetValue(nil)
                return true
            }
        }
        return false
    }

    private func ResolveDependency(
        context AssemblyLoadContext,
        assemblyName AssemblyName,
        referencePaths IReadOnlyList[string]
    ) Assembly? {
        // User-supplied references win over any same-named host assembly so
        // the program binds against exactly what it was compiled against —
        // mirrors EmittedProgramHost's script-mode resolution.
        if assemblyName.Name != nil {
            let match string? = referencePaths.FirstOrDefault(
                (path string) -> string.Equals(
                    Path.GetFileNameWithoutExtension(path),
                    assemblyName.Name,
                    StringComparison.OrdinalIgnoreCase
                ) &&
                    File.Exists(path)
            )
            if match != nil {
                return context.LoadFromAssemblyPath(Path.GetFullPath(match))
            }
        }
        // Framework, test-assembly, and transitive dependencies fall back to
        // the default context.
        try {
            return Assembly.Load(assemblyName)
        } catch (FileNotFoundException) {
            return nil
        } catch (FileLoadException) {
            return nil
        } catch (BadImageFormatException) {
            return nil
        }
    }
}
