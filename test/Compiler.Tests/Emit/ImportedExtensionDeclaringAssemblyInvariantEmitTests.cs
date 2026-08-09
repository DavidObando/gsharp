// <copyright file="ImportedExtensionDeclaringAssemblyInvariantEmitTests.cs" company="GSharp">
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

/// <summary>
/// Verifies that an imported extension method's MemberRef retains its
/// <see cref="System.Reflection.MethodInfo.DeclaringType"/> assembly identity
/// when another reference defines the same fully-qualified host type.
/// </summary>
public sealed class ImportedExtensionDeclaringAssemblyInvariantEmitTests
{
    private const string PrimarySource = """
        namespace ClassLibrary1;

        public sealed class A { }

        public static class B
        {
            public static string Call(this A value) => "correct";
        }
        """;

    private const string ShadowSource = """
        namespace ClassLibrary1;

        public static class B
        {
            public static string Shadow(this A value) => "shadow";
        }
        """;

    private const string GSharpSource = """
        package MyApp

        import System
        import ClassLibrary1

        var a = A()
        Console.WriteLine(a.Call())
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MemberRef_PreservesDeclaringAssembly_RegardlessOfReferenceOrder(bool shadowReferenceFirst)
    {
        using var artifacts = Compile(shadowReferenceFirst);

        IlVerifier.Verify(
            artifacts.OutputPath,
            additionalReferences: new[] { artifacts.PrimaryPath, artifacts.ShadowPath });

        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var callHandle = Assert.Single(
            reader.MemberReferences,
            handle => reader.GetString(reader.GetMemberReference(handle).Name) == "Call");
        var call = reader.GetMemberReference(callHandle);
        Assert.Equal(HandleKind.TypeReference, call.Parent.Kind);
        var parent = reader.GetTypeReference((TypeReferenceHandle)call.Parent);
        Assert.Equal(HandleKind.AssemblyReference, parent.ResolutionScope.Kind);
        var assembly = reader.GetAssemblyReference((AssemblyReferenceHandle)parent.ResolutionScope);

        Assert.Equal("ClassLibrary1", reader.GetString(assembly.Name));
        Assert.Equal($"correct{Environment.NewLine}", Run(artifacts.OutputPath));
    }

    private static CompilationArtifacts Compile(bool shadowReferenceFirst)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "imported-extension-assembly-identity-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var primaryPath = Path.Combine(directory, "ClassLibrary1.dll");
        EmitFixture("ClassLibrary1", PrimarySource, primaryPath);
        var shadowPath = Path.Combine(directory, "AClassLibrary3.dll");
        EmitFixture(
            "AClassLibrary3",
            ShadowSource,
            shadowPath,
            new[] { MetadataReference.CreateFromFile(primaryPath) });

        var sourcePath = Path.Combine(directory, "Program.gs");
        var outputPath = Path.Combine(directory, "MyApp.dll");
        File.WriteAllText(sourcePath, GSharpSource);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            var firstReference = shadowReferenceFirst ? shadowPath : primaryPath;
            var secondReference = shadowReferenceFirst ? primaryPath : shadowPath;
            exitCode = Program.Main(
                new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + firstReference,
                    "/reference:" + secondReference,
                    sourcePath,
                });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        var diagnostics = stdout.ToString() + stderr.ToString();
        Assert.True(exitCode == 0, $"gsc failed:\n{diagnostics}");
        return new CompilationArtifacts(directory, primaryPath, shadowPath, outputPath);
    }

    private static void EmitFixture(
        string assemblyName,
        string source,
        string path,
        MetadataReference[] additionalReferences = null)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(reference => MetadataReference.CreateFromFile(reference))
            .Concat(additionalReferences ?? Array.Empty<MetadataReference>());
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
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
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private sealed class CompilationArtifacts : IDisposable
    {
        public CompilationArtifacts(
            string directory,
            string primaryPath,
            string shadowPath,
            string outputPath)
        {
            Directory = directory;
            PrimaryPath = primaryPath;
            ShadowPath = shadowPath;
            OutputPath = outputPath;
        }

        public string Directory { get; }

        public string PrimaryPath { get; }

        public string ShadowPath { get; }

        public string OutputPath { get; }

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
