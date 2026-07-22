// <copyright file="Issue2766ValueTypeConstructorAbiTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2766ValueTypeConstructorAbiTests
{
    private const string Source = """
        namespace Abi;

        public readonly struct ValuePolicy
        {
            private readonly int _level;

            public ValuePolicy(int level) => _level = level;

            public int Level => _level;
        }

        public struct MixedValue
        {
            public readonly int PublicField;
            private readonly int _privateField;

            public MixedValue(int publicValue, int privateValue, int propertyValue)
            {
                PublicField = publicValue;
                _privateField = privateValue;
                Property = propertyValue;
            }

            public MixedValue(int all) : this(all, all + 1, all + 2)
            {
            }

            public int PrivateValue => _privateField;

            public int Property { get; }
        }

        public sealed class ClassControl
        {
            public ClassControl(int value) => Value = value;

            public int Value { get; }
        }

        public readonly record struct RecordControl(int Value);

        public struct PrimaryControl(int value)
        {
            public int Read() => value;
        }
        """;

    [Fact]
    public void Translation_PreservesPlainStructConstructorsAndMemberKinds()
    {
        CompilationUnit unit = Translate();

        TypeDeclaration policy = FindType(unit, "ValuePolicy");
        Assert.True(policy.PrimaryConstructorParameters is null || policy.PrimaryConstructorParameters.Count == 0);
        Assert.Equal("level", Assert.Single(policy.Members.OfType<ConstructorDeclaration>()).Parameters.Single().Name);
        Assert.Equal(Visibility.Private, Assert.Single(policy.Members.OfType<FieldDeclaration>()).Visibility);
        Assert.Equal("Level", Assert.Single(policy.Members.OfType<PropertyDeclaration>()).Name);

        TypeDeclaration mixed = FindType(unit, "MixedValue");
        Assert.True(mixed.PrimaryConstructorParameters is null || mixed.PrimaryConstructorParameters.Count == 0);
        Assert.Equal(
            new[] { "publicValue", "privateValue", "propertyValue" },
            mixed.Members.OfType<ConstructorDeclaration>().First().Parameters.Select(p => p.Name));
        Assert.Equal("all", mixed.Members.OfType<ConstructorDeclaration>().Last().Parameters.Single().Name);
        Assert.Equal(
            new[] { Visibility.Default, Visibility.Private },
            mixed.Members.OfType<FieldDeclaration>().Select(f => f.Visibility));
        Assert.Equal(
            new[] { "PrivateValue", "Property" },
            mixed.Members.OfType<PropertyDeclaration>().Select(p => p.Name));

        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("init(level int32)", printed, StringComparison.Ordinal);
        Assert.Contains("init(publicValue int32, privateValue int32, propertyValue int32)", printed, StringComparison.Ordinal);
        Assert.Contains("convenience init(all int32)", printed, StringComparison.Ordinal);
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    [Fact]
    public void Translation_LeavesClassRecordAndNativePrimaryShapesOnTheirOwnPaths()
    {
        CompilationUnit unit = Translate();

        TypeDeclaration classControl = FindType(unit, "ClassControl");
        Assert.True(classControl.PrimaryConstructorParameters is null || classControl.PrimaryConstructorParameters.Count == 0);
        Assert.Equal("value", Assert.Single(classControl.Members.OfType<ConstructorDeclaration>()).Parameters.Single().Name);

        TypeDeclaration recordControl = FindType(unit, "RecordControl");
        Assert.Equal("Value", Assert.Single(recordControl.PrimaryConstructorParameters).Name);
        Assert.Empty(recordControl.Members.OfType<ConstructorDeclaration>());

        TypeDeclaration primaryControl = FindType(unit, "PrimaryControl");
        Assert.Equal("value", Assert.Single(primaryControl.PrimaryConstructorParameters).Name);
        Assert.Empty(primaryControl.Members.OfType<ConstructorDeclaration>());
    }

    [Fact]
    public void TranslatedLibrary_RealCSharpConsumerUsesNamedArgumentsGettersAndFieldAbi()
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2766-csharp-consumer",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);

        string gsPath = Path.Combine(workDir, "Abi.gs");
        string dllPath = Path.Combine(workDir, "Abi.dll");
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
                <Reference Include="Abi">
                  <HintPath>{dllPath}</HintPath>
                </Reference>
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(consumerDir, "Program.cs"), """
            using System;
            using System.Linq;
            using System.Reflection;
            using Abi;

            var policy = new ValuePolicy(level: 3);
            var mixed = new MixedValue(publicValue: 7, privateValue: 8, propertyValue: 9);
            var overloaded = new MixedValue(all: 5);

            Console.WriteLine(policy.Level);
            Console.WriteLine($"{mixed.PublicField}:{mixed.PrivateValue}:{mixed.Property}");
            Console.WriteLine($"{overloaded.PublicField}:{overloaded.PrivateValue}:{overloaded.Property}");
            Console.WriteLine(string.Join(",", typeof(MixedValue).GetConstructors()
                .OrderBy(c => c.GetParameters().Length)
                .Select(c => string.Join("+", c.GetParameters().Select(p => p.Name)))));
            Console.WriteLine(string.Join(",", typeof(MixedValue).GetFields(
                BindingFlags.Public | BindingFlags.Instance).Select(f => f.Name)));
            Console.WriteLine(string.Join(",", typeof(MixedValue).GetProperties(
                BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name).OrderBy(n => n)));
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
        Assert.StartsWith("3" + Environment.NewLine, output, StringComparison.Ordinal);
        Assert.Contains("7:8:9", output, StringComparison.Ordinal);
        Assert.Contains("5:6:7", output, StringComparison.Ordinal);
        Assert.Contains("all,publicValue+privateValue+propertyValue", output, StringComparison.Ordinal);
        Assert.Contains(Environment.NewLine + "PublicField" + Environment.NewLine, output, StringComparison.Ordinal);
        Assert.Contains("PrivateValue,Property", output, StringComparison.Ordinal);
    }

    private static TypeDeclaration FindType(CompilationUnit unit, string name) =>
        unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == name);

    private static CompilationUnit Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Abi.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return unit;
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
