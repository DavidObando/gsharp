// <copyright file="Issue5595DeconstructedElementStoreTests.cs" company="GSharp">
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

/// Issue #5595: in a nullable-oblivious compilation, the #2113 taint can widen a record's positional
/// property (`Entry.Item`) to `Node?`. A deconstruction into an array element or an indexer stores that
/// element, so the store gets the decision that the plain `arr[0] = entry.Item` gets (#2259): one
/// query, `ElementAccessStoreRequiresNonNullReference`, decides both forms, inside the deconstruction
/// store bridge of #5561 (`BridgeDeconstructedElementStore`).
///
/// | Shape | before | after (same as the plain element store) |
/// | --- | --- | --- |
/// | `(arr[0], i) = entry` into `Node[]` | `arr[0] = arrValue`, GS0155 | `arr[0] = arrValue!!`, as `arr[0] = entry.Item!!` |
/// | `(list[0], i) = entry` into `List<Node>` | `list[0] = listValue`, GS0155 | `list[0] = listValue!!`, as `list[0] = entry.Item!!` |
/// | a `Node?[]`, `List<Node?>` or a widened array local | no `!!` | unchanged: the element accepts null |
/// | another project's `[AllowNull]` indexer | no `!!` | unchanged: the indexer is promoted (#4356), so the slot is `T?` |
/// | an oblivious indexer of a prebuilt library outside the run | plain `h[0] = entry.Item!!` | no `!!` in either form: gsc imports the slot as a platform type (#3865) |
/// @remarks Mutation witnesses (ADR-0154): the first two tests fail on 21e3f30fa (GS0155) and when the
/// element arm of `BridgeDeconstructedElementStore` keeps the unbridged store. The nullable-element
/// test throws `NullReferenceException` when that arm asks `TargetWillRemainNonNullableReference`
/// instead of the element store query, and when the query does not ask `IsNullableArrayElementAccess`.
/// The `[AllowNull]` test throws when the query does not ask whether the indexer is promoted. The
/// imported oblivious indexer test throws when the query does not ask
/// `IsImportedObliviousNullableTarget`.
open class Issue5595DeconstructedElementStoreTests {
    /// A widened element stored into a `Node[]` element is bridged, as `arr[0] = entry.Item` is.
    @Fact
    func StoreIntoAnArrayElement_IsBridgedLikeThePlainElementStore() {
        let printed = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string A(Entry entry, Node[] arr) { int i; (arr[0], i) = entry; return arr[0].ToString() + i; }
        public static string APlain(Entry entry, Node[] arr) { arr[0] = entry.Item; return arr[0].ToString(); }
        public static string Run()
        {
            var entry = new Entry(new Node(), 1);
            return A(entry, new Node[1]) + " " + APlain(entry, new Node[1]);
        }
    }
}`)
        Assert.Equal("node1 node", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("arr[0] = arrValue!!\n", printed)
        Assert.Contains("arr[0] = entry.Item!!\n", printed)
    }

    /// A widened element stored through a `List<Node>` indexer is bridged, as `list[0] = entry.Item` is.
    @Fact
    func StoreThroughAnIndexer_IsBridgedLikeThePlainIndexerStore() {
        let printed = Translate(`
