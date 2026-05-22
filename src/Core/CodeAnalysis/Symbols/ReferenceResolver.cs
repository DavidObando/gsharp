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
/// This is the seam that <c>import</c> statements use to find CLR types. The
/// default resolver covers the BCL by snapshotting the loaded runtime
/// assemblies plus seeding a handful of well-known ones (<c>mscorlib</c>,
/// <c>System.Runtime</c>, <c>System.Console</c>). Callers can extend the set
/// by passing assembly paths to <see cref="WithReferences"/>; these are
/// loaded with <see cref="Assembly.LoadFrom(string)"/> so the resulting
/// <see cref="Type"/> instances are usable by the
/// <c>ReflectionMetadataEmitter</c> alongside the BCL types.
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

    private ReferenceResolver(ImmutableArray<Assembly> assemblies)
    {
        this.assemblies = assemblies;
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
        return new ReferenceResolver(BuildDefaultAssemblies(Array.Empty<string>()));
    }

    /// <summary>
    /// Gets a resolver that searches the runtime's loaded assemblies plus
    /// any additional assemblies referenced by file path.
    /// </summary>
    /// <param name="referencePaths">Paths to additional assemblies to load.</param>
    /// <returns>A resolver including the supplied references.</returns>
    public static ReferenceResolver WithReferences(IEnumerable<string> referencePaths)
    {
        if (referencePaths is null)
        {
            return Default();
        }

        return new ReferenceResolver(BuildDefaultAssemblies(referencePaths));
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

    private static ImmutableArray<Assembly> BuildDefaultAssemblies(IEnumerable<string> referencePaths)
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

        foreach (var path in referencePaths)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                continue;
            }

            try
            {
                var asm = Assembly.LoadFrom(path);
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
}
