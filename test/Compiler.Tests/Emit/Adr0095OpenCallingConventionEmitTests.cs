// <copyright file="Adr0095OpenCallingConventionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit coverage for ADR-0095 v2 / issue #3611 — the open CLR
/// calling-convention model. The blob facts are pinned against csc
/// (.NET 10): bare <c>unmanaged</c> encodes convention byte <c>0x09</c>
/// with no modopts; a convention list encodes <c>0x09</c> plus
/// <c>CallConv{Name}</c> optional modifiers on the return type in
/// <b>source order</b>; a single legacy name keeps its legacy
/// convention byte. Every emitted assembly must also pass ilverify.
/// </summary>
public class Adr0095OpenCallingConventionEmitTests
{
    private const byte FnPtr = 0x1B; // ELEMENT_TYPE_FNPTR
    private const byte Unmanaged = 0x09; // SignatureCallingConvention.Unmanaged
    private const byte CModOpt = 0x20; // ELEMENT_TYPE_CMOD_OPT

    [Fact]
    public void BareUnmanaged_EncodesUnmanagedConventionWithoutModopts()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc")
            func bare(cb unmanaged () -> void) void;
            """;

        var sig = EmitAndReadPInvokeSignature(source, "bare");
        int at = IndexOfFnPtr(sig);

        // FNPTR | Unmanaged | 0 params | ELEMENT_TYPE_VOID — csc-identical.
        Assert.Equal(Unmanaged, sig[at + 1]);
        Assert.Equal(0x00, sig[at + 2]);
        Assert.Equal((byte)SignatureTypeCode.Void, sig[at + 3]);
    }

    [Fact]
    public void SingleLegacyConvention_KeepsLegacyByteWithoutModopts()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc")
            func legacy(cb unmanaged[Cdecl] (nint, nint) -> int32) void;
            """;

        var sig = EmitAndReadPInvokeSignature(source, "legacy");
        int at = IndexOfFnPtr(sig);

        // FNPTR | CDecl (0x01) | 2 params | int32 return, no modopts.
        Assert.Equal(0x01, sig[at + 1]);
        Assert.Equal(0x02, sig[at + 2]);
        Assert.Equal((byte)SignatureTypeCode.Int32, sig[at + 3]);
    }

    [Fact]
    public void CombinedConventions_EmitReturnTypeModoptsInSourceOrder()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc")
            func combined(cb unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32) void;
            """;

        var (sig, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "combined");
        int at = IndexOfFnPtr(sig);

        Assert.Equal(Unmanaged, sig[at + 1]);
        Assert.Equal(0x01, sig[at + 2]);
        Assert.Equal(CModOpt, sig[at + 3]);
        Assert.Equal(new[] { "CallConvCdecl", "CallConvSuppressGCTransition" }, modoptNames);
    }

    [Fact]
    public void CombinedConventions_ReversedSourceOrder_ReversesModopts()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc")
            func reversed(cb unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32) void;
            """;

        var (_, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "reversed");
        Assert.Equal(new[] { "CallConvSuppressGCTransition", "CallConvCdecl" }, modoptNames);
    }

    [Fact]
    public void SingleNonLegacyConvention_EmitsUnmanagedPlusModopt()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @DllImport("libc")
            func suppress(cb unmanaged[SuppressGCTransition] (int32) -> int32) void;
            """;

        var (sig, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "suppress");
        int at = IndexOfFnPtr(sig);

        Assert.Equal(Unmanaged, sig[at + 1]);
        Assert.Equal(new[] { "CallConvSuppressGCTransition" }, modoptNames);
    }

    private static int IndexOfFnPtr(byte[] signature)
    {
        int at = Array.IndexOf(signature, FnPtr);
        Assert.True(at >= 0, "expected an ELEMENT_TYPE_FNPTR byte in the P/Invoke signature");
        return at;
    }

    private static byte[] EmitAndReadPInvokeSignature(string source, string functionName)
        => EmitAndInspect(source, functionName, (sig, _) => sig);

    private static (byte[] Signature, IReadOnlyList<string> ModoptNames) EmitAndReadPInvokeSignatureWithModopts(string source, string functionName)
        => EmitAndInspect(source, functionName, (sig, names) => (sig, names));

    private static T EmitAndInspect<T>(
        string source,
        string functionName,
        Func<byte[], IReadOnlyList<string>, T> project)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3611_cc_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath);
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                if (md.GetString(m.Name) != functionName)
                {
                    continue;
                }

                var sig = md.GetBlobBytes(m.Signature);
                return project(sig, ReadModoptNamesInBlobOrder(md, sig));
            }

            throw new Xunit.Sdk.XunitException($"expected an emitted P/Invoke method named {functionName}");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    /// <summary>
    /// Decodes the type names of the return-type <c>CMOD_OPT</c> run that
    /// follows the FNPTR header (<c>1B | conv | param-count</c>), in blob
    /// order. Blob order IS source order for the open calling-convention
    /// model (pinned against csc), so decoding the bytes directly — rather
    /// than through a signature provider whose modifier collection order is
    /// unspecified — is the point of the test.
    /// </summary>
    private static IReadOnlyList<string> ReadModoptNamesInBlobOrder(MetadataReader md, byte[] signature)
    {
        var names = new List<string>();
        int i = Array.IndexOf(signature, FnPtr);
        if (i < 0)
        {
            return names;
        }

        i += 3; // skip FNPTR, convention byte, and the (single-byte) param count
        while (i < signature.Length && signature[i] == CModOpt)
        {
            int coded = DecodeCompressedInteger(signature, i + 1, out int tokenLength);
            var handle = UncompressTypeDefOrRef(coded);
            if (handle.Kind == HandleKind.TypeReference)
            {
                names.Add(md.GetString(md.GetTypeReference((TypeReferenceHandle)handle).Name));
            }

            i += 1 + tokenLength;
        }

        return names;
    }

    private static int DecodeCompressedInteger(byte[] blob, int offset, out int length)
    {
        byte first = blob[offset];
        if ((first & 0x80) == 0)
        {
            length = 1;
            return first;
        }

        if ((first & 0xC0) == 0x80)
        {
            length = 2;
            return ((first & 0x3F) << 8) | blob[offset + 1];
        }

        length = 4;
        return ((first & 0x1F) << 24) | (blob[offset + 1] << 16) | (blob[offset + 2] << 8) | blob[offset + 3];
    }

    private static EntityHandle UncompressTypeDefOrRef(int coded)
    {
        int rowId = coded >> 2;
        return (coded & 0x3) switch
        {
            0 => MetadataTokens.EntityHandle(TableIndex.TypeDef, rowId),
            1 => MetadataTokens.EntityHandle(TableIndex.TypeRef, rowId),
            _ => MetadataTokens.EntityHandle(TableIndex.TypeSpec, rowId),
        };
    }

    private static void CompileOrThrow(string srcPath, string outPath)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