namespace Demo
{
    public class Node { public override string ToString() => "node"; }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string L(Entry entry, System.Collections.Generic.List<Node> list)
        {
            int i;
            (list[0], i) = entry;
            return list[0].ToString() + i;
        }
        public static string LPlain(Entry entry, System.Collections.Generic.List<Node> list)
        {
            list[0] = entry.Item;
            return list[0].ToString();
        }
        public static string Run()
        {
            var entry = new Entry(new Node(), 1);
            return L(entry, new System.Collections.Generic.List<Node> { null }) + " " +
                LPlain(entry, new System.Collections.Generic.List<Node> { null });
        }
    }
}`)
        Assert.Equal("node1 node", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.Contains("list[0] = listValue!!\n", printed)
        Assert.Contains("list[0] = entry.Item!!\n", printed)
    }

    /// An element that accepts null (an annotated `Node?[]` or `List<Node?>`, or an array local that
    /// the taint widens) takes the widened element without a bridge, as the plain store does, and the
    /// null that C# stores is stored.
    @Fact
    func StoreIntoANullableElement_IsNotBridged() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Widened(Entry entry)
        {
            var arr = new Node[1];
            arr[0] = null;
            int i;
            (arr[0], i) = entry;
            object o = arr[0];
            return (o == null) + ":" + i;
        }
        public static string WidenedPlain(Entry entry)
        {
            var arr = new Node[1];
            arr[0] = null;
            arr[0] = entry.Item;
            object o = arr[0];
            return (o == null).ToString();
        }
        public static string Run() =>
            Widened(Empty()) + " " + WidenedPlain(Empty()) + " " + Annotated.A(Empty(), new Node[1]) + " " +
            Annotated.APlain(Empty(), new Node[1]) + " " +
            Annotated.L(Empty(), new System.Collections.Generic.List<Node> { new Node() }) + " " +
            Annotated.LPlain(Empty(), new System.Collections.Generic.List<Node> { new Node() });
    }
#nullable enable
    public static class Annotated
    {
        public static string A(Entry entry, Node?[] arr) { int i; (arr[0], i) = entry; return (arr[0] == null) + ":" + i; }
        public static string APlain(Entry entry, Node?[] arr) { arr[0] = entry.Item; return (arr[0] == null).ToString(); }
        public static string L(Entry entry, System.Collections.Generic.List<Node?> list)
        {
            int i;
            (list[0], i) = entry;
            return (list[0] == null) + ":" + i;
        }
        public static string LPlain(Entry entry, System.Collections.Generic.List<Node?> list)
        {
            list[0] = entry.Item;
            return (list[0] == null).ToString();
        }
    }
#nullable restore
}`)
        Assert.Equal("True:0 True True:0 True True:0 True", CompileAndRun([]string{printed}, "Demo.Use.Run()").Trim())
        Assert.DoesNotContain("Value!!", printed)
        Assert.DoesNotContain("entry.Item!!", printed)
    }

    /// Another project's `[AllowNull]` indexer, bound through its emitted reference, is emitted with a
    /// `T?` value, so the deconstruction store and the plain store ask the same query and store the null.
    @Fact
    func StoreThroughAnAllowNullIndexerFromAnotherProject_IsNotBridged() {
        let library = Compile("Lib", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        private Node stored;
        [System.Diagnostics.CodeAnalysis.AllowNull]
        public Node this[int index] { get { return stored ?? new Node(); } set { stored = value; } }
        public bool IsEmpty => stored == null;
    }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public record Entry(Demo.Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Store(Entry entry)
        {
            var h = new Demo.Holder();
            int i;
            (h[0], i) = entry;
            return h.IsEmpty + ":" + i;
        }
        public static string Plain(Entry entry)
        {
            var h = new Demo.Holder();
            h[0] = entry.Item;
            return h.IsEmpty.ToString();
        }
        public static string Run() => Store(Empty()) + " " + Plain(Empty());
    }
}`, Emit(library))
        let repository = []CSharpCompilation{library, app}
        let libraryPrinted = Translate(library, repository)
        let appPrinted = Translate(app, repository)
        Assert.Equal("True:0 True", CompileAndRun([]string{libraryPrinted, appPrinted}, "Demo.App.Use.Run()").Trim())
        Assert.Contains("Item Node?", appPrinted)
        Assert.DoesNotContain("Value!!", appPrinted)
        Assert.DoesNotContain("entry.Item!!", appPrinted)
    }

    /// An indexer of a prebuilt nullable-oblivious library outside the run is imported with a platform
    /// type value, which accepts null, so neither the deconstruction store nor the plain store asserts
    /// the element, as for an imported oblivious property (#3865), and the null that C# stores is stored.
    @Fact
    func StoreThroughAnImportedObliviousIndexer_IsNotBridged() {
        let library = Compile("Ext", `
namespace Ext
{
    public class Node { }
    public class Holder
    {
        private Node stored;
        public Node this[int index] { get { return stored; } set { stored = value; } }
        public bool IsEmpty => stored == null;
    }
}`, nil)
        let app = Compile("App", `
namespace Demo.App
{
    public record Entry(Ext.Node Item, int Id);
    public static class Use
    {
        public static Entry Empty() => new Entry(null, 0);
        public static string Store(Entry entry)
        {
            var h = new Ext.Holder();
            int i;
            (h[0], i) = entry;
            return h.IsEmpty + ":" + i;
        }
        public static string Plain(Entry entry)
        {
            var h = new Ext.Holder();
            h[0] = entry.Item;
            return h.IsEmpty.ToString();
        }
        public static string Run() => Store(Empty()) + " " + Plain(Empty());
    }
}`, Emit(library))
        let appPrinted = Translate(app, []CSharpCompilation{app})
        Assert.Equal("True:0 True", CompileAndRun([]string{appPrinted}, "Demo.App.Use.Run()", library).Trim())
        Assert.Contains("Item Node?", appPrinted)
        Assert.DoesNotContain("Value!!", appPrinted)
        Assert.DoesNotContain("entry.Item!!", appPrinted)
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

    private func CompileAndRun(
        printedFiles IReadOnlyList[string],
        callExpression string,
        importedLibrary CSharpCompilation? = nil
    ) string {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
        let workDir = Path.Combine(AppContext.BaseDirectory, "issue-5595-e2e", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workDir)
        try {
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath"}
            if importedLibrary != nil {
                let libraryPath = Path.Combine(workDir, importedLibrary.AssemblyName + ".dll")
                using let image = File.Create(libraryPath)
                Assert.True(importedLibrary.Emit(image).Success)
                arguments.Add("/reference:$libraryPath")
            }
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
