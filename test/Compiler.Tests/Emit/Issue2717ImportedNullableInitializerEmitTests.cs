// <copyright file="Issue2717ImportedNullableInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2717ImportedNullableInitializerEmitTests
{
    [Fact]
    public void ExactOahuRuleStyleInitializer_CompilesWithoutGS9998()
    {
        const string tokens = """
            package Oahu.Cli.Tui.Tokens
            import Spectre.Console

            data struct SemanticColor(Value Color) {
                func operator implicit(c SemanticColor) Color -> c.Value
                func operator implicit(c SemanticColor) Style -> Style(c.Value)
            }

            class Tokens {
                shared {
                    prop BorderNeutral SemanticColor -> SemanticColor(Color.Red)
                }
            }
            """;
        const string appShell = """
            package Oahu.Cli.Tui
            import Spectre.Console
            import Spectre.Console.Rendering
            import Oahu.Cli.Tui.Tokens

            func Build() Spectre.Console.Rule ->
                Spectre.Console.Rule{Style: Style(Tokens.BorderNeutral)}
            """;

        var directory = NewDirectory();
        try
        {
            var spectrePath = typeof(Spectre.Console.Style).Assembly.Location;
            var references = new[]
            {
                spectrePath,
                Path.Combine(Path.GetDirectoryName(spectrePath)!, "Spectre.Console.Ansi.dll"),
            };
            var result = Compile(directory, "Oahu.Cli.Tui", new[] { tokens, appShell }, references);

            Assert.True(result.ExitCode == 0, result.Diagnostics);
            Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ImportedReferenceAndValueNullableProperties_RunAndVerifyWithoutBoxing()
    {
        var directory = NewDirectory();
        try
        {
            var fixturePath = Path.Combine(directory, "Issue2717.Metadata.dll");
            EmitFixture(fixturePath);
            const string source = """
                package Issue2717.App
                import Issue2717.Metadata

                func Build() Holder2717 -> Holder2717{
                    Reference: ReferenceValue2717("oahu"),
                    Value: ValueValue2717(2717)
                }
                """;

            var result = Compile(directory, "Issue2717.App", new[] { source }, new[] { fixturePath });
            Assert.True(result.ExitCode == 0, result.Diagnostics);
            IlVerifier.Verify(result.OutputPath, new[] { fixturePath });

            _ = Assembly.LoadFrom(fixturePath);
            var emitted = Assembly.LoadFrom(result.OutputPath);
            var build = emitted.GetTypes()
                .Single(type => type.Name == "<Program>")
                .GetMethod("Build", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
            var holder = build.Invoke(null, null)!;
            var reference = holder.GetType().GetProperty("Reference")!.GetValue(holder)!;
            var value = holder.GetType().GetProperty("Value")!.GetValue(holder)!;
            Assert.Equal(
                "oahu",
                reference.GetType().GetProperty("Text")!.GetValue(reference));
            Assert.Equal(
                2717,
                value.GetType().GetProperty("Value")!.GetValue(value));
            Assert.DoesNotContain((byte)0x8C, build.GetMethodBody()!.GetILAsByteArray()!);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void IncompatibleImportedNullableProperty_RemainsATypeError()
    {
        var directory = NewDirectory();
        try
        {
            var fixturePath = Path.Combine(directory, "Issue2717.Metadata.dll");
            EmitFixture(fixturePath);
            const string source = """
                package Issue2717.Negative
                import Issue2717.Metadata

                func Bad() Holder2717 ->
                    Holder2717{Value: ReferenceValue2717("not a value struct")}
                """;

            var result = Compile(directory, "Issue2717.Negative", new[] { source }, new[] { fixturePath });

            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains("GS0155", result.Diagnostics, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void EmitFixture(string outputPath)
    {
        const string source = """
            #nullable enable
            namespace Issue2717.Metadata;

            public sealed class ReferenceValue2717
            {
                public ReferenceValue2717(string text) => Text = text;
                public string Text { get; }
            }

            public readonly struct ValueValue2717
            {
                public ValueValue2717(int value) => Value = value;
                public int Value { get; }
            }

            public sealed class Holder2717
            {
                public ReferenceValue2717? Reference { get; set; }
                public ValueValue2717? Value { get; set; }
            }
            """;
        var compilation = CSharpCompilation.Create(
            "Issue2717.Metadata",
            new[] { CSharpSyntaxTree.ParseText(source) },
            TrustedPlatformAssemblies().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        using var pe = File.Create(outputPath);
        var result = compilation.Emit(pe);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static CompileResult Compile(
        string directory,
        string assemblyName,
        string[] sources,
        string[] references)
    {
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        args.AddRange(TrustedPlatformAssemblies().Select(path => "/reference:" + path));
        args.AddRange(references.Where(File.Exists).Select(path => "/reference:" + path));
        for (var i = 0; i < sources.Length; i++)
        {
            var sourcePath = Path.Combine(directory, $"Source{i}.gs");
            File.WriteAllText(sourcePath, sources[i]);
            args.Add(sourcePath);
        }

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            return new CompileResult(exitCode, stdout.ToString() + stderr, outputPath);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string NewDirectory()
    {
        var directory = Path.Combine(
            Environment.CurrentDirectory,
            "TestArtifacts",
            "Issue2717",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var assemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(assemblies)
            ? Array.Empty<string>()
            : assemblies.Split(Path.PathSeparator).Where(File.Exists);
    }

    private sealed record CompileResult(int ExitCode, string Diagnostics, string OutputPath);
}
