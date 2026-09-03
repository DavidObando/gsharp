// <copyright file="EmittedFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;

namespace GSharp.Tests;

/// <summary>
/// Loads a compiler-emitted test fixture assembly for reflection and
/// in-process invocation without making it ambient to later compilations
/// (issue #3828).
/// </summary>
/// <remarks>
/// <para><b>Why this exists.</b> Emit tests run gsc in-process
/// (<c>Program.Main</c>) and then load the produced PE so they can invoke it.
/// The historical pattern — <c>Assembly.Load(bytes)</c> or
/// <c>Assembly.LoadFrom(path)</c> — puts every fixture into the default,
/// non-collectible load context, permanently.
/// <c>ReferenceResolver.BuildHostAssemblies</c> enumerates
/// <c>AppDomain.CurrentDomain.GetAssemblies()</c> and excludes only dynamic
/// and <em>collectible</em> contexts (issue #3235), so every fixture already
/// loaded that way is offered to every later in-process compile as a
/// reference. A later fixture declaring the same package as an earlier one
/// then binds the earlier fixture's types and the compile fails inside gsc —
/// the observed <c>GS0156: Cannot convert type 'P.Color' to 'Color'</c>. The
/// symptom is order-dependent because it needs the colliding fixture to have
/// been loaded first, and xUnit's class order varies per process.</para>
/// <para><b>What this does.</b> Each fixture is loaded into its own
/// collectible <see cref="AssemblyLoadContext"/>, which
/// <c>BuildHostAssemblies</c> already excludes, so the fixture simply stops
/// being ambient. Unique per-test package or assembly names would only make
/// the collision rarer; they would not close the gap, because the leak — not
/// the name — is the defect.</para>
/// <para><b>Dependency resolution.</b> The fixture's context prefers the
/// host's identity for anything the default context can supply (the
/// framework, <c>Gsharp.Extensions</c>, the test assembly, and any reference
/// assembly the test itself loaded), so types shared with the test still
/// compare equal. Only what the default context cannot supply is probed for
/// beside the fixture and loaded privately.</para>
/// <para><b>Lifetime.</b> The context is collectible but is deliberately not
/// unloaded: emit tests hold types, delegates, and running state from the
/// fixture for the rest of the test, and some invoke asynchronous code whose
/// completion outlives the call. Nothing is reclaimed earlier than it was
/// before this helper existed; the change is which context the fixture lives
/// in, not how long it lives.</para>
/// </remarks>
public static class EmittedFixture
{
    /// <summary>
    /// Loads the emitted assembly at <paramref name="assemblyPath"/> into a
    /// fresh collectible context that probes the assembly's own directory for
    /// dependencies the host cannot supply.
    /// </summary>
    /// <param name="assemblyPath">Path to the emitted assembly.</param>
    /// <returns>The loaded assembly.</returns>
    public static Assembly Load(string assemblyPath)
    {
        if (assemblyPath is null)
        {
            throw new ArgumentNullException(nameof(assemblyPath));
        }

        var fullPath = Path.GetFullPath(assemblyPath);
        var context = CreateContext(Path.GetDirectoryName(fullPath));

        // Load from bytes so the file stays deletable — emit tests routinely
        // clean up their temp directory while still asserting on the assembly.
        return context.LoadFromStream(new MemoryStream(File.ReadAllBytes(fullPath)));
    }

    /// <summary>
    /// Loads an emitted assembly image into a fresh collectible context.
    /// </summary>
    /// <param name="rawAssembly">The emitted PE image.</param>
    /// <param name="probeDirectory">Directory to probe for dependencies the host cannot supply; may be <see langword="null"/>.</param>
    /// <returns>The loaded assembly.</returns>
    public static Assembly Load(byte[] rawAssembly, string probeDirectory = null)
    {
        if (rawAssembly is null)
        {
            throw new ArgumentNullException(nameof(rawAssembly));
        }

        var context = CreateContext(probeDirectory);
        return context.LoadFromStream(new MemoryStream(rawAssembly));
    }

    /// <summary>
    /// Loads several emitted assemblies into <em>one</em> collectible context,
    /// for tests that assert across them — a type from one fixture only
    /// compares equal to the same type seen through another fixture when both
    /// were loaded into the same context.
    /// </summary>
    /// <param name="assemblyPaths">Paths to the emitted assemblies, in load order.</param>
    /// <returns>The loaded assemblies, in the same order.</returns>
    public static Assembly[] LoadTogether(params string[] assemblyPaths)
    {
        if (assemblyPaths is null)
        {
            throw new ArgumentNullException(nameof(assemblyPaths));
        }

        var probeDirectories = new List<string>();
        var fullPaths = new string[assemblyPaths.Length];
        for (var i = 0; i < assemblyPaths.Length; i++)
        {
            fullPaths[i] = Path.GetFullPath(assemblyPaths[i]);
            var directory = Path.GetDirectoryName(fullPaths[i]);
            if (directory is not null && !probeDirectories.Contains(directory))
            {
                probeDirectories.Add(directory);
            }
        }

        var context = CreateContext(probeDirectories);
        var loaded = new Assembly[fullPaths.Length];
        for (var i = 0; i < fullPaths.Length; i++)
        {
            loaded[i] = context.LoadFromStream(new MemoryStream(File.ReadAllBytes(fullPaths[i])));
        }

        return loaded;
    }

    private static AssemblyLoadContext CreateContext(string probeDirectory)
        => CreateContext(probeDirectory is null ? new List<string>() : new List<string> { probeDirectory });

    private static AssemblyLoadContext CreateContext(IReadOnlyList<string> probeDirectories)
    {
        var context = new AssemblyLoadContext(
            "gsharp-emitted-fixture-" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        context.Resolving += (resolving, name) => Resolve(resolving, name, probeDirectories);
        return context;
    }

    private static Assembly Resolve(
        AssemblyLoadContext context,
        AssemblyName assemblyName,
        IReadOnlyList<string> probeDirectories)
    {
        // The host's identity wins: the framework, Gsharp.Extensions, the
        // test assembly, and any reference assembly the test loaded itself
        // must stay one type identity across the fixture boundary, or
        // assertions comparing them silently fail.
        try
        {
            var fromHost = AssemblyLoadContext.Default.LoadFromAssemblyName(assemblyName);
            if (fromHost is not null)
            {
                return fromHost;
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

        if (assemblyName.Name is null)
        {
            return null;
        }

        foreach (var directory in probeDirectories)
        {
            var candidate = Path.Combine(directory, assemblyName.Name + ".dll");
            if (File.Exists(candidate))
            {
                return context.LoadFromStream(new MemoryStream(File.ReadAllBytes(candidate)));
            }
        }

        return null;
    }
}
