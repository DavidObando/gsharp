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
import System.Reflection.Metadata.Ecma335
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

    /// Like csc, explicit application of the nullability attributes is not allowed, so user metadata
    /// cannot override the compiler's own stamps.
    @Fact
    func UserWrittenNullabilityAttribute_IsRejected() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4922_apply_").FullName
        try {
            let result = CompileLibrary(
                "lib",
                UserAppliedContextSource,
                Path.Combine(tempDir, "Lib.dll"),
                tempDir,
                netstandard!!
            )
            Assert.True(result.Item1 != 0 && result.Item2.Contains("GS0205"), "expected GS0205:\n" + result.Item2)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The compiler-generated declarations name framework types by their full names, so a project
    /// type called `Attribute` in the same package cannot change what they derive from.
    @Fact
    func ShadowedFrameworkNames_DoNotChangeTheEmbeddedCopies() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4922_shadow_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", LibrarySource, libPath, tempDir, netstandard!!, extraSource: ShadowSource)
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
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
            Assert.True(stamps > 0, "the embedded NullableAttribute must still be used")
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4993: a `netstandard2.0` library declaring `data class`, `data struct`,
    /// `inline struct`, `init` properties, `in` parameters, and `ref readonly` returns
    /// must reference only `netstandard` (no `System.Private.CoreLib`, no
    /// `System.Runtime`, and no `System.HashCode` TypeRef), embed internal
    /// `IsExternalInit` and `IsReadOnlyAttribute` TypeDefs, load cleanly in a
    /// `netstandard2.0`-only `MetadataLoadContext`, and execute accurately from a
    /// consumer assembly.
    @Fact
    func Issue4993_DataClasses_DataStructs_And_InlineStructs_OnNetStandard20_ReferenceOnlyNetStandard() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4993_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", Issue4993LibrarySource, libPath, tempDir, netstandard!!)
            {
                using let stream = File.OpenRead(libPath)
                using let peReader = PEReader(stream)
                let reader = peReader.GetMetadataReader()
                let assemblyRefs = reader
                    .AssemblyReferences
                    .Select((h AssemblyReferenceHandle) -> reader.GetString(reader.GetAssemblyReference(h).Name))
                    .ToArray()
                Assert.Equal([]string{"netstandard"}, assemblyRefs)
                for handle in reader.TypeReferences {
                    let tr = reader.GetTypeReference(handle)
                    Assert.NotEqual("HashCode", reader.GetString(tr.Name))
                    Assert.NotEqual("IsExternalInit", reader.GetString(tr.Name))
                    Assert.NotEqual("IsReadOnlyAttribute", reader.GetString(tr.Name))
                }
                let embedded = Dictionary[string, TypeDefinition]()
                for handle in reader.TypeDefinitions {
                    let definition = reader.GetTypeDefinition(handle)
                    embedded[
                        reader.GetString(definition.Namespace) + "." + reader.GetString(definition.Name)
                    ] = definition
                }
                for name in[]string{
                    "System.Runtime.CompilerServices.IsExternalInit",
                    "System.Runtime.CompilerServices.IsReadOnlyAttribute",
                    "Microsoft.CodeAnalysis.EmbeddedAttribute"
                } {
                    Assert.True(embedded.ContainsKey(name), "the library must declare an embedded " + name)
                    Assert.Equal(TypeAttributes.NotPublic, embedded[name].Attributes & TypeAttributes.VisibilityMask)
                }
            }
            // Load every type, member, custom attribute, and custom modifier in a
            // MetadataLoadContext that can only see the netstandard2.0 ref directory.
            let refDir = Path.GetDirectoryName(netstandard!!)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(refDir, "*.dll").Concat([]string{libPath}))
            {
                using let mlc = MetadataLoadContext(resolver, "netstandard")
                let loaded = mlc.LoadFromAssemblyPath(libPath)
                let allFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
                for type in loaded.GetTypes() {
                    let _ = type
                        .GetCustomAttributesData()
                        .Select((a CustomAttributeData) -> a.AttributeType.FullName)
                        .ToArray()
                    for prop in type.GetProperties(allFlags) {
                        let _ = prop.PropertyType.FullName
                    }
                    for method in type.GetMethods(allFlags) {
                        let _ = method
                            .ReturnParameter
                            .GetRequiredCustomModifiers()
                            .Select((m Type) -> m.FullName)
                            .ToArray()
                        for param in method.GetParameters() {
                            let _ = param.GetRequiredCustomModifiers().Select((m Type) -> m.FullName).ToArray()
                            let _ = param
                                .GetCustomAttributesData()
                                .Select((a CustomAttributeData) -> a.AttributeType.FullName)
                                .ToArray()
                        }
                    }
                }
            }
            // Compile and run a consumer against the netstandard2.0 library.
            let appPath = Path.Combine(tempDir, "App.dll")
            let (exit, output) = CompileApp(tempDir, appPath, libPath, Issue4993ConsumerSource)
            Assert.True(exit == 0, "the consumer must compile:\n" + output)
            let psi = System
                .Diagnostics
                .ProcessStartInfo("dotnet", "\"$appPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            using let proc = System.Diagnostics.Process.Start(psi)!!
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            proc.WaitForExit()
            Assert.True(proc.ExitCode == 0, "consumer failed ($stderr):\n$stdout")
            Assert.Equal("True False True True 5" + Environment.NewLine, stdout)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4993: a `netstandard2.0` project that declares its own polyfills for
    /// `IsExternalInit` and `IsReadOnlyAttribute` reuses those declarations without
    /// emitting duplicate `TypeDef` rows.
    @Fact
    func Issue4993_NetStandardLibraryWithPolyfills_ReusesPolyfillsWithoutDuplicates() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4993_poly_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow(
                "lib",
                Issue4993LibrarySource,
                libPath,
                tempDir,
                netstandard!!,
                extraSource: Issue4993PolyfillSource
            )
            using let stream = File.OpenRead(libPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var isExternalInitCount = 0
            var isReadOnlyCount = 0
            for handle in reader.TypeDefinitions {
                let definition = reader.GetTypeDefinition(handle)
                if reader.GetString(definition.Namespace) != "System.Runtime.CompilerServices" {
                    continue
                }
                let name = reader.GetString(definition.Name)
                if name == "IsExternalInit" {
                    isExternalInitCount++
                } else if name == "IsReadOnlyAttribute" {
                    isReadOnlyCount++
                }
            }
            Assert.Equal(1, isExternalInitCount)
            Assert.Equal(1, isReadOnlyCount)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4993 review: a source `struct IsExternalInit {}` polyfill in
    /// `System.Runtime.CompilerServices` suppresses embedding and is still resolved as the
    /// `modreq` target for `init` setters on `netstandard2.0`.
    @Fact
    func Issue4993_StructIsExternalInitPolyfill_RetainsInitSetterModreq() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4993_struct_init_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            CompileOrThrow("lib", `
package Lib

public class Config {
    public prop Name string { get; init; }
    public init() {
        this.Name = "ok"
    }
}
`, libPath, tempDir, netstandard!!, extraSource: `
package System.Runtime.CompilerServices

internal struct IsExternalInit {
}
`)
            let refDir = Path.GetDirectoryName(netstandard!!)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(refDir, "*.dll").Concat([]string{libPath}))
            using let mlc = MetadataLoadContext(resolver, "netstandard")
            let loaded = mlc.LoadFromAssemblyPath(libPath)
            let configType = loaded.GetType("Lib.Config", throwOnError: true)!!
            let setter = configType.GetProperty("Name")!!.GetSetMethod()!!
            let modreqs = setter.ReturnParameter.GetRequiredCustomModifiers().Select((m Type) -> m.FullName).ToArray()
            Assert.Equal([]string{"System.Runtime.CompilerServices.IsExternalInit"}, modreqs)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4993 review: when `(in int32) -> int32` or a `ref readonly` function literal
    /// return is the only readonly construct in a `netstandard2.0` compilation,
    /// `IsReadOnlyAttribute` is embedded and stamped on the emitted parameter/return rows.
    @Fact
    func Issue4993_FunctionTypeInSlotAndFunctionLiteralRefReadOnlyReturn_EmbedAndEmitIsReadOnlyAttribute() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4993_fn_ro_").FullName
        try {
            let fnTypeOnlyPath = Path.Combine(tempDir, "FnTypeOnlyLib.dll")
            CompileOrThrow("fnTypeOnlyLib", `
package Lib

public class Holder {
    public var Callback ((in int32) -> int32)?
}
`, fnTypeOnlyPath, tempDir, netstandard!!)
            let fnLiteralOnlyPath = Path.Combine(tempDir, "FnLiteralOnlyLib.dll")
            CompileOrThrow("fnLiteralOnlyLib", `
package Lib

public class Box {
    shared {
        private var slot int32 = 42

        public func Run() int32 {
            let reader = func () ref readonly int32 {
                return ref Box.slot
            }
            return reader()
        }
    }
}
`, fnLiteralOnlyPath, tempDir, netstandard!!)
            let refDir = Path.GetDirectoryName(netstandard!!)!!
            for dllPath in[]string{fnTypeOnlyPath, fnLiteralOnlyPath} {
                using let stream = File.OpenRead(dllPath)
                using let peReader = PEReader(stream)
                let reader = peReader.GetMetadataReader()
                var hasEmbeddedIsReadOnly = false
                for handle in reader.TypeDefinitions {
                    let definition = reader.GetTypeDefinition(handle)
                    if reader.GetString(definition.Namespace) == "System.Runtime.CompilerServices" && reader.GetString(
                        definition.Name
                    ) == "IsReadOnlyAttribute" {
                        hasEmbeddedIsReadOnly = true
                    }
                }
                Assert.True(hasEmbeddedIsReadOnly, "expected embedded IsReadOnlyAttribute in " + dllPath)

                let resolver = PathAssemblyResolver(Directory.GetFiles(refDir, "*.dll").Concat([]string{dllPath}))
                using let mlc = MetadataLoadContext(resolver, "netstandard")
                let loaded = mlc.LoadFromAssemblyPath(dllPath)
                let allFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
                var foundReadOnlyStamp = false
                for type in loaded.GetTypes() {
                    for method in type.GetMethods(allFlags) {
                        if method
                            .ReturnParameter
                            .GetCustomAttributesData()
                            .Any(
                            (a CustomAttributeData) -> a.AttributeType.FullName ==
                            "System.Runtime.CompilerServices.IsReadOnlyAttribute"
                        ) {
                            foundReadOnlyStamp = true
                        }
                        for param in method.GetParameters() {
                            if param.GetCustomAttributesData().Any(
                                (a CustomAttributeData) -> a.AttributeType.FullName ==
                                "System.Runtime.CompilerServices.IsReadOnlyAttribute"
                            ) {
                                foundReadOnlyStamp = true
                            }
                        }
                    }
                }
                Assert.True(foundReadOnlyStamp, "expected IsReadOnlyAttribute stamp in " + dllPath)
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4993 review: when a `netstandard2.0` consumer implements an interface or
    /// overrides an abstract base declared in another `netstandard2.0` assembly, the
    /// consumer's emitted `in` parameter and `init` setter `modreq` tokens match the
    /// imported slot's embedded modifier types so CLR slot matching and dispatch succeed.
    @Fact
    func Issue4993_CrossAssemblyInterfaceAndBaseOverride_PreservesImportedModifiersAndDispatches() {
        let netstandard string? = FindNetStandardReference()
        Assert.True(netstandard != nil, "could not locate a netstandard.dll reference assembly")
        let tempDir = Directory.CreateTempSubdirectory("gs_4993_xasm_").FullName
        try {
            let contractPath = Path.Combine(tempDir, "ContractLib.dll")
            CompileOrThrow("ContractLib", `
package ContractLib

public interface IReader {
    func Read(in x int32) int32;
    prop this[in i int32] int32 { get; }
}

public interface IView {
    prop Name string { get; }
}

public interface IConfig {
    prop Name string { get; init; }
}

public abstract class BaseInit {
    public abstract prop Tag string? { get; init; }
    public open func Borrow(in x int32) ref readonly int32;
}
`, contractPath, tempDir, netstandard!!)

            let implSrcPath = Path.Combine(tempDir, "ImplLib.gs")
            let implPath = Path.Combine(tempDir, "ImplLib.dll")
            File.WriteAllText(implSrcPath, `
package ImplLib

import ContractLib

public class Config[T] : IView, IConfig {
    public prop Name string { get; init; }
    public prop Value T? { get; init; }
    public init() {
        this.Name = ""
        this.Value = default(T?)
    }

    shared {
        public func Make(name string, v T) Config[T] -> Config[T]{ Name: name, Value: v }
    }
}

public class PlainConfig : IView, IConfig {
    public prop Name string { get; init; }
    public init() {
        this.Name = ""
    }
}

public class Impl : BaseInit, IReader {
    private var slot int32 = 10
    public override prop Tag string? { get; init; }
    public func Read(in x int32) int32 -> x + this.slot
    public prop this[in i int32] int32 {
        get -> i * 2 + this.slot
    }
    public override func Borrow(in x int32) ref readonly int32 {
        this.slot = x + 5
        return ref this.slot
    }
}
`)
            {
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var implExit int32
                try {
                    implExit = Program.Main(
                        []string{
                            "/out:" + implPath,
                            "/target:library",
                            "/targetframework:netstandard2.0",
                            "/reference:" + netstandard!!,
                            "/reference:" + contractPath,
                            implSrcPath
                        }
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(implExit == 0, "ImplLib failed to compile:\n$compileOut\n$compileErr")
            }

            let appSrcPath = Path.Combine(tempDir, "App.gs")
            let appPath = Path.Combine(tempDir, "App.dll")
            File.WriteAllText(appSrcPath, `
import System
import ContractLib
import ImplLib

let impl = Impl{ Tag: "configured" }
let cfg = Config[int32].Make("ok", 99)
let plainCfg = PlainConfig{ Name: "plain" }
let iview IView = plainCfg
let icfg IConfig = cfg
let reader IReader = impl
let baseInit BaseInit = impl
let k = 7
let r1 = reader.Read(in k)
let r2 = reader[in k]
let r3 = baseInit.Borrow(in k)
Console.WriteLine("${baseInit.Tag} ${icfg.Name} ${iview.Name} ${cfg.Value} $r1 $r2 $r3")
`)
            {
                let args = List[string]{
                    "/out:" + appPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + contractPath,
                    "/reference:" + implPath
                }
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add(appSrcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var appExit int32
                try {
                    appExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(appExit == 0, "App failed to compile:\n$compileOut\n$compileErr")
            }

            let psi = System
                .Diagnostics
                .ProcessStartInfo("dotnet", "\"$appPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            using let proc = System.Diagnostics.Process.Start(psi)!!
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            proc.WaitForExit()
            Assert.True(proc.ExitCode == 0, "App failed at runtime ($stderr):\n$stdout")
            Assert.Equal("configured ok plain 99 17 24 12" + Environment.NewLine, stdout)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const UserAppliedContextSource string = `
package Lib

import System.Runtime.CompilerServices

@NullableContext(2)
class Holder {
}
`

        private const ShadowSource string = `
package System.Runtime.CompilerServices

internal class Attribute {
}

internal class AttributeUsage {
}
`

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

        private const Issue4993LibrarySource string = `
package Lib

data class Rec(V string?)

data struct Pt(X int32, Y int32)

data class Wide(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32, I int32)

inline struct Meters(Value float64)

class InRefBox {
    var item int32 = 5
    prop Tag string? { get; init; }
    func Read(in x int32) ref readonly int32 {
        return ref this.item
    }
}
`

        private const Issue4993PolyfillSource string = `
package System.Runtime.CompilerServices

import System

internal shared class IsExternalInit {
}

internal class IsReadOnlyAttribute : Attribute {
}
`

        private const Issue4993ConsumerSource string = `
import System
import Lib

let r1 = Rec("a")
let r2 = Rec("a")
let r3 = r1 with { V = "b" }
let p1 = Pt(2, 3)
let p2 = p1 with { Y = 3 }
let w1 = Wide(1, 2, 3, 4, 5, 6, 7, 8, 9)
let w2 = Wide(1, 2, 3, 4, 5, 6, 7, 8, 9)
let m1 = Meters(1.5)
let m2 = Meters(1.5)
let box = InRefBox{ Tag: "ok" }
let k = 1
Console.WriteLine("${r1 == r2 && r1.GetHashCode() == r2.GetHashCode()} ${r1 == r3} ${p1 == p2 && p1.GetHashCode() == p2.GetHashCode() && w1.GetHashCode() == w2.GetHashCode()} ${m1 == m2 && m1.GetHashCode() == m2.GetHashCode()} ${box.Read(in k)}")
`

        private let netStandardCacheLock object = Object()
        private var cachedNetStandard20Path string?

        // NuGet cache NETStandard.Library 2.0 ref assembly, or <dotnet-root>/packs/NETStandard.Library.Ref/<version>/ref/<tfm>/netstandard.dll
        // scrubbed to the netstandard2.0 surface (without netstandard2.1's IsReadOnlyAttribute / HashCode).
        internal func FindNetStandardReference() string? {
            lock netStandardCacheLock {
                if cachedNetStandard20Path != nil && File.Exists(cachedNetStandard20Path) {
                    return cachedNetStandard20Path
                }
                let packages = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".nuget",
                    "packages"
                )
                let packageRoot = Path.Combine(packages, "netstandard.library")
                if Directory.Exists(packageRoot) {
                    let packaged string? = Directory
                        .GetFiles(packageRoot, "netstandard.dll", SearchOption.AllDirectories)
                        .Where(
                        (p string) -> p.Contains(
                            Path.Combine("build", "netstandard2.0", "ref"),
                            StringComparison.Ordinal
                        )
                    )
                        .OrderByDescending((p string) -> p, StringComparer.Ordinal)
                        .FirstOrDefault()
                    if packaged != nil {
                        cachedNetStandard20Path = EnsureNetStandard20Surface(packaged)
                        return cachedNetStandard20Path
                    }
                }
                var dotnetRoot string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                while dotnetRoot != nil && !Directory.Exists(Path.Combine(dotnetRoot, "packs")) {
                    dotnetRoot = Path.GetDirectoryName(dotnetRoot)
                }
                var packRoot = if dotnetRoot != nil {
                    Path.Combine(dotnetRoot, "packs", "NETStandard.Library.Ref")
                } else {
                    ""
                }
                if !Directory.Exists(packRoot) && Directory.Exists(
                    "/usr/local/share/dotnet/packs/NETStandard.Library.Ref"
                ) {
                    packRoot = "/usr/local/share/dotnet/packs/NETStandard.Library.Ref"
                }
                if !Directory.Exists(packRoot) {
                    return nil
                }
                let packCandidate = Directory
                    .GetFiles(packRoot, "netstandard.dll", SearchOption.AllDirectories)
                    .OrderByDescending((p string) -> p, StringComparer.Ordinal)
                    .FirstOrDefault()
                if packCandidate == nil {
                    return nil
                }
                cachedNetStandard20Path = EnsureNetStandard20Surface(packCandidate)
                return cachedNetStandard20Path
            }
        }

        internal func EnsureNetStandard20Surface(path string) string {
            let bytes = File.ReadAllBytes(path)
            var patched = false
            {
                using let memory = MemoryStream(bytes, writable: false)
                using let peReader = PEReader(memory)
                let reader = peReader.GetMetadataReader()
                let metadataStart = peReader.PEHeaders.MetadataStartOffset
                let typeDefTableOffset = metadataStart + reader.GetTableMetadataOffset(TableIndex.TypeDef)
                let typeDefRowSize = reader.GetTableRowSize(TableIndex.TypeDef)
                for handle in reader.TypeDefinitions {
                    let definition = reader.GetTypeDefinition(handle)
                    if (definition.Attributes & TypeAttributes.VisibilityMask) != TypeAttributes.Public {
                        continue
                    }
                    let ns = reader.GetString(definition.Namespace)
                    let name = reader.GetString(definition.Name)
                    if (ns == "System" && name == "HashCode") ||
                        (ns == "System.Runtime.CompilerServices" && name == "IsReadOnlyAttribute") {
                        let rowNumber = MetadataTokens.GetRowNumber(handle)
                        let flagsOffset = typeDefTableOffset + ((rowNumber - 1) * typeDefRowSize)
                        bytes[flagsOffset] = cast[uint8](bytes[flagsOffset] & 0xF8)
                        patched = true
                    }
                }
            }
            if !patched {
                return path
            }
            let cacheDir = Path.Combine(AppContext.BaseDirectory, "netstandard20-surface-cache")
            Directory.CreateDirectory(cacheDir)
            let sourceDir = Path.GetDirectoryName(path)
            if sourceDir != nil {
                for dll in Directory.GetFiles(sourceDir, "*.dll") {
                    let fileName = Path.GetFileName(dll)
                    if !string.Equals(fileName, "netstandard.dll", StringComparison.OrdinalIgnoreCase) {
                        let dest = Path.Combine(cacheDir, fileName)
                        if !File.Exists(dest) {
                            File.Copy(dll, dest, overwrite: true)
                        }
                    }
                }
            }
            let outPath = Path.Combine(cacheDir, "netstandard.dll")
            File.WriteAllBytes(outPath, bytes)
            return outPath
        }

        private func CompileLibrary(
            name string,
            source string,
            outPath string,
            tempDir string,
            reference string,
            extraSource string? = nil
        )(int32, string) {
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
            return (exit, "stdout:\n$compileOut\nstderr:\n$compileErr")
        }

        private func CompileOrThrow(
            name string,
            source string,
            outPath string,
            tempDir string,
            reference string,
            extraSource string? = nil
        ) {
            let result = CompileLibrary(name, source, outPath, tempDir, reference, extraSource)
            Assert.True(result.Item1 == 0, "gsc failed compiling '$name':\n" + result.Item2)
        }
    }
}
