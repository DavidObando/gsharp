// <copyright file="Issue4924DownlevelMemberSurfaceTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit
import Xunit.Sdk

/// Issue #4924: a `netstandard2.0` compilation must bind only to members its
/// target framework declares.
///
/// The predefined type symbols (`string`, `object`, ...) carry the gsc host's
/// `System.Private.CoreLib` types. Instance-member lookup enumerated those, so
/// `s.Split(',')` in the netstandard2.0 SDK task bound to the host's
/// `Split(char, StringSplitOptions)`, which .NET Framework does not have:
/// Visual Studio's MSBuild failed the build with MissingMethodException. And
/// with any non-framework reference in the set the resolver also put every host
/// BCL assembly in scope, so a host-only extension method (`MemoryExtensions`,
/// `CollectionExtensions`) bound instead and the output referenced
/// `System.Private.CoreLib`.
///
/// The reference set is NETStandard.Library's netstandard2.0 reference assemblies
/// plus one non-framework library (xunit), as any real project has.
/// `NETStandard.Library.Ref` (netstandard2.1) is not used: 2.1 does declare
/// `Split(char, StringSplitOptions)`.
class Issue4924DownlevelMemberSurfaceTests {
    /// `Split(params char[])` is the only one-character overload netstandard2.0 has.
    @Fact
    func StringSplit_BindsToTheNetStandardOverload() {
        let image = CompileOrFail(NetStandardReferences(), `package Issue4924

class Reader {
    func Parts(s string)[]string? -> s.Split(',')

    func Maybe(s string?) int32 -> s?.Split(';')?.Length ?? 0
}
`)
        // Both calls bind the same overload, so they share one MemberRef; a call bound to
        // any other overload would add a second row.
        let split = Assert.Single(StringMemberSignatures(image, "Split"))
        Assert.Equal("netstandard", split.Item1)
        // HASTHIS, one parameter, returns string[], takes char[].
        Assert.Equal("20-01-1D-0E-1D-03", split.Item2)
    }

