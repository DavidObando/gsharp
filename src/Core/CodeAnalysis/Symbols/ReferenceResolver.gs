// <copyright file="ReferenceResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Runtime.Loader
import System.Security.Cryptography
import System.Threading
import SystemObject = System.Object

/// Resolves imported types by name across a configurable set of referenced
/// assemblies.
/// @remarks This is the seam that `import` statements use to find CLR types, and
/// the source of well-known primitive types (`System.Object`,
/// `System.String`) consumed by the emitter when materialising type
/// references.
///
/// When the resolver is constructed with explicit reference paths
/// ((cref:WithReferences)), those paths are loaded into a
/// (cref:MetadataLoadContext). The (cref:Type) instances
/// returned by (cref:TryResolveType(string, out System.Type)) then carry the target framework's
/// assembly identities (e.g. `System.Console, Version=8.0.0.0` when
/// the reference paths point at the net8.0 reference pack). Without this
/// indirection, the emitter would write type references bound to the gsc
/// host's runtime version, which fails to load on lower target frameworks.
///
/// (cref:Default) falls back to the gsc host's loaded assemblies and
/// is intended for in-process interpreter scenarios and the existing test
/// suite where cross-targeting is not relevant.
class ReferenceResolver : IDisposable {
    private let assemblies ImmutableArray[Assembly]
    private let metadataContext MetadataLoadContext?
    // ADR-0209 PR 1: the handle-backed reference set, built beside the MetadataLoadContext
    // when GSHARP_METADATA_MODEL is `handles` or `compare`. No binder code reads it yet.
    private var imageSet ReferenceImageSet?
    private let runtimeContext AssemblyLoadContext?
    private let missingTransitiveReferences ImmutableArray[string]
    private let hostFallbackAssemblyNames ImmutableHashSet[string]
    private let resolveCache ConcurrentDictionary[string, Type] = ConcurrentDictionary[string, Type](
        StringComparer.Ordinal
    )

    // Issue #2263 / #2269: per-compilation cache of imported data-type semantic
    // aggregates (see ImportedTypeSymbol.TryCreateSemanticAggregate). This MUST
    // be an instance field, not a process-wide static: the cached StructSymbol
    // graphs strongly reference the CLR Type objects — and therefore the
    // MetadataLoadContext / assemblies — of this resolver. Scoping the cache to
    // the resolver ties that graph's lifetime to the MLC, so it is released when
    // this resolver is disposed (ResourceLeakRegressionTests) and never pins a
    // disposed context's memory. A single resolver serves an entire compilation
    // (one consumer assembly), so keying by Type alone still yields one
    // consistent aggregate identity per type in every binding position, and
    // avoids the cross-thread cache churn a shared static cache suffered when
    // xUnit ran compilations in parallel.
    private let semanticAggregateCache ConcurrentDictionary[Type, StructSymbol] = ConcurrentDictionary[
        Type,
        StructSymbol
    ]()

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
    private let typeNameIndex Lazy[ReferenceTypeNameIndex]

    private let emittedTypeNameIndex Lazy[Dictionary[string, string]]
    private let namespaceIndex Lazy[ImmutableHashSet[string]]

    // Group metadata names once, using the warm keyset when present. Resolve
    // only the matching arities at query time so visibility and type forwarding
    // remain governed by TryResolveType without forcing the cold type index.
    private let arityInsensitiveTypeNames Lazy[Dictionary[string, ImmutableArray[string]]]

    // ADR-0107 (cold-start cache): an optional, externally-supplied
    // full-name -> declaring-assembly-index map that stands in for the names in
    // `typeNameIndex` below. When set (via TryUseMetadataIndex), TryResolveType
    // consults this map instead of reading the names from the reference images.
    // Its keyset is the set of names ExportMetadataIndex produced from the same
    // reference set, which TryUseMetadataIndex checks by assembly identity and
    // content fingerprint. Null when no index was adopted, where the names come
    // from `typeNameIndex`.
    private var warmNameIndex Dictionary[string, int32]?

    /// Gets or sets the simple name of the assembly currently being compiled.
    /// When populated, imported-member lookup may honor
    /// `InternalsVisibleTo` friendship on referenced assemblies.
    prop CurrentAssemblyName string?

    /// Returns the cached imported data-type semantic aggregate for
    /// [`type`](paramref) within this resolver's (compilation's) lifetime,
    /// building it via [`factory`](paramref) on first request. See the
    /// `semanticAggregateCache` field remarks for why this cache is
    /// resolver-scoped rather than a process-wide static (issue #2263 / #2269).
    /// @param type The imported CLR type to build an aggregate for.
    /// @param consumerAssemblyName The simple name of the assembly being compiled, passed to
    /// [`factory`](paramref) so it can honor `InternalsVisibleTo`.
    /// @param factory Builds the aggregate for a cache miss, given the type and consumer name.
    /// @returns The cached or newly built semantic aggregate.
    internal func GetOrAddSemanticAggregate(
        type Type,
        consumerAssemblyName string,
        factory(Type, string) -> StructSymbol
    ) StructSymbol -> semanticAggregateCache.GetOrAdd(type, factory, consumerAssemblyName)

    private convenience init(assemblies ImmutableArray[Assembly], metadataContext MetadataLoadContext?) {
        init(assemblies, metadataContext, ImmutableArray[string].Empty, nil, nil, nil)
    }

