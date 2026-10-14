// <copyright file="ManagedReferenceLanguageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler.Tests.LanguageConformance
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

class ManagedReferenceLanguageTests {
    @Theory
    @MemberData("Programs")
    func ProgramsVerifyAndExecute(source string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(source, "managed", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(expected, fixture.Run(dll))
        let heapTypes = EmittedFixture.Load(dll).GetTypes().Where((type Type) -> type.IsClass).ToArray()
        Assert.NotEmpty(heapTypes)
        for field in heapTypes.SelectMany(
            func (type Type) IEnumerable[FieldInfo] {
                return type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            }
        ) {
            Assert.False(field.FieldType.IsByRef || field.FieldType.IsByRefLike, field.ToString())
        }
        let borrows = NormalizedIlDump
            .Create(dll)
            .Split("method ")
            .Where(
            (body string) -> body.Split('\n')[0].Contains("<>__ManagedLocation") && body.Split('\n')[0].Contains(
                "::Borrow"
            )
        )
            .ToArray()
        Assert.NotEmpty(borrows)
        Assert.All(
            borrows,
            (body string) -> {
                Assert.DoesNotContain("newobj ", body)
                Assert.DoesNotContain("box ", body)
                Assert.DoesNotContain("System.Func", body)
            }
        )
    }

    @Fact
    func NestedGenericManagedLocationKeepsEnclosingAndOwnTypeParameters() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ManagedNestedGenericHelper
import System

class Box[V] {
    var Value V
}

class Counter[T, U] {
    func Read[V](box Box[V]) V {
        let location = managed(box.Value)
        return *location
    }
}

func Main() {
    let counter = Counter[int32, string]()
    let box = Box[bool]{Value: true}
    Console.WriteLine(counter.Read[bool](box))
}`, "ManagedNestedGenericHelper", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("True\n", fixture.Run(dll))
        let assembly = EmittedFixture.Load(dll)
        let counter = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Counter`2")
        let helper = Assert.Single(
            counter.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            (type Type) -> type.Name.StartsWith("<>__ManagedLocation", StringComparison.Ordinal)
        )
        Assert.Equal(3, helper.GetGenericArguments().Length)
    }

