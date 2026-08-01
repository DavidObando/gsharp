// <copyright file="Issue2857ExplicitGenericLambdaProjectReferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2857ExplicitGenericLambdaProjectReferenceEmitTests
{
    [Theory]
    [InlineData("i2857direct", false, 11)]
    [InlineData("i2857transitive", true, 22)]
    public void ExplicitGenericTypeArgument_WithTypedLambdaAcrossReference_Runs(
        string packageName,
        bool useIntermediateBase,
        int expected)
    {
        var baseType = packageName + ".Base";
        var intermediateDeclaration = useIntermediateBase
            ? $"open class Middle : {baseType} {{}}"
            : "";
        var derivedBase = useIntermediateBase ? "Middle" : baseType;
        var library = $$"""
            package {{packageName}}

            open class Base {
                var Value int32

                shared {
                    func Make[T Base init()](configure ((T) -> void)?) T {
                        let value = T()
                        if let apply = configure {
                            apply(value)
                        }
                        return value
                    }
                }
            }
            """;

        var consumer = $$"""
            package {{packageName}}use
            import System

            {{intermediateDeclaration}}
            class Derived : {{derivedBase}} {}

            func Main() {
                let value = {{baseType}}.Make[Derived](
                    (item Derived) -> { item.Value = {{expected}} })
                Console.WriteLine(value.Value)
            }
            """;

        Assert.Equal($"{expected}\n", CompileAndRun(library, consumer, packageName));
    }

    [Theory]
    [InlineData("i2857listdirect", false, 33)]
    [InlineData("i2857listtransitive", true, 44)]
    public void ExplicitGenericTypeArgument_WithListOfDerivedAcrossReference_Runs(
        string packageName,
        bool useIntermediateBase,
        int expected)
    {
        var baseType = packageName + ".Base";
        var intermediateDeclaration = useIntermediateBase
            ? $"open class Middle : {baseType} {{}}"
            : "";
        var derivedBase = useIntermediateBase ? "Middle" : baseType;
        var library = $$"""
            package {{packageName}}
            import System.Collections.Generic

            open class Base {}

            class Api {
                shared {
                    func Use[T Base](items List[T], result int32) int32 -> result
                }
            }
            """;

        var consumer = $$"""
            package {{packageName}}use
            import System
            import System.Collections.Generic

            {{intermediateDeclaration}}
            class Derived : {{derivedBase}} {}

            func Main() {
                let items = List[Derived]()
                items.Add(Derived())
                Console.WriteLine({{packageName}}.Api.Use[Derived](items, {{expected}}))
            }
            """;

        Assert.Equal($"{expected}\n", CompileAndRun(library, consumer, packageName));
    }

    [Fact]
    public void ExplicitGenericTypeArgument_WithUnrelatedDelegateParameterAcrossReference_Runs()
    {
        const string packageName = "i2857unrelateddelegate";
        var library = $$"""
            package {{packageName}}
            import System
            import System.Collections.Generic

            open class Base {}

            class Api {
                shared {
                    func Use[T Base](items List[T], callback Action, result int32) int32 {
                        callback()
                        return result
                    }
                }
            }
            """;

        var consumer = $$"""
            package {{packageName}}use
            import System
            import System.Collections.Generic

            class Derived : {{packageName}}.Base {}

            func Main() {
                let items = List[Derived]()
                items.Add(Derived())
                let value = {{packageName}}.Api.Use[Derived](
                    items,
                    () -> Console.WriteLine(55),
                    66)
                Console.WriteLine(value)
            }
            """;

        Assert.Equal("55\n66\n", CompileAndRun(library, consumer, packageName));
    }

    [Fact]
    public void TransitiveSlice_ToInvariantInterfaceAcrossReference_IsRejected()
    {
        const string packageName = "i2857invariantslice";
        var library = $$"""
            package {{packageName}}
            import System.Collections.Generic

            open class Base {}

            class Api {
                shared {
                    func Fill(items IList[Base]) {}
                }
            }
            """;

        var consumer = $$"""
            package {{packageName}}use
            import {{packageName}}

            open class Middle : Base {}
            class Derived : Middle {}

            func Main() {
                let items = []Derived{ Derived() }
                Api.Fill(items)
            }
            """;

        var output = CompileExpectingFailure(library, consumer, packageName);
        var diagnosticIds = Regex.Matches(output, @"\berror (GS\d{4}):")
            .Select(match => match.Groups[1].Value)
            .ToArray();
        Assert.Equal(new[] { "GS0159" }, diagnosticIds);
    }

    private static string CompileAndRun(string library, string consumer, string libraryAssemblyName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2857ExplicitGenericLambdaProjectReferenceEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs");
            var libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll");
            File.WriteAllText(librarySourcePath, library);
            Compile(new[]
            {
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath,
            });
            IlVerifier.Verify(libraryPath);

            var consumerSourcePath = Path.Combine(directory, "consumer.gs");
            var consumerPath = Path.Combine(directory, "consumer.dll");
            File.WriteAllText(consumerSourcePath, consumer);
            Compile(new[]
            {
                "/out:" + consumerPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                consumerSourcePath,
            });
            IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(consumerPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(consumerPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileExpectingFailure(string library, string consumer, string libraryAssemblyName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2857ExplicitGenericLambdaProjectReferenceEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs");
            var libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll");
            File.WriteAllText(librarySourcePath, library);
            Compile(new[]
            {
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath,
            });

            var consumerSourcePath = Path.Combine(directory, "consumer.gs");
            var consumerPath = Path.Combine(directory, "consumer.dll");
            File.WriteAllText(consumerSourcePath, consumer);
            var compilation = RunCompiler(new[]
            {
                "/out:" + consumerPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                consumerSourcePath,
            });

            Assert.NotEqual(0, compilation.ExitCode);
            return compilation.Stdout + compilation.Stderr;
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void Compile(string[] args)
    {
        var compilation = RunCompiler(args);
        Assert.True(
            compilation.ExitCode == 0,
            $"compile failed ({compilation.ExitCode})\nstdout:\n{compilation.Stdout}\nstderr:\n{compilation.Stderr}");
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, stdout.ToString(), stderr.ToString());
    }
}
