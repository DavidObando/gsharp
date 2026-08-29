// <copyright file="Issue3645ReferencedExeEntryTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #3645: an executable project that another
/// project in the same migration run compiles against must keep its
/// entry-point class as a real G# class. Flattening it to top-level statements
/// (ADR-0115 §B.11 T3) erases the type from the migrated assembly, so every
/// cross-project use site (e.g. the migrated GeneratorHost tests calling
/// <c>GsgenProgram.Run(...)</c> on the Gsgen.Cli exe) fails with GS0157.
/// </summary>
public sealed class Issue3645ReferencedExeEntryTypeTests
{
    private const string EntrySource = """
        using System;
        using System.IO;

        namespace Demo.Cli;

        public static class DemoProgram
        {
            public static int Main(string[] args) => Run(args, Console.Out);

            public static int Run(string[] args, TextWriter stdout)
            {
                stdout.WriteLine(args.Length);
                return 0;
            }
        }
        """;

    [Fact]
    public void PreserveEntryType_KeepsEntryClassAsConsumableType()
    {
        string printed = TranslateEntrySource(preserveEntryType: true);

        // The entry class must survive as a CLR-visible type so a referencing
        // project's `DemoProgram.Run(...)` call sites resolve. gsc supports a
        // class-scoped static `Main` (issue #1996), so this form still runs.
        Assert.Contains("class DemoProgram", printed);
        Assert.Contains("Main", printed);
        Assert.Contains("Run", printed);
    }

    [Fact]
    public void DefaultTranslation_StillFlattensEntryClass()
    {
        string printed = TranslateEntrySource(preserveEntryType: false);

        // The unreferenced-executable shape is unchanged: T3 flattening drops
        // the entry class and hoists its members to top level.
        Assert.DoesNotContain("class DemoProgram", printed);
        Assert.Contains("func Run", printed);
    }

    [Fact]
    public void CollectCompileReferencedProjectPaths_TracksCompileReferencesOnly()
    {
        string root = Path.Combine(
            Path.GetTempPath(), "cs2gs-issue3645-" + Guid.NewGuid().ToString("N"));
        try
        {
            string exeDir = Path.Combine(root, "Exe");
            string buildOnlyDir = Path.Combine(root, "BuildOnly");
            string testsDir = Path.Combine(root, "Tests");
            Directory.CreateDirectory(exeDir);
            Directory.CreateDirectory(buildOnlyDir);
            Directory.CreateDirectory(testsDir);

            string exeProject = Path.Combine(exeDir, "Exe.csproj");
            string buildOnlyProject = Path.Combine(buildOnlyDir, "BuildOnly.csproj");
            string testsProject = Path.Combine(testsDir, "Tests.csproj");
            File.WriteAllText(exeProject, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
                </Project>
                """);
            File.WriteAllText(buildOnlyProject, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
                </Project>
                """);
            File.WriteAllText(testsProject, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <ItemGroup>
                    <ProjectReference Include="..\Exe\Exe.csproj" />
                    <ProjectReference Include="..\BuildOnly\BuildOnly.csproj" ReferenceOutputAssembly="false" />
                  </ItemGroup>
                </Project>
                """);

            IReadOnlyCollection<string> referenced =
                DeclaredProjectItems.CollectCompileReferencedProjectPaths(
                    new[] { exeProject, buildOnlyProject, testsProject });

            // The compile reference makes Exe's entry class consumable API
            // surface; the ReferenceOutputAssembly="false" edge contributes no
            // type surface, so BuildOnly keeps the default T3 flattening.
            Assert.Contains(Path.GetFullPath(exeProject), referenced);
            Assert.DoesNotContain(Path.GetFullPath(buildOnlyProject), referenced);
            Assert.DoesNotContain(Path.GetFullPath(testsProject), referenced);
        }
        finally
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string TranslateEntrySource(bool preserveEntryType)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("DemoProgram.cs", EntrySource) },
            outputKind: OutputKind.ConsoleApplication);
        Assert.True(
            project.BoundWithoutErrors,
            "Entry source should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        var translator = new CSharpToGSharpTranslator(preserveEntryType: preserveEntryType);
        return GSharpPrinter.Print(translator.TranslateDocument(document, context));
    }
}
