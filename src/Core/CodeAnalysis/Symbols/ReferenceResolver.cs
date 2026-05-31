// <copyright file="ReferenceResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // a struct should not follow a class — ReferenceInfo is paired with ReferenceResolver by design

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Resolves imported types by name across a configurable set of referenced
/// assemblies.
/// </summary>
/// <remarks>
/// This is the seam that <c>import</c> statements use to find CLR types, and
/// the source of well-known primitive types (<c>System.Object</c>,
/// <c>System.String</c>) consumed by the emitter when materialising type
/// references.
/// <para>
/// When the resolver is constructed with explicit reference paths
/// (<see cref="WithReferences"/>), those paths are loaded into a
/// <see cref="MetadataLoadContext"/>. The <see cref="Type"/> instances
/// returned by <see cref="TryResolveType"/> then carry the target framework's
/// assembly identities (e.g. <c>System.Console, Version=8.0.0.0</c> when
/// the reference paths point at the net8.0 reference pack). Without this
/// indirection, the emitter would write type references bound to the gsc
/// host's runtime version, which fails to load on lower target frameworks.
/// </para>
/// <para>
/// <see cref="Default"/> falls back to the gsc host's loaded assemblies and
/// is intended for in-process interpreter scenarios and the existing test
/// suite where cross-targeting is not relevant.
/// </para>
/// </remarks>
public sealed class ReferenceResolver
{
    private static readonly string[] WellKnownBclAssemblyNames =
    {
        "System.Runtime",
        "System.Console",
        "System.Private.CoreLib",
        "mscorlib",
    };

    private readonly ImmutableArray<Assembly> assemblies;
    private readonly MetadataLoadContext metadataContext;

    private ReferenceResolver(ImmutableArray<Assembly> assemblies, MetadataLoadContext metadataContext)
    {
        this.assemblies = assemblies;
        this.metadataContext = metadataContext;
    }

    /// <summary>
    /// Gets the assemblies this resolver searches, in priority order.
    /// </summary>
    public ImmutableArray<Assembly> Assemblies => assemblies;

    /// <summary>
    /// Gets a resolver that searches the runtime's currently loaded
    /// assemblies plus the well-known BCL assemblies.
    /// </summary>
    /// <returns>A default resolver.</returns>
    public static ReferenceResolver Default()
    {
        return new ReferenceResolver(BuildHostAssemblies(), metadataContext: null);
    }

    /// <summary>
    /// Gets a resolver that searches only the assemblies referenced by file
    /// path. The supplied paths are loaded into an isolated
    /// <see cref="MetadataLoadContext"/> so callers see types whose
    /// <see cref="Type.Assembly"/> reflects the target framework rather than
    /// the gsc host's runtime.
    /// </summary>
    /// <param name="referencePaths">Paths to additional assemblies to load.</param>
    /// <returns>A resolver including the supplied references.</returns>
    public static ReferenceResolver WithReferences(IEnumerable<string> referencePaths)
    {
        if (referencePaths is null)
        {
            return Default();
        }

        var paths = referencePaths
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Where(File.Exists)
            .ToArray();

        if (paths.Length == 0)
        {
            return Default();
        }

        // Augment the resolver with the gsc host's trusted platform assemblies
        // as a *fallback*. User-supplied paths take precedence because the
        // PathAssemblyResolver iterates in order, so any BCL assembly the user
        // brings (e.g. from a target framework ref pack) wins over the host
        // copy. The host fallback only kicks in for dependencies the user did
        // not enumerate (typical when a user DLL pulls in extra BCL pieces).
        var resolverPaths = new List<string>(paths);
        var hostPaths = GetHostTrustedPlatformAssemblies();
        var pathSet = new HashSet<string>(paths.Select(p => Path.GetFileName(p)), StringComparer.OrdinalIgnoreCase);
        foreach (var host in hostPaths)
        {
            if (pathSet.Add(Path.GetFileName(host)))
            {
                resolverPaths.Add(host);
            }
        }

        var resolver = new PathAssemblyResolver(resolverPaths);
        var mlc = new MetadataLoadContext(resolver, coreAssemblyName: ChooseCoreAssemblyName(resolverPaths.ToArray()));

        var builder = ImmutableArray.CreateBuilder<Assembly>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths)
        {
            try
            {
                var asm = mlc.LoadFromAssemblyPath(path);
                if (asm != null && seen.Add(asm.GetName().FullName))
                {
                    builder.Add(asm);
                }
            }
            catch (FileNotFoundException)
            {
            }
            catch (BadImageFormatException)
            {
            }
        }

