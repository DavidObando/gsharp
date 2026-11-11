// <copyright file="Issue5602TypedLocalWidenedInitializerTests.cs" company="GSharp">
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
import System.Reflection
import System.Text
import System.Threading.Tasks
import Xunit

/// Issue #5602: in a nullable-oblivious compilation, the #2113 taint widens `Entry.Item` to `Node?`,
/// so G# infers `var item = entry.Item` and `var (item, _) = entry` as `Node?`. A store of that local
/// into a slot that stays non-null (`object o = item`, `o = item`) needs the bridge that a store of
/// `entry.Item` gets. The store bridge asked a narrower question about a local value than the
/// receiver and value rules, and a declaration did not bridge a promoted value into its type clause,
/// so each store failed to bind (GS0156). A later read of `o` got a redundant `o!!`.
/// @remarks Mutation witnesses (ADR-0154) are in the PR body.
open class Issue5602TypedLocalWidenedInitializerTests {
    /// The store into a typed local or an existing local is bridged, and the read of that local is
    /// not asserted again. The translation prints what the C# prints, also for `Empty()`: C# throws
    /// `NullReferenceException` at `o.ToString()`, and G# throws it at the store `item!!`. A local of
    /// a composed widened initializer (`entry.Item ?? entry.Item`) holds `Node?`, so its read is
    /// asserted (it was GS0159).
    @Fact
    func StoreOfAWidenedLocalIntoATypedLocal_IsBridgedLikeAnAssignment() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Plain(Entry entry) { var item = entry.Item; object o = item; return o.ToString(); }
        public static string Decon(Entry entry) { var (item, _) = entry; object o = item; return o.ToString(); }
        public static string Assigned(Entry entry) { var item = entry.Item; object o; o = item; return o.ToString(); }
        public static string Coalesced(Entry entry) { var n = entry.Item ?? entry.Item; return n.ToString(); }
        public static string Guard(Entry entry, int shape)
        {
            try { return shape == 0 ? Plain(entry) : shape == 1 ? Decon(entry) : shape == 2 ? Assigned(entry) : Coalesced(entry); }
            catch (System.NullReferenceException) { return "nre"; }
        }
        public static string Run()
        {
            var entry = new Entry(new Node(), 1);
            return Guard(entry, 0) + " " + Guard(entry, 1) + " " + Guard(entry, 2) + " " + Guard(entry, 3) + " " +
                Guard(Empty(), 0) + " " + Guard(Empty(), 1) + " " + Guard(Empty(), 2) + " " + Guard(Empty(), 3);
        }
    }
}`)
        Assert.Equal("node node node node nre nre nre nre", RunCSharp(compilation).Trim())
        Assert.Equal("node node node node nre nre nre nre", CompileAndRun(printed).Trim())
        Assert.Contains(
            "func Plain(entry Entry) string? {\n        let item = entry.Item\n        let o object = item!!\n        return o.ToString()\n",
            printed
        )
        Assert.Contains(
            "func Decon(entry Entry) string? {\n        let (item, _) = entry\n        let o object = item!!\n        return o.ToString()\n",
            printed
        )
        Assert.Contains("        var o object\n        o = item!!\n        return o.ToString()\n", printed)
        Assert.Contains("let n = entry.Item ?? entry.Item\n        return n!!.ToString()\n", printed)
        Assert.DoesNotContain("o!!", printed)
    }

    /// A typed local whose storage G# infers from the initializer (`Node n = entry.Item`, no type
    /// clause) and a typed local that the code null-tests (`object? o`) accept the null as C# does,
    /// so their initializers are not bridged.
    @Fact
    func StoreIntoStorageThatAcceptsNil_IsNotBridged() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static bool Inferred(Entry entry) { Node n = entry.Item; return ReferenceEquals(n, entry.Item); }
        public static string Tested(Entry entry) { var item = entry.Item; object o = item; return o == null ? "null" : "node"; }
        public static string Run() => Inferred(Empty()) + " " + Tested(Empty()) + " " + Tested(new Entry(new Node(), 1));
    }
}`)
        Assert.Equal("True null node", RunCSharp(compilation).Trim())
        Assert.Equal("True null node", CompileAndRun(printed).Trim())
        Assert.Contains("let n = entry.Item\n", printed)
        Assert.Contains("let o object? = item\n", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// A local whose emitted storage G# infers from a widened initializer (`Node n = entry.Item`,
    /// `var n = entry.Item`, also through `??` or `?:`) holds `Node?`, so a store into it takes the
    /// null as C# does: plain, chained and from the widened property. A user-defined conversion still
    /// checks its operand.
    @Fact
    func StoreIntoALocalOfNullableStorage_IsNotBridged() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public class Box
    {
        public string Name;
        public static implicit operator Box(Node node) => new Box { Name = node.ToString() };
    }
    public record Entry(Node Item, Box Wrap, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, null, 0);
        public static bool Typed(Entry entry) { Node n = entry.Item; var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool Inferred(Entry entry) { var n = entry.Item; var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool TypedProperty(Entry entry) { Node n = entry.Item; n = entry.Item; return ReferenceEquals(n, entry.Item); }
        public static bool InferredProperty(Entry entry) { var n = entry.Item; n = entry.Item; return ReferenceEquals(n, entry.Item); }
        public static bool Coalesced(Entry entry) { var n = entry.Item ?? entry.Item; var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool Assigned(Entry entry) { var item = entry.Item; var slot = entry.Item; var n = (slot = item); n = item; return ReferenceEquals(n, item); }
        public static bool Checked(Entry entry) { var n = checked(entry.Item ?? entry.Item); var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool Unchecked(Entry entry) { var n = unchecked(entry.Item ?? entry.Item); var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool Conditional(Entry entry, bool flag) { var n = flag ? entry.Item : new Node(); var item = entry.Item; n = item; return ReferenceEquals(n, item); }
        public static bool Chained(Entry entry)
        {
            Node n = entry.Item;
            var m = entry.Item;
            var item = entry.Item;
            n = m = item;
            return ReferenceEquals(n, item) && ReferenceEquals(m, item);
        }
        public static string Convert(Entry entry)
        {
            var b = entry.Wrap;
            var item = entry.Item;
            try { b = item; return b.Name; }
            catch (System.NullReferenceException) { return "nre"; }
        }
        public static string Run() =>
            Typed(Empty()) + " " + Inferred(Empty()) + " " + TypedProperty(Empty()) + " " +
            InferredProperty(Empty()) + " " + Coalesced(Empty()) + " " + Conditional(Empty(), true) + " " +
            Checked(Empty()) + " " + Unchecked(Empty()) + " " + Assigned(Empty()) + " " +
            Chained(Empty()) + " " + Convert(Empty()) + " " +
            Convert(new Entry(new Node(), null, 1));
    }
}`)
        Assert.Equal("True True True True True True True True True True nre node", RunCSharp(compilation).Trim())
        Assert.Equal("True True True True True True True True True True nre node", CompileAndRun(printed).Trim())
        Assert.Contains(
            "func Typed(entry Entry) bool {\n        var n = entry.Item\n        let item = entry.Item\n        n = item\n",
            printed
        )
        Assert.Contains(
            "func TypedProperty(entry Entry) bool {\n        var n = entry.Item\n        n = entry.Item\n",
            printed
        )
        Assert.Contains("n = (m = item)\n", printed)
        Assert.Contains("b = item!!\n", printed)
        Assert.Equal(1, printed.Split("item!!").Length - 1)
        Assert.DoesNotContain("Item!!", printed)
    }

    /// The local query reads each link of a chain of composed initializers once. Every link names
    /// the link before it in both arms, so without the kept answers the work doubles with each link.
    @Fact
    func ComposedAliasChain_TranslatesInLinearWork() {
        let body = StringBuilder("var a0 = p; ")
        for var i = 1; i <= 64; i++ {
            body.Append("var a$i = flag ? a${i - 1} : a${i - 1}; ")
        }
        let source = "namespace Demo { public class Node { } public static class Use { " +
            "public static string Chain(Node p, bool flag) { " +
            body.ToString() + "object o = a64; return o.ToString() + a64.ToString(); } } }"
        let translation = Task.Run(() -> Translate(source).Printed)
        Assert.True(translation.Wait(TimeSpan.FromMinutes(2)), "The translation of a 64-link chain must finish.")
        Assert.Contains("let o object = a64\n", translation.Result)
    }

    /// A composed initializer whose arms G# types non-null (a checked cast `cast[Node](entry.Item)`, an
    /// un-widened parameter, or a widened value that a user-defined conversion with a non-null result
    /// converts) gives the local non-null storage, so a widened value stored into it keeps its bridge,
    /// as before. The bridge throws if the value is null, as `n = entry.Item!!` does for any non-null
    /// local.
    @Fact
    func StoreIntoALocalOfNonNullComposedStorage_KeepsItsBridge() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public class Box
    {
        public string Name = "box";
        public static implicit operator Box(Node node) => node == null ? new Box() : new Box();
    }
    public record Entry(Node Item, Box Wrap, int Id);
    public class Holder { public Node Plain = new Node(); }
    public static class Use
    {
        public static Entry Empty() => new Entry(null, null, 0);
        public static Entry Full() => new Entry(new Node(), new Box(), 1);
        public static string Mixed(Entry entry, Node fallback, bool flag)
        {
            var n = flag ? (Node)entry.Item : fallback;
            n = entry.Item;
            return n.ToString();
        }
        public static string AssignedField(Entry entry, Holder h, Node fallback)
        {
            var n = (h.Plain = fallback);
            n = entry.Item;
            return n.ToString();
        }
        public static string Converted(Entry entry, Box fallback, bool flag)
        {
            var b = flag ? entry.Item : fallback;
            b = entry.Wrap;
            return b.Name;
        }
        public static string ConvertedArm(Entry entry, Box fallback, bool flag)
        {
            var b = flag switch { true => entry.Item, _ => fallback };
            b = entry.Wrap;
            return b.Name;
        }
        public static string Run() =>
            Mixed(Full(), new Node(), false) + " " + Mixed(Full(), new Node(), true) + " " +
            Converted(Full(), new Box(), true) + " " + ConvertedArm(Full(), new Box(), true) + " " +
            AssignedField(Full(), new Holder(), new Node());
    }
}`)
        Assert.Equal("node node box box node", RunCSharp(compilation).Trim())
        Assert.Equal("node node box box node", CompileAndRun(printed).Trim())
        Assert.Contains("        n = entry.Item!!\n        return n.ToString()\n", printed)
        Assert.Equal(2, printed.Split("b = entry.Wrap!!\n").Length - 1)
        Assert.Contains("        n = entry.Item!!\n        return n.ToString()\n    }\n\n    func Converted", printed)
    }

    /// A local that its own initializer assigns asks the local query about itself. The inner
    /// question answers no, so the translation finishes, and the store keeps `main`'s decision.
    @Fact
    func SelfAssigningInitializer_Translates() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public static class Use
    {
        public static string Self() { object n = (n = new object()); return n.ToString(); }
        public static string Run() => Self();
    }
}`)
        Assert.Equal("System.Object", RunCSharp(compilation).Trim())
        Assert.Contains("        var n = (n = SystemObject())\n        return n.ToString()\n", printed)
    }

    /// Issue #5645: both the typed promoted local and its inferred source keep the conditional's narrowing.
    @Fact
    func Issue5645_PromotedLocalInItsOwnNullTestArm_DoesNotAssert() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node
    {
        public Node Child { get; }
        public bool IsValid { get; }
        public override string ToString() => "node";
    }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Tested(Entry entry) { var item = entry.Item; object o = item; return o == null ? "null" : o.ToString(); }
        public static string Inferred(Entry entry) { var item = entry.Item; return item == null ? "null" : item.ToString(); }
        public static string StablePath(Entry entry)
        {
            var item = entry.Item;
            if (item == null) return "null";
            return item.Child == null || !item.Child.IsValid ? "node" : "bad";
        }
        public static string Run() => Tested(Empty()) + " " + Tested(new Entry(new Node(), 1)) + " " +
            Inferred(Empty()) + " " + Inferred(new Entry(new Node(), 1)) + " " +
            StablePath(Empty()) + " " + StablePath(new Entry(new Node(), 1));
    }
}`)
        Assert.Equal("null node null node null node", RunCSharp(compilation).Trim())
        Assert.Equal("null node null node null node", CompileAndRun(printed).Trim())
        Assert.Contains("let o object? = item\n", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// Issue #5645: receiver and argument reads share G#'s guard regions even without Roslyn flow analysis.
    @Fact
    func Issue5645_PromotedLocalGuardRegions_NarrowReceiverAndArgumentReads() {
        let source = StringBuilder(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static Entry Full() => new Entry(new Node(), 1);
#nullable enable
        public static bool TakeNonNull(object value) => value.GetType().Name == "Node";
#nullable disable
`)
        let calls = List[string]()
        for initializer in[]string{"var item = entry.Item; object o = item;", "var o = entry.Item;"} {
            for read in[]string{"o.ToString() == \"node\"", "TakeNonNull(o)"} {
                for guard_ in[]string{
                    "return o == null ? false : READ;",
                    "return o != null ? READ : false;",
                    "return o is null ? false : READ;",
                    "return o is not null ? READ : false;",
                    "return o != null && READ;",
                    "return !(o == null || !(READ));",
                    "if (o != null) return READ; return false;",
                    "if (o == null) return false; else return READ;",
                    "if (o == null) return false; return READ;",
                    "if (o is null) return false; return READ;"
                } {
                    let name = "Test${calls.Count}"
                    source.Append("public static bool $name(Entry entry) { $initializer ")
                    source.Append(guard_.Replace("READ", read))
                    source.Append(" }\n")
                    calls.Add("$name(Empty())")
                    calls.Add("$name(Full())")
                }
            }
        }
        source.Append("public static string Run() => " + string.Join(" + \" \" + ", calls) + "; } }")
        let (printed, compilation) = Translate(source.ToString())
        let expected = string.Join(" ", Enumerable.Repeat("False True", calls.Count / 2))
        Assert.Equal(expected, RunCSharp(compilation).Trim())
        Assert.Equal(expected, CompileAndRun(printed).Trim())
        Assert.Contains("func TakeNonNull(value object) bool", printed)
        Assert.DoesNotContain("o!!", printed)
    }

    /// Issue #5645: writes and escaped closure calls end narrowing; mutable captures do not inherit an outer guard.
    @Fact
    func Issue5645_PromotedLocalInvalidatedGuards_KeepRequiredAssertions() {
        let (printed, compilation) = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static bool SideEffect(System.Action write) { write(); return true; }
#nullable enable
        public static string TakeNonNull(object value) => value.GetType().Name;
#nullable disable
        public static string Conditional(Entry entry)
        {
            object o = entry.Item;
            System.Action write = () => { o = null; };
            return o != null && SideEffect(write) ? o.ToString() : "null";
        }
        public static string ConditionalArgument(Entry entry)
        {
            object o = entry.Item;
            System.Action write = () => { o = null; };
            return o != null && SideEffect(write) ? TakeNonNull(o) : "null";
        }
        public static string Arm(Entry entry)
        {
            object o = entry.Item;
            System.Action write = () => { o = null; };
            return o == null ? "null" : SideEffect(write) ? TakeNonNull(o) : "bad";
        }
        public static string IfArm(Entry entry)
        {
            object o = entry.Item;
            System.Action write = () => { o = null; };
            if (o != null) { SideEffect(write); return TakeNonNull(o); }
            return "null";
        }
        public static string Reassigned(Entry entry)
        {
            object o = entry.Item;
            if (o == null) return "null";
            o = Empty().Item;
            return o.ToString();
        }
        public static string Captured(Entry entry)
        {
            object o = entry.Item;
            if (o == null) return "null";
            System.Func<string> read = () => o.ToString();
            o = Empty().Item;
            return read();
        }
        public static string AssignedCondition(Entry entry)
        {
            object o = null;
            return (o = entry.Item) != null ? o.ToString() : "null";
        }
        public static string Guard(Entry entry, int shape)
        {
            try { return shape == 0 ? Conditional(entry) : shape == 1 ? ConditionalArgument(entry) :
                shape == 2 ? Arm(entry) : shape == 3 ? Reassigned(entry) : shape == 4 ? Captured(entry) : IfArm(entry); }
            catch (System.NullReferenceException) { return "nre"; }
        }
        public static string Run()
        {
            var full = new Entry(new Node(), 1);
            return Guard(Empty(), 0) + " " + Guard(full, 0) + " " + Guard(full, 1) + " " +
                Guard(full, 2) + " " + Guard(full, 3) + " " + Guard(full, 4) + " " + Guard(full, 5) + " " +
                AssignedCondition(Empty()) + " " + AssignedCondition(full);
        }
    }
}`)
        Assert.Equal("null nre nre nre nre nre nre null node", RunCSharp(compilation).Trim())
        Assert.Equal("null nre nre nre nre nre nre null node", CompileAndRun(printed).Trim())
        Assert.Contains("o!!.ToString()", printed)
        Assert.Contains("TakeNonNull(o!!)", printed)
    }

    shared {
        private func Translate(source string)(Printed string, Compilation CSharpCompilation) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
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
            let repository = []CSharpCompilation{compilation}
            let context = TranslationContext(
                compilation,
                model,
                tree.FilePath,
                siblingCompilations: repository,
                repositoryCompilations: repository
            )
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            )
            return (printed, compilation)
        }

        // The C# oracle: runs `Demo.Use.Run()` of the source compilation.
        private func RunCSharp(compilation CSharpCompilation) string {
            let image = MemoryStream()
            Assert.True(compilation.Emit(image).Success)
            let assembly = Assembly.Load(image.ToArray())
            let run MethodInfo? = assembly.GetType("Demo.Use")?.GetMethod("Run")
            Assert.NotNull(run)
            return run!!.Invoke(nil, nil) as string ?? ""
        }

        private func CompileAndRun(printed string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5602-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                let gsPath = Path.Combine(workDir, "Unit.gs")
                File.WriteAllText(gsPath, printed)
                let entryPath = Path.Combine(workDir, "Main.gs")
                File.WriteAllText(
                    entryPath,
                    "import System${Environment.NewLine}${Environment.NewLine}Console.WriteLine(Demo.Use.Run())${Environment.NewLine}"
                )
                let (compileExit, compileOutput) = RunDotnet(
                    compiler!!,
                    "/target:exe",
                    "/out:$dllPath",
                    gsPath,
                    entryPath
                )
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase) &&
                        !compileOutput.Contains("warning", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet with no errors or warnings. Output:\n" + compileOutput + `

Translated G#:
` + printed
                )
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(
                    runExit == 0,
                    "Translated snippet must run successfully. Output:\n" + runOutput + "\nTranslated G#:\n" + printed
                )
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
