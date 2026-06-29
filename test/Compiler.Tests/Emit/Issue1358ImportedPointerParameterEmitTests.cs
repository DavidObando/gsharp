// <copyright file="Issue1358ImportedPointerParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1358: imported BCL methods whose parameters are <c>T*</c> or
/// <c>void*</c> must compile through emit after binding selects them.
/// </summary>
public class Issue1358ImportedPointerParameterEmitTests
{
    [Fact]
    public void Vector256Load_GenericPointerParameter_Compiles()
    {
        const string source = """
            package P
            import System.Runtime.Intrinsics

            class C {
                unsafe func G(p *uint8) {
                    let v = Vector256.Load(p)
                }
            }
            """;

        Compile(source);
    }

    [Fact]
    public void UnsafeRead_VoidPointerParameter_Compiles()
    {
        const string source = """
            package P
            import System.Runtime.CompilerServices

            class C {
                unsafe func G(p *uint8) {
                    let v = Unsafe.Read[uint8](p)
                }
            }
            """;

        Compile(source);
    }

    private static void Compile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1358_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
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
}
