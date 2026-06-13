// <copyright file="Issue762MarshalAsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + ilverify (+ run on POSIX hosts) coverage for
/// ADR-0096 / issue #762 — per-parameter <c>@MarshalAs(UnmanagedType.…)</c>
/// overrides on P/Invoke declarations. For each accepted form the
/// test compiles a P/Invoke declaration, ilverifies the assembly, then
/// inspects the metadata to confirm <c>ParameterAttributes.HasFieldMarshal</c>
/// is set and the <c>FieldMarshal</c> blob's first byte equals the
/// expected ECMA-335 II.23.4 <c>UnmanagedType</c> token.
///
/// The execution-time test (LPArray with SizeParamIndex against libc
/// <c>memcpy</c>) is cross-platform: it runs on Linux and macOS and is
/// skipped on Windows where libc is not available under that name.
/// </summary>
public class Issue762MarshalAsEmitTests
{
    [Theory]
    [InlineData("LPStr", "string", 0x14)]
    [InlineData("LPWStr", "string", 0x15)]
    [InlineData("LPUTF8Str", "string", 0x30)]
    [InlineData("BStr", "string", 0x13)]
    [InlineData("Bool", "bool", 0x02)]
    [InlineData("VariantBool", "bool", 0x25)]
    [InlineData("I1", "int8", 0x03)]
    [InlineData("U1", "uint8", 0x04)]
    [InlineData("I2", "int16", 0x05)]
    [InlineData("U2", "uint16", 0x06)]
    [InlineData("I4", "int32", 0x07)]
    [InlineData("U4", "uint32", 0x08)]
    [InlineData("I8", "int64", 0x09)]
    [InlineData("U8", "uint64", 0x0a)]
    [InlineData("SysInt", "nint", 0x1f)]
    [InlineData("SysUInt", "nuint", 0x20)]
    public void MarshalAs_BareForm_StampsHasFieldMarshalAndCorrectBlobByte(string unmanagedType, string paramTypeText, int expectedByte)
    {
        var source = $@"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.{unmanagedType}) p {paramTypeText}) void;
";

        VerifyMarshalAsBlob(
            source,
            functionName: "native_x",
            parameterName: "p",
            expectedFirstBlobByte: (byte)expectedByte,
            expectedBlobLength: 1);
    }

    [Fact]
    public void MarshalAs_I4_OnBool_StampsHasFieldMarshal()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""set_flag"")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
";

        VerifyMarshalAsBlob(
            source,
            functionName: "native_set_flag",
            parameterName: "on",
            expectedFirstBlobByte: 0x07,
            expectedBlobLength: 1);
    }

    [Fact]
    public void MarshalAs_LPArray_WithSizeParamIndex_EncodesAsLPArrayMaxParam()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""sum_buf"")
func native_sum_buf(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_sum_buf", parameterName: "buf");
        Assert.Equal(0x2a, blob[0]); // NATIVE_TYPE_ARRAY
        Assert.Equal(0x50, blob[1]); // NATIVE_TYPE_MAX (ArraySubType unspecified)
        Assert.Equal(0x01, blob[2]); // compressed SizeParamIndex = 1
        Assert.Equal(3, blob.Length);
    }

    [Fact]
    public void MarshalAs_ByValArray_WithSizeConst_EncodesAsFixedArray()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""inline"")
func native_inline(@MarshalAs(UnmanagedType.ByValArray, SizeConst: 16) buf []uint8) void;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_inline", parameterName: "buf");
        Assert.Equal(0x1e, blob[0]); // NATIVE_TYPE_FIXEDARRAY
        Assert.Equal(0x10, blob[1]); // compressed SizeConst = 16
        Assert.Equal(2, blob.Length);
    }

    [Fact]
    public void MarshalAs_ByValTStr_WithSizeConst_EncodesAsFixedSysstring()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""take_str"")
func native_take_str(@MarshalAs(UnmanagedType.ByValTStr, SizeConst: 8) s string) void;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_take_str", parameterName: "s");
        Assert.Equal(0x17, blob[0]); // NATIVE_TYPE_FIXEDSYSSTRING
        Assert.Equal(0x08, blob[1]); // compressed SizeConst = 8
        Assert.Equal(2, blob.Length);
    }

    [Fact]
    public void MarshalAs_SafeArray_WithSafeArraySubType_EncodesVariantType()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""take_sa"")
func native_take_sa(@MarshalAs(UnmanagedType.SafeArray, SafeArraySubType: VarEnum.VT_I4) sa []int32) void;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_take_sa", parameterName: "sa");
        Assert.Equal(0x1d, blob[0]); // NATIVE_TYPE_SAFEARRAY
        Assert.Equal((byte)VarEnum.VT_I4, blob[1]); // VT_I4 == 3
        Assert.Equal(2, blob.Length);
    }

    [Fact]
    public void MarshalAs_Struct_EncodesAsStructByte()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Pt {
    var x int32
    var y int32
}

