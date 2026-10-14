// <copyright file="Issue4350IndexerOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import SourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GSharp.Compiler
import GSharp.Compiler.Tests

/// ADR-0187 / issue #4350: overloaded user indexers compile, verify, and run,
/// and each overload is emitted as its own `Item` property so a C#
/// consumer sees the same overload set a C# declaration would produce.
open class Issue4350IndexerOverloadEmitTests {
    @Fact
    func OverloadedIndexers_CompileVerifyAndRun() {
        let source = `package P
import System

struct Buffer[T](items []T) {
    prop this[index int32] ref T -> items[index]
    prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
    prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
}

class Table {
    private var values []string = []string{"a", "b", "c"}
    prop this[index int32] string {
        get { return values[index] }
        set { values[index] = value }
    }
    prop this[name string] string {
        get { return name + "!" }
    }
    prop this[row int32, column int32] int32 -> row * 10 + column
}

let buffer = Buffer[int32]([]int32{10, 20, 30})
Console.WriteLine(buffer[0])
Console.WriteLine(buffer[^1])
let last = ^2
Console.WriteLine(buffer[last])
Console.WriteLine(buffer[1, true])
var mutable = Buffer[int32]([]int32{1, 2, 3})
mutable[0] = 5
mutable[^1] = 9
Console.WriteLine(mutable[0] + mutable[2])
let table = Table()
table[1] = "z"
Console.WriteLine(table[1])
Console.WriteLine(table["key"])
Console.WriteLine(table[2, 3])`
        let nl = Environment.NewLine
        Assert.Equal("10${nl}30${nl}20${nl}30${nl}14${nl}z${nl}key!${nl}23$nl", CompileAndRun(source))
    }

    @Fact
    func MultiParameterIndexers_SupportWritesAndCompoundAssignment() {
        let source = `package P
import System
import System.Collections.Generic

class Grid {
    private var cells []int32 = []int32{0, 0, 0, 0}
    prop this[index int32] int32 {
        get { return cells[index] }
        set { cells[index] = value }
    }
    prop this[row int32, column int32] int32 {
        get { return cells[row * 2 + column] }
        set { cells[row * 2 + column] = value }
    }
}

struct Buffer[T](items []T) {
    prop this[index int32] ref T -> items[index]
    prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
}

func next(log List[string], name string, value int32) int32 {
    log.Add(name)
    return value
}

let log = List[string]()
let g = Grid()
g[1] += 5
g[next(log, "row", 1), next(log, "column", 1)] = 7
g[next(log, "row", 1), next(log, "column", 1)] += 1
Console.WriteLine(g[1])
Console.WriteLine(g[3])
Console.WriteLine(g[1, 1])
Console.WriteLine(String.Join(",", log))
var buffer = Buffer[int32]([]int32{1, 2, 3})
buffer[1, true] = 9
buffer[0, false] += 10
Console.WriteLine(buffer[2])
Console.WriteLine(buffer[0])`
        let nl = Environment.NewLine
        Assert.Equal("5${nl}8${nl}8${nl}row,column,row,column${nl}9${nl}11$nl", CompileAndRun(source))
    }

