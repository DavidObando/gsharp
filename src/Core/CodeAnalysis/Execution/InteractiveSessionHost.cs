// <copyright file="InteractiveSessionHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;

namespace GSharp.Core.CodeAnalysis.Execution;

/// <summary>
/// Execution host for the interactive REPL (ADR-0156 Phase 2). Owns one
/// collectible <see cref="AssemblyLoadContext"/> for the whole session: each
/// submission's emitted PE loads into it and stays loaded — submission
/// <c>N+1</c> references <c>N</c>'s assembly and its live static state, so
/// the unit of unload is the session, reclaimed by <see cref="Reset"/> or
/// <see cref="Dispose"/>. Framework dependencies resolve through the default
/// load context; sibling submissions resolve by name from the session's own
/// loaded set; user-supplied reference assemblies (<c>/r:</c>) resolve from
/// their explicit paths.
/// </summary>
public sealed class InteractiveSessionHost : IDisposable
{
    private readonly object gate = new();
    private readonly IReadOnlyList<string> referencePaths;
    private Dictionary<string, Assembly>? loadedByName;
    private AssemblyLoadContext? loadContext;
    private bool disposed;

    /// <summary>
    /// Initializes a new instance of the <see cref="InteractiveSessionHost"/> class.
    /// </summary>
    /// <param name="referencePaths">User-supplied reference assembly paths (<c>/r:</c>) made resolvable at runtime; may be <see langword="null"/>.</param>
    public InteractiveSessionHost(IReadOnlyList<string>? referencePaths = null)
    {
        this.referencePaths = referencePaths ?? Array.Empty<string>();
        CreateLoadContext();
    }

    /// <summary>
    /// Loads a submission's emitted PE bytes into the session context and
    /// invokes its entry point (when one exists — a declarations-only
    /// submission has none and simply loads). The assembly stays loaded for
    /// the rest of the session either way; a submission whose entry point
    /// threw keeps whatever side effects it already applied, exactly like the
    /// historical evaluator's partial-state behavior.
    /// </summary>
    /// <param name="peImage">The emitted PE image.</param>
    /// <param name="assemblyName">The submission assembly's simple name (used for sibling resolution).</param>
    /// <returns>The loaded assembly plus the entry point's outcome.</returns>
    public SubmissionRunResult RunSubmission(byte[] peImage, string assemblyName)
    {
        if (peImage is null)
        {
            throw new ArgumentNullException(nameof(peImage));
        }

        ObjectDisposedException.ThrowIf(disposed, this);

        Assembly assembly;
        lock (gate)
        {
            using var stream = new MemoryStream(peImage, writable: false);

            // loadContext is assigned in the constructor and cleared only by
            // Dispose; a disposed host is not reused.
            assembly = loadContext!.LoadFromStream(stream);
            if (!string.IsNullOrEmpty(assemblyName))
            {
                loadedByName![assemblyName] = assembly;
            }
        }

        var entryPoint = assembly.EntryPoint;
        if (entryPoint is null)
        {
            return new SubmissionRunResult(assembly, returnValue: null, unhandledException: null);
        }

        var arguments = entryPoint.GetParameters().Length == 0
            ? null
            : new object[] { Array.Empty<string>() };

        try
        {
            var returnValue = entryPoint.Invoke(null, arguments);
            return new SubmissionRunResult(assembly, returnValue, unhandledException: null);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            return new SubmissionRunResult(assembly, returnValue: null, unhandledException: ex.InnerException);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            return new SubmissionRunResult(assembly, returnValue: null, unhandledException: ex);
        }
    }

    /// <summary>
    /// Reads a public static field from a loaded submission assembly via
    /// runtime reflection — the value channel for the REPL's cell echo
    /// (the synthesized <c>&lt;Result&gt;$</c> field) and the state sidebar's
    /// values column. Returns <see langword="null"/> when the type or field
    /// does not exist.
    /// </summary>
    /// <param name="assembly">The loaded submission assembly.</param>
    /// <param name="typeFullName">The declaring type's metadata full name (e.g. <c>gsi3.&lt;Program&gt;</c>).</param>
    /// <param name="fieldName">The static field's name.</param>
    /// <returns>The field's current value, or <see langword="null"/>.</returns>
    public object? ReadStaticField(Assembly assembly, string typeFullName, string fieldName)
    {
        if (assembly is null)
        {
            return null;
        }

        try
        {
            var type = assembly.GetType(typeFullName, throwOnError: false);
            var field = type?.GetField(fieldName, BindingFlags.Public | BindingFlags.Static);
            return field?.GetValue(null);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            return null;
        }
    }

    /// <summary>
    /// Unloads the session's load context (letting real deinitializers run
    /// when the finalizer queue drains after collection) and starts a fresh
    /// one, discarding every loaded submission.
    /// </summary>
    public void Reset()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);

            // ThrowIf above rules out the disposed state, the only one in
            // which loadContext is null.
            loadContext!.Unload();
            CreateLoadContext();
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        lock (gate)
        {
            if (disposed)
            {
                return;
            }

            disposed = true;

            // The `disposed` guard above returns early on a second call, so
            // loadContext is still the one the constructor assigned.
            loadContext!.Unload();
            loadContext = null;
            loadedByName = null;
        }
    }

    private void CreateLoadContext()
    {
        loadedByName = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
        loadContext = new AssemblyLoadContext($"gsi-session-{Guid.NewGuid():N}", isCollectible: true);
        Func<AssemblyLoadContext, AssemblyName, Assembly?> resolver =
            (context, assemblyName) => ResolveDependency(context, assemblyName);
        AddResolvingHandler(loadContext, resolver);
    }

    private static void AddResolvingHandler(
        AssemblyLoadContext context,
        Func<AssemblyLoadContext, AssemblyName, Assembly?> resolver)
    {
        var resolvingEvent = typeof(AssemblyLoadContext).GetEvent("Resolving");
        resolvingEvent?.AddEventHandler(context, resolver);
    }

    private Assembly? ResolveDependency(AssemblyLoadContext context, AssemblyName assemblyName)
    {
        if (assemblyName.Name is null)
        {
            return null;
        }

        // Sibling submissions resolve from the session's own loaded set.
        lock (gate)
        {
            if (loadedByName is not null && loadedByName.TryGetValue(assemblyName.Name, out var sibling))
            {
                return sibling;
            }
        }

        // User-supplied references win over any same-named host assembly so
        // the submission binds against exactly what it was compiled against.
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

        // Framework and transitive dependencies fall back to the default
        // context, mirroring EmittedProgramHost's script-mode resolution.
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

/// <summary>
/// The outcome of running one submission: the loaded assembly (always
/// non-null — a submission that threw stays loaded), the entry point's
/// return value, and the unhandled exception when the submission threw.
/// </summary>
public sealed class SubmissionRunResult
{
    internal SubmissionRunResult(Assembly assembly, object? returnValue, Exception? unhandledException)
    {
        Assembly = assembly;
        ReturnValue = returnValue;
        UnhandledException = unhandledException;
    }

    /// <summary>Gets the loaded submission assembly.</summary>
    public Assembly Assembly { get; }

    /// <summary>Gets the entry point's return value (<see langword="null"/> for void or on failure).</summary>
    public object? ReturnValue { get; }

    /// <summary>Gets the exception the submission's entry point threw, or <see langword="null"/> on success.</summary>
    public Exception? UnhandledException { get; }
}
