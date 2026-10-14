// <copyright file="ReferenceResolverTransitiveClosureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Tests for issue #340: when the supplied `/r:` reference set is missing a
/// transitive dependency of a referenced assembly, the
/// (cref:ReferenceResolver) must degrade gracefully — never throwing an
/// unhandled exception out of construction or member enumeration — and surface
/// the missing assembly so a diagnostic can be emitted.
open class ReferenceResolverTransitiveClosureTests : IDisposable {
    private let scratchDir string

    /// Initializes a new instance of the
    /// (cref:ReferenceResolverTransitiveClosureTests) class, creating an
    /// isolated scratch directory next to the test binaries to hold the two
    /// synthesized assemblies.
    init() {
        scratchDir = Path.Combine(AppContext.BaseDirectory, "gs340-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(scratchDir)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            if Directory.Exists(scratchDir) {
                Directory.Delete(scratchDir, recursive: true)
            }
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
        GC.SuppressFinalize(this)
    }

    @Fact
    func WithReferences_MissingTransitiveDependency_DoesNotThrow_AndIsReported() {
        let (libPath, _) = BuildLibraryWithMissingDependency()
        // Supplying only the library (and the host BCL fallback) — but NOT the
        // dependency it references — must not throw out of construction.
        let resolver = ReferenceResolver.WithReferences([]string{libPath})
        // The directly referenced type still resolves from the supplied set.
        Assert.True(resolver.TryResolveType("Lib.Widget", out var widget))
        Assert.NotNull(widget)
        // The missing transitive dependency is reported by name so a diagnostic
        // can be raised for an under-referenced project.
        Assert.Contains("DepAsmB", resolver.MissingTransitiveReferences)
    }

    @Fact
    func OverloadResolution_SkipsMember_WhoseSignatureNeedsMissingAssembly() {
        let (libPath, _) = BuildLibraryWithMissingDependency()
        let resolver = ReferenceResolver.WithReferences([]string{libPath})
        Assert.True(resolver.TryResolveType("Lib.Widget", out var widget))
        // M(Dep.Marker) references the omitted assembly; reflecting over its
        // parameter throws a load failure. Overload resolution must treat the
        // member as simply not applicable rather than letting the exception
        // escape (issue #340 / #321 per-member tolerance).
        let candidate MethodInfo? = widget.GetMethod("M", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(candidate)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{candidate!!}, Array.Empty[Type]())
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    /// Synthesizes two assemblies on disk: `DepAsmB` defining
    /// `Dep.Marker`, and `LibAsmA` defining `Lib.Widget` with a
    /// static method `M(Dep.Marker)` so that LibAsmA carries an assembly
    /// reference to DepAsmB. Only the LibAsmA path is returned for use; the
    /// DepAsmB path is deliberately withheld from the resolver to model an
    /// incomplete transitive closure.
    private func BuildLibraryWithMissingDependency()(LibPath string, DepPath string) {
        let coreAssembly = typeof(object).Assembly
        let depName = AssemblyName("DepAsmB"){Version = Version(1, 0, 0, 0)}
        let depBuilder = PersistedAssemblyBuilder(depName, coreAssembly)
        let depModule = depBuilder.DefineDynamicModule("DepAsmB")
        let marker = depModule.DefineType("Dep.Marker", TypeAttributes.Public | TypeAttributes.Class)
        marker.CreateType()
        let depPath = Path.Combine(scratchDir, "DepAsmB.dll")
        depBuilder.Save(depPath)
        let libName = AssemblyName("LibAsmA"){Version = Version(1, 0, 0, 0)}
        let libBuilder = PersistedAssemblyBuilder(libName, coreAssembly)
        let libModule = libBuilder.DefineDynamicModule("LibAsmA")
        let widget = libModule.DefineType("Lib.Widget", TypeAttributes.Public | TypeAttributes.Class)
        let method = widget.DefineMethod(
            "M",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(Void),
            cast[[]Type]([]TypeBuilder{marker})
        )
        method.GetILGenerator().Emit(OpCodes.Ret)
        widget.CreateType()
        let libPath = Path.Combine(scratchDir, "LibAsmA.dll")
        libBuilder.Save(libPath)
        return (libPath, depPath)
    }
}
