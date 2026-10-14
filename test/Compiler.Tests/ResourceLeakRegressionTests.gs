// <copyright file="ResourceLeakRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// Regression guard for the OOM / fd-exhaustion bug that manifested when the
/// full Compiler.Tests suite ran in a single host process. The root cause was
/// (cref:GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver) not disposing
/// its `MetadataLoadContext`, which leaked ~200 file handles per
/// compilation that used `/reference:` switches.
///
/// This test compiles multiple programs with explicit references in a tight
/// loop and asserts that process memory and handle counts stay bounded.
open class ResourceLeakRegressionTests {
    /// Compiles 20 programs using explicit /reference: paths (triggering
    /// MetadataLoadContext creation) and verifies that memory does not grow
    /// unboundedly. Before the fix, each compilation leaked ~5-50 MB via
    /// undisposed MetadataLoadContext; after the fix, GC.GetTotalMemory
    /// stays roughly flat because the MLC file mappings are released on
    /// each Program.Main return.
    @Fact
    func RepeatedCompilationsWithReferences_DoNotLeakMemory() {
        const iterations = 20
        const source = `package P

func Main() {
}`
        let references = TrustedPlatformAssemblies().Take(30).ToList()
        if references.Count == 0 {
            // If we can't locate platform assemblies, skip gracefully.
            return
        }
        // Warm up: run one compilation so JIT / static init costs don't skew.
        RunCompilation(source, references)
        // Force a full GC to establish a clean baseline.
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
        GC.WaitForPendingFinalizers()
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
        let baselineMemory = GC.GetTotalMemory(forceFullCollection: true)
        for var i = 0; i < iterations; i++ {
            RunCompilation(source, references)
        }
        // After all compilations, force GC and measure.
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
        GC.WaitForPendingFinalizers()
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
        let finalMemory = GC.GetTotalMemory(forceFullCollection: true)
        let growth = finalMemory - baselineMemory
        // Allow up to 50 MB of growth (generous margin for test framework
        // overhead, string allocations, etc.). Before the fix, growth was
        // typically 200-500+ MB over 20 iterations due to leaked MLCs.
        const maxAllowedGrowthBytes int64 = 50 * 1024 * 1024
        Assert.True(
            growth < maxAllowedGrowthBytes,
            "Memory grew by ${growth / int64((1024 * 1024))} MB over $iterations compilations " +
                "with /reference: (baseline=${baselineMemory / int64((1024 * 1024))} MB, " +
                "final=${finalMemory / int64((1024 * 1024))} MB). " +
                "This suggests MetadataLoadContext instances are not being disposed."
        )
    }

    @Fact
    func MetadataLoadContextCaches_DoNotKeepResolverAliveAfterDispose() {
        let references = TrustedPlatformAssemblies().ToList()
        if references.Count == 0 {
            return
        }
        let (contextRef, assemblyRef, typeRef) = CreateCachedMetadataWeakReferences(references)
        AssertCollected(contextRef, "MetadataLoadContext")
        AssertCollected(assemblyRef, "reflected assembly")
        AssertCollected(typeRef, "reflected type")
    }

    shared {
        @MethodImpl(MethodImplOptions.NoInlining)
        private func CreateCachedMetadataWeakReferences(references List[string])(
            Context WeakReference,
            Assembly WeakReference,
            Type WeakReference
        ) {
            var contextRef WeakReference
            var assemblyRef WeakReference
            var typeRef WeakReference
            {
                using let resolver = ReferenceResolver.WithReferences(references)
                Assert.True(resolver.TryResolveType("System.Text.StringBuilder", out var type))
                let context object? = typeof(ReferenceResolver).GetField(
                    "metadataContext",
                    BindingFlags.Instance | BindingFlags.NonPublic
                )
                    ?.GetValue(resolver)
                Assert.NotNull(context)
                let _ = ImportedTypeSymbol.Get(type)
                let _ = InvokeClrInterfacesCache(type)
                let _ = InvokeMemberLookupCache(type)
                contextRef = WeakReference(context)
                assemblyRef = WeakReference(type.Assembly)
                typeRef = WeakReference(type)
            }
            return (contextRef, assemblyRef, typeRef)
        }

        private func InvokeMemberLookupCache(type Type?) object? {
            let memberLookup Type? = typeof(ReferenceResolver).Assembly.GetType(
                "GSharp.Core.CodeAnalysis.Binding.MemberLookup"
            )
            // Issue #3679 added an `includeInternal` overload, so the probe must
            // name the parameter types instead of matching on the name alone.
            let method MethodInfo? = memberLookup?.GetMethod(
                "SafeGetMethodsIncludingSelfAndInterfaces",
                BindingFlags.Public | BindingFlags.Static,
                binder: nil,
                []Type{typeof(Type), typeof(string)},
                modifiers: nil
            )
            // A renamed or re-signatured member must fail here, not skip priming
            // the cache this leak test exists to cover (it would pass vacuously).
            Assert.NotNull(method)
            return method!!.Invoke(nil, []object{type!!, "ToString"})
        }

        private func InvokeClrInterfacesCache(type Type?) object? {
            let method MethodInfo? = typeof(ClrTypeUtilities).GetMethod(
                "SafeGetInterfaces",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            // As above: a missing member must fail, not silently skip the cache.
            Assert.NotNull(method)
            return method!!.Invoke(nil, []object{type!!})
        }

        private func AssertCollected(weakReference WeakReference, name string) {
            for var i = 0; i < 5 && weakReference.IsAlive; i++ {
                GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
                GC.WaitForPendingFinalizers()
                GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true)
            }
            Assert.False(weakReference.IsAlive, "$name should be collectable after ReferenceResolver.Dispose().")
        }

        private func RunCompilation(source string, references List[string]) {
            let tempDir = CreateTestDirectory("gs_leak_test_")
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for r in references {
                    args.Add("/reference:" + r)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                try {
                    let exit = Program.Main(args.ToArray())
                    Assert.True(exit == 0, "compile failed: $compileOut$compileErr")
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CreateTestDirectory(prefix string) string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
