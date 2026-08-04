// <copyright file="EmittedOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Tests;

/// <summary>
/// The ADR-0156 Phase 3b emitted test oracle: the drop-in replacement for the
/// historical <c>Compilation.Evaluate</c> semantic-oracle pattern
/// (<c>new Compilation(SyntaxTree.Parse(source)).Evaluate(new Dictionary&lt;VariableSymbol, object&gt;())</c>).
/// The source compiles as a one-shot REPL submission — which is what makes the
/// trailing-expression value observable, via the synthesized
/// <c>&lt;Result&gt;$</c> global the Phase 2 submission machinery emits — with
/// the real emitter into an in-memory PE, loads into a fresh one-shot
/// collectible <see cref="AssemblyLoadContext"/>, runs its entry point
/// in-process with both console streams captured, and returns the
/// <see cref="EmittedOracleResult"/> assertion surface.
/// </summary>
/// <remarks>
/// <para><b>Diagnostics short-circuit.</b> Compile-time errors return
/// immediately with the same warnings-then-errors diagnostic shape
/// <c>Compilation.Evaluate</c> produced, and the program never runs — tests
/// that assert diagnostics without execution keep their expectations
/// verbatim.</para>
/// <para><b>Runtime failures.</b> An exception the program does not catch is
/// unwrapped from the reflection boundary and surfaces both as
/// <see cref="EmittedOracleResult.UnhandledException"/> and as a synthesized
/// <c>GS9999</c> error diagnostic carrying the exception's
/// <see cref="Exception.Message"/> — the historical evaluator's
/// uncaught-exception protocol, minus the interpreter-only source-node
/// location (the synthesized diagnostic carries a default location; tests
/// asserting runtime-error <em>locations</em> are evaluator-specific and stay
/// on the old oracle until Phase 3c retires them).</para>
/// <para><b>ALC lifetime.</b> Each call gets its own collectible context and
/// unload is initiated before the result is returned. Collectible unload is
/// cooperative: the context, its assembly, and any returned
/// <see cref="EmittedOracleResult.Value"/> of a submission-declared type stay
/// fully usable for as long as the test holds them — assertions after return
/// are safe by construction, and the context is reclaimed when the last
/// reference dies.</para>
/// <para><b>Concurrency.</b> The oracle keeps no per-call shared state (no
/// temp files — the PE never touches disk) and compiles concurrently; only the
/// execute window is serialized by a process-wide gate, because console
/// capture rides the process-global <see cref="Console.SetOut(TextWriter)"/>.
/// Suites additionally keep their existing <c>ConsoleIo</c> collection
/// discipline for tests that redirect the console themselves.</para>
/// </remarks>
public static class EmittedOracle
{
    private static readonly object ConsoleGate = new();

    // One process-wide host-reference snapshot, taken on first oracle use.
    // ReferenceResolver.Default() rescans AppDomain.CurrentDomain.GetAssemblies()
    // on every call, so a fresh per-call resolver would see the still-loaded
    // collectible assemblies of EARLIER oracle runs — and their emitted types
    // would shadow same-named source packages in later compilations
    // (issue #3235). Snapshotting once keeps every oracle compilation's
    // reference surface identical and oracle-emission-free.
    private static readonly Lazy<ReferenceResolver> SharedDefaultResolver =
        new(() => ReferenceResolver.Default(), LazyThreadSafetyMode.ExecutionAndPublication);

    private static int submissionCounter;

    /// <summary>
    /// Compiles <paramref name="source"/> as a one-shot submission, runs it
    /// emitted and in-process, and returns the full assertion surface.
    /// </summary>
    /// <param name="source">The G# source text.</param>
    /// <returns>The oracle result.</returns>
    public static EmittedOracleResult Evaluate(string source)
        => Evaluate(source, references: null);

    /// <summary>
    /// Compiles <paramref name="source"/> as a one-shot submission against
    /// the given reference assemblies, runs it emitted and in-process, and
    /// returns the full assertion surface.
    /// </summary>
    /// <param name="source">The G# source text.</param>
    /// <param name="references">Reference assembly paths resolvable at compile and run time (the <c>/r:</c> channel); may be <see langword="null"/>.</param>
    /// <returns>The oracle result.</returns>
    public static EmittedOracleResult Evaluate(string source, IReadOnlyList<string> references)
    {
        if (source is null)
        {
            throw new ArgumentNullException(nameof(source));
        }

        return Evaluate(new[] { source }, new EmittedOracleOptions { References = references });
    }

