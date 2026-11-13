// <copyright file="Issue3627VariadicCarrierEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic
import System.Diagnostics
import System.Text
import System.Text.RegularExpressions

/// ADR-0173 / issue #3627: a variadic parameter with a non-array carrier
/// (`...List[T]`, `...ReadOnlySpan[T]`, …) emits the carrier as
/// the CLR parameter type and stamps C#13's
/// `[ParamCollectionAttribute]`, so C# consumers see exactly
/// `params X<T>`; the array family keeps
/// `[ParamArrayAttribute]`. Runtime behavior is pinned end to end
/// (verified IL, expanded packing, pass-through).
open class Issue3627VariadicCarrierEmitTests {
    @Fact
    func CarrierParameters_EmitCollectionAttributeAndCarrierSignature() {
        let assembly = CompileToAssembly(`package P
import System
import System.Collections.Generic

class Totals {
    shared {
        func Span(values ...ReadOnlySpan[int32]) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }

        func Lst(values ...List[int32]) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }

        func Seq(values ...IEnumerable[string]) int32 {
            var n = 0
            for v in values { n = n + v.Length }
            return n
        }

        func Classic(values ...int32) int32 {
            var t = 0
            for v in values { t = t + v }
            return t
        }
    }
}`)
        let totals = assembly.GetTypes().Single((t Type) -> t.Name == "Totals")
        AssertParam(totals, "Span", "ReadOnlySpan`1", "ParamCollectionAttribute")
        AssertParam(totals, "Lst", "List`1", "ParamCollectionAttribute")
        AssertParam(totals, "Seq", "IEnumerable`1", "ParamCollectionAttribute")
        AssertParam(totals, "Classic", "Int32[]", "ParamArrayAttribute")
        // Runtime witness through the List carrier (spans cannot box through
        // reflection): the pack really produced a List the body could Count.
        let lst = totals.GetMethod("Lst")!!
        Assert.Equal(9, lst.Invoke(nil, []object{List[int32]{4, 5}}))
    }

    @Fact
    func CarrierCalls_RunEndToEnd() {
        let output = CompileAndRun(`package P
import System
import System.Collections.Generic

func totalSpan(values ...ReadOnlySpan[int32]) int32 {
    var t = 0
    for v in values { t = t + v }
    return t
}

func totalList(values ...List[int32]) int32 {
    var t = 0
    for v in values { t = t + v }
    return t + values.Count
}

func run() {
    Console.WriteLine(totalSpan(1, 2, 3))
    Console.WriteLine(totalList(4, 5))
    let existing = List[int32]()
    existing.Add(10)
    Console.WriteLine(totalList(existing))
}

run()`)
        Assert.Equal(
            Encoding.UTF8.GetBytes("6${Environment.NewLine}11${Environment.NewLine}11${Environment.NewLine}"),
            output
        )
    }

    @Theory
    @InlineData("List", "Count")
    @InlineData("Span", "Length")
    @InlineData("ReadOnlySpan", "Length")
    func SourceElementCarriers_PreservePackingOrderIdentityAndNullability(carrier string, length string) {
        let output = CompileAndRun(`import System
import System.Collections.Generic

class Node { var Value int32 }
var order = 0
func make(value int32) Node {
    order = order * 10 + value
    let node = Node()
    node.Value = value
    return node
}
func count(items ...CARRIER[Node]) int32 -> items.LENGTH
func read(items ...CARRIER[Node]) int32 -> items[0].Value * 10 + items[1].Value
func nullable(items ...CARRIER[Node?]) int32 {
    var result = 0
    for item in items { if item == nil { result++ } }
    return result
}
let node = make(1)
func same(items ...CARRIER[Node]) bool -> object.ReferenceEquals(node, items[0])
Console.Write("${count()}:${count(node)}:${same(node)}:${read(make(2), make(3))}:${order}:${nullable(nil, node)}")
`.Replace("CARRIER", carrier).Replace("LENGTH", length))
        Assert.Equal(Encoding.UTF8.GetBytes("0:1:True:23:123:1"), output)
    }

