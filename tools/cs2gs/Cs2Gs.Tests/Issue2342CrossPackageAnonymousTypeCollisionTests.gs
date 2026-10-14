// <copyright file="Issue2342CrossPackageAnonymousTypeCollisionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Regression tests for issue #2342: independently synthesized anonymous
/// shapes in different packages compile and emit as distinct package-qualified
/// types. Issue #2598 now gives distinct shapes distinct stable simple names as
/// well, preventing imported-package lookup from selecting the wrong arity.
open class Issue2342CrossPackageAnonymousTypeCollisionTests {
    @Fact
    func DistinctAnonymousShapes_InDifferentPackages_CompileAndEmitDistinctTypes() {
        // Mirrors the real Oahu.Data shape: a "BooksDatabase" file with its own
        // top-level query shape, and a "BooksDatabase.Migrations" file (a child
        // package) whose migration independently projects an anonymous object.
        // One package is a strict dotted prefix of the other, so both package
        // identity and shape identity must remain distinct.
        const BooksDatabaseSource = `
namespace Oahu.BooksDatabase
{
    public sealed class BookRepository
    {
        public object GetSummary()
        {
            return new { SeriesId = 1, BookId = 2 };
        }
    }
}`
        const MigrationSource = `
namespace Oahu.BooksDatabase.Migrations
{
    public sealed class InitialCreate
    {
        public object Up()
        {
            return new { Alias = "x", AudibleId = "y" };
        }
    }
}`
        let (printedBooksDatabase, printedMigration) = TranslateTwoFiles(
            "BookRepository.cs",
            BooksDatabaseSource,
            "InitialCreate.cs",
            MigrationSource
        )
        let booksType = AnonymousTypeName(printedBooksDatabase)
        let migrationType = AnonymousTypeName(printedMigration)
        Assert.Contains("package Oahu.BooksDatabase", printedBooksDatabase)
        Assert.Contains("data class $booksType(SeriesId int32, BookId int32)", printedBooksDatabase)
        Assert.Contains("package Oahu.BooksDatabase.Migrations", printedMigration)
        Assert.Contains("data class $migrationType(Alias string, AudibleId string)", printedMigration)
        Assert.NotEqual(booksType, migrationType)
        // The proof that matters: gsc must compile BOTH files together (as two
        // distinct packages) with no GS0102 "already declared" collision, and
        // must emit BOTH synthesized types.
        let dllPath = CompileFilesTogether(
            ("BookRepository.gs", printedBooksDatabase),
            ("InitialCreate.gs", printedMigration)
        )
        AssertTypeIsEmitted(dllPath, "Oahu.BooksDatabase.$booksType")
        AssertTypeIsEmitted(dllPath, "Oahu.BooksDatabase.Migrations.$migrationType")
    }

    shared {
        private func AnonymousTypeName(printed string) string -> Regex
            .Match(printed, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(")
            .Groups[1]
            .Value

        private func TranslateTwoFiles(fileNameA string, sourceA string, fileNameB string, sourceB string)(
            PrintedA string,
            PrintedB string
        ) {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){(fileNameA, sourceA), (fileNameB, sourceB)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippets should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(2, project.Documents.Count)
            // ONE shared translator instance, mirroring exactly how
            // TranslateStage/TestParityStage translate every document of a real
            // project, so the package-scoped anonymous-type registries are real
            // (keyed independently per package) rather than each file getting an
            // unshared translator.
            let translator = CSharpToGSharpTranslator()
            let documentA = project.Documents[0]
            let documentB = project.Documents[1]
            let contextA = TranslationContext(project.Compilation, documentA.SemanticModel, documentA.FilePath)
            let unitA = translator.TranslateDocument(documentA, contextA)
            let printedA = GSharpPrinter.Print(unitA)
            let contextB = TranslationContext(project.Compilation, documentB.SemanticModel, documentB.FilePath)
            let unitB = translator.TranslateDocument(documentB, contextB)
            let printedB = GSharpPrinter.Print(unitB)
            TranslationTestValidation.AssertBinds(printedA, printedB)
            return (printedA, printedB)
        }

        /// Compiles every `(fileName, contents)` pair together and returns the
        /// emitted assembly for inspection.
        private func CompileFilesTogether(files ...(FileName string, Contents string)) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2342-e2e", Guid.NewGuid().ToString("N"))
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
            return dllPath
        }

        /// Loads the emitted assembly with a (cref:System.Reflection.MetadataLoadContext)
        /// and asserts a type with the given full name (namespace-qualified,
        /// matching the G# package) exists — proving the two same-simple-name
        /// package-scoped types were BOTH emitted, not just one silently winning.
        private func AssertTypeIsEmitted(dllPath string, fullTypeName string) {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let emittedType Type? = asm.GetType(fullTypeName, throwOnError: false)
            Assert.True(
                emittedType != nil,
                "Expected emitted type '$fullTypeName' not found. Available types: " + string.Join(
                    ", ",
                    Array.ConvertAll(asm.GetTypes(), (t Type) -> t.FullName!!)
                )
            )
            Assert.Null(emittedType!!.GetProperty("EqualityContract", BindingFlags.Instance | BindingFlags.NonPublic))
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
