// <copyright file="Issue5574NullArgumentPinTests.cs" company="GSharp">
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

/// Issue #5574: two gsharp-csharp self-migration failures after #5525, from the pinned C# shapes.
///
/// 1. `TypeSymbol.ContainsTypeParameter(null)` (Core.Tests) widened `type` to `TypeSymbol?`, but
/// the value goes on unchanged to a local function whose parameter stays non-null, so the
/// translation bridged it with `type!!` and threw where C# returns `false`. A declaration whose
/// value reaches a slot that keeps a non-null contract is now PINNED: it is not widened, and no
/// value is widened through it.
/// 2. `Slice<string>.FromArray(null)` (Compiler.Tests) widened the migrated `Gsharp.Runtime.Values`
/// declaration, but `slice[string].FromArray` binds to the SDK's copy, so the call's `nil` was
/// GS0155. A declaration of an SDK runtime assembly is not a null-argument candidate, and the call
/// keeps `default([]string)` as before #5525.
/// @remarks Mutation witnesses (ADR-0154): with `IsPinnedNonNull` always `false`, the
/// `ContainsTypeParameter` rows emit `type!!` and the translated program throws
/// `NullReferenceException`; with `IsSdkRuntimeDeclaration` always `false`, the slice row emits
/// `FromArray(nil)` and fails binding with GS0155. Both rows also fail on 9e0dbaecb, before this fix.
open class Issue5574NullArgumentPinTests {
    /// The pinned `ContainsTypeParameter` shape: a null into a parameter that forwards its value to a
    /// local function keeps the parameter non-null, and the translation returns `false` as C# does.
    /// @remarks The pinned corpus is nullable-oblivious. In a two-project oblivious snippet the #2113
    /// taint (not this rule) also widens `ContainsTypeParameter`, so this row runs nullable-enabled,
    /// where only the null-argument rule decides; the oblivious corpus shape is covered by the
    /// gsharp-csharp leg's `Core.Tests` test-parity.
    @Fact
    func NullForwardedIntoALocalFunction_IsNotWidenedAndDoesNotThrow() {
        let (core, image) = Compile(`
namespace Demo
{
    public class TypeSymbol
    {
        public static readonly TypeSymbol Int32 = new TypeSymbol();

        public static bool ContainsTypeParameter(TypeSymbol type) => AnyTypeParameter(type, t => true);

        public static bool AnyTypeParameter(TypeSymbol type, System.Func<TypeSymbol, bool> match)
        {
            return AnyTypeParameter(type, match);

            bool AnyTypeParameter(TypeSymbol type, System.Func<TypeSymbol, bool> match)
            {
                switch (type)
                {
                    case null:
                        return false;
                    default:
                        return type != Int32 && match(type);
                }
            }
        }
    }

}`, "Core", NullableContextOptions.Enable, Array.Empty[MetadataReference]())
        let (tests, _) = Compile(`
namespace Demo.Tests
{
    public static class Probe
    {
        public static string Run() =>
            Demo.TypeSymbol.ContainsTypeParameter(Demo.TypeSymbol.Int32) + " " +
            Demo.TypeSymbol.ContainsTypeParameter(null);
    }
}`, "Core.Tests", NullableContextOptions.Enable, []MetadataReference{image})
        let repository = []CSharpCompilation{core, tests}
        let printed = Translate(core, repository)
        Assert.Equal(
            "False False",
            CompileAndRun([]string{printed, Translate(tests, repository)}, "Demo.Tests.Probe.Run()").Trim()
        )
        Assert.False(printed.Contains("AnyTypeParameter(type!!", StringComparison.Ordinal), printed)
        Assert.False(printed.Contains("ContainsTypeParameter(type TypeSymbol?)", StringComparison.Ordinal), printed)
    }

