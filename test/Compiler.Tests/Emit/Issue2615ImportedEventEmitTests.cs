// <copyright file="Issue2615ImportedEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2615: imported inherited events participate in access, binding, and emit.</summary>
public sealed class Issue2615ImportedEventEmitTests
{
    private const string FixtureSource = """
        using System.ComponentModel;

        namespace OahuFixture;

        public class ObservableObject : INotifyPropertyChanged
        {
            public event PropertyChangedEventHandler? PropertyChanged;

            public void Raise(string name) =>
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
        }
        """;

    private const string OahuSource = """
        package Oahu.Core.UI.Avalonia.ViewModels

        import System
        import System.ComponentModel
        import OahuFixture

        class BookItemViewModel : ObservableObject { }

        class Probe {
            var Hits int32

            init() {
                Hits = 0
            }

            func OnPropertyChanged(sender Object, e PropertyChangedEventArgs) {
                Hits = Hits + 1
            }

            func Run() int32 {
                let vm = BookItemViewModel()
                vm.PropertyChanged += OnPropertyChanged
                vm.Raise("IsSelected")
                vm.PropertyChanged -= OnPropertyChanged
                vm.Raise("Ignored")
                return Hits
            }
        }
        """;

    [Fact]
    public void ImportedInheritedPropertyChanged_AddRemove_Runs()
    {
        using var artifacts = Compile(OahuSource);
        _ = Assembly.LoadFrom(artifacts.FixturePath);
        var assembly = Assembly.LoadFrom(artifacts.OutputPath);
        var probeType = assembly.GetType("Oahu.Core.UI.Avalonia.ViewModels.Probe");
        var probe = Activator.CreateInstance(probeType!);

        Assert.Equal(1, probeType!.GetMethod("Run")!.Invoke(probe, null));
        IlVerifier.Verify(artifacts.OutputPath, additionalReferences: new[] { artifacts.FixturePath });
    }

    [Fact]
    public void ImportedInheritedPropertyChanged_EmitsAddAndRemoveMemberReferences()
    {
        using var artifacts = Compile(OahuSource);
        using var stream = File.OpenRead(artifacts.OutputPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var memberNames = reader.MemberReferences
            .Select(handle => reader.GetString(reader.GetMemberReference(handle).Name))
            .ToHashSet(StringComparer.Ordinal);

        Assert.Contains("add_PropertyChanged", memberNames);
        Assert.Contains("remove_PropertyChanged", memberNames);
    }

    [Fact]
    public void MissingImportedInheritedEvent_RemainsGS0158()
    {
        var source = OahuSource.Replace("vm.PropertyChanged += OnPropertyChanged", "vm.Missing += OnPropertyChanged", StringComparison.Ordinal);
        using var artifacts = Compile(source, expectSuccess: false);

        Assert.NotEqual(0, artifacts.ExitCode);
        Assert.Contains("GS0158", artifacts.Diagnostics, StringComparison.Ordinal);
        Assert.Contains("Cannot find member Missing", artifacts.Diagnostics, StringComparison.Ordinal);
    }

    private static CompilationArtifacts Compile(string source, bool expectSuccess = true)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2615-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        var fixturePath = Path.Combine(directory, "OahuFixture.dll");
        EmitFixture(fixturePath);
        var sourcePath = Path.Combine(directory, "BookLibraryViewModel.gs");
        var outputPath = Path.Combine(directory, "Oahu.UI.dll");
        File.WriteAllText(sourcePath, source);

        var (exitCode, stdout, stderr) = RunCompiler(new[]
        {
            "/out:" + outputPath,
            "/target:library",
            "/targetframework:net10.0",
            "/r:" + fixturePath,
            "/nowarn:GS9100",
            sourcePath,
        });
        if (expectSuccess)
        {
            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
        }

        return new CompilationArtifacts(directory, fixturePath, outputPath, exitCode, stdout + stderr);
    }

    private static void EmitFixture(string path)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "OahuFixture",
            new[] { CSharpSyntaxTree.ParseText(FixtureSource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
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
