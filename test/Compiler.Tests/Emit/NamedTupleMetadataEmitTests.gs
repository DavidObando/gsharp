// <copyright file="NamedTupleMetadataEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.ObjectModel
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// ADR-0172 Phase B: gsc synthesizes
/// `[System.Runtime.CompilerServices.TupleElementNamesAttribute]` on
/// tuple-typed parameters, returns, fields, and properties (the C# flattened
/// pre-order encoding), and decodes it when importing referenced assemblies,
/// so element names survive the CLR boundary in both directions. The blob's
/// C#-compatibility witness is the cross-assembly round trip: a consumer
/// compiled against the emitted metadata resolves `pos.line` — before
/// Phase B that access was GS0158 and the attribute rows did not exist.
open class NamedTupleMetadataEmitTests {
    @Fact
    func ReturnAndParameter_CarryTupleElementNames() {
        let assembly = CompileToAssembly(`package P

class Locator {
    shared {
        func Find() (line int32, column int32) {
            return 3, 5
        }

        func Sum(pos (line int32, column int32)) int32 {
            return pos.line + pos.column
        }
    }
}`)
        let locator = assembly.GetTypes().Single((t Type) -> t.Name == "Locator")
        let find = locator.GetMethod("Find")!!
        Assert.Equal([]string{"line", "column"}, ReadNames(find.ReturnParameter))
        let sum = locator.GetMethod("Sum")!!
        Assert.Equal([]string{"line", "column"}, ReadNames(sum.GetParameters()[0]))
    }

    @Fact
    func UnnamedTuple_OmitsAttribute() {
        let assembly = CompileToAssembly(`package P

class Plain {
    shared {
        func Pair() (int32, int32) {
            return 1, 2
        }
    }
}`)
        let pair = assembly.GetTypes().Single((t Type) -> t.Name == "Plain").GetMethod("Pair")!!
        Assert.Null(FindAttribute(pair.ReturnParameter))
    }

    @Fact
    func NestedGenericAndPartialNames_FlattenedPreOrder() {
        let assembly = CompileToAssembly(`package P
import System.Collections.Generic

class Store {
    shared {
        func All() List[(line int32, string)] {
            return List[(line int32, string)]()
        }
    }
}`)
        let all = assembly.GetTypes().Single((t Type) -> t.Name == "Store").GetMethod("All")!!
        // The List itself contributes no entries; the tuple argument
        // contributes its two logical positions, null where unnamed.
        Assert.Equal([]string? {"line", nil}, ReadNames(all.ReturnParameter))
    }