    /// The pinned `Slice<string>.FromArray(null)` shape: the call binds to the SDK's
    /// `Gsharp.Runtime.Values`, so the null keeps the typed default and the SDK's argument check
    /// still runs.
    @Fact
    func NullIntoAnSdkRuntimeDeclaration_KeepsTheTypedDefault() {
        let (values, image) = Compile(`
namespace Gsharp.Values
{
    public readonly struct Slice<T>
    {
        private readonly T[] array;

        private Slice(T[] array) { this.array = array; }

        public static Slice<T> FromArray(T[] array)
        {
            if (array == null) { throw new System.ArgumentNullException(nameof(array)); }
            return new Slice<T>(array);
        }
    }
}`, "Gsharp.Runtime.Values", NullableContextOptions.Enable, Array.Empty[MetadataReference]())
        let (consumer, _) = Compile(`
namespace Demo
{
    public static class Probe
    {
        public static string Run()
        {
            try
            {
                Gsharp.Values.Slice<string>.FromArray(null);
                return "none";
            }
            catch (System.ArgumentNullException)
            {
                return "ANE";
            }
        }
    }
}`, "Compiler.Tests", NullableContextOptions.Disable, []MetadataReference{image})
        let repository = []CSharpCompilation{values, consumer}
        let printed = Translate(consumer, repository)
        Assert.Equal("ANE", CompileAndRun([]string{printed}, "Demo.Probe.Run()").Trim())
        Assert.Contains("FromArray(default([]string))", printed)
    }

    /// Pinning is reachability, so the order of the declarations cannot change it: `A` forwards to
    /// a virtual (fixed) sink and to `B`, `B` forwards back to `A`, both store into `Stored`, and
    /// only `B` receives the null. Both parameters are pinned and `Stored` is not widened.
    /// @param aFirst Whether `A` is declared before `B`.
    @Theory
    @InlineData(true)
    @InlineData(false)
    func ACycleThroughAFixedSink_PinsEveryMemberWhateverTheOrder(aFirst bool) {
        let a = "public void A(Node a, Sink s, int depth) { if (depth > 0) { B(a, s, depth - 1); } Stored = a; s.Take(a); }"
        let b = "public void B(Node b, Sink s, int depth) { Stored = b; if (depth > 0) { A(b, s, depth - 1); } }"
        let printed = TranslateBound(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Sink { public virtual void Take(Node n) { } }
    public class Holder
    {
        public Node Stored = new Node();
        ` + (
                    if aFirst {
                        a + "\n        " + b
                    } else {
                        b + "\n        " + a
                    }
                ) + `
        public static void Go(Holder h, Sink s) => h.B(null!, s, 1);
    }
}`))
        Assert.DoesNotContain("Stored Node?", printed)
        Assert.DoesNotContain("a Node?", printed)
        Assert.DoesNotContain("b Node?", printed)
        Assert.DoesNotContain("a!!", printed)
        Assert.DoesNotContain("b!!", printed)
    }

    /// A slot that an attribute contract widens (`[AllowNull]`) takes the null, so it does not pin
    /// the parameter that forwards into it.
    @Fact
    func AForwardIntoAnAllowNullSlot_DoesNotPin() {
        let printed = TranslateBound(("Sink.cs", `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public class Sink
    {
        public virtual void Take([AllowNull] Node n) { }
        public void Forward(Node p) => Take(p);
        public void Go() => Forward(null!);
    }
}`))
        Assert.Contains("Forward(p Node?)", printed)
        Assert.DoesNotContain("p!!", printed)
    }

    /// A generic slot is read as the call binds it. `Sink<Node>(p)` names `Node`, and an inferred
    /// `Sink(q)` binds `Node` too: the translator asserts a value C# proved non-null even where G#
    /// infers the type argument (#5254), so both forwards pin.
    @Fact
    func AGenericSlot_PinsWhetherItsTypeArgumentIsNamedOrInferred() {
        let printed = TranslateBound(("Sinks.cs", `
namespace Demo
{
    public class Node { }
    public static class Sinks
    {
        public static void Sink<T>(T value) { }
        public static void Named(Node p) => Sink<Node>(p);
        public static void Inferred(Node q) => Sink(q);
        public static void Go() { Named(null!); Inferred(null!); }
    }
}`))
        Assert.Contains("Named(p Node)", printed)
        Assert.DoesNotContain("p!!", printed)
        Assert.Contains("Inferred(q Node)", printed)
        Assert.DoesNotContain("q!!", printed)
    }

    /// A linked source file is one declaration in every project that compiles it. `Forward.cs` is
    /// linked into A, whose sink can be widened, and into B, whose sink is virtual. The parameter is
    /// pinned in both translations and for a consumer that sees it through A's emitted reference,
    /// which therefore bridges its own maybe-null argument instead of passing a `Node?` to `Node`.
    @Fact
    func ALinkedForwarder_IsPinnedThroughEveryAlias() {
        let forward = `
namespace Demo
{
    public class Node { }
    public static class Forwarder
    {
        public static void Forward(Node p, Sinks s) => s.Sink(p);
    }
}`
        let a = CompileFiles("A", nil, ("Forward.cs", forward), ("SinkA.cs", `
namespace Demo
{
    public class Sinks { public void Sink(Node value) { } }
}`))
        let b = CompileFiles("B", nil, ("Forward.cs", forward), ("SinkB.cs", `
namespace Demo
{
    public class Sinks { public virtual void Sink(Node value) { } }
}`))
        let image = MemoryStream()
        Assert.True(a.Emit(image).Success)
        image.Position = 0
        let c = CompileFiles("C", MetadataReference.CreateFromStream(image), ("Go.cs", `
namespace Demo
{
    public static class Go
    {
        public static void Run(Node? maybe)
        {
            Forwarder.Forward(null!, new Sinks());
            Forwarder.Forward(maybe, new Sinks());
        }
    }
}`))
        let siblings = []CSharpCompilation{a, b, c}
        let forwardA = TranslateFile(a, "Forward.cs", siblings)
        Assert.Contains("Forward(p Node, s Sinks)", forwardA)
        Assert.Equal(forwardA, TranslateFile(b, "Forward.cs", siblings))
        Assert.Contains("Forward(maybe!!", TranslateFile(c, "Go.cs", siblings))
    }

    /// A sibling project's `[AllowNull]` slot seen through its emitted reference assembly is a
    /// non-null store target for this translation (it bridges a `Node?` stored into it, #5577), so it pins
    /// the parameter stored into it, and no `p!!` throws on the null the C# stores.
    @Fact
    func AnAllowNullSlotThroughAnEmittedReference_PinsAsTheTranslationReadsIt() {
        let library = CompileFiles("Lib", nil, ("Holder.cs", `
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { }
    public class Holder { [AllowNull] public virtual Node Stored { get; set; } = new Node(); }
}`))
        let image = MemoryStream()
        Assert.True(library.Emit(image).Success)
        image.Position = 0
        let app = CompileFiles("App", MetadataReference.CreateFromStream(image), ("Use.cs", `
