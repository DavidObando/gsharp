// <copyright file="Issue4921HostFallbackEmbeddableAttributeTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #4921: an assembly compiled for `netstandard2.0` must not
/// reference `System.Private.CoreLib`.
///
/// `ReferenceResolver.WithReferences` appends the host runtime assemblies as a
/// transitive-dependency fallback. The `netstandard.dll` contract publishes no
/// `NullableAttribute`/`NullableContextAttribute`, so the embeddable-attribute
/// lookup fell through to the host's `System.Private.CoreLib` (where they are
/// public) and scoped the emitted TypeRefs there. .NET Framework (Visual Studio
/// MSBuild) has no such assembly, so the SDK task assembly built by gsc failed
/// to load. The decision is made once, in
/// `WellKnownReferences.TryResolveEmbeddableAttribute`.
open class Issue4921HostFallbackEmbeddableAttributeTests {
    /// Reference set is `netstandard.dll` alone, so the only declaration of the
    /// attributes the resolver can reach is the host fallback's. Before the fix the
    /// output had an AssemblyRef and TypeRefs scoped to `System.Private.CoreLib`.
    @Fact
    func NetStandardLibrary_DoesNotReferenceHostCoreLib() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(
            netstandard != nil,
            "could not locate a netstandard.dll reference assembly (NETStandard.Library.Ref pack); this " +
                "regression test must not be skipped silently."
        )
        let tempDir = Directory.CreateTempSubdirectory("gs_4921_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!)
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let assemblyRefs = reader
                .AssemblyReferences
                .Select((h AssemblyReferenceHandle) -> reader.GetString(reader.GetAssemblyReference(h).Name))
                .ToArray()
            // Anti-vacuity: the library really did bind against netstandard.
            Assert.Contains("netstandard", assemblyRefs)
            Assert.DoesNotContain("System.Private.CoreLib", assemblyRefs)
            for handle in reader.TypeReferences {
                let typeReference = reader.GetTypeReference(handle)
                if typeReference.ResolutionScope.Kind != HandleKind.AssemblyReference {
                    continue
                }
                let refScope = reader.GetString(
                    reader.GetAssemblyReference(AssemblyReferenceHandle(typeReference.ResolutionScope)).Name
                )
                Assert.NotEqual("System.Private.CoreLib", refScope)
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const LibrarySource string = `
package Lib

class Holder {
    var name string?
    func Get(input string?) string? -> input
}
`

        // <dotnet-root>/packs/NETStandard.Library.Ref/<version>/ref/<tfm>/netstandard.dll
        private func FindNetStandardReference() string? {
            var dotnetRoot string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            while dotnetRoot != nil && !Directory.Exists(Path.Combine(dotnetRoot, "packs")) {
                dotnetRoot = Path.GetDirectoryName(dotnetRoot)
            }
            if dotnetRoot == nil {
                return nil
            }
            let packRoot = Path.Combine(dotnetRoot, "packs", "NETStandard.Library.Ref")
            if !Directory.Exists(packRoot) {
                return nil
            }
            return Directory
                .GetFiles(packRoot, "netstandard.dll", SearchOption.AllDirectories)
                .OrderByDescending((p string) -> p, StringComparer.Ordinal)
                .FirstOrDefault()
        }

        private func CompileOrThrow(name string, source string, outPath string, tempDir string, reference string) {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            File.WriteAllText(srcPath, source)
            let args = []string{
                "/out:" + outPath,
                "/target:library",
                "/targetframework:netstandard2.0",
                "/reference:" + reference,
                srcPath
            }
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, "gsc failed compiling '$name':\nstdout:\n$compileOut\nstderr:\n$compileErr")
        }
    }
}
