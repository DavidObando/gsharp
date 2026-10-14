// <copyright file="Issue3839RefReturningMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3839: the by-ref-ness of a member was lost on the way out of cs2gs,
/// in two different ways with two different verdicts.
/// 1. An expression-bodied `ref`-returning METHOD kept its `ref` return type but folded to the G# arrow
/// form with a plain (non-`ref`) return, which gsc rejects with GS0252. G# genuinely HAS this construct
/// (issue #490 / ADR-0060, block form only), so this is a translator bug and is fixed: the arrow fold
/// is refused for a ref return and the block body carries `return ref lvalue`.
/// 2. A `ref` PROPERTY or INDEXER lost its `ref` entirely and became a copy-returning member — no error
/// anywhere, a pure behaviour change. At the time G# had NO such construct (the by-ref return was a
/// `func` feature; there was no `prop P ref T` spelling), so the honest verdict was a loud gap. Issue
/// #3879 then added the spelling, and the plain-`ref` property and indexer now TRANSLATE — see
/// `Issue3879RefReturningPropertyTranslationTests`. Issue #4220 extends this to `ref readonly`. Neither
/// a copy-returning nor a writable-ref translation may replace that readonly contract.
///
/// The method half is proven by EXECUTION, not by printed shape: a printed-shape
/// assertion passes just as happily on a copy-returning member. The translated
/// G# is compiled by gsc and a C# driver writes through the returned reference;
/// the write has to be observable through the original storage.
class Issue3839RefReturningMemberTranslationTests {
    /// The declaration keeps `ref` AND the returned expression is emitted as
    /// a by-ref return. G#'s arrow form has no `-> ref lvalue` spelling,
    /// so the member must fall back to the block body.
    @Fact
    func ExpressionBodiedRefMethod_EmitsBlockBodyWithReturnRef() {
        let printed = Translate(RefMethodSource)
        Assert.Contains("ref int32", printed, StringComparison.Ordinal)
        Assert.Contains("return ref values[index]", printed, StringComparison.Ordinal)
        // The defect shape: the arrow form with the `ref` dropped from the
        // returned expression (`func GetValue(index int32) ref int32 ->
        // values[index]`), which gsc rejects with GS0252.
        Assert.DoesNotContain("ref int32 ->", printed, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard: an ORDINARY expression-bodied method must still fold
    /// to the idiomatic G# arrow form (issue #1278 / ADR-0131). Without this,
    /// "never fold an expression body" would satisfy the test above.
    @Fact
    func ExpressionBodiedNonRefMethod_StillFoldsToTheArrowForm() {
        let printed = Translate(`namespace Repro
{
    public class Plain
    {
        private readonly int[] values = new[] { 1, 2, 3 };

        public int Read(int index) => values[index];
    }
}`)
        Assert.Contains("-> values[index]", printed, StringComparison.Ordinal)
    }

    /// The executing proof. gsc compiles the translated G#; a C# driver takes a
    /// reference through the emitted member, writes 99 through it, and reads the
    /// storage back. A copy-returning member would still read 41 — which is
    /// exactly what the silent half of #3839 produced — so this assertion, unlike
    /// any shape assertion, cannot be satisfied by a member that lost its
    /// `ref`.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func TranslatedRefMethod_ReturnsALiveAlias(readOnly bool) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let printed = Translate(
            if readOnly {
                RefMethodSource.Replace("public ref int", "public ref readonly int")
            } else {
                RefMethodSource
            }
        )
        let workDir = NewDirectory("runtime")
        let sourcePath = Path.Combine(workDir, "Repro.gs")
        let libraryPath = Path.Combine(workDir, "Repro.dll")
        File.WriteAllText(sourcePath, printed + Environment.NewLine)
        let compile = ProcessRunner.Run(
            "dotnet",
            []string{compiler!!, "/target:library", "/out:" + libraryPath, sourcePath},
            workDir
        )
        Assert.True(
            compile.ExitCode == 0,
            "gsc must compile the translated ref-returning method. Output:\n" + compile.Output + `
Translated G#:
` + printed
        )
        let loadContext = AssemblyLoadContext("TranslatedRefMethod_ReturnsALiveAlias", isCollectible: true)
        try {
            let library = loadContext.LoadFromAssemblyPath(libraryPath)
            let holder = library.GetType("Repro.Holder") ??
                throw InvalidOperationException(
                "Repro.Holder is missing from the emitted assembly: " + string.Join(
                    ", ",
                    library.GetTypes().Select((t Type) -> t.FullName)
                )
            )
            // Metadata direction: the emitted method genuinely returns by ref.
            let getValue = holder.GetMethod("GetValue") ??
                throw InvalidOperationException("GetValue is missing from the emitted type.")
            Assert.True(
                getValue.ReturnType.IsByRef,
                "The emitted GetValue must return by reference, not by value; it returned " +
                    getValue
                    .ReturnType
                    .FullName
            )
            // Behaviour direction: a C# consumer writes through the reference.
            let driverPath = CompileDriver(workDir, libraryPath, readOnly)
            let driver = loadContext.LoadFromAssemblyPath(driverPath)
            let result object? = driver.GetType("Repro.Driver")!!.GetMethod("Run")!!.Invoke(nil, nil)
            Assert.Equal(99, Assert.IsType[int32](result))
        } finally {
            loadContext.Unload()
        }
    }