    @Theory
    @InlineData("func Bad(ref value int32) managed[int32] { return managed(value) }", "GS0604")
    @InlineData("func Bad() { var p managed[int32] = default }", "GS0604")
    @InlineData("func Bad() { var p managed[int32]; Console.WriteLine(p.GetHashCode()) }", "GS0604")
    @InlineData("func Bad() { var value = 1; let p = readonly managed(value); *p = 2 }", "GS0604")
    @InlineData("func Bad() { var span = Span[int32]([]int32{1}); let p = managed(span[0]) }", "GS0604")
    @InlineData(
        "func Foreign(ref value int32) ref int32 { return ref value }\nfunc Bad() { var x = 0; let p = managed(Foreign(ref x)) }",
        "GS0604"
    )
    @InlineData("func Bad(scoped p managed[int32]) managed[int32] { return p }", "GS0604")
    @InlineData("class Holder { var Location managed[int32] }\nfunc Bad() { let h = Holder() }", "GS0604")
    @InlineData("struct Holder { var Location managed[int32] }\nfunc Bad() { let h = default(Holder) }", "GS0604")
    @InlineData(`class Holder { var Location managed[int32]
init() { } }
func Bad() { let h = Holder() }`, "GS0604")
    @InlineData("var value = 1\nfunc Bad() { let p = managed(value) }", "GS0604")
    @InlineData("func Bad() { let p = managed(DateTime.Now) }", "GS0604")
    @InlineData("func Bad(scoped p managed[int32]) []managed[int32] { return []managed[int32]{p} }", "GS0604")
    @InlineData("func Bad() { var x = 1; let p = readonly managed(x); let q = managed(*p) }", "GS0604")
    @InlineData(`import System.Threading.Tasks
async func Bad(p managed[int32]) { let ref value = p.Borrow(); await Task.Delay(1); Console.WriteLine(value) }`, "GS0258")
    func InvalidProgramsDiagnose(declaration string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package InvalidManaged
import System
` + declaration, "invalid", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("error " + diagnostic + ":", StringComparison.Ordinal), output)
    }

    @Fact
    func ForeignOriginDiagnosticPointsAtTheRejectedLocation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const line = "func Bad(ref value int32) managed[int32] { return managed(value) }"
        let (code, output) = fixture.TryCompile("package InvalidManaged\n" + line, "invalid", executable: false)
        let column = line.IndexOf("managed(value)", StringComparison.Ordinal) + "managed(".Length + 1
        Assert.NotEqual(0, code)
        Assert.Contains("invalid.gs(2,$column,2,${column + 5}): error GS0604:", output)
    }

    @Fact
    func OrdinaryNamesKeepTypeValueFunctionAndEscapePrecedence() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ManagedNames
import System
class managed[T] { var Value T }
class readonlyManaged[T] { var Value T }
func Main() {
    let a = $managed[int32]{Value: 1}
    let b = readonlyManaged[int32]{Value: 2}
    let managed = func (value int32) int32 { return value + 3 }
    Console.WriteLine(managed(a.Value + b.Value))
    let p = Gsharp.Values.ManagedRef[int32].FromArray([]int32{7}, 0)
    Console.WriteLine(*p)
}`, "names", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`6
7
`, fixture.Run(dll))
    }

    @Fact
    func SeparateAssembliesAndCSharpRetainNominalBorrowContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.CompileCSharp(`namespace Producer;
public struct Pair { public int Value; }
public sealed class Box {
    public int Value;
    public readonly int Readonly = 7;
    public Pair Pair;
}`, "producer")
        let reference = Path.Combine(fixture.Directory, "ManagedApi.ref.dll")
        let api = fixture.Compile(`package ManagedApi
import Producer
class Api {
    shared {
        func Field(box Box) managed[int32] { return managed(box.Value) }
        func Read(box Box) readonly managed[int32] { return readonly managed(box.Readonly) }
        func Element[T](values []T) managed[T] { return managed(values[0]) }
        func Borrow[T](p managed[T]) ref T { return ref *p }
        func View[T](p readonly managed[T]) ref readonly T { return ref *p }
    }
}`, "ManagedApi", false, "/r:" + producer, "/refout:" + reference)
        IlVerifier.Verify(api, []string{producer})
        let consumer = fixture.CompileCSharp(`using Gsharp.Values;
using ManagedApi;
using Producer;
namespace ManagedConsumerLib;
public static class Consumer {
    public static bool Run(Box box) {
        ManagedRef<int> p = Api.Field(box);
        ref int borrow = ref Api.Borrow(p);
        ref readonly int view = ref Api.View(p.AsReadOnly());
        borrow = 9;
        var values = new[] { new Pair { Value = 3 } };
        Api.Element(values).Borrow().Value = 4;
        return view == 9 && Api.Read(box).Borrow() == 7 && values[0].Value == 4;
    }
}`, "consumer", reference, producer)
        let executable = fixture.Compile(`package ManagedConsumer
import System
import Producer
import ManagedApi
import ManagedConsumerLib
func Main() {
    let box = Box()
    let first = Api.Field(box)
    let second = managed(box.Value)
    Console.WriteLine(first == second)
    Console.WriteLine(first.GetHashCode() == second.GetHashCode())
    Console.WriteLine(first.SameLocation(readonly managed(box.Value)))
    Console.WriteLine(Consumer.Run(box))
    Console.WriteLine(*second)
}`, "consumerProgram", true, "/r:" + api, "/r:" + producer, "/r:" + consumer)
        IlVerifier.Verify(executable, []string{producer, api, consumer})
        Assert.Equal(`True
True
True
True
9
`, fixture.Run(executable))
    }

    shared {
        func Programs() sequence[[]object] {
            yield[]object{`package ManagedSuspension
import System
func Values() sequence[managed[int32]] {
    var x = 1
    let p = managed(x)
    yield p
    x = 2
    yield p
}
func Main() {
    let iterator = Values().GetEnumerator()
    iterator.MoveNext()
    let first = iterator.Current
    Console.WriteLine(*first)
    iterator.MoveNext()
    Console.WriteLine(*first)
    Console.WriteLine(first == iterator.Current)
    let channel = chan[managed[int32]](0)
    go func () { channel <- first }()
    let received = <-channel
    *received = 9
    Console.WriteLine(*first)
}`, `1
2
True
9
`}
            yield[]object{`package ManagedInitialization
import System
class Owner { var Value int32 }
class Holder { var Location managed[int32] = managed(Owner{Value: 13}.Value) }
func Main() {
    let holder = Holder()
    Console.WriteLine(*holder.Location)
    var value string? = nil
    let p managed[string?] = managed(value)
    Console.WriteLine(*p == nil)
    *p = "retained"
    Console.WriteLine(value)
    let input object = 17
    if input is int32 number {
        let saved = readonly managed(number)
        Console.WriteLine(*saved)
    }
}`, `13
True
retained
17
`}
            yield[]object{`package ManagedCompositions
import System
import System.Collections.Generic
class Node { var Value int32 }
struct Pair {
    var Number int32
    var Child Node
}
func Same[T](p managed[T], q managed[T]) bool { return p == q }
func Borrow[T](p managed[T]) ref T { return ref *p }
func View[T](p readonly managed[T]) ref readonly T { return ref *p }
func Main() {
    var values = []Pair{Pair{Number: 1, Child: Node{Value: 2}}}
    let root = managed(values[0])
    let n = managed(values[0].Number)
    let child = managed(values[0].Child.Value)
    let originalChild = values[0].Child
    values[0] = Pair{Number: 3, Child: Node{Value: 4}}
    *child = 5
    Console.WriteLine(*n)
    Console.WriteLine(originalChild.Value)
    Console.WriteLine(values[0].Child.Value)
    Console.WriteLine(Same(root, managed(values[0])))
    let ref borrowed = Borrow(n)
    let ref readonly readonlyBorrow = View(n.AsReadOnly())
    borrowed = 6
    Console.WriteLine(readonlyBorrow)
    Console.WriteLine(values[0].Number)
    let refs = List[managed[int32]]()
    for i in []int32{0, 1, 2} {
        var local = i
        refs.Add(managed(local))
    }
    *refs[0] = 10
    Console.WriteLine(*refs[0])
    Console.WriteLine(*refs[1])
    Console.WriteLine(*refs[2])
    let factory = func () managed[int32] {
        var local = 11
        let ref alias = local
        let nested = func () managed[int32] { return managed(alias) }
        local = 12
        return nested()
    }
    Console.WriteLine(*factory())
    GC.Collect(2, GCCollectionMode.Forced, true, true)
    Console.WriteLine(*n)
}`, `3
5
4
True
6
6
10
1
2
12
6
`}
            yield[]object{`package ManagedReadonlyFields
import System
class Box { let Value int32 = 17 }
func Main() {
    let box = Box()
    let view = readonly managed(box.Value)
    Console.WriteLine(*view)
    let factory = func (value int32) readonly managed[int32] { return readonly managed(value) }
    Console.WriteLine(*factory(23))
}`, `17
23
`}
            yield[]object{`package ManagedState
import System
import System.Threading.Tasks
class Holder {
    var Location managed[int32]
    init(location managed[int32]) { this.Location = location }
}
async func Change(p managed[int32]) int32 {
    {
        let ref live = p.Borrow()
        live += 1
    }
    try {
        await Task.Delay(1)
    } finally {
        *p += 1
    }
    *p += 1
    return *p
}
func Main() {
    var x = 1
    let h = Holder(managed(x))
    Console.WriteLine(Change(h.Location).GetAwaiter().GetResult())
    Console.WriteLine(x)
    var p managed[int32]
    p = managed(x)
    Console.WriteLine(*p)
    let nilHandle managed[int32]? = default
    Console.WriteLine(nilHandle == nil)
}`, `4
4
4
True
`}
            yield[]object{`package ManagedClosures
import System
func Make[T](value T) managed[T] {
    var copy = value
    return managed(copy)
}
func Observe[T](value T) readonly managed[T] { return readonly managed(value) }
func Main() {
    var x = 1
    let writer = func () { x += 1 }
    let reader = func () int32 { return x }
    let address = func () managed[int32] { return managed(x) }
    let p = address()
    writer()
    *p += 3
    Console.WriteLine(reader())
    Console.WriteLine(x)
    Console.WriteLine(p == address())
    let copy = Make(x)
    *copy = 99
    Console.WriteLine(x)
    Console.WriteLine(*copy)
    let independent = Observe(x)
    x = 42
    Console.WriteLine(*independent)
}`, `5
5
True
5
99
5
`}
            yield[]object{`package ManagedAlias
import System
class Box { var Value int32 }
func Main() {
    var obj = Box{Value: 1}
    let ref before = obj.Value
    let p = managed(before)
    obj = Box{Value: 2}
    before = 7
    Console.WriteLine(*p)
    Console.WriteLine(obj.Value)
    var x = 1
    let ref early = x
    let q = managed(early)
    x = 8
    Console.WriteLine(*q)
    let ref readonly observe = early
    let ro = readonly managed(observe)
    *q = 9
    Console.WriteLine(*ro)
    let pointer = &x
    let retained = managed(*pointer)
    *pointer = 10
    Console.WriteLine(*retained)
}`, `7
2
8
9
10
`}
            yield[]object{`package ManagedPrivate
import System
import System.Threading
class Counter[T] {
    private var value T
    func Address() managed[T] { return managed(this.value) }
    func Read() T { return this.value }
}
func IsNil[T](p managed[T]?) bool { return nil == p }
func Main() {
    let c = Counter[int32]()
    let p = c.Address()
    *p = 12
    Console.WriteLine(c.Read())
    Console.WriteLine(p == c.Address())
    Console.WriteLine(p.SameLocation(readonly managed(*p)))
    Console.WriteLine(Interlocked.Increment(&*p))
    Console.WriteLine(IsNil[int32](nil))
}`, `12
True
True
13
True
`}
            yield[]object{`package ManagedCells
import System
func Make() managed[int32] {
    var x = 1
    let ref early = x
    let p = managed(x)
    early = 3
    x += 4
    *p += 1
    Console.WriteLine(x)
    Console.WriteLine(early)
    Console.WriteLine(p == managed(x))
    return p
}
func Main() {
    let p = Make()
    Console.WriteLine(*p)
    let ro = p.AsReadOnly()
    let ref readonly borrow = ro.Borrow()
    *p = 9
    Console.WriteLine(borrow)
    Console.WriteLine(p.SameLocation(ro))
}`, `8
8
True
8
9
True
`}
            yield[]object{`package ManagedOwners
import System
class Box { var Value int32 }
struct Pair {
    var Left int32
    var Right int32
    func Bump() { this.Left += 1 }
}
func Main() {
    var obj = Box{Value: 1}
    let original = obj
    let p = managed(obj.Value)
    obj = Box{Value: 2}
    *p = 3
    Console.WriteLine(original.Value)
    Console.WriteLine(obj.Value)
    var pair = Pair{Left: 4, Right: 5}
    let left = managed(pair.Left)
    pair = Pair{Left: 6, Right: 7}
    Console.WriteLine(*left)
    *left = 8
    Console.WriteLine(pair.Left)
    let readonlyPair = readonly managed(pair)
    (*readonlyPair).Bump()
    Console.WriteLine(pair.Left)
    let readonlyObject = readonly managed(obj)
    (*readonlyObject).Value = 17
    Console.WriteLine(obj.Value)
    var values = []int32{10, 20}
    let element = managed(values[1])
    let again = managed(values[1])
    let hash = element.GetHashCode()
    values = []int32{30, 40}
    *element = 99
    Console.WriteLine(*again)
    Console.WriteLine(element == again)
    Console.WriteLine(hash == element.GetHashCode())
    Console.WriteLine(values[1])
    var s = slice[int32]{11, 12}
    let saved = managed(s[1])
    s = s.Append(13)
    *saved = 14
    Console.WriteLine(s[1])
    Console.WriteLine(*saved)
}`, `3
2
6
8
8
17
99
True
True
40
12
14
`}
        }
    }
}
