// <copyright file="Issue3088AsyncNullableTupleInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3088AsyncNullableTupleInterfaceTests
{
    [Fact]
    public void ImportedInterface_AsyncNullableTupleReturn_DispatchesVerifiesAndRuns()
    {
        const string ContractSource = """
            #nullable enable
            using System;
            using System.Threading;
            using System.Threading.Tasks;

            namespace Issue3088.Contract;

            public sealed class Item
            {
                public Item(int value) => Value = value;

                public int Value { get; }
            }

            public interface IStore
            {
                Task<(Item Item, string? Name)?> GetAsync(
                    Guid id,
                    CancellationToken ct = default);
            }
            """;

        const string Source = """
            package Issue3088

            import System
            import System.Threading
            import System.Threading.Tasks
            import Issue3088.Contract

            class Store : IStore {
                public async func GetAsync(id Guid, ct CancellationToken = default(CancellationToken)) (Item, string?)? {
                    await Task.Yield()
                    return id == Guid.Empty ? nil : (Item(42), default(string?))
                }
            }

            async func Verify(store IStore) {
                let missing = await store.GetAsync(Guid.Empty)
                Console.WriteLine(missing == nil)

                let found = await store.GetAsync(Guid.NewGuid())
                if found == nil {
                    Environment.Exit(12)
                }

                let value = found!!
                Console.WriteLine(value.Item1.Value)
                Console.WriteLine(value.Item2 == nil)
            }

            Verify(Store()).GetAwaiter().GetResult()
            """;

        Assert.Equal($"True{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}", CompileVerifyAndRun(ContractSource, Source));
    }

    private static string CompileVerifyAndRun(string contractSource, string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3088AsyncNullableTupleInterfaceTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory, contractSource);
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3088.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/reference:" + contractPath,
            };
            arguments.AddRange(ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => "/reference:" + path));
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
            IlVerifier.Verify(outputPath, new[] { contractPath });

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:{Environment.NewLine}{error}");
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileContract(string directory, string source)
    {
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "GSharp.Issue3088.Contract",
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, "GSharp.Issue3088.Contract.dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }
}
