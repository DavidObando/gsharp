// <copyright file="Issue2852GenericUnmanagedStackAllocEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2852: runtime and metadata coverage for
/// <c>stackalloc [n]T</c> under <c>T unmanaged</c>.
/// </summary>
public class Issue2852GenericUnmanagedStackAllocEmitTests
{
    private static readonly string[] StackAllocIlVerifyIgnored =
    {
        "Unverifiable",
    };

    [Fact]
    public void GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize()
    {
        var outputPath = CompileLibrary(Source, nameof(GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize));
        IlVerifier.Verify(outputPath, null, StackAllocIlVerifyIgnored);

        var loadContext = new AssemblyLoadContext(
            nameof(GenericUnmanagedStackAlloc_WritesAndReadsUsingRuntimeElementSize),
            isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(outputPath);
            var probe = assembly.GetType("Probe.StackAllocProbe")
                ?? throw new InvalidOperationException("StackAllocProbe type not found.");

            Assert.Equal(7, probe.GetMethod("Byte")!.Invoke(null, null));
            Assert.Equal(123456, probe.GetMethod("Int32")!.Invoke(null, null));
            Assert.Equal(9876543210L, probe.GetMethod("Int64")!.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
            TryDeleteDirectory(Path.GetDirectoryName(outputPath)!);
        }
    }

    [Fact]
    public void GenericUnmanagedStackAlloc_EmitsSymbolicSizeAndSpanConstructor()
    {
        var outputPath = CompileLibrary(Source, nameof(GenericUnmanagedStackAlloc_EmitsSymbolicSizeAndSpanConstructor));
        try
        {
            using var pe = new PEReader(File.OpenRead(outputPath));
            var metadata = pe.GetMetadataReader();
            var il = GetMethodIl(pe, metadata, "RoundTrip");
            var sizeOfOperands = GetSizeOfOperands(il);

            Assert.NotEmpty(sizeOfOperands);
            foreach (var operand in sizeOfOperands)
            {
                Assert.Equal(HandleKind.TypeSpecification, operand.Kind);
                var signature = metadata.GetBlobBytes(
                    metadata.GetTypeSpecification((TypeSpecificationHandle)operand).Signature);
                Assert.True(
                    ContainsSequence(signature, 0x1E, 0x00),
                    $"sizeof operand must name method type parameter !!0: {BitConverter.ToString(signature)}");
            }

            Assert.True(
                HasSymbolicSpanConstructor(metadata),
                "Span constructor parent must be a TypeSpec closed over method type parameter !!0.");
        }
        finally
        {
            TryDeleteDirectory(Path.GetDirectoryName(outputPath)!);
        }
    }

    private const string Source = """
        package Probe

        public class StackAllocProbe {
            shared {
                public func RoundTrip[T unmanaged](value T) T {
                    var values = stackalloc [4]T
                    values[3] = value
                    return values[3]
                }

                public func Byte() int32 -> int32(RoundTrip[uint8](uint8(7)))
                public func Int32() int32 -> RoundTrip[int32](123456)
                public func Int64() int64 -> RoundTrip[int64](9876543210)
            }
        }
        """;

    private static string CompileLibrary(string source, string testName)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2852_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var args = new[]
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            sourcePath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        Assert.True(
            exitCode == 0,
            $"{testName}: gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        return outputPath;
    }

    private static byte[] GetMethodIl(PEReader pe, MetadataReader metadata, string methodName)
    {
        foreach (var handle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(handle);
            if (metadata.GetString(method.Name) == methodName && method.RelativeVirtualAddress != 0)
            {
                return pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
                    ?? throw new InvalidOperationException($"Method '{methodName}' has no IL body.");
            }
        }

        throw new InvalidOperationException($"Method '{methodName}' not found.");
    }

    private static List<EntityHandle> GetSizeOfOperands(byte[] il)
    {
        var operands = new List<EntityHandle>();
        for (var i = 0; i + 5 < il.Length; i++)
        {
            if (il[i] != 0xFE || il[i + 1] != 0x1C)
            {
                continue;
            }

            var token = BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 2, 4));
            operands.Add(MetadataTokens.EntityHandle(token));
            i += 5;
        }

        return operands;
    }

    private static bool HasSymbolicSpanConstructor(MetadataReader metadata)
    {
        foreach (var handle in metadata.MemberReferences)
        {
            var member = metadata.GetMemberReference(handle);
            if (metadata.GetString(member.Name) != ".ctor"
                || member.Parent.Kind != HandleKind.TypeSpecification)
            {
                continue;
            }

            var signature = metadata.GetBlobBytes(
                metadata.GetTypeSpecification((TypeSpecificationHandle)member.Parent).Signature);
            if (ContainsSequence(signature, 0x1E, 0x00))
            {
                return true;
            }
        }

        return false;
    }

    private static bool ContainsSequence(byte[] bytes, params byte[] sequence)
    {
        for (var i = 0; i + sequence.Length <= bytes.Length; i++)
        {
            var match = true;
            for (var j = 0; j < sequence.Length; j++)
            {
                if (bytes[i + j] != sequence[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
            // ignored
        }
    }
}