        return new ReferenceResolver(builder.ToImmutable(), mlc);
    }

    /// <summary>
    /// Returns per-reference metadata needed to emit a
    /// <c>CompilationMetadataReferences</c> <c>CustomDebugInformation</c> blob
    /// per the Portable PDB spec. Each entry corresponds to one assembly in
    /// <see cref="Assemblies"/> that can be read from disk; references with no
    /// file on disk (in-memory, dynamic) are silently skipped.
    /// </summary>
    /// <returns>
    /// An immutable array of <see cref="ReferenceInfo"/> values, one per
    /// resolvable file-backed reference.
    /// </returns>
    public ImmutableArray<ReferenceInfo> GetReferenceInfos()
    {
        var builder = ImmutableArray.CreateBuilder<ReferenceInfo>();
        foreach (var asm in this.assemblies)
        {
            var location = asm.Location;
            if (string.IsNullOrEmpty(location) || !File.Exists(location))
            {
                continue;
            }

            try
            {
                var fileSize = (uint)new FileInfo(location).Length;
                uint timeStamp = 0;
                var mvid = Guid.Empty;

                using (var fs = new FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var peReader = new PEReader(fs))
                {
                    timeStamp = (uint)peReader.PEHeaders.CoffHeader.TimeDateStamp;
                    var mdReader = peReader.GetMetadataReader();
                    var module = mdReader.GetModuleDefinition();
                    mvid = mdReader.GetGuid(module.Mvid);
                }

                // Flags per Portable PDB spec § CompilationMetadataReferences:
                //   bit 0 = EmbedInteropTypes (COM interop embed, false for normal refs)
                //   bit 1 = MetadataImageKind.Assembly (true for .dll assemblies)
                const byte flags = 0x02;

                builder.Add(new ReferenceInfo(
                    fileName: Path.GetFileName(location),
                    aliases: string.Empty,
                    flags: flags,
                    timeStamp: timeStamp,
                    fileSize: fileSize,
                    mvid: mvid));
            }
            catch (Exception)
            {
                // Skip references that cannot be read (locked, corrupt, etc.).
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Tries to resolve a fully-qualified type name across the referenced
    /// assemblies.
    /// </summary>
    /// <param name="fullName">The fully-qualified type name (e.g. <c>System.Console</c>).</param>
    /// <param name="type">The resolved <see cref="Type"/>, if found.</param>
    /// <returns><c>true</c> if a matching type was found; otherwise <c>false</c>.</returns>
    public bool TryResolveType(string fullName, out Type type)
    {
        type = null;
        if (string.IsNullOrEmpty(fullName))
        {
            return false;
        }

        foreach (var asm in assemblies)
        {
            Type candidate;
            try
            {
                candidate = asm.GetType(fullName, throwOnError: false, ignoreCase: false);
            }
            catch (FileNotFoundException)
            {
                continue;
            }
            catch (BadImageFormatException)
            {
                continue;
            }

            if (candidate != null)
            {
                type = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Projects a CLR <see cref="Type"/> that may originate from the gsc host
    /// runtime onto the equivalent <see cref="Type"/> from this resolver's
    /// reference set (its <see cref="MetadataLoadContext"/> when one is in
    /// play). This is required before calling
    /// <see cref="Type.MakeGenericType(Type[])"/> on an open generic obtained
    /// from <see cref="TryResolveType"/>: <c>MakeGenericType</c> demands that
    /// every type argument was loaded by the SAME context as the generic
    /// definition, otherwise it throws
    /// <see cref="ArgumentException"/> ("was not loaded by the
    /// MetadataLoadContext that loaded the generic type or method").
    /// </summary>
    /// <remarks>
    /// For the <see cref="Default"/> resolver (no
    /// <see cref="MetadataLoadContext"/>) the host type is already the right
    /// identity and is returned unchanged. Arrays, byref types, pointer types
    /// and constructed generics are projected element-by-element so nested
    /// types (e.g. <c>List[int]</c>) are mapped too. Open generic type/method
    /// parameters are passed through, as they are only meaningful relative to
    /// their already-projected declaring definition. When a leaf type cannot be
    /// resolved by name from the references, an
    /// <see cref="InvalidOperationException"/> is thrown so the cross-context
    /// mismatch surfaces here rather than deep inside a later reflection call.
    /// </remarks>
    /// <param name="hostType">The CLR type to project; may be <c>null</c>.</param>
    /// <returns>The projected type, or <c>null</c> when <paramref name="hostType"/> is <c>null</c>.</returns>
    /// <exception cref="InvalidOperationException">
    /// Thrown when a non-null leaf type cannot be projected into the reference
    /// set's <see cref="MetadataLoadContext"/> (it is not resolvable by name and
    /// is not a recognised array/byref/pointer/generic shape).
    /// </exception>
    public Type MapClrTypeToReferences(Type hostType)
    {
        if (hostType == null)
        {
            return null;
        }

        // The Default resolver searches host-runtime assemblies, so host types
        // already share identity with anything TryResolveType returns. No
        // projection is needed (and attempting one would be wasted work).
        if (metadataContext == null)
        {
            return hostType;
        }

        if (hostType.IsArray)
        {
            var mappedElement = MapClrTypeToReferences(hostType.GetElementType());
            var rank = hostType.GetArrayRank();
            return rank == 1 ? mappedElement.MakeArrayType() : mappedElement.MakeArrayType(rank);
        }

        // Byref (T&) and pointer (T*) types have no resolvable FullName, so they
        // must be projected element-wise and re-wrapped. Handle them before the
        // name-resolution fallback. The element itself may be an array, generic,
        // or another shape, so recurse to keep the whole chain in the same
        // context.
        if (hostType.IsByRef)
        {
            return MapClrTypeToReferences(hostType.GetElementType()).MakeByRefType();
        }

        if (hostType.IsPointer)
        {
            return MapClrTypeToReferences(hostType.GetElementType()).MakePointerType();
        }

        if (hostType.IsGenericType && !hostType.IsGenericTypeDefinition)
        {
            var mappedDefinition = MapClrTypeToReferences(hostType.GetGenericTypeDefinition());
            var mappedArgs = hostType.GetGenericArguments().Select(MapClrTypeToReferences).ToArray();
            return mappedDefinition.MakeGenericType(mappedArgs);
        }

        // Open generic type/method parameters (e.g. the T of List`1 or of a
        // generic method) carry no FullName and cannot be name-resolved. They
        // are meaningful only relative to the generic definition that declares
        // them, which is itself projected through this method, so the parameter
        // is already in the correct context. Pass it through unchanged.
        if (hostType.IsGenericParameter)
        {
            return hostType;
        }

        var fullName = hostType.FullName;
        if (!string.IsNullOrEmpty(fullName) && TryResolveType(fullName, out var mapped) && mapped != null)
        {
            return mapped;
        }

        // No projection was possible. Returning the host type here would yield a
        // cross-context identity mismatch that fails much later inside
        // MakeGenericType/MakeGenericMethod with an opaque ArgumentException
        // ("was not loaded by the MetadataLoadContext that loaded the generic
        // type or method"). Surface the failure at the projection site instead,
        // where the offending type is known.
        throw new InvalidOperationException(
            $"Unable to project CLR type '{hostType}' (assembly '{hostType.Assembly?.GetName().Name}') " +
            "into the reference set's MetadataLoadContext. The type could not be resolved by name from the " +
            "supplied references and is not a recognised array/byref/pointer/generic shape. Returning the host " +
            "type would cause a cross-context identity mismatch in later reflection calls.");
    }

    /// <summary>
    /// Resolves a well-known core CLR type (e.g. <c>System.Object</c>,
    /// <c>System.String</c>) by full name. Used by the emitter so type
    /// references for primitives originate from the target framework's
    /// reference assemblies rather than the gsc host's loaded runtime.
    /// </summary>
    /// <param name="fullName">The fully-qualified core type name.</param>
    /// <returns>The resolved <see cref="Type"/>.</returns>
    /// <exception cref="InvalidOperationException">Thrown when no referenced assembly defines the requested type.</exception>
    public Type GetCoreType(string fullName)
    {
        if (TryResolveType(fullName, out var t))
        {
            return t;
        }

        throw new InvalidOperationException(
            $"Core type '{fullName}' could not be resolved from the supplied references.");
    }

    private static ImmutableArray<Assembly> BuildHostAssemblies()
    {
        var builder = ImmutableArray.CreateBuilder<Assembly>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.IsDynamic)
            {
                continue;
            }

            var name = asm.GetName().FullName;
            if (seen.Add(name))
            {
                builder.Add(asm);
            }
        }

        foreach (var name in WellKnownBclAssemblyNames)
        {
            try
            {
                var asm = Assembly.Load(new AssemblyName(name));
                if (seen.Add(asm.GetName().FullName))
                {
                    builder.Add(asm);
                }
            }
            catch (FileNotFoundException)
            {
            }
            catch (FileLoadException)
            {
            }
            catch (BadImageFormatException)
            {
            }
        }

        return builder.ToImmutable();
    }

    private static string ChooseCoreAssemblyName(string[] paths)
    {
        // MetadataLoadContext needs a "core assembly" — the one declaring the
        // primitive types (Object, String, etc.). For modern .NET reference
        // packs this is System.Runtime.dll; older targets ship mscorlib.dll
        // as the canonical home. Pick whichever we can see in the supplied
        // reference set, falling back to letting MLC autodetect.
        var fileNames = paths.Select(Path.GetFileNameWithoutExtension)
                             .ToArray();

        if (fileNames.Any(n => string.Equals(n, "System.Runtime", StringComparison.OrdinalIgnoreCase)))
        {
            return "System.Runtime";
        }

        if (fileNames.Any(n => string.Equals(n, "mscorlib", StringComparison.OrdinalIgnoreCase)))
        {
            return "mscorlib";
        }

        return null;
    }

    private static IEnumerable<string> GetHostTrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Array.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator)
                  .Where(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p));
    }
}

