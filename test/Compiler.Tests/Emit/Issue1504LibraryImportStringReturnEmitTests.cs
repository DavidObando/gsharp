// <copyright file="Issue1504LibraryImportStringReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit + execute + ilverify coverage for issue #1504 (ADR-0092 §2): an
/// <c>@LibraryImport</c> function whose return type is <c>string</c>. The
/// inner blittable P/Invoke returns the raw native pointer (encoded as
/// <c>IntPtr</c>); the outer managed stub materializes a managed
/// <c>string</c> via <see cref="Marshal.PtrToStringUTF8(IntPtr)"/> /
/// <see cref="Marshal.PtrToStringUni(IntPtr)"/> per the resolved
/// <see cref="StringMarshalling"/>. The returned native buffer is
/// non-owning (the native side owns it, e.g. <c>getenv</c>), so the stub
/// never frees it — only marshalled string <em>parameters</em> are freed in
/// the <c>finally</c>.
/// </summary>
public class Issue1504LibraryImportStringReturnEmitTests
{
    [Fact]
    public void StringReturn_Utf8_GetenvRoundTrip_ReturnsManagedString()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on platforms without libc
        }

        // setenv + getenv are POSIX and share the process environ, so the
        // round-trip is deterministic and memory-safe: getenv returns a
        // pointer owned by libc that the stub never frees.
        const string source = """
            package P1504U8RoundTrip
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "setenv", StringMarshalling: StringMarshalling.Utf8)
            func set_env_u8(name string, value string, overwrite int32) int32;

            @LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
            func get_env_u8(name string) string;

            var rc = set_env_u8("GS_ISSUE_1504_U8", "round-trip-value", 1)
            Console.WriteLine(get_env_u8("GS_ISSUE_1504_U8"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("round-trip-value\n", output);
    }

    [Fact]
    public void StringReturn_Utf8_MissingEnv_ReturnsNilString()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // getenv on an unset name returns IntPtr.Zero; PtrToStringUTF8 maps
        // that to null, so the managed value compares equal to `nil`.
        const string source = """
            package P1504U8Missing
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
            func get_env_missing_u8(name string) string;

            var v = get_env_missing_u8("GS_ISSUE_1504_DOES_NOT_EXIST")
            Console.WriteLine(v == nil)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    [Fact]
    public void StringReturn_Utf8_WithParam_OuterReturnsString_InnerReturnsIntPtr_MaterializesAndDoesNotFreeReturn()
    {
        const string source = """
            package P1504U8Shape
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
            func GetEnvShapeU8(name string) string;
            """;

        AssertStubShape(
            source,
            outerName: "GetEnvShapeU8",
            expectedConvert: "StringToCoTaskMemUTF8",
            expectedMaterialize: "PtrToStringUTF8",
            expectedConvertCount: 1,
            expectedFreeCount: 1,
            expectedMaterializeCount: 1);
    }

    [Fact]
    public void StringReturn_Utf16_WithParam_OuterReturnsString_InnerReturnsIntPtr_UsesPtrToStringUni()
    {
        const string source = """
            package P1504U16Shape
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "wide_lookup", StringMarshalling: StringMarshalling.Utf16)
            func WideLookupU16(key string) string;
            """;

        AssertStubShape(
            source,
            outerName: "WideLookupU16",
            expectedConvert: "StringToCoTaskMemUni",
            expectedMaterialize: "PtrToStringUni",
            expectedConvertCount: 1,
            expectedFreeCount: 1,
            expectedMaterializeCount: 1);
    }

    [Fact]
    public void StringReturn_Utf8_ReturnOnly_NoParams_DoesNotFreeReturn()
    {
        // No string parameters → the stub never allocates or frees a
        // CoTaskMem buffer, and crucially never frees the return pointer.
        const string source = """
            package P1504U8ReturnOnly
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getprogname", StringMarshalling: StringMarshalling.Utf8)
            func GetProgNameU8() string;
            """;

        AssertStubShape(
            source,
            outerName: "GetProgNameU8",
            expectedConvert: "StringToCoTaskMemUTF8",
            expectedMaterialize: "PtrToStringUTF8",
            expectedConvertCount: 0,
            expectedFreeCount: 0,
            expectedMaterializeCount: 1);
    }

    [Fact]
    public void StringReturn_Utf16_ReturnOnly_NoParams_DoesNotFreeReturn()
    {
        const string source = """
            package P1504U16ReturnOnly
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "wide_progname", StringMarshalling: StringMarshalling.Utf16)
            func WideProgNameU16() string;
            """;

        AssertStubShape(
            source,
            outerName: "WideProgNameU16",
            expectedConvert: "StringToCoTaskMemUni",
            expectedMaterialize: "PtrToStringUni",
            expectedConvertCount: 0,
            expectedFreeCount: 0,
            expectedMaterializeCount: 1);
    }

    private static void AssertStubShape(
        string source,
        string outerName,
        string expectedConvert,
        string expectedMaterialize,
        int expectedConvertCount,
        int expectedFreeCount,
        int expectedMaterializeCount)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1504_shape_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();
            var provider = new NameSignatureProvider(md);

            byte[] outerIl = null;
            var foundOuter = false;
            var foundInner = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                var name = md.GetString(m.Name);
                if (name == outerName)
                {
                    foundOuter = true;

                    // Outer stub is managed (NOT PinvokeImpl) and its
                    // user-visible signature returns a managed string.
                    Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == 0);
                    var sig = m.DecodeSignature(provider, genericContext: null);
                    Assert.Equal("String", sig.ReturnType);

                    Assert.NotEqual(-1, m.RelativeVirtualAddress);
                    outerIl = pe.GetMethodBody(m.RelativeVirtualAddress).GetILBytes();
                }
                else if (name.Contains(outerName) && name.Contains("PInvoke"))
                {
                    foundInner = true;

                    // Inner blittable P/Invoke returns the raw native pointer.
                    Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl);
                    var sig = m.DecodeSignature(provider, genericContext: null);
                    Assert.Equal("IntPtr", sig.ReturnType);
                }
            }

            Assert.True(foundOuter, $"expected an emitted outer stub named {outerName}");
            Assert.True(foundInner, $"expected an emitted inner P/Invoke for {outerName}");
            Assert.NotNull(outerIl);

            var marshalCalls = CollectMarshalCalls(outerIl, md);
            Assert.Equal(expectedMaterializeCount, CountCall(marshalCalls, expectedMaterialize));
            Assert.Equal(expectedConvertCount, CountCall(marshalCalls, expectedConvert));
            Assert.Equal(expectedFreeCount, CountCall(marshalCalls, "FreeCoTaskMem"));

            // The non-owning return policy: the materialize helper is called,
            // but the return pointer is never routed through FreeCoTaskMem.
            // FreeCoTaskMem appears exactly once per marshalled *parameter*.
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

    private static int CountCall(IReadOnlyDictionary<string, int> calls, string name)
        => calls.TryGetValue(name, out var n) ? n : 0;

    /// <summary>
    /// Walks the outer stub's IL, resolving every <c>call</c> (0x28) token to
    /// a <see cref="MemberReference"/> whose parent type is
    /// <see cref="Marshal"/>, and returns the multiset of member names called.
    /// Tokens that do not resolve to a Marshal MemberRef (e.g. the inner
    /// P/Invoke MethodDef call, or a 0x28 byte that is part of an operand) are
    /// ignored.
    /// </summary>
    private static Dictionary<string, int> CollectMarshalCalls(byte[] il, MetadataReader md)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i + 4 < il.Length; i++)
        {
            if (il[i] != 0x28)
            {
                continue; // ECMA-335 `call`
            }

            var token = BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 1, 4));
            EntityHandle handle;
            try
            {
                handle = MetadataTokens.EntityHandle(token);
            }
            catch (ArgumentException)
            {
                continue;
            }

            if (handle.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            MemberReference mr;
            try
            {
                mr = md.GetMemberReference((MemberReferenceHandle)handle);
            }
            catch
            {
                continue;
            }

            if (mr.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var parent = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
            if (md.GetString(parent.Name) != "Marshal")
            {
                continue;
            }

            var memberName = md.GetString(mr.Name);
            result[memberName] = (result.TryGetValue(memberName, out var c) ? c : 0) + 1;
        }

        return result;
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1504_emit_").FullName;
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

    /// <summary>
    /// Minimal <see cref="ISignatureTypeProvider{TType, TGenericContext}"/> that
    /// renders each referenced type by name so the test can assert the outer
    /// stub returns <c>String</c> while the inner P/Invoke returns
    /// <c>IntPtr</c>.
    /// </summary>
    private sealed class NameSignatureProvider : ISignatureTypeProvider<string, object>
    {
        private readonly MetadataReader reader;

        public NameSignatureProvider(MetadataReader reader)
        {
            this.reader = reader;
        }

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";

        public string GetByReferenceType(string elementType) => "ref " + elementType;

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => genericType + "<...>";

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader metadataReader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            var def = metadataReader.GetTypeDefinition(handle);
            var ns = metadataReader.GetString(def.Namespace);
            var name = metadataReader.GetString(def.Name);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        public string GetTypeFromReference(MetadataReader metadataReader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            var typeRef = metadataReader.GetTypeReference(handle);
            var ns = metadataReader.GetString(typeRef.Namespace);
            var name = metadataReader.GetString(typeRef.Name);
            return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
        }

        public string GetTypeFromSpecification(MetadataReader metadataReader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) => "spec";
    }
}
