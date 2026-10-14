// <copyright file="AssemblyDocumentationProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Security
import System.Threading
import System.Xml
import System.Xml.Linq
import GSharp.Core.CodeAnalysis.Symbols

/// Loads and indexes the companion `.xml` documentation file for a single resolved
/// assembly, exposing a DocID → (cref:DocumentationComment) lookup (ADR-0057 §6).
/// @remarks Instances are obtained through (cref:ForAssembly), which caches one provider per
/// (cref:Assembly) so a given assembly's (potentially large) xml is discovered and
/// parsed at most once per process. Parsing is <em>lazy</em> — the file is read on the
/// first lookup, not at construction — and <em>XXE-safe</em> (DTD processing prohibited,
/// no external resolver, bounded size). Any failure (missing file, malformed xml, oversize)
/// degrades silently to "docs unavailable": ingestion never fails a hover or a build.
///
/// Thread safety: all lookup state is immutable after construction. The per-assembly
/// (cref:ConditionalWeakTable{TKey,TValue}) cache is documented thread-safe for
/// concurrent (cref:ConditionalWeakTable{TKey,TValue}.GetValue) callers, and the
/// (cref:Lazy{T}) wrapping the index uses (cref:LazyThreadSafetyMode.ExecutionAndPublication)
/// so concurrent first-time lookups produce exactly one (cref:Dictionary{TKey,TValue})
/// instance. That dictionary is read-only after publication: (cref:LoadIndex) writes
/// to a local `result` before publishing it through the `Lazy`, and
/// (cref:TryGetDocumentation) only performs (cref:Dictionary{TKey,TValue}.TryGetValue)
/// reads — which are safe for concurrent readers when no writer is present. The provider is
/// therefore safe to share across concurrent hover requests.
class AssemblyDocumentationProvider {
    private let index Lazy[Dictionary[string, DocumentationComment]]

    private init(xmlPath string?) {
        this.index = Lazy[Dictionary[string, DocumentationComment]](
            () -> LoadIndex(xmlPath),
            LazyThreadSafetyMode.ExecutionAndPublication
        )
    }

    /// Looks up the documentation for a member by its DocID.
    /// @param documentationId The member's DocID (e.g. `T:System.Console`).
    /// @param documentation The parsed documentation, when found.
    /// @returns `true` when documentation was found; otherwise `false`.
    func TryGetDocumentation(documentationId string, @NotNullWhen(true) out documentation DocumentationComment?) bool {
        documentation = nil
        if string.IsNullOrEmpty(documentationId) {
            return false
        }
        let map_ = this.index.Value
        return map_.TryGetValue(documentationId, out documentation)
    }

