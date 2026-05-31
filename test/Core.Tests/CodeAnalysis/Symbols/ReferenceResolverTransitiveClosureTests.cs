// <copyright file="ReferenceResolverTransitiveClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Tests for issue #340: when the supplied <c>/r:</c> reference set is missing a
/// transitive dependency of a referenced assembly, the
/// <see cref="ReferenceResolver"/> must degrade gracefully — never throwing an
/// unhandled exception out of construction or member enumeration — and surface
/// the missing assembly so a diagnostic can be emitted.
/// </summary>
public class ReferenceResolverTransitiveClosureTests : IDisposable
{
    private readonly string scratchDir;

    /// <summary>
    /// Initializes a new instance of the
    /// <see cref="ReferenceResolverTransitiveClosureTests"/> class, creating an
    /// isolated scratch directory next to the test binaries to hold the two
    /// synthesized assemblies.
    /// </summary>
    public ReferenceResolverTransitiveClosureTests()
    {
        scratchDir = Path.Combine(AppContext.BaseDirectory, "gs340-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratchDir);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            if (Directory.Exists(scratchDir))
            {
                Directory.Delete(scratchDir, recursive: true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void WithReferences_MissingTransitiveDependency_DoesNotThrow_AndIsReported()
    {
        var (libPath, _) = BuildLibraryWithMissingDependency();

        // Supplying only the library (and the host BCL fallback) — but NOT the
        // dependency it references — must not throw out of construction.
        var resolver = ReferenceResolver.WithReferences(new[] { libPath });

        // The directly referenced type still resolves from the supplied set.
        Assert.True(resolver.TryResolveType("Lib.Widget", out var widget));
        Assert.NotNull(widget);

        // The missing transitive dependency is reported by name so a diagnostic
        // can be raised for an under-referenced project.
        Assert.Contains("DepAsmB", resolver.MissingTransitiveReferences);
    }

    [Fact]
    public void OverloadResolution_SkipsMember_WhoseSignatureNeedsMissingAssembly()
    {
        var (libPath, _) = BuildLibraryWithMissingDependency();
        var resolver = ReferenceResolver.WithReferences(new[] { libPath });

        Assert.True(resolver.TryResolveType("Lib.Widget", out var widget));

        // M(Dep.Marker) references the omitted assembly; reflecting over its
        // parameter throws a load failure. Overload resolution must treat the
        // member as simply not applicable rather than letting the exception
        // escape (issue #340 / #321 per-member tolerance).
        var candidate = widget.GetMethod("M", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(candidate);

        var result = OverloadResolution.Resolve(new[] { candidate }, Array.Empty<Type>());
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    /// <summary>
    /// Synthesizes two assemblies on disk: <c>DepAsmB</c> defining
    /// <c>Dep.Marker</c>, and <c>LibAsmA</c> defining <c>Lib.Widget</c> with a
    /// static method <c>M(Dep.Marker)</c> so that LibAsmA carries an assembly
    /// reference to DepAsmB. Only the LibAsmA path is returned for use; the
    /// DepAsmB path is deliberately withheld from the resolver to model an
    /// incomplete transitive closure.
    /// </summary>
    private (string LibPath, string DepPath) BuildLibraryWithMissingDependency()
    {
        var coreAssembly = typeof(object).Assembly;

        var depName = new AssemblyName("DepAsmB") { Version = new Version(1, 0, 0, 0) };
        var depBuilder = new PersistedAssemblyBuilder(depName, coreAssembly);
        var depModule = depBuilder.DefineDynamicModule("DepAsmB");
        var marker = depModule.DefineType("Dep.Marker", TypeAttributes.Public | TypeAttributes.Class);
        marker.CreateType();
        var depPath = Path.Combine(scratchDir, "DepAsmB.dll");
        depBuilder.Save(depPath);

        var libName = new AssemblyName("LibAsmA") { Version = new Version(1, 0, 0, 0) };
        var libBuilder = new PersistedAssemblyBuilder(libName, coreAssembly);
        var libModule = libBuilder.DefineDynamicModule("LibAsmA");
        var widget = libModule.DefineType("Lib.Widget", TypeAttributes.Public | TypeAttributes.Class);
        var method = widget.DefineMethod(
            "M",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(void),
            new[] { marker });
        method.GetILGenerator().Emit(OpCodes.Ret);
        widget.CreateType();
        var libPath = Path.Combine(scratchDir, "LibAsmA.dll");
        libBuilder.Save(libPath);

        return (libPath, depPath);
    }
}
