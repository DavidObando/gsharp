// <copyright file="Issue2292AnonymousTypePackageScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #2292: anonymous shape declarations are
/// deduplicated across every document in one G# package. Issue #2598 further
/// makes each synthetic name a stable function of the complete ordered shape,
/// so the same rules remain consistent across packages and projects.
/// <para>
/// One <see cref="AnonymousTypeRegistry"/> per resolved package is threaded
/// through every mapper the translator creates, so an identical shape is
/// emitted once and reused by later documents.
/// </para>
/// </summary>
public class Issue2292AnonymousTypePackageScopeTests
{
    [Fact]
    public void DistinctAnonymousShapes_InDifferentFiles_SamePackage_GetDistinctSyntheticNames()
    {
        const string SourceA = @"
namespace Demo
{
    public sealed class MigrationA
    {
        public void Up()
        {
            var shapeA = new { Id = 1, Name = ""x"" };
        }
    }
}";
        const string SourceB = @"
namespace Demo
{
    public sealed class MigrationB
    {
        public void Down()
        {
            var shapeB = new { Count = 1, Flag = true, Extra = 2.0 };
        }
    }
}";
        (string printedA, string printedB) = TranslateTwoFiles("MigrationA.cs", SourceA, "MigrationB.cs", SourceB);
        string nameA = AnonymousTypeNames(printedA).Single();
        string nameB = AnonymousTypeNames(printedB).Single();

        // Distinct ordered shapes get distinct stable names.
        Assert.NotEqual(nameA, nameB);
        Assert.Contains($"data class {nameA}(Id int32, Name string)", printedA);
        Assert.Contains($"data class {nameB}(Count int32, Flag bool, Extra float64)", printedB);

        // The proof that matters: gsc must compile BOTH files together (as one
        // package) with no GS0102 "already declared" collision.
        CompileFilesTogether(("MigrationA.gs", printedA), ("MigrationB.gs", printedB));
    }

    [Fact]
    public void IdenticalAnonymousShape_InDifferentFiles_SamePackage_SharesOneSynthesizedType()
    {
        const string SourceA = @"
namespace Demo
{
    public sealed class MigrationA
    {
        public void Up()
        {
            var shape = new { Id = 1, Name = ""x"" };
        }
    }
}";
        const string SourceB = @"
namespace Demo
{
    public sealed class MigrationB
    {
        public void Down()
        {
            var shape = new { Id = 2, Name = ""y"" };
        }
    }
}";
        (string printedA, string printedB) = TranslateTwoFiles("MigrationA.cs", SourceA, "MigrationB.cs", SourceB);
        string name = AnonymousTypeNames(printedA).Single();

        // The FIRST file to need the shape declares it...
        Assert.Contains($"data class {name}(Id int32, Name string)", printedA);

        // ...and the SECOND file reuses that same synthesized type by name
        // rather than re-declaring its own copy (a re-declaration would ALSO
        // be a GS0102 collision, even for an identical shape).
        Assert.Contains($"{name}(2, \"y\")", printedB);
        Assert.DoesNotContain("data class AnonymousType", printedB);

        CompileFilesTogether(("MigrationA.gs", printedA), ("MigrationB.gs", printedB));
    }

    [Fact]
    public void DistinctAnonymousShapes_InDifferentMethods_SameFile_GetDistinctSyntheticNames()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Migration
    {
        public void Up()
        {
            var shapeUp = new { Id = 1, Name = ""x"" };
        }

        public void Down()
        {
            var shapeDown = new { Count = 1, Flag = true };
        }
    }
}");

        string[] names = AnonymousTypeNames(printed);
        Assert.Equal(2, names.Length);
        Assert.Contains($"data class {names[0]}(Id int32, Name string)", printed);
        Assert.Contains($"data class {names[1]}(Count int32, Flag bool)", printed);

        CompileFilesTogether(("Migration.gs", printed));
    }

    /// <summary>
    /// Part 2 (residual #2282): the EF-Core-style generic
    /// <c>CreateTable</c>/<c>PrimaryKey</c> pattern — a generic method whose
    /// type parameter is inferred from a lambda's anonymous-typed RETURN
    /// value, crossing into ANOTHER lambda's parameter type, with a nested
    /// named-member access (<c>x.Id</c>) on that parameter — must still
    /// resolve end-to-end through the real <c>gsc</c> (not just round-trip
    /// parse). cs2gs sidesteps the generic-inference question entirely by
    /// annotating the lambda parameter with the CONCRETE synthesized type
    /// (resolved from the bound C# semantic model, not re-inferred by gsc),
    /// so gsc's binder never needs to flow a generic return type through
    /// <c>Func/Action</c> type arguments itself.
    /// </summary>
    [Fact]
    public void GenericMethodWithLambdaReturningAnonymousType_CompilesAndBindsMemberAccess()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public sealed class ColumnsBuilder
    {
        public T Column<T>(string name) => default!;
    }

    public sealed class CreateTableBuilder<TColumns>
    {
        public void PrimaryKey(string name, Func<TColumns, object> columns) { }
    }

    public sealed class MigrationBuilder
    {
        public void CreateTable<TColumns>(
            string name,
            Func<ColumnsBuilder, TColumns> columns,
            Action<CreateTableBuilder<TColumns>> constraints)
        {
        }
    }

    public sealed class Migration
    {
        public void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: ""Books"",
                columns: table => new
                {
                    Id = table.Column<int>(name: ""Id""),
                    Title = table.Column<string>(name: ""Title"")
                },
                constraints: table =>
                {
                    table.PrimaryKey(""PK_Books"", x => x.Id);
                });
        }
    }
}");

        string name = AnonymousTypeNames(printed).Single();
        Assert.Contains($"data class {name}(Id int32, Title string)", printed);
        Assert.Contains($"CreateTableBuilder[{name}]", printed);
        Assert.Contains($"(x {name}) -> x.Id", printed);

        // The real proof (not just round-trip parse): gsc must actually BIND
        // the generic CreateTable/PrimaryKey calls and the x.Id member access
        // with zero errors (GS0159/GS0158's original symptom).
        CompileFilesTogether(("Migration.gs", printed));
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string[] AnonymousTypeNames(string printed) =>
        Regex.Matches(printed, @"data class (AnonymousType\d+_[0-9A-F]{16})\(")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    /// <summary>
    /// Translates two files loaded into the SAME in-memory C# project with
    /// ONE shared <see cref="CSharpToGSharpTranslator"/> instance — mirroring
    /// exactly how <c>TranslateStage</c>/<c>TestParityStage</c> translate
    /// every document of a real project — so the package-scoped anonymous-type
    /// registry is actually shared across the two files, the way it is in
    /// production.
    /// </summary>
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
    /// invocation (one package), asserting zero compiler errors — the
    /// end-to-end proof that no synthesized 'AnonymousTypeN' declaration
    /// collides (GS0102) and, for Part 2, that generic-method + lambda-return
    /// inference over a synthesized type actually binds.
    /// </summary>
    private static void CompileFilesTogether(params (string FileName, string Contents)[] files)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2292-e2e", Guid.NewGuid().ToString("N"));
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
