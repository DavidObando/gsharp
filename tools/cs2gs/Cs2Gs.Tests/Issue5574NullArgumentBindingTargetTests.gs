// <copyright file="Issue5574NullArgumentBindingTargetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #5574: two regressions of the #5508 null-argument widening in the
/// gsharp-csharp self-migration.
///
/// | # | C# (nullable enabled) | #5508 output | output |
/// | - | --- | --- | --- |
/// | 1 | `Slice<string>.FromArray(null)` from a consumer of a run project `Gsharp.Runtime.Values` | `slice[string].FromArray(nil)` (GS0155: `slice[string]` binds the SDK runtime) | `slice[string].FromArray(default([]string))`, and the run's `FromArray(array []T)` keeps its type |
/// | 2 | `Contains(Node node) => Any(node, ..)`, `Any` forwards `node` into a local function, `Contains(null)` | `Any(node!!, match)` throws | no `!!`; the chain keeps `Node` and returns `false` |
/// | 3 | a widened parameter forwarded into a virtual method, `List<Node>.Add` and a `params object[]` element | `node!!` throws at each forward | no `!!`; the C# output |
/// | 4 | a widened parameter forwarded into `Sink.Accept(object)` of a library outside the run | `node!!` throws | no `!!`; the C# output |
///
/// Each runtime case compiles the translation with the gsc driver with zero
/// diagnostics, verifies the image with ILVerify and no ignored error before
/// execution, and compares the output with the Roslyn-compiled C# program.
open class Issue5574NullArgumentBindingTargetTests {
    /// Row 1: the call binds the SDK's runtime `Slice`, not the run's declaration.
    @Fact
    func NullIntoNativeSliceView_KeepsTheRuntimeContract() {
        let (printedValues, printedConsumer) = TranslateSliceRun(ValuesSource, SliceConsumerSource)
        Assert.Contains("func FromArray(array []T) Slice[T]", printedValues, StringComparison.Ordinal)
        Assert.DoesNotContain("[]?T", printedValues, StringComparison.Ordinal)
        this.AssertConsumerKeepsTheRuntimeContract(printedConsumer)
    }

    /// Row 1, when a call in the run's `Gsharp.Runtime.Values` widens its own
    /// declaration: the consumer still binds the SDK's runtime `Slice`.
    @Fact
    func NullIntoNativeSliceView_WhenTheRunWidensItsDeclaration_KeepsTheRuntimeContract() {
        let (printedValues, printedConsumer) = TranslateSliceRun(
            ValuesSource.Replace(
                "public int Length",
                "public static Slice<T> Empty() => FromArray(null!);\n\n        public int Length"
            ),
            SliceConsumerSource
        )
        Assert.Contains("func FromArray(array []?T) Slice[T]", printedValues, StringComparison.Ordinal)
        this.AssertConsumerKeepsTheRuntimeContract(printedConsumer)
    }

    /// Row 1, for a forward into the native view. The SDK's runtime member keeps
    /// its non-null contract, so `items` keeps its type and gets no `!!`, and the
    /// run's `FromArray` does not widen. The `Wrap(nil)` call is the pre-#5508
    /// spelling, which gsc rejects explicitly (GS0155).
    @Fact
    func ForwardIntoNativeSliceView_KeepsTheParameterType() {
        let (printedValues, printedConsumer) = TranslateSliceRun(ValuesSource, SliceForwardSource)
        Assert.Contains("func Wrap(items []Node) slice[Node]", printedConsumer, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printedConsumer, StringComparison.Ordinal)
        Assert.DoesNotContain("[]?T", printedValues, StringComparison.Ordinal)
    }

