// <copyright file="Issue2857ExplicitGenericLambdaProjectReferenceInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

[Collection("ConsoleIo")]
public sealed class Issue2857ExplicitGenericLambdaProjectReferenceInterpreterTests
{
    [Theory]
    [InlineData("i2857interptopdirect", false, false, 11)]
    [InlineData("i2857interptoptransitive", true, false, 22)]
    [InlineData("i2857interpfuncdirect", false, true, 33)]
    [InlineData("i2857interpfunctransitive", true, true, 44)]
    public void ExplicitGenericTypeArgument_WithTypedLambdaAcrossReference_Evaluates(
        string packageName,
        bool useIntermediateBase,
        bool useFunction,
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
        var consumer = useFunction
            ? $$"""
                package {{packageName}}use
                import System

                {{intermediateDeclaration}}
                class Derived : {{derivedBase}} {}

                func Read() int32 {
                    let value = {{baseType}}.Make[Derived](
                        (item Derived) -> { item.Value = {{expected}} })
                    return value.Value
                }

                Console.WriteLine(Read())
                """
            : $$"""
                package {{packageName}}use
                import System

                {{intermediateDeclaration}}
                class Derived : {{derivedBase}} {}

                let value = {{baseType}}.Make[Derived](
                    (item Derived) -> { item.Value = {{expected}} })
                Console.WriteLine(value.Value)
                """;

        using var peStream = new MemoryStream();
        var emitResult = new Compilation(SyntaxTree.Parse(library)).Emit(
            peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: packageName);
        Assert.True(
            emitResult.Success,
            "library emit failed:\n" + string.Join("\n", emitResult.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        _ = Assembly.Load(peStream.ToArray());
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2857ExplicitGenericLambdaProjectReferenceInterpreterTests),
            packageName);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "consumer.gs");
        File.WriteAllText(sourcePath, consumer);
        try
        {
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            try
            {
                Console.SetOut(stdout);
                Console.SetError(stderr);
                Assert.Equal(0, GSharp.Repl.Program.Main(new[] { sourcePath }));
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.Equal(string.Empty, stderr.ToString());
            Assert.Equal(
                $"{expected}\n",
                stdout.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
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
}