    @Fact
    func MultiParameterIndexers_SupportPrefixAndPostfixIncrementDecrement() {
        // Review finding (#4350): `t[a, b]++` / `--` bind against the
        // multi-parameter indexer, evaluate the receiver and arguments once,
        // and a postfix form yields the element's previous value.
        let source = `package P
import System
import System.Collections.Generic

class Grid {
    var cells []int32 = []int32{0, 0, 0, 0}
    prop this[row int32, column int32] int32 {
        get { return cells[row * 2 + column] }
        set { cells[row * 2 + column] = value }
    }
}

struct Buffer[T](items []T) {
    prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
}

func next(log List[string], name string, value int32) int32 {
    log.Add(name)
    return value
}

let log = List[string]()
let g = Grid()
g[1, 1]++
g[next(log, "row", 1), next(log, "column", 1)]++
let before = g[1, 1]--
let pre = ++g[0, 1]
Console.WriteLine(String.Join(",", g.cells))
Console.WriteLine(before)
Console.WriteLine(pre)
Console.WriteLine(String.Join(",", log))
var buffer = Buffer[int32]([]int32{1, 2, 3})
let old = buffer[1, true]++
--buffer[0, false]
Console.WriteLine(old)
Console.WriteLine(String.Join(",", buffer[0, false], buffer[1, false], buffer[2, false]))`
        let nl = Environment.NewLine
        Assert.Equal("0,1,0,1${nl}2${nl}1${nl}row,column${nl}3${nl}0,2,4$nl", CompileAndRun(source))
    }

