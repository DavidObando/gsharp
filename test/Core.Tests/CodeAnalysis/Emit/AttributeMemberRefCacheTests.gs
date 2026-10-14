// <copyright file="AttributeMemberRefCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #420 (P3-11): `EmitIsReadOnlyAttribute` and
/// `EmitIsByRefLikeAttribute` previously allocated a fresh
/// `MemberRef` for the attribute constructor on every call, producing
/// duplicate rows when multiple inline structs / ref structs were emitted.
/// These tests verify that exactly one MemberRef row exists per attribute
/// ctor regardless of how many type defs are decorated.
open class AttributeMemberRefCacheTests {
    @Fact
    func MultipleInlineStructs_ProduceSingleIsReadOnlyAttributeCtorMemberRef() {
        const source = `package InlineStructCache
inline struct AId(value string) {}
inline struct BId(value string) {}
inline struct CId(value string) {}
func Main() {}
`
        using let pe = Compile(source)
        let counts = CountAttributeCtorMemberRefs(pe)
        // Expect exactly one MemberRef for IsReadOnlyAttribute..ctor() across all
        // three inline structs (each gets the attribute, but the MemberRef is cached).
        Assert.Equal(1, counts.IsReadOnly)
    }

    @Fact
    func MultipleRefStructs_ProduceSingleIsByRefLikeAndObsoleteAttributeCtorMemberRef() {
        const source = `package RefStructCache
ref struct A { var x int32 }
ref struct B { var y int32 }
ref struct C { var z int32 }
func Main() {}
`
        using let pe = Compile(source)
        let counts = CountAttributeCtorMemberRefs(pe)
        // Each ref struct gets IsByRefLikeAttribute + ObsoleteAttribute(string,bool).
        // With caching, only one MemberRef per ctor should be emitted.
        Assert.Equal(1, counts.IsByRefLike)
        Assert.Equal(1, counts.ObsoleteStringBool)
    }

    shared {
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

        private func CountAttributeCtorMemberRefs(pe MemoryStream)(
            IsReadOnly int32,
            IsByRefLike int32,
            ObsoleteStringBool int32
        ) {
            using let peReader = PEReader(pe, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            var isReadOnly = 0
            var isByRefLike = 0
            var obsolete = 0
            for mrHandle in md.MemberReferences {
                let mr = md.GetMemberReference(mrHandle)
                let name = md.GetString(mr.Name)
                if name != ".ctor" {
                    continue
                }
                if mr.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let tr = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                let typeName = md.GetString(tr.Name)
                let ns = md.GetString(tr.Namespace)
                if ns == "System.Runtime.CompilerServices" && typeName == "IsReadOnlyAttribute" {
                    isReadOnly++
                } else if ns == "System.Runtime.CompilerServices" && typeName == "IsByRefLikeAttribute" {
                    isByRefLike++
                } else if ns == "System" && typeName == "ObsoleteAttribute" {
                    obsolete++
                }
            }
            return (isReadOnly, isByRefLike, obsolete)
        }
    }
}
