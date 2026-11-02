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
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
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
        private func AssertRunsLikeCSharp(source string) string {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Snippet" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            using let peStream = MemoryStream()
            let emitted = compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let expected = cast[string](
                Assembly.Load(peStream.ToArray()).GetType("Demo", throwOnError: true)!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Equal(expected, CompileAndRun(printed).Trim())
            return printed
        }

        private func CompileAndRun(printed string) string {
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
                let (compileExit, compileOutput) = RunDotnet(
                    compiler!!,
                    "/target:exe",
                    "/out:$dllPath",
                    gsPath,
                    mainPath
                )
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
