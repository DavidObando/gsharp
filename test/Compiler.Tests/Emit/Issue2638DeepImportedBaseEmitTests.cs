// <copyright file="Issue2638DeepImportedBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2638DeepImportedBaseEmitTests
{
    private const string LibrarySource = """
        namespace Issue2638.Library;

        public sealed class Rule
        {
            public Rule(int value) => Value = value;
            public int Value { get; }
        }

        public class Root
        {
            public string Apply(Rule rule) => "deep:" + rule.Value;
            protected string ProtectedOnly() => "protected";
            internal string InternalOnly() => "internal";
            private string PrivateOnly() => "private";
        }

        public class Mid : Root
        {
            public string Distractor() => "distractor";
        }

        public sealed class Leaf : Mid
        {
            public string Own() => "own";
        }
        """;

    [Fact]
    public void CrossAssemblyDeepPublicMethod_Runs()
    {
        using var fixture = new Fixture();
        var result = fixture.CompileGSharp("""
            package Issue2638.Consumer
            import System
            import Issue2638.Library

            Console.WriteLine(Leaf().Apply(Rule(2638)))
            """, "exe");

        Assert.Equal(0, result.ExitCode);
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { fixture.LibraryPath });
        Assert.Equal("deep:2638\n", fixture.Run(result.OutputPath));
    }

    [Fact]
    public void CrossAssemblyDeepNonPublicMethods_ReportGS0159()
    {
        using var fixture = new Fixture();
        var result = fixture.CompileGSharp("""
            package Issue2638.Consumer
            import Issue2638.Library

            func Probe(value Leaf) {
                value.ProtectedOnly()
                value.InternalOnly()
                value.PrivateOnly()
            }
            """, "library");

        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal(3, Count(result.Output, "GS0159"));
    }

    private static int Count(string text, string value)
    {
        var count = 0;
        for (var index = 0; (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0; index += value.Length)
        {
            count++;
        }

        return count;
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2638DeepImportedBaseEmitTests),
            Guid.NewGuid().ToString("N"));

        public Fixture()
        {
            Directory.CreateDirectory(directory);
            LibraryPath = Path.Combine(directory, "Issue2638.Library.dll");
            EmitCSharpLibrary(LibraryPath);
        }

        public string LibraryPath { get; }

        public CompileResult CompileGSharp(string source, string target)
        {
            var sourcePath = Path.Combine(directory, "Consumer.gs");
            var outputPath = Path.Combine(directory, "Consumer.dll");
            File.WriteAllText(sourcePath, source);
            var args = new List<string>
            {
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/r:" + LibraryPath,
                sourcePath,
            };
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            return new CompileResult(exitCode, outputPath, stdout.ToString() + stderr.ToString());
        }

        public string Run(string assemblyPath)
        {
            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add(assemblyPath);
            using var process = Process.Start(startInfo);
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exit {process.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }

        private static void EmitCSharpLibrary(string path)
        {
            var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                    ?.Split(Path.PathSeparator)
                    ?? Array.Empty<string>())
                .Where(File.Exists)
                .Select(file => MetadataReference.CreateFromFile(file));
            var compilation = CSharpCompilation.Create(
                "Issue2638.Library",
                new[] { CSharpSyntaxTree.ParseText(LibrarySource, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = File.Create(path);
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }
    }

    private sealed record CompileResult(int ExitCode, string OutputPath, string Output);
}