@DllImport(""libfoo"", EntryPoint: ""take_pt"")
func native_take_pt(@MarshalAs(UnmanagedType.Struct) p Pt) void;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_take_pt", parameterName: "p");
        Assert.Single(blob); // NATIVE_TYPE_STRUCT (single byte)
        Assert.Equal(0x1b, blob[0]);
    }

    [Fact]
    public void MarshalAs_LibraryImport_NonString_StampsHasFieldMarshalOnOuterParam()
    {
        // ADR-0096 §5 + ADR-0092 §6.x — @MarshalAs on a @LibraryImport
        // non-string parameter must flow into the outer-stub parameter
        // (the user-visible method) so the runtime marshaller picks up
        // the override at the inner P/Invoke boundary.
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libfoo"", EntryPoint: ""sum"")
func native_sum(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
";

        var blob = ReadMarshalAsBlob(source, functionName: "native_sum", parameterName: "buf");
        Assert.Equal(0x2a, blob[0]); // NATIVE_TYPE_ARRAY
    }

    [Fact]
    public void MarshalAs_PseudoCustomAttribute_NoCustomAttributeRowOnParam()
    {
        // ADR-0096 §5: @MarshalAs is pseudo-custom; the emitter must not
        // also write a CustomAttribute row for it on the Param row. The
        // FieldMarshal table row is the entire metadata representation.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.LPWStr) s string) void;
";

        var tempDir = Directory.CreateTempSubdirectory("gs_762_no_ca_").FullName;
        try
        {
            var (srcPath, outPath) = WriteAndCompile(tempDir, source);
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var methodDef = FindMethod(md, "native_x");
            foreach (var ph in methodDef.GetParameters())
            {
                var pdef = md.GetParameter(ph);
                if (md.GetString(pdef.Name) != "s")
                {
                    continue;
                }

                Assert.True((pdef.Attributes & ParameterAttributes.HasFieldMarshal) != 0, "expected HasFieldMarshal");
                foreach (var ca in pdef.GetCustomAttributes())
                {
                    var attr = md.GetCustomAttribute(ca);
                    var ctorH = attr.Constructor;
                    if (ctorH.Kind == HandleKind.MemberReference)
                    {
                        var mref = md.GetMemberReference((MemberReferenceHandle)ctorH);
                        if (mref.Parent.Kind == HandleKind.TypeReference)
                        {
                            var tref = md.GetTypeReference((TypeReferenceHandle)mref.Parent);
                            var name = md.GetString(tref.Name);
                            Assert.NotEqual("MarshalAsAttribute", name);
                        }
                    }
                }
            }
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

    [Fact]
    public void MarshalAs_LPArray_SizeParamIndex_MemcpyEndToEnd()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on Windows.
        }

        // ADR-0096 / issue #762 end-to-end: pass a managed `[]int32`
        // through libc memcpy using `@MarshalAs(UnmanagedType.LPArray,
        // SizeParamIndex: …)` so the runtime knows the source array
        // length. Read the written bytes back from native memory to
        // prove the marshaller honoured the override.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @DllImport("libc", EntryPoint: "memcpy")
            func native_memcpy(
                dest nint,
                @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 2) src []int32,
                n nuint) nint;

            let dest = Marshal.AllocHGlobal(16)
            let src = []int32{11, 22, 33, 44}
            native_memcpy(dest, src, UIntPtr(16))

            Console.WriteLine(Marshal.ReadInt32(dest, 0))
            Console.WriteLine(Marshal.ReadInt32(dest, 4))
            Console.WriteLine(Marshal.ReadInt32(dest, 8))
            Console.WriteLine(Marshal.ReadInt32(dest, 12))

            Marshal.FreeHGlobal(dest)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n22\n33\n44\n", output);
    }

    private static void VerifyMarshalAsBlob(string source, string functionName, string parameterName, byte expectedFirstBlobByte, int expectedBlobLength)
    {
        var blob = ReadMarshalAsBlob(source, functionName, parameterName);
        Assert.Equal(expectedFirstBlobByte, blob[0]);
        if (expectedBlobLength == 1)
        {
            Assert.Single(blob);
        }
        else
        {
            Assert.Equal(expectedBlobLength, blob.Length);
        }
    }

    private static byte[] ReadMarshalAsBlob(string source, string functionName, string parameterName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_762_blob_").FullName;
        try
        {
            var (srcPath, outPath) = WriteAndCompile(tempDir, source);
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var methodDef = FindMethod(md, functionName);
            foreach (var ph in methodDef.GetParameters())
            {
                var pdef = md.GetParameter(ph);
                if (md.GetString(pdef.Name) != parameterName)
                {
                    continue;
                }

                Assert.True(
                    (pdef.Attributes & ParameterAttributes.HasFieldMarshal) != 0,
                    $"expected ParameterAttributes.HasFieldMarshal on '{parameterName}'");

                var marshallingHandle = pdef.GetMarshallingDescriptor();
                Assert.False(marshallingHandle.IsNil, "expected a FieldMarshal blob on the parameter");
                return md.GetBlobBytes(marshallingHandle);
            }

            throw new InvalidOperationException($"parameter '{parameterName}' not found on '{functionName}'");
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

    private static MethodDefinition FindMethod(MetadataReader md, string name)
    {
        foreach (var h in md.MethodDefinitions)
        {
            var m = md.GetMethodDefinition(h);
            if (md.GetString(m.Name) == name)
            {
                return m;
            }
        }

        throw new InvalidOperationException($"method '{name}' not found");
    }

    private static (string SrcPath, string OutPath) WriteAndCompile(string tempDir, string source)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        CompileOrThrow(srcPath, outPath, target: "library");
        return (srcPath, outPath);
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_762_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "exe");
            IlVerifier.Verify(outPath);

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

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
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

    private static void CompileOrThrow(string srcPath, string outPath, string target)
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
                "/target:" + target,
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
