// <copyright file="MethodSpecCacheUserTypeArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #420 (P3-7): regression test verifying that the
/// <c>ReflectionMetadataEmitter</c> MethodSpec cache deduplicates rows when the
/// same generic method is referenced multiple times with the same user-defined
/// type as the generic argument. Previously the cache was bypassed entirely
/// whenever any generic argument was a user-type symbol, producing duplicate
/// MethodSpec rows. The metadata was still valid but bloated.
/// </summary>
public class MethodSpecCacheUserTypeArgsEmitTests
{
    [Fact]
    public void RepeatedGenericCallWithSameUserTypeArg_EmitsSingleMethodSpecRow()
    {
        // Three calls to Array.Empty[Clock]() — they must all resolve to the
        // same MethodSpec row, not three distinct rows.
        var source = """
            package P
            import System

            type Clock class {
                Ticks int32
            }

            var a = Array.Empty[Clock]()
            var b = Array.Empty[Clock]()
            var c = Array.Empty[Clock]()
            Console.WriteLine(a.Length + b.Length + c.Length)
            """;

        var outPath = CompileToDll(source);

        using var pe = new PEReader(File.OpenRead(outPath));
        var reader = pe.GetMetadataReader();

        // Count MethodSpec rows whose parent MemberRef name is "Empty".
        var emptySpecCount = CountMethodSpecsByName(reader, "Empty");
        Assert.Equal(1, emptySpecCount);
    }

    [Fact]
    public void DistinctUserTypeArgs_StillProduceDistinctMethodSpecRows()
    {
        // Two distinct user types as generic args must still emit two
        // separate MethodSpec rows — the cache fix must not over-deduplicate.
        var source = """
            package P
            import System

            type ClockA class {
                Ticks int32
            }

            type ClockB class {
                Ticks int32
            }

            var a = Array.Empty[ClockA]()
            var b = Array.Empty[ClockB]()
            Console.WriteLine(a.Length + b.Length)
            """;

        var outPath = CompileToDll(source);

        using var pe = new PEReader(File.OpenRead(outPath));
        var reader = pe.GetMetadataReader();

        var emptySpecCount = CountMethodSpecsByName(reader, "Empty");
        Assert.Equal(2, emptySpecCount);
    }

    private static int CountMethodSpecsByName(MetadataReader reader, string name)
    {
        var count = 0;
        var rowCount = reader.GetTableRowCount(TableIndex.MethodSpec);
        for (var rid = 1; rid <= rowCount; rid++)
        {
            var handle = MetadataTokens.MethodSpecificationHandle(rid);
            var spec = reader.GetMethodSpecification(handle);
            if (spec.Method.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var memberRef = reader.GetMemberReference((MemberReferenceHandle)spec.Method);
            if (reader.GetString(memberRef.Name) == name)
            {
                count++;
            }
        }

        return count;
    }

    private static string CompileToDll(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_methodspec_cache_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = System.Console.Out;
        var prevErr = System.Console.Error;
        System.Console.SetOut(compileOut);
        System.Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            System.Console.SetOut(prevOut);
            System.Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        return outPath;
    }
}