/// <summary>
/// Per-reference metadata record used to emit a
/// <c>CompilationMetadataReferences</c> <c>CustomDebugInformation</c> blob
/// per the Portable PDB spec § "CompilationMetadataReferences".
/// </summary>
public readonly struct ReferenceInfo
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ReferenceInfo"/> struct.
    /// </summary>
    /// <param name="fileName">File name (no directory) of the reference PE, e.g. <c>System.Console.dll</c>.</param>
    /// <param name="aliases">Comma-separated extern alias list; empty string when there are no aliases.</param>
    /// <param name="flags">Flags byte: bit 0 = EmbedInteropTypes; bit 1 = MetadataImageKind.Assembly.</param>
    /// <param name="timeStamp">PE COFF header <c>TimeDateStamp</c> of the reference file.</param>
    /// <param name="fileSize">Length of the reference file in bytes.</param>
    /// <param name="mvid">Module version id read from the reference's PE metadata.</param>
    public ReferenceInfo(string fileName, string aliases, byte flags, uint timeStamp, uint fileSize, Guid mvid)
    {
        FileName = fileName;
        Aliases = aliases;
        Flags = flags;
        TimeStamp = timeStamp;
        FileSize = fileSize;
        Mvid = mvid;
    }

    /// <summary>
    /// Gets the file name (no directory) of the reference PE, e.g.
    /// <c>System.Console.dll</c>.
    /// </summary>
    public string FileName { get; }

    /// <summary>
    /// Gets the comma-separated extern alias list. Empty string for the
    /// common case of no aliases.
    /// </summary>
    public string Aliases { get; }

    /// <summary>
    /// Gets the flags byte.
    /// Bit 0 = EmbedInteropTypes; bit 1 = MetadataImageKind.Assembly.
    /// </summary>
    public byte Flags { get; }

    /// <summary>
    /// Gets the PE COFF header <c>TimeDateStamp</c> of the reference file.
    /// </summary>
    public uint TimeStamp { get; }

    /// <summary>
    /// Gets the length of the reference file in bytes.
    /// </summary>
    public uint FileSize { get; }

    /// <summary>
    /// Gets the module version id (MVID) read from the reference's PE metadata.
    /// </summary>
    public Guid Mvid { get; }
}