    @Fact
    func LongTuples_MatchRoslynNamesAndPhysicalSignatures() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let shapes = List[(Gs string, Cs string)]()
        for arity in[]int32{7, 8, 9, 14, 15} {
            shapes.Add(
                (
                    "(" + string.Join(", ", Enumerable.Range(1, arity).Select((i int32) -> "E$i int32")) + ")",
                    "(" + string.Join(", ", Enumerable.Range(1, arity).Select((i int32) -> "int E$i")) + ")"
                )
            )
        }
        shapes.Add(
            (
                "(Head (X int32, Y int32), B int32, C int32, D int32, E int32, F int32, G int32, H int32)",
                "((int X, int Y) Head, int B, int C, int D, int E, int F, int G, int H)"
            )
        )
        shapes.Add(
            (
                "(A int32, B int32, C int32, D int32, E int32, F int32, G int32, Tail (X int32, Y int32))",
                "(int A, int B, int C, int D, int E, int F, int G, (int X, int Y) Tail)"
            )
        )
        shapes.Add(
            (
                "System.Collections.Generic.Dictionary[(A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32), (X int32, Y int32)]",
                "System.Collections.Generic.Dictionary<(int A, int B, int C, int D, int E, int F, int G, int H), (int X, int Y)>"
            )
        )
        shapes.Add(
            (
                "(int32, int32, int32, int32, int32, int32, int32, (X int32, Y int32))",
                "(int, int, int, int, int, int, int, (int X, int Y))"
            )
        )
        for var i = 0; i < shapes.Count; i++ {
            let shape = shapes[i]
            let gs = fixture.Compile(`public class Export {
    public var Field ` + shape.Gs + `
    public prop Value ` + shape.Gs + ` { get; set; }
    public func Echo(value ` + shape.Gs + `) ` + shape.Gs + ` -> value
}`, "TupleExport$i", false)
            let cs = fixture.CompileCSharp(`public class Export {
    public ` + shape.Cs + ` Field;
    public ` + shape.Cs + ` Value { get; set; }
    public ` + shape.Cs + ` Echo(` + shape.Cs + ` value) => value;
}`, "RoslynTupleControl$i")
            IlVerifier.Verify(gs)
            IlVerifier.Verify(cs)
            let actual = EmittedFixture.Load(gs).GetType("Default.Export")!!
            let expected = EmittedFixture.Load(cs).GetType("Export")!!
            let actualEcho = actual.GetMethod("Echo")!!
            let expectedEcho = expected.GetMethod("Echo")!!
            Assert.Equal(expectedEcho.ReturnType.ToString(), actualEcho.ReturnType.ToString())
            Assert.Equal(ReadNames(expectedEcho.ReturnParameter), ReadNames(actualEcho.ReturnParameter))
            Assert.Equal(ReadNames(expectedEcho.GetParameters()[0]), ReadNames(actualEcho.GetParameters()[0]))
            Assert.Equal(ReadNames(expected.GetField("Field")!!), ReadNames(actual.GetField("Field")!!))
            Assert.Equal(ReadNames(expected.GetProperty("Value")!!), ReadNames(actual.GetProperty("Value")!!))
        }
    }

    @Fact
    func EightElementExport_IsReadableByCSharp() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`public class Plain {
    public func Get() (A int32, B int32, C int32, D int32, E int32, F int32, G int32, H int32) -> (1,2,3,4,5,6,7,8)
}`, "Default", false)
        IlVerifier.Verify(library)
        let consumer = fixture.CompileCSharp(`public class Reader {
    public static int Read() => new Default.Plain().Get().H;
}`, "Reader", library)
        IlVerifier.Verify(consumer, additionalReferences: []string{library})
        Assert.Equal(8, EmittedFixture.Load(consumer).GetType("Reader")!!.GetMethod("Read")!!.Invoke(nil, nil))
    }

    @Fact
    func RoslynLongTuple_WithFollowingTuple_KeepsImportedNames() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace TupleContracts;
public class Contract {
    public static ((int A, int B, int C, int D, int E, int F, int G, int H) Long, (int X, int Y) Next) Get()
        => ((1,2,3,4,5,6,7,8), (9,10));
}`, "RoslynLongTupleContract")
        IlVerifier.Verify(library)
        let consumer = fixture.Compile(`import System
import TupleContracts
let result = Contract.Get()
Console.Write(result.Long.H)
Console.Write(result.Next.X)
Console.Write(result.Next.Y)`, "tuple-import", true, "/reference:" + library)
        IlVerifier.Verify(consumer, additionalReferences: []string{library})
        Assert.Equal("8910", fixture.Run(consumer))
    }

    @Fact
    func FieldAndProperty_CarryTupleElementNames() {
        let assembly = CompileToAssembly(`package P

class Holder {
    var Position (line int32, column int32)
    prop Origin (x int32, y int32) -> (0, 0)
}`)
        let holder = assembly.GetTypes().Single((t Type) -> t.Name == "Holder")
        let field FieldInfo? = holder.GetField(
            "Position",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        if field != nil {
            Assert.Equal([]string{"line", "column"}, ReadNames(field))
        }
        let property = holder.GetProperty("Origin")!!
        Assert.Equal([]string{"x", "y"}, ReadNames(property))
    }

    @Fact
    func GsToGsRoundTrip_NameAccessAcrossAssemblies() {
        // The full loop: names emitted by gsc, read back by gsc's importer.
        let libSource = `package NamedLib
import System.Collections.Generic

class Locator {
    shared {
        func Find() (line int32, column int32) {
            return 3, 5
        }

        func FindAll() List[(line int32, column int32)] {
            let all = List[(line int32, column int32)]()
            all.Add((1, 2))
            all.Add((3, 4))
            return all
        }
    }
}`
        let appSource = `package App
import System
import NamedLib

