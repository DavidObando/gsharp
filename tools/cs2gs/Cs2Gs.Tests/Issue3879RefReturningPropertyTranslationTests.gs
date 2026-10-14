// <copyright file="Issue3879RefReturningPropertyTranslationTests.cs" company="GSharp">
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

/// Issue #3879 (ADR-0060 amendment): G# gained a by-ref return on `prop`, so
/// the property/indexer half of #3839 — which PR #3878 correctly gapped, because
/// there was no G# spelling to translate into — now translates.
/// - A C# `ref` property becomes `prop P ref T -> lvalue` (or the block form when the body does not
/// fold).
/// - A C# `ref` indexer becomes `prop this[…] ref T -> lvalue`.
/// - Issue #4220 adds `ref readonly`. Translation preserves its live alias identity without granting
/// write permission.
///
/// The aliasing is proven by EXECUTION, reusing #3878's shape: a printed-shape
/// assertion passes just as happily on a copy-returning member. gsc compiles the
/// translated G# into a library, a C# driver is compiled against it with Roslyn,
/// and the driver takes `ref int slot = ref holder.Property`, writes through
/// it, and reads the storage back through a separate accessor. (The driver is C#
/// rather than G# because G#'s ref-alias binder does not accept a call result as
/// an lvalue — the documented #1900 limit.)
class Issue3879RefReturningPropertyTranslationTests {
    /// The declaration keeps its `ref`, on the property and on the indexer.
    /// The G# arrow form is ref-aware (gsc desugars `prop P ref T -> e` to
    /// `{ get { return ref e } }`), so the idiomatic ADR-0131 fold survives
    /// — unlike the `func` arrow, which #3839 had to refuse.
    @Fact
    func RefPropertyAndIndexer_KeepTheirRefOnTheDeclaration() {
        let printed = Translate(RefMemberSource)
        Assert.Contains("prop Property ref int32 -> values[0]", printed, StringComparison.Ordinal)
        Assert.Contains("prop this[index int32] ref int32 -> values[index]", printed, StringComparison.Ordinal)
        // The defect shape #3839 named: the member migrating into a
        // copy-returning `prop Property int32`.
        Assert.DoesNotContain("prop Property int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("prop this[index int32] int32", printed, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard: ordinary properties and indexers must NOT acquire a
    /// `ref`. Without this, "always print `ref`" would satisfy the test
    /// above.
    @Fact
    func OrdinaryPropertyAndIndexer_StayByValue() {
        let printed = Translate(`namespace Repro
{
    public class Plain
    {
        private readonly int[] values = new[] { 1, 2, 3 };

        public int Property => values[0];

        public int Count { get; set; }

        public int this[int index] => values[index];
    }
}`)
        Assert.Contains("prop Property int32 -> values[0]", printed, StringComparison.Ordinal)
        Assert.Contains("prop this[index int32] int32 -> values[index]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ref int32", printed, StringComparison.Ordinal)
    }

    /// The executing proof. gsc compiles the translated G#; a C# driver takes a
    /// reference through the emitted property and through the emitted indexer,
    /// mutates storage through an authorized path, and reads the aliases. A copy-returning member
    /// would still read 40/41 — which is exactly what the silent half of #3839
    /// produced — so this assertion, unlike any shape assertion, cannot be
    /// satisfied by a member that lost its `ref`.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func TranslatedRefPropertyAndIndexer_ReturnLiveAliases(readOnly bool) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let printed = Translate(
            if readOnly {
                RefMemberSource.Replace("public ref int", "public ref readonly int")
            } else {
                RefMemberSource
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
            "gsc must compile the translated ref-returning property and indexer. Output:\n" + compile.Output + `
Translated G#:
` + printed
        )
        let loadContext = AssemblyLoadContext("TranslatedRefPropertyAndIndexer_ReturnLiveAliases", isCollectible: true)
        try {
            let library = loadContext.LoadFromAssemblyPath(libraryPath)
            let holder = library.GetType("Repro.Holder") ??
                throw InvalidOperationException(
                "Repro.Holder is missing from the emitted assembly: " + string.Join(
                    ", ",
                    library.GetTypes().Select((t Type) -> t.FullName)
                )
            )
            // Metadata direction: the emitted members genuinely return by ref,
            // on the PropertyDef row AND on the getter MethodDef.
            for name in[]string{"Property", "Item"} {
                let property = holder.GetProperty(name) ??
                    throw InvalidOperationException("'$name' is missing from the emitted type.")
                Assert.True(
                    property.PropertyType.IsByRef,
                    "the emitted '$name' must be by-ref; it was ${property.PropertyType}"
                )
                Assert.True(
                    property.GetMethod!!.ReturnType.IsByRef,
                    "the emitted get_$name must return by reference; it returned ${property.GetMethod!!.ReturnType}"
                )
            }
            // A C# consumer retains the references across legitimate mutation.
            let driverPath = CompileDriver(workDir, libraryPath, readOnly)
            let driver = loadContext.LoadFromAssemblyPath(driverPath)
            let result = driver.GetType("Repro.Driver")!!.GetMethod("Run")!!.Invoke(nil, nil)!!
            Assert.Equal([]int32{99, 88, 77}, Assert.IsType[[]int32](result))
        } finally {
            loadContext.Unload()
        }
    }

    /// Issue #4220: readonly property declarations keep their write permission.
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

    /// The indexer form of the same readonly contract.
    @Fact
    func RefReadonlyIndexer_PreservesContract() {
        let printed = Translate(`namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref readonly int this[int index] => ref values[index];
    }
}`)
        Assert.Contains("prop this[index int32] ref readonly int32", printed, StringComparison.Ordinal)
    }

    /// C# allows an ABSTRACT `ref` property; gsc does not, because a slot
    /// names nothing to alias and G# has no ref-kind matching for property slots
    /// (GS0578). The difference has to surface HERE, as a translate-stage gap —
    /// emitting `prop P ref T` and letting gsc refuse it turns a local, loud
    /// answer into a compile failure several steps downstream, which is the
    /// failure mode #3839/#3878 established this gap to avoid.
    @Fact
    func AbstractRefProperty_StaysLoudGap() {
        Assert.Contains(Diagnose(`namespace Repro
{
    public abstract class Holder
    {
        public abstract ref int Property { get; }
    }
}`), (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported &&
                d.Message!!.Contains("abstract or declared on an interface", StringComparison.Ordinal))
    }

    /// The interface form of the same concrete-only restriction.
    @Fact
    func InterfaceRefProperty_StaysLoudGap() {
        Assert.Contains(Diagnose(`namespace Repro
{
    public interface IHolder
    {
        ref int Property { get; }
    }
}`), (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported &&
                d.Message!!.Contains("abstract or declared on an interface", StringComparison.Ordinal))
    }

    /// The abstract indexer form.
    @Fact
    func AbstractRefIndexer_StaysLoudGap() {
        Assert.Contains(Diagnose(`namespace Repro
{
    public abstract class Holder
    {
        public abstract ref int this[int index] { get; }
    }
}`), (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported &&
                d.Message!!.Contains("abstract or declared on an interface", StringComparison.Ordinal))
    }

    /// The interface indexer form.
    @Fact
    func InterfaceRefIndexer_StaysLoudGap() {
        Assert.Contains(Diagnose(`namespace Repro
{
    public interface IHolder
    {
        ref int this[int index] { get; }
    }
}`), (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported &&
                d.Message!!.Contains("abstract or declared on an interface", StringComparison.Ordinal))
    }

    /// Anti-vacuity for the four gaps above: a CONCRETE ref property and indexer
    /// on an ordinary class must still translate cleanly, so the new check cannot
    /// have been written as a blanket refusal of every ref member.
    @Fact
    func ConcreteRefMembers_StillTranslate() {
        Assert.DoesNotContain(Diagnose(`namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref int Property => ref values[0];

        public ref int this[int index] => ref values[index];
    }
}`), (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
    }

    /// Issue #1987's USE-site gap is lifted for a plain `ref` indexer: the
    /// declaration now translates, and gsc's emitter loads through the returned
    /// managed pointer at the read, so a plain index expression is the correct
    /// lowering with the same read semantics C# gives it.
    @Fact
    func ReadThroughARefIndexer_NoLongerGaps() {
        let diagnostics = Diagnose(`namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref int this[int index] => ref values[index];

        public int Sum() => this[0] + this[1];
    }
}`)
        Assert.DoesNotContain(diagnostics, (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
    }

    /// The concrete migration consequence #3879 was filed to unblock:
    /// `test/Interpreter.Tests/Issue3004ManagedByRefAutoDereferenceFixture.cs`
    /// was the whole app's only translate-stage blocker in the self-migration
    /// gate (#3501), with exactly two CS2GS-GAP fingerprints — its `ref`
    /// property and its `ref` indexer. Reproduced verbatim so a regression
    /// here is recognisable as that failure and not as a generic one.
    @Fact
    func TheInterpreterTestsByRefFixture_TranslatesWithoutGaps() {
        let printed = Translate(`namespace GSharp.Interpreter.Tests.Issue3004;

/// <summary>
/// CLR ref-return shapes used to guard managed-byref auto-dereference.
/// </summary>
public sealed class ManagedByRefAutoDereferenceFixture
{
    private readonly int[] values = [40, 41, 42];

    /// <summary>Gets the first value by reference.</summary>
    public ref int Property => ref values[0];

    /// <summary>Gets a value by reference through an indexer.</summary>
    /// <param name="index">The value index.</param>
    public ref int this[int index] => ref values[index];

    /// <summary>Gets a value by reference through an instance call.</summary>
    /// <param name="index">The value index.</param>
    /// <returns>A reference to the selected value.</returns>
    public ref int GetValue(int index) => ref values[index];
}`)
        // Translate() already asserts no Unsupported diagnostics; these pin the
        // three shapes so a future "translates, but drops the ref" cannot pass.
        Assert.Contains("prop Property ref int32 -> values[0]", printed, StringComparison.Ordinal)
        Assert.Contains("prop this[index int32] ref int32 -> values[index]", printed, StringComparison.Ordinal)
        Assert.Contains("return ref values[index]", printed, StringComparison.Ordinal)
    }

    shared {
        private const RefMemberSource string = `namespace Repro
{
    public class Holder
    {
        private readonly int[] values = new[] { 40, 41, 42 };

        public ref int Property => ref values[0];

        public ref int this[int index] => ref values[index];

        public int Read(int index) => values[index];
        public void Set(int index, int next) { values[index] = next; }
        public int LocalRead() {
            ref readonly int view = ref values[2];
            values[2] = 77;
            return view;
        }
    }
}`

        private func CompileDriver(workDir string, libraryPath string, readOnly bool) string {
            const DriverSource = `namespace Repro
{
    public static class Driver
    {
        public static int[] Run()
        {
            var holder = new Holder();

            ref int fromProperty = ref holder.Property;
            fromProperty = 99;

            ref int fromIndexer = ref holder[1];
            fromIndexer = 88;

            return new[] { holder.Read(0), holder.Read(1), holder.LocalRead() };
        }
    }
}`
            let driverSource = if readOnly {
                DriverSource
                    .Replace("ref int", "ref readonly int")
                    .Replace("fromProperty = 99;", "holder.Set(0, 99);")
                    .Replace("fromIndexer = 88;", "holder.Set(1, 88);")
                    .Replace("holder.Read(0), holder.Read(1)", "fromProperty, fromIndexer")
            } else {
                DriverSource
            }
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
                    "holder.Property` does not compile, the emitted member is not by-ref. Diagnostics:\n" +
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
                "issue-3879-ref-properties",
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
