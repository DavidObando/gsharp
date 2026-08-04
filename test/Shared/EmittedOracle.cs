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

        var referencePaths = references?.Where(r => !string.IsNullOrWhiteSpace(r)).ToArray() ?? Array.Empty<string>();
        var n = Interlocked.Increment(ref submissionCounter);
        var assemblyName = "oracle$" + n;
        var packageName = "oracle" + n;

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var resolver = referencePaths.Length > 0
            ? ReferenceResolver.WithReferences(referencePaths)
            : ReferenceResolver.Default();

        var compilation = new Compilation(resolver, tree)
        {
            Submission = new SubmissionBindingOptions
            {
                Imports = SubmissionImports.Create(ImmutableArray<SubmissionReference>.Empty),
                DefaultPackageName = packageName,
            },
        };

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

        return Execute(peStream, referencePaths, warnings);
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
                    weakContext);
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
                weakContext);
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
