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
/// @remarks Mutation witnesses (ADR-0154), each also failing on d12a50f86: with the
/// `IsTranslatorWidenedDeclaration` local arms of `IsNullablePromotedValue` and
/// `ReceiverValueIsPromotedNullable` reverted to `ShouldPromoteToNullableReference`, the first test
/// fails binding (GS0159, GS0154); with `BridgeDeconstructedElementStore` returning its value, the second
/// fails binding (GS0155); without the `CollectDeconstructedElementEdges` calls in `CollectEdges`,
/// the third throws `NullReferenceException` at the bridged store, where C# stores the null.
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

    private func Translate(source string) string {
        let tree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest), path: "Use.cs")
        let compilation = CSharpCompilation.Create(
            "Snippet",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let model = compilation.GetSemanticModel(tree)
        let document = LoadedDocument(tree.FilePath, tree, model)
        let context = TranslationContext(compilation, model, document.FilePath, []CSharpCompilation{compilation})
        return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
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
