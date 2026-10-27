// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import Gsharp.Values
import System
import System.IO
import System.Text
import Xunit
import Xunit.Abstractions

/// Product-driver witnesses for the ADR-0210 F2a copying foundations.
class FixedArrayCopyBridgeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        this.output = output
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AllLengthsCopyThroughIndependentImplementationAndReferenceContracts(referenceAssemblies bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let root = IlVerifier.FindRepoRoot()
        let referenceDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(referenceDirectory)
        let runtimeReference = Path.Combine(referenceDirectory, "Gsharp.Runtime.Values.dll")
        let runtimeSource = File.ReadAllText(
            Path.Combine(root, "src", "Sdk", "Gsharp.Runtime.Values", "FixedArrays.V1.gs")
        )
            .Replace(
            "@assembly: AssemblyMetadata",
            "@assembly: AssemblyVersion(\"0.5.0.0\")\n@assembly: AssemblyMetadata",
            StringComparison.Ordinal
        )
        let runtime = fixture.Compile(
            runtimeSource,
            "Gsharp.Runtime.Values",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + runtimeReference,
            Path.Combine(root, "src", "Sdk", "Gsharp.Runtime.Values", "FixedArrays.ClrArrayCopies.g.gs")
        )
        let owner = if referenceAssemblies {
            runtimeReference
        } else {
            runtime
        }
        let runtimeBytes = File.ReadAllBytes(runtime)
        let runtimeReferenceBytes = File.ReadAllBytes(runtimeReference)
        let producerReference = Path.Combine(referenceDirectory, "BridgeProducer.dll")
        let producer = fixture.Compile(
            Producer(),
            "BridgeProducer",
            false,
            "/assemblyname:BridgeProducer",
            "/reference:" + owner,
            "/refout:" + producerReference
        )
        let producerBytes = File.ReadAllBytes(producer)
        let foreignReference = Path.Combine(referenceDirectory, "BridgeForeign.dll")
        let foreign = fixture.CompileCSharpWithReference(Foreign(), "BridgeForeign", foreignReference)
        let foreignBytes = File.ReadAllBytes(foreign)
        let consumer = fixture.Compile(
            Consumer(),
            "BridgeConsumer",
            true,
            "/reference:" + owner,
            "/reference:" + if referenceAssemblies {
                producerReference
            } else {
                producer
            },
            "/reference:" + if referenceAssemblies {
                foreignReference
            } else {
                foreign
            }
        )
        fixture.Compile(
            runtimeSource,
            "Gsharp.Runtime.Values",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + runtimeReference,
            Path.Combine(root, "src", "Sdk", "Gsharp.Runtime.Values", "FixedArrays.ClrArrayCopies.g.gs")
        )
        Assert.Equal(runtimeBytes, File.ReadAllBytes(runtime))
        Assert.Equal(runtimeReferenceBytes, File.ReadAllBytes(runtimeReference))
        File.WriteAllBytes(producer, producerBytes)
        File.WriteAllBytes(foreign, foreignBytes)
        VerifyStrict(runtime)
        VerifyStrict(runtimeReference)
        VerifyStrict(producer, runtime)
        VerifyStrict(producerReference, runtime)
        VerifyStrict(foreign, runtime)
        VerifyStrict(foreignReference, runtime)
        VerifyStrict(consumer, runtime, producer, foreign)
        Assert.Equal(
            Encoding.UTF8.GetBytes("33 canonical shapes; checked faults/defaults; independent copies\n"),
            Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
    }

    @Fact
    func ExistingValueBoundariesAndRetainedRootsKeepTheirCopyAndStoreBehavior() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let consumer = fixture.Compile(Boundaries(), "BridgeBoundaries", true)
        VerifyStrict(consumer)
        Assert.Equal(
            Encoding.UTF8.GetBytes("value boundaries; existing destinations; descriptor sharing; defaults\n"),
            Encoding.UTF8.GetBytes(fixture.Run(consumer))
        )
    }

    private func VerifyStrict(path string, references ...string) {
        var report = string.Empty
        IlVerifier.Verify(
            path,
            references,
            report: (text string) -> {
                report = text
                this.output.WriteLine(text)
            }
        )
        Assert.Contains("ilverify invocation:", report, StringComparison.Ordinal)
        Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
        Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
    }

    shared {
        private func Carrier(length int32, element string = "T") string {
            if length < 2 {
                return (
                    if length == 0 {
                        "Empty"
                    } else {
                        "Leaf"
                    }
                ) +
                    "[" +
                    element +
                    "]"
            }
            let left = length / 2
            return "Branch[" + element + ", " + Carrier(left, element) + ", " + Carrier(length - left, element) + "]"
        }

        private func Producer() string {
            let source = StringBuilder(`package CopyProducer
import System.Reflection
import Gsharp.Values.FixedArrays.V1
@assembly: AssemblyMetadata("GSharp.FixedArrays", "1")
shared class Producer {
`)
            for var length = 0; length <= 32; length++ {
                let suffix = length.ToString()
                source.AppendLine(
                    "func Make" +
                        suffix +
                        "[T](array []T) " +
                        Carrier(length) +
                        " -> ClrArrayCopies.FromArray" +
                        suffix +
                        "(array)"
                )
                source.AppendLine(
                    "func Copy" +
                        suffix +
                        "[T](value " +
                        Carrier(length) +
                        ") []T -> ClrArrayCopies.ToArray" +
                        suffix +
                        "(value)"
                )
            }
            return source.AppendLine("}").ToString()
        }

        private func Consumer() string {
            let source = StringBuilder(`package CopyConsumer
import System
import CopyProducer
import CopyForeign
import Gsharp.Values.FixedArrays.V1
func Main() {
`)
            for var length = 0; length <= 32; length++ {
                let n = length.ToString()
                source.AppendLine("let source" + n + " = Foreign.Values(" + n + ")")
                source.AppendLine("let value" + n + " = Producer.Make" + n + "(source" + n + ")")
                source.AppendLine("Foreign.Expect(value" + n + ", " + n + ")")
                if length != 0 {
                    source.AppendLine("source" + n + "[0] = -1")
                    source.AppendLine("Foreign.Expect(value" + n + ", " + n + ")")
                }
                source.AppendLine(
                    "let canonical" + n + " = cast[" + Carrier(length, "int32") + "](Foreign.Make(" + n + "))"
                )
                source.AppendLine("let output" + n + " = Producer.Copy" + n + "(canonical" + n + ")")
                source.AppendLine("Foreign.ExpectArray(output" + n + ", " + n + ")")
                source.AppendLine(
                    "Foreign.Require(!Object.ReferenceEquals(output" +
                        n +
                        ", Producer.Copy" +
                        n +
                        "(canonical" +
                        n +
                        ")))"
                )
            }
            return source.AppendLine(`Foreign.CheckedFaultsAndDefaults()
Console.WriteLine("33 canonical shapes; checked faults/defaults; independent copies")
}`).ToString()
        }

        private func Foreign() string {
            let source = StringBuilder(`
using System;
using System.Collections.Generic;
using System.Linq;
using Gsharp.Values.FixedArrays.V1;
namespace CopyForeign {
public struct Constructed {
    public static int Calls;
    public int Value;
    public Constructed() { Calls++; Value = 91; }
}
public static class Foreign {
    public static void Require(bool condition) {
        if (!condition) throw new Exception("independent fixed-array copy oracle");
    }
    public static int[] Values(int length) =>
        Enumerable.Range(0, length).Select(i => length * 100 + i).ToArray();
    private static IEnumerable<int> Flatten(object value) {
        var type = value.GetType();
        var definition = type.GetGenericTypeDefinition();
        if (definition == typeof(Empty<>)) yield break;
        if (definition == typeof(Leaf<>)) {
            yield return (int)type.GetField("Item")!.GetValue(value)!;
            yield break;
        }
        Require(definition == typeof(Branch<,,>));
        foreach (var item in Flatten(type.GetField("Left")!.GetValue(value)!)) yield return item;
        foreach (var item in Flatten(type.GetField("Right")!.GetValue(value)!)) yield return item;
    }
    public static void Expect(object value, int length) =>
        Require(Flatten(value).SequenceEqual(Values(length)));
    public static void ExpectArray(int[] value, int length) =>
        Require(value.SequenceEqual(Values(length)));
    private static Type Shape(int length) {
        if (length == 0) return typeof(Empty<int>);
        if (length == 1) return typeof(Leaf<int>);
        return typeof(Branch<,,>).MakeGenericType(typeof(int), Shape(length / 2), Shape(length - length / 2));
    }
    private static object Fill(Type type, int[] values, ref int index) {
        var value = Activator.CreateInstance(type)!;
        if (type.GetGenericTypeDefinition() == typeof(Leaf<>))
            type.GetField("Item")!.SetValue(value, values[index++]);
        else if (type.GetGenericTypeDefinition() == typeof(Branch<,,>)) {
            var left = type.GetField("Left")!;
            var right = type.GetField("Right")!;
            left.SetValue(value, Fill(left.FieldType, values, ref index));
            right.SetValue(value, Fill(right.FieldType, values, ref index));
        }
        return value;
    }
    public static object Make(int length) {
        var index = 0;
        var value = Fill(Shape(length), Values(length), ref index);
        Require(index == length);
        return value;
    }
    private static void Fault<E>(Action action) where E: ArgumentException {
        try { action(); }
        catch (E error) { Require(error.GetType() == typeof(E) && error.ParamName == "array"); return; }
        throw new Exception("missing checked bridge fault");
    }
    public static void CheckedFaultsAndDefaults() {
        _ = new Constructed();
        Require(Constructed.Calls == 1);
        Constructed.Calls = 0;
`)
            for var length = 0; length <= 32; length++ {
                let n = length.ToString()
                source.AppendLine("{")
                source.AppendLine("var destination = ClrArrayCopies.FromArray" + n + "(Values(" + n + "));")
                source.AppendLine(
                    "Fault<ArgumentNullException>(() => destination = ClrArrayCopies.FromArray" + n + "<int>(null!));"
                )
                source.AppendLine("Expect(destination, " + n + ");")
                source.AppendLine(
                    "Fault<ArgumentException>(() => destination = ClrArrayCopies.FromArray" +
                        n +
                        "(new int[" +
                        (length + 1).ToString() + "]));"
                )
                source.AppendLine("Expect(destination, " + n + ");")
                if length != 0 {
                    source.AppendLine(
                        "Fault<ArgumentException>(() => destination = ClrArrayCopies.FromArray" +
                            n +
                            "(new int[" +
                            (length - 1).ToString() + "]));"
                    )
                    source.AppendLine("Expect(destination, " + n + ");")
                }
                source.AppendLine("var defaults = ClrArrayCopies.ToArray" + n + "<Constructed>(default);")
                source.AppendLine("Require(defaults.Length == " + n + " && defaults.All(item => item.Value == 0));")
                source.AppendLine("var zeros = ClrArrayCopies.FromArray" + n + "(new Constructed[" + n + "]);")
                source.AppendLine("var copiedZeros = ClrArrayCopies.ToArray" + n + "(zeros);")
                source.AppendLine(
                    "Require(copiedZeros.Length == " + n + " && copiedZeros.All(item => item.Value == 0));"
                )
                source.AppendLine("Require(Constructed.Calls == 0);")
                source.AppendLine("var references = ClrArrayCopies.ToArray" + n + "<string>(default);")
                source.AppendLine("Require(references.Length == " + n + " && references.All(item => item is null));")
                source.AppendLine("var optional = ClrArrayCopies.ToArray" + n + "<int?>(default);")
                source.AppendLine("Require(optional.Length == " + n + " && optional.All(item => item is null));")
                source.AppendLine("}")
            }
            return source.AppendLine("}\n}\n}").ToString()
        }

        private func Boundaries() string -> `package CopyBoundaries
import System
import System.Collections.Generic
import Gsharp.Values
import Gsharp.Values.FixedArrays.V1
class Box { var Value Branch[int32, Leaf[int32], Leaf[int32]] }
open class Base { var Tag int32 }
class Derived : Base { }
struct Aggregate { var Value Branch[int32, Leaf[int32], Leaf[int32]] }
enum Mode { Zero, Ready }
func Require(ok bool) {
    Counter.Checks++
    if !ok { throw Exception("fixed-array bridge boundary " + Counter.Checks.ToString()) }
}
func Echo[T](value T) T -> value
func Replace(value Branch[int32, Leaf[int32], Leaf[int32]]) Branch[int32, Leaf[int32], Leaf[int32]] {
    var copy = value
    copy.Left.Item = 91
    return copy
}
shared class Counter {
    var Evaluations int32 = 0
    var Checks int32 = 0
}
func Input() []int32 {
    Counter.Evaluations++
    return []int32{3, 4}
}
func Main() {
    var original = ClrArrayCopies.FromArray2(Input())
    Require(Counter.Evaluations == 1)
    var copy = Echo(original)
    copy.Left.Item = 8
    Require(original.Left.Item == 3)
    Require(Replace(original).Left.Item == 91)
    Require(original.Left.Item == 3)
    var aggregate = Aggregate{Value: original}
    var aggregateCopy = aggregate
    aggregateCopy.Value.Right.Item = 9
    Require(aggregate.Value.Right.Item == 4)
    let (tupleCopy, tag) = (original, 17)
    original.Right.Item = 6
    Require(tupleCopy.Right.Item == 4 && tag == 17)
    let items = List[Branch[int32, Leaf[int32], Leaf[int32]]]{original}
    var extracted = items[0]
    extracted.Left.Item = 33
    original.Left.Item = 12
    Require(items[0].Left.Item == 3)
    let boxed object = tupleCopy
    var unboxed = cast[Branch[int32, Leaf[int32], Leaf[int32]]](boxed)
    unboxed.Left.Item = 22
    Require(cast[Branch[int32, Leaf[int32], Leaf[int32]]](boxed).Left.Item == 3)
    let holder = Box{Value: tupleCopy}
    let other = Box{Value: ClrArrayCopies.FromArray2([]int32{70, 80})}
    let retained = managed(holder.Value.Left.Item)
    holder.Value = ClrArrayCopies.FromArray2([]int32{10, 20})
    Require(*retained == 10)
    holder.Value, other.Value = other.Value, holder.Value
    Require(*retained == 70 && other.Value.Left.Item == 10)
    var fault = false
    try { holder.Value = ClrArrayCopies.FromArray2([]int32{1}) }
    catch (error ArgumentException) { fault = true }
    Require(fault && *retained == 70)
    let storage = []Branch[int32, Leaf[int32], Leaf[int32]]{tupleCopy}
    var frames = slice[Branch[int32, Leaf[int32], Leaf[int32]]].FromArray(storage)
    let snapshot = frames[0]
    let element = managed(frames[0].Left.Item)
    // #5325 tracks the separate nested native-slice field-store defect.
    frames[0] = ClrArrayCopies.FromArray2([]int32{50, 40})
    Require(snapshot.Left.Item == 3 && *element == 50)
    frames = frames.Append(tupleCopy)
    frames[0] = ClrArrayCopies.FromArray2([]int32{60, 40})
    Require(storage[0].Left.Item == 50 && *element == 50 && frames[0].Left.Item == 60)
    let token = Derived{Tag: 7}
    let covariant = cast[[]Base]([]Derived{token, token})
    Require(covariant.GetType() == typeof([]Derived))
    var references = ClrArrayCopies.FromArray2(covariant)
    let referenceCopy = ClrArrayCopies.ToArray2(references)
    references.Left.Item.Tag = 9
    Require(covariant[0].Tag == 9 && Object.ReferenceEquals(referenceCopy[1], token))
    references.Left.Item = Base{Tag: 1}
    Require(Object.ReferenceEquals(covariant[0], token))
    Require(referenceCopy.GetType() == typeof([]Base))
    let inner = []int32{4}
    let arrays = ClrArrayCopies.FromArray1([][]int32{inner})
    let arrayCopy = ClrArrayCopies.ToArray1(arrays)
    arrayCopy[0][0] = 8
    Require(inner[0] == 8)
    let optional = ClrArrayCopies.FromArray2([]string?{nil, "ok"})
    Require(optional.Left.Item == nil && optional.Right.Item == "ok")
    let nested = ClrArrayCopies.FromArray1([]Leaf[int32]{Leaf[int32]{Item: 7}})
    var nestedCopy = Echo(nested)
    nestedCopy.Item.Item = 11
    Require(nested.Item.Item == 7)
    let descriptor = slice[int32].FromArray(inner)
    let descriptors = ClrArrayCopies.FromArray1([]Slice[int32]{descriptor})
    var descriptorCopy = ClrArrayCopies.ToArray1(descriptors)[0]
    descriptorCopy[0] = 19
    Require(inner[0] == 19)
    let handles = ClrArrayCopies.FromArray1([]managed[int32]{managed(inner[0])})
    let handleCopies = ClrArrayCopies.ToArray1(handles)
    *handleCopies[0] = 23
    Require(inner[0] == 23 && *handles.Item == 23)
    let modes = ClrArrayCopies.FromArray1([]Mode{Mode.Ready})
    Require(ClrArrayCopies.ToArray1(modes)[0] == Mode.Ready)
    GC.Collect()
    GC.WaitForPendingFinalizers()
    GC.Collect()
    Require(*retained == 70 && *element == 50)
    Console.WriteLine("value boundaries; existing destinations; descriptor sharing; defaults")
}`
    }
}
