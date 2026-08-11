// <copyright file="Issue2838GenericPointerStrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2838: pointer arithmetic over a pointer to an <c>unmanaged</c>-constrained
/// generic type parameter silently used a hard-coded 8-byte stride.
/// <para>
/// An open <c>TypeParameterSymbol</c> has no
/// reference-context CLR type (its <c>ClrType</c> is <c>null</c>), so the
/// pointee-size classifier did not see a value type and fell back to the
/// <c>nint.Size</c> literal. Every instantiation — <c>*uint8</c>, <c>*uint16</c>,
/// <c>*int32</c> — therefore scaled by 8. That is a WRONG-ANSWER bug, not merely a
/// verification failure, so these tests execute the emitted code and assert the
/// computed strides rather than only inspecting metadata.
/// </para>
/// <para>
/// A secondary defect in the same report: <c>fixed p *T = span</c> emitted the
/// <c>GetPinnableReference()</c> MemberRef parented at the erased
/// <c>Span`1&lt;object&gt;</c> while the receiver on the stack was
/// <c>Span`1&lt;!!T&gt;</c>. The parent must be a TypeSpec naming the type
/// parameter.
/// </para>
/// </summary>
public class Issue2838GenericPointerStrideEmitTests
{
    // Raw-pointer code is unverifiable by design. This is the established
    // tolerated set for the `fixed` pinnable-reference form (see
    // Issue1043FixedPinnableEmitTests): `conv.u` on the pinned `T&` is exactly
    // what C# emits and is inherently unverifiable. Listing only these codes
    // keeps unrelated verification regressions failing the test.
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
        "ExpectedNumericType",
    };

    /// <summary>
    /// The headline regression: <c>(p + 1) - p</c> over <c>*T</c> must advance by
    /// <c>sizeof(T)</c>. Before the fix every instantiation printed <c>8</c>.
    /// </summary>
    [Fact]
    public void PointerDifference_OverGenericUnmanaged_UsesRuntimeStride()
    {
        var source = """
            package Probe

            import System

            class Stride {
                shared {
                    func PointerStride[T unmanaged](xs Span[T]) int64 {
                        unsafe {
                            var d int64 = 0
                            fixed p *T = xs {
                                d = int64((p + 1)) - int64(p)
                            }
                            return d
                        }
                    }
                }
            }

            func run() {
                Console.WriteLine(Stride.PointerStride[uint8]([8]uint8))
                Console.WriteLine(Stride.PointerStride[uint16]([8]uint16))
                Console.WriteLine(Stride.PointerStride[int32]([8]int32))
                Console.WriteLine(Stride.PointerStride[int64]([8]int64))
            }

            run()
            """;

        var output = CompileAndRun(source, UnsafeIlVerifyIgnored);
        Assert.Equal($"1{Environment.NewLine}2{Environment.NewLine}4{Environment.NewLine}8{Environment.NewLine}", output);
    }

    /// <summary>
    /// Covers the other consumer of the pointee-size helper: scaling a
    /// non-constant offset (<c>p + n</c>) rather than a literal <c>+ 1</c>.
    /// </summary>
    [Fact]
    public void PointerOffset_OverGenericUnmanaged_ScalesByElementSize()
    {
        var source = """
            package Probe

            import System

            class Stride {
                shared {
                    func OffsetDelta[T unmanaged](xs Span[T], n int32) int64 {
                        unsafe {
                            var d int64 = 0
                            fixed p *T = xs {
                                d = int64((p + n)) - int64(p)
                            }
                            return d
                        }
                    }
                }
            }

            func run() {
                Console.WriteLine(Stride.OffsetDelta[uint8]([8]uint8, 3))
                Console.WriteLine(Stride.OffsetDelta[uint16]([8]uint16, 3))
                Console.WriteLine(Stride.OffsetDelta[int32]([8]int32, 3))
                Console.WriteLine(Stride.OffsetDelta[int64]([8]int64, 3))
            }

            run()
            """;

        var output = CompileAndRun(source, UnsafeIlVerifyIgnored);
        Assert.Equal($"3{Environment.NewLine}6{Environment.NewLine}12{Environment.NewLine}24{Environment.NewLine}", output);
    }

    /// <summary>
    /// Metadata-level guard for both defects, so a future regression is diagnosed
    /// at the IL shape rather than only as a wrong printed number:
    /// the stride must be the <c>sizeof</c> opcode (never a baked-in
    /// <c>ldc.i4.8</c>), and the <c>GetPinnableReference</c> MemberRef must be
    /// parented at a TypeSpec that names the method type parameter.
    /// </summary>
    [Fact]
    public void GenericPointerWalk_EmitsSizeOfOpcodeAndSymbolicPinnableParent()
    {
        var source = """
            package Probe

            import System

            class Stride {
                shared {
                    func PointerStride[T unmanaged](xs Span[T]) int64 {
                        unsafe {
                            var d int64 = 0
                            fixed p *T = xs {
                                d = int64((p + 1)) - int64(p)
                            }
                            return d
                        }
                    }
                }
            }

            func run() {
                Console.WriteLine(Stride.PointerStride[int32]([8]int32))
            }

            run()
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var il = GetMethodIl(pe, md, "PointerStride");

            // ECMA-335 III.1.2.1: `sizeof` is the two-byte prefixed opcode
            // 0xFE 0x1C. Its presence proves the stride is computed from the
            // runtime type token rather than a compile-time constant.
            Assert.True(
                ContainsSequence(il, 0xFE, 0x1C),
                "PointerStride must scale by the `sizeof` opcode over the generic type token.");

            // `ldc.i4.8; conv.i` (0x1E 0xD3) was the exact erased-stride
            // emission. Matching the pair rather than the bare constant avoids
            // false positives from 0x1E appearing inside a metadata token.
            Assert.False(
                ContainsSequence(il, 0x1E, 0xD3),
                "PointerStride must not bake in an 8-byte stride.");

            AssertPinnableReferenceParentNamesTypeParameter(md);
        }
        finally
        {
            TryDeleteDir(tempDir);
        }
    }

    private static void AssertPinnableReferenceParentNamesTypeParameter(MetadataReader md)
    {
        var found = false;
        foreach (var mrh in md.MemberReferences)
        {
            var mr = md.GetMemberReference(mrh);
            if (md.GetString(mr.Name) != "GetPinnableReference")
            {
                continue;
            }

            found = true;

            // The receiver is `Span[T]`, so the parent must be a TypeSpec — a
            // plain TypeRef parent would be the erased `Span<object>`.
            Assert.True(
                mr.Parent.Kind == HandleKind.TypeSpecification,
                $"GetPinnableReference parent must be a TypeSpecification, was {mr.Parent.Kind}.");

            var spec = md.GetTypeSpecification((TypeSpecificationHandle)mr.Parent);
            var blob = md.GetBlobBytes(spec.Signature);

            // ECMA-335 II.23.1.16: ELEMENT_TYPE_MVAR (0x1E) — the method-level
            // generic parameter `!!T`. Its absence means the argument erased.
            Assert.Contains((byte)0x1E, blob);
        }

        Assert.True(found, "no GetPinnableReference MemberRef found in emitted metadata");
    }

    private static byte[] GetMethodIl(PEReader pe, MetadataReader md, string methodName)
    {
        foreach (var mh in md.MethodDefinitions)
        {
            var mdef = md.GetMethodDefinition(mh);
            if (md.GetString(mdef.Name) != methodName || mdef.RelativeVirtualAddress == 0)
            {
                continue;
            }

            return pe.GetMethodBody(mdef.RelativeVirtualAddress).GetILBytes()
                ?? throw new InvalidOperationException($"method '{methodName}' has no IL body");
        }

        throw new InvalidOperationException($"method '{methodName}' not found in emitted metadata");
    }

    private static bool ContainsSequence(byte[] haystack, params byte[] needle)
    {
        for (var i = 0; i + needle.Length <= haystack.Length; i++)
        {
            var match = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j])
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

    /// <summary>
    /// Issue #2838 symptom 2: passing a `*T` to an imported generic method
    /// (`Vector256.Load[T](*T)`) must infer <c>T</c>, not the erased
    /// <c>object</c>. Before the fix the open pointer parameter matched none of
    /// the unifier's structural forms, so the MethodSpec closed over
    /// <c>System.Object</c> — emitting <c>Vector256::Load&lt;System.Object&gt;</c>,
    /// which is not a constructible instantiation and failed verification with
    /// <c>StackUnexpected</c>. This mirrors the real
    /// <c>Oahu.Decrypt.Mpeg4.Util.HelperExtensions</c> shape.
    /// </summary>
    [Fact]
    public void GenericPointerArgument_ToImportedGenericMethod_InfersTypeParameter()
    {
        var source = """
            package Probe

            import System
            import System.Runtime.Intrinsics

            class V {
                shared {
                    func AllLessOrEqual[T unmanaged](ints Span[T], comparand Vector256[T]) bool {
                        unsafe {
                            var ok = true
                            fixed p *T = ints {
                                let v = Vector256.Load(p)
                                ok = Vector256.LessThanOrEqualAll(v, comparand)
                            }
                            return ok
                        }
                    }
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var specCount = md.GetTableRowCount(TableIndex.MethodSpec);
            Assert.True(specCount > 0, "expected at least one MethodSpec for the generic Vector256 calls");

            var sawLoad = false;
            for (var i = 1; i <= specCount; i++)
            {
                var spec = md.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(i));
                if (spec.Method.Kind != HandleKind.MemberReference)
                {
                    continue;
                }

                var name = md.GetString(md.GetMemberReference((MemberReferenceHandle)spec.Method).Name);
                var blob = md.GetBlobBytes(spec.Signature);

                // ECMA-335 II.23.2.15: GENERICINST (0x0A), argument count, then
                // each argument. `1E 00` is MVAR(0) — the method type parameter.
                // `1C` is ELEMENT_TYPE_OBJECT, the erasure this test guards.
                Assert.False(
                    Array.IndexOf(blob, (byte)0x1C) >= 0,
                    $"MethodSpec for '{name}' closed over the erased System.Object: {BitConverter.ToString(blob)}");

                if (name == "Load")
                {
                    sawLoad = true;
                    Assert.True(
                        ContainsSequence(blob, 0x1E, 0x00),
                        $"Vector256.Load must close over the method type parameter, was {BitConverter.ToString(blob)}");
                }
            }

            Assert.True(sawLoad, "no MethodSpec found for Vector256.Load");
        }
        finally
        {
            TryDeleteDir(tempDir);
        }
    }

    private static void CompileOrThrow(string srcPath, string outPath, string target = "exe")
    {
        var args = new[]
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            srcPath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
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

    private static string CompileAndRun(string source, string[] ignoredIlVerifyCodes)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            CompileOrThrow(srcPath, outPath);
            IlVerifier.Verify(outPath, null, ignoredIlVerifyCodes);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            TryDeleteDir(tempDir);
        }
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
            // ignored
        }
    }
}
