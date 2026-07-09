// <copyright file="Issue1235TypeParameterObjectInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #1235 (write side / object-initializer
/// follow-up to <c>Issue988TypeParameterConstructionEmitTests</c>): a
/// composite literal <c>T{Member: value, ...}</c> on a type parameter <c>T</c>
/// constrained <c>where T : class, new()</c> — the generic counterpart of
/// C#'s <c>new T { Member = value }</c> object-initializer, and the plain
/// assignment form <c>t.Member = value</c> on a variable typed as a
/// constrained type parameter. This is the exact shape `cs2gs` emits for a
/// C# generic factory method such as
/// <c>Oahu.Core.BookLibrary.AddPersons&lt;TPerson&gt;</c>
/// (<c>where TPerson : class, IPerson, new()</c>) that does
/// <c>new TPerson { Asin = ..., Name = ... }</c>.
/// </summary>
public class Issue1235TypeParameterObjectInitializerEmitTests
{
    [Fact]
    public void ObjectInitializerLiteral_ClassConstraint_ConstructsAndAssignsProperty()
    {
        var source = """
            package T
            import System
            open class Base { prop P int32 { get; set; } }
            func Make[T Base init()]() T { return T{P: 42} }
            Console.WriteLine(Make[Base]().P.ToString())
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ObjectInitializerLiteral_ClassConstraint_ConstructsAndAssignsField()
    {
        var source = """
            package T
            import System
            open class Base { var F int32 }
            func Make[T Base init()]() T { return T{F: 7} }
            Console.WriteLine(Make[Base]().F.ToString())
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void ObjectInitializerLiteral_InterfaceConstraint_ConstructsAndAssignsProperty()
    {
        var source = """
            package T
            import System
            interface IHasName { prop Name string { get; set; } }
            open class Named : IHasName { prop Name string { get; set; } }
            func Make[T IHasName init()]() T { return T{Name: "Alice"} }
            Console.WriteLine(Make[Named]().Name)
            """;

        Assert.Equal("Alice\n", CompileAndRun(source));
    }

    [Fact]
    public void VariableReceiver_ClassConstraint_PropertyAssignment_Roundtrips()
    {
        // The plain-assignment counterpart of the object-initializer literal —
        // `var p T = T(); p.P = value` — the shape a translated
        // multi-statement C# object initializer lowers to.
        var source = """
            package T
            import System
            open class Base { prop P int32 { get; set; } }
            func Make[T Base init()]() T {
                var p T = T()
                p.P = 99
                return p
            }
            Console.WriteLine(Make[Base]().P.ToString())
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void VariableReceiver_ClassConstraint_FieldAssignment_Roundtrips()
    {
        var source = """
            package T
            import System
            open class Base { var F int32 }
            func Make[T Base init()]() T {
                var p T = T()
                p.F = 123
                return p
            }
            Console.WriteLine(Make[Base]().F.ToString())
            """;

        Assert.Equal("123\n", CompileAndRun(source));
    }

    [Fact]
    public void VariableReceiver_InterfaceConstraint_PropertyAssignment_Roundtrips()
    {
        var source = """
            package T
            import System
            interface IHasName { prop Name string { get; set; } }
            open class Named : IHasName { prop Name string { get; set; } }
            func Make[T IHasName init()]() T {
                var p T = T()
                p.Name = "Carol"
                return p
            }
            Console.WriteLine(Make[Named]().Name)
            """;

        Assert.Equal("Carol\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1235_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var (compileExit, compileText) = RunCompiler(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileText}");
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
            TryDeleteDirectory(tempDir);
        }
    }

    private static (int Exit, string Output) RunCompiler(string[] args)
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
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (compileExit, compileOut.ToString() + compileErr.ToString());
    }

    private static void TryDeleteDirectory(string dir)
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch
        {
        }
    }
}
