// <copyright file="Issue3645ReferencedExeEntryTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Regression coverage for issue #3645: an executable project that another
/// project in the same migration run compiles against must keep its
/// entry-point class as a real G# class. Flattening it to top-level statements
/// (ADR-0115 §B.11 T3) erases the type from the migrated assembly, so every
/// cross-project use site (e.g. the migrated GeneratorHost tests calling
/// `GsgenProgram.Run(...)` on the Gsgen.Cli exe) fails with GS0157.
class Issue3645ReferencedExeEntryTypeTests {
    @Fact
    func PreserveEntryType_KeepsEntryClassAsConsumableType() {
        let printed = TranslateEntrySource(preserveEntryType: true)
        // The entry class must survive as a CLR-visible type so a referencing
        // project's `DemoProgram.Run(...)` call sites resolve. gsc supports a
        // class-scoped static `Main` (issue #1996), so this form still runs.
        Assert.Contains("class DemoProgram", printed)
        Assert.Contains("Main", printed)
        Assert.Contains("Run", printed)
    }

    @Fact
    func DefaultTranslation_StillFlattensEntryClass() {
        let printed = TranslateEntrySource(preserveEntryType: false, source: PrivateHelperEntrySource)
        // The unreferenced-executable shape is unchanged: T3 flattening drops
        // the entry class and hoists its members to top level. Issue #3837
        // narrowed this to an entry class with nothing but `private` non-entry
        // members — a `public`/`internal` helper is consumable surface that
        // flattening would erase, so it now preserves the class even without
        // this opt-in (see Issue3837EntryTypeExportedSurfaceTests).
        Assert.DoesNotContain("class DemoProgram", printed)
        Assert.Contains("func Run", printed)
    }

    @Fact
    func CollectCompileReferencedProjectPaths_TracksCompileReferencesOnly() {
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-issue3645-" + Guid.NewGuid().ToString("N"))
        try {
            let exeDir = Path.Combine(root, "Exe")
            let buildOnlyDir = Path.Combine(root, "BuildOnly")
            let testsDir = Path.Combine(root, "Tests")
            Directory.CreateDirectory(exeDir)
            Directory.CreateDirectory(buildOnlyDir)
            Directory.CreateDirectory(testsDir)
            let exeProject = Path.Combine(exeDir, "Exe.csproj")
            let buildOnlyProject = Path.Combine(buildOnlyDir, "BuildOnly.csproj")
            let testsProject = Path.Combine(testsDir, "Tests.csproj")
            File.WriteAllText(exeProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
</Project>`)
            File.WriteAllText(buildOnlyProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
</Project>`)
            File.WriteAllText(testsProject, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="..\Exe\Exe.csproj" />
    <ProjectReference Include="..\BuildOnly\BuildOnly.csproj" ReferenceOutputAssembly="false" />
  </ItemGroup>
</Project>`)
            let referenced = DeclaredProjectItems.CollectCompileReferencedProjectPaths(
                []string{exeProject, buildOnlyProject, testsProject}
            )
            // The compile reference makes Exe's entry class consumable API
            // surface; the ReferenceOutputAssembly="false" edge contributes no
            // type surface, so BuildOnly keeps the default T3 flattening.
            Assert.Contains(Path.GetFullPath(exeProject), referenced)
            Assert.DoesNotContain(Path.GetFullPath(buildOnlyProject), referenced)
            Assert.DoesNotContain(Path.GetFullPath(testsProject), referenced)
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        private const EntrySource string = `using System;
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
}`

        /// Issue #3837: the same entry class with a `private` helper instead of
        /// a public one. Nothing outside the class can consume it, so T3 flattening
        /// erases no surface and the canonical top-level form still applies.
        private const PrivateHelperEntrySource string = `using System;
using System.IO;

namespace Demo.Cli;

public static class DemoProgram
{
    public static int Main(string[] args) => Run(args, Console.Out);

    private static int Run(string[] args, TextWriter stdout)
    {
        stdout.WriteLine(args.Length);
        return 0;
    }
}`

        private func TranslateEntrySource(preserveEntryType bool, source string = `using System;
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
}`) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("DemoProgram.cs", source)},
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Entry source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translator = CSharpToGSharpTranslator(preserveEntryType: preserveEntryType)
            return GSharpPrinter.Print(translator.TranslateDocument(document, context))
        }
    }
}
