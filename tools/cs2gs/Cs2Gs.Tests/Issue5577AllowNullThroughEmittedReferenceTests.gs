// <copyright file="Issue5577AllowNullThroughEmittedReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
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

/// Issue #5577: a sibling project's `[AllowNull]` slot that a consumer binds through the
/// sibling's emitted reference assembly. The sibling's translation emits the slot `T?` (#3694),
/// but the metadata symbol has no source attributes, so the consumer bridged a maybe-null store
/// with a `!!` that throws where C# stores the null. The store bridge and the null-argument pin
/// rule (#5574) now read the contract of the source declaration in the run.
/// The query answers as the producer emits the slot: a `params` carrier and a slot typed by an
/// unconstrained type parameter stay non-null, so they keep their bridge.
/// @remarks Mutation witnesses (ADR-0154): on fe8eaa302, before this fix, the run rows emit
/// `m!!` and the translated program throws `NullReferenceException`, and the one-compilation
/// `params` row has no bridge. The PR records a mutant for each other row.
open class Issue5577AllowNullThroughEmittedReferenceTests {
    /// A maybe-null value stored into a sibling's `[AllowNull]` property or field, or passed to its
    /// `[AllowNull]` parameter, takes no bridge. The translation stores and passes the null as C#
    /// does.
    @Fact
    func ASiblingAllowNullSlot_TakesTheNullWithoutABridge() {
        let library = CompileFiles("Lib", nil, ("Holder.cs", HolderSource))
        let app = CompileFiles("App", Emit(library), ("Use.cs", UseSource))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = TranslateFile(library, "Holder.cs", repository)
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.Contains("Stored Node?", libraryPrinted)
        Assert.DoesNotContain("m!!", appPrinted)
        Assert.Equal("null null null", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    /// The control: a sibling's slot without `[AllowNull]` stays non-null in its translation, so a
    /// maybe-null value stored into it or passed to it keeps its bridge.
    @Fact
    func ASiblingSlotWithoutAllowNull_KeepsItsBridge() {
        let library = CompileFiles("Lib", nil, ("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public virtual Node Stored { get; set; } = new Node();
        public Node Field = new Node();
        public string Take(Node n) => "node";
    }
}`))
        let app = CompileFiles("App", Emit(library), ("Use.cs", `
namespace Demo.App
{
    public static class Use
    {
        public static void Maybe(Holder h, Node? m) { h.Stored = m; }
        public static void MaybeField(Holder h, Node? m) { h.Field = m; }
        public static string MaybeTake(Holder h, Node? m) => h.Take(m);
    }
}`))
        let repository = []CSharpCompilation{library, app}
        Assert.Contains("Stored Node {", TranslateFile(library, "Holder.cs", repository))
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.Contains("h.Stored = m!!", appPrinted)
        Assert.Contains("h.Field = m!!", appPrinted)
        Assert.Contains("h.Take(m!!)", appPrinted)
    }

    /// A linked source file is one declaration in every project that compiles it. `Holder.cs` is
    /// linked into A and B, and the consumer sees it through B's emitted reference. Both copies
    /// translate alike, and the consumer stores the null without a bridge.
    @Fact
    func ALinkedAllowNullSlot_TakesTheNullThroughEveryAlias() {
        let a = CompileFiles("A", nil, ("Holder.cs", HolderSource))
        let b = CompileFiles("B", nil, ("Holder.cs", HolderSource))
        let app = CompileFiles("App", Emit(b), ("Use.cs", UseSource))
        let repository = []CSharpCompilation{a, b, app}
        let holderB = TranslateFile(b, "Holder.cs", repository)
        Assert.Equal(TranslateFile(a, "Holder.cs", repository), holderB)
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.DoesNotContain("m!!", appPrinted)
        Assert.Equal("null null null", CompileAndRun([]string{holderB, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    /// A sibling's `[AllowNull]` indexer key and reduced extension parameter take the null too. The
    /// extension's parameter is read at its unreduced ordinal: the call binds the reduced parameter
    /// `n` at ordinal 0, whose documentation id names no declaration in the producer.
    @Fact
    func ASiblingAllowNullIndexerOrExtensionParameter_TakesTheNull() {
        let library = CompileFiles("Lib", nil, ("Holder.cs", ExtensionSource))
        let app = CompileFiles("App", Emit(library), ("Use.cs", `
namespace Demo.App
{
    public static class Use
    {
        public static string Index(Holder h, Node? m) => h[m];
        public static string Extension(Holder h, Node? m) => h.Take(m);
        public static string Run() => Index(new Holder(), null) + " " + Extension(new Holder(), null);
    }
}`))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = TranslateFile(library, "Holder.cs", repository)
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.DoesNotContain("!!", appPrinted)
        Assert.Equal("null null", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    /// An `[AllowNull]` `params` carrier stays `...Node` in the producer's translation: its attribute
    /// admits a null array, not a null element. So an expanded maybe-null argument keeps its bridge,
    /// through an emitted reference and in one compilation, and the translation compiles and runs.
    @Theory
    @InlineData(true)
    @InlineData(false)
    func AnAllowNullParamsCarrier_KeepsItsBridge(throughReference bool) {
        let producer = ("Lib.cs", `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public static class Counter
    {
        public static int Count([AllowNull] params Node[] nodes) => nodes == null ? -1 : nodes.Length;
    }
}`)
        let consumer = ("Use.cs", `
namespace Demo.App
{
    public static class Use
    {
        public static int CountOne(Node? m) => Counter.Count(m);
        public static string Run() => CountOne(new Node()).ToString();
    }
}`)
        let library = if throughReference {
            CompileFiles("Lib", nil, producer)
        } else {
            CompileFiles("Lib", nil, producer, consumer)
        }
        let app = if throughReference {
            CompileFiles("App", Emit(library), consumer)
        } else {
            library
        }
        let repository = []CSharpCompilation{library, app}.Distinct().ToArray()
        let libraryPrinted = TranslateFile(library, "Lib.cs", repository)
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.Contains("Count(m!!)", appPrinted)
        Assert.Equal("1", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    /// A sibling's `[AllowNull]` field typed by a type parameter that is not constrained to a class
    /// stays `Value T` in the producer's translation, so a maybe-null value stored into
    /// `Box<Node>.Value` keeps its bridge, and the translation compiles and runs.
    @Fact
    func ASiblingAllowNullSlotOfAnUnconstrainedTypeParameter_KeepsItsBridge() {
        let library = CompileFiles("Lib", nil, ("Lib.cs", `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public class Box<T>
    {
        public Box(T value) { Value = value; }
        [AllowNull] public T Value;
    }
}`))
        let app = CompileFiles("App", Emit(library), ("Use.cs", `
namespace Demo.App
{
    public static class Use
    {
        public static void Put(Box<Node> b, Node? m) { b.Value = m; }
        public static string Run()
        {
            var b = new Box<Node>(new Node());
            Put(b, new Node());
            return b.Value == null ? "null" : "node";
        }
    }
}`))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = TranslateFile(library, "Lib.cs", repository)
        let appPrinted = TranslateFile(app, "Use.cs", repository)
        Assert.Contains("Value T", libraryPrinted)
        Assert.Contains("b.Value = m!!", appPrinted)
        Assert.Equal("node", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
    }

    shared {
        private const HolderSource string = `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public class Holder
    {
        [AllowNull] public virtual Node Stored { get; set; } = new Node();
        [AllowNull] public Node Field = new Node();
        public string Take([AllowNull] Node n) => n == null ? "null" : "node";
    }
}`

        private const ExtensionSource string = `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public string this[[AllowNull] Node key] => key == null ? "null" : "node";
    }
    public static class Ext
    {
        public static string Take(this Holder h, [AllowNull] Node n) => n == null ? "null" : "node";
    }
}`

        private const UseSource string = `
