// <copyright file="Issue2292AnonymousTypePackageScopeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.CompilerServices
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Regression tests for issue #2292: anonymous shape declarations are
/// deduplicated across every document in one G# package. Issue #2598 further
/// makes each synthetic name a stable function of the complete ordered shape,
/// so the same rules remain consistent across packages and projects.
///
/// One (cref:AnonymousTypeRegistry) per resolved package is threaded
/// through every mapper the translator creates, so an identical shape is
/// emitted once and reused by later documents.
open class Issue2292AnonymousTypePackageScopeTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ManagedAnonymousContractsRemainInvariantAcrossDocumentOrder(nullableFirst bool, sameContract bool) {
        let references = List[Microsoft.CodeAnalysis.MetadataReference](CSharpProjectLoader.RuntimeReferences())
        {
            Microsoft
                .CodeAnalysis
                .MetadataReference
                .CreateFromFile(typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location)
        }
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "First.cs",
                    "#nullable enable\nusing Gsharp.Values; public static class First { public static string Run() { var array = new string[]{\"safe\"}; var value = new { Reference = ManagedRef<string>.FromArray(array, 0) }; return value.Reference.Borrow() + \":\"; } }"
                ),
                (
                    "Second.cs",
                    if sameContract {
                        "#nullable enable\nusing Gsharp.Values; public static class Second { public static string Run() { var array = new string[]{\"next\"}; var value = new { Reference = ManagedRef<string>.FromArray(array, 0) }; return value.Reference.Borrow(); } }"
                    } else {
                        "#nullable enable\nusing Gsharp.Values; public static class Second { public static string Run() { var array = new string?[]{null}; var value = new { Reference = ManagedRef<string?>.FromArray(array, 0) }; return value.Reference.Borrow() ?? \"nil\"; } }"
                    }
                )
            },
            references
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let translator = CSharpToGSharpTranslator()
        for special in[]bool{false, true, false} {
            let printed = [2]string
            for index in(
                if nullableFirst {
                    []int32{1, 0}
                } else {
                    []int32{0, 1}
                }
            ) {
                let document = project.Documents[index]
                printed[index] = GSharpPrinter.Print(
                    translator.TranslateDocument(
                        document,
                        TranslationContext(
                            project.Compilation,
                            project.Compilation.GetSemanticModel(document.SyntaxTree, ignoreAccessibility: special),
                            document.FilePath
                        )
                    )
                )
            }
            CompileFilesTogether(("First.gs", printed[0]), ("Second.gs", printed[1]))
            CompileAndRunOutput(
                [](Name string, Text string){("First.gs", printed[0]), ("Second.gs", printed[1])},
                if sameContract {
                    "safe:next"
                } else {
                    "safe:nil"
                },
                []string{typeof(Gsharp.Values.ManagedRef[_]).Assembly.Location}
            )
            if sameContract {
                Assert.Single(AnonymousTypeNames(printed[0]).Concat(AnonymousTypeNames(printed[1])))
            } else {
                Assert.Matches("data class [^\\n]+\\(Reference managed\\[string\\]\\)", printed[0])
                Assert.Matches("data class [^\\n]+\\(Reference managed\\[string\\?\\]\\)", printed[1])
            }
        }
    }

    @Theory
    @InlineData(0, 0)
    @InlineData(0, 1)
    @InlineData(1, 0)
    @InlineData(1, 1)
    @InlineData(0, 2)
    @InlineData(2, 0)
    @InlineData(2, 2)
    func OutputDeclarationOwnership_SurvivesCollectedContextsAndMixedModels(firstMode int32, secondMode int32) {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "First.cs",
                    "public static class First { public static int Run() { var item = new { Id = 21 }; return item.Id; } }"
                ),
                (
                    "Second.cs",
                    "public static class Second { public static int Run() { var item = new { Id = 22 }; return item.Id; } }"
                )
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let translator = CSharpToGSharpTranslator()
        let first = TranslateTemporaryContext(translator, project.Compilation, project.Documents[0], firstMode)
        GC.Collect()
        GC.WaitForPendingFinalizers()
        GC.Collect()
        Assert.False(first.Context.IsAlive)
        Assert.False(first.Catalog.IsAlive)
        let second = TranslateTemporaryContext(translator, project.Compilation, project.Documents[1], secondMode)
        CompileFilesTogether(("First.gs", first.Printed), ("Second.gs", second.Printed))
        TranslationTestValidation.AssertBinds(first.Printed, second.Printed)
        CompileAndRunOutput(first.Printed + "\n" + second.Printed)
    }

    @Fact
    func OutputDeclarationOwnership_DoesNotRetainTheSourceCompilation() {
        let translator = CSharpToGSharpTranslator()
        let compilation = TranslateCollectibleProject(translator)
        GC.Collect()
        GC.WaitForPendingFinalizers()
        GC.Collect()
        Assert.False(compilation.IsAlive)
        GC.KeepAlive(translator)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func OutputDeclarationOwnership_DistinguishesEffectivePropertyContracts(specialFirst bool, nested bool) {
        let creation = if nested {
            "new { Wrap = new { Item = VALUE } }"
        } else {
            "new { Item = VALUE }"
        }
        let read = if nested {
            "item.Wrap.Item"
        } else {
            "item.Item"
        }
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "First.cs",
                    "public static class First { public static string Run() { var item = " + creation.Replace(
                        "VALUE",
                        "\"safe\""
                    ) +
                        "; return " +
                        read +
                        " + \":\"; } }"
                ),
                (
                    "Second.cs",
                    "public static class Second { public static string Run() { var item = " + creation.Replace(
                        "VALUE",
                        "\"safe\""
                    ) +
                        "; return " +
                        read +
                        " ?? \"nil\"; } }"
                )
            }
        )
        let second = project.Documents[1]
        let original = second
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
            .Single()
        let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
            Microsoft
                .CodeAnalysis
                .CSharp
                .SyntaxFactory
                .ParseMemberDeclaration(
                "public static string Run() { var item = " + creation.Replace("VALUE", "(string)null") +
                    "; if (" +
                    read +
                    " != null) return \"wrong\"; return \"nil\"; }"
            )
        )
        Assert.True(
            Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpExtensions
                .TryGetSpeculativeSemanticModelForMethodBody(
                second.SemanticModel,
                original.Body!!.SpanStart,
                replacement,
                out var speculative
            )
        )
        let special = speculative ?? throw InvalidOperationException("Speculative model missing.")
        let translator = CSharpToGSharpTranslator()
        let printed = [2]string
        for index in(
            if specialFirst {
                []int32{1, 0}
            } else {
                []int32{0, 1}
            }
        ) {
            let document = project.Documents[index]
            let model = if index == 1 {
                special
            } else {
                document.SemanticModel
            }
            let catalog = List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]{project.Compilation}
            let context = TranslationContext(project.Compilation, model, document.FilePath, catalog, catalog)
            printed[index] = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        }
        CompileFilesTogether(("First.gs", printed[0]), ("Second.gs", printed[1]))
        CompileAndRunOutput(printed[0] + "\n" + printed[1], "safe:nil")
        Assert.Matches("data class [^\\n]+\\(Item string\\)", printed[0])
        Assert.Matches("data class [^\\n]+\\(Item string\\?\\)", printed[1])
    }

    @MethodImpl(MethodImplOptions.NoInlining)
    private func TranslateCollectibleProject(translator CSharpToGSharpTranslator) WeakReference {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (
                    "Collectible.cs",
                    "public static class Collectible { public static object Make() => new { Id = 42 }; }"
                )
            }
        )
        let document = project.Documents[0]
        let catalog = List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]{project.Compilation}
        let context = TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            catalog,
            catalog
        )
        Assert.Contains(
            "data class AnonymousType",
            GSharpPrinter.Print(translator.TranslateDocument(document, context))
        )
        return WeakReference(project.Compilation)
    }

    @MethodImpl(MethodImplOptions.NoInlining)
    private func TranslateTemporaryContext(
        translator CSharpToGSharpTranslator,
        compilation Microsoft.CodeAnalysis.CSharp.CSharpCompilation,
        document LoadedDocument,
        mode int32
    )(Printed string, Context WeakReference, Catalog WeakReference) {
        var model = compilation.GetSemanticModel(document.SyntaxTree, ignoreAccessibility: mode == 1)
        if mode == 2 {
            let original = document
                .GetRoot()
                .DescendantNodes()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax]()
                .Single()
            let replacement = Assert.IsAssignableFrom[Microsoft.CodeAnalysis.CSharp.Syntax.BaseMethodDeclarationSyntax](
                Microsoft.CodeAnalysis.CSharp.SyntaxFactory.ParseMemberDeclaration(original.ToString())
            )
            Assert.True(
                Microsoft
                    .CodeAnalysis
                    .CSharp
                    .CSharpExtensions
                    .TryGetSpeculativeSemanticModelForMethodBody(
                    model,
                    original.Body!!.SpanStart,
                    replacement,
                    out var speculative
                )
            )
            model = speculative ?? throw InvalidOperationException("Speculative model missing.")
        }
        let catalog = List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]{compilation}
        let context = TranslationContext(compilation, model, document.FilePath, catalog, catalog)
        let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        return (printed, WeakReference(context), WeakReference(catalog))
    }

    private func CompileAndRunOutput(
        printed string,
        expected string = "43",
        extraReferences IReadOnlyList[string]? = nil
    ) ->
    this.CompileAndRunOutput([](Name string, Text string){("Output.gs", printed)}, expected, extraReferences)

    private func CompileAndRunOutput(
        files IReadOnlyList[(Name string, Text string)],
        expected string,
        extraReferences IReadOnlyList[string]? = nil
    ) {
        let compiler = FindCompiler() ?? throw InvalidOperationException("Compiler missing.")
        let directory = Path.Combine(AppContext.BaseDirectory, "issue2292-runtime", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let dll = Path.Combine(directory, "Output.dll")
            let sources = List[string]()
            for file in files {
                let path = Path.Combine(directory, file.Name)
                File.WriteAllText(path, file.Text)
                sources.Add("\"" + path + "\"")
            }
            let driver = Path.Combine(directory, "Driver.gs")
            File.WriteAllText(driver, "System.Console.WriteLine(First.Run() + Second.Run())\n")
            sources.Add("\"" + driver + "\"")
            let extra = extraReferences ?? Array.Empty[string]()
            let arguments = string.Join(" ", extra.Select((path string) -> "/reference:\"" + path + "\""))
            let (compileExit, compileOutput) = RunDotnet(
                "\"" + compiler + "\" /out:\"" + dll + "\" " + string.Join(" ", sources) + " " + arguments
            )
            Assert.True(compileExit == 0, compileOutput)
            File.WriteAllText(
                Path.ChangeExtension(dll, ".runtimeconfig.json"),
                "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}"
            )
            let references = string.Join(
                " ",
                Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll").Select(
                    (path string) -> "-r \"" + path + "\""
                )
            )
            let (verifyExit, verifyOutput) = RunDotnet(
                "tool run ilverify \"" + dll + "\" -s System.Private.CoreLib " + references + " " + string.Join(
                    " ",
                    extra.Select((path string) -> "-r \"" + path + "\"")
                )
            )
            Assert.True(verifyExit == 0, verifyOutput)
            for reference in extra {
                File.Copy(reference, Path.Combine(directory, Path.GetFileName(reference)), overwrite: true)
            }
            let (runExit, output) = RunDotnet("\"" + dll + "\"")
            Assert.True(runExit == 0, output)
            Assert.Equal(Encoding.UTF8.GetBytes(expected + Environment.NewLine), Encoding.UTF8.GetBytes(output))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func DistinctAnonymousShapes_InDifferentFiles_SamePackage_GetDistinctSyntheticNames() {
        const SourceA = `
namespace Demo
{
    public sealed class MigrationA
    {
        public void Up()
        {
            var shapeA = new { Id = 1, Name = "x" };
        }
    }
}`
        const SourceB = `
namespace Demo
{
    public sealed class MigrationB
    {
        public void Down()
        {
            var shapeB = new { Count = 1, Flag = true, Extra = 2.0 };
        }
    }
}`
        let (printedA, printedB) = TranslateTwoFiles("MigrationA.cs", SourceA, "MigrationB.cs", SourceB)
        let nameA = AnonymousTypeNames(printedA).Single()
        let nameB = AnonymousTypeNames(printedB).Single()
        // Distinct ordered shapes get distinct stable names.
        Assert.NotEqual(nameA, nameB)
        Assert.Contains("data class $nameA(Id int32, Name string)", printedA)
        Assert.Contains("data class $nameB(Count int32, Flag bool, Extra float64)", printedB)
        // The proof that matters: gsc must compile BOTH files together (as one
        // package) with no GS0102 "already declared" collision.
        CompileFilesTogether(("MigrationA.gs", printedA), ("MigrationB.gs", printedB))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IdenticalAnonymousShape_InDifferentFiles_SamePackage_SharesOneSynthesizedType(
        separateEquivalentCatalogs bool
    ) {
        const SourceA = `
namespace Demo
{
    public sealed class MigrationA
    {
        public void Up()
        {
            var shape = new { Id = 1, Name = "x" };
        }
    }
}`
        const SourceB = `
namespace Demo
{
    public sealed class MigrationB
    {
        public void Down()
        {
            var shape = new { Id = 2, Name = "y" };
        }
    }
}`
        let (printedA, printedB) = TranslateTwoFiles(
            "MigrationA.cs",
            SourceA,
            "MigrationB.cs",
            SourceB,
            separateEquivalentCatalogs
        )
        let name = AnonymousTypeNames(printedA).Single()
        // The FIRST file to need the shape declares it...
        Assert.Contains("data class $name(Id int32, Name string)", printedA)
        // ...and the SECOND file reuses that same synthesized type by name
        // rather than re-declaring its own copy (a re-declaration would ALSO
        // be a GS0102 collision, even for an identical shape).
        Assert.Contains("$name(2, \"y\")", printedB)
        Assert.DoesNotContain("data class AnonymousType", printedB)
        CompileFilesTogether(("MigrationA.gs", printedA), ("MigrationB.gs", printedB))
    }

    @Fact
    func DistinctAnonymousShapes_InDifferentMethods_SameFile_GetDistinctSyntheticNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Migration
    {
        public void Up()
        {
            var shapeUp = new { Id = 1, Name = "x" };
        }

        public void Down()
        {
            var shapeDown = new { Count = 1, Flag = true };
        }
    }
}`)
        let names = AnonymousTypeNames(printed)
        Assert.Equal(2, names.Length)
        Assert.Contains("data class ${names[0]}(Id int32, Name string)", printed)
        Assert.Contains("data class ${names[1]}(Count int32, Flag bool)", printed)
        CompileFilesTogether(("Migration.gs", printed))
    }

    /// Part 2 (residual #2282): the EF-Core-style generic
    /// `CreateTable`/`PrimaryKey` pattern — a generic method whose
    /// type parameter is inferred from a lambda's anonymous-typed RETURN
    /// value, crossing into ANOTHER lambda's parameter type, with a nested
    /// named-member access (`x.Id`) on that parameter — must still
    /// resolve end-to-end through the real `gsc` (not just round-trip
    /// parse). cs2gs sidesteps the generic-inference question entirely by
    /// annotating the lambda parameter with the CONCRETE synthesized type
    /// and preserving the converted delegate's exact `object` return
    /// (resolved from the bound C# semantic model, not re-inferred by gsc),
    /// so gsc's binder never needs to flow a generic return type through
    /// `Func/Action` type arguments itself.
    @Fact
    func GenericMethodWithLambdaReturningAnonymousType_CompilesAndBindsMemberAccess() {
        let printed = TranslateUnit(`
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
                name: "Books",
                columns: table => new
                {
                    Id = table.Column<int>(name: "Id"),
                    Title = table.Column<string>(name: "Title")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Books", x => x.Id);
                });
        }
    }
}`)
        let name = AnonymousTypeNames(printed).Single()
        Assert.Contains("data class $name(Id int32, Title string)", printed)
        Assert.Contains("CreateTableBuilder[$name]", printed)
        Assert.Matches(
            "table\\.PrimaryKey\\(\"PK_Books\", func \\(x ${Regex.Escape(name)}\\) object \\{\\s*return x\\.Id\\s*\\}\\)",
            printed
        )
        // The real proof (not just round-trip parse): gsc must actually BIND
        // the generic CreateTable/PrimaryKey calls and the x.Id member access
        // with zero errors (GS0159/GS0158's original symptom).
        CompileFilesTogether(("Migration.gs", printed))
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func AnonymousTypeNames(printed string)[]string -> Regex
            .Matches(printed, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        /// Translates two files loaded into the SAME in-memory C# project with
        /// ONE shared (cref:CSharpToGSharpTranslator) instance — mirroring
        /// exactly how `TranslateStage`/`TestParityStage` translate
        /// every document of a real project — so the package-scoped anonymous-type
        /// registry is actually shared across the two files, the way it is in
        /// production.
        private func TranslateTwoFiles(
            fileNameA string,
            sourceA string,
            fileNameB string,
            sourceB string,
            separateEquivalentCatalogs bool = false
        )(PrintedA string, PrintedB string) {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){(fileNameA, sourceA), (fileNameB, sourceB)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippets should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(2, project.Documents.Count)
            let translator = CSharpToGSharpTranslator()
            let documentA = project.Documents[0]
            let documentB = project.Documents[1]
            let firstCatalog = if separateEquivalentCatalogs {
                List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]{project.Compilation}
            } else {
                default(List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]?)
            }
            let secondCatalog = if separateEquivalentCatalogs {
                List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]{project.Compilation}
            } else {
                default(List[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]?)
            }
            let contextA = TranslationContext(
                project.Compilation,
                documentA.SemanticModel,
                documentA.FilePath,
                firstCatalog,
                firstCatalog
            )
            let unitA = translator.TranslateDocument(documentA, contextA)
            let printedA = GSharpPrinter.Print(unitA)
            let contextB = TranslationContext(
                project.Compilation,
                documentB.SemanticModel,
                documentB.FilePath,
                secondCatalog,
                secondCatalog
            )
            let unitB = translator.TranslateDocument(documentB, contextB)
            let printedB = GSharpPrinter.Print(unitB)
            if separateEquivalentCatalogs {
                CompileFilesTogether(("MigrationA.gs", printedA), ("MigrationB.gs", printedB))
            }
            TranslationTestValidation.AssertBinds(printedA, printedB)
            return (printedA, printedB)
        }

        /// Compiles every `(fileName, contents)` pair together, as ONE gsc
        /// invocation (one package), asserting zero compiler errors — the
        /// end-to-end proof that no synthesized 'AnonymousTypeN' declaration
        /// collides (GS0102) and, for Part 2, that generic-method + lambda-return
        /// inference over a synthesized type actually binds.
        private func CompileFilesTogether(files ...(FileName string, Contents string)) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2292-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPaths = List[string]()
            for (fileName, contents) in files {
                let gsPath = Path.Combine(workDir, fileName)
                File.WriteAllText(gsPath, contents)
                gsPaths.Add(gsPath)
            }
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            let quotedSources = string.Join(" ", gsPaths.ConvertAll((p string) -> "\"$p\""))
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:library /out:\"$dllPath\" $quotedSources")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated files together with zero errors. Output:\n" + compileOut
            )
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
