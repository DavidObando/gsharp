// <copyright file="Issue4921HostFallbackEmbeddableAttributeTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
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

    /// Issue #4922: omitting the attributes (the #4921 minimal fix) would make nullability
    /// vanish from every netstandard2.0 output. The library must instead carry
    /// embedded, internal copies of the attributes, as csc emits, and its
    /// nullable members must be stamped with them. The stamp is decoded from the
    /// metadata, then the library is consumed by a net10.0 compilation, which can
    /// only reject passing the `string?` result to a non-null `string` if it reads
    /// the annotation back through the embedded attribute.
    @Fact
    func NetStandardLibrary_CarriesEmbeddedNullableAttributes_ThatRoundTrip() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4922_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!)
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let embedded = Dictionary[string, TypeDefinition]()
            for handle in reader.TypeDefinitions {
                let definition = reader.GetTypeDefinition(handle)
                embedded[reader.GetString(definition.Namespace) + "." + reader.GetString(definition.Name)] = definition
            }
            for name in[]string{
                "System.Runtime.CompilerServices.NullableAttribute",
                "System.Runtime.CompilerServices.NullableContextAttribute",
                "Microsoft.CodeAnalysis.EmbeddedAttribute"
            } {
                Assert.True(embedded.ContainsKey(name), "the library must declare an embedded " + name)
                // csc embeds the copies `internal`, never public.
                Assert.Equal(TypeAttributes.NotPublic, embedded[name].Attributes & TypeAttributes.VisibilityMask)
            }
            // The stamps bind to those in-assembly types (MethodDef constructors), not to a TypeRef.
            var nullableStamps = 0
            var contextStamps = 0
            var arrayFormStamps = 0
            var nullableValues = List[uint8]()
            for handle in reader.CustomAttributes {
                let attribute = reader.GetCustomAttribute(handle)
                if attribute.Constructor.Kind != HandleKind.MethodDefinition {
                    continue
                }
                let ctor = reader.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                let declaring = reader.GetTypeDefinition(ctor.GetDeclaringType())
                let declaringName = reader.GetString(declaring.Name)
                let blob = reader.GetBlobBytes(attribute.Value)
                if declaringName == "NullableAttribute" && blob.Length == 5 {
                    nullableStamps++
                    nullableValues.Add(blob[2])
                } else if declaringName == "NullableAttribute" {
                    // The byte[] constructor: per-position flags of a nested annotation such as `[]string?`.
                    arrayFormStamps++
                } else if declaringName == "NullableContextAttribute" {
                    contextStamps++
                }
            }
            Assert.True(nullableStamps > 0, "the nullable members must be stamped with the embedded NullableAttribute")
            Assert.True(contextStamps > 0, "the embedded NullableContextAttribute must be applied")
            Assert.True(arrayFormStamps > 0, "a nested annotation must be stamped through the byte[] constructor")
            // `string?` is flag 2 (annotated).
            Assert.True(nullableValues.Contains(2), "string? is flag 2")
            // Consume it from a modern target: reading the annotation back rejects the assignment.
            let appPath = Path.Combine(tempDir, "App.dll")
            let exit = CompileApp(tempDir, appPath, libPath, NullableMisuseSource)
            Assert.True(exit.Item1 != 0, "the consumer must see Holder.Get(...) as returning string?:\n" + exit.Item2)
            let okExit = CompileApp(tempDir, appPath, libPath, NullableOkSource)
            Assert.True(okExit.Item1 == 0, "the consumer using the annotation correctly must compile:\n" + okExit.Item2)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A netstandard2.0 library that already carries its own polyfill copies of the
    /// attributes (very common) must neither collide with an injected copy nor end up with two.
    @Fact
    func NetStandardLibraryWithItsOwnPolyfill_UsesThatCopy() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4922_poly_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!, extraSource: PolyfillSource)
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var nullableTypes = 0
            for handle in reader.TypeDefinitions {
                let definition = reader.GetTypeDefinition(handle)
                let name = reader.GetString(definition.Name)
                if name == "NullableAttribute" {
                    nullableTypes++
                }
            }
            Assert.Equal(1, nullableTypes)
            var stamps = 0
            for handle in reader.CustomAttributes {
                let attribute = reader.GetCustomAttribute(handle)
                if attribute.Constructor.Kind == HandleKind.MethodDefinition {
                    let ctor = reader.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor))
                    if reader.GetString(reader.GetTypeDefinition(ctor.GetDeclaringType()).Name) == "NullableAttribute" {
                        stamps++
                    }
                }
            }
            Assert.True(stamps > 0, "the nullable members must bind to the library's own NullableAttribute")
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review findings on the polyfill detection: a homonym in another package must not suppress
    /// embedding, a project-declared `EmbeddedAttribute` marker must be reused (no duplicate type),
    /// and a polyfill whose only constructor is a primary constructor must be bound.
    @Fact
    func PolyfillDetection_IsPackageQualifiedAndAcceptsMarkerAndPrimaryConstructor() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        for extra in[]string{HomonymSource, MarkerAndPolyfillSource, PrimaryConstructorPolyfillSource} {
            let tempDir = Directory.CreateTempSubdirectory("gs_4922_cases_").FullName
            try {
                let libPath = Path.Combine(tempDir, "Lib.dll")
                CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!, extraSource: extra)
                using let stream = File.OpenRead(libPath)
                using let peReader = PEReader(stream)
                let reader = peReader.GetMetadataReader()
                var compilerServicesNullable = 0
                var markers = 0
                for handle in reader.TypeDefinitions {
                    let definition = reader.GetTypeDefinition(handle)
                    let ns = reader.GetString(definition.Namespace)
                    let name = reader.GetString(definition.Name)
                    if ns == "System.Runtime.CompilerServices" && name == "NullableAttribute" {
                        compilerServicesNullable++
                    } else if name == "EmbeddedAttribute" {
                        markers++
                    }
                }
                Assert.Equal(1, compilerServicesNullable)
                Assert.Equal(1, markers)
                var stampsOnFrameworkNamedType = 0
                for handle in reader.CustomAttributes {
                    let attribute = reader.GetCustomAttribute(handle)
                    if attribute.Constructor.Kind != HandleKind.MethodDefinition {
                        continue
                    }
                    let declaring = reader.GetTypeDefinition(
                        reader.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor)).GetDeclaringType()
                    )
                    let declaringName = reader.GetString(declaring.Name)
                    if reader.GetString(declaring.Namespace) == "System.Runtime.CompilerServices" &&
                        (declaringName == "NullableAttribute" || declaringName == "NullableContextAttribute") {
                        stampsOnFrameworkNamedType++
                    }
                }
                Assert.True(
                    stampsOnFrameworkNamedType > 0,
                    "nullable stamps must bind to System.Runtime.CompilerServices.*"
                )
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }
    }

    /// A same-named class that cannot serve as the attribute (no `System.Attribute` base, or only a
    /// by-reference constructor) must not be bound: the library still compiles, and no custom-attribute
    /// row names its constructor.
    @Fact
    func UnusablePolyfill_IsNotBound() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        for extra in[]string{NonAttributePolyfillSource, RefConstructorPolyfillSource} {
            let tempDir = Directory.CreateTempSubdirectory("gs_4922_unusable_").FullName
            try {
                let libPath = Path.Combine(tempDir, "Lib.dll")
                CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!, extraSource: extra)
                using let stream = File.OpenRead(libPath)
                using let peReader = PEReader(stream)
                let reader = peReader.GetMetadataReader()
                for handle in reader.CustomAttributes {
                    let attribute = reader.GetCustomAttribute(handle)
                    if attribute.Constructor.Kind != HandleKind.MethodDefinition {
                        continue
                    }
                    let declaring = reader.GetTypeDefinition(
                        reader.GetMethodDefinition(MethodDefinitionHandle(attribute.Constructor)).GetDeclaringType()
                    )
                    Assert.NotEqual("NullableAttribute", reader.GetString(declaring.Name))
                }
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }
    }

    shared {
        private const NonAttributePolyfillSource string = `
package System.Runtime.CompilerServices

internal class NullableAttribute {
    init(flag uint8) {}
}
`

        private const RefConstructorPolyfillSource string = `
package System.Runtime.CompilerServices

import System

internal class NullableAttribute : Attribute {
    init(ref flag uint8) {}
}
`

        private const EscapedNamePolyfillSource string = `
package System.Runtime.CompilerServices

import System

internal class $NullableAttribute : Attribute {
    init(flag uint8) {}
    init(flags []uint8) {}
}
`

        private const HomonymSource string = `
package App

import System

internal class NullableAttribute : Attribute {
    init(flag uint8) {}
}
`

        private const MarkerAndPolyfillSource string = `
package Microsoft.CodeAnalysis

import System

internal class EmbeddedAttribute : Attribute {
}
`

        private const PrimaryConstructorPolyfillSource string = `
package System.Runtime.CompilerServices

import System

internal class NullableContextAttribute(flag uint8) : Attribute {
}
`

        private const PolyfillSource string = `
package System.Runtime.CompilerServices

import System

internal class NullableAttribute : Attribute {
    public let NullableFlags []uint8
    init(flag uint8) {
        this.NullableFlags = []uint8{flag}
    }
    init(flags []uint8) {
        this.NullableFlags = flags
    }
}
`

        private const NullableMisuseSource string = `
import Lib

let h = Holder()
let r string = h.Get("x")
`

        private const NullableOkSource string = `
import Lib

let h = Holder()
let r string? = h.Get("x")
`

        private func CompileApp(tempDir string, outPath string, libPath string, source string)(int32, string) {
            let srcPath = Path.Combine(tempDir, "app.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libPath
            }
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, "$compileOut\n$compileErr")
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }

        private const LibrarySource string = `
package Lib

class Holder {
    var name string?
    func Get(input string?) string? -> input
    func Name() string -> "n"
    func Many(input []string?) []string? -> input
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

        private func CompileOrThrow(
            name string,
            source string,
            outPath string,
            tempDir string,
            reference string,
            extraSource string? = nil
        ) {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            File.WriteAllText(srcPath, source)
            var args = []string{
                "/out:" + outPath,
                "/target:library",
                "/targetframework:netstandard2.0",
                "/reference:" + reference,
                srcPath
            }
            if extraSource != nil {
                let extraPath = Path.Combine(tempDir, name + ".extra.gs")
                File.WriteAllText(extraPath, extraSource)
                args = args.Append(extraPath).ToArray()
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
