// <copyright file="ReferenceResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;

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
