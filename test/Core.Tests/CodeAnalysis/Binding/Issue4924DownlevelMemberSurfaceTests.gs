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
        let projected = resolver.GetMemberLookupType(typeof(string))
        Assert.Same(stringType, projected)
        Assert.Same(projected, resolver.GetMemberLookupType(typeof(string)))
        // A reference-set type is never re-projected by name.
        Assert.Same(stringType, resolver.GetMemberLookupType(stringType))
    }

    shared {
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