    @Fact
    func GenericParameterAndConcreteIndexerOverloads_DispatchBySignature() {
        // Review finding: a `this[key T]` parameter has no reflected CLR type,
        // so it must not match any same-arity overload — `this[index int32]`
        // and `this[key T]` each dispatch to their own accessor.
        let source = `package P
import System

class Lookup[T] {
    prop this[key T] string -> "key:" + key.ToString()
    prop this[index int32] string -> "index:" + index.ToString()
}

func probe[U](lookup Lookup[U], key U) string -> lookup[key] + "|" + lookup[1]

let lookup = Lookup[string]()
Console.WriteLine(lookup["a"])
Console.WriteLine(lookup[2])
Console.WriteLine(probe(lookup, "b"))
Console.WriteLine(probe(Lookup[bool](), true))`
        Assert.Equal(
            string.Join(Environment.NewLine, "key:a", "index:2", "key:b|index:1", "key:True|index:1") +
                Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func RefGetterCompoundAssignment_CallsGetterOnce() {
        // Review finding: without a setter, a compound assignment writes
        // through the ref getter; it must call that getter exactly once so a
        // side-effecting getter reads and writes the same element.
        let source = `package P
import System

class Counter {
    shared {
        var Calls int32 = 0
    }
}

struct Cells {
    private let items []int32

    init(items []int32) {
        this.items = items
    }

    prop this[index int32] ref int32 {
        get {
            Counter.Calls += 1
            return ref items[index + Counter.Calls - 1]
        }
    }

    prop this[index int32, offset int32] ref int32 {
        get {
            Counter.Calls += 1
            return ref items[index + offset + Counter.Calls - 1]
        }
    }
}

let values = []int32{10, 20, 30}
var cells = Cells(values)
cells[0] += 5
Console.WriteLine(Counter.Calls)
Console.WriteLine(String.Join(",", values))
cells[1]++
cells[0] -= 1
Console.WriteLine(Counter.Calls)
Console.WriteLine(String.Join(",", values))
Counter.Calls = 0
cells[0, 1] += 100
Console.WriteLine(Counter.Calls)
Console.WriteLine(String.Join(",", values))`
        Assert.Equal(
            string.Join(Environment.NewLine, "1", "15,20,30", "3", "15,20,30", "1", "15,120,30") + Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func NestedGenericIndexerOverloads_DispatchBySignature() {
        // Review finding: a nested type in a generic outer type flattens the
        // outer generic parameters first, so `Inner[U]`'s `U` is CLR position
        // 1; accessor matching must use that flattened position.
        let source = `package P
import System

class Outer[T] {
    class Inner[U] {
        prop this[key U] string -> "key:" + key.ToString()
        prop this[index int32] string -> "index:" + index.ToString()
    }

    func Make() Inner[bool] -> Inner[bool]()

    func Read(inner Inner[bool]) string -> inner[true] + "|" + inner[3]
}

let outer = Outer[string]()
let inner = outer.Make()
Console.WriteLine(inner[true])
Console.WriteLine(inner[3])
Console.WriteLine(outer.Read(inner))`
        Assert.Equal(
            string.Join(Environment.NewLine, "key:True", "index:3", "key:True|index:3") + Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func OptionalIndexerParameters_TakeDeclaredDefaults() {
        // Review note: an indexer parameter may be optional, as in C#. The
        // default used to be dropped silently; it now binds, fills omitted
        // arguments for reads and writes, and is emitted to metadata.
        let source = `package P
import System

class Table {
    var cells []string = []string{"", "", "", "", "", ""}

    prop this[row int32, column int32 = 1] string {
        get { return row.ToString() + ":" + column.ToString() + "=" + cells[row * 3 + column] }
        set { cells[row * 3 + column] = value }
    }
}

let t = Table()
t[1] = "a"
t[0, 2] = "b"
t[1] += "!"
Console.WriteLine(t[1])
Console.WriteLine(t[0, 2])
let column = typeof(Table).GetProperty("Item")!!.GetIndexParameters()[1]
Console.WriteLine(column.IsOptional.ToString() + " " + column.DefaultValue!!.ToString())`
        Assert.Equal(
            string.Join(Environment.NewLine, "1:1=1:1=a!", "0:2=b", "True 1") + Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func IndexersInheritedFromConstructedBases_KeepTypeArguments() {
        // Review finding: `interface IDerived : IBase[int32]` must expose
        // `IBase[T].this[T]` as `this[int32]`, and the call must be emitted
        // against the constructed base (`IBase<int32>`), not the open one.
        let source = `package P
import System

interface IBase[T] {
    prop this[key T] string { get; }
}

interface IDerived : IBase[int32] {
}

interface IView[U] : IBase[U] {
}

class Impl : IDerived {
    prop this[key int32] string -> "impl:" + key.ToString()
}

class Words : IView[string] {
    prop this[key string] string -> "word:" + key
}

open class Base[T] {
    var last string = ""
    prop this[key T] string {
        get { return "base:" + key.ToString() + last }
        set { last = "/" + value }
    }
}

class Derived : Base[int32] {
}

let d IDerived = Impl()
Console.WriteLine(d[1])
let v IView[string] = Words()
Console.WriteLine(v["a"])
let b = Derived()
b[2] = "x"
Console.WriteLine(b[2])`
        Assert.Equal(
            string.Join(Environment.NewLine, "impl:1", "word:a", "base:2/x") + Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func InheritedSystemIndexIndexer_FromConstructedBase() {
        // Review note: a `this[System.Index]` indexer inherited from a
        // constructed base (`Words : Base[string]`) receives `^n` and saved
        // Index values, called on the receiver viewed as `Base<string>`.
        let source = `package P
import System

open class Base[T] {
    var items []T
    init(items []T) {
        this.items = items
    }
    prop this[index int32] T -> items[index]
    prop this[index Index] T -> items[index.GetOffset(items.Length)]
}

class Words : Base[string] {
    init(items []string) : base(items) {
    }
}

let w = Words([]string{"a", "b", "c"})
Console.WriteLine(w[^1] + w[0] + w[(^2)])
let last = ^3
Console.WriteLine(w[last])`
        Assert.Equal(string.Join(Environment.NewLine, "cab", "a") + Environment.NewLine, CompileAndRun(source))
    }

    @Fact
    func NullableIndexerParameters_ResolveTheirOwnAccessors() {
        // Review finding: a nullable value-type index parameter reflects as
        // `Nullable<X>` while its symbol's CLR type is the underlying `X`;
        // accessor matching must unwrap it rather than miss the accessor.
        let source = `package P
import System

class Table {
    prop this[key int32?] string -> if key == nil { "nil-int" } else { "int:" + key!!.ToString() }
    prop this[key string?] string -> if key == nil { "nil-string" } else { "string:" + key!! }
    prop this[key int32?, scale int32] string -> "scaled:" + (key ?? 0 * scale).ToString()
}

let t = Table()
let none int32? = nil
Console.WriteLine(t[none])
Console.WriteLine(t[3])
Console.WriteLine(t["x"])
Console.WriteLine(t[none, 2])`
        Assert.Equal(
            string.Join(Environment.NewLine, "nil-int", "int:3", "string:x", "scaled:0") + Environment.NewLine,
            CompileAndRun(source)
        )
    }

    @Fact
    func OverloadedIndexers_EmitOneItemPropertyPerSignature() {
        let libraryPath = EmitGSharpLibrary("Shape", Library)
        let assembly = EmittedFixture.Load(libraryPath)
        let table = assembly.GetTypes().Single((t Type) -> t.Name == "Table")
        let tableIndexers = table
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where((p PropertyInfo) -> p.Name == "Item")
            .Select(
            (p PropertyInfo) -> string.Join(
                ",",
                p.GetIndexParameters().Select((i ParameterInfo) -> i.ParameterType.Name)
            )
        )
            .OrderBy((s string) -> s, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal([]string{"Int32", "Int32,Int32", "String"}, tableIndexers)
        Assert.Equal("Item", table.GetCustomAttribute[DefaultMemberAttribute]()?.MemberName)
        let buffer = assembly.GetTypes().Single((t Type) -> t.Name.StartsWith("Buffer", StringComparison.Ordinal))
        let bufferIndexers = buffer
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where((p PropertyInfo) -> p.Name == "Item")
            .ToArray()
        Assert.Equal(3, bufferIndexers.Length)
        Assert.All(bufferIndexers, (p PropertyInfo) -> Assert.True(p.PropertyType.IsByRef))
    }

    @Fact
    func CSharpConsumer_SelectsEachOverload() {
        let libraryPath = EmitGSharpLibrary("Consumer", Library)
        let consumerPath = EmitCSharpConsumer("Consumer", `public static class Probe
{
    public static string Run()
    {
        var table = new Lib.Table();
        table[0] = "q";
        var buffer = Lib.Buffer<int>.Of(new[] { 1, 2, 3 });
        buffer[^1] = 8;
        return table[0] + table["x"] + table[4, 2] + buffer[0] + buffer[2] + buffer[1, true];
    }
}`, libraryPath)
        let assemblies = EmittedFixture.LoadTogether(libraryPath, consumerPath)
        let probe = assemblies[1].GetType("Probe", throwOnError: true)!!
        let result object? = probe.GetMethod("Run")!!.Invoke(nil, nil)
        Assert.Equal("qx!42188", result)
    }

    shared {
        private const Library string = `package Lib
import System

struct Buffer[T](items []T) {
    prop this[index int32] ref T -> items[index]
    prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
    prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]

    shared {
        func Of(items []T) Buffer[T] -> Buffer[T](items)
    }
}

class Table {
    private var values []string = []string{"a", "b", "c"}
    prop this[index int32] string {
        get { return values[index] }
        set { values[index] = value }
    }
    prop this[name string] string {
        get { return name + "!" }
    }
    prop this[row int32, column int32] int32 -> row * 10 + column
}`

        private func EmitGSharpLibrary(caseName string, source string) string {
            let assemblyPath = Path.Combine(LibraryDirectory(), "Issue4350Indexers." + caseName + ".dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            {
                using let peStream = File.Create(assemblyPath)
                let result = compilation.Emit(
                    peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue4350Indexers." + caseName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(assemblyPath)
            return assemblyPath
        }

        private func EmitCSharpConsumer(caseName string, source string, libraryPath string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let consumerPath = Path.Combine(outputDir, "Issue4350IndexerConsumer.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .Append(MetadataReference.CreateFromFile(libraryPath))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Issue4350IndexerConsumer",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(consumerPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            return consumerPath
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue4350IndexerOverloads")
            Directory.CreateDirectory(dir)
            return dir
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_indexers_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