namespace Demo.App
{
    public static class Use
    {
        public static void Maybe(Holder h, Node? m) { h.Stored = m; }
        public static void MaybeField(Holder h, Node? m) { h.Field = m; }
        public static string MaybeTake(Holder h, Node? m) => h.Take(m);

        public static string Run()
        {
            var h = new Holder();
            Maybe(h, null);
            MaybeField(h, null);
            return (h.Stored == null ? "null" : "node") + " " + (h.Field == null ? "null" : "node") + " " +
                MaybeTake(h, null);
        }
    }
}`

        private func Emit(compilation CSharpCompilation) MetadataReference {
            let image = MemoryStream()
            Assert.True(compilation.Emit(image).Success)
            image.Position = 0
            return MetadataReference.CreateFromStream(image)
        }

        private func TranslateFile(
            compilation CSharpCompilation,
            path string,
            repository IReadOnlyList[CSharpCompilation]
        ) string {
            let tree = compilation.SyntaxTrees.First((t SyntaxTree) -> t.FilePath == path)
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(
                compilation,
                model,
                tree.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
        }

        private func CompileFiles(
            name string,
            reference MetadataReference?,
            sources ...(Path string, Source string)
        ) CSharpCompilation {
            let trees = sources.Select(
                (source(Path string, Source string)) -> CSharpSyntaxTree.ParseText(
                    source.Source,
                    CSharpParseOptions(LanguageVersion.Latest),
                    path: source.Path
                )
            )
                .ToArray()
            var references = CSharpProjectLoader.RuntimeReferences().ToList()
            if reference != nil {
                references.Add(reference)
            }
            let compilation = CSharpCompilation.Create(
                name,
                trees,
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            return compilation
        }

        private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5577-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath"}
                for var i = 0; i < printedFiles.Count; i++ {
                    let gsPath = Path.Combine(workDir, "Unit$i.gs")
                    File.WriteAllText(gsPath, printedFiles[i])
                    arguments.Add(gsPath)
                }
                let entryPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(
                    entryPath,
                    "import System${Environment.NewLine}${Environment.NewLine}Console.WriteLine($callExpression)${Environment.NewLine}"
                )
                arguments.Add(entryPath)
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput + `

Translated G#:
` + string.Join(Environment.NewLine, printedFiles)
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput)
                return runOutput
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                startInfo.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(startInfo)
            Assert.NotNull(process)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            if !process!!.WaitForExit(TimeSpan.FromMinutes(5)) {
                process!!.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