    /// <summary>
    /// Compiles all <paramref name="sources"/> as the syntax trees of one
    /// compilation — the multi-tree equivalent of
    /// <c>new Compilation(t1, t2, …).Evaluate(…)</c> — applying the given
    /// compilation <paramref name="options"/>, and returns the full assertion
    /// surface. Unless <see cref="EmittedOracleOptions.IsLibrary"/> is set the
    /// sources compile as a one-shot submission and run emitted in-process;
    /// a library compilation emits and returns diagnostics without executing
    /// (there is no entry point to run — the historical evaluator likewise
    /// had nothing to execute for a library).
    /// </summary>
    /// <param name="sources">The G# source texts, one per syntax tree, in compilation order.</param>
    /// <param name="options">Compilation-level knobs; <see langword="null"/> for defaults.</param>
    /// <returns>The oracle result.</returns>
    public static EmittedOracleResult Evaluate(IReadOnlyList<string> sources, EmittedOracleOptions options = null)
    {
        if (sources is null)
        {
            throw new ArgumentNullException(nameof(sources));
        }

        if (sources.Count == 0 || sources.Any(s => s is null))
        {
            throw new ArgumentException("At least one non-null source is required.", nameof(sources));
        }

        options ??= new EmittedOracleOptions();
        var referencePaths = options.References?.Where(r => !string.IsNullOrWhiteSpace(r)).ToArray() ?? Array.Empty<string>();
        var n = Interlocked.Increment(ref submissionCounter);
        var assemblyName = "oracle$" + n;
        var packageName = "oracle" + n;

        var trees = sources.Select(s => SyntaxTree.Parse(SourceText.From(s))).ToArray();
        var resolver = referencePaths.Length > 0
            ? ReferenceResolver.WithReferences(referencePaths)
            : SharedDefaultResolver.Value;

        var compilation = new Compilation(resolver, trees);
        if (options.ImplicitSystemImport is bool implicitSystemImport)
        {
            compilation.ImplicitSystemImport = implicitSystemImport;
        }

        if (options.IsLibrary)
        {
            // A library has no entry point and forbids top-level statements,
            // so there is nothing to wrap in a submission — and nothing to
            // run afterwards.
            compilation.IsLibrary = true;
        }
        else
        {
            compilation.Submission = new SubmissionBindingOptions
            {
                Imports = SubmissionImports.Create(ImmutableArray<SubmissionReference>.Empty),
                DefaultPackageName = packageName,
            };
        }

        using var peStream = new MemoryStream();
        var emitResult = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: assemblyName);

        // Mirror Compilation.Evaluate's compile-failure shape: warnings first,
        // then errors, value null, nothing executed.
        var warnings = emitResult.Diagnostics.Where(d => !d.IsError).ToImmutableArray();
        var errors = emitResult.Diagnostics.Where(d => d.IsError).ToImmutableArray();
        if (!emitResult.Success || errors.Length > 0)
        {
            return new EmittedOracleResult(
                warnings.Concat(errors).ToImmutableArray(),
                value: null,
                output: string.Empty,
                errorOutput: string.Empty,
                exitCode: 1,
                unhandledException: null,
                loadContext: null);
        }

        if (options.IsLibrary)
        {
            return new EmittedOracleResult(
                warnings,
                value: null,
                output: string.Empty,
                errorOutput: string.Empty,
                exitCode: 0,
                unhandledException: null,
                loadContext: null);
        }

