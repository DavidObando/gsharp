// <copyright file="Issue2746ConstructorPropertyAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2746ConstructorPropertyAbiTests
{
    private const string Source = """
        namespace Oahu.Cli;

        public enum OutputFormat
        {
            Text,
            Json,
        }

        public enum ServerTransport
        {
            Stdio,
            Http,
        }

        public sealed class OutputContext
        {
            public OutputContext(OutputFormat format, bool quiet, bool useColor, bool useAscii)
            {
                Format = format;
                Quiet = quiet;
                UseColor = useColor;
                UseAscii = useAscii;
            }

            public OutputFormat Format { get; }

            public bool Quiet { get; }

            public bool UseColor { get; }

            public bool UseAscii { get; }
        }

        public sealed class CapabilityPolicy
        {
            public CapabilityPolicy(ServerTransport transport, bool unattended)
            {
                Transport = transport;
                Unattended = unattended;
            }

            public ServerTransport Transport { get; }

            public bool Unattended { get; }
        }
        """;

    [Fact]
    public void ExplicitConstructorsAndGetOnlyProperties_KeepDeclaredShape()
    {
        CompilationUnit unit = Translate();

        AssertClassShape(
            unit,
            "OutputContext",
            new[] { "format", "quiet", "useColor", "useAscii" },
            new[] { "Format", "Quiet", "UseColor", "UseAscii" });
        AssertClassShape(
            unit,
            "CapabilityPolicy",
            new[] { "transport", "unattended" },
            new[] { "Transport", "Unattended" });
    }

    [Fact]
    public void TranslatedLibrary_RealCSharpConsumerUsesNamedArgumentsAndProperties()
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2746-csharp-consumer",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);

        string gsPath = Path.Combine(workDir, "Oahu.Cli.gs");
        string dllPath = Path.Combine(workDir, "Oahu.Cli.dll");
        File.WriteAllText(Path.Combine(workDir, "Directory.Build.props"), "<Project></Project>");
        File.WriteAllText(gsPath, GSharpPrinter.Print(Translate()));
        AssertProcessSucceeds(
            "dotnet",
            workDir,
            compiler,
            "/target:library",
            "/targetframework:net10.0",
            "/out:" + dllPath,
            gsPath);

        string consumerDir = Path.Combine(workDir, "Consumer");
        Directory.CreateDirectory(consumerDir);
        File.WriteAllText(Path.Combine(consumerDir, "Consumer.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
              <ItemGroup>
                <Reference Include="Oahu.Cli">
                  <HintPath>{dllPath}</HintPath>
                </Reference>
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(consumerDir, "Program.cs"), """
            using System;
            using Oahu.Cli;

            var output = new OutputContext(
                format: OutputFormat.Json,
                quiet: true,
                useColor: false,
                useAscii: true);
            var policy = new CapabilityPolicy(
                transport: ServerTransport.Stdio,
                unattended: true);

            Console.WriteLine($"{output.Format}:{output.Quiet}:{output.UseColor}:{output.UseAscii}");
            Console.WriteLine($"{policy.Transport}:{policy.Unattended}");
            """);

        AssertProcessSucceeds("dotnet", consumerDir, "restore", "--nologo");
        string output = AssertProcessSucceeds(
            "dotnet",
            consumerDir,
            "run",
            "--no-restore",
            "--nologo",
            "-c",
            "Release");
        Assert.Contains("Json:True:False:True", output, StringComparison.Ordinal);
        Assert.Contains("Stdio:True", output, StringComparison.Ordinal);
    }

    [Fact]
    public void NativePrimaryConstructor_RemainsPrimaryConstructor()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Native.cs", "namespace Demo; public class Native(string value) { public string Value() => value; }"),
        });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        TypeDeclaration native = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Native");
        Assert.Equal("value", Assert.Single(native.PrimaryConstructorParameters).Name);
    }

    private static void AssertClassShape(
        CompilationUnit unit,
        string className,
        string[] parameterNames,
        string[] propertyNames)
    {
        TypeDeclaration type = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == className);
        Assert.True(type.PrimaryConstructorParameters is null || type.PrimaryConstructorParameters.Count == 0);
        Assert.Equal(
            parameterNames,
            Assert.Single(type.Members.OfType<ConstructorDeclaration>()).Parameters.Select(p => p.Name));
        Assert.Equal(
            propertyNames,
            type.Members.OfType<PropertyDeclaration>().Select(p => p.Name));
    }

    private static CompilationUnit Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Oahu.Cli.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }

    private static string AssertProcessSucceeds(
        string fileName,
        string workingDirectory,
        params string[] arguments)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, output);
        return output;
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
