// <copyright file="Issue2542DelegateFactoryCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2542: factory function values may covary their return type, but their
/// parameter types remain invariant.
/// </summary>
public class Issue2542DelegateFactoryCovarianceEmitTests
{
    [Fact]
    public void FunctionValueAndLambda_ConcreteReturnToInterfaceFactory_Run()
    {
        var output = CompileAndRun("""
            package P

            interface IProduct {
                func Name() string;
            }

            class Product : IProduct {
                func Name() string { return "product" }
            }

            func Make() Product { return Product() }
            func Use(factory () -> IProduct) string { return factory().Name() }

            func Main() {
                let factory () -> Product = Make
                System.Console.WriteLine(Use(factory))
                System.Console.WriteLine(Use(() -> Product()))
            }
            """);

        Assert.Equal("product\nproduct\n", output);
    }

    [Fact]
    public void NarrowerFactoryParameter_IsRejected()
    {
        var (exit, diagnostics) = TryCompile("""
            package P

            interface IAnimal { }
            class Dog : IAnimal { }
            class Cat : IAnimal { }

            func DescribeDog(value Dog) string { return "dog" }
            func Use(factory (IAnimal) -> string) string { return factory(Cat()) }

            func Main() {
                let factory (Dog) -> string = DescribeDog
                System.Console.WriteLine(Use(factory))
            }
            """);

        Assert.NotEqual(0, exit);
        Assert.Contains("GS0154", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var dir = Directory.CreateTempSubdirectory("gs_2542_run_").FullName;
        try
        {
            var path = Path.Combine(dir, "test.gs");
            var output = Path.Combine(dir, "test.dll");
            File.WriteAllText(path, source);

            var (exit, diagnostics) = RunCompiler(path, output, "exe");
            Assert.True(exit == 0, diagnostics);
            IlVerifier.Verify(output);

            File.WriteAllText(Path.ChangeExtension(output, "runtimeconfig.json"), """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var start = new ProcessStartInfo("dotnet", "exec \"" + output + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = Process.Start(start)!;
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.True(process.ExitCode == 0, stderr);
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Diagnostics) TryCompile(string source)
    {
        var dir = Directory.CreateTempSubdirectory("gs_2542_compile_").FullName;
        try
        {
            var path = Path.Combine(dir, "test.gs");
            var output = Path.Combine(dir, "test.dll");
            File.WriteAllText(path, source);
            return RunCompiler(path, output, "exe");
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Diagnostics) RunCompiler(string source, string output, string target)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exit = Program.Main(new[]
            {
                "/out:" + output,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                source,
            });
            return (exit, stdout.ToString() + stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }
}
