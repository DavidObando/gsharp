// <copyright file="Issue5561DeconstructedLocalTests.cs" company="GSharp">
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

/// Issue #5561: in a nullable-oblivious compilation, the #2113 taint can widen a record's positional
/// property (`Entry.Item`) to `Node?`. A deconstruction through the record's `Deconstruct` stores
/// each element into its target, so every target now gets the treatment that `target = entry.Item`
/// gets. One resolution, `ObliviousNullabilityAnalyzer.DeconstructedElementDeclaration` (#5508),
/// names the element for all three rules:
///
/// | Shape | before | after (same as the property read) |
/// | --- | --- | --- |
/// | `new Entry(null, 0)`; `var (item, _) = entry; item.M()`, `(Node item, int id) = entry`, `foreach (var (item, id) in entries)` | `item.M()`, GS0159 | `item!!.M()` (`IsTranslatorWidenedDeclaration`) |
/// | the same local passed to `Keep(Node node)` | `Keep(item)`, GS0154 | `Keep(item!!)` |
/// | `Node n; (n, i) = entry;`, also nested | `n = nValue`, GS0155 | `n = nValue!!`, as `n = entry.Item!!` (store bridge) |
/// | the same, when `entry.Item != null` taints the property itself | `n = nValue`, GS0155 | `var n Node?`, `n = nValue`; the null is stored (taint edge) |
/// | `var n = entry.Item; (n, i) = entry;` (nullable storage) | `n = nValue` | unchanged: the target reads as nullable, so no bridge |
/// | `Node n = entry.Item; (n, i) = entry;` (G# infers `n` from the initializer) | `n = nValue` | unchanged: the storage that the declaration emitted accepts nil |
/// | `(b, i) = entry` through `implicit operator Box(Node node)` | `b = bValue` | unchanged: the bridge asks the operator's parameter, and `b` gets the conversion's result flow, not the element's |
/// | a record from another project's emitted reference | GS0155, GS0159 | as for a record of this project |
/// | `entry.Item is var p` / `is Node p`, then `(p, i) = Empty()` (no recorded storage) | `p = pValue` | unchanged (#5605): an unknown local is not bridged |
/// | the same, when the consumer tests `entry.Item != null` | GS0155 | `var n Node?`: the taint keys the metadata property, as `n = entry.Item` does |
/// | `(holder.Value, i) = entry` into another project's `Holder<T>.Value`, which the consumer null-tests | GS0155 | `holder.Value = holderValue!!`: a field is decided by its declaration |
/// | `(h.Stored, i) = entry` into another project's `[AllowNull]` property | GS0155 | `h.Stored = hValue`: the #5577 query (`HasRunAllowNullWriteContract`) keeps the slot `T?` |
/// @remarks Mutation witnesses (ADR-0154), each also failing on d12a50f86: with the
/// `IsTranslatorWidenedDeclaration` local arms of `IsNullablePromotedValue` and
/// `ReceiverValueIsPromotedNullable` reverted to `ShouldPromoteToNullableReference`, the first test
/// fails binding (GS0159, GS0154); with `BridgeDeconstructedElementStore` returning its value, the second
/// fails binding (GS0155); without the `CollectDeconstructedElementEdges` calls in `CollectEdges`,
/// the third throws `NullReferenceException` at the bridged store, where C# stores the null. The
/// other rows answer reviews of c05ce523f and 38b501c29 and fail on the head they answer. Their
/// mutants: no `IsNullablePromotedValue(target)` check in `BridgeDeconstructedElementStore`; no
/// conversion-operator slot there; an element edge in place of the conversion's result flow in
/// `AddDeconstructedElementEdge` (on 38b501c29); `SynthesizedDeconstructRecord` ignoring the run's
/// compilations; the conversion's result flow discarded; no compiler-generated match without the
/// run's compilations. The field row fails on baacf938e (GS0155), whose exception covered fields too.
/// The `Node n` row is decided by `EmittedLocalStorageAcceptsNil`; it throws at `n = nValue!!` when
/// only a `var` local's storage follows its initializer. The pattern-variable row throws at
/// `p = pValue!!` on 7c4638e68, which bridged a local with no record by its declared type. The
/// `[AllowNull]` row throws at the bridged store on a31c75b9b, before #5577's query.
open class Issue5561DeconstructedLocalTests {
    /// Locals that a deconstruction declares hold the widened element, so their dereferences and
    /// their hand-off to a non-null parameter are asserted, as for `var item = entry.Item`.
    @Fact
    func DeclaredLocalsOfAWidenedElement_AreAssertedLikeAPropertyRead() {
        let printed = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Keep(Node node) => "kept";
        public static string Var(Entry entry) { var (item, _) = entry; return item.ToString(); }
        public static string Typed(Entry entry) { (Node item, int id) = entry; return item.ToString() + id; }
        public static int Loop(System.Collections.Generic.List<Entry> entries)
        {
            var sum = 0;
            foreach (var (item, id) in entries) { sum += item.ToString().Length + id; }
            return sum;
        }
        public static string Pass(Entry entry) { var (item, id) = entry; return Keep(item) + id; }
        public static string Plain(Entry entry) { var item = entry.Item; return Keep(item); }
        public static string Run()
        {
            var entry = new Entry(new Node(), 1);
            var entries = new System.Collections.Generic.List<Entry> { entry };
            return Var(entry) + " " + Typed(entry) + " " + Loop(entries) + " " + Pass(entry) + " " + Plain(entry);
        }
    }
}`)
        Assert.Equal("node node1 5 kept1 kept", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("Item Node?", printed)
        Assert.Contains("return item!!.ToString()", printed)
        Assert.Contains("return item!!.ToString() + id", printed)
        Assert.Contains("item!!.ToString().Length", printed)
        Assert.Contains("return Keep(item!!) + id", printed)
        Assert.Contains("return Keep(item!!)\n", printed)
    }

    /// A widened element stored into an existing local that stays non-null is bridged, as
    /// `n = entry.Item` is.
    @Fact
    func StoreOfAWidenedElementIntoAnExistingLocal_IsBridgedLikeAPropertyStore() {
        let printed = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Store(Entry entry) { Node n; int i; (n, i) = entry; return n.ToString() + i; }
        public static string Nested(Entry entry)
        {
            Node m; int outer; int id;
            (outer, (m, id)) = (2, entry);
            return m.ToString() + outer + id;
        }
        public static string Plain(Entry entry) { Node n; n = entry.Item; return n.ToString(); }
        public static string Run()
        {
            var entry = new Entry(new Node(), 1);
            return Store(entry) + " " + Nested(entry) + " " + Plain(entry);
        }
    }
}`)
        Assert.Equal("node1 node21 node", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("var n Node\n", printed)
        Assert.Contains("n = nValue!!", printed)
        Assert.Contains("m = mValue!!", printed)
        Assert.Contains("n = entry.Item!!", printed)
    }

    /// When the taint widens the property itself, `n = entry.Item` widens `n`; a deconstruction now
    /// widens its targets the same way, so the null that C# stores and passes on is not asserted.
    @Fact
    func DeconstructionOfATaintedProperty_WidensItsTargetsLikeAnAssignment() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static bool HasItem(Entry entry) => entry.Item != null;
        public static Entry Empty() => new Entry(null, 0);
        public static string Keep(Node node) => "kept";
        public static string KeepDeclared(Node node) => "declared";
        public static string Store(Entry entry) { Node n; int i; (n, i) = entry; return Keep(n) + i; }
        public static string Declared(Entry entry) { var (item, id) = entry; return KeepDeclared(item) + id; }
        public static string Run() => Store(Empty()) + " " + Declared(Empty()) + " " + HasItem(Empty());
    }
}`)
        Assert.Equal("kept0 declared0 False", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("var n Node?", printed)
        Assert.Contains("Keep(node Node?)", printed)
        Assert.Contains("KeepDeclared(node Node?)", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// A `var` local whose initializer is the widened property already has nullable storage, so a
    /// deconstruction into it stores the null as C# does (review of c05ce523f).
    @Fact
    func StoreIntoAnInferredNullableLocal_IsNotBridged() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Inferred(Entry entry)
        {
            var n = entry.Item;
            int i;
            (n, i) = Empty();
            object o = n;
            return (o == null) + ":" + i;
        }
        public static string Run() => Inferred(new Entry(new Node(), 1));
    }
}`)
        Assert.Equal("True:0", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("n = nValue\n", printed)
    }

    /// An explicitly typed local's storage is what its declaration emitted. G# infers `Node n = entry.Item`
    /// from its initializer, so a deconstruction into it stores the null, as for `var`.
    @Fact
    func StoreIntoAnExplicitlyTypedLocal_FollowsItsEmittedStorage() {
        let printed = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Same(Entry entry)
        {
            Node n = entry.Item;
            int i;
            (n, i) = Empty();
            object o = n;
            return (o == null) + ":" + i;
        }
        public static string Run() => Same(new Entry(new Node(), 1));
    }
}`)
        Assert.Equal("True:0", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("n = nValue\n", printed)
    }

    /// A pattern variable has no recorded declared storage (#5605), so the bridge leaves its store as it
    /// is on `main`: the lowerings emit `var p Node?`, and the null that C# stores is stored, not asserted.
    @Fact
    func StoreIntoALocalOfUnknownStorage_IsNotBridged() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Pattern(Entry entry)
        {
            if (entry.Item is var p)
            {
                int i;
                (p, i) = Empty();
                object o = p;
                return (o == null) + ":" + i;
            }
            return "none";
        }
        public static string Typed(Entry entry)
        {
            if (entry.Item is Node p)
            {
                int i;
                (p, i) = Empty();
                object o = p;
                return (o == null) + ":" + i;
            }
            return "none";
        }
        public static string Run() => Pattern(new Entry(new Node(), 1)) + " " + Typed(new Entry(new Node(), 1));
    }
}`)
        Assert.Equal("True:0 True:0", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.DoesNotContain("p = pValue!!", printed)
    }

    /// A user-defined conversion takes the element as its input, so the bridge asks the operator's
    /// parameter, as the plain `b = entry.Item` does, and the null reaches the operator.
    @Fact
    func StoreThroughAUserDefinedConversion_AsksTheOperatorParameter() {
        let printed = Translate(BoxSource(""))
        Assert.Equal("null0 null", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("b = bValue\n", printed)
    }

    /// The conversion's result, not the element, is stored, so the element's taint does not widen the
    /// target of a converted element, also when the taint widens the property itself.
    @Fact
    func ConvertedElement_DoesNotWidenTheTarget() {
        let printed = Translate(BoxSource("public static bool HasItem(Entry entry) => entry.Item != null;"))
        Assert.Equal("null0 null", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("func Convert(entry Entry) string {\n        var b Box\n", printed)
    }

    /// A conversion declared to return `Box?` stores that null: the target gets the conversion's result
    /// flow and is widened, as for `b = entry.Item`.
    /// @remarks Translation only: G# has no conversion operator to `Box?` (GS0394), so neither form
    /// compiles, on d12a50f86 either. The row pins that both targets get the same declaration.
    @Fact
    func ConversionWithANullableResult_WidensTheTarget() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
#nullable enable
    public class Box
    {
        public static implicit operator Box?(Node? node) => node == null ? null : new Box();
    }
#nullable restore
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Convert(Entry entry) { Box b; int i; (b, i) = entry; object o = b; return (o == null) + ":" + i; }
        public static string Plain(Entry entry) { Box b; b = entry.Item; object o = b; return (o == null).ToString(); }
        public static string Run() => Convert(Empty()) + " " + Plain(Empty());
    }
}`)
        Assert.Contains("func Convert(entry Entry) string {\n        var b Box?\n", printed)
        Assert.Contains("func Plain(entry Entry) string {\n        var b Box?\n", printed)
    }

    /// The consumer's own null test of a record property from another project taints that property
    /// in the consumer, and a deconstruction there widens its target from it, as `n = entry.Item` does.
    @Fact
    func ConsumerTaintOfAPropertyFromAnotherProject_WidensTheTarget() {
        let library = Compile("Lib", `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Make { public static Entry Empty() => new Entry(null, 0); }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public static class Use
    {
        public static bool HasItem(Demo.Entry entry) => entry.Item != null;
        public static string Store(Demo.Entry entry) { Demo.Node n; int i; (n, i) = entry; object o = n; return (o == null) + ":" + i; }
        public static string Plain(Demo.Entry entry) { Demo.Node n; n = entry.Item; object o = n; return (o == null).ToString(); }
        public static string Run() => Store(Demo.Make.Empty()) + " " + Plain(Demo.Make.Empty()) + " " + HasItem(Demo.Make.Empty());
    }
}`, Emit(library))
        let repository = []CSharpCompilation{library, app}
        let appPrinted = Translate(app, repository)
        Assert.Equal(
            "True:0 True False",
            CompileAndRun([]string{Translate(library, repository), appPrinted}, "Demo.App.Use.Run()").Trim()
        )
        Assert.Contains("n = nValue\n", appPrinted)
    }

    /// A consumer's null test of a field that another project declares does not widen the field that
    /// project emits, so a widened element stored into it is bridged, as for a plain assignment.
    @Fact
    func StoreIntoAFieldFromAnotherProject_IsDecidedByItsDeclaration() {
        let library = Compile("Lib", `
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public class Holder<T> { public T Value; }
    public static class Make { public static Entry Empty() => new Entry(null, 0); }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public static class Use
    {
        public static bool Has(Demo.Holder<Demo.Node> holder) => holder.Value != null;
        public static string Store(Demo.Entry entry)
        {
            var holder = new Demo.Holder<Demo.Node>();
            int i;
            (holder.Value, i) = entry;
            return Has(holder) + ":" + i;
        }
        public static string Run() => Store(new Demo.Entry(new Demo.Node(), 1));
    }
}`, Emit(library))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = Translate(library, repository)
        let appPrinted = Translate(app, repository)
        Assert.Equal("True:1", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
        Assert.Contains("var Value T\n", libraryPrinted)
        Assert.Contains("holder.Value = holderValue!!", appPrinted)
    }

    /// Another project's `[AllowNull]` property, bound through its emitted reference, is emitted `T?`
    /// (#5577), so the store bridge asks the same query as a plain store and stores the null.
    @Fact
    func StoreIntoAnAllowNullPropertyFromAnotherProject_IsNotBridged() {
        let library = Compile("Lib", `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public class Holder { [System.Diagnostics.CodeAnalysis.AllowNull] public Node Stored { get; set; } }
    public static class Make { public static Entry Empty() => new Entry(null, 0); }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public static class Use
    {
        public static string Store(Demo.Entry entry)
        {
            var h = new Demo.Holder();
            int i;
            (h.Stored, i) = entry;
            object o = h.Stored;
            return (o == null) + ":" + i;
        }
        public static string Run() => Store(Demo.Make.Empty());
    }
}`, Emit(library))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = Translate(library, repository)
        let appPrinted = Translate(app, repository)
        Assert.Equal("True:0", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
        Assert.Contains("Stored Node?", libraryPrinted)
        Assert.DoesNotContain("Value!!", appPrinted)
    }

    private func BoxSource(extra string) string -> `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public class Box
    {
        public string Tag;
        public static implicit operator Box(Node node) => new Box { Tag = node == null ? "null" : "node" };
    }
    public static class Use
    {
        ` + extra + `
        public static Entry Empty() => new Entry(null, 0);
        public static string Convert(Entry entry) { Box b; int i; (b, i) = entry; return b.Tag + i; }
        public static string Plain(Entry entry) { Box b; b = entry.Item; return b.Tag; }
        public static string Run() => Convert(Empty()) + " " + Plain(Empty());
    }
}`

    /// A record from another project of the run is deconstructed through its emitted reference, where
    /// the synthesized `Deconstruct` is not marked implicitly declared. It is matched through the
    /// record's source declaration, whose positional property carries the producer's widening.
    @Fact
    func DeconstructionOfARecordFromAnotherProject_ReadsTheSourceProperty() {
        let library = Compile("Lib", `
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Make { public static Entry Empty() => new Entry(null, 0); }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public static class Use
    {
        public static string Store(Demo.Entry entry) { Demo.Node n; int i; (n, i) = entry; return n.ToString() + i; }
        public static string Read(Demo.Entry entry) { var (item, id) = entry; return item.ToString() + id; }
        public static string Run()
        {
            var entry = new Demo.Entry(new Demo.Node(), 1);
            return Store(entry) + " " + Read(entry);
        }
    }
}`, Emit(library))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = Translate(library, repository)
        let appPrinted = Translate(app, repository)
        Assert.Equal("node1 node1", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
        Assert.Contains("Item Node?", libraryPrinted)
        Assert.Contains("n = nValue!!", appPrinted)
        Assert.Contains("return item!!.ToString() + id", appPrinted)
    }

    private func Translate(source string) string {
        let compilation = Compile("Snippet", source, nil)
        return Translate(compilation, []CSharpCompilation{compilation})
    }

    private func Translate(compilation CSharpCompilation, repository IReadOnlyList[CSharpCompilation]) string {
        let tree = compilation.SyntaxTrees.Single()
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

    private func Compile(name string, source string, reference MetadataReference?) CSharpCompilation {
        let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest), path: name + ".cs")
        var references = CSharpProjectLoader.RuntimeReferences().ToList()
        if reference != nil {
            references.Add(reference)
        }
        let compilation = CSharpCompilation.Create(
            name,
            []SyntaxTree{tree},
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        return compilation
    }

    private func Emit(compilation CSharpCompilation) MetadataReference {
        let image = MemoryStream()
        Assert.True(compilation.Emit(image).Success)
        image.Position = 0
        return MetadataReference.CreateFromStream(image)
    }

    private func CompileAndRun(printedFiles IReadOnlyList[string], callExpression string) string {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5561-e2e", Guid.NewGuid().ToString("N"))
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
