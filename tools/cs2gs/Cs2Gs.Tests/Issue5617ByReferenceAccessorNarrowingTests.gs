// <copyright file="Issue5617ByReferenceAccessorNarrowingTests.gs" company="GSharp">
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
import System.Runtime.Loader
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #5617: gsc removes the narrowing fact of a by-reference variable at an accessor that can run user code
/// (ADR-0208 R14, R16 and R17) and at a write through a member or an element (R12). C# flow analysis keeps the
/// fact, so the translated read needs its own `!!`. An accessor that runs no user code keeps the fact, so its read
/// stays bare. Each test translates the C#, compiles the G# with the repository's `gsc.dll`, runs it, and compares
/// the output with the output of the C#.
open class Issue5617ByReferenceAccessorNarrowingTests {
    /// The issue shape: `Lazy<T>.Value` is an imported getter that is not on the stable list (R16).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public class Demo
{
    public static int Compute(ref string? s, Lazy<int> lazy)
    {
        if (s == null) return 0;
        var n = lazy.Value;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Lazy<int>(() => 1)).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// A source property with a computed getter runs user code (R14).
    @Fact
    func RefParameter_ReadAfterAComputedSourceGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
}
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var n = counter.Next;
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An overridable auto property read through a receiver whose type can have a subclass can dispatch to an
    /// override with user code (R14, #5599).
    @Fact
    func OutParameter_ReadAfterAnOverridableAutoPropertyOfAnOpenReceiver_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Shape
{
    public virtual int Size { get; set; }
}
public class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    static string? Pick() => "abc";
    public static int Compute(out string? s, Shape shape)
    {
        s = Pick();
        if (s == null) return 0;
        var n = shape.Size;
        return s.Length + n;
    }
    public static string Run() => Compute(out _, new Square()).ToString();
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer read that is not on the stable list (`Dictionary<K, V>` calls `GetHashCode` and `Equals`
    /// of the key) runs user code (R17).
    @Fact
    func RefParameter_ReadAfterAnUnlistedImportedIndexer_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
public class Demo
{
    public static int Compute(ref string? s, Dictionary<int, int> map)
    {
        if (s == null) return 0;
        var n = map[1];
        return s.Length + n;
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Dictionary<int, int> { [1] = 7 }).ToString();
    }
}`)
        Assert.Contains("s!!.Length", printed)
    }

    /// An imported indexer write, an imported setter and a field write: a write through a member or an element can
    /// change the storage that a by-reference parameter names (R12, R17).
    @Fact
    func RefParameter_ReadAfterAnImportedSetterOrIndexerWrite_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.IO;
public sealed class Box
{
    public int Field;
}
public class Demo
{
    public static int Store(ref string? s, Dictionary<int, int> table)
    {
        if (s == null) return 0;
        table[2] = 5;
        return s.Length + table.Count;
    }
    public static int Seek(ref string? s, MemoryStream stream)
    {
        if (s == null) return 0;
        stream.Position = 0;
        return s.Length;
    }
    public static int Write(ref string? s, Box box)
    {
        if (s == null) return 0;
        box.Field = 3;
        return s.Length + box.Field;
    }
    public static string Run()
    {
        string? text = "abc";
        return Store(ref text, new Dictionary<int, int>()) + "," + Seek(ref text, new MemoryStream()) + "," + Write(ref text, new Box());
    }
}`)
        Assert.Contains("return s!!.Length + table.Count", printed)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s!!.Length + box.Field", printed)
    }

    /// cs2gs lowers a positional subpattern to a read of the member that its slot deconstructs to, so a computed
    /// getter there runs user code (R14). A positional record property is a plain auto property and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAPositionalPatternOverAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Counter
{
    private int count;
    public int Next => ++count;
    public void Deconstruct(out int next) { next = Next; }
}
public sealed record Point(int X);
public class Demo
{
    public static int Compute(ref string? s, Counter counter)
    {
        if (s == null) return 0;
        var hit = counter is Counter(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static int Plain(ref string? s, Point point)
    {
        if (s == null) return 0;
        var hit = point is Point(1);
        return s.Length + (hit ? 1 : 0);
    }
    public static string Run()
    {
        string? text = "abc";
        return Compute(ref text, new Counter()) + "," + Plain(ref text, new Point(1));
    }
}`)
        Assert.Contains("return s!!.Length + (if hit", printed)
        Assert.Contains("return s.Length + (if hit", printed)
    }

    /// The guard's own pattern runs its getters before the fact holds, so gsc does not narrow a by-reference variable
    /// on a pattern with a computed getter (R18 (6)). A plain auto property keeps the fact.
    @Fact
    func RefParameter_GuardedByItsOwnPatternWithAComputedGetter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed class Box
{
    private int count;
    public int P => ++count;
    public int Q { get; set; }
    public int X = 7;
}
public class Demo
{
    public static int Compute(ref Box? s)
    {
        if (s is Box { P: 1 } matched) return s.X;
        return 0;
    }
    public static int Plain(ref Box? s)
    {
        if (s is Box { Q: 0 } matched) return s.X + 1;
        return 0;
    }
    public static string Run()
    {
        Box? box = new Box();
        return Compute(ref box) + "," + Plain(ref box);
    }
}`)
        Assert.Contains("return s!!.X\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.X + 1", printed)
    }

    /// A writable `ref` local of an element can write the storage that a by-reference parameter names, so gsc records
    /// it as a write (R12, `RecordWritableReference`). A `ref readonly` local and a `ref` local of a local keep the fact.
    @Fact
    func RefParameter_ReadAfterAWritableRefLocalOfAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public class Demo
{
    public static int Writable(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref int alias = ref xs[0];
        return s.Length + alias;
    }
    public static int ReadOnly(ref string? s, int[] xs)
    {
        if (s == null) return 0;
        ref readonly int view = ref xs[0];
        return s.Length + view + 1;
    }
    public static int OfLocal(ref string? s, int[] xs)
    {
        var n = xs[1];
        if (s == null) return 0;
        ref int local = ref n;
        return s.Length + local + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var xs = new int[] { 4, 5 };
        return Writable(ref text, xs) + "," + ReadOnly(ref text, xs) + "," + OfLocal(ref text, xs);
    }
}`)
        Assert.Contains("return s!!.Length + alias", printed)
        Assert.Contains("return s.Length + view + 1", printed)
        Assert.Contains("return s.Length + local + 2", printed)
    }

    /// gsc emits an index read on an imported `List<int>` subclass nested in `Outer<T>` through `IList`, because the
    /// CLR type arguments of the nested type include `T` (R17). The listed `List<T>` indexer is then not the one that
    /// runs. A closed `Outer<string>.Items` uses the listed indexer and keeps the fact.
    @Fact
    func RefParameter_ReadAfterAnIndexOfAnImportedNestedTypeOfAGenericParameter_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using Lib;
public class Demo
{
    public static int Open<T>(ref string? s, Outer<T>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n;
    }
    public static int Closed(ref string? s, Outer<string>.Items items)
    {
        if (s == null) return 0;
        var n = items[0];
        return s.Length + n + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        var items = new Outer<string>().Values;
        return Open<string>(ref text, items) + "," + Closed(ref text, items);
    }
}`, library: `
using System.Collections.Generic;
namespace Lib
{
    public class Outer<T>
    {
        public class Items : List<int> { }
        public Items Values { get; } = new Items { 4 };
    }
}`)
        Assert.Contains("return s!!.Length + n\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("return s.Length + n + 1", printed)
    }

    /// A `with` expression writes the members of the copy, which gsc counts as a member write (R12), for a positional
    /// property and for an `init` property.
    @Fact
    func RefParameter_ReadAfterARecordWithExpression_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public sealed record Rec(int X)
{
    public int Y { get; init; }
}
public class Demo
{
    public static int Positional(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { X = 2 };
        return s.Length + r2.X;
    }
    public static int Init(ref string? s, Rec r)
    {
        if (s == null) return 0;
        var r2 = r with { Y = 3 };
        return s.Length + r2.Y;
    }
    public static string Run()
    {
        string? text = "abc";
        return Positional(ref text, new Rec(1)) + "," + Init(ref text, new Rec(1));
    }
}`)
        Assert.Contains("return s!!.Length + r2.X", printed)
        Assert.Contains("return s!!.Length + r2.Y", printed)
    }

    /// The address of a member names storage that a write through the pointer can change, so gsc counts it as a
    /// write (R12). The address of a local keeps the fact.
    @Fact
    func RefParameter_ReadAfterTheAddressOfAMember_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Pt { public int X; }
public class Demo
{
    public static unsafe int Member(ref string? s, int seed)
    {
        var pt = new Pt { X = seed };
        if (s == null) return 0;
        int* p = &pt.X;
        return s.Length + *p;
    }
    public static unsafe int Local(ref string? s, int seed)
    {
        var n = seed;
        if (s == null) return 0;
        int* q = &n;
        return s.Length + *q + 1;
    }
    public static string Run()
    {
        string? text = "abc";
        return Member(ref text, 4) + "," + Local(ref text, 4);
    }
}`)
        Assert.Contains("return s!!.Length + *p", printed)
        Assert.Contains("return s.Length + *q + 1", printed)
    }

    /// cs2gs passes the receiver of a `this ref` extension as `&counters[0]`, a writable reference to an element,
    /// which gsc counts as a write (R12). A local receiver and an `in` receiver keep the fact.
    @Fact
    func RefParameter_ReadAfterARefExtensionCallOnAnElement_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
