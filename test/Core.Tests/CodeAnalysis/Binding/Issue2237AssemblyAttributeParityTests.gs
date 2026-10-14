// <copyright file="Issue2237AssemblyAttributeParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2237: file-level `@assembly:` annotations must reach parity
/// with C#'s `[assembly: ...]` — any attribute type the compiler can
/// resolve (BCL or a same-compilation user-declared attribute), not just
/// `InternalsVisibleTo`.
open class Issue2237AssemblyAttributeParityTests {
    @Fact
    func Binds_NonInternalsVisibleTo_Assembly_Annotation_Into_AssemblyAttributes() {
        let globalScope = BindSource(`package MyApp
@assembly:System.Reflection.AssemblyMetadataAttribute("Key", "Value")

func Main() {
}`)
        Assert.Empty(GetBinderDiagnostics(globalScope))
        let attr = Assert.Single(globalScope.AssemblyAttributes)
        Assert.Equal("System.Reflection.AssemblyMetadataAttribute", attr.AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Assembly, attr.Target)
        Assert.Equal(2, attr.PositionalArguments.Length)
        Assert.Equal("Key", attr.PositionalArguments[0].Value)
        Assert.Equal("Value", attr.PositionalArguments[1].Value)
    }

    @Fact
    func InternalsVisibleTo_Annotation_Is_Excluded_From_AssemblyAttributes_But_Kept_In_FriendAssemblies() {
        // InternalsVisibleTo keeps its own early, syntactic fast path
        // (FriendAssemblies) so it isn't double-bound/double-emitted via the
        // general AssemblyAttributes list.
        let globalScope = BindSource(`package MyApp
@assembly:InternalsVisibleTo("Some.Other.Assembly")
@assembly:System.Reflection.AssemblyMetadataAttribute("Key", "Value")

func Main() {
}`)
        Assert.Empty(GetBinderDiagnostics(globalScope))
        Assert.Equal([]string{"Some.Other.Assembly"}, globalScope.FriendAssemblies)
        let attr = Assert.Single(globalScope.AssemblyAttributes)
        Assert.Equal("System.Reflection.AssemblyMetadataAttribute", attr.AttributeType.Name)
    }

    @Fact
    func Reports_AttributeTypeNotFound_Instead_Of_The_Old_Fixed_GS0464_For_Unknown_Assembly_Attribute() {
        let globalScope = BindSource(`package MyApp
@assembly:TotallyBogusAttribute("x")

func Main() {
}`)
        Assert.Contains(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0198")
        Assert.DoesNotContain(GetBinderDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0464")
        Assert.Empty(globalScope.AssemblyAttributes)
    }

    @Fact
    func Emits_Multiple_Arbitrary_Assembly_Attributes_As_Real_CustomAttribute_Rows() {
        const source = `package MyApp
@assembly:InternalsVisibleTo("Friend.Assembly")
@assembly:System.Reflection.AssemblyFileVersionAttribute("1.3.1.0")
@assembly:System.CodeDom.Compiler.GeneratedCodeAttribute("Nerdbank.GitVersioning.Tasks", "1.0")

func Main() {
}`
        using let pe = Compile(source)
        let typeNames = GetAssemblyCustomAttributeTypeNames(pe)
        Assert.Contains("System.Runtime.CompilerServices.InternalsVisibleToAttribute", typeNames)
        Assert.Contains("System.Reflection.AssemblyFileVersionAttribute", typeNames)
        Assert.Contains("System.CodeDom.Compiler.GeneratedCodeAttribute", typeNames)
    }

    @Fact
    func Does_Not_Duplicate_AssemblyInformationalVersionAttribute_When_User_Declares_It_Explicitly() {
        // The emitter also synthesizes AssemblyInformationalVersionAttribute
        // from the /version:-style override when present; an explicit
        // user `@assembly:` declaration of the same (non-repeatable)
        // attribute type must win instead of producing a duplicate row.
        const source = `package MyApp
@assembly:System.Reflection.AssemblyInformationalVersionAttribute("1.3.0-explicit")

func Main() {
}`
        let pe = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let result = compilation.Emit(
            pe,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2237Dedup",
            assemblyVersion: "9.9.9-override"
        )
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pe.Position = 0
        using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let assembly = md.GetAssemblyDefinition()
        var count = 0
        for cah in assembly.GetCustomAttributes() {
            if GetAttributeTypeName(md, cah) == "System.Reflection.AssemblyInformationalVersionAttribute" {
                count++
            }
        }
        Assert.Equal(1, count)
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetBinderDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] {
            return $scope.Diagnostics
        }

        private func Compile(source string) MemoryStream {
            let pe = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(pe)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            pe.Position = 0
            return pe
        }

        private func GetAssemblyCustomAttributeTypeNames(pe MemoryStream) HashSet[string] {
            using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            let assembly = md.GetAssemblyDefinition()
            let names = HashSet[string]()
            for cah in assembly.GetCustomAttributes() {
                let name string? = GetAttributeTypeName(md, cah)
                if name != nil {
                    names.Add(name)
                }
            }
            return names
        }

        private func GetAttributeTypeName(md MetadataReader, cah CustomAttributeHandle) string? {
            let ca = md.GetCustomAttribute(cah)
            let ctor = ca.Constructor
            if ctor.Kind == HandleKind.MemberReference {
                let mr = md.GetMemberReference(MemberReferenceHandle(ctor))
                if mr.Parent.Kind == HandleKind.TypeReference {
                    let tr = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                    return md.GetString(tr.Namespace) + "." + md.GetString(tr.Name)
                }
            }
            return nil
        }
    }
}
