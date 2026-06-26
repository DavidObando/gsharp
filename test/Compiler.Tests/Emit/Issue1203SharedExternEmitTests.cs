// <copyright file="Issue1203SharedExternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit coverage for ADR-0086 / issue #1203: a static
/// <c>@DllImport</c> extern declared inside a class's <c>shared { }</c> block
/// (the C# <c>static extern</c> equivalent) lowers to a CLR <c>Static</c> +
/// <c>PinvokeImpl</c> method with an <c>ImplMap</c> row. The bodyless static
/// member used to crash the compiler with GS9998; this pins the emitted
/// metadata, including the raw-pointer parameters allowed by the enclosing
/// <c>unsafe</c> class.
/// </summary>
public class Issue1203SharedExternEmitTests
{
    [Fact]
    public void StaticDllImportExtern_InUnsafeClass_EmitsPinvokeImplMethod()
    {
        const string source = """
            package p
            import System.Runtime.InteropServices

            unsafe class C {
                shared {
                    @DllImport("kernel32", SetLastError: true)
                    func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_shared_extern_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var foundPInvoke = false;
            foreach (var h in md.MethodDefinitions)
            {
                var m = md.GetMethodDefinition(h);
                if (md.GetString(m.Name) != "ReadFile")
                {
                    continue;
                }

                foundPInvoke = true;
                Assert.True((m.Attributes & System.Reflection.MethodAttributes.Static) == System.Reflection.MethodAttributes.Static);
                Assert.True((m.Attributes & System.Reflection.MethodAttributes.PinvokeImpl) == System.Reflection.MethodAttributes.PinvokeImpl);

                var import = m.GetImport();
                Assert.False(import.Module.IsNil);
                Assert.Equal("kernel32", md.GetString(md.GetModuleReference(import.Module).Name));
                Assert.Equal("ReadFile", md.GetString(import.Name));
                Assert.True((import.Attributes & System.Reflection.MethodImportAttributes.SetLastError) == System.Reflection.MethodImportAttributes.SetLastError);

                var declaringType = md.GetString(md.GetTypeDefinition(m.GetDeclaringType()).Name);
                Assert.Equal("C", declaringType);
            }

            Assert.True(foundPInvoke, "expected an emitted static P/Invoke method named ReadFile on class C");
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
