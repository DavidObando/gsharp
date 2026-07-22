// <copyright file="Issue2701ImportedStructMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2701ImportedStructMethodEmitTests
{
    private const string FixtureSource = """
        namespace Oahu.Cli;

        public readonly struct Icon
        {
            public string Render(bool enabled) => enabled ? "icon:on" : "icon:off";
        }
        """;

    private const string OahuSource = """
        package Oahu.Cli.App

        import System
        import Oahu.Cli

        func Main() {
            var icon = Icon()
            Console.WriteLine(icon.Render(true))
        }
        """;

    [Fact]
    public void ExactOahuIconRender_CrossAssembly_RunsVerifiesAndReferencesExactMethod()
    {
        using var artifacts = Compile(OahuSource);

        Assert.DoesNotContain("GS9998", artifacts.Diagnostics, StringComparison.Ordinal);
        Assert.Equal("icon:on\n", Run(artifacts.OutputPath));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.FixturePath });

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var renderHandle = Assert.Single(
            reader.MemberReferences,
            handle => reader.GetString(reader.GetMemberReference(handle).Name) == "Render");
        var render = reader.GetMemberReference(renderHandle);
        var parent = reader.GetTypeReference((TypeReferenceHandle)render.Parent);

        Assert.Equal("Oahu.Cli", reader.GetString(parent.Namespace));
        Assert.Equal("Icon", reader.GetString(parent.Name));
        Assert.Equal(new byte[] { 0x20, 0x01, 0x0E, 0x02 }, reader.GetBlobBytes(render.Signature));
    }

    [Fact]
    public void IconRender_WithWrongArgument_RemainsACompileTimeError()
    {
        var source = OahuSource.Replace("Render(true)", "Render(1)", StringComparison.Ordinal);
        using var artifacts = Compile(source, expectSuccess: false);

        Assert.NotEqual(0, artifacts.ExitCode);
        Assert.Contains("GS0159", artifacts.Diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", artifacts.Diagnostics, StringComparison.Ordinal);
    }

    private static CompilationArtifacts Compile(string source, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2701-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var fixturePath = Path.Combine(directory, "Oahu.Cli.dll");
        EmitFixture(fixturePath);
        var sourcePath = Path.Combine(directory, "Program.gs");
        var outputPath = Path.Combine(directory, "Oahu.Cli.App.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(
                new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + fixturePath,
                    sourcePath,
                });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        var diagnostics = stdout.ToString() + stderr.ToString();
        if (expectSuccess)
        {
            Assert.True(exitCode == 0, $"gsc failed:\n{diagnostics}");
        }

        return new CompilationArtifacts(directory, fixturePath, outputPath, exitCode, diagnostics);
    }

    private static void EmitFixture(string path)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(reference => MetadataReference.CreateFromFile(reference));
        var compilation = CSharpCompilation.Create(
            "Oahu.Cli",
            new[] { CSharpSyntaxTree.ParseText(FixtureSource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private sealed class CompilationArtifacts : IDisposable
    {
        public CompilationArtifacts(
            string directory,
            string fixturePath,
            string outputPath,
            int exitCode,
            string diagnostics)
        {
            Directory = directory;
            FixturePath = fixturePath;
            OutputPath = outputPath;
            ExitCode = exitCode;
            Diagnostics = diagnostics;
        }

        public string Directory { get; }

        public string FixturePath { get; }

        public string OutputPath { get; }

        public int ExitCode { get; }

        public string Diagnostics { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