public struct Counter { public int N; }
public static class Ext
{
    public static void Touch(this ref Counter value) { value.N++; }
    public static int Peek(this in Counter value) => value.N;
}
public class Demo
{
    public static int Element(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        counters[0].Touch();
        return s.Length + counters[0].N;
    }
    public static int Local(ref string? s, int seed)
    {
        var c = new Counter { N = seed };
        if (s == null) return 0;
        c.Touch();
        return s.Length + c.N + 1;
    }
    public static int ReadOnly(ref string? s, Counter[] counters)
    {
        if (s == null) return 0;
        var n = counters[0].Peek();
        return s.Length + n + 2;
    }
    public static string Run()
    {
        string? text = "abc";
        var counters = new Counter[1];
        return Element(ref text, counters) + "," + Local(ref text, 1) + "," + ReadOnly(ref text, counters);
    }
}`)
        Assert.Contains("return s!!.Length + counters[0].N", printed)
        Assert.Contains("return s.Length + c.N + 1", printed)
        Assert.Contains("return s.Length + n + 2", printed)
    }

    /// A `switch` case or arm runs its test, and its guard, before its body (ADR-0208, #5629). cs2gs lowers a property
    /// case to a guard that reads the property, so a computed getter there removes the fact for the body. A constant
    /// case on `object` calls `Equals`, a plain call that keeps the fact of a by-reference variable (amendment A3).
    @Fact
    func RefParameter_ReadInASwitchCaseAfterAnAccessorTest_IsAsserted() {
        let printed = AssertRunsLikeCSharp(`