    @Fact
    func SourceElementCarriers_NormalFormAndGenericCallersPreservePhysicalTypes() {
        let output = CompileAndRun(`import System
import System.Collections.Generic

class Node {}
struct Value { var Number int32 }
enum Code { First, Second }
class Box {
    var Count int32
    init(items ...List[Node]) { Count = items.Count }
    func Read(items ...List[Node]) int32 -> items.Count
    shared {
        func Keep(items ...List[Node]) List[Node] {
            items.Add(Node())
            return items
        }
        func Generic[T](items ...List[T]) int32 -> items.Count
    }
}
class Owner[T] {
    func Count(items ...List[T]) int32 -> items.Count
}
func values(items ...List[Value]) int32 -> items[0].Number
func codes(items ...List[Code]) int32 -> int32(items[0])
func nested(items ...List[List[Node]]) int32 -> items[0].Count
let node = Node()
let existing = List[Node]([]Node{node})
let kept = Box.Keep(existing)
let physical (List[Node]) -> List[Node] = Box.Keep
let delegated = physical(existing)
let box = Box(node, node)
let value = Value{Number: 7}
Console.Write("${object.ReferenceEquals(existing, kept)}:${object.ReferenceEquals(existing, delegated)}:${existing.Count}:${box.Count}:${box.Read(node)}:${Box.Generic[Node](node)}:${Owner[Node]().Count(node)}:${values(value)}:${codes(Code.Second)}:${nested(existing)}")
`)
        Assert.Equal(Encoding.UTF8.GetBytes("True:True:3:2:1:1:1:7:1:3"), output)
    }

    @Fact
    func SourceElementCarriers_MetadataNamesSourceElementRatherThanErasedObject() {
        let assembly = CompileToAssembly(`package P
import System.Collections.Generic
class Node {}
class Calls {
    shared {
        func Pack(items ...List[Node]) List[Node] -> items
        func Generic[T](items ...List[T]) int32 -> items.Count
        func Run() int32 -> Pack(Node()).Count + Generic[Node](Node())
    }
}`)
        let node = assembly.GetTypes().Single((t Type) -> t.Name == "Node")
        let calls = assembly.GetTypes().Single((t Type) -> t.Name == "Calls")
        let pack = calls.GetMethod("Pack")!!
        Assert.Equal(node, Assert.Single(Assert.Single(pack.GetParameters()).ParameterType.GetGenericArguments()))
        Assert.Equal(node, Assert.Single(pack.ReturnType.GetGenericArguments()))
        AssertParam(calls, "Pack", "List`1", "ParamCollectionAttribute")
        let generic = calls.GetMethod("Generic")!!
        Assert.Equal(
            Assert.Single(generic.GetGenericArguments()),
            Assert.Single(Assert.Single(generic.GetParameters()).ParameterType.GetGenericArguments())
        )
        Assert.Equal(2, calls.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Theory
    @InlineData("func count(items ...List[Node]) int32 -> items.Count\ncount(nil)", "(4,7,4,10): error GS0154:")
    @InlineData("func count(items ...List[Node]) int32 -> items.Count\ncount(\"wrong\")", "(4,7,4,14): error GS0154:")
    @InlineData("func read(items ...List[Node?]) Node -> items[0]\nread(nil)", "(3,41,3,49): error GS0155:")
    func SourceElementCarriers_RejectInvalidElementContracts(body string, diagnostic string) {
        let directory = Path.Combine(AppContext.BaseDirectory, "gs_vcarrier_reject_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "test.gs")
            let image = Path.Combine(directory, "test.dll")
            File.WriteAllText(source, "import System.Collections.Generic\nclass Node {}\n" + body)
            let result = Compile([]string{"/out:" + image, "/target:exe", "/targetframework:net10.0", source})
            Assert.Equal(1, result.Exit)
            Assert.False(File.Exists(image))
            Assert.Single(Regex.Matches(result.Log, "error GS[0-9]+:").Cast[Match]())
            Assert.Contains(diagnostic, result.Log)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func AssertParam(type Type, methodName string, expectedParamTypeName string, expectedAttribute string) {
            let parameter = type.GetMethod(methodName)!!.GetParameters()[0]
            Assert.Equal(
                expectedParamTypeName,
                parameter
                    .ParameterType
                    .Name +
                    (
                    if parameter.ParameterType.IsArray {
                        string.Empty
                    } else {
                        string.Empty
                    }
                )
            )
            Assert.Contains(
                parameter.GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType.Name == expectedAttribute
            )
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_vcarrier_emit_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            RunGsc([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileAndRun(source string)[]uint8 {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_vcarrier_run_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                RunGsc([]string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath})
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
                using let stdout = MemoryStream()
                let read = proc.StandardOutput.BaseStream.CopyToAsync(stdout)
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                read.GetAwaiter().GetResult()
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + Encoding.UTF8.GetString(stdout.ToArray()) + `
stderr:
` + "$stderr"))
                return stdout.ToArray()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunGsc(args[]string) {
            let result = Compile(args)
            Assert.True(result.Exit == 0, "gsc failed:\n" + result.Log)
        }

        private func Compile(args[]string)(Exit int32, Log string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, compileOut.ToString() + compileErr.ToString())
        }
    }
}