    private init(
        assemblies ImmutableArray[Assembly],
        metadataContext MetadataLoadContext?,
        missingTransitiveReferences ImmutableArray[string],
        runtimeContext AssemblyLoadContext? = nil,
        typeNameIndex Lazy[ReferenceTypeNameIndex]? = nil,
        hostFallbackAssemblyNames ImmutableHashSet[string]? = nil
    ) {
        this.assemblies = assemblies
        this.metadataContext = metadataContext
        this.runtimeContext = runtimeContext
        this.missingTransitiveReferences = missingTransitiveReferences
        this.hostFallbackAssemblyNames = hostFallbackAssemblyNames ?? ImmutableHashSet.Create[string](
            StringComparer.OrdinalIgnoreCase
        )
        this.typeNameIndex = typeNameIndex ?? CreateTypeNameIndex(assemblies)
        this.namespaceIndex = Lazy[ImmutableHashSet[string]](
            BuildNamespaceIndex,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        this.arityInsensitiveTypeNames = Lazy[Dictionary[string, ImmutableArray[string]]](
            BuildArityInsensitiveTypeNames,
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        this.emittedTypeNameIndex = Lazy[Dictionary[string, string]](
            () -> BuildEmittedTypeNameIndex(cast[IEnumerable[string]](this.CurrentNameIndex().Keys)),
            LazyThreadSafetyMode.ExecutionAndPublication
        )
        // Issue #4023: a `map[K, V]` whose key or value is an IMPORTED type
        // must build its backing `Dictionary<K, V>` inside THIS resolver's
        // reflection context — a host `typeof(Dictionary<,>)` closed over a
        // MetadataLoadContext argument answers an unusable
        // `TypeBuilderInstantiation` and the map loses its whole member
        // surface. `MapTypeSymbol` is a process-wide interned symbol with no
        // resolver of its own, so publish the projection here, keyed weakly by
        // each assembly this resolver can name; the map then looks it up by
        // the assembly its imported key or value came from.
        //
        // ONLY a MetadataLoadContext resolver registers. Review feedback on
        // #4034: this constructor also serves `WithRuntimeReferences`, whose
        // `assemblies` include process-lifetime HOST assemblies. A
        // `ConditionalWeakTable` keeps its VALUE alive for as long as its key
        // is, so registering a bound `this.MapClrTypeToReferences` under a key
        // that never dies would root this resolver — and, through it, the
        // collectible `DriverReferenceLoadContext` it holds — forever, so the
        // context could never unload. There is nothing to gain either way: a
        // runtime-loaded type IS a host `RuntimeType`, so `MakeClrType` takes
        // its host fast path and never consults a projector. `metadataContext`
        // is the exact discriminator: `Default()` and `WithRuntimeReferences`
        // both pass it null, and only `WithReferences` supplies one. Every
        // assembly an MLC resolver holds was loaded THROUGH that context —
        // including the BCL host-fallback paths, which `WithReferences` routes
        // through `LoadFromPath(mlc, host)` rather than the host loader — so
        // each key here dies with the context, and the projector value dies
        // with it.
        if metadataContext != nil {
            for assembly in assemblies {
                MapTypeSymbol.RegisterReferenceProjector(assembly, this.MapClrTypeToReferences)
            }
        }
    }

    private class NotFoundSentinel { }

    private class DriverReferenceLoadContext : AssemblyLoadContext {
        private let directories HashSet[string] = HashSet[string](StringComparer.OrdinalIgnoreCase)

        init() : base(true) { }

        func LoadReference(path string) Assembly {
            AddProbeDirectory(path)
            return LoadFromAssemblyPath(path)
        }

        // Issue #3818: a reference reused from the host context (rather than
        // loaded here) still contributes its directory, so a private
        // dependency sitting beside it stays resolvable from this context.
        func AddProbeDirectory(path string) -> directories.Add(Path.GetDirectoryName(path) ?? string.Empty)

        protected override func Load(assemblyName AssemblyName) Assembly? {
            for directory in directories {
                let path = Path.Combine(directory, assemblyName.Name + ".dll")
                if File.Exists(path) {
                    return LoadFromAssemblyPath(path)
                }
            }
            return nil
        }
    }

    /// Releases the underlying (cref:MetadataLoadContext) (if any),
    /// closing all file handles it holds to referenced assemblies. Also
    /// evicts stale entries from the process-wide type-symbol caches so
    /// that the disposed context's (cref:Type) objects can be
    /// garbage-collected.
    /// @remarks Callers that create a resolver via (cref:WithReferences) must
    /// dispose it when the compilation session is complete. Failing to do so
    /// leaks one file handle per loaded assembly per resolver instance.
    func Dispose() {
        metadataContext?.Dispose()
        runtimeContext?.Unload()
        // Kept as a call site for symmetry with the caches below, but note
        // that ImportedTypeSymbol.ClearCache is deliberately a NO-OP: that
        // cache is weakly keyed by assembly, so a disposed context's entries
        // become collectable on their own (#2341). Cross-compilation IDENTITY
        // — a symbol from one compilation answering another's lookup — is not
        // a lifetime question and is not addressed here; it is handled by the
        // load-context-sensitive key that cache uses (#3826).
        ImportedTypeSymbol.ClearCache()
        // FunctionTypeSymbol eagerly closes a host-runtime Func/Action over
        // MetadataLoadContext-projected type arguments, so its process-wide
        // cache can likewise pin (and later resurface) types from this disposed
        // context across compilations in the same process (issue #908). Clear
        // it for the same reason.
        FunctionTypeSymbol.ClearCache()
        // Every other interning cache in this namespace is process-wide and
        // keyed (directly or via a constructed-generic definition) by symbols
        // that ultimately point back at this context's Type objects or at
        // Declaration syntax trees. Left uncleared they pin that memory for
        // the lifetime of the process even though no live compilation can
        // reach them anymore (#1622).
        NullableTypeSymbol.ClearCache()
        PlatformTypeSymbol.ClearCache()
        SliceTypeSymbol.ClearCache()
        MapTypeSymbol.ClearCache()
        PointerTypeSymbol.ClearCache()
        ByRefTypeSymbol.ClearCache()
        ArrayTypeSymbol.ClearCache()
        RectangularArrayTypeSymbol.ClearCache()
        SequenceTypeSymbol.ClearCache()
        AsyncSequenceTypeSymbol.ClearCache()
        ChannelTypeSymbol.ClearCache()
        TupleTypeSymbol.ClearCache()
        FunctionPointerTypeSymbol.ClearCache()
        StructSymbol.ClearCache()
        EnumSymbol.ClearCache()
        InterfaceSymbol.ClearCache()
        DelegateTypeSymbol.ClearCache()
        // Issue #1678: the binder's per-Type CLR member-enumeration
        // memoization (ClrTypeUtilities.SafeGetMethods/SafeGetInterfaces/etc.
        // and MemberLookup's higher-level (Type, name) method cache) is also
        // process-wide and keyed on this context's Type objects. Clear it for
        // the same reason as every cache above.
        ClrTypeUtilities.ClearCache()
        MemberLookup.ClearCache()
        // Issue #1632: ClrOperatorResolution.TryResolveConversion memoizes
        // user-defined-conversion lookups per (sourceType, targetType,
        // allowExplicit); those Type instances also originate from this
        // context, so clear it for the same reason as the caches above.
        ClrOperatorResolution.ClearCache()
    }

    /// Gets the assemblies this resolver searches, in priority order.
    prop Assemblies ImmutableArray[Assembly] -> assemblies

    /// Gets the simple names of assemblies that are referenced (transitively)
    /// by the supplied reference set but could not be resolved from either that
    /// set or the gsc host runtime. An empty array means the supplied references
    /// form a complete transitive closure. A non-empty array indicates the
    /// project is under-referenced: touching a member whose signature lives in
    /// one of these assemblies would otherwise throw deep in member
    /// enumeration, so the resolver degrades gracefully (the member is skipped)
    /// and callers may surface a diagnostic naming the missing assemblies
    /// (issue #340).
    prop MissingTransitiveReferences ImmutableArray[string] -> missingTransitiveReferences

    /// Returns `true` when [`assembly`](paramref)'s
    /// internal surface is visible to the current compilation, either because
    /// it is the same assembly or because it grants friendship via
    /// `InternalsVisibleTo`.
    /// @param assembly The referenced assembly to inspect.
    /// @returns `true` when internal members are visible.
    func CanAccessInternalMembers(assembly Assembly?) bool -> ImportedAssemblySemantics.GrantsInternalAccessTo(
        assembly,
        CurrentAssemblyName
    )

    /// Returns per-reference metadata needed to emit a
    /// `CompilationMetadataReferences` `CustomDebugInformation` blob
    /// per the Portable PDB spec. Each entry corresponds to one assembly in
    /// (cref:Assemblies) that can be read from disk; references with no
    /// file on disk (in-memory, dynamic) are silently skipped.
    /// @returns An immutable array of (cref:ReferenceInfo) values, one per
    /// resolvable file-backed reference.
    func GetReferenceInfos() ImmutableArray[ReferenceInfo] {
        let builder = ImmutableArray.CreateBuilder[ReferenceInfo]()
        for asm in this.assemblies {
            let location = asm.Location
            if string.IsNullOrEmpty(location) || !File.Exists(location) {
                continue
            }
            try {
                let fileSize = uint32(FileInfo(location).Length)
                var timeStamp uint32 = uint32(0)
                var mvid = Guid.Empty
                {
                    using let fs = FileStream(location, FileMode.Open, FileAccess.Read, FileShare.Read)
                    {
                        using let peReader = PEReader(fs)
                        timeStamp = uint32(peReader.PEHeaders.CoffHeader.TimeDateStamp)
                        let mdReader = peReader.GetMetadataReader()
                        let module = mdReader.GetModuleDefinition()
                        mvid = mdReader.GetGuid(module.Mvid)
                    }
                }
                // Flags per Portable PDB spec § CompilationMetadataReferences:
                //   bit 0 = EmbedInteropTypes (COM interop embed, false for normal refs)
                //   bit 1 = MetadataImageKind.Assembly (true for .dll assemblies)
                const flags uint8 = uint8(0x02)
                builder.Add(
                    ReferenceInfo(
                        fileName: Path.GetFileName(location),
                        aliases: string.Empty,
                        flags: flags,
                        timeStamp: timeStamp,
                        fileSize: fileSize,
                        mvid: mvid
                    )
                )
            } catch (Exception) {
                // Skip references that cannot be read (locked, corrupt, etc.).

            }
        }
        return builder.ToImmutable()
    }

    /// Tries to resolve a fully-qualified type name across the referenced
    /// assemblies.
    /// @param fullName The fully-qualified type name (e.g. `System.Console`).
    /// @param type The resolved (cref:Type), if found.
    /// @returns `true` if a matching type was found; otherwise `false`.
    /// @remarks This user-facing overload enforces external visibility: a metadata type
    /// resolves by name only when it is accessible to the compilation (mirroring
    /// C# accessibility). Compiler infrastructure (the emitter and lowering)
    /// resolves well-known types by exact name — including non-externally-visible
    /// attributes such as `NullableAttribute`/`IsReadOnlyAttribute` — and
    /// must use the (cref:TryResolveType(string, bool, out Type)) overload
    /// with `requireExternalVisibility: false` to bypass the gate.
    func TryResolveType(fullName string, @NotNullWhen(true) out type Type?) bool -> TryResolveType(
        fullName,
        requireExternalVisibility: true,
        out type
    )

    /// Tries to resolve a fully-qualified type name across the referenced
    /// assemblies, optionally enforcing external visibility.
    /// @param fullName The fully-qualified type name.
    /// @param requireExternalVisibility When `true` (the default for user-facing binding), a
    /// non-externally-
    /// visible type does not satisfy the request. When `false`, infrastructure
    /// callers may resolve internal well-known types by exact name.
    /// @param type The resolved (cref:Type), if found.
    /// @returns `true` if a matching type was found; otherwise `false`.
    func TryResolveType(fullName string, requireExternalVisibility bool, @NotNullWhen(true) out type Type?) bool {
        type = nil
        if !TryResolveTypeRaw(fullName, out var resolved) {
            return false
        }
        if !IsExternallyResolvable(resolved) {
            // Issue #3445 follow-through, issue #4233: dependency assemblies
            // can carry internal compatibility shims with the same full name
            // as a public framework type (e.g. Microsoft.TestPlatform.Utilities
            // embeds a private System.Diagnostics.CodeAnalysis.NotNullWhenAttribute
            // polyfill for its own netstandard2.0 build). The raw index
            // intentionally keeps first-writer precedence for infrastructure
            // lookups, so an ambiguous name can land on the inaccessible shim
            // even when an accessible duplicate exists elsewhere in the
            // reference set. Prefer that accessible duplicate unconditionally —
            // both the user-facing (`requireExternalVisibility: true`) path and
            // infrastructure's well-known-type lookups (`false`) must agree
            // with what the binder already accepted, or gsc can emit a TypeRef
            // the CLR refuses to load (MethodAccessException) despite a clean
            // compile. `requireExternalVisibility` only controls the fallback
            // when NO accessible duplicate exists: infrastructure still
            // resolves genuinely internal well-known types (e.g.
            // IsReadOnlyAttribute) by exact name; user-written names fail.
            //
            // Scan with `resolved.FullName` — the type's raw CLR metadata
            // name — rather than the caller-supplied `fullName`. `fullName`
            // may be a G#-canonical spelling (reserved segments gain `_`,
            // nested types may use `.` instead of `+`) that `TryResolveTypeRaw`
            // mapped through `emittedTypeNameIndex` to reach `resolved`;
            // `Assembly.GetType(fullName)` on that canonical spelling finds no
            // duplicate at all, silently skipping this whole preference.
            let scanName = resolved!!.FullName ?? fullName
            for assembly in this.assemblies {
                let candidate Type? = SafeGetType(assembly, scanName)
                if candidate != nil && IsExternallyResolvable(candidate) {
                    // The raw first-writer-wins result is already cached under
                    // `fullName` (by TryResolveTypeRaw, above) — overwrite it
                    // with the preferred accessible candidate so repeated
                    // lookups hit the O(1) cache instead of re-scanning the
                    // whole reference closure every time.
                    resolveCache[fullName] = candidate
                    type = candidate
                    return true
                }
            }
            if requireExternalVisibility {
                return false
            }
        }
        type = resolved
        return true
    }

    /// Returns whether [`type`](paramref) was resolved from the host
    /// runtime assemblies that (cref:WithReferences) appends as a
    /// transitive-dependency fallback rather than from the supplied target
    /// reference set.
    /// @param type The resolved type to classify.
    /// @returns `true` when the type came from the host fallback.
    func IsHostFallback(type Type) bool {
        let assemblyName string? = type.Assembly.GetName().Name
        return assemblyName != nil && this.hostFallbackAssemblyNames.Contains(assemblyName)
    }

    /// Issue #4921 / #4922: returns whether this compilation targets a downlevel
    /// framework whose core library is `netstandard.dll` or `mscorlib` (netstandard2.x,
    /// .NET Framework). Those targets run on runtimes that have no
    /// `System.Private.CoreLib`, and they publish neither embeddable nullability
    /// attribute.
    /// @returns `true` when `System.Object` is declared by `netstandard` or `mscorlib`.
    internal func TargetsDownlevelFramework() bool {
        if !TryResolveType("System.Object", out var objectType) {
            return false
        }
        let name string? = objectType!!.Assembly.GetName().Name
        return string.Equals(name, "netstandard", StringComparison.OrdinalIgnoreCase) || string.Equals(
            name,
            "mscorlib",
            StringComparison.OrdinalIgnoreCase
        )
    }

    /// Issue #4921: resolves a compiler-embeddable attribute (for example
    /// `System.Runtime.CompilerServices.NullableAttribute`) that the target
    /// framework itself <em>publishes</em>, that is, an externally visible declaration
    /// the emitted assembly can legitimately reference.
    /// @remarks The host runtime assemblies are appended to every reference set as a
    /// transitive-dependency fallback (cref:IsHostFallback). Where the target is a
    /// downlevel framework (cref:TargetsDownlevelFramework), a declaration found only
    /// there is the host's `System.Private.CoreLib`, which does not exist on the runtime
    /// that will load the output (.NET Framework), so it does not count as published.
    /// Where the target runs on the host's own runtime the fallback is harmless and is
    /// kept, as it always was.
    /// @param fullName The attribute's fully-qualified metadata name.
    /// @param type The resolved declaration, if the target publishes one.
    /// @returns `true` when the target publishes the attribute.
    internal func TryResolvePublishedEmbeddableAttribute(fullName string, @NotNullWhen(true) out type Type?) bool {
        if !TryResolveType(fullName, requireExternalVisibility: true, out type) {
            return false
        }
        if IsHostFallback(type!!) && TargetsDownlevelFramework() {
            type = nil
            return false
        }
        return true
    }

    /// Issue #3297: tries to resolve a fully-qualified type name from the
    /// specific referenced assembly whose simple name is
    /// [`assemblySimpleName`](paramref), rather than across the whole
    /// reference set. Interactive submission binding needs this
    /// assembly-qualified steering: two REPL cells that redeclare the same
    /// `package foo` emit into distinct submission assemblies
    /// (`gsi$1`, `gsi$2`) that each define a `foo.<Program>`
    /// container, so the flat name lookup of
    /// (cref:TryResolveType(string, out System.Type)) can only ever answer with one
    /// of them and the other submission's declarations become unreachable.
    /// Resolving against the declaring submission's own assembly keeps every
    /// submission's members addressable. Enforces the same external-visibility
    /// gate as the user-facing flat lookup.
    /// @param assemblySimpleName The simple name of the declaring assembly (e.g. `gsi$3`).
    /// @param fullName The fully-qualified type name (e.g. `foo.<Program>`).
    /// @param type The resolved (cref:Type), if found.
    /// @returns `true` if the named assembly defines a matching, externally visible type; otherwise
    /// `false`.
    func TryResolveTypeInAssembly(assemblySimpleName string, fullName string, @NotNullWhen(true) out type Type?) bool {
        type = nil
        if string.IsNullOrEmpty(assemblySimpleName) || string.IsNullOrEmpty(fullName) {
            return false
        }
        // "::" cannot occur in a CLR type full name (nested types use '+',
        // generics use '`'), so these keys never collide with the flat
        // full-name keys sharing the cache.
        let cacheKey = assemblySimpleName + "::" + fullName
        if resolveCache.TryGetValue(cacheKey, out var cached) {
            if object.ReferenceEquals(cached, MissTypeSentinel) {
                return false
            }
            type = cached
            return true
        }
        var resolved Type? = nil
        for asm in assemblies {
            if !string.Equals(asm.GetName().Name, assemblySimpleName, StringComparison.Ordinal) {
                continue
            }
            resolved = SafeGetType(asm, fullName)
            if resolved != nil {
                break
            }
        }
        if resolved == nil || !IsExternallyResolvable(resolved) {
            resolveCache.TryAdd(cacheKey, MissTypeSentinel)
            return false
        }
        resolveCache.TryAdd(cacheKey, resolved)
        type = resolved
        return true
    }

    /// Issue #526: resolves a nested CLR type by name on a containing
    /// [`containingType`](paramref). Used by the binder to walk a
    /// dotted-qualifier type clause (e.g. `Outer.Inner.DeepInner`) one
    /// segment at a time after the outermost type has been resolved.
    /// Honors the resolver's (cref:MetadataLoadContext) by going
    /// through (cref:Type.GetNestedType(string, BindingFlags)), which
    /// stays inside the same load context as [`containingType`](paramref).
    /// @param containingType The previously resolved outer/containing type.
    /// @param nestedName The simple name of the nested type to look up.
    /// @param nestedType The resolved nested type on success.
    /// @returns `true` when a public or non-public nested type with the requested name exists; otherwise
    /// `false`.
    func TryResolveNestedType(containingType Type?, nestedName string, @NotNullWhen(true) out nestedType Type?) bool {
        nestedType = nil
        if containingType == nil || string.IsNullOrEmpty(nestedName) {
            return false
        }
        try {
            nestedType = containingType.GetNestedType(nestedName, BindingFlags.Public | BindingFlags.NonPublic)
        } catch (FileNotFoundException) {
            return false
        } catch (BadImageFormatException) {
            return false
        }
        return nestedType != nil
    }

    /// Issue #4924: finds the type whose members binding may see for
    /// [`type`](paramref), that is, its declaration on this compilation's target
    /// surface.
    /// @remarks The predefined type symbols (`string`, `object`, `int32`, ...) carry the
    /// gsc host's `System.Private.CoreLib` types, which have every member of the host
    /// runtime. Enumerating members on them binds a call to an overload the target
    /// framework may not have: `s.Split(',')` against `netstandard2.0` chose the host's
    /// `Split(char, StringSplitOptions)`, which .NET Framework does not have
    /// (MissingMethodException in Visual Studio's MSBuild), instead of the target's
    /// `Split(params char[])`. Every imported-member lookup on a receiver therefore goes
    /// through this method, and a host type is projected onto its reference-set
    /// declaration. A type from the reference set keeps its identity: projecting it again
    /// by name could pick a same-named type from another assembly (#4381).
    ///
    /// For a downlevel target (cref:TargetsDownlevelFramework) a type the target does not
    /// declare has no members binding may use: a host type the reference set cannot
    /// project, or a type the host fallback supplied only to resolve a dependency's
    /// signature (for example `System.DateOnly` out of `System.Private.CoreLib`). The
    /// method answers `false` for it and the caller reports GS0546. On any other target
    /// the host fallback is part of the runtime the output runs on, and such a type is
    /// used as is, as before. The (cref:Default) resolver has no separate target, so it
    /// keeps the host type. Loads nothing: projection is the resolver's cached name index.
    /// @param type The CLR type of a receiver.
    /// @param lookupType The type to enumerate members on; [`type`](paramref) itself when the
    /// method answers `false`.
    /// @returns `false` when the compilation targets a downlevel framework that does not
    /// declare [`type`](paramref).
    internal func TryGetMemberLookupType(type Type, out lookupType Type) bool {
        lookupType = type
        if metadataContext == nil {
            return true
        }
        if type.GetType() == typeof(object).GetType() {
            try {
                if MapClrTypeToReferences(type) is Type projected {
                    lookupType = projected
                    return true
                }
            } catch (InvalidOperationException) {
                // The reference set does not declare the type (or one of its arguments).

            }
        } else if !IsHostFallback(
            if type.IsConstructedGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
        ) {
            return true
        }
        return !IsDownlevelTarget()
    }

    // Issue #4924: TargetsDownlevelFramework, computed once per resolver (0 = not yet
    // computed, 1 = downlevel, 2 = not). The value cannot change, so a racing first
    // computation stores the same answer.
    private var downlevelTarget int32 = 0

    private func IsDownlevelTarget() bool {
        if downlevelTarget == 0 {
            downlevelTarget = if TargetsDownlevelFramework() {
                1
            } else {
                2
            }
        }
        return downlevelTarget == 1
    }

    /// Projects a CLR (cref:Type) that may originate from the gsc host
    /// runtime onto the equivalent (cref:Type) from this resolver's
    /// reference set (its (cref:MetadataLoadContext) when one is in
    /// play). This is required before calling
    /// (cref:Type.MakeGenericType(Type[])) on an open generic obtained
    /// from (cref:TryResolveType(string, out System.Type)): `MakeGenericType` demands that
    /// every type argument was loaded by the SAME context as the generic
    /// definition, otherwise it throws
    /// (cref:ArgumentException) ("was not loaded by the
    /// MetadataLoadContext that loaded the generic type or method").
    /// @remarks For the (cref:Default) resolver (no
    /// (cref:MetadataLoadContext)) the host type is already the right
    /// identity and is returned unchanged. Arrays, byref types, pointer types
    /// and constructed generics are projected element-by-element so nested
    /// types (e.g. `List[int]`) are mapped too. Open generic type/method
    /// parameters are passed through, as they are only meaningful relative to
    /// their already-projected declaring definition. When a leaf type cannot be
    /// resolved by name from the references, an
    /// (cref:InvalidOperationException) is thrown so the cross-context
    /// mismatch surfaces here rather than deep inside a later reflection call.
    /// @param hostType The CLR type to project; may be `null`.
    /// @returns The projected type, or `null` when [`hostType`](paramref) is `null`.
    /// @exception InvalidOperationException Thrown when a non-null leaf type cannot be projected into the
    /// reference
    /// set's (cref:MetadataLoadContext) (it is not resolvable by name and
    /// is not a recognised array/byref/pointer/generic shape).
    @return: NotNullIfNotNull("hostType")
    func MapClrTypeToReferences(hostType Type?) Type? {
        if hostType == nil {
            return nil
        }
        // Issue #2126: the overload-resolution sentinels (the inline `out var`
        // placeholder and the untyped `default` literal) are synthetic marker
        // types defined in GSharp.Core purely for betterness ranking. They must
        // be rebound to the resolved parameter's real type before binding
        // completes and must NEVER be projected — a sentinel reaching here means
        // an inline `out var`/`default` argument leaked out of a binder exit path
        // without being rebound. Fail with an actionable internal-compiler-error
        // that names the bug instead of the opaque MetadataLoadContext projection
        // failure it would otherwise cause.
        if object.ReferenceEquals(hostType, ClrOverloadResolution.InlineOutVarArgumentType) || object.ReferenceEquals(
            hostType,
            ClrOverloadResolution.DefaultLiteralArgumentType
        ) {
            throw InvalidOperationException(
                "Internal compiler error: the overload-resolution sentinel '${hostType.FullName}' escaped the " +
                    "binder and reached type projection. An inline `out var`/`out let`/`out _` or `default` argument " +
                    "was not rebound to its resolved parameter type on some binder exit path (issue #2126). This is a " +
                    "compiler bug; the sentinel must never participate in generic inference, projection, or emit."
            )
        }
        // The Default resolver searches host-runtime assemblies, so host types
        // already share identity with anything TryResolveType returns. No
        // projection is needed (and attempting one would be wasted work).
        if metadataContext == nil {
            return hostType
        }
        if hostType.IsArray {
            // Type.GetElementType() is documented to return non-null exactly
            // when IsArray/IsByRef/IsPointer is true (or the type is a generic
            // parameter, handled separately below) — guaranteed here by the
            // IsArray check on this line.
            let mappedElement = MapClrTypeToReferences(hostType.GetElementType()!!)
            let rank = hostType.GetArrayRank()
            return if rank == 1 {
                mappedElement!!.MakeArrayType()
            } else {
                mappedElement!!.MakeArrayType(rank)
            }
        }
        // Byref (T&) and pointer (T*) types have no resolvable FullName, so they
        // must be projected element-wise and re-wrapped. Handle them before the
        // name-resolution fallback. The element itself may be an array, generic,
        // or another shape, so recurse to keep the whole chain in the same
        // context.
        if hostType.IsByRef {
            // See the IsArray branch above: GetElementType() is non-null here
            // because IsByRef is true.
            return MapClrTypeToReferences(hostType.GetElementType()!!)!!.MakeByRefType()
        }
        if hostType.IsPointer {
            // See the IsArray branch above: GetElementType() is non-null here
            // because IsPointer is true.
            return MapClrTypeToReferences(hostType.GetElementType()!!)!!.MakePointerType()
        }
        if hostType.IsGenericType && !hostType.IsGenericTypeDefinition {
            let mappedDefinition = MapClrTypeToReferences(hostType.GetGenericTypeDefinition())
            let hostArguments = hostType.GetGenericArguments()
            let mappedArgs = [hostArguments.Length]Type
            for var i = 0; i < hostArguments.Length; i++ {
                mappedArgs[i] = MapClrTypeToReferences(hostArguments[i])!!
            }
            return mappedDefinition!!.MakeGenericType(mappedArgs)
        }
        // Open generic type/method parameters (e.g. the T of List`1 or of a
        // generic method) carry no FullName and cannot be name-resolved. They
        // are meaningful only relative to the generic definition that declares
        // them, which is itself projected through this method, so the parameter
        // is already in the correct context. Pass it through unchanged.
        if hostType.IsGenericParameter {
            return hostType
        }
        let fullName = hostType.FullName
        if !string.IsNullOrEmpty(fullName) &&
            TryResolveType(fullName!!, requireExternalVisibility: false, out var mapped) &&
            mapped != nil {
            return mapped
        }
        // No projection was possible. Returning the host type here would yield a
        // cross-context identity mismatch that fails much later inside
        // MakeGenericType/MakeGenericMethod with an opaque ArgumentException
        // ("was not loaded by the MetadataLoadContext that loaded the generic
        // type or method"). Surface the failure at the projection site instead,
        // where the offending type is known.
        throw InvalidOperationException(
            "Unable to project CLR type '$hostType' (assembly '${hostType.Assembly?.GetName().Name}') " +
                "into the reference set's MetadataLoadContext. The type could not be resolved by name from the " +
                "supplied references and is not a recognised array/byref/pointer/generic shape. Returning the host " +
                "type would cause a cross-context identity mismatch in later reflection calls."
        )
    }

    /// Resolves a well-known core CLR type (e.g. `System.Object`,
    /// `System.String`) by full name. Used by the emitter so type
    /// references for primitives originate from the target framework's
    /// reference assemblies rather than the gsc host's loaded runtime.
    /// @param fullName The fully-qualified core type name.
    /// @returns The resolved (cref:Type).
    /// @exception InvalidOperationException Thrown when no referenced assembly defines the requested type.
    func GetCoreType(fullName string) Type {
        if TryResolveType(fullName, out var t) {
            return t!!
        }
        throw InvalidOperationException("Core type '$fullName' could not be resolved from the supplied references.")
    }

    /// Gets the handle-backed reference set, or `null` in `mlc` mode or when a reference has no image.
    internal prop ImageSet ReferenceImageSet? -> imageSet

    /// Tells whether an assembly simple name is a host fallback assembly: a framework assembly that the resolver adds
    /// behind the supplied references.
    internal func IsHostFallbackName(simpleName string) bool -> hostFallbackAssemblyNames.Contains(simpleName)

    /// Discards the memoized results of (cref:TryResolveType).
    /// The comparison mode calls it, so that its lookups leave no state behind.
    internal func DiscardResolutionCache() {
        resolveCache.Clear()
    }

    /// Gives, for each assembly in search order, the type names that this resolver indexes.
    /// This is the answer of the `MetadataLoadContext` model, in the order that reflection reports.
    internal func ReadIndexedTypeNames() List[List[string]] {
        let result = List[List[string]](assemblies.Length)
        for names in ReadTypeNames(assemblies) {
            result.Add(names.Defined)
        }
        return result
    }

    /// Finds a type in the `MetadataLoadContext` by assembly simple name and full name, for the comparison mode.
    /// An assembly that the resolver already loaded answers from that assembly.
    /// Another assembly is loaded through the context, as a member signature would load it.
    /// @returns The type, or `null` when the assembly or the type is not there.
    internal func FindTypeForComparison(assemblySimpleName string, fullName string) Type? {
        try {
            for asm in assemblies {
                if string.Equals(asm.GetName().Name, assemblySimpleName, StringComparison.OrdinalIgnoreCase) {
                    return asm.GetType(fullName)
                }
            }
            return metadataContext?.LoadFromAssemblyName(assemblySimpleName)?.GetType(fullName)
        } catch (ex Exception) when ex is FileNotFoundException ||
            ex is FileLoadException ||
            ex is BadImageFormatException ||
            ex is TypeLoadException ||
            ex is ArgumentException {
            return nil
        }
    }

    /// ADR-0107: captures this resolver's full-type-name surface — every
    /// assembly's identity plus the defined and forwarded type full-names it
    /// contributes, in search order — into a serialisable
    /// (cref:ReferenceMetadataIndex). The language server persists this to
    /// its cold-start cache so a later process can skip reading the names from
    /// the reference images. This performs the same read as the type-name index,
    /// so calling it costs roughly one index build.
    /// @returns A snapshot of the resolver's type-name surface.
    func ExportMetadataIndex() ReferenceMetadataIndex {
        using let measurement = CompilationMeasurements.BeginPhase("references.metadata-index-export")
        let identities = ImmutableArray.CreateBuilder[string](assemblies.Length)
        let namesByAssembly = ImmutableArray.CreateBuilder[ImmutableArray[string]](assemblies.Length)
        let fingerprints = ImmutableArray.CreateBuilder[string](assemblies.Length)
        let typeNames = ReadTypeNames(assemblies)
        for asm in assemblies {
            identities.Add(asm.GetName().FullName)
            fingerprints.Add(GetReferenceContentFingerprint(asm))
            namesByAssembly.Add(typeNames[namesByAssembly.Count].Defined.ToImmutableArray())
        }
        return ReferenceMetadataIndex.Create(
            identities.MoveToImmutable(),
            namesByAssembly.MoveToImmutable(),
            fingerprints.MoveToImmutable()
        )
    }

    /// ADR-0107: adopts a previously-built (cref:ReferenceMetadataIndex)
    /// as this resolver's warm type-name index, so (cref:TryResolveType(string, out System.Type))
    /// skips reading the names from the reference images. The index is accepted only when its
    /// recorded assembly identities match this resolver's freshly-loaded
    /// assemblies <em>exactly</em> (same count, same
    /// (cref:System.Reflection.AssemblyName.FullName) in the same order);
    /// Content fingerprints must also match. Same-identity reference replacements
    /// return `false` and leave the resolver on the cold path.
    /// Runtime assemblies without immutable image snapshots cannot verify an index.
    /// Must be called before the first resolution so the warm index is in place
    /// for binding.
    /// @param index The candidate metadata index.
    /// @returns `true` when the index was adopted; otherwise `false`.
    func TryUseMetadataIndex(index ReferenceMetadataIndex?) bool {
        using let measurement = CompilationMeasurements.BeginPhase("references.metadata-index-adopt")
        if index == nil || index.AssemblyIdentities.Length != assemblies.Length {
            return false
        }
        for var i = 0; i < assemblies.Length; i++ {
            if !string.Equals(
                index.AssemblyIdentities[i],
                assemblies[i].GetName().FullName,
                StringComparison.Ordinal
            ) ||
                string.IsNullOrEmpty(index.ContentFingerprints[i]) || !string.Equals(
                index.ContentFingerprints[i],
                GetReferenceContentFingerprint(assemblies[i]),
                StringComparison.Ordinal
            ) {
                return false
            }
        }
        warmNameIndex = index.ToNameIndex()
        CompilationMeasurements.Count("references.metadata-index-adoptions")
        return true
    }

    private func GetReferenceContentFingerprint(assembly Assembly) string {
        if AssemblyContentFingerprints.TryGetValue(assembly, out var fingerprint) {
            return assembly.ManifestModule.ModuleVersionId.ToString("N") + ":" + fingerprint.Value
        }
        // Runtime assemblies have no immutable image snapshot here. A later disk read cannot verify their loaded bytes.
        return string.Empty
    }

    /// Returns whether the reference set contains at least one type below the
    /// specified CLR namespace.
    /// @param namespaceName The fully-qualified namespace name.
    /// @returns Whether the namespace is present in the reference set.
    internal func ContainsNamespace(namespaceName string) bool -> !string.IsNullOrEmpty(namespaceName) &&
        namespaceIndex
        .Value
        .Contains(namespaceName)

    internal func HasTypeNameAtAnyArity(fullName string) bool -> arityInsensitiveTypeNames.Value.TryGetValue(
        fullName,
        out var candidates
    ) &&
        candidates.Any((candidate string) -> TryResolveType(candidate, out _))

    private func BuildArityInsensitiveTypeNames() Dictionary[string, ImmutableArray[string]] {
        using let measurement = CompilationMeasurements.BeginPhase("references.arity-name-index")
        let names = cast[IEnumerable[string]](CurrentNameIndex().Keys)
        let groups = Dictionary[string, List[string]](StringComparer.Ordinal)
        for name in names {
            var suffix = name.Length
            while suffix > 0 && char.IsAsciiDigit(name[suffix - 1]) {
                suffix--
            }
            let key = if suffix > 0 && suffix < name.Length && name[suffix - 1] == '`' {
                name.Substring(0, suffix - 1)
            } else {
                name
            }
            if !groups.TryGetValue(key, out var group) {
                group = List[string]()
                groups.Add(key, group)
            }
            group.Add(name)
        }
        return groups.ToDictionary(
            (pair KeyValuePair[string, List[string]]) -> pair.Key,
            (pair KeyValuePair[string, List[string]]) -> pair.Value.ToImmutableArray(),
            StringComparer.Ordinal
        )
    }

    private func BuildNamespaceIndex() ImmutableHashSet[string] {
        using let measurement = CompilationMeasurements.BeginPhase("references.namespace-index")
        let builder = ImmutableHashSet.CreateBuilder[string](StringComparer.Ordinal)
        let AddNamespacePrefixes = func (typeName string) {
            let topLevelName = typeName.Split('+')[0]
            for var separator = topLevelName.LastIndexOf('.'); separator > 0; separator = topLevelName.LastIndexOf(
                '.',
                separator - 1
            ) {
                builder.Add(topLevelName.Substring(0, separator))
            }
        }
        let names = CurrentNameIndex().Keys.ToArray()
        let scopes = BuildTypeNameScopes(names)
        for name in names {
            AddNamespacePrefixes(name)
            AddNamespacePrefixes(CanonicalTypeName(name, scopes))
        }
        return builder.ToImmutable()
    }

    // Raw resolution shared by the public/internal TryResolveType overloads: it
    // performs the reference-set name lookup (warm/cold index + cache) without
    // applying the external-visibility gate, which the callers layer on top.
    private func TryResolveTypeRaw(fullName string, @NotNullWhen(true) out type Type?) bool {
        type = nil
        if string.IsNullOrEmpty(fullName) {
            return false
        }
        if resolveCache.TryGetValue(fullName, out var cached) {
            if object.ReferenceEquals(cached, MissTypeSentinel) {
                return false
            }
            type = cached
            return true
        }
        // Look the name up in the name -> assembly map. The map is the adopted
        // persisted index, or else the index read from the metadata names.
        // Create the Type only for a name that is looked up.
        // A name that is not in the map is a miss.
        // If the recorded assembly cannot supply a name, scan the assemblies in order.
        let nameIndex = CurrentNameIndex()
        if nameIndex.TryGetValue(fullName, out var assemblyIndex) &&
            TryMaterializeIndexedType(fullName, assemblyIndex, out var indexed) {
            resolveCache.TryAdd(fullName, indexed!!)
            type = indexed
            return true
        }
        if TryFindRawTypeName(fullName, out var rawName) && nameIndex.TryGetValue(rawName!!, out assemblyIndex) &&
            TryMaterializeIndexedType(rawName!!, assemblyIndex, out indexed) {
            resolveCache.TryAdd(fullName, indexed!!)
            type = indexed
            return true
        }
        resolveCache.TryAdd(fullName, MissTypeSentinel)
        return false
    }

    private func CurrentNameIndex() Dictionary[string, int32] -> warmNameIndex ?? typeNameIndex.Value.Names

    private func TryMaterializeIndexedType(
        fullName string,
        assemblyIndex int32,
        @NotNullWhen(true) out type Type?
    ) bool {
        // Return a type that reflection found as it was found (assemblies with no image).
        if warmNameIndex == nil && typeNameIndex.Value.LoadedTypes.TryGetValue(fullName, out type) {
            return true
        }
        return TryMaterializeWarmType(fullName, assemblyIndex, out type)
    }

    private func TryFindRawTypeName(emittedName string, @NotNullWhen(true) out rawName string?) bool {
        return this.emittedTypeNameIndex.Value.TryGetValue(emittedName, out rawName)
    }

    // Issue: an `internal` (non-externally-visible) type declared by a
    // *referenced* assembly is not accessible to the compilation by name, so it
    // must not satisfy a user-written type reference. gsc previously indexed
    // every type returned by `Assembly.GetTypes()` (which includes internal
    // types), letting an unqualified name such as `ThisAssembly` bind to the
    // framework-internal `System.Diagnostics.ThisAssembly` instead of failing.
    // Mirror C# accessibility: a metadata type resolves by name only when it is
    // externally visible, or when its declaring assembly grants this compilation
    // internal access via `InternalsVisibleTo`. `Type.IsVisible` already encodes
    // "public, and — for nested types — every enclosing type is public too".
    private func IsExternallyResolvable(type Type?) bool {
        if type == nil {
            return false
        }
        if type.IsVisible {
            return true
        }
        try {
            return CanAccessInternalMembers(type.Assembly)
        } catch (Exception) {
            // A type whose assembly cannot be inspected is conservatively
            // treated as inaccessible by name.
            return false
        }
    }

    private func TryMaterializeWarmType(fullName string, assemblyIndex int32, @NotNullWhen(true) out type Type?) bool {
        type = nil
        if assemblyIndex >= 0 && assemblyIndex < assemblies.Length {
            type = SafeGetType(assemblies[assemblyIndex], fullName)
            if type != nil {
                return true
            }
        }
        for asm in assemblies {
            type = SafeGetType(asm, fullName)
            if type != nil {
                return true
            }
        }
        return false
    }

    /// A (cref:MetadataAssemblyResolver) that resolves from a supplied
    /// set of images indexed by their metadata assembly names and, when
    /// that fails, degrades gracefully: instead of allowing the
    /// (cref:MetadataLoadContext) to surface an exception for an
    /// unresolved transitive dependency, it records the offending simple name
    /// and returns `null` so the caller can skip the affected
    /// member (issue #340). The recorded names feed the
    /// (cref:MissingTransitiveReferences) diagnostic surface.
    private class FallbackMetadataAssemblyResolver : MetadataAssemblyResolver {
        private let assemblyBytes Dictionary[string, []uint8] = Dictionary[string, []uint8](
            StringComparer.OrdinalIgnoreCase
        )
        private let assemblyPaths Dictionary[string, string] = Dictionary[string, string](
            StringComparer.OrdinalIgnoreCase
        )
        private let assemblyNamesByPath Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal)
        private let unresolved HashSet[string] = HashSet[string](StringComparer.OrdinalIgnoreCase)
        private let gate object = SystemObject()

        init(paths IEnumerable[string], sharedPaths IEnumerable[string]) {
            let shared = sharedPaths.Select(Path.GetFullPath).ToHashSet(StringComparer.Ordinal)
            // Read each assembly into memory so no file handles are held open.
            // This prevents MSBuild CopyRefAssembly from being blocked (#853).
            for path in paths {
                let fullPath = Path.GetFullPath(path)
                if !assemblyNamesByPath.ContainsKey(fullPath) {
                    try {
                        let bytes = if shared.Contains(fullPath) {
                            SharedHostAssemblyBytes.GetOrAdd(fullPath, ReadAssemblyBytes)
                        } else {
                            ReadAssemblyBytes(fullPath)
                        }
                        using let pe = PEReader(ImmutableCollectionsMarshal.AsImmutableArray(bytes))
                        if !pe.HasMetadata {
                            continue
                        }
                        let reader = pe.GetMetadataReader()
                        if !reader.IsAssembly {
                            continue
                        }
                        let simpleName = reader.GetString(reader.GetAssemblyDefinition().Name)
                        assemblyNamesByPath[fullPath] = simpleName
                        // Keep the first supplied image for each name, before host fallback images.
                        if !assemblyBytes.ContainsKey(simpleName) {
                            assemblyBytes[simpleName] = bytes
                            assemblyPaths[simpleName] = fullPath
                        }
                    } catch (ex Exception) when ex is IOException ||
                        ex is UnauthorizedAccessException ||
                        ex is BadImageFormatException {
                        // Skip files that can't be read.

                    }
                }
            }
        }

        func TryGetOriginalPath(simpleName string, @NotNullWhen(true) out path string?) bool {
            if !string.IsNullOrEmpty(simpleName) {
                return assemblyPaths.TryGetValue(simpleName, out path)
            }
            path = nil
            return false
        }

        prop UnresolvedSimpleNames IEnumerable[string] {
            get {
                lock gate {
                    return unresolved.ToArray()
                }
            }
        }

        /// Loads an assembly by path into the given (cref:MetadataLoadContext)
        /// using in-memory bytes (no file handle held open).
        func LoadFromPath(context MetadataLoadContext, path string) Assembly {
            var asm Assembly
            var originalPath = path
            let bytes = GetImageFromPath(path)
            if bytes != nil {
                asm = context.LoadFromByteArray(bytes)
                ReferenceResolver.RegisterAssemblyContentFingerprint(asm, bytes, GetImage)
                originalPath = assemblyPaths[assemblyNamesByPath[Path.GetFullPath(path)]]
            } else {
                // Fallback: read from disk with sharing flags.
                using let fs = FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)
                let buffer = [int32(fs.Length)]uint8
                fs.ReadExactly(buffer)
                asm = context.LoadFromByteArray(buffer)
                ReferenceResolver.RegisterAssemblyContentFingerprint(asm, buffer, GetImage)
            }
            ReferenceResolver.RegisterAssemblyOriginalPath(asm, originalPath)
            return asm
        }

        /// Gets the image of the assembly this resolver supplies for a simple name, or `null`
        /// when it supplies none. A type forwarded to an assembly it cannot supply cannot be loaded.
        func GetImage(simpleName string)([]uint8)? {
            if assemblyBytes.TryGetValue(simpleName, out var image) {
                return image
            }
            return nil
        }

        func GetImageFromPath(path string)([]uint8)? {
            if assemblyNamesByPath.TryGetValue(Path.GetFullPath(path), out var simpleName) {
                return GetImage(simpleName)
            }
            return nil
        }

        func GetAssemblyNameFromPath(path string) string? {
            if assemblyNamesByPath.TryGetValue(Path.GetFullPath(path), out var simpleName) {
                return simpleName
            }
            return nil
        }

        /// Whether this resolver holds an image for [`simpleName`](paramref), so that
        /// (cref:Resolve) can answer it. A `false` answer is what makes the context raise
        /// (cref:FileNotFoundException) for the name.
        /// @param simpleName The simple assembly name.
        /// @returns `true` when an image is held for the name.
        func HasImage(simpleName string) bool -> !string.IsNullOrEmpty(simpleName) && assemblyBytes.ContainsKey(
            simpleName
        )

        /// Records [`simpleName`](paramref) as unresolved, as (cref:Resolve) does when it
        /// returns `null`.
        /// @param simpleName The simple assembly name.
        func RecordUnresolved(simpleName string) {
            if !string.IsNullOrEmpty(simpleName) {
                lock gate {
                    unresolved.Add(simpleName)
                }
            }
        }

        override func Resolve(context MetadataLoadContext, assemblyName AssemblyName) Assembly? {
            let simpleName = assemblyName?.Name
            if !string.IsNullOrEmpty(simpleName) && assemblyBytes.TryGetValue(simpleName!!, out var bytes) {
                try {
                    let asm = context.LoadFromByteArray(bytes)
                    ReferenceResolver.RegisterAssemblyContentFingerprint(asm, bytes, GetImage)
                    if assemblyPaths.TryGetValue(simpleName!!, out var originalPath) {
                        ReferenceResolver.RegisterAssemblyOriginalPath(asm, originalPath)
                    }
                    return asm
                } catch (ex Exception) when ex is FileNotFoundException ||
                    ex is FileLoadException ||
                    ex is BadImageFormatException {
                    // Fall through to record-and-degrade below.

                }
            }
            if !string.IsNullOrEmpty(simpleName) {
                lock gate {
                    unresolved.Add(simpleName)
                }
            }
            // Returning null lets MetadataLoadContext raise a load failure only
            // if a member actually depends on this assembly; the per-member
            // tolerance in ClrOverloadResolution then skips that member rather than
            // aborting the whole lookup.
            return nil
        }

        shared {
            private let SharedHostAssemblyBytes ConcurrentDictionary[string, []uint8] = ConcurrentDictionary[
                string,
                []uint8
            ](StringComparer.Ordinal)

            private func ReadAssemblyBytes(path string)[]uint8 {
                using let stream = FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                )
                let bytes = [int32(stream.Length)]uint8
                stream.ReadExactly(bytes)
                return bytes
            }
        }
    }

    shared {
        private let WellKnownBclAssemblyNames[]string = []string{
            "System.Runtime",
            "System.Console",
            "System.Private.CoreLib",
            "mscorlib"
        }
        private let DefaultTypeNameIndexGate object = SystemObject()

        /// The folder with the portable runtime files of the SDK package (`channels/`, `values/`,
        /// `extensions/`). The driver sets it from /sdktoolsdir:. The variable GSHARP_SDK_TOOLS_DIR
        /// is the fallback (ADR-0207).
        internal var SdkToolsDirectory string? = nil
        private var defaultTypeNameIndexAssemblies ImmutableArray[Assembly] = ImmutableArray[Assembly].Empty
        private var defaultTypeNameIndex Lazy[ReferenceTypeNameIndex]?

        // Process-wide registry of original on-disk paths for assemblies loaded
        // via LoadFromByteArray (whose Assembly.Location is empty). Populated by
        // FallbackMetadataAssemblyResolver and consulted by TryGetAssemblyPath /
        // AssemblyDocumentationProvider so doc-XML discovery and cross-assembly
        // navigation keep working after #853 (which switched ref-pack loading
        // from PathAssemblyResolver to LoadFromByteArray to avoid file locking).
        private let AssemblyOriginalPaths ConditionalWeakTable[Assembly, string] = ConditionalWeakTable[
            Assembly,
            string
        ]()
        private let AssemblyContentFingerprints ConditionalWeakTable[Assembly, Lazy[string]] =
        ConditionalWeakTable[Assembly, Lazy[string]]()
        // The image bytes of each assembly that was loaded from memory.
        // They give the type names from the metadata tables.
        // The fingerprint above already keeps the same array alive.
        private let AssemblyImages ConditionalWeakTable[Assembly, []uint8] = ConditionalWeakTable[Assembly, []uint8]()

        // Gives the image of an assembly by simple name, from the load context
        // that produced the assembly. Present for each assembly in AssemblyImages.
        private let AssemblyImageLookups ConditionalWeakTable[
            Assembly,
            Func[string, ([]uint8)?]
        ] = ConditionalWeakTable[Assembly, Func[string, ([]uint8)?]]()

        private func RegisterAssemblyContentFingerprint(
            assembly Assembly,
            bytes[]uint8,
            imageOf Func[string, ([]uint8)?]
        ) {
            AssemblyImages.AddOrUpdate(assembly, bytes)
            AssemblyImageLookups.AddOrUpdate(assembly, imageOf)
            AssemblyContentFingerprints.GetValue(
                assembly,
                (key Assembly) -> Lazy[string](() -> Convert.ToHexString(SHA256.HashData(bytes)))
            )
        }

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
        private let MissTypeSentinel Type = typeof(NotFoundSentinel)

        /// Recovers the on-disk path that [`assembly`](paramref) was
        /// originally loaded from. Falls back to the per-process registry that
        /// (cref:ReferenceResolver) populates whenever an assembly is read
        /// into a (cref:MetadataLoadContext) from in-memory bytes (so
        /// MSBuild's `CopyRefAssembly` task is not blocked — see #853 / #858),
        /// which is the case where (cref:Assembly.Location) returns the
        /// empty string. Used by
        /// `AssemblyDocumentationProvider.DiscoverXmlPath` to locate the
        /// companion XML doc file, and by
        /// `CrossAssemblyDefinitionResolver` to locate the originating
        /// sibling project / portable PDB for cross-assembly Go-to-Definition.
        /// @param assembly An assembly returned by a resolver.
        /// @param path The original on-disk path on success.
        /// @returns `true` when a non-empty path was recovered.
        func TryGetAssemblyPath(assembly Assembly?, @NotNullWhen(true) out path string?) bool {
            path = nil
            if assembly == nil {
                return false
            }
            try {
                let location = assembly.Location
                if !string.IsNullOrEmpty(location) {
                    path = location
                    return true
                }
            } catch (NotSupportedException) {
                // Dynamic / in-memory assemblies throw on Location access; fall through.

            }
            if AssemblyOriginalPaths.TryGetValue(assembly, out var registered) && !string.IsNullOrEmpty(registered) {
                path = registered
                return true
            }
            return false
        }

        internal func OpenAssemblyImage(assembly Assembly) Stream? {
            if AssemblyImages.TryGetValue(assembly, out var image) {
                return MemoryStream(image, writable: false)
            }
            if TryGetAssemblyPath(assembly, out var path) {
                // Runtime assemblies can outlive deleted fixture files. No image
                // means callers must inspect reflection metadata, not assume absence.
                try {
                    return File.OpenRead(path)
                } catch (error FileNotFoundException) {
                    return nil
                } catch (error DirectoryNotFoundException) {
                    return nil
                }
            }
            return nil
        }

        internal func OpenReferencedAssemblyImage(origin Assembly, simpleName string) Stream? {
            if AssemblyImageLookups.TryGetValue(origin, out var imageOf) {
                let image = imageOf(simpleName)
                return if image != nil {
                    MemoryStream(image, writable: false)
                } else {
                    nil
                }
            }
            let assembly = AssemblyLoadContext
                .GetLoadContext(origin)
                ?.Assemblies
                .FirstOrDefault((candidate Assembly) -> candidate.GetName().Name == simpleName)
            return if assembly != nil {
                OpenAssemblyImage(assembly)
            } else {
                nil
            }
        }

        /// Gets a resolver that searches the runtime's currently loaded
        /// assemblies plus the well-known BCL assemblies.
        /// @returns A default resolver.
        func Default() ReferenceResolver {
            for path in ResolveDriverReferencePaths(Array.Empty[string]()) {
                try {
                    // Deliberately load here: BuildHostAssemblies excludes DriverReferenceLoadContext assemblies.
                    let _ = AssemblyLoadContext.Default.LoadFromAssemblyPath(path)
                } catch (ex Exception) when ex is FileLoadException || ex is BadImageFormatException {
                    // Already loaded or corrupt; leave it unavailable to the resolver.

                }
            }
            let assemblies = BuildHostAssemblies()
            return ReferenceResolver(
                assemblies,
                metadataContext: nil,
                missingTransitiveReferences: ImmutableArray[string].Empty,
                typeNameIndex: GetDefaultTypeNameIndex(assemblies)
            )
        }

        /// Resolves the references supplied to a driver and appends the bundled
        /// Gsharp.Extensions, Gsharp.Runtime.Channels, and Gsharp.Runtime.Values assemblies when they are
        /// available.
        /// @param referencePaths Explicit reference paths.
        /// @returns The effective reference paths.
        func ResolveDriverReferencePaths(referencePaths IEnumerable[string]?) IReadOnlyList[string] {
            let paths = List[string]()
            if referencePaths != nil {
                for path in referencePaths {
                    if !string.IsNullOrWhiteSpace(path) {
                        paths.Add(path)
                    }
                }
            }
            AppendBundledPath(paths, FindBundledExtensionPath(AppContext.BaseDirectory))
            AppendBundledPath(paths, FindBundledChannelsRuntimePath(AppContext.BaseDirectory))
            AppendBundledPath(paths, FindBundledValuesRuntimePath(AppContext.BaseDirectory))
            return paths
        }

        /// Validates explicit driver references before implicit bundled references
        /// are appended.
        /// @param referencePaths Explicit reference paths.
        /// @param error A command-line error when validation fails.
        /// @returns `true` when every reference is a readable .NET assembly.
        func TryValidateDriverReferencePaths(referencePaths IEnumerable[string], out error string) bool {
            for path in referencePaths {
                if string.IsNullOrWhiteSpace(path) {
                    error = "/reference requires a path."
                    return false
                }
                try {
                    let fullPath = Path.GetFullPath(path)
                    if !File.Exists(fullPath) {
                        error = "Unable to load reference '$path': file does not exist."
                        return false
                    }
                    let _ = AssemblyName.GetAssemblyName(fullPath)
                } catch (BadImageFormatException) {
                    error = "Unable to load reference '$path': file is not a valid .NET assembly."
                    return false
                } catch (ex Exception) when ex is ArgumentException ||
                    ex is IOException ||
                    ex is NotSupportedException ||
                    ex is UnauthorizedAccessException {
                    error = "Unable to load reference '$path': ${ex.Message}"
                    return false
                }
            }
            error = string.Empty
            return true
        }

        /// Gets a resolver for evaluated code by loading explicit references into
        /// the runtime context rather than a metadata-only context.
        /// @param referencePaths Paths to runtime assemblies.
        /// @returns A resolver over the loaded assemblies and host BCL.
        func WithRuntimeReferences(referencePaths IEnumerable[string]?) ReferenceResolver -> WithRuntimeReferences(
            referencePaths,
            default(ImmutableArray[Assembly])
        )

        /// Freezes host candidates before compiler workers can load additional implementation dependencies.
        internal func CaptureHostAssemblies() ImmutableArray[Assembly] -> BuildHostAssemblies()

        internal func WithRuntimeReferences(
            referencePaths IEnumerable[string]?,
            hostSnapshot ImmutableArray[Assembly]
        ) ReferenceResolver {
            let runtimeContext = DriverReferenceLoadContext()
            let runtimeAssemblies = List[Assembly]()
            if referencePaths != nil {
                for path in referencePaths {
                    if string.IsNullOrWhiteSpace(path) {
                        continue
                    }
                    let fullPath = Path.GetFullPath(path)
                    // Issue #3818: a reference the host has ALREADY loaded from
                    // this exact path must resolve to the host's instance, not to
                    // a second private copy. Loading it again into the driver
                    // context mints a rival identity for every type in it, and any
                    // Type that leaks between two compilations in one process
                    // (through the binder's process-wide symbol/member caches) then
                    // becomes a cross-context type: `MakeGenericMethod` rejects it,
                    // the only candidate is dropped, and the call reports the
                    // opaque "Cannot find function <name>" — order-dependently,
                    // because it needs an earlier compilation to have created the
                    // rival copy. Same file plus same identity means reuse is
                    // always safe; a genuinely different assembly does not match by
                    // path and is still loaded privately.
                    let reused Assembly? = TryReuseHostLoadedAssembly(fullPath)
                    if reused != nil {
                        runtimeContext.AddProbeDirectory(fullPath)
                    }
                    let assembly = reused ?? runtimeContext.LoadReference(fullPath)
                    RegisterAssemblyOriginalPath(assembly, fullPath)
                    runtimeAssemblies.Add(assembly)
                }
            }
            let runtimeNames = HashSet[string?](StringComparer.OrdinalIgnoreCase)
            for assembly in runtimeAssemblies {
                runtimeNames.Add(assembly.GetName().FullName)
            }
            let assemblies = ImmutableArray.CreateBuilder[Assembly]()
            for assembly in if hostSnapshot.IsDefault {
                BuildHostAssemblies()
            } else {
                hostSnapshot
            } {
                if !runtimeNames.Contains(assembly.GetName().FullName) {
                    assemblies.Add(assembly)
                }
            }
            assemblies.AddRange(runtimeAssemblies)
            return ReferenceResolver(
                assemblies.ToImmutable(),
                metadataContext: nil,
                missingTransitiveReferences: ImmutableArray[string].Empty,
                runtimeContext: runtimeContext
            )
        }

        /// Issue #2215: the gsc host's trusted-platform (BCL) assembly paths, exposed
        /// so sibling tools (e.g. gsgen's C# stub compilation) can apply the same
        /// "explicit paths win, host BCL is a fallback for anything not named" policy
        /// this resolver uses internally, instead of silently compiling against zero
        /// references when the caller supplies none.
        /// @returns The host's trusted-platform assembly paths.
        func HostTrustedPlatformAssemblyPaths() IReadOnlyList[string] -> GetHostTrustedPlatformAssemblies()

        /// Gets a resolver that searches only the assemblies referenced by file
        /// path. The supplied paths are loaded into an isolated
        /// (cref:MetadataLoadContext) so callers see types whose
        /// (cref:Type.Assembly) reflects the target framework rather than
        /// the gsc host's runtime.
        /// @param referencePaths Paths to additional assemblies to load.
        /// @returns A resolver including the supplied references.
        func WithReferences(referencePaths IEnumerable[string]?) ReferenceResolver {
            if referencePaths == nil {
                return Default()
            }
            let paths = List[string]()
            for path in referencePaths {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    paths.Add(path)
                }
            }
            if paths.Count == 0 {
                return Default()
            }
            // Augment the resolver with the gsc host's trusted platform assemblies
            // as a *fallback*. The resolver registers supplied identities first.
            // Any BCL assembly the user
            // brings (e.g. from a target framework ref pack) wins over the host
            // copy. The host fallback only kicks in for dependencies the user did
            // not enumerate (typical when a user DLL pulls in extra BCL pieces).
            let resolverPaths = List[string](paths)
            let hostPaths = GetHostTrustedPlatformAssemblies()
            resolverPaths.AddRange(hostPaths)
            let resolver = FallbackMetadataAssemblyResolver(resolverPaths, hostPaths)
            let userAssemblyNames = paths
                .Select(resolver.GetAssemblyNameFromPath)
                .OfType[string]()
                .ToHashSet(StringComparer.OrdinalIgnoreCase)
            let fallbackHostPaths = hostPaths.Where(
                (path string) -> !userAssemblyNames.Contains(resolver.GetAssemblyNameFromPath(path) ?? string.Empty)
            )
                .ToList()
            let mlc = MetadataLoadContext(resolver, coreAssemblyName: ChooseCoreAssemblyName(resolverPaths, resolver))
            let builder = ImmutableArray.CreateBuilder[Assembly]()
            let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
            for path in paths {
                try {
                    let asm Assembly? = resolver.LoadFromPath(mlc, path)
                    if asm != nil && seen.Add(asm.GetName().FullName) {
                        builder.Add(asm)
                    }
                } catch (FileNotFoundException) { } catch (BadImageFormatException) { }
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
            //
            // Issue #4924: nor is it applied for a downlevel target, whose core
            // library is the supplied `netstandard.dll` or `mscorlib`. That target
            // brings its own complete BCL surface, and every host type visible to
            // binding beyond it is a type the target framework does not have:
            // `import System` put the host's `MemoryExtensions` in scope, so
            // `s.Contains('x')` bound to `MemoryExtensions.Contains(ReadOnlySpan<char>,
            // char)` in `System.Private.CoreLib`, and `d.TryAdd(k, v)` to the host's
            // `CollectionExtensions`, an output .NET Framework cannot load. The host
            // assemblies stay in the resolver closure above, so a supplied reference
            // that depends on them (Gsharp.Extensions) still resolves its signatures.
            var userHasNonBcl = false
            for path in paths {
                if !IsBclOrRuntimeAssemblyPath(path) {
                    userHasNonBcl = true
                    break
                }
            }
            if userHasNonBcl && !SuppliesDownlevelCoreLibrary(paths, resolver) {
                for host in fallbackHostPaths {
                    if !IsBclOrRuntimeAssemblyPath(host) {
                        continue
                    }
                    try {
                        let asm Assembly? = resolver.LoadFromPath(mlc, host)
                        if asm != nil && seen.Add(asm.GetName().FullName) {
                            builder.Add(asm)
                        }
                    } catch (FileNotFoundException) { } catch (BadImageFormatException) { }
                }
            }
            let loaded = builder.ToImmutable()
            let missing = ComputeMissingTransitiveReferences(loaded, mlc, resolver)
            let created = ReferenceResolver(
                loaded,
                mlc,
                missing,
                hostFallbackAssemblyNames: fallbackHostPaths
                    .Select(resolver.GetAssemblyNameFromPath)
                    .OfType[string]()
                    .ToImmutableHashSet(StringComparer.OrdinalIgnoreCase)
            )
            AttachImageSet(created, resolver, resolverPaths)
            return created
        }

        // ADR-0209 PR 1: in `handles` and `compare` mode, build the handle-backed set over the
        // same images, in the same order. In `compare` mode, also compare the two models by name.
        private func AttachImageSet(
            created ReferenceResolver,
            supplier FallbackMetadataAssemblyResolver,
            resolverPaths List[string]
        ) {
            let mode = MetadataModel.Current
            if mode == MetadataModelMode.Mlc {
                return
            }
            using let measurement = CompilationMeasurements.BeginPhase("references.image-set")
            let set = TryBuildImageSet(created.assemblies, supplier, resolverPaths)
            created.imageSet = set
            if mode == MetadataModelMode.Compare {
                MetadataModelComparison.CompareAndReport(created, set)
            }
        }

        private func HasAssemblyMetadata(image[]uint8) bool {
            try {
                using let peReader = PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image))
                return peReader.HasMetadata && peReader.GetMetadataReader().IsAssembly
            } catch (ex Exception) when ex is BadImageFormatException || ex is InvalidOperationException {
                return false
            }
        }

        // The searched modules are the loaded assemblies. The other images of the resolver closure follow,
        // because the MetadataLoadContext reaches them through a type reference. Returns null when an
        // assembly has no image (a host assembly; PR 6 of ADR-0209 covers them) or an image is unreadable.
        private func TryBuildImageSet(
            loaded ImmutableArray[Assembly],
            supplier FallbackMetadataAssemblyResolver,
            resolverPaths List[string]
        ) ReferenceImageSet? {
            let images = ImmutableArray.CreateBuilder[ReferenceImage]()
            let seen = HashSet[object](ReferenceEqualityComparer.Instance)
            for asm in loaded {
                if !AssemblyImages.TryGetValue(asm, out var image) {
                    return nil
                }
                seen.Add(image)
                images.Add(
                    ReferenceImage(
                        image,
                        if TryGetAssemblyPath(asm, out var path) {
                            path
                        } else {
                            nil
                        },
                        true
                    )
                )
            }
            for path in resolverPaths {
                let image = supplier.GetImageFromPath(path)
                // The context loads a dependency only when a signature needs it, and skips an unreadable one.
                // The set skips it at construction, so one bad dependency does not hide the others.
                if image != nil && seen.Add(image) && HasAssemblyMetadata(image) {
                    images.Add(ReferenceImage(image, path, false))
                }
            }
            try {
                return ReferenceImageSet(images.ToImmutable())
            } catch (ex Exception) when ex is BadImageFormatException || ex is InvalidOperationException {
                return nil
            }
        }

        internal func FindBundledExtensionPath(baseDirectory string) string? {
            // Compiler cannot ProjectReference Gsharp.Extensions because its bootstrap
            // build already references Compiler; solution and SDK layouts provide it.
            return FindBundledRuntimePath(baseDirectory, "Gsharp.Extensions.dll", "Gsharp.Extensions", "extensions")
        }

        internal func FindBundledChannelsRuntimePath(baseDirectory string) string? {
            // ADR-0174 D1. The compiler core deliberately takes no ProjectReference
            // on the channel runtime (emitted programs bind whichever runtime is in
            // the reference set); gsc/gsi ship it beside themselves, the solution
            // layout has it under out/bin/<Config>/Gsharp.Runtime.Channels/, and
            // the SDK NuGet under tools/channels/.
            return FindBundledRuntimePath(
                baseDirectory,
                "Gsharp.Runtime.Channels.dll",
                "Gsharp.Runtime.Channels",
                "channels"
            )
        }

        internal func FindBundledValuesRuntimePath(baseDirectory string) string? -> FindBundledRuntimePath(
            baseDirectory,
            "Gsharp.Runtime.Values.dll",
            "Gsharp.Runtime.Values",
            "values"
        )

        private func AppendBundledPath(paths List[string], bundledPath string?) {
            if bundledPath == nil {
                return
            }
            for path in paths {
                if string.Equals(Path.GetFullPath(path), bundledPath, StringComparison.OrdinalIgnoreCase) {
                    return
                }
                if Path.GetFileName(bundledPath) == "Gsharp.Runtime.Values.dll" && File.Exists(path) &&
                    AssemblyName
                    .GetAssemblyName(path).Name == NativeSliceTypes.AssemblyName {
                    return
                }
            }
            paths.Add(bundledPath)
        }

        private func FindBundledRuntimePath(
            baseDirectory string,
            fileName string,
            projectFolder string,
            sdkFolder string
        ) string? {
            // ADR-0207: the SDK tools directory comes first. Its files are the portable
            // copies. A candidate that is not portable IL is skipped, so an R2R image of a
            // runtime assembly never reaches user output.
            let candidates = List[string]()
            let sdkToolsDirectory = SdkToolsDirectory ?? Environment.GetEnvironmentVariable("GSHARP_SDK_TOOLS_DIR")
            if !string.IsNullOrEmpty(sdkToolsDirectory) {
                candidates.Add(Path.Combine(sdkToolsDirectory, sdkFolder, fileName))
            }
            candidates.Add(Path.Combine(baseDirectory, fileName))
            candidates.Add(Path.Combine(baseDirectory, "..", projectFolder, fileName))
            candidates.Add(Path.Combine(baseDirectory, "..", sdkFolder, fileName))
            return candidates.Select(Path.GetFullPath).FirstOrDefault(IsPortableBundledFile)
        }

        private func IsPortableBundledFile(path string) bool {
            if !File.Exists(path) {
                return false
            }
            try {
                using let stream = File.OpenRead(path)
                let headers = PEHeaders(stream)
                // 0x14C is the machine of a portable IL assembly. ReadyToRun images
                // carry another value (the architecture XOR an OS tag).
                return headers.CoffHeader.Machine == Machine.I386
            } catch (IOException) {
                return false
            } catch (BadImageFormatException) {
                // A file that is not a PE image is not a ReadyToRun image either. The caller
                // reports it when it loads the file.
                return true
            }
        }

        private func BuildEmittedTypeNameIndex(rawNames IEnumerable[string]) Dictionary[string, string] {
            let names = rawNames.ToArray()
            let scopes = BuildTypeNameScopes(names)
            let index = Dictionary[string, string](StringComparer.Ordinal)
            for candidate in names {
                let canonical = CanonicalTypeName(candidate, scopes)
                index.TryAdd(canonical, candidate)
                index.TryAdd(canonical.Replace('+', '.'), candidate)
            }
            return index
        }

        private func BuildTypeNameScopes(rawNames IEnumerable[string]) Dictionary[string, HashSet[string]] {
            let scopes = Dictionary[string, HashSet[string]](StringComparer.Ordinal)
            let Add = func ($scope string, name string) {
                if !scopes.TryGetValue($scope, out var names) {
                    names = HashSet[string](StringComparer.Ordinal)
                    scopes[$scope] = names
                }
                names.Add(name)
            }
            for fullName in rawNames {
                SplitRawTypeName(fullName, out var namespaceParts, out var typeParts)
                var parent = "namespace:"
                for part in namespaceParts {
                    Add(parent, StripArity(part))
                    parent += "." + part
                }
                parent = "type:" + string.Join(".", namespaceParts)
                for part in typeParts {
                    Add(parent, StripArity(part))
                    parent += "+" + part
                }
            }
            return scopes
        }

        private func CanonicalTypeName(rawName string, scopes IReadOnlyDictionary[string, HashSet[string]]) string {
            SplitRawTypeName(rawName, out var namespaceParts, out var typeParts)
            let canonicalNamespace = List[string](namespaceParts.Length)
            var parent = "namespace:"
            for part in namespaceParts {
                let sourceName = StripArity(part)
                scopes.TryGetValue(parent, out var siblingNames)
                canonicalNamespace.Add(
                    SyntaxFacts.GetEmittedIdentifier(sourceName, IdentifierNameContext.General, siblingNames)
                )
                parent += "." + part
            }
            let canonicalTypes = List[string](typeParts.Length)
            parent = "type:" + string.Join(".", namespaceParts)
            for part in typeParts {
                let arityIndex = part.IndexOf('`')
                let sourceName = if arityIndex >= 0 {
                    part.Substring(0, arityIndex)
                } else {
                    part
                }
                let arity = if arityIndex >= 0 {
                    part.Substring(arityIndex)
                } else {
                    string.Empty
                }
                scopes.TryGetValue(parent, out var siblingNames)
                canonicalTypes.Add(
                    SyntaxFacts.GetEmittedIdentifier(sourceName, IdentifierNameContext.Type, siblingNames) + arity
                )
                parent += "+" + part
            }
            let typeName = string.Join("+", canonicalTypes)
            return if canonicalNamespace.Count == 0 {
                typeName
            } else {
                string.Join(".", canonicalNamespace) + "." + typeName
            }
        }

        private func SplitRawTypeName(fullName string, out namespaceParts[]string, out typeParts[]string) {
            let nestedIndex = fullName.IndexOf('+')
            let topLevel = if nestedIndex >= 0 {
                fullName.Substring(0, nestedIndex)
            } else {
                fullName
            }
            let namespaceEnd = topLevel.LastIndexOf('.')
            namespaceParts = if namespaceEnd >= 0 {
                topLevel.Substring(0, namespaceEnd).Split('.')
            } else {
                Array.Empty[string]()
            }
            let topType = if namespaceEnd >= 0 {
                topLevel.Substring(namespaceEnd + 1)
            } else {
                topLevel
            }
            let nestedTypes = if nestedIndex >= 0 {
                fullName.Substring(nestedIndex + 1)
            } else {
                string.Empty
            }
            typeParts = if string.IsNullOrEmpty(nestedTypes) {
                []string{topType}
            } else {
                []string{topType}.Concat(nestedTypes.Split('+')).ToArray()
            }
        }

        private func StripArity(name string) string {
            let arityIndex = name.IndexOf('`')
            return if arityIndex >= 0 {
                name.Substring(0, arityIndex)
            } else {
                name
            }
        }

        // ADR-0107: materialise the CLR Type for a name the warm index claims is
        // resolvable. Prefer the recorded declaring assembly; if that assembly cannot
        // satisfy GetType (e.g. a stale/edge forwarder), fall back to an in-order scan
        // of every assembly so resolution still finds the first declarer — exactly the
        // precedence the type-name index encodes. Returns false only if no assembly can
        // produce the type, in which case the caller records a (conservative) miss.
        private func SafeGetType(assembly Assembly, fullName string) Type? {
            try {
                return assembly.GetType(fullName)
            } catch (FileNotFoundException) {
                return nil
            } catch (BadImageFormatException) {
                return nil
            } catch (TypeLoadException) {
                return nil
            }
        }

        private func CreateTypeNameIndex(assemblies ImmutableArray[Assembly]) Lazy[ReferenceTypeNameIndex] -> Lazy[
            ReferenceTypeNameIndex
        ](() -> BuildTypeNameIndex(assemblies), LazyThreadSafetyMode.ExecutionAndPublication)

        private func GetDefaultTypeNameIndex(assemblies ImmutableArray[Assembly]) Lazy[ReferenceTypeNameIndex] {
            lock DefaultTypeNameIndexGate {
                if defaultTypeNameIndex == nil || !defaultTypeNameIndexAssemblies.SequenceEqual(assemblies) {
                    defaultTypeNameIndexAssemblies = assemblies
                    defaultTypeNameIndex = CreateTypeNameIndex(assemblies)
                }
                return defaultTypeNameIndex!!
            }
        }

        // Issue #854: build the full-name -> declaring-assembly-index map for TryResolveType.
        // Visit the assemblies in `assemblies` order. The first assembly that declares a name wins.
        // The names come from the metadata tables. No Type is created here.
        private func BuildTypeNameIndex(assemblies ImmutableArray[Assembly]) ReferenceTypeNameIndex {
            using let measurement = CompilationMeasurements.BeginPhase("references.type-name-index")
            let index = Dictionary[string, int32](StringComparer.Ordinal)
            let loadedTypes = Dictionary[string, Type](StringComparer.Ordinal)
            let namesByAssembly = ReadTypeNames(assemblies)
            for var i = 0; i < assemblies.Length; i++ {
                let names = namesByAssembly[i].Defined
                let types = namesByAssembly[i].Types
                for var n = 0; n < names.Count; n++ {
                    if index.TryAdd(names[n], i) && types.Count > 0 {
                        loadedTypes[names[n]] = types[n]
                    }
                }
            }
            return ReferenceTypeNameIndex(index, loadedTypes)
        }

        // Gives the type names of each assembly, in the order that reflection reports them.
        // BuildTypeNameIndex and ExportMetadataIndex both use it, so the computed index
        // and the persisted index have the same names.
        // An assembly with an image is read from its metadata tables.
        // Any other assembly (a host runtime assembly) is read through reflection.
        // Its Types then hold the Type of each name.
        // Each forwarded name follows the defined names, as reflection reports it.
        private func ReadTypeNames(assemblies ImmutableArray[Assembly]) List[AssemblyTypeNames] {
            let result = List[AssemblyTypeNames](assemblies.Length)
            let bySimpleName = Dictionary[string, AssemblyTypeNames](StringComparer.OrdinalIgnoreCase)
            for asm in assemblies {
                let names = ReadAssemblyTypeNames(asm)
                result.Add(names)
                bySimpleName.TryAdd(asm.GetName().Name ?? string.Empty, names)
            }
            let visiting = HashSet[string](StringComparer.Ordinal)
            let added = List[string]()
            for var i = 0; i < result.Count; i++ {
                let names = result[i]
                added.Clear()
                var exact = true
                for forward in names.Forwarded {
                    visiting.Clear()
                    let declaring = FindDeclaringAssembly(
                        forward.Key,
                        forward.Value,
                        names.ImageOf,
                        bySimpleName,
                        visiting,
                        out var unverifiable
                    )
                    if unverifiable {
                        exact = false
                        break
                    }
                    if declaring != nil {
                        // Reflection reports the type, then its public nested types
                        // as the declaring assembly lists them.
                        AddWithPublicNestedTypes(declaring, forward.Key, added)
                    }
                }
                if exact {
                    names.Defined.AddRange(added)
                } else {
                    // The reader cannot answer exactly for this forward. Never keep a
                    // partial answer: read the whole assembly through reflection.
                    let reflected = ReadThroughReflection(assemblies[i])
                    result[i] = reflected
                    if bySimpleName.TryGetValue(assemblies[i].GetName().Name ?? string.Empty, out var current) &&
                        object.ReferenceEquals(current, names) {
                        bySimpleName[assemblies[i].GetName().Name ?? string.Empty] = reflected
                    }
                }
            }
            return result
        }

        private func AddWithPublicNestedTypes(declaring AssemblyTypeNames, name string, destination List[string]) {
            destination.Add(name)
            if declaring.PublicNested.TryGetValue(name, out var children) {
                for child in children {
                    AddWithPublicNestedTypes(declaring, child, destination)
                }
            }
        }

        private func ReadAssemblyTypeNames(asm Assembly) AssemblyTypeNames {
            let defined = List[string]()
            let forwarded = List[KeyValuePair[string, string]]()
            let publicNested = Dictionary[string, List[string]](StringComparer.Ordinal)
            if AssemblyImages.TryGetValue(asm, out var image) && AssemblyImageLookups.TryGetValue(
                asm,
                out var imageOf
            ) &&
                MetadataTypeNameReader
                .TryReadNames(image, defined, forwarded, publicNested) {
                return AssemblyTypeNames(defined, forwarded, List[Type](), publicNested, imageOf)
            }
            return ReadThroughReflection(asm)
        }

        private func ReadThroughReflection(asm Assembly) AssemblyTypeNames {
            let defined = List[string]()
            let forwarded = List[KeyValuePair[string, string]]()
            let publicNested = Dictionary[string, List[string]](StringComparer.Ordinal)
            let types = List[Type]()
            for t in EnumerateDefinedAndForwardedTypes(asm) {
                if t.FullName is {} fullName {
                    defined.Add(fullName)
                    types.Add(t)
                    // Build the same parent -> public nested types map that the
                    // metadata reader builds, so a forward to this assembly is
                    // followed by the same nested types on both paths.
                    if t.IsNestedPublic && t.DeclaringType?.FullName is {} outer {
                        if !publicNested.TryGetValue(outer, out var children) {
                            children = List[string]()
                            publicNested[outer] = children
                        }
                        if !children.Contains(fullName) {
                            children.Add(fullName)
                        }
                    }
                }
            }
            return AssemblyTypeNames(defined, forwarded, types, publicNested, nil)
        }

        // Reflection reports a forwarded type only when it loads.
        // The same load context must supply the target assembly.
        // The target must declare the type, or forward it to an assembly that does.
        // Returns the assembly that declares the type, or null.
        // `unverifiable` is set when the target image cannot be read here.
        // The caller then reads the forwarding assembly through reflection.
        private func FindDeclaringAssembly(
            name string,
            target string,
            imageOf Func[string, ([]uint8)?]?,
            known Dictionary[string, AssemblyTypeNames],
            visiting HashSet[string],
            out unverifiable bool
        ) AssemblyTypeNames? {
            unverifiable = false
            if !known.TryGetValue(target, out var targetNames) {
                let image = imageOf?.Invoke(target)
                if image == nil {
                    return nil
                }
                let defined = List[string]()
                let forwarded = List[KeyValuePair[string, string]]()
                let publicNested = Dictionary[string, List[string]](StringComparer.Ordinal)
                if !MetadataTypeNameReader.TryReadNames(image, defined, forwarded, publicNested) {
                    unverifiable = true
                    return nil
                }
                targetNames = AssemblyTypeNames(defined, forwarded, List[Type](), publicNested, imageOf)
                known[target] = targetNames
            }
            if targetNames.Declares(name) {
                return targetNames
            }
            if !visiting.Add(target) {
                return nil
            }
            for forward in targetNames.Forwarded {
                if string.Equals(forward.Key, name, StringComparison.Ordinal) {
                    let declaring = FindDeclaringAssembly(
                        name,
                        forward.Value,
                        targetNames.ImageOf,
                        known,
                        visiting,
                        out unverifiable
                    )
                    if declaring != nil || unverifiable {
                        return declaring
                    }
                }
            }
            return nil
        }

        // Issue #854 / ADR-0107: enumerate one assembly's defined types (top-level +
        // nested) followed by its exported type forwarders through reflection,
        // tolerating the partial results that ReflectionTypeLoadException /
        // GetForwardedTypes surface for a closure with an unresolvable member. It
        // reads the assemblies that have no image (host runtime assemblies) and is
        // the reference the metadata reader is tested against.
        private func EnumerateDefinedAndForwardedTypes(asm Assembly) sequence[Type] {
            var definedTypes[]Type?
            try {
                definedTypes = asm.GetTypes()
            } catch (ex ReflectionTypeLoadException) {
                // ex.Types carries a null entry for every type that failed to
                // load, alongside the successfully loaded ones; the null filter
                // in the loop below is precisely what strips those entries.
                definedTypes = ex.Types
            } catch (FileNotFoundException) {
                definedTypes = Array.Empty[Type]()
            } catch (BadImageFormatException) {
                definedTypes = Array.Empty[Type]()
            }
            for t in definedTypes {
                if t != nil {
                    yield t
                }
            }
            var forwardedTypes[]Type?
            try {
                forwardedTypes = asm.GetForwardedTypes()
            } catch (ex ReflectionTypeLoadException) {
                // Same rationale as the definedTypes catch above.
                forwardedTypes = ex.Types
            } catch (Exception) {
                forwardedTypes = Array.Empty[Type]()
            }
            for t in forwardedTypes {
                if t != nil {
                    yield t
                }
            }
        }

        private func RegisterAssemblyOriginalPath(assembly Assembly?, path string) {
            if assembly == nil || string.IsNullOrEmpty(path) {
                return
            }
            AssemblyOriginalPaths.AddOrUpdate(assembly, path)
        }

        /// Issue #3818: finds an assembly the default load context already holds
        /// for [`fullPath`](paramref), so a runtime reference to it reuses the
        /// host's identity instead of minting a second copy.
        /// @param fullPath The absolute reference path.
        /// @returns The already-loaded assembly, or `null`.
        private func TryReuseHostLoadedAssembly(fullPath string) Assembly? {
            for loaded in AssemblyLoadContext.Default.Assemblies {
                var location string
                try {
                    location = loaded.Location
                } catch (NotSupportedException) {
                    // Dynamic / in-memory assemblies have no location to match.
                    continue
                }
                if !string.IsNullOrEmpty(location) && string.Equals(
                    location,
                    fullPath,
                    StringComparison.OrdinalIgnoreCase
                ) {
                    return loaded
                }
            }
            return nil
        }

        private func BuildHostAssemblies() ImmutableArray[Assembly] {
            // Load resolver dependencies before taking the snapshot so the first
            // and subsequent snapshots retain AppDomain's native assembly order.
            for name in WellKnownBclAssemblyNames.Append("System.Reflection.MetadataLoadContext") {
                try {
                    let _ = Assembly.Load(AssemblyName(name))
                } catch (FileNotFoundException) { } catch (FileLoadException) { } catch (BadImageFormatException) { }
            }
            let builder = ImmutableArray.CreateBuilder[Assembly]()
            let seen = HashSet[string](StringComparer.OrdinalIgnoreCase)
            for asm in AppDomain.CurrentDomain.GetAssemblies() {
                // Collectible load contexts hold execution artifacts — in-memory
                // emitted programs and submissions (EmittedProgramHost,
                // InteractiveSessionHost, the test oracle) awaiting unload — not
                // references. Including them let a finished run's emitted types
                // shadow same-named source packages in later compilations
                // (issue #3235); driver reference contexts stay excluded as
                // before.
                if asm.IsDynamic || AssemblyLoadContext.GetLoadContext(asm) is DriverReferenceLoadContext ||
                    (AssemblyLoadContext.GetLoadContext(asm)?.IsCollectible ?? false) {
                    continue
                }
                let name = asm.GetName().FullName
                if seen.Add(name) {
                    builder.Add(asm)
                }
            }
            return builder.ToImmutable()
        }

        private func ChooseCoreAssemblyName(
            paths IReadOnlyList[string],
            resolver FallbackMetadataAssemblyResolver
        ) string? {
            // MetadataLoadContext needs a "core assembly" — the one declaring the
            // primitive types (Object, String, etc.). Most modern reference packs
            // define them in System.Runtime.dll, but netstandard2.0 defines them in
            // netstandard.dll and makes System.Runtime/mscorlib facades that forward
            // back to it. Inspect the candidates rather than guessing by filename.
            var hasMscorlib = false
            for path in paths {
                let assemblyName = resolver.GetAssemblyNameFromPath(path)
                let image = resolver.GetImageFromPath(path)
                if (
                    string.Equals(assemblyName, "System.Runtime", StringComparison.OrdinalIgnoreCase) || string.Equals(
                        assemblyName,
                        "mscorlib",
                        StringComparison.OrdinalIgnoreCase
                    ) ||
                        string.Equals(assemblyName, "netstandard", StringComparison.OrdinalIgnoreCase)
                ) &&
                    image != nil &&
                    DeclaresSystemObject(image) {
                    return assemblyName
                }
                hasMscorlib |= string.Equals(assemblyName, "mscorlib", StringComparison.OrdinalIgnoreCase)
            }
            return if hasMscorlib {
                "mscorlib"
            } else {
                default(string?)
            }
        }

        /// Issue #4924: whether the supplied references declare `System.Object` in
        /// `netstandard.dll` (netstandard2.x) or `mscorlib.dll` (.NET Framework), the
        /// same classification as (cref:TargetsDownlevelFramework). Only the supplied
        /// paths count: the host's own `mscorlib.dll` and `netstandard.dll` are facades
        /// that declare nothing.
        /// @param paths The supplied reference paths.
        /// @param resolver The selected metadata names and images.
        /// @returns `true` when the target's core library is a downlevel one.
        private func SuppliesDownlevelCoreLibrary(
            paths IReadOnlyList[string],
            resolver FallbackMetadataAssemblyResolver
        ) bool {
            for path in paths {
                let assemblyName = resolver.GetAssemblyNameFromPath(path)
                let image = resolver.GetImageFromPath(path)
                if (
                    string.Equals(assemblyName, "netstandard", StringComparison.OrdinalIgnoreCase) || string.Equals(
                        assemblyName,
                        "mscorlib",
                        StringComparison.OrdinalIgnoreCase
                    )
                ) &&
                    image != nil &&
                    DeclaresSystemObject(image) {
                    return true
                }
            }
            return false
        }

        private func DeclaresSystemObject(image[]uint8) bool {
            try {
                using let peReader = PEReader(ImmutableCollectionsMarshal.AsImmutableArray(image))
                if !peReader.HasMetadata {
                    return false
                }
                let metadata = peReader.GetMetadataReader()
                for handle in metadata.TypeDefinitions {
                    let definition = metadata.GetTypeDefinition(handle)
                    if metadata.StringComparer.Equals(definition.Namespace, "System") && metadata.StringComparer.Equals(
                        definition.Name,
                        "Object"
                    ) {
                        return true
                    }
                }
            } catch (BadImageFormatException) { }
            return false
        }

        /// Returns `true` when the assembly path looks like a
        /// .NET BCL / runtime assembly the user is likely to expect transitively
        /// when they pass a single user reference (e.g. `System.Runtime`,
        /// `System.Collections`, `Microsoft.CSharp`, `mscorlib`,
        /// `netstandard`). Non-runtime assemblies (test runners, user
        /// libraries, third-party NuGet packages already loaded into the host's
        /// AppDomain) are excluded so the user-visible reference set in
        /// (cref:WithReferences(IEnumerable{string})) stays scoped to the
        /// surface the user actually opted into.
        /// @remarks Issue #2345 follow-up: this was previously a pure filename-prefix
        /// check, and "Microsoft." is not a reserved runtime prefix — plenty of
        /// third-party NuGet packages ship under it (e.g.
        /// `Microsoft.EntityFrameworkCore.Relational`,
        /// `Microsoft.Extensions.*`, `Microsoft.Data.Sqlite`). When a
        /// caller's *only* references happened to be such packages, every one of
        /// them was misclassified as "already BCL", so
        /// (cref:WithReferences(IEnumerable{string})) skipped augmenting the
        /// user-visible reference set with the host's actual BCL assemblies. Core
        /// types like `System.Int32` were then unresolvable by name (only
        /// reachable through the (cref:MetadataLoadContext) resolver's
        /// closure, not the user-visible (cref:Assemblies) index), later
        /// surfacing as an opaque (cref:InvalidOperationException) from
        /// (cref:MapClrTypeToReferences(Type)) ("Unable to project CLR type
        /// 'System.Int32'").
        ///
        /// The unambiguous BCL/runtime prefixes (`System.*`, `mscorlib`,
        /// `netstandard`, `WindowsBase`) are reserved by the runtime and
        /// are still recognized by name alone — no third-party package may claim
        /// them. `Microsoft.*`, however, is only trusted as BCL/runtime when
        /// the assembly's on-disk path additionally confirms it comes from a
        /// shared framework or reference-pack directory (e.g.
        /// `.../shared/Microsoft.NETCore.App/<version>/Microsoft.CSharp.dll`
        /// or
        /// `.../packs/Microsoft.NETCore.App.Ref/<version>/ref/<tfm>/Microsoft.Win32.Primitives.dll`)
        /// — a layout convention of the dotnet host/SDK install contract that is
        /// stable across Windows/Linux/macOS and install locations, unlike a
        /// NuGet package's cache path (`.../packages/<id>/<version>/lib/<tfm>/...`).
        /// This preserves real framework assemblies (e.g. `Microsoft.CSharp`,
        /// `Microsoft.Win32.Primitives`, `Microsoft.VisualBasic.Core`) as
        /// BCL/runtime while excluding same-named-prefix third-party packages.
        /// @param assemblyPath Absolute path to a candidate assembly (a host TPA entry or a user-supplied
        /// reference).
        /// @returns `true` when the path's file-name simple name
        /// matches a known BCL / runtime prefix, and — for the ambiguous
        /// `Microsoft.*` prefix — the path also confirms a trusted shared
        /// framework or reference-pack location.
        private func IsBclOrRuntimeAssemblyPath(assemblyPath string) bool {
            if string.IsNullOrEmpty(assemblyPath) {
                return false
            }
            let simple = Path.GetFileNameWithoutExtension(assemblyPath)
            if string.IsNullOrEmpty(simple) {
                return false
            }
            if simple.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || simple.Equals(
                "System",
                StringComparison.OrdinalIgnoreCase
            ) ||
                simple.Equals("mscorlib", StringComparison.OrdinalIgnoreCase) || simple.Equals(
                "netstandard",
                StringComparison.OrdinalIgnoreCase
            ) ||
                simple.Equals("WindowsBase", StringComparison.OrdinalIgnoreCase) {
                return true
            }
            return simple.StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase) &&
                IsUnderSharedFrameworkOrReferencePackDirectory(assemblyPath)
        }

        /// Issue #2345 follow-up: reports whether [`assemblyPath`](paramref)
        /// physically resides under a dotnet shared-framework directory (e.g.
        /// `dotnet/shared/Microsoft.NETCore.App/<version>/...`) or a
        /// reference-pack directory (e.g.
        /// `dotnet/packs/Microsoft.NETCore.App.Ref/<version>/ref/<tfm>/...`).
        /// Both are well-known, install-location-independent segments of the
        /// dotnet SDK/runtime layout contract (present verbatim on Windows, Linux,
        /// and macOS regardless of where `DOTNET_ROOT` points), so matching a
        /// literal `shared` or `packs` path *segment* — rather than
        /// searching for a specific root — reliably distinguishes genuine
        /// framework/runtime assemblies from same-named third-party NuGet
        /// packages, whose cache layout (`packages/<id>/<version>/lib/<tfm>/...`)
        /// never contains either segment.
        /// @param assemblyPath Absolute or relative path to the candidate assembly.
        /// @returns `true` when a `shared` or `packs` path segment is present.
        private func IsUnderSharedFrameworkOrReferencePackDirectory(assemblyPath string) bool {
            var fullPath string
            try {
                fullPath = Path.GetFullPath(assemblyPath)
            } catch (ArgumentException) {
                return false
            } catch (NotSupportedException) {
                return false
            } catch (PathTooLongException) {
                return false
            }
            let normalized = fullPath.Replace('\\', '/')
            for segment in normalized.Split('/', StringSplitOptions.RemoveEmptyEntries) {
                if segment.Equals("shared", StringComparison.OrdinalIgnoreCase) || segment.Equals(
                    "packs",
                    StringComparison.OrdinalIgnoreCase
                ) {
                    return true
                }
            }
            return false
        }

        private func GetHostTrustedPlatformAssemblies() IReadOnlyList[string] {
            let tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Array.Empty[string]()
            }
            let paths = List[string]()
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    paths.Add(path)
                }
            }
            return paths
        }

        /// Whether [`mlc`](paramref) has already loaded an assembly with the simple name
        /// [`simpleName`](paramref).
        private func IsLoadedBySimpleName(mlc MetadataLoadContext, simpleName string) bool {
            for loaded in mlc.GetAssemblies() {
                if string.Equals(loaded.GetName().Name, simpleName, StringComparison.OrdinalIgnoreCase) {
                    return true
                }
            }
            return false
        }

        /// Eagerly verifies that the supplied reference set forms a complete
        /// transitive closure. For every primary reference, each required assembly it names
        /// (one hop) is probed against the load context's resolver; any name that
        /// neither the supplied set nor the gsc host runtime can satisfy is
        /// reported as missing. This converts a latent
        /// (cref:FileNotFoundException)/(cref:TypeLoadException) that
        /// would otherwise surface deep in member enumeration into an actionable,
        /// up-front signal (issue #340).
        private func ComputeMissingTransitiveReferences(
            loaded ImmutableArray[Assembly],
            mlc MetadataLoadContext,
            resolver FallbackMetadataAssemblyResolver
        ) ImmutableArray[string] {
            let missing = SortedSet[string](StringComparer.OrdinalIgnoreCase)
            for asm in loaded {
                var referenced[]AssemblyName
                try {
                    referenced = asm.GetReferencedAssemblies()
                } catch (Exception) {
                    // A malformed reference table must not abort closure analysis.
                    continue
                }
                let forwarderOnly = ForwarderOnlyAssemblyReferences(asm)
                for refName in referenced {
                    if string.IsNullOrEmpty(refName?.Name) || forwarderOnly.Contains(refName.Name!!) {
                        continue
                    }
                    // The context raises (cref:FileNotFoundException) for a name that neither
                    // the resolver nor an already loaded assembly can supply. Answer that
                    // case from the resolver without paying for the throw: the resolver
                    // would record the name and return null, and the catch below would add
                    // it to the missing set.
                    if !resolver.HasImage(refName.Name!!) && !IsLoadedBySimpleName(mlc, refName.Name!!) {
                        resolver.RecordUnresolved(refName.Name!!)
                        missing.Add(refName.Name!!)
                        continue
                    }
                    try {
                        // LoadFromAssemblyName forces the resolver to locate the
                        // dependency. Success means it is in the closure; a load
                        // failure means it is genuinely missing.
                        let dependency Assembly? = mlc.LoadFromAssemblyName(refName)
                        if dependency == nil {
                            missing.Add(refName.Name!!)
                        }
                    } catch (ex Exception) when ex is FileNotFoundException ||
                        ex is FileLoadException ||
                        ex is BadImageFormatException ||
                        ex is TypeLoadException {
                        missing.Add(refName.Name!!)
                    }
                }
            }
            // Fold in any names the resolver itself failed to satisfy while loading
            // the primaries (e.g. a primary's core-assembly dependency).
            for name in resolver.UnresolvedSimpleNames {
                missing.Add(name)
            }
            return if missing.Count == 0 {
                ImmutableArray[string].Empty
            } else {
                missing.ToImmutableArray()
            }
        }

        private func ForwarderOnlyAssemblyReferences(assembly Assembly) HashSet[string] {
            let names = HashSet[string](StringComparer.OrdinalIgnoreCase)
            using let image = OpenAssemblyImage(assembly)
            if image == nil {
                return names
            }
            using let pe = PEReader(image)
            let reader = pe.GetMetadataReader()
            for handle in reader.ExportedTypes {
                let exported = reader.GetExportedType(handle)
                if exported.IsForwarder && exported.Implementation.Kind == HandleKind.AssemblyReference {
                    let reference = reader.GetAssemblyReference(cast[AssemblyReferenceHandle](exported.Implementation))
                    names.Add(reader.GetString(reference.Name))
                }
            }
            // A facade can advertise optional packages without depending on their types.
            // A TypeRef to the same assembly makes it a real metadata dependency.
            for handle in reader.TypeReferences {
                let reference = reader.GetTypeReference(handle)
                if reference.ResolutionScope.Kind == HandleKind.AssemblyReference {
                    let assemblyReference = reader.GetAssemblyReference(
                        cast[AssemblyReferenceHandle](reference.ResolutionScope)
                    )
                    names.Remove(reader.GetString(assemblyReference.Name))
                }
            }
            return names
        }
    }
}

