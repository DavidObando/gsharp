// <copyright file="EmittedProgramHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Execution;

/// <summary>
/// Shared execution host for the evaluating drivers (ADR-0156 Phase 1):
/// compiles a <see cref="Compilation.Compilation"/> with the real emitter into
/// a <see cref="MemoryStream"/>, loads the PE bytes into a collectible
/// <see cref="AssemblyLoadContext"/>, invokes the entry point in-process, and
/// maps the outcome onto the drivers' exit-code protocol. Framework
/// dependencies resolve through the default load context; user-supplied
/// reference assemblies (<c>/r:</c>) resolve from their explicit paths.
/// </summary>
/// <remarks>
/// <para>The program's console is the host process's console — output and
/// input stream straight through, exactly as under <c>dotnet exec</c>, and
/// callers that need capture use the process-global <see cref="Console.SetOut(TextWriter)"/>
/// as they always have.</para>
/// <para>Cancellation is best-effort and matches the historical evaluator
/// drivers: the token is only observed before the entry point is invoked, so
/// an already-running program cannot be interrupted, and Ctrl+C keeps its
/// process-default behavior in the CLI drivers.</para>
/// <para>In-process execution inherits the same hazards the tree-walking
/// evaluator had: <see cref="Environment.Exit(int)"/> in user code terminates
/// the driver, and threads the program spawned may outlive its entry point.</para>
/// </remarks>
public static class EmittedProgramHost
{
    /// <summary>
    /// Gets the exit code a driver reports when the program threw an
    /// unhandled exception, matching the CLR host's crash exit code
    /// (SIGABRT's 134 on Unix, the CLR exception COMPLUS code on Windows).
    /// </summary>
    public static int UnhandledExceptionExitCode { get; } =
        OperatingSystem.IsWindows() ? unchecked((int)0xE0434352) : 134;

    /// <summary>
    /// Renders an unhandled program exception the way the CLR host does for
    /// an emitted executable: <c>Unhandled exception. </c> followed by the
    /// exception text, with the reflection-invoker frames the in-process
    /// invocation appends below the program's own frames trimmed away so the
    /// text matches <c>dotnet exec</c> byte-for-byte.
    /// </summary>
    /// <param name="unhandledException">The unhandled exception from <see cref="EmittedProgramResult.UnhandledException"/>.</param>
    /// <returns>The single- or multi-line crash text, without a trailing newline.</returns>
    public static string FormatUnhandledException(Exception unhandledException)
    {
        if (unhandledException is null)
        {
            throw new ArgumentNullException(nameof(unhandledException));
        }

        var lines = unhandledException.ToString()
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n')
            .ToList();
        while (lines.Count > 0 && IsReflectionInvokerFrame(lines[^1]))
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return "Unhandled exception. " + string.Join(Environment.NewLine, lines);
    }

    /// <summary>
    /// Compiles <paramref name="compilation"/> to memory and, when emit
    /// succeeds, executes its entry point in a collectible
    /// <see cref="AssemblyLoadContext"/> which is unloaded before returning.
    /// </summary>
    /// <param name="compilation">The compilation to emit and run.</param>
    /// <param name="referencePaths">User-supplied reference assembly paths (<c>/r:</c>) made resolvable at runtime; may be <see langword="null"/>.</param>
    /// <param name="cancellationToken">Best-effort cancellation, observed only before the entry point is invoked.</param>
    /// <returns>The emit diagnostics plus the program's exit code or unhandled exception.</returns>
    /// <exception cref="OperationCanceledException">The token was cancelled before the program was invoked.</exception>
    public static EmittedProgramResult Run(
        Compilation.Compilation compilation,
        IReadOnlyList<string>? referencePaths = null,
        CancellationToken cancellationToken = default)
    {
        if (compilation is null)
        {
            throw new ArgumentNullException(nameof(compilation));
        }

        using var peStream = new MemoryStream();
        var emitResult = compilation.Emit(peStream);
        if (!emitResult.Success)
        {
            return EmittedProgramResult.FromFailedEmit(emitResult.Diagnostics);
        }

        cancellationToken.ThrowIfCancellationRequested();

        var (exitCode, unhandledException, loadContext) = LoadAndInvoke(peStream, referencePaths);
        return EmittedProgramResult.FromExecution(emitResult.Diagnostics, exitCode, unhandledException, loadContext);
    }

