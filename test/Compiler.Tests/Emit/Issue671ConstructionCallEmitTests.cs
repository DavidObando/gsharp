// <copyright file="Issue671ConstructionCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for the construction-call follow-up of issue #671:
/// a CLR generic invoked as a constructor with one or more G# user-defined
/// type arguments (e.g. <c>List[MyGs]()</c>, <c>Dictionary[string, MyGs]()</c>,
/// nested generics, fully-qualified type names) compiles, IL-verifies, and
/// runs.
/// </summary>
public class Issue671ConstructionCallEmitTests
{
    [Fact]
    public void Construct_ListOfUserClass_Compiles_And_Runs()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            let xs = List[MyGs]()
            xs.Add(MyGs())
            xs.Add(MyGs())
            Console.WriteLine(xs.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void Construct_ListOfUserInterface_Compiles_And_Runs()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            interface IMyGs {
                func GetName() string
            }

            let xs = List[IMyGs]()
            Console.WriteLine(xs.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void Construct_KeyValuePairOfStringToUserClass_Compiles_And_Runs()
    {
        // Multi-type-arg CLR generic ctor where one type argument is a G#
        // user-defined class. The direct Dictionary[K, V]() coverage for
        // this same shape lives in Issue693DictionaryConstructionEmitTests
        // (the follow-up to this PR); KeyValuePair is kept here as a
        // narrowly-typed sibling regression for the multi-arg construction
        // path itself.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            let kvp = KeyValuePair[string, MyGs]("k", MyGs())
            Console.WriteLine(kvp.Key)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("k\n", output);
    }

    [Fact]
    public void Construct_NestedListOfListOfUserClass_Compiles_And_Runs()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            let outer = List[List[MyGs]]()
            outer.Add(List[MyGs]())
            outer[0].Add(MyGs())
            Console.WriteLine(outer.Count)
            Console.WriteLine(outer[0].Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n1\n", output);
    }

    [Fact]
    public void Construct_QualifiedListOfUserClass_Compiles_And_Runs()
    {
        var source = """
            package App
            import System

            class MyGs {
                var Name string = ""
            }

            let xs = System.Collections.Generic.List[MyGs]()
            xs.Add(MyGs())
            Console.WriteLine(xs.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void Construct_ListOfClrType_Regression_StillWorks()
    {
        // Regression guard: a CLR-only type argument (no symbolic substitution)
        // must continue to bind and emit through the existing happy path.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[int32]()
            xs.Add(1)
            xs.Add(2)
            xs.Add(3)
            Console.WriteLine(xs.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void Construct_ListOfString_Regression_StillWorks()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[string]()
            xs.Add("a")
            xs.Add("b")
            Console.WriteLine(xs.Count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue671_ctor_").FullName;
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
