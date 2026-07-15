// <copyright file="Issue2342CrossPackageAnonymousTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2342: <c>CSharpToGSharpTranslator</c> keys its
/// per-package <see cref="Cs2Gs.Translator.AnonymousTypeRegistry"/> (issue
/// #2292) by resolved G# package name, so two files in DIFFERENT packages —
/// e.g. the real Oahu.Data shape, where <c>Oahu.BooksDatabase</c> and
/// <c>Oahu.BooksDatabase.Migrations</c> each independently synthesize an
/// anonymous-object shape from an EF-Core-style migration — each mint their
/// OWN <c>AnonymousType0</c> starting from zero. cs2gs's translation output is
/// therefore, by design, two same-simple-name top-level
/// <c>data class AnonymousType0</c> declarations in two different <c>package</c>
/// blocks. Before the #2342 fix, <c>gsc</c> rejected compiling both files
/// together with <c>GS0102</c> ("'AnonymousType0' is already declared") because
/// <c>BoundScope.TryDeclareTypeAlias</c> treated every top-level declaration in
/// the WHOLE compilation as one flat, package-blind scope. After the fix, both
/// packages' independently-synthesized shapes compile and emit as distinct
/// types.
/// </summary>
public class Issue2342CrossPackageAnonymousTypeCollisionTests
{
    [Fact]
    public void DistinctAnonymousShapes_InDifferentPackages_CompileAndEmitDistinctTypes()
    {
        // Mirrors the real Oahu.Data shape: a "BooksDatabase" file with its own
        // top-level query shape, and a "BooksDatabase.Migrations" file (a child
        // package) whose migration independently projects an anonymous object.
        // Both synthesize a shape named "AnonymousType0" (each package's
        // registry starts counting at zero), and since one package is a strict
        // dotted PREFIX of the other, the fix must also correctly treat them as
        // distinct (mirroring the Foo/Foo.Bar prefix-package binder/compiler
        // tests) rather than accidentally conflating a prefix relationship with
        // sameness.
        const string BooksDatabaseSource = @"
namespace Oahu.BooksDatabase
{
    public sealed class BookRepository
    {
        public object GetSummary()
        {
            return new { SeriesId = 1, BookId = 2 };
        }
    }
}";
        const string MigrationSource = @"
namespace Oahu.BooksDatabase.Migrations
{
    public sealed class InitialCreate
    {
        public object Up()
        {
            return new { Alias = ""x"", AudibleId = ""y"" };
        }
    }
}";
        (string printedBooksDatabase, string printedMigration) = TranslateTwoFiles(
            "BookRepository.cs",
            BooksDatabaseSource,
            "InitialCreate.cs",
            MigrationSource);

        Assert.Contains("package Oahu.BooksDatabase", printedBooksDatabase);
        Assert.Contains("data class AnonymousType0(SeriesId int32, BookId int32)", printedBooksDatabase);

        Assert.Contains("package Oahu.BooksDatabase.Migrations", printedMigration);
        Assert.Contains("data class AnonymousType0(Alias string, AudibleId string)", printedMigration);

        // The proof that matters: gsc must compile BOTH files together (as two
        // distinct packages) with no GS0102 "already declared" collision, and
        // must emit BOTH synthesized types.
        string dllPath = CompileFilesTogether(
            ("BookRepository.gs", printedBooksDatabase),
            ("InitialCreate.gs", printedMigration));

        AssertTypeIsEmitted(dllPath, "Oahu.BooksDatabase.AnonymousType0");
        AssertTypeIsEmitted(dllPath, "Oahu.BooksDatabase.Migrations.AnonymousType0");
    }

    private static (string PrintedA, string PrintedB) TranslateTwoFiles(
        string fileNameA,
        string sourceA,
        string fileNameB,
        string sourceB)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (fileNameA, sourceA), (fileNameB, sourceB) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippets should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(2, project.Documents.Count);

        // ONE shared translator instance, mirroring exactly how
        // TranslateStage/TestParityStage translate every document of a real
        // project, so the package-scoped anonymous-type registries are real
        // (keyed independently per package) rather than each file getting an
        // unshared translator.
        var translator = new CSharpToGSharpTranslator();
        LoadedDocument documentA = project.Documents[0];
        LoadedDocument documentB = project.Documents[1];

        var contextA = new TranslationContext(project.Compilation, documentA.SemanticModel, documentA.FilePath);
        CompilationUnit unitA = translator.TranslateDocument(documentA, contextA);
        string printedA = GSharpPrinter.Print(unitA);

        var contextB = new TranslationContext(project.Compilation, documentB.SemanticModel, documentB.FilePath);
        CompilationUnit unitB = translator.TranslateDocument(documentB, contextB);
        string printedB = GSharpPrinter.Print(unitB);

        Assert.True(GSharpRoundTrip.Validate(printedA).Success, "File A must round-trip:\n" + printedA);
        Assert.True(GSharpRoundTrip.Validate(printedB).Success, "File B must round-trip:\n" + printedB);

        return (printedA, printedB);
    }

    /// <summary>
    /// Compiles every <c>(fileName, contents)</c> pair together, as ONE gsc
    /// invocation spanning multiple packages, asserting zero compiler errors,
    /// and returns the path to the emitted assembly for further inspection.
    /// </summary>
    private static string CompileFilesTogether(params (string FileName, string Contents)[] files)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2342-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);

        var gsPaths = new System.Collections.Generic.List<string>();
        foreach ((string fileName, string contents) in files)
        {
            string gsPath = Path.Combine(workDir, fileName);
            File.WriteAllText(gsPath, contents);
            gsPaths.Add(gsPath);
        }

        string dllPath = Path.Combine(workDir, "Snippet.dll");
        string quotedSources = string.Join(" ", gsPaths.ConvertAll(p => $"\"{p}\""));
        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:library /out:\"{dllPath}\" {quotedSources}");

        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated files together with zero errors. Output:\n" + compileOut);

        return dllPath;
    }

    /// <summary>
    /// Loads the emitted assembly with a <see cref="System.Reflection.MetadataLoadContext"/>
    /// and asserts a type with the given full name (namespace-qualified,
    /// matching the G# package) exists — proving the two same-simple-name
    /// package-scoped types were BOTH emitted, not just one silently winning.
    /// </summary>
    private static void AssertTypeIsEmitted(string dllPath, string fullTypeName)
    {
        string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var resolver = new System.Reflection.PathAssemblyResolver(
            Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { dllPath }));
        using var mlc = new System.Reflection.MetadataLoadContext(resolver, "System.Private.CoreLib");
        System.Reflection.Assembly asm = mlc.LoadFromAssemblyPath(dllPath);
        Assert.True(
            asm.GetType(fullTypeName, throwOnError: false) != null,
            $"Expected emitted type '{fullTypeName}' not found. Available types: " +
                string.Join(", ", Array.ConvertAll(asm.GetTypes(), t => t.FullName)));
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