/// Per-reference metadata record used to emit a
/// `CompilationMetadataReferences` `CustomDebugInformation` blob
/// per the Portable PDB spec § "CompilationMetadataReferences".
struct ReferenceInfo {
    /// Initializes a new instance of the (cref:ReferenceInfo) struct.
    /// @param fileName File name (no directory) of the reference PE, e.g. `System.Console.dll`.
    /// @param aliases Comma-separated extern alias list; empty string when there are no aliases.
    /// @param flags Flags byte: bit 0 = EmbedInteropTypes; bit 1 = MetadataImageKind.Assembly.
    /// @param timeStamp PE COFF header `TimeDateStamp` of the reference file.
    /// @param fileSize Length of the reference file in bytes.
    /// @param mvid Module version id read from the reference's PE metadata.
    init(fileName string, aliases string, flags uint8, timeStamp uint32, fileSize uint32, mvid Guid) {
        FileName = fileName
        Aliases = aliases
        Flags = flags
        TimeStamp = timeStamp
        FileSize = fileSize
        Mvid = mvid
    }

    /// Gets the file name (no directory) of the reference PE, e.g.
    /// `System.Console.dll`.
    prop FileName string {
        get;
    }

    /// Gets the comma-separated extern alias list. Empty string for the
    /// common case of no aliases.
    prop Aliases string {
        get;
    }

    /// Gets the flags byte.
    /// Bit 0 = EmbedInteropTypes; bit 1 = MetadataImageKind.Assembly.
    prop Flags uint8 {
        get;
    }

    /// Gets the PE COFF header `TimeDateStamp` of the reference file.
    prop TimeStamp uint32 {
        get;
    }

    /// Gets the length of the reference file in bytes.
    prop FileSize uint32 {
        get;
    }

    /// Gets the module version id (MVID) read from the reference's PE metadata.
    prop Mvid Guid {
        get;
    }
}
