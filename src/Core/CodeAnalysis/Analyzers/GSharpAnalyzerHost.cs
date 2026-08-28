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
            var exportedTypes = assembly.GetExportedTypes();
            foreach (var type in exportedTypes)
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
                // Issue #3617: a zero-discovery result has three very
                // different causes — wrong bytes at the path (e.g. a stale
                // Roslyn-era assembly), a type-identity split (the analyzer's
                // GSharpDiagnosticAnalyzer base bound to a DIFFERENT
                // GSharp.Core instance than the host's), or a genuinely empty
                // assembly. Emit enough forensic detail that one CI log
                // distinguishes them.
                string zeroDiscovery =
                    "the assembly contains no [GSharpDiagnosticAnalyzer] types deriving from GSharpDiagnosticAnalyzer. "
                    + DescribeZeroDiscovery(assembly, fullPath, exportedTypes);
                hostDiagnostics.Add(Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                    default,
                    path,
                    zeroDiscovery));
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            hostDiagnostics.Add(Diagnostic.Create(
                DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                default,
                path,
                DescribeLoadException(ex)));
        }
    }

    /// <summary>
    /// Issue #3617: builds the forensic tail of the zero-discovery GS9301 —
    /// the exported-type census, per-candidate filter verdicts with the
    /// identity/location/MVID of each candidate's resolved analyzer base
    /// assembly versus the host's own, and the analyzer file's size and MVID.
    /// </summary>
    private static string DescribeZeroDiscovery(Assembly assembly, string fullPath, Type[] exportedTypes)
    {
        var sb = new System.Text.StringBuilder();
        try
        {
            var hostBase = typeof(GSharpDiagnosticAnalyzer);
            sb.Append("Forensics: exportedTypes=").Append(exportedTypes.Length);

            var fileInfo = new FileInfo(fullPath);
            sb.Append("; file(size=").Append(fileInfo.Exists ? fileInfo.Length : -1)
                .Append(", mvid=").Append(assembly.ManifestModule.ModuleVersionId)
                .Append(')');

            var referencedCore = assembly.GetReferencedAssemblies()
                .FirstOrDefault(name => string.Equals(name.Name, hostBase.Assembly.GetName().Name, StringComparison.OrdinalIgnoreCase));
            sb.Append("; referencedCore=").Append(referencedCore?.Version?.ToString() ?? "<none>")
                .Append("; hostCore(version=").Append(hostBase.Assembly.GetName().Version)
                .Append(", location=").Append(hostBase.Assembly.Location)
                .Append(", mvid=").Append(hostBase.Assembly.ManifestModule.ModuleVersionId)
                .Append(')');

            // Candidates that carry the attribute BY NAME but failed a filter:
            // the smoking gun for identity splits is a base assembly whose
            // location/MVID differs from the host's.
            foreach (var type in exportedTypes)
            {
                bool namedAttribute = type.GetCustomAttributesData()
                    .Any(attribute => attribute.AttributeType.Name == nameof(GSharpDiagnosticAnalyzerAttribute));
                var analyzerBase = FindAnalyzerBase(type, hostBase.FullName);
                if (!namedAttribute && analyzerBase == null)
                {
                    continue;
                }

                sb.Append("; candidate ").Append(type.FullName)
                    .Append("(abstract=").Append(type.IsAbstract)
                    .Append(", namedAttr=").Append(namedAttribute)
                    .Append(", assignable=").Append(hostBase.IsAssignableFrom(type));
                if (analyzerBase != null)
                {
                    sb.Append(", baseAssembly=").Append(analyzerBase.Assembly.GetName().Version)
                        .Append('@').Append(analyzerBase.Assembly.Location)
                        .Append(", baseMvid=").Append(analyzerBase.Assembly.ManifestModule.ModuleVersionId)
                        .Append(", baseIsHost=").Append(ReferenceEquals(analyzerBase.Assembly, hostBase.Assembly));
                }

                sb.Append(')');
            }
        }
        catch (Exception forensics) when (forensics is not OutOfMemoryException and not StackOverflowException)
        {
            sb.Append("; forensics-failed: ").Append(forensics.GetType().Name).Append(": ").Append(forensics.Message);
        }

        return sb.ToString();
    }

    private static Type? FindAnalyzerBase(Type type, string? analyzerBaseFullName)
    {
        for (var current = type.BaseType; current != null; current = current.BaseType)
        {
            if (current.FullName == analyzerBaseFullName)
            {
                return current;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #3617: a load exception's Message alone hid every actionable
    /// detail (two CI runs produced no data). Surface the exception chain and
    /// any per-type loader failures.
    /// </summary>
    private static string DescribeLoadException(Exception ex)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(ex.GetType().Name).Append(": ").Append(ex.Message);
        if (ex is ReflectionTypeLoadException typeLoad)
        {
            foreach (var loaderException in typeLoad.LoaderExceptions.Take(5))
            {
                if (loaderException != null)
                {
                    sb.Append(" | loader: ").Append(loaderException.GetType().Name)
                        .Append(": ").Append(loaderException.Message);
                }
            }
        }

        for (var inner = ex.InnerException; inner != null; inner = inner.InnerException)
        {
            sb.Append(" | inner: ").Append(inner.GetType().Name).Append(": ").Append(inner.Message);
        }

        return sb.ToString();
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
            // Issue #3617: resolve HOST-OWNED assemblies to the host's own
            // instances FIRST — typeof(GSharpDiagnosticAnalyzer)'s assembly
            // and everything loaded beside it in the host's own context. The
            // analyzer's base type must be identity-equal to the driver's or
            // discovery reports "no analyzer types"; scanning Default first
            // left a hole whenever the host itself runs outside the default
            // context (in-proc hosts, test harnesses, future embeddings).
            var hostAssembly = typeof(GSharpDiagnosticAnalyzer).Assembly;
            if (string.Equals(hostAssembly.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase))
            {
                return hostAssembly;
            }

            var hostContext = GetLoadContext(hostAssembly);
            if (hostContext != null && hostContext != this)
            {
                foreach (var loaded in hostContext.Assemblies)
                {
                    if (string.Equals(loaded.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase))
                    {
                        return loaded;
                    }
                }
            }

            if (hostContext != Default)
            {
                foreach (var loaded in Default.Assemblies)
                {
                    if (string.Equals(loaded.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase))
                    {
                        return loaded;
                    }
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