namespace Demo
{
    public static class Use
    {
        public static void Put(Holder h, Node p) { h.Stored = p; }
        public static void Go(Holder h) => Put(h, null!);
        public static void Maybe(Holder h, Node? m) { h.Stored = m; }
    }
}`))
        let printed = TranslateFile(app, "Use.cs", []CSharpCompilation{library, app})
        Assert.Contains("Put(h Holder, p Node)", printed)
        Assert.DoesNotContain("p!!", printed)
    }

    /// An async result is the awaited value: a `Task<Node?>` result takes the null and does not
    /// pin, while a `Task<Node>` result keeps its non-null contract and does.
    @Fact
    func AnAsyncResult_PinsByItsAwaitedType() {
        let printed = TranslateBound(("Async.cs", `
using System.Threading.Tasks;
namespace Demo
{
    public class Node { }
    public static class Forwarders
    {
        public static async Task<Node?> Open(Node p) { await Task.Yield(); return p; }
        public static async Task<Node> Closed(Node q) { await Task.Yield(); return q; }
        public static void Go() { _ = Open(null!); _ = Closed(null!); }
    }
}`))
        Assert.Contains("Open(p Node?)", printed)
        Assert.Contains("Closed(q Node)", printed)
        Assert.DoesNotContain("q!!", printed)
    }

    /// A local function's result never widens, so returning a captured parameter from it pins the
    /// parameter, in both body forms, and the translation returns the null as C# does.
    @Fact
    func ACapturedParameterReturnedFromALocalFunction_IsPinned() {
        let compilation = CompileFiles("App", nil, ("Check.cs", `