let pos = Locator.Find()
Console.WriteLine(pos.line)
Console.WriteLine(pos.column)
Console.WriteLine(Locator.FindAll()[1].line)`
        let output = CompileAndRunWithLibrary(libSource, appSource)
        Assert.Equal("3${Environment.NewLine}5${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func GsToGsRoundTrip_AwaitedTaskOfNamedTuple_KeepsNames() {
        // The imported awaitable arrives wrapped in nullability metadata
        // (NullabilityAnnotatedTypeSymbol); the await element derivation must
        // unwrap to the symbolic Task so `t.line` still binds — and the
        // nullable named tuple (`(line int32, gitRef string?)?`) must survive
        // an if-let unwrap of the awaited value.
        let libSource = `package NamedAsyncLib
import System.Threading.Tasks

class Fetcher {
    shared {
        async func Find() (line int32, column int32) {
            await Task.Delay(1)
            return (3, 5)
        }

        async func TryFind(ok bool) (line int32, gitRef string?)? {
            await Task.Delay(1)
            if ok {
                return (7, "main")
            }

            return nil
        }
    }
}`
        let appSource = `package App
import System
import NamedAsyncLib

async func run() {
    let t = await Fetcher.Find()
    Console.WriteLine(t.line)
    if let r = await Fetcher.TryFind(true) {
        Console.WriteLine(r.line)
        Console.WriteLine(r.gitRef)
    }
}

run().Wait()`
        let output = CompileAndRunWithLibrary(libSource, appSource, libraryName: "NamedAsyncLib")
        Assert.Equal("3${Environment.NewLine}7${Environment.NewLine}main${Environment.NewLine}", output)
    }

    /// Issue #4772: G#-emitted Task and ValueTask tuple return labels survive
    /// cross-assembly import across interface, generic-interface, generic-method,
    /// property, field, and synthesized Deconstruct signatures.
    @Fact
    func Issue4772_GsToGsRoundTrip_TaskAndValueTaskTupleReturnLabels_SurviveCrossAssemblyAndSymbolicProjections() {
        let libSource = `package TupleLabelProducer
import System
import System.Threading.Tasks

interface IRows {
    func Read() Task[(Required string, Code int32)];
    func ReadValue() ValueTask[(Required string, Code int32)];
}

interface IRows[T] {
    func Read() Task[(Required string, Code int32)];
    func ReadItem() Task[(Required T, Code int32)];
    func ReadValueItem() ValueTask[(Required T, Code int32)];
    func ReadEightItem() Task[(First T, B int32, C int32, D int32, E int32, F int32, G int32, H T)];
    prop Current Task[(Required string, Code int32)] { get; }
    prop CurrentItem Task[(Required T, Code int32)] { get; }
}

interface IGenericMethodRows {
    func Read[T]() Task[(Required string, Code int32)];
    func ReadItem[T]() Task[(Required T, Code int32)];
    func ReadValueItem[T]() ValueTask[(Required T, Code int32)];
    func ReadTwo[T]() Task[(First T, Second (Label string, Num int32))];
    func ReadEight[T](seed T) Task[(First T, B int32, C int32, D int32, E int32, F int32, G int32, H T)];
    func ReadDirectEight[T](seed T) (First T, B int32, C int32, D int32, E int32, F int32, G int32, H T);
    func ReadRefTuple[T](seed T) Tuple[T, (Label int32, Code int32)];
}

class RowBox[T] {
    var Field Task[(Required T, Code int32)]

    init(field Task[(Required T, Code int32)]) {
        Field = field
    }
}

data class RowData(Pair (Required string, Code int32), Count int32)

inline struct InlineRow(Pair (Required string, Code int32))