using System;
public sealed class Box { private int count; public int P => ++count; }
public class Demo
{
    public static int Case(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case Box { P: 1 }:
                return s.Length;
            default:
                return 0;
        }
    }
    public static int Arm(ref string? s, object o)
    {
        if (s == null) return 0;
        return o switch { Box { P: 1 } => s.Length + 1, _ => 0 };
    }
    public static int Guard(ref string? s, int n, Lazy<int> lazy)
    {
        if (s == null) return 0;
        switch (n)
        {
            case 1 when lazy.Value > 0:
                return s.Length + 2;
            default:
                return 0;
        }
    }
    public static int Constant(ref string? s, object o)
    {
        if (s == null) return 0;
        switch (o)
        {
            case 1:
                return s.Length + 3;
            default:
                return 0;
        }
    }
    public static string Run()
    {
        string? text = "abc";
        return Case(ref text, new Box()) + "," + Arm(ref text, new Box()) + "," +
            Guard(ref text, 1, new Lazy<int>(() => 1)) + "," + Constant(ref text, 1);
    }
}`)
        Assert.Contains("return s!!.Length\n", printed.Replace("\r\n", "\n"))
        Assert.Contains("s!!.Length + 1", printed)
        Assert.Contains("return s!!.Length + 2", printed)
        Assert.Contains("return s.Length + 3", printed)
    }

    /// A field read, the getters and indexers on the stable list, a plain auto property, an overridable auto property
    /// through a receiver that cannot have a subclass, and `Nullable<T>.Value` (which the translator emits as `!!`)
    /// run no user code, so gsc keeps the fact and the read stays bare.
    @Fact
    func RefParameter_ReadAfterAccessorsThatRunNoUserCode_StaysBare() {
        let printed = AssertRunsLikeCSharp(`