        return Execute(peStream, referencePaths, warnings);
    }

    /// <summary>
    /// Fully binds the caller's <paramref name="compilation"/> — global scope
    /// plus every function/method body and top-level statement — and returns
    /// its diagnostics in <c>Compilation.Evaluate</c>'s pre-execution shape
    /// (parse, then global-scope, then body diagnostics; warnings before
    /// errors), without ever executing. The binder-inspection companion for
    /// Phase 3b.2 (issue #3176): tests that assert on the compilation's bound
    /// state afterwards (<c>GlobalScope</c>, <c>BoundProgram</c>) keep their
    /// own <c>Compilation</c> instance and stop running code they never
    /// observe. The interpreter-only diagnostics <c>Compilation.Evaluate</c>
    /// appended after this point (deinit GS0510, P/Invoke GS0514) never
    /// appear — those constructs simply work under emitted execution
    /// (ADR-0156); tests asserting them are evaluator-machinery pins.
    /// </summary>
    /// <param name="compilation">The compilation to bind.</param>
    /// <returns>The full bind-time diagnostics, warnings first.</returns>
    public static ImmutableArray<Diagnostic> CompileDiagnostics(Compilation compilation)
    {
        if (compilation is null)
        {
            throw new ArgumentNullException(nameof(compilation));
        }

        var all = compilation.SyntaxTrees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();
        return all.Where(d => !d.IsError).Concat(all.Where(d => d.IsError)).ToImmutableArray();
    }

    private static EmittedOracleResult Execute(
        MemoryStream peStream,
        IReadOnlyList<string> referencePaths,
        ImmutableArray<Diagnostic> warnings)
    {
        var loadContext = new AssemblyLoadContext("gsharp-oracle-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        var weakContext = new WeakReference(loadContext);
        loadContext.Resolving += (context, name) => ResolveDependency(context, name, referencePaths);

        var stdout = new StringWriter();
        var stderr = new StringWriter();

        try
        {
            peStream.Position = 0;
            var assembly = loadContext.LoadFromStream(peStream);
            var entryPoint = assembly.EntryPoint;

            object returnValue = null;
            Exception unhandledException = null;
            if (entryPoint is not null)
            {
                var arguments = entryPoint.GetParameters().Length == 0
                    ? null
                    : new object[] { Array.Empty<string>() };

                // Serialize the redirected-console window across concurrent
                // oracle calls; compilation and emit stay parallel.
                lock (ConsoleGate)
                {
                    var originalOut = Console.Out;
                    var originalError = Console.Error;
                    Console.SetOut(stdout);
                    Console.SetError(stderr);
                    try
                    {
                        returnValue = entryPoint.Invoke(null, arguments);
                    }
                    catch (TargetInvocationException ex) when (ex.InnerException is not null)
                    {
                        unhandledException = ex.InnerException;
                    }
                    catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
                    {
                        unhandledException = ex;
                    }
                    finally
                    {
                        Console.SetOut(originalOut);
                        Console.SetError(originalError);
                    }
                }
            }

            if (unhandledException is not null)
            {
                // The historical evaluator surfaced an uncaught exception as a
                // GS9999 error diagnostic with the exception's message; keep
                // that assertion surface (location is default — runtime code
                // has no bound-node context) and expose the exception itself.
                var runtimeDiagnostic = new Diagnostic(default, "GS9999", DiagnosticSeverity.Error, unhandledException.Message);
                return new EmittedOracleResult(
                    warnings.Add(runtimeDiagnostic),
                    value: null,
                    stdout.ToString(),
                    stderr.ToString(),
                    EmittedProgramHost.UnhandledExceptionExitCode,
                    unhandledException,
                    weakContext,
                    assembly);
            }

            // Prefer the synthesized trailing-expression capture; fall back to
            // the entry point's return value (an explicit int/uint `main`),
            // mirroring EmittedSessionEngine's echo protocol.
            TryReadResultField(assembly, out var captured);
            var value = captured ?? returnValue;
            var exitCode = returnValue switch
            {
                int intValue => intValue,
                uint uintValue => unchecked((int)uintValue),
                _ => 0,
            };

            return new EmittedOracleResult(
                warnings,
                value,
                stdout.ToString(),
                stderr.ToString(),
                exitCode,
                unhandledException: null,
                weakContext,
                assembly);
        }
        finally
        {
            // Initiate unload; reclamation waits for the last reference (the
            // returned result's Value included) to die, so returned values
            // remain safe to assert on.
            loadContext.Unload();
        }
    }

    private static bool TryReadResultField(Assembly assembly, out object value)
    {
        value = null;
        Type[] types;
        try
        {
            types = assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            types = ex.Types.Where(t => t is not null).ToArray();
        }

        foreach (var type in types)
        {
            if (!string.Equals(type.Name, SubmissionImports.ProgramTypeName, StringComparison.Ordinal))
            {
                continue;
            }

            var field = type.GetField(SubmissionImports.ResultFieldName, BindingFlags.Public | BindingFlags.Static);
            if (field is not null)
            {
                value = field.GetValue(null);
                return true;
            }
        }

        return false;
    }

    private static Assembly ResolveDependency(
        AssemblyLoadContext context,
        AssemblyName assemblyName,
        IReadOnlyList<string> referencePaths)
    {
        // User-supplied references win over any same-named host assembly so
        // the program binds against exactly what it was compiled against —
        // mirrors EmittedProgramHost's script-mode resolution.
        if (assemblyName.Name is not null)
        {
            var match = referencePaths.FirstOrDefault(path =>
                string.Equals(Path.GetFileNameWithoutExtension(path), assemblyName.Name, StringComparison.OrdinalIgnoreCase)
                && File.Exists(path));
            if (match is not null)
            {
                return context.LoadFromAssemblyPath(Path.GetFullPath(match));
            }
        }

        // Framework, test-assembly, and transitive dependencies fall back to
        // the default context.
        try
        {
            return Assembly.Load(assemblyName);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (FileLoadException)
        {
            return null;
        }
        catch (BadImageFormatException)
        {
            return null;
        }
    }
}
