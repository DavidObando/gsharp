// <copyright file="Issue2820ImportedGenericNullableFunctionParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2820ImportedGenericNullableFunctionParameterEmitTests
{
    [Fact]
    public void TwoProjectCompile_PreservesNullableFunctionParameterAfterGenericSubstitution()
    {
        const string librarySource = """
            package Issue2820.Lib

            class Book {
            }

            class Job[T] {
                func Run(context T, action ((Book, T) -> void)?) {
                }
            }
            """;
        const string appSource = """
            package Issue2820.App
            import Issue2820.Lib

            class Ctx {
            }

            class Use {
                func M() {
                    let job = Job[Ctx]()
                    var act ((Book, Ctx) -> void)? = nil
                    job.Run(Ctx(), act)
                    job.Run(Ctx(), nil)
                }
            }
            """;

        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2820",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = Compile(directory, "Issue2820.Lib", librarySource);
            _ = Compile(directory, "Issue2820.App", appSource, libraryPath);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Compile(
        string directory,
        string assemblyName,
        string source,
        string reference = null)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        var arguments = new System.Collections.Generic.List<string>
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
        };
        if (reference != null)
        {
            arguments.Add("/reference:" + reference);
        }

        arguments.Add(sourcePath);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(arguments.ToArray());
            Assert.True(
                exitCode == 0,
                $"compile failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return outputPath;
    }
}
