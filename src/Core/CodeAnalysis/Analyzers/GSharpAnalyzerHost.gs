// <copyright file="GSharpAnalyzerHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Text
import System.Text

/// Loads analyzer assemblies (gsc's `/gsanalyzer:`, the language
/// server's project analyzer set) and runs them through
/// (cref:GSharpAnalyzerDriver) (ADR-0169). Each assembly loads in its
/// own (cref:AssemblyLoadContext) whose resolution unifies
/// `GSharp.Core` (and anything already loaded in the default context) to
/// the host's copies, so analyzer-declared types are identity-compatible with
/// the driver's.
shared class GSharpAnalyzerHost {
    /// A collectible load context that resolves any assembly already loaded
    /// in the default context (GSharp.Core, the BCL) to the host's copy and
    /// probes next to the analyzer assembly for its private dependencies.
    private class AnalyzerLoadContext : AssemblyLoadContext {
        private let analyzerDirectory string

        init(analyzerPath string) : base("gsanalyzer:${Path.GetFileName(analyzerPath)}", true) {
            analyzerDirectory = Path.GetDirectoryName(analyzerPath) ?? string.Empty
        }

        protected override func Load(assemblyName AssemblyName) Assembly? {
            // Issue #3617: resolve HOST-OWNED assemblies to the host's own
            // instances FIRST — typeof(GSharpDiagnosticAnalyzer)'s assembly
            // and everything loaded beside it in the host's own context. The
            // analyzer's base type must be identity-equal to the driver's or
            // discovery reports "no analyzer types"; scanning Default first
            // left a hole whenever the host itself runs outside the default
            // context (in-proc hosts, test harnesses, future embeddings).
            let hostAssembly = typeof(GSharpDiagnosticAnalyzer).Assembly
            if string.Equals(hostAssembly.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase) {
                return hostAssembly
            }
            let hostContext AssemblyLoadContext? = AssemblyLoadContext.GetLoadContext(hostAssembly)
            if hostContext != nil && hostContext != this {
                for loaded in hostContext.Assemblies {
                    if string.Equals(loaded.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase) {
                        return loaded
                    }
                }
            }
            if hostContext != AssemblyLoadContext.Default {
                for loaded in AssemblyLoadContext.Default.Assemblies {
                    if string.Equals(loaded.GetName().Name, assemblyName.Name, StringComparison.OrdinalIgnoreCase) {
                        return loaded
                    }
                }
            }
            let candidate = Path.Combine(analyzerDirectory, assemblyName.Name + ".dll")
            if File.Exists(candidate) {
                return LoadFromAssemblyPath(candidate)
            }
            // Fall through to the default context (framework assemblies).
            return nil
        }
    }

    /// Loads every assembly in [`analyzerPaths`](paramref) and discovers
    /// its analyzers. Load failures surface as GS9301; Core version
    /// mismatches as GS9303.
    /// @param analyzerPaths Analyzer assembly paths.
    /// @param hostDiagnostics GS9301/GS9303 diagnostics produced while loading.
    /// @returns The discovered analyzers.
    func Load(analyzerPaths IReadOnlyList[string], out hostDiagnostics ImmutableArray[Diagnostic]) ImmutableArray[
        GSharpDiagnosticAnalyzer
    ] {
        let diagnostics = ImmutableArray.CreateBuilder[Diagnostic]()
        let analyzers = ImmutableArray.CreateBuilder[GSharpDiagnosticAnalyzer]()
        for path in analyzerPaths {
            LoadAnalyzers(path, analyzers, diagnostics)
        }
        hostDiagnostics = diagnostics.ToImmutable()
        return analyzers.ToImmutable()
    }

    /// Loads the analyzers in [`analyzerPaths`](paramref) and runs them
    /// over [`compilation`](paramref).
    /// @param compilation The bound compilation to analyze.
    /// @param analyzerPaths Analyzer assembly paths.
    /// @param options Optional driver options.
    /// @param cancellationToken Cancels the driver run.
    /// @returns Host and analyzer diagnostics.
    func Run(
        compilation Compilation,
        analyzerPaths IReadOnlyList[string],
        options AnalyzerOptions? = nil,
        cancellationToken CancellationToken = default(CancellationToken)
    ) ImmutableArray[Diagnostic] {
        let analyzers = Load(analyzerPaths, out var hostDiagnostics)
        let produced = GSharpAnalyzerDriver.Run(compilation, analyzers, options, cancellationToken)
        return hostDiagnostics.AddRange(produced)
    }

    private func LoadAnalyzers(
        path string,
        analyzers ImmutableArray[GSharpDiagnosticAnalyzer].Builder,
        hostDiagnostics ImmutableArray[Diagnostic].Builder
    ) {
        try {
            let fullPath = Path.GetFullPath(path)
            let loadContext = AnalyzerLoadContext(fullPath)
            let assembly = loadContext.LoadFromAssemblyPath(fullPath)
            CheckCoreVersion(assembly, fullPath, hostDiagnostics)
            var found = 0
            let exportedTypes = assembly.GetExportedTypes()
            for type in exportedTypes {
                if type.IsAbstract || !typeof(GSharpDiagnosticAnalyzer).IsAssignableFrom(type) ||
                    type.GetCustomAttribute[GSharpDiagnosticAnalyzerAttribute]() == nil {
                    continue
                }
                // `!`: CreateInstance returns null only for Nullable<T>, and
                // the discovery filter admits only non-abstract reference
                // types deriving from GSharpDiagnosticAnalyzer.
                analyzers.Add(cast[GSharpDiagnosticAnalyzer](Activator.CreateInstance(type)!!))
                found++
            }
            if found == 0 {
                // Issue #3617: a zero-discovery result has three very
                // different causes — wrong bytes at the path (e.g. a stale
                // Roslyn-era assembly), a type-identity split (the analyzer's
                // GSharpDiagnosticAnalyzer base bound to a DIFFERENT
                // GSharp.Core instance than the host's), or a genuinely empty
                // assembly. Emit enough forensic detail that one CI log
                // distinguishes them.
                let zeroDiscovery = "the assembly contains no [GSharpDiagnosticAnalyzer] types deriving from GSharpDiagnosticAnalyzer. " +
                    DescribeZeroDiscovery(assembly, fullPath, exportedTypes)
                hostDiagnostics.Add(
                    Diagnostic.Create(
                        DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                        default(TextLocation),
                        path,
                        zeroDiscovery
                    )
                )
            }
        } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
            hostDiagnostics.Add(
                Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerAssemblyLoadFailure,
                    default(TextLocation),
                    path,
                    DescribeLoadException(ex)
                )
            )
        }
    }

    /// Issue #3617: builds the forensic tail of the zero-discovery GS9301 —
    /// the exported-type census, per-candidate filter verdicts with the
    /// identity/location/MVID of each candidate's resolved analyzer base
    /// assembly versus the host's own, and the analyzer file's size and MVID.
    private func DescribeZeroDiscovery(assembly Assembly, fullPath string, exportedTypes[]Type) string {
        let sb = StringBuilder()
        try {
            let hostBase = typeof(GSharpDiagnosticAnalyzer)
            sb.Append("Forensics: exportedTypes=").Append(exportedTypes.Length)
            let fileInfo = FileInfo(fullPath)
            sb
                .Append("; file(size=")
                .Append(
                if fileInfo.Exists {
                    fileInfo.Length
                } else {
                    int64(-1)
                }
            )
                .Append(", mvid=")
                .Append(assembly.ManifestModule.ModuleVersionId)
                .Append(')')
            let referencedCore = assembly.GetReferencedAssemblies().FirstOrDefault(
                (name AssemblyName) -> string.Equals(
                    name.Name,
                    hostBase.Assembly.GetName().Name,
                    StringComparison.OrdinalIgnoreCase
                )
            )
            sb
                .Append("; referencedCore=")
                .Append(referencedCore?.Version?.ToString() ?? "<none>")
                .Append("; hostCore(version=")
                .Append(hostBase.Assembly.GetName().Version)
                .Append(", location=")
                .Append(hostBase.Assembly.Location)
                .Append(", mvid=")
                .Append(hostBase.Assembly.ManifestModule.ModuleVersionId)
                .Append(')')
            // Candidates that carry the attribute BY NAME but failed a filter:
            // the smoking gun for identity splits is a base assembly whose
            // location/MVID differs from the host's.
            for type in exportedTypes {
                let namedAttribute = type.GetCustomAttributesData().Any(
                    (attribute CustomAttributeData) -> attribute
                        .AttributeType
                        .Name == "GSharpDiagnosticAnalyzerAttribute"
                )
                let analyzerBase Type? = FindAnalyzerBase(type, hostBase.FullName)
                if !namedAttribute && analyzerBase == nil {
                    continue
                }
                sb
                    .Append("; candidate ")
                    .Append(type.FullName)
                    .Append("(abstract=")
                    .Append(type.IsAbstract)
                    .Append(", namedAttr=")
                    .Append(namedAttribute)
                    .Append(", assignable=")
                    .Append(hostBase.IsAssignableFrom(type))
                if analyzerBase != nil {
                    sb
                        .Append(", baseAssembly=")
                        .Append(analyzerBase.Assembly.GetName().Version)
                        .Append('@')
                        .Append(analyzerBase.Assembly.Location)
                        .Append(", baseMvid=")
                        .Append(analyzerBase.Assembly.ManifestModule.ModuleVersionId)
                        .Append(", baseIsHost=")
                        .Append(object.ReferenceEquals(analyzerBase.Assembly, hostBase.Assembly))
                }
                sb.Append(')')
            }
        } catch (forensics Exception) when !(forensics is OutOfMemoryException) &&
            !(forensics is StackOverflowException) {
            sb.Append("; forensics-failed: ").Append(forensics.GetType().Name).Append(": ").Append(forensics.Message)
        }
        return sb.ToString()
    }

    private func FindAnalyzerBase(type Type, analyzerBaseFullName string?) Type? {
        for var current Type? = type.BaseType; current != nil; current = current!!.BaseType {
            if current.FullName == analyzerBaseFullName {
                return current
            }
        }
        return nil
    }

    /// Issue #3617: a load exception's Message alone hid every actionable
    /// detail (two CI runs produced no data). Surface the exception chain and
    /// any per-type loader failures.
    private func DescribeLoadException(ex Exception) string {
        let sb = StringBuilder()
        sb.Append(ex.GetType().Name).Append(": ").Append(ex.Message)
        if ex is ReflectionTypeLoadException typeLoad {
            for loaderException in typeLoad.LoaderExceptions.Take(5) {
                if loaderException != nil {
                    sb
                        .Append(" | loader: ")
                        .Append(loaderException.GetType().Name)
                        .Append(": ")
                        .Append(loaderException.Message)
                }
            }
        }
        for var inner Exception? = ex.InnerException; inner != nil; inner = inner!!.InnerException {
            sb.Append(" | inner: ").Append(inner.GetType().Name).Append(": ").Append(inner.Message)
        }
        return sb.ToString()
    }

    private func CheckCoreVersion(assembly Assembly, path string, hostDiagnostics ImmutableArray[Diagnostic].Builder) {
        let hostCore = typeof(GSharpDiagnosticAnalyzer).Assembly.GetName()
        let referencedCore = assembly.GetReferencedAssemblies().FirstOrDefault(
            (name AssemblyName) -> string.Equals(name.Name, hostCore.Name, StringComparison.OrdinalIgnoreCase)
        )
        if referencedCore?.Version is {} referencedVersion &&
            hostCore.Version is {} hostVersion &&
            referencedVersion != hostVersion {
            hostDiagnostics.Add(
                Diagnostic.Create(
                    DiagnosticDescriptors.AnalyzerCoreVersionMismatch,
                    default(TextLocation),
                    path,
                    referencedVersion,
                    hostVersion
                )
            )
        }
    }
}
