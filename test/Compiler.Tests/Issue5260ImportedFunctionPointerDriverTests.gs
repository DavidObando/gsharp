package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5260ImportedFunctionPointerDriverTests {
    @Theory
    @InlineData("FunctionPointer")
    @InlineData("Pointer")
    @InlineData("Order")
    func NestedTupleNames_ConsumePointerChildrenBeforeLaterSiblings(kind string) {
        using let fixture = CSharpFixture(NestedTupleContract, allowUnsafe: true)
        let consumer = Compile(
            fixture.DirectoryPath,
            "Consumer",
            "import NestedTuples\nunsafe func Main() {\n    let value = Tuples." +
                kind +
                "()\n    System.Console.Write(value.Tail.First)\n    System.Console.Write(\"|\")\n" +
                "    System.Console.Write(value.Tail.Second)\n}",
            fixture.AssemblyPath
        )
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        IlVerifier.Verify(consumer.Path, []string{fixture.AssemblyPath})
        Assert.Equal(Encoding.UTF8.GetBytes("11|22"), Run(consumer.Path))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedTupleNames_EmitFunctionPointerReturnBeforeParameters(hasReturnTuple bool) {
        using let fixture = CSharpFixture(NestedTupleContract, allowUnsafe: true)
        let signature = if hasReturnTuple {
            "(Pointers []unmanaged[Cdecl]((ArgA int32, ArgB int32)) -> (RetA int32, RetB int32), Tail (First int32, Second int32))"
        } else {
            "(Pointers []unmanaged[Cdecl]((Second int32, First int32)) -> void, Tail (First int32, Second int32))"
        }
        let producer = Compile(
            fixture.DirectoryPath,
            "Forwarder",
            "package Forwarder\nimport NestedTuples\npublic unsafe func Get() " +
                signature +
                " -> Tuples." +
                (
                if hasReturnTuple {
                    "Order"
                } else {
                    "FunctionPointer"
                }
            ) +
                "()",
            fixture.AssemblyPath,
            executable: false
        )
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let method = Assembly
            .LoadFile(producer.Path)
            .GetTypes()
            .SelectMany((type Type) -> type.GetMethods(BindingFlags.Public | BindingFlags.Static))
            .Single((method MethodInfo) -> method.Name == "Get")
        let names = Assert.IsType[TupleElementNamesAttribute](
            Attribute.GetCustomAttribute(method.ReturnParameter, typeof(TupleElementNamesAttribute))
        )
        let expected = if hasReturnTuple {
            []string? {"Pointers", "Tail", "RetA", "RetB", "ArgA", "ArgB", "First", "Second"}
        } else {
            []string? {"Pointers", "Tail", "Second", "First", "First", "Second"}
        }
        Assert.Equal(expected, names.TransformNames)
        let consumer = Compile(fixture.DirectoryPath, "Consumer", `import Forwarder
unsafe func Main() {
    let value = Get()
    System.Console.Write(value.Tail.First)
    System.Console.Write("|")
    System.Console.Write(value.Tail.Second)
}`, producer.Path)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        IlVerifier.Verify(producer.Path, []string{fixture.AssemblyPath})
        IlVerifier.Verify(consumer.Path, []string{fixture.AssemblyPath, producer.Path})
        Assert.Equal(Encoding.UTF8.GetBytes("11|22"), Run(consumer.Path))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ObliviousNamedTuples_PreservePlatformWrappersAndPointerSignatures(longTuple bool) {
        using let fixture = CSharpFixture(ObliviousTupleContract, allowUnsafe: true)
        let source = "import ObliviousTuples\nunsafe func Main() {\n" +
            "    let field = Tuples.Field.Value\n    let property = Tuples.Property.Value\n" +
            "    let box = Tuples." +
            (
            if longTuple {
                "GetLong"
            } else {
                "Get"
            }
        ) +
            "()\n    let result = box.Value\n    let pointer unmanaged[Cdecl]() -> void = result.Pointers[0]\n" +
            "    System.Console.Write(field.Tag + property.Tag + result.Tag)\n" +
            "    System.Console.Write(pointer == nil)\n    System.Console.Write(box == nil)\n}"
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        IlVerifier.Verify(consumer.Path, []string{fixture.AssemblyPath})
        Assert.Equal(Encoding.UTF8.GetBytes("21TrueFalse"), Run(consumer.Path))
        let tupleType = if longTuple {
            "(A int32, B int32, C int32, D int32, E int32, F int32, G int32, Tag int32, Pointers []unmanaged[Cdecl]() -> void)"
        } else {
            "(Tag int32, Pointers []unmanaged[Cdecl]() -> void)"
        }
        let target = "Box[" + tupleType + "]"
        let expression = if longTuple {
            "Tuples.GetLong()"
        } else {
            "Tuples.Get()"
        }
        let rejected = Compile(
            fixture.DirectoryPath,
            "Rejected",
            "import ObliviousTuples\nunsafe func Reject() {\n    let strict " + target + " = " + expression + "\n}",
            fixture.AssemblyPath,
            executable: false
        )
        Assert.NotEqual(0, rejected.Code)
        Assert.False(File.Exists(rejected.Path))
        let error = Assert.Single(Regex.Matches(rejected.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal((19 + target.Length).ToString(), error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((19 + target.Length + expression.Length).ToString(), error.Groups[4].Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedPointerOverloads_KeepOrdinaryAndExpandedApplicableCandidates(expanded bool) {
        using let fixture = CSharpFixture(ReviewContract, allowUnsafe: true)
        let source = if expanded {
            `import Review4
struct Amount { var Value int32 }
func operator implicit(value Amount) int32 -> value.Value
func Main() { System.Console.Write(Expanded.M(Amount{Value: 1}, Amount{Value: 2})) }`
        } else {
            `import Review4
func Main() { System.Console.Write(Ordinary.M(1)) }`
        }
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        IlVerifier.Verify(consumer.Path, []string{fixture.AssemblyPath})
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                if expanded {
                    "3"
                } else {
                    "2"
                }
            ),
            Run(consumer.Path)
        )
    }

    @Theory
    @InlineData("Get", "unmanaged[Stdcall](nint) -> nint", "nil")
    @InlineData("Get", "nint", "nint(0)")
    @InlineData("GetArray", "[]?unmanaged[Stdcall](nint) -> nint", "nil")
    func ImportedOverride_RejectsErasedFunctionPointerSignatureMatches(name string, type string, value string) {
        using let fixture = CSharpFixture(ReviewContract, allowUnsafe: true)
        let source = "import Review4\nunsafe class Derived : Base[int32] {\n    override func " +
            name +
            "() " +
            type +
            " { return " +
            value +
            " }\n}"
        let consumer = Compile(fixture.DirectoryPath, "Rejected", source, fixture.AssemblyPath, executable: false)
        Assert.NotEqual(0, consumer.Code)
        Assert.False(File.Exists(consumer.Path))
        let error = Assert.Single(Regex.Matches(consumer.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
        Assert.Equal("GS0185", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal("19", error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((19 + name.Length).ToString(), error.Groups[4].Value)
        var expected TypeSymbol = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray.Create(TypeSymbol.NInt),
            TypeSymbol.NInt
        )
        var actual TypeSymbol = if type == "nint" {
            TypeSymbol.NInt
        } else {
            FunctionPointerTypeSymbol.Get(
                CallingConvention.StdCall,
                ImmutableArray.Create(TypeSymbol.NInt),
                TypeSymbol.NInt
            )
        }
        if name == "GetArray" {
            expected = SliceTypeSymbol.Get(expected)
            actual = SliceTypeSymbol.Get(actual)
        }
        Assert.False(TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(expected, actual))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NamedTupleMerge_PreservesPointerArraysAndRestLayout(longTuple bool) {
        using let fixture = CSharpFixture(ReviewContract, allowUnsafe: true)
        let source = "import Review4\nunsafe func Main() {\n    let tuple = Tuples." +
            (
            if longTuple {
                "GetLong"
            } else {
                "Get"
            }
        ) +
            "().Value\n" +
            "    let pointer unmanaged[Cdecl](int32) -> void = tuple.Pointers[0]\n" +
            "    System.Console.Write(tuple.Tag)\n    System.Console.Write(pointer == nil)\n}"
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("7True"), Run(consumer.Path))
        IlVerifier.Verify(consumer.Path, []string{fixture.AssemblyPath})
    }

    @Fact
    func ManagedPointerNullability_PreservesDirectAndProjectedSignaturePositions() {
        using let fixture = CSharpFixture(ReviewContract, allowUnsafe: true)
        const source = `import Review4
unsafe func Invoke[T](api Managed[T], value T) T {
    let pointer = api.Value
    return pointer(value)
}
unsafe func Main() {
    let direct = Direct.Value
    let directResult = direct()
    let echo = Direct.Echo
    let echoResult = echo(nil)
    let api = Managed[string]()
    let field = api.Value
    let property = api.Property
    let result = api.Get()
    System.Console.Write(directResult == nil && echoResult == nil)
    System.Console.Write("|")
    System.Console.Write(field(nil) == nil && property(nil) == nil && result(nil) == nil)
    System.Console.Write("|")
    System.Console.Write(Invoke[int32](Managed[int32](), 7))
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True|True|7"), Run(consumer.Path))
        let producer = Compile(fixture.DirectoryPath, "Published", `package Published
public unsafe struct Holder { public var Value *func(string?) string? }`, executable: false)
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let roundtrip = Compile(fixture.DirectoryPath, "Roundtrip", `import Published
func Identity(value string?) string? -> value
unsafe func Main() {
    var holder = Holder()
    holder.Value = &Identity
    let pointer = holder.Value
    System.Console.Write(pointer(nil) == nil)
}`, producer.Path)
        Assert.True(roundtrip.Code == 0, roundtrip.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(roundtrip.Path))
    }

    @Theory
    @InlineData("Direct.Value", "")
    @InlineData("Managed[string]().Value", `"value"`)
    func ManagedPointerNullability_RejectsNullableResultNarrowing(expression string, arguments string) {
        using let fixture = CSharpFixture(ReviewContract, allowUnsafe: true)
        let invocation = "pointer(" + arguments + ")"
        let source = "import Review4\nunsafe func Main() {\n    let pointer = " +
            expression +
            "\n    let value string = " +
            invocation +
            "\n}"
        let consumer = Compile(fixture.DirectoryPath, "Rejected", source, fixture.AssemblyPath)
        Assert.NotEqual(0, consumer.Code)
        Assert.False(File.Exists(consumer.Path))
        let error = Assert.Single(Regex.Matches(consumer.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("4", error.Groups[1].Value)
        Assert.Equal("24", error.Groups[2].Value)
        Assert.Equal("4", error.Groups[3].Value)
        Assert.Equal((24 + invocation.Length).ToString(), error.Groups[4].Value)
    }

    @Fact
    func SeparateGSharpProducer_AssignsTheOriginalSignatureAndPreservesSourceControl() {
        using let fixture = CSharpFixture("public class DirectoryOwner {}")
        let control = Compile(
            fixture.DirectoryPath,
            "Control",
            Producer + Consumer.Replace("import Fixture", "").Replace("Dispatch()", "Dispatch{}")
        )
        Assert.True(control.Code == 0, control.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(control.Path))

        let producer = Compile(fixture.DirectoryPath, "Fixture", Producer, executable: false)
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let consumer = Compile(fixture.DirectoryPath, "Consumer", Consumer, producer.Path)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(consumer.Path))
        let image = File.ReadAllBytes(consumer.Path)
        Assert.NotEmpty(image)
        let repeated = Compile(fixture.DirectoryPath, "Consumer", Consumer, producer.Path)
        Assert.True(repeated.Code == 0, repeated.Diagnostics)
        Assert.Equal(image, File.ReadAllBytes(repeated.Path))
    }

    @Fact
    func RoslynProducer_PreservesFunctionPointersInsideGenericArrayArguments() {
        using let fixture = CSharpFixture(NestedContract, allowUnsafe: true)
        const source = `import GenericPointers
struct Payload { var Value int32 }
unsafe func Main() {
    let holder = Provider[Payload].Create()
    let field unmanaged[Cdecl](*Payload, nuint) -> *Payload = holder.Values.Value[0]
    let property unmanaged[Cdecl](*Payload, nuint) -> *Payload = holder.Property.Value[0]
    let result unmanaged[Cdecl](*Payload, nuint) -> *Payload = Provider[Payload].Get().Value[0]
    System.Console.Write(field == nil)
    System.Console.Write("|")
    System.Console.Write(property == nil)
    System.Console.Write("|")
    System.Console.Write(result == nil)
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True|True|True"), Run(consumer.Path))
        let image = File.ReadAllBytes(consumer.Path)
        Assert.NotEmpty(image)
        let repeated = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(repeated.Code == 0, repeated.Diagnostics)
        Assert.Equal(image, File.ReadAllBytes(repeated.Path))
    }

    @Theory
    @InlineData("unmanaged[Stdcall](*Payload, nuint) -> *Payload")
    @InlineData("unmanaged[Cdecl](*Payload, nint) -> *Payload")
    func ImportedGenericArray_RejectsDifferentAbiOrSignatureWithAnExactDiagnostic(type string) {
        using let fixture = CSharpFixture(NestedContract, allowUnsafe: true)
        let expression = "Provider[Payload].Get().Value[0]"
        let source = "import GenericPointers\nstruct Payload { var Value int32 }\nunsafe func Main() {\n    let target " +
            type +
            " = " +
            expression +
            "\n}"
        let consumer = Compile(fixture.DirectoryPath, "Rejected", source, fixture.AssemblyPath)
        Assert.NotEqual(0, consumer.Code)
        Assert.False(File.Exists(consumer.Path))
        let errors = Regex.Matches(consumer.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+): ([^\r\n]*)`)
        let error = Assert.Single(errors)
        Assert.Equal("4", error.Groups[1].Value)
        Assert.Equal((19 + type.Length).ToString(), error.Groups[2].Value)
        Assert.Equal("4", error.Groups[3].Value)
        Assert.Equal((19 + type.Length + expression.Length).ToString(), error.Groups[4].Value)
        Assert.Equal("GS0156", error.Groups[5].Value)
    }

    @Fact
    func RoslynProducer_ProjectsAnOverrideSignatureWithoutAnInternalError() {
        using let fixture = CSharpFixture(Contract, assemblyName: "Contracts", allowUnsafe: true)
        const source = `import Contracts
unsafe class Derived : Base[int32] {
    override func Get() unmanaged[Cdecl](nint) -> nint { return nil }
}
unsafe func Main() {
    let value Base[int32] = Derived()
    let pointer unmanaged[Cdecl](nint) -> nint = value.Get()
    System.Console.Write(pointer == nil)
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(consumer.Path))
    }

    @Fact
    func RoslynProducer_ProjectsFieldsPropertiesAndReturnsThroughGenericReceiver() {
        using let fixture = CSharpFixture(Contract, assemblyName: "Contracts", allowUnsafe: true)
        const source = `import System
import Contracts
struct Payload { var Value int32 }
func Increment(value nint) nint -> value + 1
unsafe func Main() {
    let api = Api[Payload]()
    let pointer = cast[unmanaged[Cdecl](*Payload, nuint) -> *Payload](nint(0))
    api.Value = pointer
    api.Property = pointer
    let field unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Value
    let property unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Property
    let result unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Get()
    api.Managed = &Increment
    let managed *func(nint) nint = api.Managed
    let stdcall unmanaged[Stdcall](nint) -> nint = api.Stdcall
    let extended unmanaged[Cdecl, SuppressGCTransition](nint) -> nint = api.Extended
    let platform unmanaged(nint) -> nint = api.Platform
    Console.Write(managed(nint(41)))
    Console.Write("|")
    Console.Write(field == nil && property == nil && result == nil)
    Console.Write("|")
    Console.Write(stdcall == nil && extended == nil && platform == nil)
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("42|True|True"), Run(consumer.Path))
    }

    @Theory
    @InlineData("*func(nint, uint64, *Callbacks)", "nil")
    @InlineData("unmanaged[Stdcall](nint, uint64, *Callbacks) -> void", "nint(0)")
    @InlineData("unmanaged[Cdecl](nuint, uint64, *Callbacks) -> void", "nint(0)")
    @InlineData("unmanaged[Cdecl](nint, uint64, *Callbacks) -> nint", "nint(0)")
    func ImportedField_RejectsDifferentAbiOrSignatureWithAnExactDiagnostic(type string, value string) {
        using let fixture = CSharpFixture("public class DirectoryOwner {}")
        let producer = Compile(fixture.DirectoryPath, "Fixture", Producer, executable: false)
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let expression = "cast[" + type + "](" + value + ")"
        let source = "import Fixture\nunsafe func Reject(dispatch Dispatch) {\n    dispatch.Destroy = " +
            expression +
            "\n}"
        let consumer = Compile(fixture.DirectoryPath, "Rejected", source, producer.Path, executable: false)
        Assert.NotEqual(0, consumer.Code)
        Assert.False(File.Exists(consumer.Path))
        let errors = Regex.Matches(consumer.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+): ([^\r\n]*)`)
        let error = Assert.Single(errors)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal("24", error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((24 + expression.Length).ToString(), error.Groups[4].Value)
        Assert.Equal("GS0156", error.Groups[5].Value)
        Assert.EndsWith(
            "to 'unmanaged[Cdecl] (nint, uint64, *Fixture.Callbacks) -> void'. An explicit conversion exists (are you missing a cast?)",
            error.Groups[6].Value
        )
    }

    shared {
        private const ObliviousTupleContract string = `#nullable disable
namespace ObliviousTuples {
    public class Box<T> { public T Value; }
    public unsafe static class Tuples {
        public static Box<(int Tag, delegate* unmanaged[Cdecl]<void>[] Pointers)> Field =
            new() { Value = (7, new delegate* unmanaged[Cdecl]<void>[1]) };
        public static Box<(int Tag, delegate* unmanaged[Cdecl]<void>[] Pointers)> Property => Field;
        public static Box<(int Tag, delegate* unmanaged[Cdecl]<void>[] Pointers)> Get() => Field;
        public static Box<(int A, int B, int C, int D, int E, int F, int G, int Tag, delegate* unmanaged[Cdecl]<void>[] Pointers)> GetLong() =>
            new() { Value = (0, 0, 0, 0, 0, 0, 0, 7, new delegate* unmanaged[Cdecl]<void>[1]) };
    }
}`

        private const ReviewContract string = `#nullable enable
namespace Review4 {
    public unsafe static class Ordinary {
        public static int M(int value) => value + 1;
        public static int M(delegate* unmanaged[Cdecl]<void>[] pointers) => -1;
    }
    public unsafe static class Expanded {
        public static int M(params int[] values) => values[0] + values[1];
        public static int M(params delegate* unmanaged[Cdecl]<void>[][] pointers) => -1;
    }
    public unsafe class Base<T> {
        public virtual delegate* unmanaged[Cdecl]<nint, nint> Get() => null;
        public virtual delegate* unmanaged[Cdecl]<nint, nint>[] GetArray() =>
            new delegate* unmanaged[Cdecl]<nint, nint>[1];
    }
    public class Box<T> { public T Value = default!; }
    public unsafe static class Tuples {
        public static Box<(int Tag, delegate* unmanaged[Cdecl]<int, void>[] Pointers)> Get() =>
            new() { Value = (7, new delegate* unmanaged[Cdecl]<int, void>[1]) };
        public static Box<(int A, int B, int C, int D, int E, int F, int G, int Tag, delegate* unmanaged[Cdecl]<int, void>[] Pointers)> GetLong() =>
            new() { Value = (0, 0, 0, 0, 0, 0, 0, 7, new delegate* unmanaged[Cdecl]<int, void>[1]) };
    }
    public unsafe static class Direct {
        public static delegate*<string?> Value = &Null;
        public static delegate*<string?, string?> Echo = &Identity;
        public static string? Null() => null;
        public static string? Identity(string? value) => value;
    }
    public unsafe class Managed<T> {
        public delegate*<T?, T?> Value = &Identity;
        public delegate*<T?, T?> Property => Value;
        public delegate*<T?, T?> Get() => Value;
        public static T? Identity(T? value) => value;
    }
}`

        private const NestedTupleContract string = `#nullable enable
namespace NestedTuples {
    public static unsafe class Tuples {
        public static (delegate* unmanaged[Cdecl]<(int Second, int First), void>[] Pointers,
            (int First, int Second) Tail) FunctionPointer() => (null!, (11, 22));
        public static ((int Second, int First)*[] Pointers,
            (int First, int Second) Tail) Pointer() => (null!, (11, 22));
        public static (delegate* unmanaged[Cdecl]<(int ArgA, int ArgB), (int RetA, int RetB)>[] Pointers,
            (int First, int Second) Tail) Order() => (null!, (11, 22));
    }
}`

        private const NestedContract string = `namespace GenericPointers {
    public class Box<T> { public T Value; }
    public unsafe class Provider<T> where T : unmanaged {
        public Box<delegate* unmanaged[Cdecl]<T*, nuint, T*>[]> Values;
        public Box<delegate* unmanaged[Cdecl]<T*, nuint, T*>[]> Property => Values;
        public static Provider<T> Create() => new Provider<T> { Values = Get() };
        public static Box<delegate* unmanaged[Cdecl]<T*, nuint, T*>[]> Get() =>
            new Box<delegate* unmanaged[Cdecl]<T*, nuint, T*>[]> { Value = new delegate* unmanaged[Cdecl]<T*, nuint, T*>[1] };
    }
}`

        private const Producer string = `package Fixture
import System.Runtime.InteropServices
@StructLayout(LayoutKind.Sequential)
public struct Callbacks { public var UserData nint }
@StructLayout(LayoutKind.Sequential)
public unsafe struct Dispatch { public var Destroy unmanaged[Cdecl](nint, uint64, *Callbacks) -> void }
`

        private const Consumer string = `import Fixture
@System.Runtime.InteropServices.UnmanagedCallersOnly
unsafe func Destroy(device nint, pool uint64, callbacks *Callbacks) {}
unsafe func Probe() {
 var dispatch = Dispatch()
 dispatch.Destroy = cast[unmanaged[Cdecl](nint, uint64, *Callbacks) -> void](nint(&Destroy))
}
unsafe func Main() {
 var dispatch = Dispatch()
 dispatch.Destroy = cast[unmanaged[Cdecl](nint, uint64, *Callbacks) -> void](nint(&Destroy))
 System.Console.Write(nint(dispatch.Destroy) == nint(&Destroy))
}`

        private const Contract string = `namespace Contracts {
    public unsafe class Api<T> where T : unmanaged {
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Value;
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Property { get; set; }
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Get() => Value;
        public delegate*<nint, nint> Managed;
        public delegate* unmanaged[Stdcall]<nint, nint> Stdcall;
        public delegate* unmanaged[Cdecl, SuppressGCTransition]<nint, nint> Extended;
        public delegate* unmanaged<nint, nint> Platform;
    }
    public unsafe class Base<T> {
        public virtual delegate* unmanaged[Cdecl]<nint, nint> Get() => null;
    }
}`

        private func Compile(
            directory string,
            name string,
            source string,
            reference string? = nil,
            executable bool = true
        )(Code int32, Diagnostics string, Path string) {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{
                if executable {
                    "/target:exe"
                } else {
                    "/target:library"
                },
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:none",
                "/out:" + outputPath,
                sourcePath
            }
            if reference != nil {
                arguments.Add("/reference:" + reference)
            }
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let originalOut = Console.Out
            let originalError = Console.Error
            var code int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                code = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            return (code, stdout.ToString() + stderr.ToString(), outputPath)
        }

        private func Run(assembly string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(assembly)!!
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start)!!
            let stderr = process.StandardError.ReadToEndAsync()
            using let stdout = MemoryStream()
            let readOutput = process.StandardOutput.BaseStream.CopyToAsync(stdout)
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("function-pointer consumer timed out")
            }
            readOutput.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
            return stdout.ToArray()
        }
    }
}
