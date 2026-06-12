// <copyright file="AttributeMemberRefCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-11): <c>EmitIsReadOnlyAttribute</c> and
/// <c>EmitIsByRefLikeAttribute</c> previously allocated a fresh
/// <c>MemberRef</c> for the attribute constructor on every call, producing
/// duplicate rows when multiple inline structs / ref structs were emitted.
/// These tests verify that exactly one MemberRef row exists per attribute
/// ctor regardless of how many type defs are decorated.
/// </summary>
public class AttributeMemberRefCacheTests
{
    [Fact]
    public void MultipleInlineStructs_ProduceSingleIsReadOnlyAttributeCtorMemberRef()
    {
        const string source = @"package InlineStructCache
inline struct AId(value string) {}
inline struct BId(value string) {}
inline struct CId(value string) {}
func Main() {}
";
        using var pe = Compile(source);
        var counts = CountAttributeCtorMemberRefs(pe);

        // Expect exactly one MemberRef for IsReadOnlyAttribute..ctor() across all
        // three inline structs (each gets the attribute, but the MemberRef is cached).
        Assert.Equal(1, counts.IsReadOnly);
    }

    [Fact]
    public void MultipleRefStructs_ProduceSingleIsByRefLikeAndObsoleteAttributeCtorMemberRef()
    {
        const string source = @"package RefStructCache
ref struct A { var x int32 }
ref struct B { var y int32 }
ref struct C { var z int32 }
func Main() {}
";
        using var pe = Compile(source);
        var counts = CountAttributeCtorMemberRefs(pe);

        // Each ref struct gets IsByRefLikeAttribute + ObsoleteAttribute(string,bool).
        // With caching, only one MemberRef per ctor should be emitted.
        Assert.Equal(1, counts.IsByRefLike);
        Assert.Equal(1, counts.ObsoleteStringBool);
    }

    private static MemoryStream Compile(string source)
    {
        var pe = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(pe);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        pe.Position = 0;
        return pe;
    }

    private static (int IsReadOnly, int IsByRefLike, int ObsoleteStringBool) CountAttributeCtorMemberRefs(MemoryStream pe)
    {
        using var peReader = new PEReader(pe, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        int isReadOnly = 0;
        int isByRefLike = 0;
        int obsolete = 0;

        foreach (var mrHandle in md.MemberReferences)
        {
            var mr = md.GetMemberReference(mrHandle);
            var name = md.GetString(mr.Name);
            if (name != ".ctor")
            {
                continue;
            }

            if (mr.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
            var typeName = md.GetString(tr.Name);
            var ns = md.GetString(tr.Namespace);

            if (ns == "System.Runtime.CompilerServices" && typeName == "IsReadOnlyAttribute")
            {
                isReadOnly++;
            }
            else if (ns == "System.Runtime.CompilerServices" && typeName == "IsByRefLikeAttribute")
            {
                isByRefLike++;
            }
            else if (ns == "System" && typeName == "ObsoleteAttribute")
            {
                obsolete++;
            }
        }

        return (isReadOnly, isByRefLike, obsolete);
    }
}