    private static bool IsReflectionInvokerFrame(string line)
    {
        var trimmed = line.TrimStart();
        return trimmed.StartsWith("at System.Reflection.MethodBaseInvoker.", StringComparison.Ordinal)
            || trimmed.StartsWith("at System.Reflection.RuntimeMethodInfo.Invoke(", StringComparison.Ordinal)
            || trimmed.StartsWith("at System.Reflection.MethodBase.Invoke(", StringComparison.Ordinal)
            || trimmed.StartsWith("at System.RuntimeMethodHandle.InvokeMethod(", StringComparison.Ordinal);
    }

    private static (int ExitCode, Exception? UnhandledException, WeakReference LoadContext) LoadAndInvoke(
        MemoryStream peStream,
        IReadOnlyList<string>? referencePaths)
    {
        var loadContext = new AssemblyLoadContext($"gsharp-emitted-{Guid.NewGuid():N}", isCollectible: true);
        var weakReference = new WeakReference(loadContext);
        Func<AssemblyLoadContext, AssemblyName, Assembly?> resolver =
            (context, assemblyName) => ResolveDependency(context, assemblyName, referencePaths);
        AddResolvingHandler(loadContext, resolver);

        try
        {
            peStream.Position = 0;
            var assembly = loadContext.LoadFromStream(peStream);
            var entryPoint = assembly.EntryPoint;
            if (entryPoint is null)
            {
                // A declaration-only script emits no runnable statements; the
                // historical drivers report success with exit code 0.
                return (0, null, weakReference);
            }

            // The CLR host validates the managed entry point's signature
            // before running a single user statement; mirror its check (and
            // its exact crash text) so an invalid Main crashes identically
            // under `dotnet exec` and the in-memory drivers. IsSameAs keeps
            // the issue-#835 typeof-identity guard clean even though these
            // are runtime-loaded (never MetadataLoadContext) types.
            if (!entryPoint.ReturnType.IsSameAs(typeof(void))
                && !entryPoint.ReturnType.IsSameAs(typeof(int))
                && !entryPoint.ReturnType.IsSameAs(typeof(uint)))
            {
                var invalidEntryPoint = new MethodAccessException(
                    "Entry point must have a return type of void, integer, or unsigned integer.");
                return (UnhandledExceptionExitCode, invalidEntryPoint, weakReference);
            }

            var arguments = entryPoint.GetParameters().Length == 0
                ? null
                : new object[] { Array.Empty<string>() };

            object? returnValue;
            try
            {
                returnValue = entryPoint.Invoke(null, arguments);
            }
            catch (TargetInvocationException ex) when (ex.InnerException is not null)
            {
                // The inner exception's stack trace was frozen at the
                // reflection boundary, so it ends at the program's own frames —
                // rendering it reproduces exactly what the CLR host prints
                // for an emitted executable, with no host frames appended.
                return (UnhandledExceptionExitCode, ex.InnerException, weakReference);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
            {
                return (UnhandledExceptionExitCode, ex, weakReference);
            }

            var exitCode = returnValue switch
            {
                int value => value,
                uint value => unchecked((int)value),
                _ => 0,
            };

            return (exitCode, null, weakReference);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void AddResolvingHandler(
        AssemblyLoadContext loadContext,
        Func<AssemblyLoadContext, AssemblyName, Assembly?> resolver)
    {
        var resolvingEvent = typeof(AssemblyLoadContext).GetEvent("Resolving");
        resolvingEvent?.AddEventHandler(loadContext, resolver);
    }

    private static Assembly? ResolveDependency(
        AssemblyLoadContext context,
        AssemblyName assemblyName,
        IReadOnlyList<string>? referencePaths)
    {
        // User-supplied references win over any same-named host assembly so
        // the program binds against exactly what it was compiled against.
        if (referencePaths is not null && assemblyName.Name is not null)
        {
            string? match = null;
            foreach (var path in referencePaths)
            {
                if (!string.IsNullOrWhiteSpace(path)
                    && string.Equals(Path.GetFileNameWithoutExtension(path), assemblyName.Name, StringComparison.OrdinalIgnoreCase)
                    && File.Exists(path))
                {
                    match = path;
                    break;
                }
            }

            if (match is not null)
            {
                return context.LoadFromAssemblyPath(Path.GetFullPath(match));
            }
        }

        // Framework and transitive dependencies fall back to the default
        // context, mirroring how the emitted program would bind under the
        // shared-framework host.
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