class RowsImpl : IRows, IRows[string], IGenericMethodRows {
    func Read() Task[(Required string, Code int32)] -> Task.FromResult[(Required string, Code int32)](("plain", 10))
    func ReadValue() ValueTask[(Required string, Code int32)] -> ValueTask[(Required string, Code int32)](("vplain", 11))
    func ReadItem() Task[(Required string, Code int32)] -> Task.FromResult[(Required string, Code int32)](("item", 12))
    func ReadValueItem() ValueTask[(Required string, Code int32)] -> ValueTask[(Required string, Code int32)](("vitem", 13))
    func ReadEightItem() Task[(First string, B int32, C int32, D int32, E int32, F int32, G int32, H string)] -> Task.FromResult[(First string, B int32, C int32, D int32, E int32, F int32, G int32, H string)](("e1", 2, 3, 4, 5, 6, 7, "e8"))
    prop Current Task[(Required string, Code int32)] -> Task.FromResult[(Required string, Code int32)](("cur", 14))
    prop CurrentItem Task[(Required string, Code int32)] -> Task.FromResult[(Required string, Code int32)](("curitem", 15))
    func Read[T]() Task[(Required string, Code int32)] -> Task.FromResult[(Required string, Code int32)](("gm", 16))
    func ReadItem[T]() Task[(Required T, Code int32)] -> Task.FromResult[(Required T, Code int32)]((default(T), 17))
    func ReadValueItem[T]() ValueTask[(Required T, Code int32)] -> ValueTask[(Required T, Code int32)]((default(T), 18))
    func ReadTwo[T]() Task[(First T, Second (Label string, Num int32))] -> Task.FromResult[(First T, Second (Label string, Num int32))]((default(T), ("lbl", 19)))
    func ReadEight[T](seed T) Task[(First T, B int32, C int32, D int32, E int32, F int32, G int32, H T)] -> Task.FromResult[(First T, B int32, C int32, D int32, E int32, F int32, G int32, H T)]((seed, 2, 3, 4, 5, 6, 7, seed))
    func ReadDirectEight[T](seed T) (First T, B int32, C int32, D int32, E int32, F int32, G int32, H T) -> (seed, 2, 3, 4, 5, 6, 7, seed)
    func ReadRefTuple[T](seed T) Tuple[T, (Label int32, Code int32)] -> Tuple[T, (Label int32, Code int32)](seed, (21, 22))
}`
        let appSource = `package TupleLabelConsumer
import System
import System.Threading.Tasks
import TupleLabelProducer

class LocalType {
    var Tag string = "loc"
}

shared class Consumer[U] {
    func ReadPlain(rows IRows) string -> rows.Read().GetAwaiter().GetResult().Required
    async func AwaitPlain(rows IRows) Task[string] -> (await rows.Read()).Required + "|" + (await rows.ReadValue()).Required
    func ReadGenericPlain(rows IRows[U]) string -> rows.Read().GetAwaiter().GetResult().Required
    func ReadGenericItem(rows IRows[U]) U -> rows.ReadItem().GetAwaiter().GetResult().Required
    async func AwaitGenericValueItem(rows IRows[U]) Task[int32] -> (await rows.ReadValueItem()).Code
    func ReadNullableItem(rows IRows[string?]) int32 -> rows.ReadItem().GetAwaiter().GetResult().Code
    func ReadLocalItem(rows IRows[LocalType]) int32 -> rows.ReadItem().GetAwaiter().GetResult().Code
    func ReadMethodItem(rows IGenericMethodRows) int32 -> rows.ReadItem[U]().GetAwaiter().GetResult().Code
    async func AwaitMethodValueItem(rows IGenericMethodRows) Task[int32] -> (await rows.ReadValueItem[U]()).Code
    func ReadMethodNullable(rows IGenericMethodRows) int32 -> rows.ReadItem[string?]().GetAwaiter().GetResult().Code
    func ReadMethodLocal(rows IGenericMethodRows) int32 -> rows.ReadItem[LocalType]().GetAwaiter().GetResult().Code
    func ReadPropItem(rows IRows[U]) U -> rows.CurrentItem.GetAwaiter().GetResult().Required
    func ReadBoxField(box RowBox[U]) U -> box.Field.GetAwaiter().GetResult().Required
    func ReadNestedTupleArg(rows IGenericMethodRows) string {
        let res = rows.ReadTwo[(InnerA string, InnerB int32)]().GetAwaiter().GetResult()
        return res.Second.Label + ":" + res.First.InnerB.ToString()
    }
    func ReadEightReceiver(rows IRows[U])(U, U) {
        let res = rows.ReadEightItem().GetAwaiter().GetResult()
        return (res.First, res.H)
    }
    func ReadEightMethod(rows IGenericMethodRows, seed U)(U, U, int32) {
        let taskRes = rows.ReadEight[U](seed).GetAwaiter().GetResult()
        let directRes = rows.ReadDirectEight[U](seed)
        return (taskRes.First, directRes.H, taskRes.G + directRes.B)
    }
    func ReadRefTupleMethod(rows IGenericMethodRows, seed U)(Tuple[U, (Label int32, Code int32)], U, int32) {
        let refTuple Tuple[U, (Label int32, Code int32)] = rows.ReadRefTuple[U](seed)
        return (refTuple, refTuple.Item1, refTuple.Item2.Label + refTuple.Item2.Code)
    }
    func ReadDeconstructed(data RowData, inlineRow InlineRow) string {
        var count = 0
        data.Deconstruct(out var p1, out count)
        inlineRow.Deconstruct(out var p2)
        return p1.Required + ":" + p2.Required + ":" + count.ToString()
    }
}

