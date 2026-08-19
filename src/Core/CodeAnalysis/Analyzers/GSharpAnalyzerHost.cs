// <copyright file="GSharpAnalyzerHost.cs" company="GSharp">
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

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Loads analyzer assemblies (gsc's <c>/gsanalyzer:</c>, the language
/// server's project analyzer set) and runs them through
/// <see cref="GSharpAnalyzerDriver"/> (ADR-0169). Each assembly loads in its
/// own <see cref="AssemblyLoadContext"/> whose resolution unifies
/// <c>GSharp.Core</c> (and anything already loaded in the default context) to
/// the host's copies, so analyzer-declared types are identity-compatible with
/// the driver's.
/// </summary>
public static class GSharpAnalyzerHost
{
    /// <summary>
    /// Loads every assembly in <paramref name="analyzerPaths"/> and discovers
    /// its analyzers. Load failures surface as GS9301; Core version
    /// mismatches as GS9303.
    /// </summary>
    /// <param name="analyzerPaths">Analyzer assembly paths.</param>
    /// <param name="hostDiagnostics">GS9301/GS9303 diagnostics produced while loading.</param>
    /// <returns>The discovered analyzers.</returns>
    public static ImmutableArray<GSharpDiagnosticAnalyzer> Load(
        IReadOnlyList<string> analyzerPaths,
        out ImmutableArray<Diagnostic> hostDiagnostics)
    {
        var diagnostics = ImmutableArray.CreateBuilder<Diagnostic>();
        var analyzers = ImmutableArray.CreateBuilder<GSharpDiagnosticAnalyzer>();

        foreach (var path in analyzerPaths)
        {
            LoadAnalyzers(path, analyzers, diagnostics);
        }

        hostDiagnostics = diagnostics.ToImmutable();
        return analyzers.ToImmutable();
    }

    /// <summary>
    /// Loads the analyzers in <paramref name="analyzerPaths"/> and runs them
    /// over <paramref name="compilation"/>.
    /// </summary>
    /// <param name="compilation">The bound compilation to analyze.</param>
    /// <param name="analyzerPaths">Analyzer assembly paths.</param>
    /// <param name="options">Optional driver options.</param>
    /// <param name="cancellationToken">Cancels the driver run.</param>
    /// <returns>Host and analyzer diagnostics.</returns>
    public static ImmutableArray<Diagnostic> Run(
        Compilation.Compilation compilation,
        IReadOnlyList<string> analyzerPaths,
        AnalyzerOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var analyzers = Load(analyzerPaths, out var hostDiagnostics);
        var produced = GSharpAnalyzerDriver.Run(compilation, analyzers, options, cancellationToken);
        return hostDiagnostics.AddRange(produced);
    }

    private static void LoadAnalyzers(
        string path,
        ImmutableArray<GSharpDiagnosticAnalyzer>.Builder analyzers,
        ImmutableArray<Diagnostic>.Builder hostDiagnostics)
    {
        try
        {
            var fullPath = Path.GetFullPath(path);
            var loadContext = new AnalyzerLoadContext(fullPath);
            var assembly = loadContext.LoadFromAssemblyPath(fullPath);

            CheckCoreVersion(assembly, fullPath, hostDiagnostics);

            var found = 0;
            foreach (var type in assembly.GetExportedTypes())
            {
                if (type.IsAbstract
                    || !typeof(GSharpDiagnosticAnalyzer).IsAssignableFrom(type)
                    || type.GetCustomAttribute<GSharpDiagnosticAnalyzerAttribute>() is null)
                {
                    continue;
                }

                // `!`: CreateInstance returns null only for Nullable<T>, and
                // the discovery filter admits only non-abstract reference
                // types deriving from GSharpDiagnosticAnalyzer.
                analyzers.Add((GSharpDiagnosticAnalyzer)Activator.CreateInstance(type)!);
                found++;
            }

            if (found == 0)
            {
                hostDiagnostics.Add(Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                    default,
                    path,
                    "the assembly contains no [GSharpDiagnosticAnalyzer] types deriving from GSharpDiagnosticAnalyzer."));
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            hostDiagnostics.Add(Diagnostic.Create(
                DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                default,
                path,
                ex.Message));
        }
    }

    private static void CheckCoreVersion(
        Assembly assembly,
        string path,
        ImmutableArray<Diagnostic>.Builder hostDiagnostics)
    {
        var hostCore = typeof(GSharpDiagnosticAnalyzer).Assembly.GetName();
        var referencedCore = assembly.GetReferencedAssemblies()
            .FirstOrDefault(name => string.Equals(name.Name, hostCore.Name, StringComparison.OrdinalIgnoreCase));

        if (referencedCore?.Version is { } referencedVersion
            && hostCore.Version is { } hostVersion
            && referencedVersion != hostVersion)
        {
            hostDiagnostics.Add(Diagnostic.Create(
                DiagnosticDescriptors.AnalyzerCoreVersionMismatch,
                default,
                path,
                referencedVersion,
                hostVersion));
        }
    }

    /// <summary>
    /// A collectible load context that resolves any assembly already loaded
    /// in the default context (GSharp.Core, the BCL) to the host's copy and
    /// probes next to the analyzer assembly for its private dependencies.
    /// </summary>
    private sealed class AnalyzerLoadContext : AssemblyLoadContext
    {
        private readonly string analyzerDirectory;

        public AnalyzerLoadContext(string analyzerPath)
            : base($"gsanalyzer:{Path.GetFileName(analyzerPath)}", isCollectible: true)
        {
            analyzerDirectory = Path.GetDirectoryName(analyzerPath) ?? string.Empty;
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            foreach (var loaded in Default.Assemblies)
            {
                if (string.Equals(loaded.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase))
                {
                    return loaded;
                }
            }

            var candidate = Path.Combine(analyzerDirectory, assemblyName.Name + ".dll");
            if (File.Exists(candidate))
            {
                return LoadFromAssemblyPath(candidate);
            }

            // Fall through to the default context (framework assemblies).
            return null;
        }
    }
}
