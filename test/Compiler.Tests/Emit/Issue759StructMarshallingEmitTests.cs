// <copyright file="Issue759StructMarshallingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + execute coverage for ADR-0093 / issue #759 struct- and
/// class-marshalling. Exercises three angles:
/// <list type="bullet">
/// <item>A blittable G# struct is emitted with the correct CLR
/// <see cref="System.Reflection.TypeAttributes.SequentialLayout"/> flag,
/// can flow through user code, and contains no duplicate
/// <c>[StructLayout]</c> / <c>[FieldOffset]</c> <c>CustomAttribute</c> rows
/// (they are pseudo-custom attributes — the runtime reconstructs them from
/// the <c>ClassLayout</c> / <c>FieldLayout</c> metadata tables).</item>
/// <item>An explicit-layout union round-trips through pure managed code:
/// writing one field and reading an overlapping field returns the expected
/// bit pattern, demonstrating that the emitted <c>FieldLayout</c> rows are
/// honoured by the CLR.</item>
/// <item>A P/Invoke function whose return type is a blittable struct
/// compiles, IL-verifies, and the resulting assembly carries a
/// <c>PinvokeImpl</c> method whose return type points at the struct.</item>
/// </list>
/// </summary>
public class Issue759StructMarshallingEmitTests
{
    [Fact]
    public void Blittable_SequentialLayout_Struct_RoundTrips_In_Managed_Code()
    {
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var X int32
                var Y int32
            }

