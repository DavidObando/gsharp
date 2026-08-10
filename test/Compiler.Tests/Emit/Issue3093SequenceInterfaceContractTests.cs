// <copyright file="Issue3093SequenceInterfaceContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3093SequenceInterfaceContractTests
{
    [Fact]
    public void UserInterface_IteratorAndExplicitSequence_DispatchRunAndIlVerify()
    {
        const string Source = """
            package Issue3093.User
            import System
            import System.Collections.Generic

            func One(value int32) sequence[int32] {
                yield value
            }

            interface IDetector {
                func Detect(text string) IEnumerable[int32];
                func DetectExplicit(text string) IEnumerable[int32];
            }

            class Detector : IDetector {
                func Detect(text string) sequence[int32] {
                    yield text.Length
                }

                func DetectExplicit(text string) sequence[int32] {
                    return One(text.Length)
                }
            }

            var detector IDetector = Detector{}
            for value in detector.Detect("abc") {
                Console.WriteLine(value)
            }
            for value in detector.DetectExplicit("abc") {
                Console.WriteLine(value)
            }
            """;

        WithDirectory(directory =>
        {
            var assemblyPath = Compile(Source, directory);
            Assert.Equal($"3{Environment.NewLine}3{Environment.NewLine}", Run(assemblyPath));

            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            var detector = assembly.GetType("Issue3093.User.Detector");
            Assert.NotNull(detector);
            Assert.All(
                new[] { "Detect", "DetectExplicit" },
                name => Assert.Equal(
                    typeof(IEnumerable<int>),
                    detector!.GetMethod(name, BindingFlags.Public | BindingFlags.Instance)!.ReturnType));

            var stateMachine = detector!.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic)
                .Single(type => type.Name.StartsWith("<Detect>d__", StringComparison.Ordinal));
            Assert.Contains(typeof(IEnumerable<int>), stateMachine.GetInterfaces());
            Assert.Contains(typeof(IEnumerator<int>), stateMachine.GetInterfaces());
        });
    }

    [Fact]
    public void UserGenericInterface_ValueTypeIterator_DispatchesAndIlVerifies()
    {
        const string Source = """
            package Issue3093.Generic
            import System
            import System.Collections.Generic

            interface IDetector {
                func Detect[T](value T) IEnumerable[T];
            }

            struct Detector : IDetector {
                func Detect[T](value T) sequence[T] {
                    yield value
                }
            }

            var detector IDetector = Detector{}
            for value in detector.Detect[int32](3) {
                Console.WriteLine(value)
            }
            """;

        WithDirectory(directory =>
        {
            var assemblyPath = Compile(Source, directory);
            Assert.Equal($"3{Environment.NewLine}", Run(assemblyPath));
        });
    }

    [Fact]
    public void ImportedGenericInterface_ValueTypeIterator_DispatchesAndIlVerifies()
    {
        const string ContractSource = """
            #nullable enable
            using System.Collections.Generic;

            namespace Issue3093.Contracts;

            public interface IDetector
            {
                IEnumerable<T> Detect<T>(T value);
            }
            """;
        const string Source = """
            package Issue3093.Imported
            import System
            import Issue3093.Contracts

            struct Detector : IDetector {
                func Detect[T](value T) sequence[T] {
                    yield value
                }
            }

            var detector IDetector = Detector{}
            for value in detector.Detect[int32](3) {
                Console.WriteLine(value)
            }
            """;

        WithDirectory(directory =>
        {
            var contractPath = CompileContract(ContractSource, directory);
            var assemblyPath = Compile(Source, directory, new[] { contractPath });
            Assert.Equal($"3{Environment.NewLine}", Run(assemblyPath));
        });
    }

    [Fact]
    public void ImportedConstructedGenericInterface_Iterator_DispatchesAndIlVerifies()
    {
        const string ContractSource = """
            #nullable enable
            using System.Collections.Generic;

            namespace Issue3093.GenericContracts;

            public interface IDetector<T>
            {
                IEnumerable<T> Detect(T value);
            }
            """;
        const string Source = """
            package Issue3093.ImportedConstructed
            import System
            import Issue3093.GenericContracts

            struct Detector[T] : IDetector[T] {
                func Detect(value T) sequence[T] {
                    yield value
                }
            }

            var detector IDetector[int32] = Detector[int32]{}
            for value in detector.Detect(3) {
                Console.WriteLine(value)
            }
            """;

        WithDirectory(directory =>
        {
            var contractPath = CompileContract(ContractSource, directory);
            var assemblyPath = Compile(Source, directory, new[] { contractPath });
            Assert.Equal($"3{Environment.NewLine}", Run(assemblyPath));
        });
    }

    private static string Compile(
        string source,
        string directory,
        IReadOnlyCollection<string> additionalReferences = null)
    {
        var sourcePath = Path.Combine(directory, "Program.gs");
        var assemblyPath = Path.Combine(directory, "Issue3093.dll");
        File.WriteAllText(sourcePath, source);

        var arguments = new List<string>
        {
            "/out:" + assemblyPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        if (additionalReferences != null)
        {
            arguments.AddRange(additionalReferences.Select(path => "/reference:" + path));
            arguments.AddRange(
                ReferenceResolver.HostTrustedPlatformAssemblyPaths()
                    .Select(path => "/reference:" + path));
            arguments.Add("/nowarn:GS9100");
        }

        arguments.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(arguments.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{stdout}{stderr}");
        IlVerifier.Verify(assemblyPath, additionalReferences);
        return assemblyPath;
    }

    private static string CompileContract(string source, string directory)
    {
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "GSharp.Issue3093.Contracts",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, "GSharp.Issue3093.Contracts.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string Run(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        Assert.NotNull(process);
        var output = process!.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:{Environment.NewLine}{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }

    private static void WithDirectory(Action<string> action)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3093SequenceInterfaceContractTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            action(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
