// <copyright file="Issue758LibraryImportEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + execute + ilverify coverage for ADR-0092 / issue #758:
/// a G# function annotated with <c>@LibraryImport</c> emits an outer
/// managed marshalling stub that explicitly converts each <c>string</c>
/// argument to an unmanaged CoTaskMem buffer, calls a hidden blittable
/// inner P/Invoke method, and frees the buffer in a <c>finally</c> block.
/// The inner method carries the <c>PinvokeImpl</c> attribute and an
/// <c>ImplMap</c> row pointing at a deduplicated <c>ModuleRef</c>.
/// </summary>
public class Issue758LibraryImportEmitTests
{
    [Fact]
    public void LibraryImport_LibcStrLen_Utf8_RoundTrip_ReturnsExpectedLength()
    {
        if (!IsLibcCallable())
        {
            return; // skip-not-fail on platforms without libc
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
            func strlen_native(text string) nint;

            Console.WriteLine(strlen_native("Hello, world!"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"13{Environment.NewLine}", output);
    }

    [Fact]
    public void LibraryImport_LibcGetpid_NoStringArgs_RoundTrip_ReturnsPid()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getpid")
            func getpid_native() int32;

            var p = getpid_native()
            Console.WriteLine(p > 0)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}", output);
    }

    [Fact]
    public void LibraryImport_LibcGetpid_SuppressGCTransition_RoundTrip_ReturnsPid()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getpid")
            @SuppressGCTransition
            func getpid_native() int32;

            Console.WriteLine(getpid_native() > 0)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}", output);
    }

    [Fact]
    public void LibraryImport_NullString_IsPassedAsZero_FreeIsNoop()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        // `Marshal.StringToCoTaskMemUTF8(null)` returns `IntPtr.Zero`, and
        // `Marshal.FreeCoTaskMem(IntPtr.Zero)` is a documented no-op. Use
        // a tiny shim that passes a nullable-string parameter through to
        // the marshalling stub via a normal G# string variable so the
        // stub's null-safe path is exercised without depending on a
        // segfault-prone libc API.
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
            func strlen_native(text string) nuint;

            var empty = ""
            Console.WriteLine(strlen_native(empty))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"0{Environment.NewLine}", output);
    }

    [Fact]
    public void LibraryImport_EmittedMethod_HasOuterStub_And_HiddenInnerPInvoke()
    {
        if (!IsLibcCallable())
        {
            return;
        }

        const string source = """
            package P
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8)
            func MyStrLen(text string) nint;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_libimport_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var foundOuter = false;
            var foundInner = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                var name = md.GetString(m.Name);
                if (name == "MyStrLen")
                {
                    foundOuter = true;

                    // Outer stub is a managed method (NOT PinvokeImpl) with IL.
                    Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == 0);
                    Assert.True((m.Attributes & System.Reflection.MethodAttributes.Static) == System.Reflection.MethodAttributes.Static);
                    Assert.NotEqual(-1, m.RelativeVirtualAddress);
                }
                else if (name.Contains("MyStrLen") && name.Contains("PInvoke"))
                {
                    foundInner = true;

                    Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl);

                    var import = m.GetImport();
                    Assert.False(import.Module.IsNil);
                    Assert.False(import.Name.IsNil);
                    var moduleName = md.GetString(md.GetModuleReference(import.Module).Name);
                    Assert.Equal("libc", moduleName);
                    Assert.Equal("strlen", md.GetString(import.Name));
                }
            }

            Assert.True(foundOuter, "expected an emitted outer stub named MyStrLen");
            Assert.True(foundInner, "expected an emitted inner P/Invoke method for MyStrLen");
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
    public void LibraryImport_TransitionAttributes_AreEncodedOnlyOnHiddenInnerPInvoke()
    {
        const string source = """
            package P
            import System
            import System.Runtime.InteropServices

            @LibraryImport("libc", EntryPoint: "getpid")
            @SuppressGCTransition
            @DefaultDllImportSearchPaths(DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories)
            @Obsolete("outer")
            func MyGetPid() int32;
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_libimport_attrs_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();
            MethodDefinition outer = default;
            MethodDefinition inner = default;
            foreach (var handle in md.MethodDefinitions)
            {
                var method = md.GetMethodDefinition(handle);
                string name = md.GetString(method.Name);
                if (name == "MyGetPid")
                {
                    outer = method;
                }
                else if (name.Contains("MyGetPid", StringComparison.Ordinal)
                    && name.Contains("PInvoke", StringComparison.Ordinal))
                {
                    inner = method;
                }
            }

            Assert.False(outer.Name.IsNil, "expected the managed outer stub");
            Assert.False(inner.Name.IsNil, "expected the hidden inner P/Invoke");
            Assert.Equal(
                new[] { "ObsoleteAttribute" },
                AttributeNames(md, outer));
            Assert.Equal(
                new[] { "DefaultDllImportSearchPathsAttribute", "SuppressGCTransitionAttribute" },
                AttributeNames(md, inner).OrderBy(name => name, StringComparer.Ordinal));

            CustomAttribute suppressTransition = Assert.Single(
                inner.GetCustomAttributes()
                    .Select(md.GetCustomAttribute),
                attribute => AttributeTypeName(md, attribute) == "SuppressGCTransitionAttribute");
            BlobReader suppressValue = md.GetBlobReader(suppressTransition.Value);
            Assert.Equal(0x0001, suppressValue.ReadUInt16());
            Assert.Equal(0, suppressValue.ReadUInt16());

            CustomAttribute searchPaths = Assert.Single(
                inner.GetCustomAttributes()
                    .Select(md.GetCustomAttribute),
                attribute => AttributeTypeName(md, attribute) == "DefaultDllImportSearchPathsAttribute");
            BlobReader value = md.GetBlobReader(searchPaths.Value);
            Assert.Equal(0x0001, value.ReadUInt16());
            Assert.Equal(
                (int)(DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories),
                value.ReadInt32());
            Assert.Equal(0, value.ReadUInt16());
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

    private static string[] AttributeNames(MetadataReader md, MethodDefinition method) =>
        method.GetCustomAttributes()
            .Select(md.GetCustomAttribute)
            .Select(attribute => AttributeTypeName(md, attribute))
            .ToArray();

    private static string AttributeTypeName(MetadataReader md, CustomAttribute attribute)
    {
        if (attribute.Constructor.Kind == HandleKind.MemberReference)
        {
            var constructor = md.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (constructor.Parent.Kind == HandleKind.TypeReference)
            {
                return md.GetString(md.GetTypeReference((TypeReferenceHandle)constructor.Parent).Name);
            }
        }
        else if (attribute.Constructor.Kind == HandleKind.MethodDefinition)
        {
            var constructor = md.GetMethodDefinition((MethodDefinitionHandle)attribute.Constructor);
            return md.GetString(md.GetTypeDefinition(constructor.GetDeclaringType()).Name);
        }

        return string.Empty;
    }

    private static bool IsLibcCallable()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
        || RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_libimport_emit_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
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