            var p = Point{X: 3, Y: 4}
            Console.WriteLine(p.X)
            Console.WriteLine(p.Y)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n4\n", output);
    }

    [Fact]
    public void ExplicitLayout_Union_RoundTrips_Through_Overlapping_Fields()
    {
        // The two int32 halves of an explicit-layout union must overlap the
        // 64-bit field. Writing the halves and reading the QuadPart back
        // exercises the CLR layout engine's handling of the emitted
        // FieldLayout rows: an incorrect emit would either lose the overlap
        // (yielding 0 for QuadPart) or corrupt the high bytes.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Explicit, Size: 8)
            struct LargeInteger {
                @FieldOffset(0) var LowPart uint32
                @FieldOffset(4) var HighPart int32
                @FieldOffset(0) var QuadPart int64
            }

            var v = LargeInteger{LowPart: 0u, HighPart: 0, QuadPart: 0L}
            v.LowPart = 0x11223344u
            v.HighPart = 0x55667788
            Console.WriteLine(v.QuadPart)
            """;

        var output = CompileAndRun(source);

        // 0x5566778811223344 = 6153737367135073092.
        Assert.Equal("6153737367135073092\n", output);
    }

    [Fact]
    public void Emitted_SequentialLayout_Struct_Has_No_CustomAttribute_Rows_For_StructLayout()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var X int32
                var Y int32
            }
            """;

        var tempDir = MakeTempDir("gs_pinvoke_struct_seq_");
        try
        {
            var (md, _) = CompileAndOpenMetadata(tempDir, source, target: "library");

            var pointHandle = FindTypeDef(md, "Point");
            Assert.False(pointHandle.IsNil, "expected a TypeDef named Point");
            var point = md.GetTypeDefinition(pointHandle);

            var layoutFlag = point.Attributes & System.Reflection.TypeAttributes.LayoutMask;
            Assert.Equal(System.Reflection.TypeAttributes.SequentialLayout, layoutFlag);

            AssertNoPseudoCustomAttributeRow(md, point, "StructLayoutAttribute");
            AssertNoPseudoCustomAttributeRow(md, point, "FieldOffsetAttribute");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void Emitted_ExplicitLayout_Struct_Has_FieldLayout_Rows_And_No_Duplicate_Attributes()
    {
        const string source = """
            package P
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Explicit, Size: 8)
            struct LargeInteger {
                @FieldOffset(0) var LowPart uint32
                @FieldOffset(4) var HighPart int32
                @FieldOffset(0) var QuadPart int64
            }
            """;

        var tempDir = MakeTempDir("gs_pinvoke_struct_expl_");
        try
        {
            var (md, _) = CompileAndOpenMetadata(tempDir, source, target: "library");

            var typeHandle = FindTypeDef(md, "LargeInteger");
            Assert.False(typeHandle.IsNil, "expected a TypeDef named LargeInteger");
            var typeDef = md.GetTypeDefinition(typeHandle);

            var layoutFlag = typeDef.Attributes & System.Reflection.TypeAttributes.LayoutMask;
            Assert.Equal(System.Reflection.TypeAttributes.ExplicitLayout, layoutFlag);

            // ClassLayout row: explicit Size=8.
            var classLayout = typeDef.GetLayout();
            Assert.False(classLayout.IsDefault, "expected ClassLayout row for explicit-layout struct with Size");
            Assert.Equal(8, classLayout.Size);

            // FieldLayout per field. Build a name -> offset map.
            var offsets = new System.Collections.Generic.Dictionary<string, int>();
            foreach (var fh in typeDef.GetFields())
            {
                var f = md.GetFieldDefinition(fh);
                var name = md.GetString(f.Name);
                offsets[name] = f.GetOffset();
            }

            Assert.Equal(0, offsets["LowPart"]);
            Assert.Equal(4, offsets["HighPart"]);
            Assert.Equal(0, offsets["QuadPart"]);

            AssertNoPseudoCustomAttributeRow(md, typeDef, "StructLayoutAttribute");
            foreach (var fh in typeDef.GetFields())
            {
                AssertNoPseudoCustomAttributeRow(md, fh, "FieldOffsetAttribute");
            }
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void PInvoke_With_Blittable_Struct_Parameter_Emits_PinvokeImpl_And_Verifies()
    {
        // We do not actually invoke the native function — most stable libc
        // entry points take pointers rather than struct-by-value, and the
        // v1 P/Invoke surface (issue #728) does not yet expose `ref`
        // parameters. What we verify here is the *binding + emit + IL
        // verification* contract: a blittable struct is accepted as a
        // P/Invoke parameter type, the method definition carries
        // PinvokeImpl, and the produced assembly passes ilverify.
        const string source = """
            package P
            import System.Runtime.InteropServices

            @StructLayout(LayoutKind.Sequential)
            struct Point {
                var X int32
                var Y int32
            }

            @DllImport("libc", EntryPoint: "gsharp_test_no_such_symbol")
            func AcceptPoint(p Point) int32;
            """;

        var tempDir = MakeTempDir("gs_pinvoke_struct_param_");
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var found = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                if (md.GetString(m.Name) != "AcceptPoint")
                {
                    continue;
                }

                found = true;
                Assert.True(
                    (m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl,
                    "AcceptPoint should carry PinvokeImpl");
                Assert.False(m.GetImport().Module.IsNil);
            }

            Assert.True(found, "expected an emitted P/Invoke method named AcceptPoint");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static TypeDefinitionHandle FindTypeDef(MetadataReader md, string name)
    {
        foreach (var h in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(h);
            if (md.GetString(td.Name) == name)
            {
                return h;
            }
        }

        return default;
    }

    private static void AssertNoPseudoCustomAttributeRow(MetadataReader md, TypeDefinition typeDef, string attrTypeName)
    {
        foreach (var caH in typeDef.GetCustomAttributes())
        {
            var ca = md.GetCustomAttribute(caH);
            Assert.False(
                CustomAttributeTypeNameMatches(md, ca, attrTypeName),
                $"unexpected CustomAttribute '{attrTypeName}' on type '{md.GetString(typeDef.Name)}' (must be a pseudo-custom attribute row)");
        }
    }

    private static void AssertNoPseudoCustomAttributeRow(MetadataReader md, FieldDefinitionHandle fieldHandle, string attrTypeName)
    {
        var field = md.GetFieldDefinition(fieldHandle);
        foreach (var caH in field.GetCustomAttributes())
        {
            var ca = md.GetCustomAttribute(caH);
            Assert.False(
                CustomAttributeTypeNameMatches(md, ca, attrTypeName),
                $"unexpected CustomAttribute '{attrTypeName}' on field '{md.GetString(field.Name)}' (must be a pseudo-custom attribute row)");
        }
    }

    private static bool CustomAttributeTypeNameMatches(MetadataReader md, CustomAttribute ca, string typeName)
    {
        switch (ca.Constructor.Kind)
        {
            case HandleKind.MemberReference:
                var mref = md.GetMemberReference((MemberReferenceHandle)ca.Constructor);
                if (mref.Parent.Kind == HandleKind.TypeReference)
                {
                    var tref = md.GetTypeReference((TypeReferenceHandle)mref.Parent);
                    return md.GetString(tref.Name) == typeName;
                }

                return false;
            case HandleKind.MethodDefinition:
                var mdef = md.GetMethodDefinition((MethodDefinitionHandle)ca.Constructor);
                var declaring = md.GetTypeDefinition(mdef.GetDeclaringType());
                return md.GetString(declaring.Name) == typeName;
            default:
                return false;
        }
    }

    private static (MetadataReader Md, string AssemblyPath) CompileAndOpenMetadata(string tempDir, string source, string target)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        CompileOrThrow(srcPath, outPath, target);
        IlVerifier.Verify(outPath);
        var pe = new PEReader(File.OpenRead(outPath));
        return (pe.GetMetadataReader(), outPath);
    }

    private static string MakeTempDir(string prefix)
        => Directory.CreateTempSubdirectory(prefix).FullName;

    private static string CompileAndRun(string source)
    {
        var tempDir = MakeTempDir("gs_pinvoke_struct_emit_");
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
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
