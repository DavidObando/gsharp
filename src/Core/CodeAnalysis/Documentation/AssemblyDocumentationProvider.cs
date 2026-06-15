// <copyright file="AssemblyDocumentationProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security;
using System.Threading;
using System.Xml;
using System.Xml.Linq;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// Loads and indexes the companion <c>.xml</c> documentation file for a single resolved
/// assembly, exposing a DocID → <see cref="DocumentationComment"/> lookup (ADR-0057 §6).
/// </summary>
/// <remarks>
/// Instances are obtained through <see cref="ForAssembly"/>, which caches one provider per
/// <see cref="Assembly"/> so a given assembly's (potentially large) xml is discovered and
/// parsed at most once per process. Parsing is <em>lazy</em> — the file is read on the
/// first lookup, not at construction — and <em>XXE-safe</em> (DTD processing prohibited,
/// no external resolver, bounded size). Any failure (missing file, malformed xml, oversize)
/// degrades silently to "docs unavailable": ingestion never fails a hover or a build.
///
/// <para>Thread safety: all lookup state is immutable after construction. The per-assembly
/// <see cref="ConditionalWeakTable{TKey,TValue}"/> cache is documented thread-safe for
/// concurrent <see cref="ConditionalWeakTable{TKey,TValue}.GetValue"/> callers, and the
/// <see cref="Lazy{T}"/> wrapping the index uses <see cref="LazyThreadSafetyMode.ExecutionAndPublication"/>
/// so concurrent first-time lookups produce exactly one <see cref="Dictionary{TKey,TValue}"/>
/// instance. That dictionary is read-only after publication: <see cref="LoadIndex"/> writes
/// to a local <c>result</c> before publishing it through the <c>Lazy</c>, and
/// <see cref="TryGetDocumentation"/> only performs <see cref="Dictionary{TKey,TValue}.TryGetValue"/>
/// reads — which are safe for concurrent readers when no writer is present. The provider is
/// therefore safe to share across concurrent hover requests.</para>
/// </remarks>
public sealed class AssemblyDocumentationProvider
{
    /// <summary>The largest documentation xml we will read; larger files are treated as unavailable.</summary>
    private const long MaxXmlBytes = 96L * 1024 * 1024;

    private static readonly ConditionalWeakTable<Assembly, AssemblyDocumentationProvider> Cache = new();

    private readonly Lazy<Dictionary<string, DocumentationComment>> index;