    /// Row 2: the value reaches a local function, which never widens.
    @Fact
    func WidenedParameterForwardedIntoLocalFunction_PassesNullThrough() {
        let program = CompileCSharp("Walker", OutputKind.ConsoleApplication, []MetadataReference{}, LocalFunctionSource)
        let printed = Translate(program, []CSharpCompilation{program})
        Assert.Contains("func Contains(node Node) bool", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let output = this.CompileVerifyAndRun(printed, LocalFunctionSource)
        Assert.Equal("True\nFalse\n", output.GSharp)
        Assert.Equal(output.CSharp, output.GSharp)
    }

    /// Row 3: the same decision for the other slots that cannot widen.
    @Fact
    func WidenedParameterForwardedIntoNonWidenableSlots_PassesNullThrough() {
        let program = CompileCSharp(
            "Flow",
            OutputKind.ConsoleApplication,
            []MetadataReference{},
            NonWidenableSlotsSource
        )
        let printed = Translate(program, []CSharpCompilation{program})
        Assert.Contains("func ToVirtual(sinks Sinks, node Node) string", printed, StringComparison.Ordinal)
        Assert.Contains("func ToList(node Node) int32", printed, StringComparison.Ordinal)
        Assert.Contains("func ToParams(node Node) int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let output = this.CompileVerifyAndRun(printed, NonWidenableSlotsSource)
        Assert.Equal("virtual\n1\n1\n", output.GSharp)
        Assert.Equal(output.CSharp, output.GSharp)
    }

    /// Row 4: the value reaches a member that no compilation of the run emits.
    @Fact
    func WidenedParameterForwardedIntoAMemberOutsideTheRun_PassesNullThrough() {
        Directory.CreateDirectory(this.directory)
        let library = Path.Combine(this.directory, "Imported.dll")
        let emit = CompileCSharp(
            "Imported",
            OutputKind.DynamicallyLinkedLibrary,
            []MetadataReference{},
            ImportedSource
        ).Emit(library)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let program = CompileCSharp(
            "Forward",
            OutputKind.ConsoleApplication,
            []MetadataReference{MetadataReference.CreateFromFile(library)},
            ForwardSource
        )
        let printed = Translate(program, []CSharpCompilation{program})
        Assert.Contains("func Forward(node Node) bool", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        let output = this.CompileVerifyAndRun(printed, ForwardSource, library)
        Assert.Equal("False\nTrue\n", output.GSharp)
        Assert.Equal(output.CSharp, output.GSharp)
    }

    private func AssertConsumerKeepsTheRuntimeContract(printedConsumer string) {
        Assert.Contains("slice[string].FromArray(default([]string))", printedConsumer, StringComparison.Ordinal)
        Assert.DoesNotContain("FromArray(nil)", printedConsumer, StringComparison.Ordinal)
        let output = this.CompileVerifyAndRun(printedConsumer, SliceConsumerSource)
        Assert.Equal("ArgumentNullException\n", output.GSharp)
        Assert.Equal(output.CSharp, output.GSharp)
    }

    private let directory string = Path.Combine(
        AppContext.BaseDirectory,
        "issue-5574-e2e",
        Guid.NewGuid().ToString("N")
    )

    // Compiles the translation with the gsc driver, verifies the image, and runs it.
    // Then emits the C# program with Roslyn against the same assemblies,
    // verifies that image, and runs it. No image runs before ILVerify accepts it.
    private func CompileVerifyAndRun(printed string, csharpSource string, library string? = nil)(
        GSharp string,
        CSharp string
    ) {
        let gsharpDirectory = Path.Combine(this.directory, "gs")
        Directory.CreateDirectory(gsharpDirectory)
        let source = Path.Combine(gsharpDirectory, "Program.gs")
        File.WriteAllText(source, printed)
        let image = Path.Combine(gsharpDirectory, "Program.dll")
        let compiler = Path.Combine(RepositoryRoot(), "out", "bin", "Release", "Compiler", "gsc.dll")
        Assert.True(File.Exists(compiler), "Build the repository (Release) before this test: " + compiler)
        let compilerArguments = List[string]{compiler, "/target:exe", "/out:" + image}
        if library != nil {
            compilerArguments.Add("/reference:" + library)
        }
        compilerArguments.Add(source)
        let (compileExit, compileOutput) = RunDotnet(compilerArguments, gsharpDirectory)
        let diagnostics = compileOutput
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select((line string) -> line.Trim())
            .Where((line string) -> line.Length != 0 && !line.StartsWith("Wrote ", StringComparison.Ordinal))
            .ToArray()
        Assert.True(
            compileExit == 0 && diagnostics.Length == 0,
            "gsc must compile with zero diagnostics:\n" + compileOutput + "\n" + printed
        )
        // gsc copies the SDK runtime beside an image that uses it.
        let references = List[string]()
        let runtimeValues = Path.Combine(gsharpDirectory, "Gsharp.Runtime.Values.dll")
        if File.Exists(runtimeValues) {
            references.Add(runtimeValues)
        }
        if library != nil {
            references.Add(library)
            let copy = Path.Combine(gsharpDirectory, Path.GetFileName(library))
            if !File.Exists(copy) {
                File.Copy(library, copy)
            }
        }
        VerifyStrictly(image, references)
        let gsharpOutput = RunImage(image)

        let csharpDirectory = Path.Combine(this.directory, "cs")
        Directory.CreateDirectory(csharpDirectory)
        for reference in references {
            File.Copy(reference, Path.Combine(csharpDirectory, Path.GetFileName(reference)))
        }
        let oracle = CompileCSharp(
            "Program",
            OutputKind.ConsoleApplication,
            references.Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToArray(),
            csharpSource
        )
        let oracleImage = Path.Combine(csharpDirectory, "Program.dll")
        let emit = oracle.Emit(oracleImage)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        File.WriteAllText(
            Path.Combine(csharpDirectory, "Program.runtimeconfig.json"),
            File.ReadAllText(Path.Combine(gsharpDirectory, "Program.runtimeconfig.json"))
        )
        VerifyStrictly(oracleImage, references)
        return (gsharpOutput, RunImage(oracleImage))
    }

    shared {
        private const ValuesSource string = `
using System;

namespace Gsharp.Values
{
    public readonly struct Slice<T>
    {
        private readonly T[] owner;

        private Slice(T[] owner) { this.owner = owner; }

        public int Length => owner.Length;

        public static Slice<T> FromArray(T[] array)
        {
            ArgumentNullException.ThrowIfNull(array);
            return new Slice<T>(array);
        }
    }
}`

        private const SliceConsumerSource string = `
using System;
using Gsharp.Values;

namespace Demo
{
    public static class Program
    {
        public static void Main()
        {
            try
            {
                Slice<string>.FromArray(null);
                Console.WriteLine("returned");
            }
            catch (ArgumentNullException)
            {
                Console.WriteLine("ArgumentNullException");
            }
        }
    }
}`

        private const SliceForwardSource string = `
using Gsharp.Values;

namespace Demo
{
    public class Node { }

    public static class Program
    {
        public static Slice<Node> Wrap(Node[] items) => Slice<Node>.FromArray(items);

        public static void Main()
        {
            Wrap(null);
        }
    }
}`

        private const ImportedSource string = `
namespace Imported
{
    public static class Sink
    {
        public static bool Accept(object value) => value == null;
    }
}`

        private const ForwardSource string = `
using System;
using Imported;

namespace Demo
{
    public class Node { }

    public static class Flow
    {
        public static bool Forward(Node node) => Sink.Accept(node);
    }

    public static class Program
    {
        public static void Main()
        {
            Console.WriteLine(Flow.Forward(new Node()));
            Console.WriteLine(Flow.Forward(null!));
        }
    }
}`

        private const LocalFunctionSource string = `
using System;

namespace Demo
{
    public class Node { }

    public static class Walker
    {
        public static bool Contains(Node node) => Any(node, static _ => true);

        public static bool Any(Node node, Func<Node, bool> match)
        {
            return Any(node, match);

            static bool Any(Node node, Func<Node, bool> match)
            {
                switch (node)
                {
                    case null:
                        return false;
                    default:
                        return match(node);
                }
            }
        }
    }

    public static class Program
    {
        public static void Main()
        {
            Console.WriteLine(Walker.Contains(new Node()));
            Console.WriteLine(Walker.Contains(null));
        }
    }
}`

        private const NonWidenableSlotsSource string = `
using System;
using System.Collections.Generic;

namespace Demo
{
    public class Node { }

    public class Sinks
    {
        public virtual string Accept(Node node) => "virtual";

        public static int Count(params object[] items) => items.Length;
    }

    public static class Flow
    {
        public static string ToVirtual(Sinks sinks, Node node) => sinks.Accept(node);

        public static int ToList(Node node)
        {
            var list = new List<Node>();
            list.Add(node);
            return list.Count;
        }

        public static int ToParams(Node node) => Sinks.Count(node);
    }

    public static class Program
    {
        public static void Main()
        {
            Console.WriteLine(Flow.ToVirtual(new Sinks(), null!));
            Console.WriteLine(Flow.ToList(null!));
            Console.WriteLine(Flow.ToParams(null!));
        }
    }
}`

        private func CompileCSharp(
            name string,
            kind OutputKind,
            extraReferences IReadOnlyList[MetadataReference],
            source string
        ) CSharpCompilation {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: name + ".cs"
            )
            // The test supplies its own `Gsharp.Runtime.Values` where it needs one.
            var references = CSharpProjectLoader
                .RuntimeReferences()
                .Where(
                (candidate MetadataReference) -> !(
                    candidate is PortableExecutableReference{FilePath: {} file} && Path.GetFileName(
                        file
                    ) == "Gsharp.Runtime.Values.dll"
                )
            )
                .ToList()
            references.AddRange(extraReferences)
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(kind).WithNullableContextOptions(NullableContextOptions.Enable)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            return compilation
        }

        // Translates the run's `Gsharp.Runtime.Values` and a consumer of it. The
        // run holds both compilations.
        private func TranslateSliceRun(valuesSource string, consumerSource string)(Values string, Consumer string) {
            let values = CompileCSharp(
                "Gsharp.Runtime.Values",
                OutputKind.DynamicallyLinkedLibrary,
                []MetadataReference{},
                valuesSource
            )
            let consumer = CompileCSharp(
                "Consumer",
                OutputKind.ConsoleApplication,
                []MetadataReference{values.ToMetadataReference()},
                consumerSource
            )
            let run = []CSharpCompilation{values, consumer}
            return (Translate(values, run), Translate(consumer, run))
        }

        private func Translate(target CSharpCompilation, run IReadOnlyList[CSharpCompilation]) string {
            let tree = target.SyntaxTrees.Single()
            let model = target.GetSemanticModel(tree)
            let context = TranslationContext(target, model, tree.FilePath, run, run)
            return GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
        }

        // ILVerify with the complete runtime reference set and no ignored error category.
        private func VerifyStrictly(image string, references IReadOnlyList[string]) {
            let arguments = List[string]{
                "tool",
                "run",
                "ilverify",
                image,
                "-s",
                "System.Private.CoreLib",
                "-r",
                Path.Combine(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
            }
            for reference in references {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let (exit, output) = RunDotnet(arguments, RepositoryRoot())
            Assert.True(
                exit == 0 && output.Contains("All Classes and Methods in", StringComparison.Ordinal),
                "ILVerify must accept " + image + " before it runs:\n" + output
            )
        }

        private func RunImage(image string) string {
            let (exit, output) = RunDotnet([]string{image}, Path.GetDirectoryName(image)!!)
            Assert.True(exit == 0, image + " must exit 0:\n" + output)
            return output.Replace("\r\n", "\n")
        }

        private func RunDotnet(arguments IReadOnlyList[string], workingDirectory string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(start)
            let standardError = process!!.StandardError.ReadToEndAsync()
            let output = StringBuilder(process!!.StandardOutput.ReadToEnd())
            output.Append(standardError.Result)
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func RepositoryRoot() string {
            var current DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while current != nil {
                if RepositoryRootMarker.IsRoot(current.FullName) {
                    return current.FullName
                }
                current = current.Parent
            }
            throw InvalidOperationException("The repository root was not found above " + AppContext.BaseDirectory)
        }
    }
}