    /// The overloads of the host's `String` that netstandard2.0 lacks are not
    /// candidates, and neither are host-only extension methods. Each call has no
    /// netstandard2.0 overload, so each must fail to bind (GS0159), as csc does.
    @Theory
    @InlineData("s.Contains('x')")
    @InlineData("s.StartsWith('a')")
    @InlineData("s.Replace(\"a\", \"b\", StringComparison.Ordinal)")
    @InlineData("d.TryAdd(\"a\", 1)")
    func HostOnlyMembers_AreNotCandidates(call string) {
        let source = `package Issue4924

import System
import System.Collections.Generic

class Probe {
    func Run(s string, d Dictionary[string, int32]) object -> ` + call + `
}
`
        let (diagnostics, image) = Compile(NetStandardReferences(), source)
        Assert.Null(image)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    /// Discrimination the other way: the host target keeps the modern overload,
    /// so the fix narrows binding to the target's surface rather than to an old
    /// one.
    @Fact
    func StringSplit_OnTheHostTarget_KeepsTheCharOverload() {
        let image = CompileOrFail(nil, `package Issue4924

class Reader {
    func Parts(s string)[]string -> s.Split(',')
}
`)
        let split = Assert.Single(StringMemberSignatures(image, "Split"))
        // HASTHIS, two parameters, returns string[], takes char and a StringSplitOptions value type.
        Assert.StartsWith("20-02-1D-0E-03-11-", split.Item2)
    }

    /// The resolver for a downlevel target names only the target's types: no host
    /// BCL assembly is visible, so a type netstandard2.0 lacks does not resolve,
    /// while `System.String` resolves to netstandard's declaration. Repeated member
    /// lookups answer the same cached reference-set type, and the downlevel set is
    /// exactly the supplied references (nothing is loaded beyond them).
    @Fact
    func DownlevelResolver_NamesOnlyTheTargetSurface() {
        let references = NetStandardReferences()
        using let resolver = ReferenceResolver.WithReferences(references)
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        Assert.Equal("netstandard", stringType.Assembly.GetName().Name)
        Assert.False(resolver.TryResolveType("System.Collections.Generic.CollectionExtensions", out _))
        Assert.False(resolver.TryResolveType("System.MemoryExtensions", out _))
        Assert.DoesNotContain(
            resolver.Assemblies,
            (assembly Assembly) -> assembly.GetName().Name == "System.Private.CoreLib"
        )
        Assert.True(resolver.Assemblies.Length <= references.Count)
        Assert.True(resolver.TryGetMemberLookupType(typeof(string), out var projected))
        Assert.Same(stringType, projected)
        Assert.True(resolver.TryGetMemberLookupType(typeof(string), out var again))
        Assert.Same(projected, again)
        // A reference-set type is never re-projected by name.
        Assert.True(resolver.TryGetMemberLookupType(stringType, out var unchanged))
        Assert.Same(stringType, unchanged)
        // A host type netstandard2.0 does not declare has no members to bind.
        Assert.False(resolver.TryGetMemberLookupType(typeof(CollectionExtensions), out _))
    }

    /// A type the host fallback supplies only to resolve a dependency's signature (here
    /// `System.DateOnly` out of `System.Private.CoreLib`, from a dependency built for the
    /// host runtime) is not part of the netstandard2.0 surface: binding a member on it
    /// reports GS0546 instead of referencing the host's member.
    @Fact
    func HostFallbackReceiver_FromADependency_IsNotBound() {
        let directory = Directory.CreateTempSubdirectory("gs_4924_").FullName
        try {
            let dependencyPath = Path.Combine(directory, "Dep.dll")
            File.WriteAllBytes(dependencyPath, CompileOrFail(nil, `package Dep

import System

class Clock {
    func Today() DateOnly -> DateOnly(2026, 10, 15)
}
`))
            let references = List[string](NetStandardReferences())
            references.Add(dependencyPath)
            let (diagnostics, image) = Compile(references, `package App

import Dep

class Use {
    func Next(c Clock) object -> c.Today().AddDays(1)
}
`)
            Assert.Null(image)
            Assert.Contains(
                diagnostics,
                (d Diagnostic) -> d.Id == "GS0546" && d.Message.Contains(
                    "System.DateOnly.AddDays",
                    StringComparison.Ordinal
                )
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Issue #4928: when projecting a host type into the target reference set throws
    /// `ArgumentException` (for example, an arity mismatch on `MakeGenericType` or an
    /// invalid forwarded assembly culture), `TryGetMemberLookupType` degrades
    /// gracefully instead of letting the exception escape binding as GS9998, and
    /// compilation reports GS0546.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ProjectionFailure_InTryGetMemberLookupType_ReportsGs0546NotGs9998(forwardedBadCulture bool) {
        let directory = Directory.CreateTempSubdirectory("gs_4928_").FullName
        try {
            let references = BuildBrokenDownlevelReferences(directory, forwardedBadCulture)
            using let resolver = ReferenceResolver.WithReferences(references)
            let thrown = Assert.ThrowsAny[ArgumentException](
                () -> cast[object?](resolver.MapClrTypeToReferences(typeof(Dictionary[int32, int32])))
            )
            Assert.NotNull(thrown)
            Assert.False(resolver.TryGetMemberLookupType(typeof(Dictionary[int32, int32]), out _))
            let (diagnostics, image) = Compile(references, `package App

class Probe {
    func Run(m map[int32, int32]) int32 -> m.Count
}
`)
            Assert.Null(image)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
            Assert.Contains(
                diagnostics,
                (d Diagnostic) -> d.Id == "GS0546" && d.Message.Contains(
                    "System.Collections.Generic.Dictionary`2",
                    StringComparison.Ordinal
                )
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func BuildBrokenDownlevelReferences(directory string, forwardedBadCulture bool) IReadOnlyList[string] {
            let metadata = MetadataBuilder()
            metadata.AddModule(
                0,
                metadata.GetOrAddString("netstandard.dll"),
                metadata.GetOrAddGuid(Guid.NewGuid()),
                GuidHandle(),
                GuidHandle()
            )
            metadata.AddAssembly(
                metadata.GetOrAddString("netstandard"),
                Version(2, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                AssemblyHashAlgorithm.None
            )
            metadata.AddTypeDefinition(
                cast[TypeAttributes](0),
                StringHandle(),
                metadata.GetOrAddString("<Module>"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let systemNamespace = metadata.GetOrAddString("System")
            let objectType = metadata.AddTypeDefinition(
                TypeAttributes.Public | TypeAttributes.Class,
                systemNamespace,
                metadata.GetOrAddString("Object"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let valueType = metadata.AddTypeDefinition(
                TypeAttributes.Public | TypeAttributes.Class,
                systemNamespace,
                metadata.GetOrAddString("ValueType"),
                objectType,
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            metadata.AddTypeDefinition(
                TypeAttributes.Public | TypeAttributes.Sealed | TypeAttributes.SequentialLayout,
                systemNamespace,
                metadata.GetOrAddString("Int32"),
                valueType,
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let paths = List[string]()
            if forwardedBadCulture {
                // Forward Dictionary`2 (not a CoreType, so not probed by MetadataLoadContext..ctor)
                // to a sibling assembly via an AssemblyReference with an invalid Culture string
                // ("invalid/culture"): MetadataTypeNameReader indexes the forwarder by simple name,
                // and Assembly.GetType throws CultureNotFoundException (an ArgumentException
                // subclass) during projection.
                let badRef = metadata.AddAssemblyReference(
                    metadata.GetOrAddString("Target"),
                    Version(1, 0, 0, 0),
                    metadata.GetOrAddString("invalid/culture"),
                    BlobHandle(),
                    cast[AssemblyFlags](0),
                    BlobHandle()
                )
                metadata.AddExportedType(
                    cast[TypeAttributes](0x00200000),
                    metadata.GetOrAddString("System.Collections.Generic"),
                    metadata.GetOrAddString("Dictionary`2"),
                    badRef,
                    0
                )
                let targetMetadata = MetadataBuilder()
                targetMetadata.AddModule(
                    0,
                    targetMetadata.GetOrAddString("Target.dll"),
                    targetMetadata.GetOrAddGuid(Guid.NewGuid()),
                    GuidHandle(),
                    GuidHandle()
                )
                targetMetadata.AddAssembly(
                    targetMetadata.GetOrAddString("Target"),
                    Version(1, 0, 0, 0),
                    StringHandle(),
                    BlobHandle(),
                    cast[AssemblyFlags](0),
                    AssemblyHashAlgorithm.None
                )
                targetMetadata.AddTypeDefinition(
                    cast[TypeAttributes](0),
                    StringHandle(),
                    targetMetadata.GetOrAddString("<Module>"),
                    EntityHandle(),
                    MetadataTokens.FieldDefinitionHandle(1),
                    MetadataTokens.MethodDefinitionHandle(1)
                )
                let targetDictionary = targetMetadata.AddTypeDefinition(
                    TypeAttributes.Public | TypeAttributes.Class,
                    targetMetadata.GetOrAddString("System.Collections.Generic"),
                    targetMetadata.GetOrAddString("Dictionary`2"),
                    EntityHandle(),
                    MetadataTokens.FieldDefinitionHandle(1),
                    MetadataTokens.MethodDefinitionHandle(1)
                )
                targetMetadata.AddGenericParameter(
                    targetDictionary,
                    GenericParameterAttributes.None,
                    targetMetadata.GetOrAddString("TKey"),
                    0
                )
                targetMetadata.AddGenericParameter(
                    targetDictionary,
                    GenericParameterAttributes.None,
                    targetMetadata.GetOrAddString("TValue"),
                    1
                )
                let targetImage = BlobBuilder()
                ManagedPEBuilder(
                    PEHeaderBuilder.CreateLibraryHeader(),
                    MetadataRootBuilder(targetMetadata),
                    BlobBuilder()
                ).Serialize(targetImage)
                let targetPath = Path.Combine(directory, "Target.dll")
                File.WriteAllBytes(targetPath, targetImage.ToArray())
                let netstandardImage = BlobBuilder()
                ManagedPEBuilder(
                    PEHeaderBuilder.CreateLibraryHeader(),
                    MetadataRootBuilder(metadata),
                    BlobBuilder()
                ).Serialize(netstandardImage)
                let netstandardPath = Path.Combine(directory, "netstandard.dll")
                File.WriteAllBytes(netstandardPath, netstandardImage.ToArray())
                paths.Add(netstandardPath)
                paths.Add(targetPath)
                return paths
            }
            let dictionary = metadata.AddTypeDefinition(
                TypeAttributes.Public | TypeAttributes.Class,
                metadata.GetOrAddString("System.Collections.Generic"),
                metadata.GetOrAddString("Dictionary`2"),
                objectType,
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            // One generic parameter on `Dictionary`2`: GetType and IsVisible succeed,
            // and MakeGenericType(typeof(int), typeof(int)) throws ArgumentException for the arity mismatch.
            metadata.AddGenericParameter(dictionary, GenericParameterAttributes.None, metadata.GetOrAddString("T1"), 0)
            let image = BlobBuilder()
            ManagedPEBuilder(
                PEHeaderBuilder.CreateLibraryHeader(),
                MetadataRootBuilder(metadata),
                BlobBuilder()
            ).Serialize(image)
            let referencePath = Path.Combine(directory, "netstandard.dll")
            File.WriteAllBytes(referencePath, image.ToArray())
            paths.Add(referencePath)
            return paths
        }

        private func NetStandardReferences() IReadOnlyList[string] {
            let directory = typeof(Issue4924DownlevelMemberSurfaceTests)
                .Assembly
                .GetCustomAttributes[AssemblyMetadataAttribute]()
                .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
                .Value
            if directory is not string referenceDirectory || !Directory.Exists(referenceDirectory) {
                throw XunitException("prerequisite missing: netstandard2.0 reference directory '$directory'")
            }
            let paths = List[string](Directory.EnumerateFiles(referenceDirectory, "*.dll"))
            // A non-framework dependency, so the set is shaped like a real project's.
            paths.Add(typeof(FactAttribute).Assembly.Location)
            return paths
        }

        private func Compile(references IReadOnlyList[string]?, source string)(
            Diagnostics IReadOnlyList[Diagnostic],
            Image[]?uint8
        ) {
            using let resolver = if references == nil {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return (
                result.Diagnostics,
                if result.Success {
                    peStream.ToArray()
                } else {
                    default([]?uint8)
                }
            )
        }

        private func CompileOrFail(references IReadOnlyList[string]?, source string)[]uint8 {
            let (diagnostics, image) = Compile(references, source)
            if image is []uint8 bytes {
                return bytes
            }
            throw XunitException(
                "compilation failed:\n" + string.Join("\n", diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
        }

        /// The (resolution scope, signature blob) of every MemberRef named
        /// [`name`](paramref) whose parent is a `System.String` TypeRef.
        private func StringMemberSignatures(image[]uint8, name string) List[(string, string)] {
            using let peReader = PEReader(ImmutableArray.Create(image))
            let metadata = PEReaderExtensions.GetMetadataReader(peReader)
            let found = List[(string, string)]()
            for handle in metadata.MemberReferences {
                let member = metadata.GetMemberReference(handle)
                if metadata.GetString(member.Name) != name || member.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let parent = metadata.GetTypeReference(TypeReferenceHandle(member.Parent))
                if metadata.GetString(parent.Namespace) != "System" || metadata.GetString(parent.Name) != "String" {
                    continue
                }
                let resolutionScope = if parent.ResolutionScope.Kind == HandleKind.AssemblyReference {
                    metadata.GetString(
                        metadata.GetAssemblyReference(AssemblyReferenceHandle(parent.ResolutionScope)).Name
                    )
                } else {
                    parent.ResolutionScope.Kind.ToString()
                }
                found.Add((resolutionScope, BitConverter.ToString(metadata.GetBlobBytes(member.Signature))))
            }
            return found
        }
    }
}