    shared {
        /// The largest documentation xml we will read; larger files are treated as unavailable.
        private const MaxXmlBytes int64 = 96L * int64(1024) * int64(1024)

        private let Cache ConditionalWeakTable[Assembly, AssemblyDocumentationProvider?] = ConditionalWeakTable[
            Assembly,
            AssemblyDocumentationProvider?
        ]()

        /// Gets the cached documentation provider for an assembly, discovering its companion
        /// xml on first request. Returns `null` when the assembly has no
        /// readable location (in-memory/dynamic assemblies).
        /// @param assembly The assembly whose documentation to provide.
        /// @returns The provider, or `null` when none can be associated.
        func ForAssembly(assembly Assembly?) AssemblyDocumentationProvider? {
            if assembly == nil {
                return nil
            }
            return Cache.GetValue(assembly, Create)
        }

        /// Resolves the ingested documentation for a reflected type from its assembly's
        /// companion xml, or `null` when unavailable.
        /// @param type The reflected type.
        /// @returns The documentation, or `null`.
        func Resolve(type Type?) DocumentationComment? {
            if type == nil {
                return nil
            }
            let provider AssemblyDocumentationProvider? = ForAssembly(SafeAssembly(type))
            if provider == nil {
                return nil
            }
            let id string? = DocumentationIdProvider.GetDocumentationId(type)
            return if id != nil && provider.TryGetDocumentation(id, out var documentation) {
                documentation
            } else {
                default(DocumentationComment?)
            }
        }

        /// Resolves the ingested documentation for a reflected method from its assembly's
        /// companion xml, or `null` when unavailable. A constructed generic
        /// method is normalized to its generic definition so its DocID matches the xml.
        /// @param method The reflected method.
        /// @returns The documentation, or `null`.
        func Resolve(method MethodInfo?) DocumentationComment? {
            var method = method
            if method == nil {
                return nil
            }
            if method.IsGenericMethod && !method.IsGenericMethodDefinition {
                method = method.GetGenericMethodDefinition()
            }
            let provider AssemblyDocumentationProvider? = ForAssembly(SafeAssembly(method!!.DeclaringType))
            if provider == nil {
                return nil
            }
            let id string? = DocumentationIdProvider.GetDocumentationId(method!!)
            return if id != nil && provider.TryGetDocumentation(id, out var documentation) {
                documentation
            } else {
                default(DocumentationComment?)
            }
        }

        /// Resolves the ingested documentation for a reflected property from its assembly's
        /// companion xml, or `null` when unavailable.
        /// @param property The reflected property.
        /// @returns The documentation, or `null`.
        func Resolve(property PropertyInfo?) DocumentationComment? {
            if property == nil {
                return nil
            }
            let provider AssemblyDocumentationProvider? = ForAssembly(SafeAssembly(property.DeclaringType))
            if provider == nil {
                return nil
            }
            let id string? = DocumentationIdProvider.GetDocumentationId(property)
            return if id != nil && provider.TryGetDocumentation(id, out var documentation) {
                documentation
            } else {
                default(DocumentationComment?)
            }
        }

        /// Resolves the ingested documentation for a reflected field from its assembly's
        /// companion xml, or `null` when unavailable.
        /// @param field The reflected field.
        /// @returns The documentation, or `null`.
        func Resolve(field FieldInfo?) DocumentationComment? {
            if field == nil {
                return nil
            }
            let provider AssemblyDocumentationProvider? = ForAssembly(SafeAssembly(field.DeclaringType))
            if provider == nil {
                return nil
            }
            let id string? = DocumentationIdProvider.GetDocumentationId(field)
            return if id != nil && provider.TryGetDocumentation(id, out var documentation) {
                documentation
            } else {
                default(DocumentationComment?)
            }
        }

        /// Resolves the ingested documentation for a reflected event from its assembly's
        /// companion xml, or `null` when unavailable.
        /// @param event The reflected event.
        /// @returns The documentation, or `null`.
        func Resolve(event EventInfo?) DocumentationComment? {
            if event == nil {
                return nil
            }
            let provider AssemblyDocumentationProvider? = ForAssembly(SafeAssembly(event.DeclaringType))
            if provider == nil {
                return nil
            }
            let id string? = DocumentationIdProvider.GetDocumentationId(event)
            return if id != nil && provider.TryGetDocumentation(id, out var documentation) {
                documentation
            } else {
                default(DocumentationComment?)
            }
        }

        private func Create(assembly Assembly) AssemblyDocumentationProvider? {
            return AssemblyDocumentationProvider(DiscoverXmlPath(assembly))
        }

        private func SafeAssembly(type Type?) Assembly? {
            try {
                return type?.Assembly
            } catch (Exception) {
                return nil
            }
        }

        // Discovery (ADR-0057 §6): the companion xml sits next to the resolved assembly for
        // both reference packs and NuGet lib/ref assets, so the sibling .xml is the primary
        // location. When the assembly is loaded from the shared framework (runtime) directory
        // at design time (e.g. the language server uses runtime-loaded types for hover), the
        // sibling xml won't exist — fall back to probing the ref pack where .NET ships the
        // XML documentation alongside the reference assemblies.
        private func DiscoverXmlPath(assembly Assembly) string? {
            if !ReferenceResolver.TryGetAssemblyPath(assembly, out var location) {
                return nil
            }
            let sibling = Path.ChangeExtension(location, ".xml")
            if File.Exists(sibling) {
                return sibling
            }
            return ProbeRefPackXml(location)
        }

        // Probes the .NET ref pack for the companion xml when the assembly is in the shared
        // framework directory. Layout:
        //   {dotnet_root}/shared/Microsoft.NETCore.App/{version}/{assembly}.dll  (runtime)
        //   {dotnet_root}/packs/Microsoft.NETCore.App.Ref/{version}/ref/{tfm}/{assembly}.xml
        // Special case: System.Private.CoreLib hosts many BCL types but its docs ship in
        // System.Runtime.xml in the ref pack.
        private func ProbeRefPackXml(assemblyLocation string) string? {
            try {
                let assemblyDir = Path.GetDirectoryName(assemblyLocation)
                if string.IsNullOrEmpty(assemblyDir) {
                    return nil
                }
                // Check if we're in a shared framework directory:
                // .../shared/Microsoft.NETCore.App/{version}/
                let versionDir = DirectoryInfo(assemblyDir)
                let frameworkDir = versionDir.Parent
                let sharedDir DirectoryInfo? = frameworkDir?.Parent
                if sharedDir == nil || !string.Equals(sharedDir.Name, "shared", StringComparison.OrdinalIgnoreCase) {
                    return nil
                }
                let dotnetRoot = sharedDir.Parent?.FullName
                if string.IsNullOrEmpty(dotnetRoot) {
                    return nil
                }
                let assemblyFileName = Path.GetFileNameWithoutExtension(assemblyLocation)
                // System.Private.CoreLib hosts most BCL types, but documentation ships in
                // System.Runtime.xml. Probe both names for CoreLib.
                let candidateNames = if string.Equals(
                    assemblyFileName,
                    "System.Private.CoreLib",
                    StringComparison.OrdinalIgnoreCase
                ) {
                    []string{"System.Private.CoreLib", "System.Runtime"}
                } else {
                    []string{assemblyFileName}
                }
                let packsDir = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
                if !Directory.Exists(packsDir) {
                    return nil
                }
                // Find the best matching ref pack version (highest available)
                let packDirectories = Directory.GetDirectories(packsDir)
                let packVersions = [packDirectories.Length]string
                for var i = 0; i < packDirectories.Length; i++ {
                    packVersions[i] = Path.GetFileName(packDirectories[i])
                }
                Array.Sort(packVersions, StringComparer.OrdinalIgnoreCase)
                Array.Reverse(packVersions)
                for packVersion in packVersions {
                    let refDir = Path.Combine(packsDir, packVersion, "ref")
                    if !Directory.Exists(refDir) {
                        continue
                    }
                    // Look through all TFM subdirectories (e.g. net8.0, net9.0, net10.0)
                    for tfmDir in Directory.GetDirectories(refDir) {
                        for candidate in candidateNames {
                            let xmlPath = Path.Combine(tfmDir, candidate + ".xml")
                            if File.Exists(xmlPath) {
                                return xmlPath
                            }
                        }
                    }
                }
            } catch (ex Exception) when ex is IOException ||
                ex is UnauthorizedAccessException ||
                ex is SecurityException {
                // File system probing failed — degrade gracefully.

            }
            return nil
        }

        private func LoadIndex(path string?) Dictionary[string, DocumentationComment] {
            let result = Dictionary[string, DocumentationComment](StringComparer.Ordinal)
            if string.IsNullOrEmpty(path) {
                return result
            }
            try {
                if FileInfo(path).Length > MaxXmlBytes {
                    return result
                }
                let settings = XmlReaderSettings{
                    DtdProcessing: DtdProcessing.Prohibit,
                    XmlResolver: nil,
                    IgnoreComments: true,
                    IgnoreProcessingInstructions: true,
                    MaxCharactersFromEntities: 0
                }
                using let stream = FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)
                using let reader = XmlReader.Create(stream, settings)
                let doc = XDocument.Load(reader)
                let membersElement XElement? = doc.Root?.Element(XName?("members")!!)
                if membersElement == nil {
                    return result
                }
                for member in membersElement.Elements("member") {
                    let name = string?(member.Attribute(XName?("name")!!))
                    if string.IsNullOrEmpty(name) || result.ContainsKey(name!!) {
                        continue
                    }
                    result[name!!] = XmlDocumentationParser.ParseMember(member)
                }
            } catch (ex Exception) when ex is IOException ||
                ex is UnauthorizedAccessException ||
                ex is XmlException ||
                ex is InvalidOperationException {
                // Malformed/unreadable xml ⇒ docs unavailable for this assembly, never a failure.
                return Dictionary[string, DocumentationComment](StringComparer.Ordinal)
            }
            return result
        }
    }
}
