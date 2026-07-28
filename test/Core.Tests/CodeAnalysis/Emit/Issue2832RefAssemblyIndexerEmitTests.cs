// <copyright file="Issue2832RefAssemblyIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2832: <c>MemberDefEmitter.EmitPropertyAccessorBody</c> returns "no
/// body" under <see cref="GSharp.Core.CodeAnalysis.Emit.EmitContext.MetadataOnly"/>,
/// which pushed <c>EmitPropertyGetter</c>/<c>EmitPropertySetter</c> onto their
/// fallback signature paths. Those paths hard-coded zero/one parameter, so an
/// indexer's accessors landed in the reference assembly without their index
/// parameters — the property stopped being an indexer and every consumer
/// compiled against <c>obj/…/ref/</c> failed with GS0116. These tests pin that
/// the reference assembly's accessor signatures match the runtime assembly's.
/// </summary>
public class Issue2832RefAssemblyIndexerEmitTests
{
    private const string IndexerSource = """
        package IdxPkg

        public class Box {
            var items []string

            public func New() {
                items = []string{"", "", "", ""}
            }

            public prop this[i int32] string {
                get { return items!![i] }
                set { items!![i] = value }
            }

            public prop Count int32 {
                get { return 4 }
            }
        }
        """;

    private const string MultiParamIndexerSource = """
        package GridPkg

        public class Grid {
            var cells []int32

            public func New() {
                cells = []int32{0, 0, 0, 0}
            }

            public prop this[row int32, column int32] int32 {
                get { return cells!![(row * 2) + column] }
                set { cells!![(row * 2) + column] = value }
            }
        }
        """;

    [Theory]
    [InlineData("get_Item")]
    [InlineData("set_Item")]
    [InlineData("get_Count")]
    public void ReferenceAssembly_AccessorSignature_MatchesRuntimeAssembly(string accessorName)
    {
        var (runtime, reference) = EmitBoth(IndexerSource);

        Assert.Equal(
            SignatureOf(runtime, accessorName),
            SignatureOf(reference, accessorName));
    }

    [Theory]
    [InlineData("get_Item")]
    [InlineData("set_Item")]
    public void ReferenceAssembly_MultiParameterIndexerSignature_MatchesRuntimeAssembly(string accessorName)
    {
        var (runtime, reference) = EmitBoth(MultiParamIndexerSource);

        Assert.Equal(
            SignatureOf(runtime, accessorName),
            SignatureOf(reference, accessorName));
    }

    [Fact]
    public void ReferenceAssembly_IndexerSetter_ValueParameterFollowsIndexParameters()
    {
        var (_, reference) = EmitBoth(MultiParamIndexerSource);

        reference.Position = 0;
        using var pe = new PEReader(reference, PEStreamOptions.LeaveOpen);
        var md = pe.GetMetadataReader();
        var setter = md.MethodDefinitions
            .Select(md.GetMethodDefinition)
            .Single(m => md.GetString(m.Name) == "set_Item");

        // Two index parameters precede `value`, so its sequence number is 3.
        var sequenceNumbers = setter.GetParameters()
            .Select(h => md.GetParameter(h).SequenceNumber)
            .ToArray();
        Assert.Equal(new[] { 3 }, sequenceNumbers);
    }

    private static (MemoryStream Runtime, MemoryStream Reference) EmitBoth(string source)
    {
        var peStream = new MemoryStream();
        var refStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(source));
        var result = compilation.Emit(peStream, refStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        return (peStream, refStream);
    }

    private static byte[] SignatureOf(MemoryStream assembly, string methodName)
    {
        assembly.Position = 0;
        using var pe = new PEReader(assembly, PEStreamOptions.LeaveOpen);
        var md = pe.GetMetadataReader();
        var method = md.MethodDefinitions
            .Select(md.GetMethodDefinition)
            .Single(m => md.GetString(m.Name) == methodName);
        return md.GetBlobBytes(method.Signature);
    }
}
