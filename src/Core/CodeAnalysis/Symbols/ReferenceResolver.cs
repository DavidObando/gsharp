// <copyright file="ReferenceResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // a struct should not follow a class — ReferenceInfo is paired with ReferenceResolver by design

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

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
public sealed class ReferenceResolver : IDisposable
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
    private readonly ImmutableArray<string> missingTransitiveReferences;

    // Process-wide registry of original on-disk paths for assemblies loaded
    // via LoadFromByteArray (whose Assembly.Location is empty). Populated by
    // FallbackMetadataAssemblyResolver and consulted by TryGetAssemblyPath /
    // AssemblyDocumentationProvider so doc-XML discovery and cross-assembly
    // navigation keep working after #853 (which switched ref-pack loading
    // from PathAssemblyResolver to LoadFromByteArray to avoid file locking).
    private static readonly ConditionalWeakTable<Assembly, string> AssemblyOriginalPaths = new();

    // Memoizes TryResolveType results for the lifetime of this resolver.
    //
    // Each lookup without a cache iterates every assembly in `assemblies` (216
    // entries on the Oahu project) and calls Assembly.GetType. For a hit in
    // CoreLib that is ~15µs per call; for a miss (or a hit in a late-ordered
    // assembly like xunit.dll) it is ~100µs per call. Binding a real LSP
    // compilation issues thousands of TryResolveType calls — both during
    // GlobalScope (every `import` and every member access on an imported type)
    // and BoundProgram (every name lookup during body binding). Without this
    // cache the cumulative cost dwarfs the actual semantic work; with it,
    // every unique name pays the probe cost at most once per resolver lifetime.
    //
    // The cache is invalidated naturally because a new ReferenceResolver is
    // built whenever the project's .rsp changes (see ProjectState.GetCompilation).
    // A sentinel singleton stands in for "we probed and found nothing" so that
    // negative lookups are O(1) on the second call (the bulk of the binder's
    // probes are speculative "is this name a type?" queries that come back
    // empty).
    private static readonly Type MissTypeSentinel = typeof(NotFoundSentinel);
    private readonly ConcurrentDictionary<string, Type> resolveCache = new(StringComparer.Ordinal);

    // Issue #854: a lazily-built, full-name -> Type index over every assembly in
    // `assemblies`. The previous TryResolveType implementation scanned all
    // references on every cache miss (Assembly.GetType per assembly), which on a
    // project with a large reference closure — e.g. the Oahu test project pulls
    // in the Microsoft.AspNetCore.App framework reference for 352 assemblies —
    // costs ~1.9ms per *miss*. The binder issues tens of thousands of distinct
    // speculative probes (one candidate per declared import for every accessor
    // expression), so the cumulative scan cost dominated build time (~80s of a
    // ~83s compile). Building this index once (top-level + nested type
    // definitions plus exported type forwarders) is ~150ms for that reference
    // set and turns every subsequent resolution into an O(1) dictionary lookup.
    //
    // First-writer-wins mirrors the old scan, which returned the first assembly
    // in `assemblies` order that declared the requested name. The index is keyed
    // by Type.FullName, which uses '+' for nested types and the `arity backtick
    // suffix for open generics — exactly the spellings Assembly.GetType accepts
    // and the binder already constructs (e.g. "Ns.Type`1").
    private readonly Lazy<Dictionary<string, Type>> typeNameIndex;

    // ADR-0107 (cold-start cache): an optional, externally-supplied
    // full-name -> declaring-assembly-index map that stands in for the eager
    // `typeNameIndex` below. When set (via TryUseMetadataIndex), TryResolveType
    // consults this map and materialises the actual CLR Type lazily by name —
    // skipping the ~120ms Assembly.GetTypes()/GetForwardedTypes() enumeration of
    // the whole reference closure that BuildTypeNameIndex performs. The map's
    // keyset is, by construction, exactly the set of names that enumeration
    // would have produced (it is built from a ReferenceMetadataIndex that the
    // language server either persisted from a prior cold build or rebuilds via
    // ExportMetadataIndex), so warm resolution is a superset of cold resolution.
    // Null in the default/opt-out path, where the eager `typeNameIndex` is used
    // and behaviour is byte-for-byte identical to before this ADR.
    private Dictionary<string, int> warmNameIndex;

    private ReferenceResolver(ImmutableArray<Assembly> assemblies, MetadataLoadContext metadataContext)
        : this(assemblies, metadataContext, ImmutableArray<string>.Empty)
    {
    }

    private ReferenceResolver(ImmutableArray<Assembly> assemblies, MetadataLoadContext metadataContext, ImmutableArray<string> missingTransitiveReferences)
    {
        this.assemblies = assemblies;
        this.metadataContext = metadataContext;
        this.missingTransitiveReferences = missingTransitiveReferences;
        this.typeNameIndex = new Lazy<Dictionary<string, Type>>(
            this.BuildTypeNameIndex,
            System.Threading.LazyThreadSafetyMode.ExecutionAndPublication);
    }

    private sealed class NotFoundSentinel
    {
    }

    /// <summary>
    /// Releases the underlying <see cref="MetadataLoadContext"/> (if any),
    /// closing all file handles it holds to referenced assemblies. Also
    /// evicts stale entries from the process-wide type-symbol caches so
    /// that the disposed context's <see cref="Type"/> objects can be
    /// garbage-collected.
    /// </summary>
    /// <remarks>
    /// Callers that create a resolver via <see cref="WithReferences"/> must
    /// dispose it when the compilation session is complete. Failing to do so
    /// leaks one file handle per loaded assembly per resolver instance.
    /// </remarks>
    public void Dispose()
    {
        if (metadataContext is null)
        {
            return;
        }

        metadataContext.Dispose();

        // The static ImportedTypeSymbol cache may hold Type instances that
        // originated from the now-disposed MetadataLoadContext. Those entries
        // are unreachable from future compilations and pin the disposed
        // context's managed object graph. Clearing the cache allows them to
        // be collected. This is safe because each compilation rebuilds the
        // cache organically; the only cost is a cold cache on the next
        // compilation that reuses the same process.
        ImportedTypeSymbol.ClearCache();

        // FunctionTypeSymbol eagerly closes a host-runtime Func/Action over
        // MetadataLoadContext-projected type arguments, so its process-wide
        // cache can likewise pin (and later resurface) types from this disposed
        // context across compilations in the same process (issue #908). Clear
        // it for the same reason.
        FunctionTypeSymbol.ClearCache();
    }

    /// <summary>
    /// Gets the assemblies this resolver searches, in priority order.
    /// </summary>
    public ImmutableArray<Assembly> Assemblies => assemblies;

    /// <summary>
    /// Gets the simple names of assemblies that are referenced (transitively)
    /// by the supplied reference set but could not be resolved from either that
    /// set or the gsc host runtime. An empty array means the supplied references
    /// form a complete transitive closure. A non-empty array indicates the
    /// project is under-referenced: touching a member whose signature lives in
    /// one of these assemblies would otherwise throw deep in member
    /// enumeration, so the resolver degrades gracefully (the member is skipped)
    /// and callers may surface a diagnostic naming the missing assemblies
    /// (issue #340).
    /// </summary>
    public ImmutableArray<string> MissingTransitiveReferences => missingTransitiveReferences;

    /// <summary>
    /// Recovers the on-disk path that <paramref name="assembly"/> was
    /// originally loaded from. Falls back to the per-process registry that
    /// <see cref="ReferenceResolver"/> populates whenever an assembly is read
    /// into a <see cref="MetadataLoadContext"/> from in-memory bytes (so
    /// MSBuild's <c>CopyRefAssembly</c> task is not blocked — see #853 / #858),
    /// which is the case where <see cref="Assembly.Location"/> returns the
    /// empty string. Used by
    /// <c>AssemblyDocumentationProvider.DiscoverXmlPath</c> to locate the
    /// companion XML doc file, and by
    /// <c>CrossAssemblyDefinitionResolver</c> to locate the originating
    /// sibling project / portable PDB for cross-assembly Go-to-Definition.
    /// </summary>
    /// <param name="assembly">An assembly returned by a resolver.</param>
    /// <param name="path">The original on-disk path on success.</param>
    /// <returns><see langword="true"/> when a non-empty path was recovered.</returns>
    public static bool TryGetAssemblyPath(Assembly assembly, out string path)
    {
        path = null;
        if (assembly == null)
        {
            return false;
        }

        try
        {
            var location = assembly.Location;
            if (!string.IsNullOrEmpty(location))
            {
                path = location;
                return true;
            }
        }
        catch (NotSupportedException)
        {
            // Dynamic / in-memory assemblies throw on Location access; fall through.
        }

        if (AssemblyOriginalPaths.TryGetValue(assembly, out var registered) && !string.IsNullOrEmpty(registered))
        {
            path = registered;
            return true;
        }

        return false;
    }

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
        var userPathFileNames = new HashSet<string>(paths.Select(p => Path.GetFileName(p)), StringComparer.OrdinalIgnoreCase);
        var fallbackHostPaths = new List<string>();
        var seenResolverFile = new HashSet<string>(userPathFileNames, StringComparer.OrdinalIgnoreCase);
        foreach (var host in hostPaths)
        {
            if (seenResolverFile.Add(Path.GetFileName(host)))
            {
                resolverPaths.Add(host);
                fallbackHostPaths.Add(host);
            }
        }

        var resolver = new FallbackMetadataAssemblyResolver(resolverPaths);
        var mlc = new MetadataLoadContext(resolver, coreAssemblyName: ChooseCoreAssemblyName(resolverPaths.ToArray()));

        var builder = ImmutableArray.CreateBuilder<Assembly>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths)
        {
            try
            {
                var asm = resolver.LoadFromPath(mlc, path);
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

        // ADR-0084 follow-on (issue #724). The user-supplied references
        // frequently sit on top of the BCL — Gsharp.Extensions.dll, for
        // example, surfaces helpers that take System.String / IEnumerable[T]
        // arguments. The host fallback paths are already in the MLC's
        // resolver closure; load the BCL/runtime subset of them into the
        // user-visible `loaded` set as well so that
        // ReferenceResolver.TryResolveType("System.String") finds the MLC
        // copy and not the host's copy (the latter would cross-context
        // mismatch later in member binding). The filter intentionally
        // excludes non-runtime host assemblies (test runners, user libraries
        // the host pulled in) to keep `loaded` to the user-meaningful
        // surface. The augmentation is *only* applied when the user
        // references include at least one non-BCL/runtime path: callers that
        // pass only raw BCL (e.g. integration tests pinning a single
        // System.Private.CoreLib) get exactly the surface they asked for.
        var userHasNonBcl = paths.Any(p => !IsBclOrRuntimeAssemblyPath(p));
        if (userHasNonBcl)
        {
            foreach (var host in fallbackHostPaths)
            {
                if (!IsBclOrRuntimeAssemblyPath(host))
                {
                    continue;
                }

                try
                {
                    var asm = resolver.LoadFromPath(mlc, host);
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
        }

        var loaded = builder.ToImmutable();
        var missing = ComputeMissingTransitiveReferences(loaded, mlc, resolver);

        return new ReferenceResolver(loaded, mlc, missing);
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

        if (resolveCache.TryGetValue(fullName, out var cached))
        {
            if (ReferenceEquals(cached, MissTypeSentinel))
            {
                return false;
            }

            type = cached;
            return true;
        }

        // ADR-0107: warm path. When a metadata index has been adopted, resolve
        // by consulting the persisted name -> assembly map and materialising the
        // Type lazily, rather than building (and scanning) the eager
        // typeNameIndex. The keyset equals the cold path's, so a name absent here
        // is a genuine miss; a present name is materialised with an
        // order-preserving scan fallback so first-writer-wins is honoured even if
        // the recorded declaring assembly cannot satisfy GetType.
        if (warmNameIndex != null)
        {
            if (warmNameIndex.TryGetValue(fullName, out var assemblyIndex)
                && TryMaterializeWarmType(fullName, assemblyIndex, out var warm))
            {
                resolveCache.TryAdd(fullName, warm);
                type = warm;
                return true;
            }

            resolveCache.TryAdd(fullName, MissTypeSentinel);
            return false;
        }

        if (typeNameIndex.Value.TryGetValue(fullName, out var indexed))
        {
            resolveCache.TryAdd(fullName, indexed);
            type = indexed;
            return true;
        }

        resolveCache.TryAdd(fullName, MissTypeSentinel);
        return false;
    }

    /// <summary>
    /// Issue #526: resolves a nested CLR type by name on a containing
    /// <paramref name="containingType"/>. Used by the binder to walk a
    /// dotted-qualifier type clause (e.g. <c>Outer.Inner.DeepInner</c>) one
    /// segment at a time after the outermost type has been resolved.
    /// Honors the resolver's <see cref="MetadataLoadContext"/> by going
    /// through <see cref="Type.GetNestedType(string, BindingFlags)"/>, which
    /// stays inside the same load context as <paramref name="containingType"/>.
    /// </summary>
    /// <param name="containingType">The previously resolved outer/containing type.</param>
    /// <param name="nestedName">The simple name of the nested type to look up.</param>
    /// <param name="nestedType">The resolved nested type on success.</param>
    /// <returns><see langword="true"/> when a public or non-public nested type with the requested name exists; otherwise <see langword="false"/>.</returns>
    public bool TryResolveNestedType(Type containingType, string nestedName, out Type nestedType)
    {
        nestedType = null;
        if (containingType == null || string.IsNullOrEmpty(nestedName))
        {
            return false;
        }

        try
        {
            nestedType = containingType.GetNestedType(
                nestedName,
                BindingFlags.Public | BindingFlags.NonPublic);
        }
        catch (FileNotFoundException)
        {
            return false;
        }
        catch (BadImageFormatException)
        {
            return false;
        }

        return nestedType != null;
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

    /// <summary>
    /// ADR-0107: captures this resolver's full-type-name surface — every
    /// assembly's identity plus the defined and forwarded type full-names it
    /// contributes, in search order — into a serialisable
    /// <see cref="ReferenceMetadataIndex"/>. The language server persists this to
    /// its cold-start cache so a later process can skip the
    /// <c>Assembly.GetTypes()</c>/<c>GetForwardedTypes()</c> enumeration. This
    /// performs the same metadata walk as the eager type-name index, so calling
    /// it costs roughly one index build.
    /// </summary>
    /// <returns>A snapshot of the resolver's type-name surface.</returns>
    public ReferenceMetadataIndex ExportMetadataIndex()
    {
        var identities = ImmutableArray.CreateBuilder<string>(assemblies.Length);
        var namesByAssembly = ImmutableArray.CreateBuilder<ImmutableArray<string>>(assemblies.Length);

        foreach (var asm in assemblies)
        {
            identities.Add(asm.GetName().FullName);
            var names = ImmutableArray.CreateBuilder<string>();
            foreach (var t in EnumerateDefinedAndForwardedTypes(asm))
            {
                if (t.FullName is { } fullName)
                {
                    names.Add(fullName);
                }
            }

            namesByAssembly.Add(names.ToImmutable());
        }

        return ReferenceMetadataIndex.Create(identities.MoveToImmutable(), namesByAssembly.MoveToImmutable());
    }

    /// <summary>
    /// ADR-0107: adopts a previously-built <see cref="ReferenceMetadataIndex"/>
    /// as this resolver's warm type-name index, so <see cref="TryResolveType"/>
    /// skips the eager metadata enumeration. The index is accepted only when its
    /// recorded assembly identities match this resolver's freshly-loaded
    /// assemblies <em>exactly</em> (same count, same
    /// <see cref="System.Reflection.AssemblyName.FullName"/> in the same order);
    /// any mismatch returns <see langword="false"/> and leaves the resolver on
    /// the cold (eager) path. This identity check is defence-in-depth on top of
    /// the cache's reference-set fingerprint: if the references somehow changed
    /// without the fingerprint noticing, the payload is still rejected here.
    /// Must be called before the first resolution so the warm index is in place
    /// for binding.
    /// </summary>
    /// <param name="index">The candidate metadata index.</param>
    /// <returns><see langword="true"/> when the index was adopted; otherwise <see langword="false"/>.</returns>
    public bool TryUseMetadataIndex(ReferenceMetadataIndex index)
    {
        if (index is null || index.AssemblyIdentities.Length != assemblies.Length)
        {
            return false;
        }

        for (var i = 0; i < assemblies.Length; i++)
        {
            if (!string.Equals(index.AssemblyIdentities[i], assemblies[i].GetName().FullName, StringComparison.Ordinal))
            {
                return false;
            }
        }

        warmNameIndex = index.ToNameIndex();
        return true;
    }

    // Issue #854: enumerate every assembly's defined types (top-level + nested)
    // and exported type forwarders once, building the full-name -> Type index
    // that backs TryResolveType. Mirrors the precedence of the previous per-miss
    // scan: assemblies are visited in `assemblies` order and the first declarer
    // of a given full name wins (later duplicates are ignored).
    private static void AddToTypeNameIndex(Dictionary<string, Type> index, Type t)
    {
        if (t?.FullName is { } name && !index.ContainsKey(name))
        {
            index[name] = t;
        }
    }

    // ADR-0107: materialise the CLR Type for a name the warm index claims is
    // resolvable. Prefer the recorded declaring assembly; if that assembly cannot
    // satisfy GetType (e.g. a stale/edge forwarder), fall back to an in-order scan
    // of every assembly so resolution still finds the first declarer — exactly the
    // precedence the eager index encodes. Returns false only if no assembly can
    // produce the type, in which case the caller records a (conservative) miss.
    private static Type SafeGetType(Assembly assembly, string fullName)
    {
        try
        {
            return assembly.GetType(fullName);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (BadImageFormatException)
        {
            return null;
        }
        catch (TypeLoadException)
        {
            return null;
        }
    }

    private bool TryMaterializeWarmType(string fullName, int assemblyIndex, out Type type)
    {
        type = null;
        if (assemblyIndex >= 0 && assemblyIndex < assemblies.Length)
        {
            type = SafeGetType(assemblies[assemblyIndex], fullName);
            if (type != null)
            {
                return true;
            }
        }

        foreach (var asm in assemblies)
        {
            type = SafeGetType(asm, fullName);
            if (type != null)
            {
                return true;
            }
        }

        return false;
    }

    private Dictionary<string, Type> BuildTypeNameIndex()
    {
        var index = new Dictionary<string, Type>(StringComparer.Ordinal);

        foreach (var asm in assemblies)
        {
            foreach (var t in EnumerateDefinedAndForwardedTypes(asm))
            {
                AddToTypeNameIndex(index, t);
            }
        }

        return index;
    }

    // Issue #854 / ADR-0107: enumerate one assembly's defined types (top-level +
    // nested) followed by its exported type forwarders, tolerating the partial
    // results that ReflectionTypeLoadException / GetForwardedTypes surface for a
    // closure with an unresolvable member. This is the single source of truth for
    // "which type names does this assembly contribute, and in what order"; both
    // the eager BuildTypeNameIndex and the cache-export ExportMetadataIndex
    // consume it so the warm and cold name sets (and their first-writer-wins
    // precedence) are guaranteed to match.
    private static IEnumerable<Type> EnumerateDefinedAndForwardedTypes(Assembly asm)
    {
        Type[] definedTypes;
        try
        {
            definedTypes = asm.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            definedTypes = ex.Types;
        }
        catch (FileNotFoundException)
        {
            definedTypes = Array.Empty<Type>();
        }
        catch (BadImageFormatException)
        {
            definedTypes = Array.Empty<Type>();
        }

        foreach (var t in definedTypes)
        {
            if (t != null)
            {
                yield return t;
            }
        }

        Type[] forwardedTypes;
        try
        {
            forwardedTypes = asm.GetForwardedTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            forwardedTypes = ex.Types;
        }
        catch (Exception)
        {
            forwardedTypes = Array.Empty<Type>();
        }

        foreach (var t in forwardedTypes)
        {
            if (t != null)
            {
                yield return t;
            }
        }
    }

    private static void RegisterAssemblyOriginalPath(Assembly assembly, string path)
    {
        if (assembly == null || string.IsNullOrEmpty(path))
        {
            return;
        }

        AssemblyOriginalPaths.AddOrUpdate(assembly, path);
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

    /// <summary>
    /// Returns <see langword="true"/> when the host assembly path looks like a
    /// .NET BCL / runtime assembly the user is likely to expect transitively
    /// when they pass a single user reference (e.g. <c>System.Runtime</c>,
    /// <c>System.Collections</c>, <c>Microsoft.CSharp</c>, <c>mscorlib</c>,
    /// <c>netstandard</c>). Non-runtime host assemblies (test runners, user
    /// libraries already loaded into the host's AppDomain) are excluded so
    /// the user-visible reference set in <see cref="WithReferences(IEnumerable{string})"/>
    /// stays scoped to the surface the user actually opted into.
    /// </summary>
    /// <param name="hostPath">Absolute path to a host TPA entry.</param>
    /// <returns><see langword="true"/> when the path's file-name simple name
    /// matches a known BCL / runtime prefix.</returns>
    private static bool IsBclOrRuntimeAssemblyPath(string hostPath)
    {
        if (string.IsNullOrEmpty(hostPath))
        {
            return false;
        }

        var simple = Path.GetFileNameWithoutExtension(hostPath);
        if (string.IsNullOrEmpty(simple))
        {
            return false;
        }

        return simple.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
            || simple.Equals("System", StringComparison.OrdinalIgnoreCase)
            || simple.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)
            || simple.Equals("mscorlib", StringComparison.OrdinalIgnoreCase)
            || simple.Equals("netstandard", StringComparison.OrdinalIgnoreCase)
            || simple.Equals("WindowsBase", StringComparison.OrdinalIgnoreCase);
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

    /// <summary>
    /// Eagerly verifies that the supplied reference set forms a complete
    /// transitive closure. For every primary reference, each assembly it names
    /// (one hop) is probed against the load context's resolver; any name that
    /// neither the supplied set nor the gsc host runtime can satisfy is
    /// reported as missing. This converts a latent
    /// <see cref="FileNotFoundException"/>/<see cref="TypeLoadException"/> that
    /// would otherwise surface deep in member enumeration into an actionable,
    /// up-front signal (issue #340).
    /// </summary>
    private static ImmutableArray<string> ComputeMissingTransitiveReferences(
        ImmutableArray<Assembly> loaded,
        MetadataLoadContext mlc,
        FallbackMetadataAssemblyResolver resolver)
    {
        var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var asm in loaded)
        {
            AssemblyName[] referenced;
            try
            {
                referenced = asm.GetReferencedAssemblies();
            }
            catch (Exception)
            {
                // A malformed reference table must not abort closure analysis.
                continue;
            }

            foreach (var refName in referenced)
            {
                if (string.IsNullOrEmpty(refName?.Name))
                {
                    continue;
                }

                try
                {
                    // LoadFromAssemblyName forces the resolver to locate the
                    // dependency. Success means it is in the closure; a load
                    // failure means it is genuinely missing.
                    var dependency = mlc.LoadFromAssemblyName(refName);
                    if (dependency == null)
                    {
                        missing.Add(refName.Name);
                    }
                }
                catch (Exception ex) when (
                    ex is FileNotFoundException
                        or FileLoadException
                        or BadImageFormatException
                        or TypeLoadException)
                {
                    missing.Add(refName.Name);
                }
            }
        }

        // Fold in any names the resolver itself failed to satisfy while loading
        // the primaries (e.g. a primary's core-assembly dependency).
        foreach (var name in resolver.UnresolvedSimpleNames)
        {
            missing.Add(name);
        }

        return missing.Count == 0 ? ImmutableArray<string>.Empty : missing.ToImmutableArray();
    }

    /// <summary>
    /// A <see cref="MetadataAssemblyResolver"/> that resolves from a supplied
    /// set of paths (via an inner <see cref="PathAssemblyResolver"/>) and, when
    /// that fails, degrades gracefully: instead of allowing the
    /// <see cref="MetadataLoadContext"/> to surface an exception for an
    /// unresolved transitive dependency, it records the offending simple name
    /// and returns <see langword="null"/> so the caller can skip the affected
    /// member (issue #340). The recorded names feed the
    /// <see cref="MissingTransitiveReferences"/> diagnostic surface.
    /// </summary>
    private sealed class FallbackMetadataAssemblyResolver : MetadataAssemblyResolver
    {
        private readonly Dictionary<string, byte[]> assemblyBytes = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> assemblyPaths = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> unresolved = new(StringComparer.OrdinalIgnoreCase);
        private readonly object gate = new();

        public FallbackMetadataAssemblyResolver(IEnumerable<string> paths)
        {
            // Read each assembly into memory so no file handles are held open.
            // This prevents MSBuild CopyRefAssembly from being blocked (#853).
            foreach (var path in paths)
            {
                var fileName = Path.GetFileNameWithoutExtension(path);
                if (!assemblyBytes.ContainsKey(fileName))
                {
                    try
                    {
                        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                        var bytes = new byte[fs.Length];
                        fs.ReadExactly(bytes);
                        assemblyBytes[fileName] = bytes;
                        assemblyPaths[fileName] = path;
                    }
                    catch (Exception ex) when (
                        ex is IOException or UnauthorizedAccessException or BadImageFormatException)
                    {
                        // Skip files that can't be read.
                    }
                }
            }
        }

        public bool TryGetOriginalPath(string simpleName, out string path)
        {
            if (!string.IsNullOrEmpty(simpleName))
            {
                return assemblyPaths.TryGetValue(simpleName, out path);
            }

            path = null;
            return false;
        }

        public IEnumerable<string> UnresolvedSimpleNames
        {
            get
            {
                lock (gate)
                {
                    return unresolved.ToArray();
                }
            }
        }

        /// <summary>
        /// Loads an assembly by path into the given <see cref="MetadataLoadContext"/>
        /// using in-memory bytes (no file handle held open).
        /// </summary>
        public Assembly LoadFromPath(MetadataLoadContext context, string path)
        {
            var fileName = Path.GetFileNameWithoutExtension(path);
            Assembly asm;
            if (assemblyBytes.TryGetValue(fileName, out var bytes))
            {
                asm = context.LoadFromByteArray(bytes);
            }
            else
            {
                // Fallback: read from disk with sharing flags.
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var buffer = new byte[fs.Length];
                fs.ReadExactly(buffer);
                asm = context.LoadFromByteArray(buffer);
            }

            RegisterAssemblyOriginalPath(asm, path);
            return asm;
        }

        public override Assembly Resolve(MetadataLoadContext context, AssemblyName assemblyName)
        {
            var simpleName = assemblyName?.Name;
            if (!string.IsNullOrEmpty(simpleName) && assemblyBytes.TryGetValue(simpleName, out var bytes))
            {
                try
                {
                    var asm = context.LoadFromByteArray(bytes);
                    if (assemblyPaths.TryGetValue(simpleName, out var originalPath))
                    {
                        RegisterAssemblyOriginalPath(asm, originalPath);
                    }

                    return asm;
                }
                catch (Exception ex) when (
                    ex is FileNotFoundException
                        or FileLoadException
                        or BadImageFormatException)
                {
                    // Fall through to record-and-degrade below.
                }
            }

            if (!string.IsNullOrEmpty(simpleName))
            {
                lock (gate)
                {
                    unresolved.Add(simpleName);
                }
            }

            // Returning null lets MetadataLoadContext raise a load failure only
            // if a member actually depends on this assembly; the per-member
            // tolerance in OverloadResolution then skips that member rather than
            // aborting the whole lookup.
            return null;
        }
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