using System.Collections.Generic;
using System.Text;
public sealed class Box
{
    public int Field = 1;
}
public sealed class Person
{
    public string Name { get; init; } = "ab";
    public int Age { get; set; }
}
public class Shape
{
    public virtual int Size { get; set; }
}
public sealed class Square : Shape
{
    public Square() { Size = 5; }
    public override int Size { get; set; }
}
public class Demo
{
    public static int Compute(ref string? s, Box box, string other, List<int> list, Dictionary<int, int> table, StringBuilder builder)
    {
        if (s == null) return 0;
        var a = box.Field;
        var b = other.Length + other[0];
        var c = list.Count + list[0];
        var d = table.Count + builder.Length;
        return s.Length + a + b + c + d;
    }
    public static int Members(ref string? s, Person person, Square square, int? maybe)
    {
        if (s == null) return 0;
        var a = person.Name.Length + person.Age;
        var b = square.Size;
        var c = maybe.HasValue ? maybe.Value : 0;
        return s.Length + a + b + c;
    }
    public static string Run()
    {
        string? text = "abc";
        var list = new List<int> { 4 };
        var table = new Dictionary<int, int> { [1] = 1 };
        return Compute(ref text, new Box(), "xy", list, table, new StringBuilder("q")) + "," + Members(ref text, new Person(), new Square(), 3);
    }
}`)
        Assert.DoesNotContain("s!!", printed)
    }

    shared {
        /// Runs `Demo.Run()` of the C# and of its translation and compares the output. [`library`](paramref) is C#
        /// that both reference as a prebuilt assembly (`Lib5617`), so its types are imported in the G#.
        private func AssertRunsLikeCSharp(source string, library string? = nil) string {
            let libraryImage = if library == nil {
                Array.Empty[byte]()
            } else {
                EmitCSharp("Lib5617", library)
            }
            let references = List[MetadataReference](CSharpProjectLoader.RuntimeReferences())
            if libraryImage.Length > 0 {
                references.Add(MetadataReference.CreateFromImage(libraryImage))
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            using let peStream = MemoryStream()
            let emitted = compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue5617", isCollectible: true)
            try {
                if libraryImage.Length > 0 {
                    loadContext.LoadFromStream(MemoryStream(libraryImage))
                }
                peStream.Position = 0
                let expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
                let model = compilation.GetSemanticModel(tree)
                let document = LoadedDocument("Snippet.cs", tree, model)
                let context = TranslationContext(compilation, model, document.FilePath)
                let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.Equal(expected, CompileAndRun(printed, libraryImage).Trim())
                return printed
            } finally {
                loadContext.Unload()
            }
        }

        private func EmitCSharp(name string, source string)[]byte {
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let stream = MemoryStream()
            let emitted = compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            return stream.ToArray()
        }

        private func CompileAndRun(printed string, libraryImage[]byte) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue5617ByReferenceAccessorNarrowingTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let mainPath = Path.Combine(workDir, "Main.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(gsPath, printed)
                File.WriteAllText(
                    mainPath,
                    "import System${Environment.NewLine}Console.WriteLine(Demo.Run())${Environment.NewLine}"
                )
                let arguments = List[string]{compiler!!, "/target:exe", "/out:$dllPath", gsPath, mainPath}
                if libraryImage.Length > 0 {
                    let libraryPath = Path.Combine(workDir, "Lib5617.dll")
                    File.WriteAllBytes(libraryPath, libraryImage)
                    arguments.Add("/r:" + libraryPath)
                }
                let (compileExit, compileOutput) = RunDotnet(arguments.ToArray())
                Assert.True(
                    compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" +
                        compileOutput +
                        "\n\nTranslated G#:\n" +
                        printed
                )
                // A `!!` on the by-reference read where gsc keeps the fact is GS0536.
                let lines = printed.Replace("\r\n", "\n").Split('\n')
                for diagnostic in Regex.Matches(compileOutput, `Snippet\.gs\((\d+),\d+,\d+,\d+\): warning GS0536`) {
                    let line = lines[int32.Parse(diagnostic.Groups[1].Value) - 1]
                    Assert.False(line.Contains("s!!"), "gsc keeps the fact here (GS0536): " + line)
                }
                let (runExit, runOutput) = RunDotnet(dllPath)
                Assert.True(runExit == 0, "The translated snippet must run. Output:\n" + runOutput)
                return runOutput
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
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
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(TimeSpan.FromMinutes(5)) {
                process.Kill(entireProcessTree: true)
                Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
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
