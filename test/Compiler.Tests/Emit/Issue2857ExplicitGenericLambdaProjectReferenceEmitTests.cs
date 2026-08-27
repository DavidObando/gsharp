// <copyright file="Issue2857ExplicitGenericLambdaProjectReferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2857ExplicitGenericLambdaProjectReferenceEmitTests
{
    [Theory]
    [InlineData("i2857topdirect", false, false, 11)]
    [InlineData("i2857toptransitive", true, false, 22)]
    [InlineData("i2857funcdirect", false, true, 33)]
    [InlineData("i2857functransitive", true, true, 44)]
    public void ExplicitGenericTypeArgument_WithTypedLambdaAcrossReference_Runs(
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
        var entryPointStart = useFunction ? "func Main() {" : "";
        var entryPointEnd = useFunction ? "}" : "";
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

            {{entryPointStart}}
            let value = {{baseType}}.Make[Derived](
                (item Derived) -> { item.Value = {{expected}} })
            Console.WriteLine(value.Value)
            {{entryPointEnd}}
            """;

        Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
    }

    [Theory]
    [InlineData("i2857arraytransitive", 1, 77)]
    [InlineData("i2857arraydepth3", 3, 99)]
    public void ExplicitGenericTypeArgument_WithDelegateArrayAcrossReference_Runs(
        string packageName,
        int inheritanceDepth,
        int expected)
    {
        var baseType = packageName + ".Base";
        var intermediateDeclarations = string.Join(
            "\n",
            Enumerable.Range(1, inheritanceDepth).Select(index =>
                $"open class Middle{index} : {(index == 1 ? baseType : $"Middle{index - 1}")} {{}}"));
        var library = $$"""
            package {{packageName}}

            open class Base {
                var Value int32

                shared {
                    func Make[T Base init()](configure []((T) -> void)) T {
                        let value = T()
                        for apply in configure {
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

            {{intermediateDeclarations}}
            class Derived : Middle{{inheritanceDepth}} {}

            func Main() {
                let value = {{baseType}}.Make[Derived](
                    []((Derived) -> void){
                        (item Derived) -> { item.Value = {{expected}} }
                    })
                Console.WriteLine(value.Value)
            }
            """;

        Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
    }

    [Theory]
    [InlineData("i3178jagged2", 2, 7)]
    [InlineData("i3178jagged3", 3, 8)]
    public void ExplicitGenericTypeArgument_WithJaggedDelegateArrayAcrossReference_Runs(
        string packageName,
        int arrayDepth,
        int expected)
    {
        var libraryArrayType = string.Concat(Enumerable.Repeat("[]", arrayDepth)) + "((T) -> void)";
        var consumerDelegateType = "((Derived) -> void)";
        var consumerArrayType = string.Concat(Enumerable.Repeat("[]", arrayDepth)) + consumerDelegateType;
        var callback = $"(item Derived) -> {{ item.Value = {expected} }}";
        for (var depth = 1; depth < arrayDepth; depth++)
        {
            var nestedType = string.Concat(Enumerable.Repeat("[]", depth)) + consumerDelegateType;
            callback = $"{nestedType}{{ {callback} }}";
        }

        var indices = string.Concat(Enumerable.Repeat("[0]", arrayDepth));
        var library = $$"""
            package {{packageName}}

            open class Base {
                var Value int32

                shared {
                    func Make[T Base init()](configure {{libraryArrayType}}) T {
                        let value = T()
                        configure{{indices}}(value)
                        return value
                    }
                }
            }
            """;
        var consumer = $$"""
            package {{packageName}}use
            import System

            class Derived : {{packageName}}.Base {}

            func Main() {
                let value = {{packageName}}.Base.Make[Derived](
                    {{consumerArrayType}}{ {{callback}} })
                Console.WriteLine(value.Value)
            }
            """;

        Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
    }

    [Theory]
    [InlineData("i2857arity0", 0, 22)]
    [InlineData("i2857arity1", 1, 11)]
    [InlineData("i2857arity2", 2, 33)]
    [InlineData("i2857arity3", 3, 44)]
    [InlineData("i2857arity4", 4, 55)]
    public void ExplicitGenericTypeArgument_WithDelegateArityAcrossReference_Runs(
        string packageName,
        int arity,
        int expected)
    {
        var delegateType = arity == 0
            ? "(() -> T)"
            : $"((T{string.Concat(Enumerable.Repeat(", int32", arity - 1))}) -> void)";
        var invocation = arity == 0
            ? "return callback()"
            : $$"""
                let value = T()
                callback(value{{string.Concat(Enumerable.Repeat(", 0", arity - 1))}})
                return value
                """;
        var lambda = arity == 0
            ? $$"""
                () -> {
                    let value = Derived()
                    value.Value = {{expected}}
                    return value
                }
                """
            : $$"""
                (item Derived{{string.Concat(Enumerable.Range(1, arity - 1).Select(index => $", arg{index} int32"))}}) -> {
                    item.Value = {{expected}}
                }
                """;
        var library = $$"""
            package {{packageName}}

            open class Base {
                var Value int32

                shared {
                    func Make[T Base init()](callback {{delegateType}}) T {
                        {{invocation}}
                    }
                }
            }
            """;
        var consumer = $$"""
            package {{packageName}}use
            import System

            open class Middle : {{packageName}}.Base {}
            class Derived : Middle {}

            func Main() {
                let value = {{packageName}}.Base.Make[Derived]({{lambda}})
                Console.WriteLine(value.Value)
            }
            """;

        Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
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

        Assert.Equal($"{expected}{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
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

        Assert.Equal($"55{Environment.NewLine}66{Environment.NewLine}", CompileAndRun(library, consumer, packageName));
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

    // Issue #3501: this shape was pinned as REJECTED (GS0159) while
    // `SatisfiesClassConstraint` could not see a source class deriving an
    // imported base — the constraint failure was the loud guard for the
    // then-unclosable delegate-in-constructed-generic. With the constraint
    // fixed the call closes, ilverifies, and runs (the configure delegate
    // observably mutates the constructed T), so the guard flips to a
    // behavior assertion.
    [Fact]
    public void ExplicitGenericTypeArgument_WithDelegateInConstructedGenericAcrossReference_Runs()
    {
        const string PackageName = "i3178constructedgeneric";
        var library = $$"""
            package {{PackageName}}
            import System.Collections.Generic

            open class Base {
                var Value int32

                shared {
                    func Make[T Base init()](configure List[((T) -> void)]) T {
                        let value = T()
                        configure[0](value)
                        return value
                    }
                }
            }
            """;
        var consumer = $$"""
            package {{PackageName}}use
            import System.Collections.Generic

            class Derived : {{PackageName}}.Base {}

            func Main() {
                let configure = List[((Derived) -> void)]()
                configure.Add((item Derived) -> { item.Value = 9 })
                let made = {{PackageName}}.Base.Make[Derived](configure)
                System.Console.WriteLine(made.Value)
            }
            """;

        Assert.Equal($"9{Environment.NewLine}", CompileAndRun(library, consumer, PackageName));
    }

    private static string CompileAndRun(string library, string consumer, string libraryAssemblyName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2857ExplicitGenericLambdaProjectReferenceEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
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
            AssertLoads(libraryPath, consumerPath);

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
            return stdout.ReplaceLineEndings(Environment.NewLine);
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
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
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

    private static void AssertLoads(string libraryPath, string consumerPath)
    {
        var loadContext = new AssemblyLoadContext(
            nameof(Issue2857ExplicitGenericLambdaProjectReferenceEmitTests)
            + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        try
        {
            var library = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (_, name) =>
                name.Name == library.GetName().Name ? library : null;
            Assert.NotEmpty(library.GetTypes());
            Assert.NotEmpty(loadContext.LoadFromAssemblyPath(consumerPath).GetTypes());
        }
        finally
        {
            loadContext.Unload();
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