let impl = RowsImpl()
Console.WriteLine(Consumer[string].ReadPlain(impl))
Console.WriteLine(Consumer[string].AwaitPlain(impl).GetAwaiter().GetResult())
Console.WriteLine(Consumer[string].ReadGenericPlain(impl))
Console.WriteLine(Consumer[string].ReadGenericItem(impl))
Console.WriteLine(Consumer[string].AwaitGenericValueItem(impl).GetAwaiter().GetResult())
Console.WriteLine(Consumer[string].ReadMethodItem(impl))
Console.WriteLine(Consumer[string].AwaitMethodValueItem(impl).GetAwaiter().GetResult())
Console.WriteLine(Consumer[string].ReadPropItem(impl))
let box = RowBox[string](Task.FromResult[(Required string, Code int32)](("boxed", 20)))
Console.WriteLine(Consumer[string].ReadBoxField(box))
Console.WriteLine(Consumer[string].ReadNestedTupleArg(impl))
let (r8First, r8H) = Consumer[string].ReadEightReceiver(impl)
Console.WriteLine("$r8First:$r8H")
let (m8First, m8H, m8Sum) = Consumer[string].ReadEightMethod(impl, "eight")
Console.WriteLine("$m8First:$m8H:$m8Sum")
let (rt, rtItem1, rtSum) = Consumer[string].ReadRefTupleMethod(impl, "ref")
Console.WriteLine("${rt.GetType().Name}:$rtItem1:$rtSum")
Console.WriteLine(Consumer[string].ReadDeconstructed(RowData(("d1", 1), 5), InlineRow(("d2", 2))))`
        let output = CompileAndRunWithLibrary(libSource, appSource, libraryName: "TupleLabelProducer")
        let lines = output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal(
            []string{
                "plain",
                "plain|vplain",
                "plain",
                "item",
                "13",
                "17",
                "18",
                "curitem",
                "boxed",
                "lbl:0",
                "e1:e8",
                "eight:eight:9",
                "Tuple`2:ref:43",
                "d1:d2:5"
            },
            lines
        )
    }

    shared {
        private func ReadNames(provider ICustomAttributeProvider)[]string? {
            let data CustomAttributeData? = FindAttribute(provider)
            Assert.NotNull(data)
            let arg = Assert.Single(data!!.ConstructorArguments)
            return (cast[ReadOnlyCollection[CustomAttributeTypedArgument]](arg.Value)).Select(
                (v CustomAttributeTypedArgument) -> cast[string](v.Value)
            )
                .ToArray()
        }

        private func FindAttribute(provider ICustomAttributeProvider) CustomAttributeData? {
            let attrs = switch provider {
                case member is MemberInfo: member.GetCustomAttributesData()
                case parameter is ParameterInfo: parameter.GetCustomAttributesData()
                default: throw InvalidOperationException("unexpected provider")
            }
            return attrs.FirstOrDefault(
                (d CustomAttributeData) -> d
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
            )
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_ntuple_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            RunGsc([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileAndRunWithLibrary(
            libSource string,
            appSource string,
            libraryName string = "namedlib"
        ) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_ntuple_rt_").FullName
            try {
                let libSrc = Path.Combine(tempDir, "lib.gs")
                let libDll = Path.Combine(tempDir, libraryName + ".dll")
                let appSrc = Path.Combine(tempDir, "app.gs")
                let appDll = Path.Combine(tempDir, "app.dll")
                File.WriteAllText(libSrc, libSource)
                File.WriteAllText(appSrc, appSource)
                RunGsc([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                IlVerifier.Verify(libDll)
                RunGsc(
                    []string{
                        "/out:" + appDll,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libDll,
                        appSrc
                    }
                )
                IlVerifier.Verify(appDll, additionalReferences: []string{libDll})
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(appDll, ".runtimeconfig.json"))
                psi.ArgumentList.Add(appDll)
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

        private func RunGsc(args[]string) {
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
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