    /// Issue #4220: readonly returns preserve both aliasing and write permission.
    @Fact
    func RefReadonlyProperty_PreservesContract() {
        let printed = Translate(`namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref readonly int Property => ref values[0];
    }
}`)
        Assert.Contains("prop Property ref readonly int32", printed, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard: ordinary properties and indexers must NOT gap. Without
    /// this, "report every property" would satisfy the three tests above.
    @Fact
    func OrdinaryPropertyAndIndexer_DoNotGap() {
        let diagnostics = Diagnose(`namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public int Property => values[0];

        public int Count { get; set; }

        public int this[int index] => values[index];
    }
}`)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
    }

    shared {
        private const RefMethodSource string = `namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref int GetValue(int index) => ref values[index];

        public int Read(int index) => values[index];
        public void Set(int index, int value) { values[index] = value; }
    }
}`

        private func CompileDriver(workDir string, libraryPath string, readOnly bool) string {
            let driverSource = (`namespace Repro
{
    public static class Driver
    {
        public static int Run()
        {
            var holder = new Holder();
            ref ` + "${(if readOnly { "readonly " } else { "" })}" + `int slot = ref holder.GetValue(1);
            ` + "${(if readOnly { "holder.Set(1, 99);" } else { "slot = 99;" })}" + `
            return ` + "${(if readOnly { "slot" } else { "holder.Read(1)" })}" + `;
        }
    }
}`)
            let references = List[MetadataReference](
                CSharpProjectLoader.RuntimeReferences()
            ){MetadataReference.CreateFromFile(libraryPath)}
            let compilation = CSharpCompilation.Create(
                "Repro.Driver",
                []SyntaxTree{CSharpSyntaxTree.ParseText(driverSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let driverPath = Path.Combine(workDir, "Repro.Driver.dll")
            let emitted = compilation.Emit(driverPath)
            Assert.True(
                emitted.Success,
                "The C# driver must compile against the gsc-emitted assembly — if `ref int slot = ref " +
                    "holder.GetValue(1)` does not compile, the emitted member is not by-ref. Diagnostics:\n" +
                    string.Join(Environment.NewLine, emitted.Diagnostics)
            )
            return driverPath
        }

        private func Diagnose(source string) IReadOnlyList[TranslationDiagnostic] {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Repro.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            CSharpToGSharpTranslator().TranslateDocument(document, context)
            return context.Diagnostics.ToList()
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Repro.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func NewDirectory(category string) string {
            let path = Path.Combine(
                AppContext.BaseDirectory,
                "issue-3839-ref-members",
                category,
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(path)
            return path
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