namespace Demo
{
    public class Node { }
    public static class Checks
    {
        public static bool Arrow(Node p) { Node Local() => p; return Local() is null; }
        public static bool Block(Node q) { Node Local() { return q; } return Local() is null; }
        public static string Run() => Arrow(null!) + " " + Block(null!);
    }
}`))
        let printed = TranslateFile(compilation, "Check.cs", []CSharpCompilation{compilation})
        Assert.Equal("True True", CompileAndRun([]string{printed}, "Demo.Checks.Run()").Trim())
        Assert.DoesNotContain("p!!", printed)
        Assert.DoesNotContain("q!!", printed)
    }

    /// A widened field read as an argument to a slot that keeps a non-null contract pins the field
    /// and the parameter stored into it, and the translation passes the null on as C# does.
    @Fact
    func AStoredValueReadIntoAFixedSlot_PinsTheStoreAndItsParameter() {
        let compilation = CompileFiles("App", nil, ("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public class Holder
    {
        private readonly Node stored;
        public Holder(Node node) { stored = node; }
        public string Run(Sink s) => s.Take(stored);
        public static string Probe() => new Holder(null!).Run(new Sink());
    }
}`))
        let printed = TranslateFile(compilation, "Holder.cs", []CSharpCompilation{compilation})
        Assert.Equal("taken", CompileAndRun([]string{printed}, "Demo.Holder.Probe()").Trim())
        Assert.DoesNotContain("stored!!", printed)
        Assert.DoesNotContain("node Node?", printed)
    }

    /// A read handed to a slot that widens on its own (here `Sink`, which a call also passes `null`)
    /// takes the null, so it does not pin what it reads.
    @Fact
    func AReadIntoAnIndependentlyWidenedSlot_DoesNotPin() {
        let printed = TranslateBound(("Holder.cs", `
namespace Demo
{
    public class Holder
    {
        private readonly string stored;
        public Holder(string p) { stored = p; }
        public static void Sink(string s) { }
        public void Use() => Sink(stored);
        public static void Go() { new Holder(null!).Use(); Sink(null!); }
    }
}`))
        Assert.Contains("init(p string?)", printed)
        Assert.Contains("Sink(s string?)", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// Reads the earlier forward-edge collection missed — a positional record property, a lambda's
    /// result (both body forms), and an unqualified generic call's result — each handed to a slot
    /// that keeps a non-null contract. Every read is now classified, so each pins its source and
    /// the translation passes the null on as C# does.
    @Fact
    func EveryReadIntoAFixedSlot_Pins() {
        let compilation = CompileFiles("App", nil, ("Reads.cs", `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item);
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public static class Reads
    {
        public static Node Identity<T>(Node p) => p;
        public static bool Block(Node q) { System.Func<Node> f = () => { return q; }; return f() is null; }
        public static bool Arrow(Node r) { System.Func<Node> f = () => r; return f() is null; }
        public static string Run()
        {
            var sink = new Sink();
            return sink.Take(new Entry(null!).Item) + " " + sink.Take(Identity<int>(null!)) + " " +
                Block(null!) + " " + Arrow(null!);
        }
    }
}`))
        let printed = TranslateFile(compilation, "Reads.cs", []CSharpCompilation{compilation})
        Assert.Equal("taken taken True True", CompileAndRun([]string{printed}, "Demo.Reads.Run()").Trim())
    }

    shared {
        private func TranslateBound(source(Path string, Source string)) string {
            let compilation = CompileFiles("Snippet", nil, source)
            let printed = TranslateFile(compilation, source.Path, []CSharpCompilation{compilation})
            TranslationTestValidation.AssertBinds(printed)
            return printed
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

        private func Translate(compilation CSharpCompilation, repository IReadOnlyList[CSharpCompilation]) string {
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(
                compilation,
                model,
                document.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func Compile(
            source string,
            assemblyName string,
            nullable NullableContextOptions,
            references IReadOnlyList[MetadataReference]
        )(Compilation CSharpCompilation, Image MetadataReference) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                // The snippet's own `Gsharp.Runtime.Values` stands in for the migrated project.
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Where(
                    (reference MetadataReference) -> !(reference.Display ?? "").EndsWith(
                        "Gsharp.Runtime.Values.dll",
                        StringComparison.Ordinal
                    )
                )
                    .Concat(references),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(nullable)
            )
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return (compilation, MetadataReference.CreateFromStream(peStream))
        }

        private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5574-e2e", Guid.NewGuid().ToString("N"))
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
