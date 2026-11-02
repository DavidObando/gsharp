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
            Chained(Empty()) + " " + Convert(Empty()) + " " +
            Convert(new Entry(new Node(), null, 1));
    }
}`)
        Assert.Equal("True True True True True True True nre node", RunCSharp(compilation).Trim())
        Assert.Equal("True True True True True True True nre node", CompileAndRun(printed).Trim())
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

    /// The local query reads each link of an alias chain once. Every link asks the query about the
    /// link before it twice, so without the kept answers the work doubles with each link.
    @Fact
    func AliasChain_TranslatesInLinearWork() {
        let body = StringBuilder("var a0 = p; ")
        for var i = 1; i <= 64; i++ {
            body.Append("var a$i = a${i - 1}; ")
        }
        let source = "namespace Demo { public class Node { } public static class Use { " +
            "public static string Chain(Node p) { " +
            body.ToString() + "object o = a64; return o.ToString() + a64.ToString(); } } }"
        let translation = Task.Run(() -> Translate(source).Printed)
        Assert.True(translation.Wait(TimeSpan.FromMinutes(2)), "The translation of a 64-link alias chain must finish.")
        Assert.Contains("let o object = a64\n", translation.Result)
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