    private AssemblyDocumentationProvider(string xmlPath)
    {
        this.index = new Lazy<Dictionary<string, DocumentationComment>>(
            () => LoadIndex(xmlPath),
            LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>
    /// Gets the cached documentation provider for an assembly, discovering its companion
    /// xml on first request. Returns <see langword="null"/> when the assembly has no
    /// readable location (in-memory/dynamic assemblies).
    /// </summary>
    /// <param name="assembly">The assembly whose documentation to provide.</param>
    /// <returns>The provider, or <see langword="null"/> when none can be associated.</returns>
    public static AssemblyDocumentationProvider ForAssembly(Assembly assembly)
    {
        if (assembly is null)
        {
            return null;
        }

        return Cache.GetValue(assembly, Create);
    }

    /// <summary>
    /// Resolves the ingested documentation for a reflected type from its assembly's
    /// companion xml, or <see langword="null"/> when unavailable.
    /// </summary>
    /// <param name="type">The reflected type.</param>
    /// <returns>The documentation, or <see langword="null"/>.</returns>
    public static DocumentationComment Resolve(Type type)
    {
        if (type is null)
        {
            return null;
        }

        var provider = ForAssembly(SafeAssembly(type));
        if (provider == null)
        {
            return null;
        }

        var id = DocumentationIdProvider.GetDocumentationId(type);
        return provider.TryGetDocumentation(id, out var documentation) ? documentation : null;
    }

    /// <summary>
    /// Resolves the ingested documentation for a reflected method from its assembly's
    /// companion xml, or <see langword="null"/> when unavailable. A constructed generic
    /// method is normalized to its generic definition so its DocID matches the xml.
    /// </summary>
    /// <param name="method">The reflected method.</param>
    /// <returns>The documentation, or <see langword="null"/>.</returns>
    public static DocumentationComment Resolve(MethodInfo method)
    {
        if (method is null)
        {
            return null;
        }

        if (method.IsGenericMethod && !method.IsGenericMethodDefinition)
        {
            method = method.GetGenericMethodDefinition();
        }

        var provider = ForAssembly(SafeAssembly(method.DeclaringType));
        if (provider == null)
        {
            return null;
        }

        var id = DocumentationIdProvider.GetDocumentationId(method);
        return provider.TryGetDocumentation(id, out var documentation) ? documentation : null;
    }

    /// <summary>
    /// Resolves the ingested documentation for a reflected property from its assembly's
    /// companion xml, or <see langword="null"/> when unavailable.
    /// </summary>
    /// <param name="property">The reflected property.</param>
    /// <returns>The documentation, or <see langword="null"/>.</returns>
    public static DocumentationComment Resolve(PropertyInfo property)
    {
        if (property is null)
        {
            return null;
        }

        var provider = ForAssembly(SafeAssembly(property.DeclaringType));
        if (provider == null)
        {
            return null;
        }

        var id = DocumentationIdProvider.GetDocumentationId(property);
        return provider.TryGetDocumentation(id, out var documentation) ? documentation : null;
    }

    /// <summary>
    /// Resolves the ingested documentation for a reflected field from its assembly's
    /// companion xml, or <see langword="null"/> when unavailable.
    /// </summary>
    /// <param name="field">The reflected field.</param>
    /// <returns>The documentation, or <see langword="null"/>.</returns>
    public static DocumentationComment Resolve(FieldInfo field)
    {
        if (field is null)
        {
            return null;
        }

        var provider = ForAssembly(SafeAssembly(field.DeclaringType));
        if (provider == null)
        {
            return null;
        }

        var id = DocumentationIdProvider.GetDocumentationId(field);
        return provider.TryGetDocumentation(id, out var documentation) ? documentation : null;
    }

    /// <summary>
    /// Resolves the ingested documentation for a reflected event from its assembly's
    /// companion xml, or <see langword="null"/> when unavailable.
    /// </summary>
    /// <param name="event">The reflected event.</param>
    /// <returns>The documentation, or <see langword="null"/>.</returns>
    public static DocumentationComment Resolve(EventInfo @event)
    {
        if (@event is null)
        {
            return null;
        }

        var provider = ForAssembly(SafeAssembly(@event.DeclaringType));
        if (provider == null)
        {
            return null;
        }

        var id = DocumentationIdProvider.GetDocumentationId(@event);
        return provider.TryGetDocumentation(id, out var documentation) ? documentation : null;
    }

    /// <summary>
    /// Looks up the documentation for a member by its DocID.
    /// </summary>
    /// <param name="documentationId">The member's DocID (e.g. <c>T:System.Console</c>).</param>
    /// <param name="documentation">The parsed documentation, when found.</param>
    /// <returns><see langword="true"/> when documentation was found; otherwise <see langword="false"/>.</returns>
    public bool TryGetDocumentation(string documentationId, out DocumentationComment documentation)
    {
        documentation = null;
        if (string.IsNullOrEmpty(documentationId))
        {
            return false;
        }

        var map = this.index.Value;
        return map.TryGetValue(documentationId, out documentation);
    }

    private static AssemblyDocumentationProvider Create(Assembly assembly)
    {
        return new AssemblyDocumentationProvider(DiscoverXmlPath(assembly));
    }

    private static Assembly SafeAssembly(Type type)
    {
        try
        {
            return type?.Assembly;
        }
        catch (Exception)
        {
            return null;
        }
    }

    // Discovery (ADR-0057 §6): the companion xml sits next to the resolved assembly for
    // both reference packs and NuGet lib/ref assets, so the sibling .xml is the primary
    // location. When the assembly is loaded from the shared framework (runtime) directory
    // at design time (e.g. the language server uses runtime-loaded types for hover), the
    // sibling xml won't exist — fall back to probing the ref pack where .NET ships the
    // XML documentation alongside the reference assemblies.
    private static string DiscoverXmlPath(Assembly assembly)
    {
        if (!GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.TryGetAssemblyPath(assembly, out var location))
        {
            return null;
        }

        var sibling = Path.ChangeExtension(location, ".xml");
        if (File.Exists(sibling))
        {
            return sibling;
        }

        return ProbeRefPackXml(location);
    }

    // Probes the .NET ref pack for the companion xml when the assembly is in the shared
    // framework directory. Layout:
    //   {dotnet_root}/shared/Microsoft.NETCore.App/{version}/{assembly}.dll  (runtime)
    //   {dotnet_root}/packs/Microsoft.NETCore.App.Ref/{version}/ref/{tfm}/{assembly}.xml
    // Special case: System.Private.CoreLib hosts many BCL types but its docs ship in
    // System.Runtime.xml in the ref pack.
    private static string ProbeRefPackXml(string assemblyLocation)
    {
        try
        {
            var assemblyDir = Path.GetDirectoryName(assemblyLocation);
            if (string.IsNullOrEmpty(assemblyDir))
            {
                return null;
            }

            // Check if we're in a shared framework directory:
            // .../shared/Microsoft.NETCore.App/{version}/
            var versionDir = new DirectoryInfo(assemblyDir);
            var frameworkDir = versionDir.Parent;
            var sharedDir = frameworkDir?.Parent;
            if (sharedDir == null
                || !string.Equals(sharedDir.Name, "shared", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var dotnetRoot = sharedDir.Parent?.FullName;
            if (string.IsNullOrEmpty(dotnetRoot))
            {
                return null;
            }

            var assemblyFileName = Path.GetFileNameWithoutExtension(assemblyLocation);

            // System.Private.CoreLib hosts most BCL types, but documentation ships in
            // System.Runtime.xml. Probe both names for CoreLib.
            var candidateNames = string.Equals(assemblyFileName, "System.Private.CoreLib", StringComparison.OrdinalIgnoreCase)
                ? new[] { "System.Private.CoreLib", "System.Runtime" }
                : new[] { assemblyFileName };

            var packsDir = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
            if (!Directory.Exists(packsDir))
            {
                return null;
            }

            // Find the best matching ref pack version (highest available)
            var packVersions = Directory.GetDirectories(packsDir)
                .Select(d => Path.GetFileName(d))
                .OrderByDescending(v => v, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            foreach (var packVersion in packVersions)
            {
                var refDir = Path.Combine(packsDir, packVersion, "ref");
                if (!Directory.Exists(refDir))
                {
                    continue;
                }

                // Look through all TFM subdirectories (e.g. net8.0, net9.0, net10.0)
                foreach (var tfmDir in Directory.GetDirectories(refDir))
                {
                    foreach (var candidate in candidateNames)
                    {
                        var xmlPath = Path.Combine(tfmDir, candidate + ".xml");
                        if (File.Exists(xmlPath))
                        {
                            return xmlPath;
                        }
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException)
        {
            // File system probing failed — degrade gracefully.
        }

        return null;
    }

    private static Dictionary<string, DocumentationComment> LoadIndex(string path)
    {
        var result = new Dictionary<string, DocumentationComment>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(path))
        {
            return result;
        }

        try
        {
            if (new FileInfo(path).Length > MaxXmlBytes)
            {
                return result;
            }

            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                IgnoreComments = true,
                IgnoreProcessingInstructions = true,
                MaxCharactersFromEntities = 0,
            };

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var reader = XmlReader.Create(stream, settings);
            var doc = XDocument.Load(reader);

            var membersElement = doc.Root?.Element("members");
            if (membersElement == null)
            {
                return result;
            }

            foreach (var member in membersElement.Elements("member"))
            {
                var name = (string)member.Attribute("name");
                if (string.IsNullOrEmpty(name) || result.ContainsKey(name))
                {
                    continue;
                }

                result[name] = XmlDocumentationParser.ParseMember(member);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or XmlException or InvalidOperationException)
        {
            // Malformed/unreadable xml ⇒ docs unavailable for this assembly, never a failure.
            return new Dictionary<string, DocumentationComment>(StringComparer.Ordinal);
        }

        return result;
    }
}
