// <copyright file="Issue671UserTypeAsClrGenericArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #671: user-defined G# class/interface used as
/// a type argument to a CLR generic in declaration position (field type, method
/// return type, method parameter type). Verifies that the emitted assembly loads,
/// runs, and produces correct output.
/// </summary>
public class Issue671UserTypeAsClrGenericArgEmitTests
{
    [Fact]
    public void Field_ListOfUserClass_Compiles_And_Runs()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]
            }

            let c = Container()
            Console.WriteLine("ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void MethodReturn_ListOfUserClass_Compiles()
    {
        // Verifies that a method with return type List[MyType] compiles without
        // error. IL verification of the access pattern is a follow-up concern
        // (the field signature is correctly emitted as List<MyType>).
        var source = """
            package App
            import System
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]

                func getItems() List[MyType] {
                    return items
                }
            }

            let c = Container()
            Console.WriteLine("method-return-ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("method-return-ok\n", output);
    }

    [Fact]
    public void MethodParam_ListOfUserClass_Compiles()
    {
        // Verifies that a method with parameter type List[MyType] compiles
        // without error and the assembly is IL-valid.
        var source = """
            package App
            import System
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                func accept(xs List[MyType]) {
                }
            }

            let c = Container()
            Console.WriteLine("method-param-ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("method-param-ok\n", output);
    }

    [Fact]
    public void Field_DictionaryStringAndUserClass_Compiles_And_Runs()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                lookup Dictionary[string, MyType]
            }

            let c = Container()
            Console.WriteLine("dict-ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("dict-ok\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue671_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

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
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
