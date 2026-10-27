// <copyright file="Issue3329CrossAssemblyStructLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #3329 — a struct literal (`S{}`) for a struct type declared in
/// ANOTHER (already-compiled) assembly lost its ADR-0159 "sound zero value"
/// instance-field initializer for a magic-collection-typed field (map/slice/
/// fixed array/sequence), leaving the field at its raw CLR default (a null
/// reference for a reference-backed collection) and NREing at runtime the
/// first time the field is used. The REPL hits this identically on a
/// cross-cell struct, since each submission is a distinct assembly (ADR-0156)
/// — these tests exercise the SAME code paths (`ImportedTypeSymbol.
/// BuildSemanticAggregate` for a `data struct`/primary-ctor struct,
/// `ExpressionBinder.BindImportedTypeObjectInitializer` for a plain
/// struct) through ordinary cross-assembly `gsc` compilation plus ILVerify,
/// which is more convenient to drive from a test than a REPL session and
/// confirms the fix is not REPL-specific.
open class Issue3329CrossAssemblyStructLiteralEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_SymbolicSpreadPhases(useReferenceAssembly bool) {
        const library = `package spreadphase5296
public class Effects {
    shared {
        public var Trace string = ""
        public var Throws bool
        public func Default() int32 {
            Trace = Trace + "D"
            if Throws { throw System.InvalidOperationException("default") }
            return 7
        }
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Box[T](Value T) {
    public var X int32 = Effects.Default()
    public var Y int32
    public init() { Effects.Trace = Effects.Trace + "P" }
}
public data struct Optional[T](Value T, Count int32 = 5) { public var X int32 = Effects.Default() }`
        const source = `import spreadphase5296
import System
data struct Local { public var N int32 }
data struct Source[T](Value T)
data struct LocalOptional[T](Value T, Count int32 = 5) { public var X int32 = Effects.Default() }
func ReadSource() Source[Local] {
    Effects.Trace = Effects.Trace + "S"
    return Source[Local]{Value: Local{N: 5}}
}
func Make[T](value T) Box[T] {
    let source = Source[T]{Value: value}
    return Box[T]{...source, X: Effects.Mark("E", 9)}
}
let source = Source[Local]{Value: Local{N: 3}}
let first = Box[Local]{...source, X: Effects.Mark("E", 9)}
Console.WriteLine(first.Value.N.ToString() + ":" + first.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let second = Make[Local](Local{N: 4})
Console.WriteLine(second.Value.N.ToString() + ":" + second.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Effects.Throws = true
try {
    let bad = Box[Local]{...source, X: Effects.Mark("E", 9)}
    Console.WriteLine(bad.X)
} catch (error InvalidOperationException) {
    Console.WriteLine(Effects.Trace + ":" + error.Message)
}
Effects.Throws = false
Effects.Trace = ""
let ordered = Box[Local]{...ReadSource(), Y: Effects.Mark("F", 10), X: Effects.Mark("E", 9)}
Console.WriteLine(ordered.Value.N.ToString() + "/" + ordered.X.ToString() + "/" + ordered.Y.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let optional = Optional[Local]{...source, X: Effects.Mark("E", 9)}
Console.WriteLine(optional.Value.N.ToString() + "/" + optional.Count.ToString() + "/" + optional.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let localOptional = LocalOptional[Local]{...source, X: Effects.Mark("E", 9)}
Console.WriteLine(localOptional.Value.N.ToString() + "/" + localOptional.Count.ToString() + "/" + localOptional.X.ToString() + ":" + Effects.Trace)`
        Assert.Equal(
            ExpectedConsoleBytes("3:9:DE\n4:9:DE\nD:default\n5/9/10:SDFE\n3/0/9:DE\n3/0/9:DE\n"),
            CompileAndRunExact(source, library, "spreadphase5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_AsyncConstructionPhases(useReferenceAssembly bool) {
        const library = `package asyncphase5296
import System.Threading.Tasks
public class Effects {
    shared {
        public var Trace string = ""
        public var Throws bool
        public func Default() int32 {
            Trace = Trace + "D"
            if Throws { throw System.InvalidOperationException("default") }
            return 7
        }
        public async func MarkAsync(mark string, value int32) int32 {
            Trace = Trace + mark
            await Task.Delay(1)
            return value
        }
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Default()
    public var Y int32
    public prop Z int32 { get; set; }
    public init() { Effects.Trace = Effects.Trace + "B" }
}
public data struct P(A int32) { public var X int32 = Effects.Default() }
public data struct G[T](Value T) {
    public var X int32 = Effects.Default()
    public prop Y int32 { get; set; }
}`
        const source = `import asyncphase5296
import System
data struct Local {
    public var X int32 = Effects.Default()
    public var Y int32
    public init() { Effects.Trace = Effects.Trace + "L" }
}
data struct LocalValue { public var N int32 }
async func ReadLocal() LocalValue {
    Effects.Trace = Effects.Trace + "A"
    await System.Threading.Tasks.Task.Delay(1)
    return LocalValue{N: 5}
}
async func Make[T](value T) G[T] {
    return G[T]{Value: value, X: await Effects.MarkAsync("E", 9), Y: await Effects.MarkAsync("F", 10)}
}
async func Run() {
    let first = S{X: await Effects.MarkAsync("E", 9)}
    Console.WriteLine(first.X.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    let second = Local{X: await Effects.MarkAsync("E", 8)}
    Console.WriteLine(second.X.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    let primary = P{X: await Effects.MarkAsync("E", 9), A: await Effects.MarkAsync("A", 3)}
    Console.WriteLine(primary.A.ToString() + "/" + primary.X.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    let nonawait = P{X: Effects.Mark("E", 8), A: await Effects.MarkAsync("A", 4)}
    Console.WriteLine(nonawait.A.ToString() + "/" + nonawait.X.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    let symbolic = G[LocalValue]{X: await Effects.MarkAsync("E", 9), Value: await ReadLocal(), Y: await Effects.MarkAsync("F", 10)}
    Console.WriteLine(symbolic.Value.N.ToString() + "/" + symbolic.X.ToString() + "/" + symbolic.Y.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    let generic = await Make[LocalValue](LocalValue{N: 6})
    Console.WriteLine(generic.Value.N.ToString() + "/" + generic.X.ToString() + "/" + generic.Y.ToString() + ":" + Effects.Trace)
    Effects.Trace = ""
    try {
        let bad = S{X: throw InvalidOperationException("field"), Y: await Effects.MarkAsync("E", 9)}
        Console.WriteLine(bad.Y)
    } catch (error InvalidOperationException) {
        Console.WriteLine(Effects.Trace + ":" + error.Message)
    }
    Effects.Trace = ""
    try {
        let bad = S{Z: throw InvalidOperationException("property"), Y: await Effects.MarkAsync("E", 9)}
        Console.WriteLine(bad.Y)
    } catch (error InvalidOperationException) {
        Console.WriteLine(Effects.Trace + ":" + error.Message)
    }
    Effects.Trace = ""
    try {
        let bad = Local{X: throw InvalidOperationException("field"), Y: await Effects.MarkAsync("E", 9)}
        Console.WriteLine(bad.Y)
    } catch (error InvalidOperationException) {
        Console.WriteLine(Effects.Trace + ":" + error.Message)
    }
    Effects.Trace = ""
    Effects.Throws = true
    try {
        let bad = S{X: await Effects.MarkAsync("E", 9)}
        Console.WriteLine(bad.X)
    } catch (error InvalidOperationException) {
        Console.WriteLine(Effects.Trace + ":" + error.Message)
    }
    Effects.Trace = ""
    try {
        let bad = Local{X: await Effects.MarkAsync("E", 9)}
        Console.WriteLine(bad.X)
    } catch (error InvalidOperationException) {
        Console.WriteLine(Effects.Trace + ":" + error.Message)
    }
}
Run().GetAwaiter().GetResult()`
        Assert.Equal(
            ExpectedConsoleBytes(
                "9:DBE\n8:DLE\n3/9:ADE\n4/8:ADE\n5/9/10:ADEF\n6/9/10:DEF\nDB:field\nDB:property\nDL:field\nD:default\nD:default\n"
            ),
            CompileAndRunExact(source, library, "asyncphase5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_RecursiveSymbolicCollectionZeros(useReferenceAssembly bool) {
        const library = `package recursive5296
public data struct Child[T] {
    public var Items []T
    public var Fixed [2]T
    public var X int32 = 7
}
public data struct Middle[T] { public var Value Child[T] }
public data struct Direct[T](Value Child[T])
public data struct Box[T](Value Middle[T]) { public var Other int32 }`
        const source = `import recursive5296
import System
import System.Threading.Tasks
data struct Local { public var X int32 }
func Lengths[T]() int32 {
    let first = Direct[T]{}
    let second = Box[T]{}
    return first.Value.Items.Length + first.Value.Fixed.Length * 10 + second.Value.Value.Fixed.Length * 100 + second.Value.Value.X * 1000
}
async func Make[T]() Box[T] -> Box[T]{Other: await Task.FromResult(3)}
func Stream[T]() sequence[Box[T]] { yield Box[T]{} }
let value = recursive5296.Box[Local]{}
Console.WriteLine(value.Value.Value.Items.Length)
Console.WriteLine(value.Value.Value.Fixed.Length)
Console.WriteLine(value.Value.Value.X)
Console.WriteLine(Lengths[Local]())
Console.WriteLine(Lengths[int32]())
let awaited = Make[Local]().GetAwaiter().GetResult()
Console.WriteLine(awaited.Other + awaited.Value.Value.Items.Length)
for item in Stream[Local]() {
    Console.WriteLine(item.Value.Value.Fixed.Length)
}`
        Assert.Equal(
            ExpectedConsoleBytes("0\n2\n0\n220\n220\n3\n2\n"),
            CompileAndRunExact(source, library, "recursive5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ConstructorOwnedReview_SourceOwnedNestedReadonlyZeros(useReferenceAssembly bool, readonlyParent bool) {
        let library = `package sourceownedzero5296
import System
import System.Linq.Expressions
public class Effects {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return 7
        }
    }
}
data struct Child { public let Items []int32 }
data struct Parent {
    OWNER_FIELD Value Child
    public var X int32 = Effects.Next()
    public prop Length int32 { get { return Value.Items.Length } }
}
data struct Box(Value Parent)
public func Run() string {
    var bare Parent
    let first = bare.Length.ToString() + "/" + bare.X.ToString() + "/" + Effects.Count.ToString()
    let tree Expression[Func[Box]] = () -> Box{}
    let nested = tree.Compile()()
    let second = nested.Value.Length.ToString() + "/" + nested.Value.X.ToString() + "/" + Effects.Count.ToString()
    let fresh = Parent{}
    return first + "\n" + second + "\n" + fresh.Length.ToString() + "/" + fresh.X.ToString() + "/" + Effects.Count.ToString()
}`.Replace(
            "OWNER_FIELD",
            if readonlyParent {
                "public let"
            } else {
                "private var"
            }
        )
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("0/0/0\n0/0/0\n0/7/1" + Environment.NewLine),
            CompileAndRunExact(
                "import sourceownedzero5296\nSystem.Console.WriteLine(Run())",
                library,
                "sourceownedzero5296",
                useReferenceAssembly
            )
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ConstructorOwnedReview_ReifiedNestedGenericCopies(useReferenceAssembly bool, isClass bool) {
        let library = `package reifiedcopy5296
import System.Collections.Generic
public class Effects {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return Count
        }
    }
}
public data DECLARATION_KIND S[T](Value T) { public var X int32 = Effects.Next() }
public data struct Holder[T] {
    public var Value S[List[int32]] = S[List[int32]]{Value: List[int32]()}
}`.Replace(
            "DECLARATION_KIND",
            if isClass {
                "class"
            } else {
                "struct"
            },
            StringComparison.Ordinal
        )
        const source = `import reifiedcopy5296
import System
let holder = Holder[string?]{}
let original = holder.Value
let copied = original with{}
Console.WriteLine(copied.Value.Count)
Console.WriteLine(copied.X)
Console.WriteLine(Effects.Count)
original.Value.Add(4)
Console.WriteLine(copied.Value[0])`
        Assert.Equal(
            ExpectedConsoleBytes("0\n1\n1\n4\n"),
            CompileAndRunExact(source, library, "reifiedcopy5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_PrivateNestedSoundZeroRejected(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package privatezero5296
public data struct Child[T] { public var Items []T }
public data struct Middle[T](Value Child[T])
public data struct Box[T](Value Middle[T])`, "privatezero5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(
            "import privatezero5296\nlet bad = Box[int32]{}",
            "rejected",
            executable: true,
            "/r:" + selected,
            "/refout:" + rejectedReference
        )
        Assert.NotEqual(0, code)
        Assert.Contains("rejected.gs(2,11,2,14): error GS0127:", output)
        Assert.Equal(1, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_AuthoredSourceLiteralTrees(useReferenceAssembly bool) {
        const library = `package authoredtree5296
import System
import System.Linq.Expressions
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Mark("D", 7)
    public init() {
        Effects.Trace = Effects.Trace + "B"
        X += 1
    }
}
public data struct Stored {
    private var Items []int32
    public var X int32 = Effects.Mark("D", 7)
    public prop Length int32 { get { return Items.Length } }
    public init() {
        Effects.Trace = Effects.Trace + "B"
        X += 1
    }
}
public func Run() string {
    Effects.Trace = ""
    let first Expression[Func[S]] = () -> S{}
    let before = Effects.Trace
    let value = first.Compile()()
    let result = before + ":" + Effects.Trace + ":" + value.X.ToString()
    Effects.Trace = ""
    let second Expression[Func[S]] = () -> S{X: Effects.Mark("E", 9)}
    let other = second.Compile()()
    let middle = ":" + Effects.Trace + ":" + other.X.ToString()
    Effects.Trace = ""
    let third Expression[Func[Stored]] = () -> Stored{}
    let stored = third.Compile()()
    return result + "\n" + middle + "\n" + stored.Length.ToString() + ":" + Effects.Trace + ":" + stored.X.ToString()
}`
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes(":DB:8\n:DBE:9\n0:DB:8" + Environment.NewLine),
            CompileAndRunExact(
                "import authoredtree5296\nSystem.Console.WriteLine(Run())",
                library,
                "authoredtree5296",
                useReferenceAssembly
            )
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_RequiredOrdinaryArguments(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package required5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Next() int32 {
            Trace = Trace + "D"
            return 7
        }
    }
}
public data struct Required(A int32) { public var X int32 = Effects.Next() }
public data struct Optional(A int32 = 17) { public var X int32 = Effects.Next() }
public data struct Secondary(A int32) {
    public var X int32 = Effects.Next()
    public init() {
        A = 8
        Effects.Trace = Effects.Trace + "B"
    }
}`, "required5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import required5296
import System
Console.WriteLine(Optional().A)
Console.WriteLine(Optional{}.A)
Console.WriteLine(Required(6).A)
Console.WriteLine(Required{}.A)
Console.WriteLine(Secondary().A)
Console.WriteLine(Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("17\n0\n6\n0\n8\nDDDDDB\n"), fixture.RunBytes(consumer))
        for var i = 0; i < 2; i++ {
            let name = "rejected" + i.ToString()
            let call = if i == 0 {
                "Required()"
            } else {
                "required5296.Required()"
            }
            let rejectedReference = Path.Combine(fixture.Directory, name + ".ref.dll")
            let (code, output) = fixture.TryCompile(
                "import required5296\nlet bad = " + call,
                name,
                executable: true,
                "/r:" + selected,
                "/refout:" + rejectedReference
            )
            Assert.NotEqual(0, code)
            Assert.True(
                output.Contains(
                    name +
                        (
                        if i == 0 {
                            ".gs(2,20,2,21): error GS0144:"
                        } else {
                            ".gs(2,24,2,32): error GS0267:"
                        }
                    ),
                    StringComparison.Ordinal
                ),
                output
            )
            Assert.Equal(
                1,
                output.Split(
                    if i == 0 {
                        "error GS0144:"
                    } else {
                        "error GS0267:"
                    },
                    StringSplitOptions.None
                )
                    .Length - 1
            )
            Assert.False(File.Exists(Path.Combine(fixture.Directory, name + ".dll")))
            Assert.False(File.Exists(rejectedReference))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_SymbolicPrimaryCollectionZeros(useReferenceAssembly bool) {
        const library = `package symbolic5296
public data struct Box[T](Items []T)
public data struct Fixed[T](Items [2]T)`
        const source = `import symbolic5296
import System
data struct Local { public var X int32 }
func Lengths[T]() int32 {
    let simple = Box[T]{}
    let qualified = symbolic5296.Box[T]{}
    let fixed = symbolic5296.Fixed[T]{}
    return simple.Items.Length * 100 + qualified.Items.Length * 10 + fixed.Items.Length
}
let qualified = symbolic5296.Box[Local]{}
let fixed = symbolic5296.Fixed[Local]{}
Console.WriteLine(qualified.Items.Length)
Console.WriteLine(fixed.Items.Length)
Console.WriteLine(Lengths[Local]())
Console.WriteLine(Lengths[int32]())`
        Assert.Equal(
            ExpectedConsoleBytes("0\n2\n2\n2\n"),
            CompileAndRunExact(source, library, "symbolic5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_ExpressionTreeNestedSoundZero(useReferenceAssembly bool) {
        const library = `package treezero5296
import System
import System.Linq.Expressions
public class Effects {
    shared {
        public var Trace string = ""
        public func Next() int32 {
            Trace = Trace + "D"
            return 7
        }
    }
}
public data struct Child {
    public var Items []int32
    public var X int32 = Effects.Next()
}
public data struct Box(Value Child)
public func LocalTree() int32 {
    let tree Expression[Func[Box]] = () -> Box{}
    return tree.Compile()().Value.X
}`
        const source = `import treezero5296
import System
import System.Linq.Expressions
Console.WriteLine(LocalTree().ToString() + ":" + Effects.Trace)
let native = Box{}
Console.WriteLine(native.Value.X.ToString() + "/" + native.Value.Items.Length.ToString() + ":" + Effects.Trace)
let tree Expression[Func[Box]] = () -> Box{}
Console.WriteLine("factory:" + Effects.Trace)
let value = tree.Compile()()
Console.WriteLine(value.Value.X.ToString() + "/" + value.Value.Items.Length.ToString() + ":" + Effects.Trace)
let freshTree Expression[Func[Box]] = () -> Box{Value: Child{}}
let fresh = freshTree.Compile()()
Console.WriteLine(fresh.Value.X.ToString() + "/" + fresh.Value.Items.Length.ToString() + ":" + Effects.Trace)`
        Assert.Equal(
            ExpectedConsoleBytes("0:\n0/0:\nfactory:\n0/0:\n7/0:D\n"),
            CompileAndRunExact(source, library, "treezero5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_OrderedReadonlyStores(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package ordered5296
import System.Collections.Generic
public data struct R {
    public let X int32 = 7
    public let Items List[int32] = List[int32]()
    public var Count int32
    public func Add(value int32) { Count = Count + value }
}
public data struct Positional(X int32) {
    public prop X int32 { get; }
    public var Count int32
    public func Add(value int32) { Count = Count + value }
}`, "ordered5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import ordered5296
import System
let first = R{Count: 0, 1}
let second = R{Items: {2}, 3}
Console.WriteLine(first.X.ToString() + "/" + first.Count.ToString())
Console.WriteLine(second.X.ToString() + "/" + second.Count.ToString() + "/" + second.Items.Count.ToString())`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("7/1\n7/3/1\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import ordered5296
let bad = R{X: 9, 1}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("rejected.gs(2,13,2,14): error GS0127:", StringComparison.Ordinal), output)
        Assert.Equal(1, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let primaryConsumer = fixture.Compile(`import ordered5296
import System
let primary = Positional{X: 4, 1}
Console.WriteLine(primary.X.ToString() + "/" + primary.Count.ToString())`, "primaryconsumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(primaryConsumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("4/1\n"), fixture.RunBytes(primaryConsumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_QualifiedForeignRecords(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.CompileCSharpWithReference(`namespace qualified5296;
public record struct Foreign(int X = 17) { public int Y = 3; }
public record struct Authored(int X = 17) {
    public int Y = 3;
    public Authored() : this(8) { Y = 4; }
}
public static class Effects {
    public static string Trace = "";
    public static bool Throw;
    public static int Mark(string mark, int value) {
        Trace += mark;
        if (Throw && mark == "D") throw new System.InvalidOperationException("default");
        return value;
    }
}
public record struct GenericForeign<T>(T Value) {
    public int Stamp { get; } = Effects.Mark("P", 7);
    public int X { get; set; }
}
public record struct GenericAuthored<T>(T Value) {
    public int Stamp { get; } = Effects.Mark("P", 7);
    public int X { get; set; }
    public GenericAuthored() : this(default!) {
        Effects.Mark("D", 0);
        Stamp = 8;
    }
}
public struct Ordinary<T> {
    public T Value;
    public int Stamp;
    public Ordinary(T Value) { this.Value = Value; Stamp = 11; }
}`, "qualified5296", reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import qualified5296
import System
let first = qualified5296.Foreign{}
let second = qualified5296.Foreign{X: 9}
let third = qualified5296.Authored{}
let fourth = qualified5296.Authored{X: 9}
let ordinary = Foreign(3)
Console.WriteLine(first.X.ToString() + "/" + first.Y.ToString())
Console.WriteLine(second.X.ToString() + "/" + second.Y.ToString())
Console.WriteLine(third.X.ToString() + "/" + third.Y.ToString())
Console.WriteLine(fourth.X.ToString() + "/" + fourth.Y.ToString())
Console.WriteLine(ordinary.X.ToString() + "/" + ordinary.Y.ToString())
data struct Local { public var N int32 }
data struct Source[T](Value T)
func Supply(value Local) Source[Local] {
    Effects.Trace = Effects.Trace + "S"
    return Source[Local]{Value: value}
}
func Scoped[T](value T) string {
    let source = Source[T]{Value: value}
    Effects.Trace = ""
    let result = GenericForeign[T]{...source, X: Effects.Mark("E", 6)}
    return result.Stamp.ToString() + "/" + result.X.ToString() + ":" + Effects.Trace
}
let local = Local{N: 3}
let scalar = Source[int32]{Value: 5}
Effects.Trace = ""
let reified = GenericForeign[int32]{...scalar, X: Effects.Mark("E", 9)}
Console.WriteLine(reified.Value.ToString() + "/" + reified.Stamp.ToString() + "/" + reified.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let plain = qualified5296.GenericForeign[Local]{Value: local, X: Effects.Mark("E", 8)}
Console.WriteLine(plain.Value.N.ToString() + "/" + plain.Stamp.ToString() + "/" + plain.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let spread = qualified5296.GenericForeign[Local]{...Supply(local), X: Effects.Mark("E", 9)}
Console.WriteLine(spread.Value.N.ToString() + "/" + spread.Stamp.ToString() + "/" + spread.X.ToString() + ":" + Effects.Trace)
Console.WriteLine(Scoped[Local](local))
Effects.Trace = ""
let authoredPlain = GenericAuthored[Local]{Value: local, X: Effects.Mark("E", 8)}
Console.WriteLine(authoredPlain.Value.N.ToString() + "/" + authoredPlain.Stamp.ToString() + "/" + authoredPlain.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let authoredSpread = GenericAuthored[Local]{...Supply(local), X: Effects.Mark("E", 9)}
Console.WriteLine(authoredSpread.Value.N.ToString() + "/" + authoredSpread.Stamp.ToString() + "/" + authoredSpread.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Effects.Throw = true
try { let rejected = GenericAuthored[Local]{...Supply(local), X: Effects.Mark("E", 9)} }
catch (error Exception) { Console.WriteLine(Effects.Trace + ":" + error.Message) }
Effects.Throw = false
Effects.Trace = ""
let primaryCall = GenericForeign[Local](local)
Console.WriteLine(primaryCall.Value.N.ToString() + "/" + primaryCall.Stamp.ToString() + ":" + Effects.Trace)
let input = Source[Local]{Value: local}
let nonrecord = Ordinary[Local]{...input}
Console.WriteLine(nonrecord.Value.N.ToString() + "/" + nonrecord.Stamp.ToString())`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            ExpectedConsoleBytes(
                "0/0\n9/0\n8/4\n9/4\n3/3\n5/0/9:E\n3/0/8:E\n3/0/9:SE\n0/6:E\n3/8/8:PDE\n3/8/9:SPDE\nSPD:default\n3/7:P\n3/11\n"
            ),
            fixture.RunBytes(consumer)
        )
        const unmappedSource = `import qualified5296
data struct Local { public var N int32 }
data struct Unrelated(Other int32)
let bad = GenericForeign[Local]{...Unrelated{Other: 4}}`
        let rejectedReference = Path.Combine(fixture.Directory, "unmapped.ref.dll")
        let (code, output) = fixture.TryCompile(
            unmappedSource,
            "unmapped",
            executable: true,
            "/r:" + selected,
            "/refout:" + rejectedReference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("unmapped.gs(4,36,4,55): error GS0155:", StringComparison.Ordinal), output)
        Assert.Equal(1, output.Split("error GS0155:", StringSplitOptions.None).Length - 1)
        Assert.False(output.Contains("error GS0267:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "unmapped.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_QualifiedPrimaryPopulation(useReferenceAssembly bool) {
        const library = `package population5296
import System.Collections.Generic
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Box(Items []int32) {
    public var X int32 = Effects.Mark("D", 7)
}
public data struct ListBox(Items List[int32])
public func Local() Box -> Box{Items: {Effects.Mark("E", 4)}}`
        const source = `import population5296
import System
try { let local = Local() }
catch (ex Exception) { Console.WriteLine(Effects.Trace + ":" + ex.GetType().Name) }
Effects.Trace = ""
try { let first = Box{Items: {Effects.Mark("E", 4)}} }
catch (ex Exception) { Console.WriteLine(Effects.Trace + ":" + ex.GetType().Name) }
Effects.Trace = ""
try { let second = population5296.Box{Items: {Effects.Mark("E", 4)}} }
catch (ex Exception) { Console.WriteLine(Effects.Trace + ":" + ex.GetType().Name) }`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(library, "population5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(source, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            ExpectedConsoleBytes("DE:NotSupportedException\nDE:NotSupportedException\nDE:NotSupportedException\n"),
            fixture.RunBytes(consumer)
        )
        for value in[]string{"{1}", "List[int32]()"} {
            let rejectedReference = Path.Combine(fixture.Directory, "duplicate.ref.dll")
            let (code, output) = fixture.TryCompile(
                "import population5296\nimport System.Collections.Generic\nlet bad = population5296.ListBox{Items: List[int32](), Items: " +
                    value +
                    "}",
                "duplicate",
                executable: true,
                "/r:" + selected,
                "/refout:" + rejectedReference
            )
            Assert.NotEqual(0, code)
            Assert.Contains("duplicate.gs(3,56,3,61): error GS0102:", output)
            Assert.Equal(1, output.Split("error GS0102:", StringSplitOptions.None).Length - 1)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "duplicate.dll")))
            Assert.False(File.Exists(rejectedReference))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_GetOnlyPrimaryCalls(useReferenceAssembly bool) {
        const library = `package getter5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Next() int32 {
            Trace = Trace + "E"
            return 7
        }
    }
}
public data struct Box(Value int32 = 5) {
    public prop Value int32 { get; }
}
public func Local() Box -> Box(Effects.Next())`
        const source = `import getter5296
import System
let local = Local()
Console.WriteLine(local.Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let first = Box(Effects.Next())
Console.WriteLine(first.Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Box().Value.ToString() + ":" + Effects.Trace)
Console.WriteLine(Box{}.Value)`
        Assert.Equal(
            ExpectedConsoleBytes("7:E\n7:E\n5:\n0\n"),
            CompileAndRunExact(source, library, "getter5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_GetOnlyPrimaryLiterals(useReferenceAssembly bool) {
        const library = `package getterliteral5296
public data struct Box(Value int32) {
    public prop Value int32 { get; }
}`
        const source = `import getterliteral5296
import System
data struct Local(Value int32) {
    public prop Value int32 { get; }
}
Console.WriteLine(Local{Value: 3}.Value)
Console.WriteLine(Box{Value: 7}.Value)
let qualified = getterliteral5296.Box{Value: 9}
Console.WriteLine(qualified.Value)`
        Assert.Equal(
            ExpectedConsoleBytes("3\n7\n9\n"),
            CompileAndRunExact(source, library, "getterliteral5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_SynthesizedOrdinaryOverloads(useReferenceAssembly bool) {
        const library = `package overload5296
public data struct Primary(A int32) {
    public init(text string) { A = 9 }
}
public data struct Optional {
    public var A int32 = 1
    public init(value int32 = 5) { A = value }
}
public data struct PrimaryOptional(A int32 = 5) {
    public init() { A = 7 }
}
public data struct SynthBody {
    public var X int32 = 7
    func operator explicit(value int32) SynthBody -> SynthBody{X: value}
}
public data struct SynthEmpty() { public var X int32 = 11 }
public func SourceZeroDefaults() int32 -> SynthBody().X * 100 + SynthEmpty().X
public func SourceScalarConversion() int32 -> SynthBody(23).X
public func SourceOptionalDefaults() int32 ->
    Optional().A * 100 + PrimaryOptional().A * 10 + PrimaryOptional{}.A`
        const source = `import overload5296
import System
data struct Local(A int32) {
    public init(text string) { A = 8 }
}
Console.WriteLine(Local(1).A)
Console.WriteLine(Primary(2).A)
Console.WriteLine(Local("x").A)
Console.WriteLine(Primary("x").A)
Console.WriteLine(Optional().A)
Console.WriteLine(Optional(6).A)
Console.WriteLine(Optional{}.A)
Console.WriteLine(PrimaryOptional().A)
Console.WriteLine(PrimaryOptional(6).A)
Console.WriteLine(PrimaryOptional{}.A)
Console.WriteLine(SourceOptionalDefaults())
data struct LocalBody { public var X int32 = 13 }
data struct LocalEmpty() { public var X int32 = 17 }
Console.WriteLine(LocalBody().X)
Console.WriteLine(LocalEmpty().X)
Console.WriteLine(SynthBody().X)
Console.WriteLine(SynthEmpty().X)
Console.WriteLine(SourceZeroDefaults())
Console.WriteLine(SynthBody(23).X)
Console.WriteLine(SourceScalarConversion())`
        Assert.Equal(
            ExpectedConsoleBytes("1\n2\n8\n9\n1\n6\n1\n7\n6\n0\n170\n13\n17\n7\n11\n711\n23\n23\n"),
            CompileAndRunExact(source, library, "overload5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_SynthesizedConstructorChaining(useReferenceAssembly bool) {
        const library = `package chaining5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Default() int32 {
            Trace = Trace + "D"
            return 4
        }
    }
}
public data struct Primary(A int32) {
    public var X int32 = Effects.Default()
    public convenience init(text string) {
        init(7)
        Effects.Trace = Effects.Trace + "B"
    }
}
public data struct Body {
    public var X int32 = Effects.Default()
    public convenience init(text string) {
        init()
        Effects.Trace = Effects.Trace + "B"
        X = 9
    }
}`
        const source = `import chaining5296
import System
let first = Primary("x")
Console.WriteLine(first.A.ToString() + "/" + first.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let second = Body("x")
Console.WriteLine(second.X.ToString() + ":" + Effects.Trace)`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(library, "chaining5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        AssertOrdinaryConstructorMetadata(producer, "Body")
        AssertOrdinaryConstructorMetadata(reference, "Body")
        let implementationBytes = File.ReadAllBytes(producer)
        let referenceBytes = File.ReadAllBytes(reference)
        fixture.Compile(library, "chaining5296", executable: false, "/refout:" + reference)
        Assert.Equal(implementationBytes, File.ReadAllBytes(producer))
        Assert.Equal(referenceBytes, File.ReadAllBytes(reference))
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(source, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("7/4:DB\n9:DB\n"), fixture.RunBytes(consumer))
        let csharp = fixture.CompileCSharp(`using System;
using chaining5296;
namespace CSharpConstruction;
public static class Native {
    public static string Run() {
        var first = new Primary("x");
        var result = first.A + "/" + first.X + ":" + Effects.Trace + "\n";
        Effects.Trace = "";
        var second = new Body("x");
        return result + second.X + ":" + Effects.Trace + "\n";
    }
}`, "csharp", selected)
        IlVerifier.Verify(csharp, []string{producer})
        let csharpConsumer = fixture.Compile(`import System
import CSharpConstruction
Console.Write(Native.Run())`, "csharpconsumer", executable: true, "/r:" + csharp, "/r:" + selected)
        IlVerifier.Verify(csharpConsumer, []string{producer, csharp})
        Assert.Equal(System.Text.Encoding.UTF8.GetBytes("7/4:DB\n9:DB\n"), fixture.RunBytes(csharpConsumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_NestedReadonlyConstructorStorage(useReferenceAssembly bool) {
        const library = `package nestedreadonly5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Child {
    public let Items []int32
    public var X int32 = Effects.Mark("D", 7)
}`
        const source = `import nestedreadonly5296
import System
data struct Parent {
    public var Before int32 = Effects.Mark("P", 1)
    public var Value Child = Child{}
    public var After int32 = Effects.Mark("A", 2)
}
let first = Parent{}
Console.WriteLine(first.Value.X.ToString() + "/" + first.Value.Items.Length.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let raw = default(Parent)
let array = [1]Parent{}
Console.WriteLine(raw.Value.X.ToString() + "/" + array[0].Value.X.ToString() + ":" + Effects.Trace)`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(library, "nestedreadonly5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(source, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("7/0:PDA\n0/0:\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import nestedreadonly5296
data struct Parent {
    public var Value Child = Child{}
}
var bare Parent`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("rejected.gs(5,1,5,16): error GS0127:", StringComparison.Ordinal), output)
        Assert.Equal(1, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedReview_GenericPrimaryConstructorIdentity(useReferenceAssembly bool) {
        const library = `package collision5296
import System
import System.Linq.Expressions
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S[T](Value T) {
    public var X int32 = Effects.Mark("D", 7)
    public init(other int32) {
        Value = default(T)
        Effects.Trace = Effects.Trace + "A"
    }
}
public data struct Empty[T]() { public var X int32 = Effects.Mark("D", 7) }
public func Local() int32 -> S[int32]{Value: 5}.Value
public func LocalTree() int32 {
    let tree Expression[Func[S[int32]]] = () -> S[int32]{Value: Effects.Mark("V", 8)}
    if Effects.Trace != "" {
        return -100
    }
    return tree.Compile()().Value
}
public func LocalGenericTree[T](value T) T {
    let tree Expression[Func[S[T]]] = () -> S[T]{Value: value}
    return tree.Compile()().Value
}
public func LocalAuthoredTree() int32 {
    let tree Expression[Func[S[int32]]] = () -> S[int32](other: 12)
    return tree.Compile()().Value
}
public func ErasedTree[T]() Expression[Func[object]] {
    let factory () -> Expression[Func[object]] = () -> () -> Empty[T]{}
    return factory()
}`
        const source = `import collision5296
import System
import System.Linq.Expressions
func Make[T](value T) T -> S[T]{Value: value}.Value
func ImportedErasedTree[T]() Expression[Func[object]] {
    let factory () -> Expression[Func[object]] = () -> () -> Empty[T]{}
    return factory()
}
Console.WriteLine(Local().ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let first = S[int32]{Value: Effects.Mark("V", 5)}
Console.WriteLine(first.Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let second = collision5296.S[int32]{Value: Effects.Mark("V", 9)}
Console.WriteLine(second.Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Make[int32](6).ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(LocalTree().ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let tree Expression[Func[S[int32]]] = () -> S[int32]{Value: Effects.Mark("V", 7)}
Console.WriteLine("factory:" + Effects.Trace)
Console.WriteLine(tree.Compile()().Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(LocalGenericTree[int32](10).ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(LocalAuthoredTree().ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let authoredTree Expression[Func[S[int32]]] = () -> S[int32](other: 12)
Console.WriteLine(authoredTree.Compile()().Value.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(ErasedTree[int32]().Compile()().GetType().Name + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(ImportedErasedTree[int32]().Compile()().GetType().Name + ":" + Effects.Trace)`
        Assert.Equal(
            ExpectedConsoleBytes(
                "5:D\n5:VD\n9:VD\n6:D\n8:VD\nfactory:\n7:VD\n10:D\n0:DA\n0:DA\nEmpty`1:D\nEmpty`1:D\n"
            ),
            CompileAndRunExact(source, library, "collision5296", useReferenceAssembly)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_EmptyPrimaryParity(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package constructor5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Next() int32 {
            Trace = Trace + "I"
            return 1
        }
    }
}
public data struct S() {
    public var X int32 = Effects.Next()
}`, "constructor5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import constructor5296
import System
data struct Local() {
    public var X int32 = Effects.Next()
}
let local = Local{}
Console.WriteLine(local.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let imported = S{}
Console.WriteLine(imported.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let localOverride = Local{X: 9}
Console.WriteLine(localOverride.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let importedOverride = S{X: 9}
Console.WriteLine(importedOverride.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let ordinary = S()
Console.WriteLine(ordinary.X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("1:I\n1:I\n9:I\n9:I\n1:I\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_DefaultOverrideAndExpressionTree(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package phases5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Value(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Value("D", 7)
}
public data struct Plain {
    public var X int32 = 7
}
public data struct Primary(A int32, B int32 = 5) {
    public var X int32 = Effects.Value("D", 7)
}`, "phases5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import phases5296
import System
import System.Linq.Expressions
data struct Local {
    public var X int32 = Effects.Value("D", 7)
}
let local = Local{X: Effects.Value("E", 9)}
Console.WriteLine(Effects.Trace + ":" + local.X.ToString())
Effects.Trace = ""
let imported = S{X: Effects.Value("E", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.X.ToString())
Effects.Trace = ""
let tree Expression[Func[S]] = () -> S{}
Console.WriteLine("tree:" + Effects.Trace)
let compiled = tree.Compile()
let fromTree = compiled()
Console.WriteLine(Effects.Trace + ":" + fromTree.X.ToString())
let literalTree Expression[Func[Plain]] = () -> Plain{}
let literalFactory = literalTree.Compile()
Console.WriteLine(literalFactory().X)
Effects.Trace = ""
let overrideTree Expression[Func[S]] = () -> S{X: Effects.Value("E", 9)}
Console.WriteLine("tree:" + Effects.Trace)
Console.WriteLine(overrideTree.Compile()().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let primaryTree Expression[Func[Primary]] = () -> Primary{B: Effects.Value("Q", 2), A: Effects.Value("A", 3), X: Effects.Value("E", 9)}
Console.WriteLine("tree:" + Effects.Trace)
let primary = primaryTree.Compile()()
Console.WriteLine(Effects.Trace + ":" + primary.A.ToString() + "/" + primary.B.ToString() + "/" + primary.X.ToString())
Effects.Trace = ""
let rawTree Expression[Func[S]] = () -> default(S)
Console.WriteLine(rawTree.Compile()().X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            ExpectedConsoleBytes("DE:9\nDE:9\ntree:\nD:7\n7\ntree:\n9:DE\ntree:\nQADE:3/2/9\n0:\n"),
            fixture.RunBytes(consumer)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ReadonlyDefaultsAndConstructorUseAnchors(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package readonly5296
public data struct R {
    public let X int32 = 7
}`, "readonly5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import readonly5296
class Holder {
    public var Value R = R{}
}
let first = Holder{}
let second = Holder{}
System.Console.WriteLine(first.Value.X)
System.Console.WriteLine(second.Value.X)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("7\n7\n"), fixture.RunBytes(consumer))
        let (code, output) = fixture.TryCompile(`import readonly5296
let x = R{X: 9}`, "rejected", executable: true, "/r:" + selected)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,12): error GS0127:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        let rejectedReference = Path.Combine(fixture.Directory, "anchored.ref.dll")
        let (anchorCode, anchorOutput) = fixture.TryCompile(`import readonly5296
class Holder {
    public var Value R = R{X: 9}
}
let first = Holder{}
let second = Holder{}`, "anchored", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(anchorCode != 0, anchorOutput)
        for location in[]string{"(3,28,3,29)", "(5,13,5,19)", "(6,14,6,20)"} {
            Assert.True(
                anchorOutput.Contains("anchored.gs" + location + ": error GS0127:", StringComparison.Ordinal),
                anchorOutput
            )
        }
        Assert.Equal(3, anchorOutput.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "anchored.dll")))
        Assert.False(File.Exists(rejectedReference))
        AssertOrdinaryConstructorMetadata(producer, "R")
        AssertOrdinaryConstructorMetadata(reference, "R")
        AssertConstructorStores(consumer, "readonly5296", "R", "X")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_PrimaryAuthoredAndGenericPhases(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package policy5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Primary(A int32, B int32 = 5) {
    public var X int32 = Effects.Mark("D", 7)
}
public data struct Authored {
    public var X int32 = Effects.Mark("D", 7)
    public init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
    public convenience init(value int32) {
        init()
        X = value
    }
}
public data struct Overloaded {
    public var X int32 = Effects.Mark("D", 7)
    public init(unused int32) {
        Effects.Trace = Effects.Trace + "P"
        X = 99
    }
}
public data struct EmptyPrimary() {
    public var X int32 = Effects.Mark("D", 7)
    public init(unused int32) {
        Effects.Trace = Effects.Trace + "P"
        X = 99
    }
}
public data struct Private[T] {
    private var Hidden int32 = Effects.Mark("H", 3)
    public var X int32 = Effects.Mark("D", 7)
    public func ReadHidden() int32 -> Hidden
}
public data struct Generic[T](Value T) {
    public var X int32 = Effects.Mark("D", 7)
}
public data struct Required(Value managed[int32]) {
}`, "policy5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import policy5296
import System
func Make[T](value T) int32 {
    let item = Generic[T]{Value: value, X: Effects.Mark("E", 9)}
    return item.X
}
func RequiredControl() int32 {
    var input = 42
    let required = Required{Value: managed(input)}
    return *required.Value
}
let first = Primary{A: Effects.Mark("A", 3), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + first.A.ToString() + "/" + first.B.ToString() + "/" + first.X.ToString())
Effects.Trace = ""
let reversed = Primary{B: Effects.Mark("Q", 2), A: Effects.Mark("A", 1), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + reversed.A.ToString() + "/" + reversed.B.ToString() + "/" + reversed.X.ToString())
Effects.Trace = ""
let ordinary = Primary(3)
Console.WriteLine(Effects.Trace + ":" + ordinary.A.ToString() + "/" + ordinary.B.ToString() + "/" + ordinary.X.ToString())
Effects.Trace = ""
let authored = Authored{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + authored.X.ToString())
Effects.Trace = ""
Console.WriteLine(Authored().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Authored(5).X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded{}.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(Overloaded(1).X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary{}.X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary().X.ToString() + ":" + Effects.Trace)
Effects.Trace = ""
let hidden = Private[int32]{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + hidden.ReadHidden().ToString() + "/" + hidden.X.ToString())
Effects.Trace = ""
Console.WriteLine(Make[int32](42).ToString() + ":" + Effects.Trace)
Console.WriteLine(RequiredControl())`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            ExpectedConsoleBytes(
                "ADE:3/0/9\nQADE:1/2/9\nD:3/5/7\nDBE:9\n8:DB\n5:DB\n7:D\n7:D\n99:DP\n7:D\n7:D\nHDE:3/9\n9:DE\n42\n"
            ),
            fixture.RunBytes(consumer)
        )
        AssertOrdinaryConstructorMetadata(producer, "Overloaded")
        AssertOrdinaryConstructorMetadata(reference, "Overloaded")
        let rejectedReference = Path.Combine(fixture.Directory, "required.ref.dll")
        let (code, output) = fixture.TryCompile(`import policy5296
let bad = Required{}`, "required", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("required.gs(2,11,2,21): error GS0604:", StringComparison.Ordinal), output)
        Assert.Equal(1, output.Split("error GS0604:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "required.dll")))
        Assert.False(File.Exists(rejectedReference))
        let duplicateReference = Path.Combine(fixture.Directory, "duplicate.ref.dll")
        let (duplicateCode, duplicateOutput) = fixture.TryCompile(`data struct Duplicate() {
    public init() {}
}`, "duplicate", executable: false, "/refout:" + duplicateReference)
        Assert.NotEqual(0, duplicateCode)
        Assert.True(
            duplicateOutput.Contains("duplicate.gs(2,12,2,16): error GS0284:", StringComparison.Ordinal),
            duplicateOutput
        )
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "duplicate.dll")))
        Assert.False(File.Exists(duplicateReference))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ThrowingDefaultsAndStaticInitialization(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package throws5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
        public func Fail() int32 {
            Trace = Trace + "D"
            throw System.InvalidOperationException("default")
        }
    }
}
public data struct Throwing {
    public var X int32 = Effects.Fail()
}
public data struct Static {
    public var X int32 = Effects.Mark("D", 7)
    shared { init { Effects.Trace = Effects.Trace + "S" } }
}
public data struct StaticPrimary(A int32) {
    public var X int32 = Effects.Mark("D", 7)
    shared { init { Effects.Trace = Effects.Trace + "S" } }
}`, "throws5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import throws5296
import System
try {
    let value = Throwing{X: Effects.Mark("E", 9)}
    Console.WriteLine(value.X)
} catch (error InvalidOperationException) {
    Console.WriteLine(Effects.Trace + ":" + error.Message)
}
Effects.Trace = ""
let first = Static{X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + first.X.ToString())
Effects.Trace = ""
let second = StaticPrimary{A: Effects.Mark("A", 1), X: Effects.Mark("E", 9)}
Console.WriteLine(Effects.Trace + ":" + second.X.ToString())`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("D:default\nSDE:9\nASDE:9\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_CSharpConsumerAndDeterministicMetadata(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        const source = `package native5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct S {
    public var X int32 = Effects.Mark("D", 7)
    private var Hidden int32 = 3
    public func ReadHidden() int32 -> Hidden
}
public data struct Empty {}
public data struct Readonly {
    public let X int32 = 7
}
public data struct Generic[T](Value T, Other int32 = 5) {
    public var X int32 = Effects.Mark("D", 7)
}`
        let producer = fixture.Compile(source, "native5296", executable: false, "/refout:" + reference)
        let firstImplementation = File.ReadAllBytes(producer)
        let firstReference = File.ReadAllBytes(reference)
        fixture.Compile(source, "native5296", executable: false, "/refout:" + reference)
        Assert.Equal(firstImplementation, File.ReadAllBytes(producer))
        Assert.Equal(firstReference, File.ReadAllBytes(reference))
        IlVerifier.Verify(producer)
        AssertOrdinaryConstructorMetadata(producer, "S")
        AssertOrdinaryConstructorMetadata(reference, "S")
        AssertOrdinaryConstructorMetadata(producer, "Empty")
        AssertOrdinaryConstructorMetadata(reference, "Empty")
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let native = fixture.CompileCSharp(`using native5296;
namespace Native5296Consumer;
public static class NativeConsumer {
    public static string Run() {
        Effects.Trace = "";
        var first = new S { X = Effects.Mark("E", 9) };
        var trace = Effects.Trace + ":" + first.X + "/" + first.ReadHidden();
        Effects.Trace = "";
        var second = new Generic<int>(3) { X = Effects.Mark("E", 9) };
        trace += "\n" + Effects.Trace + ":" + second.Value + "/" + second.Other + "/" + second.X;
        Effects.Trace = "";
        var raw = default(S);
        var array = new S[1];
        return trace + "\n" + raw.X + "/" + array[0].X + ":" + Effects.Trace + "\n" + new Readonly().X;
    }
}`, "NativeConsumer", selected)
        IlVerifier.Verify(native, []string{producer})
        let consumer = fixture.Compile(`import Native5296Consumer
System.Console.WriteLine(NativeConsumer.Run())`, "consumer", executable: true, "/r:" + selected, "/r:" + native)
        IlVerifier.Verify(consumer, []string{producer, native})
        Assert.Equal(
            System.Text.Encoding.UTF8.GetBytes("DE:9/3\nDE:3/5/9\n0/0:\n7" + Environment.NewLine),
            fixture.RunBytes(consumer)
        )
        let rejected = CSharpCompilation.Create(
            "rejected",
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`using native5296;
public static class Bad {
    public static Readonly Run() => new Readonly { X = 9 };
}`, path: "rejected.cs")},
            cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                .Split(Path.PathSeparator)
                .Append(selected)
                .Select((path string) -> MetadataReference.CreateFromFile(path)),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let image = MemoryStream()
        let rejection = rejected.Emit(image)
        Assert.False(rejection.Success)
        let error = Assert.Single(
            rejection.Diagnostics.Where(
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
        )
        Assert.Equal("CS0191", error.Id)
        let location = error.Location.GetLineSpan()
        Assert.Equal("rejected.cs", location.Path)
        Assert.Equal(2, location.StartLinePosition.Line)
        Assert.Equal(51, location.StartLinePosition.Character)
        Assert.Equal(52, location.EndLinePosition.Character)
        Assert.Equal(0, image.Length)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_AuthoredAccessibilityAndFriendMetadata(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package access5296
@assembly:InternalsVisibleTo("consumer")
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Secret {
    public var X int32 = Effects.Mark("D", 7)
    private init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
    shared { public func Create() Secret -> Secret{} }
}
public data struct Friend {
    public var X int32 = Effects.Mark("D", 7)
    internal func init() {
        Effects.Trace = Effects.Trace + "B"
        X = 8
    }
}`, "access5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import access5296
import System
let own = Secret.Create()
Console.WriteLine(Effects.Trace + ":" + own.X.ToString())
Effects.Trace = ""
let friend = Friend{}
Console.WriteLine(Effects.Trace + ":" + friend.X.ToString())`, "consumer", executable: true, "/assemblyname:consumer", "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("DB:8\nDB:8\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import access5296
let bad = Secret{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,17): error GS0267:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Theory
    @InlineData(false, 0)
    @InlineData(true, 0)
    @InlineData(false, 1)
    @InlineData(true, 1)
    @InlineData(false, 2)
    @InlineData(true, 2)
    @InlineData(false, 3)
    @InlineData(true, 3)
    func ConstructorOwnedDataStruct_LegacyMissingConstructorAndForeignZero(
        useReferenceAssembly bool,
        projection int32
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const declarations = `#nullable enable
namespace legacy5296;
public struct Legacy { public int X; }
public record struct Collection(int[] Items);
public record struct NullableCollection(int[]? Items);
public record struct Foreign(int X = 17) { public int Y = 3; }
public record struct Authored {
    public int X = 7;
    public Authored() { X = 8; }
}
public record struct GenericCollection<T>(T[] Items);
public struct GenericLegacy<T> { public readonly T Value; }`
        let probe = fixture.CompileCSharp(declarations, "Probe")
        var legacyToken = 0
        var collectionToken = 0
        var nullableCollectionToken = 0
        var genericCollectionToken = 0
        var genericLegacyToken = 0
        {
            using let stream = File.OpenRead(probe)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            legacyToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == "Legacy"
                )
            )
            collectionToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(
                        reader.GetTypeDefinition(handle).Name
                    ) == "Collection"
                )
            )
            nullableCollectionToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(
                        reader.GetTypeDefinition(handle).Name
                    ) == "NullableCollection"
                )
            )
            genericCollectionToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(
                        reader.GetTypeDefinition(handle).Name
                    ) == "GenericCollection`1"
                )
            )
            genericLegacyToken = MetadataTokens.GetToken(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(
                        reader.GetTypeDefinition(handle).Name
                    ) == "GenericLegacy`1"
                )
            )
        }
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.CompileCSharpWithReference(
            "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" + legacyToken.ToString(
                System.Globalization.CultureInfo.InvariantCulture
            ) +
                "|struct|1||closed\")]\n" +
                "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" +
                collectionToken.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "|struct|1|Items:0|closed\")]\n" +
                "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" +
                nullableCollectionToken.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "|struct|1|Items:0|closed\")]\n" +
                "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" +
                genericCollectionToken.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "|struct|1|Items:0|closed\")]\n" +
                "[assembly: System.Reflection.AssemblyMetadata(\"GSharp.TypeSemantics\", \"" +
                genericLegacyToken.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "|struct|1||closed\")]\n" +
                declarations,
            "legacy5296",
            reference
        )
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import legacy5296
let bad = Legacy{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,11,2,17): error GS0267:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let genericLegacyReference = Path.Combine(fixture.Directory, "genericlegacy.ref.dll")
        let (genericLegacyCode, genericLegacyOutput) = fixture.TryCompile(`import legacy5296
data struct Local { public var N int32 }
data struct Source(Value Local)
let source = Source{Value: Local{N: 1}}
let bad = GenericLegacy[Local]{...source}`, "genericlegacy", executable: true, "/r:" +
                selected, "/refout:" + genericLegacyReference)
        Assert.NotEqual(0, genericLegacyCode)
        Assert.True(
            genericLegacyOutput.Contains("genericlegacy.gs(5,11,5,24): error GS0267:", StringComparison.Ordinal),
            genericLegacyOutput
        )
        Assert.Equal(1, genericLegacyOutput.Split("error GS0267:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "genericlegacy.dll")))
        Assert.False(File.Exists(genericLegacyReference))
        let rejectedCollectionReference = Path.Combine(fixture.Directory, "rejectedcollection.ref.dll")
        let (collectionCode, collectionOutput) = fixture.TryCompile(`import legacy5296
let bad = Collection{}`, "rejectedcollection", executable: true, "/r:" +
                selected, "/refout:" + rejectedCollectionReference)
        Assert.NotEqual(0, collectionCode)
        Assert.True(
            collectionOutput.Contains("rejectedcollection.gs(2,11,2,21): error GS0267:", StringComparison.Ordinal),
            collectionOutput
        )
        Assert.Equal(1, collectionOutput.Split("error GS0267:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejectedcollection.dll")))
        Assert.False(File.Exists(rejectedCollectionReference))
        let projectedSource = switch projection {
            case 1: `
data struct FilledSource { public var Items []int32 = []int32{6} }
let implicitValue Collection = FilledSource{}
Console.WriteLine(implicitValue.Items[0])
func Convert() Collection -> FilledSource{}
Console.WriteLine(Convert().Items[0])`
            case 2: `
let generic = GenericCollection[int32]{...original}
Console.WriteLine(generic.Items[0])
func Supply() Source {
    Console.WriteLine("R")
    return Source{Items: []int32{8}}
}
let qualified = legacy5296.GenericCollection[int32]{...Supply()}
Console.WriteLine(qualified.Items[0])
let replacement = legacy5296.GenericCollection[int32]{...Supply(), Items: []int32{6}}
Console.WriteLine(replacement.Items[0])`
            case 3: `
data struct Local(Value int32)
data struct GenericSource[T](Items []T)
func Project[T](value T) int32 {
    let source = GenericSource[T]{Items: []T{value}}
    let target = GenericCollection[T]{...source}
    return target.Items.Length
}
let source = GenericSource[Local]{Items: []Local{Local{Value: 4}}}
let generic = GenericCollection[Local]{...source}
Console.WriteLine(generic.Items[0].Value)
let qualified = legacy5296.GenericCollection[Local]{...source}
Console.WriteLine(qualified.Items[0].Value)
Console.WriteLine(Project[Local](Local{Value: 7}))`
            default: ""
        }
        let consumer = fixture.Compile(`import legacy5296
import System
let empty = Foreign{}
let supplied = Foreign{X: 9}
let ordinary = Foreign(3)
Console.WriteLine(empty.X.ToString() + "/" + empty.Y.ToString())
Console.WriteLine(supplied.X.ToString() + "/" + supplied.Y.ToString())
Console.WriteLine(ordinary.X.ToString() + "/" + ordinary.Y.ToString())
Console.WriteLine(Authored{}.X)
let collection = Collection{Items: []int32{3}}
Console.WriteLine(collection.Items.Length.ToString() + "/" + collection.Items[0].ToString())
Console.WriteLine(NullableCollection{}.Items == nil)
data struct Source(Items []int32)
let original = Source{Items: []int32{4}}
let projected = Collection{...original}
Console.WriteLine(projected.Items.Length.ToString() + "/" + projected.Items[0].ToString())
let overridden = Collection{...original, Items: []int32{8}}
Console.WriteLine(overridden.Items.Length.ToString() + "/" + overridden.Items[0].ToString())` + projectedSource, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        let projectedOutput = switch projection {
            case 1: "6\n6\n"
            case 2: "4\nR\n8\nR\n6\n"
            case 3: "4\n4\n1\n"
            default: ""
        }
        Assert.Equal(
            ExpectedConsoleBytes("0/0\n9/0\n3/3\n8\n1/3\nTrue\n1/4\n1/8\n" + projectedOutput),
            fixture.RunBytes(consumer)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_ProjectionCopyAndNestedZeroPhases(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package storage5296
public class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Child {
    public var X int32 = Effects.Mark("N", 7)
    public var Items []int32
}
public data struct Target {
    public var A int32
    public var B int32
    public var X int32 = Effects.Mark("D", 7)
    public var Nested Child
}
public data struct Positional(A int32) {
    public var X int32 = Effects.Mark("D", 7)
}`, "storage5296", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import storage5296
import System
data struct Source {
    public var A int32
    public var B int32
    public var X int32
    public var Nested Child
}
let source = Source{A: 3, X: 7}
let first Target = source
Console.WriteLine(Effects.Trace + ":" + first.A.ToString() + "/" + first.X.ToString() + "/" + first.Nested.X.ToString() + "/" + first.Nested.Items.Length.ToString())
Effects.Trace = ""
let second = Target{...source, X: Effects.Mark("E", 9), B: Effects.Mark("B", 2)}
Console.WriteLine(Effects.Trace + ":" + second.A.ToString() + "/" + second.X.ToString() + "/" + second.B.ToString())
Effects.Trace = ""
let third Positional = source
Console.WriteLine(Effects.Trace + ":" + third.A.ToString() + "/" + third.X.ToString())
Effects.Trace = ""
let copied = first with{X = Effects.Mark("E", 8)}
let copiedAgain = first.copy(X: Effects.Mark("C", 9))
Console.WriteLine(Effects.Trace + ":" + copied.X.ToString() + "/" + copiedAgain.X.ToString() + "/" + first.X.ToString())
Effects.Trace = ""
var bare Target
let raw = default(Target)
let array = [1]Target{}
Console.WriteLine(bare.X.ToString() + "/" + bare.Nested.X.ToString() + "/" + bare.Nested.Items.Length.ToString())
Console.WriteLine(raw.X.ToString() + "/" + array[0].X.ToString() + ":" + Effects.Trace)`, "consumer", executable: true, "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(
            ExpectedConsoleBytes("D:3/7/0/0\nDEB:3/9/2\nD:3/7\nEC:8/9/7\n0/0/0\n0/0:\n"),
            fixture.RunBytes(consumer)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_PrimaryConstructorsDoNotExportLiteralInitializers(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296primary
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct EmptyPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
public data struct Primary(Seed int32 = 0) {
    public var X int32 = Effects.Next("I", 1)
}
public data struct NonPrimary {
    public var X int32 = Effects.Next("I", 1)
}`, "i5296primary", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296primary
data struct LocalPrimary() {
    public var X int32 = Effects.Next("I", 1)
}
data struct LocalNonPrimary {
    public var X int32 = Effects.Next("I", 1)
}
let local = LocalPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + local.X.ToString())
Effects.Trace = ""
let imported = EmptyPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.X.ToString())
Effects.Trace = ""
Console.WriteLine(LocalPrimary{}.X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
Console.WriteLine(EmptyPrimary().X)
Console.WriteLine(Effects.Trace)
Effects.Trace = ""
let localNonPrimary = LocalNonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + localNonPrimary.X.ToString())
Effects.Trace = ""
let importedNonPrimary = NonPrimary{X: Effects.Next("E", 9)}
Console.WriteLine(Effects.Trace + ":" + importedNonPrimary.X.ToString())
Effects.Trace = ""
Console.WriteLine(NonPrimary{}.X)
Console.WriteLine(Effects.Trace)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("IE:9\nIE:9\n1\nI\n1\nI\nIE:9\nIE:9\n1\nI\n"), fixture.RunBytes(consumer))
        let assembly = EmittedFixture.Load(producer)
        for name in[]string{"EmptyPrimary", "Primary"} {
            let type = assembly.GetType("i5296primary." + name, throwOnError: true)
            Assert.Null(type!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
        }
        let nonPrimary = assembly.GetType("i5296primary.NonPrimary", throwOnError: true)
        Assert.Null(nonPrimary!!.GetNestedType("<>FieldInitializers", BindingFlags.Public))
        AssertOrdinaryConstructorMetadata(producer, "NonPrimary")
        AssertOrdinaryConstructorMetadata(reference, "NonPrimary")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_NestedReadonlyCollectionDiagnosticsRetainConsumerAnchors(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296anchors
public data struct ReadonlyItems {
    public let Items []int32
    private var Marker int32 = 0
    public func Count() int32 -> Marker + Items.Length
}
public data struct Outer {
    public var Child ReadonlyItems
}
public data struct MutableItems {
    public var Items []int32
}
public data struct MutableOuter {
    public var Child MutableItems
}`, "i5296anchors", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296anchors
class Holder {
    public var Value Outer
}
let first = Holder{}
let second = Holder{}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        for location in[]string{"(3,5,3,27)", "(5,13,5,19)", "(6,14,6,20)"} {
            Assert.True(output.Contains("rejected.gs" + location + ": error GS0127:", StringComparison.Ordinal), output)
        }
        Assert.Equal(3, output.Split("error GS0127:", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
        let consumer = fixture.Compile(`import i5296anchors
System.Console.WriteLine(Outer{}.Child.Count())
class Holder {
    public var Value MutableOuter = MutableOuter{}
}
let omitted = Holder{}
System.Console.WriteLine(omitted.Value.Child.Items.Length)
let supplied = Holder{Value: MutableOuter{Child: MutableItems{Items: []int32{1, 2}}}}
System.Console.WriteLine(supplied.Value.Child.Items.Length)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("0\n0\n2\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyProjectionUsesOwningConstructor(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296projection
public data struct Target {
    public var A int32
    public let X int32 = 7
}
public data struct Mutable {
    public var A int32
    public var X int32 = 7
}`, "i5296projection", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let projected = fixture.Compile(`import i5296projection
data struct Source { public var A int32 }
let source = Source{A: 3}
let target Target = source
System.Console.WriteLine(target.A)
System.Console.WriteLine(target.X)`, "projected", executable: true, "/r:" + selected)
        IlVerifier.Verify(projected, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("3\n7\n"), fixture.RunBytes(projected))
        AssertConstructorStores(projected, "i5296projection", "Target", "X")
        let consumer = fixture.Compile(`import i5296projection
data struct Source {
    public var A int32
    public var X int32
}
let source = Source{A: 3, X: 9}
let target Mutable = source
System.Console.WriteLine(target.A)
System.Console.WriteLine(target.X)
System.Console.WriteLine(default(Target).X)`, "control", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("3\n9\n0\n"), fixture.RunBytes(consumer))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_FriendMixedInitializerSeedsInternalCollection(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296friend
@assembly:InternalsVisibleTo("FriendConsumer")
public class Effects {
    shared {
        public var Trace string = ""
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`, "i5296friend", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let imported = EmittedFixture.Load(File.ReadAllBytes(producer), fixture.Directory).GetType("i5296friend.Basket")
        let field = imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(field!!.IsAssembly)
        Assert.Null(imported!!.GetField("Items", BindingFlags.Instance | BindingFlags.Public))
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import System
import i5296friend
data struct LocalBasket {
    public var Tag int32
    internal var Items []int32
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = LocalBasket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`, "FriendConsumer", executable: true, "/assemblyname:FriendConsumer", "/r:" +
                selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("AE:1,3\nAE:1,3\n"), fixture.RunBytes(consumer))
        let (code, output) = fixture.TryCompile(`import i5296friend
let value = Basket{Items: []int32{}}`, "NonFriend", executable: true, "/assemblyname:NonFriend", "/r:" + selected)
        Assert.True(code != 0, output)
        Assert.Contains("NonFriend.gs(2,20,2,25): error GS0158:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "NonFriend.dll")))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ReadonlyInitializerRejectsExternalWrites(useReferenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let producer = fixture.Compile(`package i5296readonly
public data struct Readonly {
    public let X int32 = 7
}`, "i5296readonly", executable: false, "/refout:" + reference)
        IlVerifier.Verify(producer)
        let selected = if useReferenceAssembly {
            reference
        } else {
            producer
        }
        let consumer = fixture.Compile(`import i5296readonly
System.Console.WriteLine(Readonly{}.X)
System.Console.WriteLine(default(Readonly).X)`, "consumer", executable: true, "/r:" + selected)
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(ExpectedConsoleBytes("7\n0\n"), fixture.RunBytes(consumer))
        let rejectedReference = Path.Combine(fixture.Directory, "rejected.ref.dll")
        let (code, output) = fixture.TryCompile(`import i5296readonly
let value = Readonly{X: 9}`, "rejected", executable: true, "/r:" + selected, "/refout:" + rejectedReference)
        Assert.True(code != 0, output)
        Assert.True(output.Contains("rejected.gs(2,22,2,23): error GS0127:", StringComparison.Ordinal), output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        Assert.False(File.Exists(rejectedReference))
    }

    @Fact
    func ImportedDataStruct_MixedInitializersUseConstructorDefaultsBeforeOrderedPopulation() {
        const expression = "Basket{Tag: 0, 1, Items: Effects.ExplicitItems()}"
        const library = `package i5296mixed
public class Effects {
    shared {
        public var Trace string = ""
        public func DefaultItems() []int32 {
            Trace = Trace + "D"
            return []int32{10, 11}
        }
        public func ExplicitItems() []int32 {
            Trace = Trace + "E"
            return []int32{8, 9, 10}
        }
    }
}
public data struct Basket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}`
        let source = `import System
import i5296mixed
data struct LocalBasket {
    public var Tag int32
    public var Items []int32 = Effects.DefaultItems()
    public func Add(value int32) {
        Effects.Trace = Effects.Trace + "A"
        Tag = Tag + value + Items.Length
    }
}
let local = ` + expression.Replace("Basket", "LocalBasket", StringComparison.Ordinal) + `
Console.WriteLine(Effects.Trace + ":" + local.Tag.ToString() + "," + local.Items.Length.ToString())
Effects.Trace = ""
let imported = ` + expression + `
Console.WriteLine(Effects.Trace + ":" + imported.Tag.ToString() + "," + imported.Items.Length.ToString())`
        Assert.Equal(ExpectedConsoleBytes("DAE:3,3\nDAE:3,3\n"), CompileAndRunExact(source, library, "i5296mixed"))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_ConstantInitializerUsesOrdinaryStaticConstructor(throws bool) {
        let initialization = if throws {
            `System.Console.Write("S")
        throw System.InvalidOperationException("expected static initialization")`
        } else {
            `System.Console.Write("S")`
        }
        let members = `public var Value int32 = 1
    shared { init { ` + initialization + ` } }`
        let library = "package i5296static\npublic data struct Imported {\n" + members + "\n}"
        let source = "import i5296static\ndata struct Local {\n" + members + `
}
try {
    System.Console.WriteLine(Local{}.Value)
} catch (error System.TypeInitializationException) {
    System.Console.WriteLine(error.InnerException?.Message)
}
try {
    System.Console.WriteLine(Imported{}.Value)
} catch (error System.TypeInitializationException) {
    System.Console.WriteLine(error.InnerException?.Message)
}`
        Assert.Equal(
            ExpectedConsoleBytes(
                (
                    if throws {
                        "Sexpected static initialization\nSexpected static initialization\n"
                    } else {
                        "S1\nS1\n"
                    }
                )
            ),
            CompileAndRunExact(source, library, "i5296static")
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDataStruct_OmittedInlineInitializersMatchLocalLiterals(useReferenceAssembly bool) {
        const library = `package i5296defaults
public enum Layout { Stacked, Compact }
public data struct PropertyGrid {
    public var Layout Layout
    public var LabelWidth float64 = 160
}
public data struct SettingsLayoutInput {
    public var SidebarWidth float64 = 180
}`
        const source = `import System
import i5296defaults
data struct LocalGrid {
    public var LabelWidth float64 = 160
}
Console.WriteLine(LocalGrid{}.LabelWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact}.LabelWidth)
Console.WriteLine(SettingsLayoutInput{}.SidebarWidth)
Console.WriteLine(PropertyGrid{Layout: Layout.Compact, LabelWidth: 160}.LabelWidth)`
        Assert.Equal(
            ExpectedConsoleBytes("160\n160\n180\n160\n"),
            CompileAndRunExact(source, library, "i5296defaults", useReferenceAssembly)
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersPreserveOverridesAndEvaluationOrder() {
        const library = `package i5296order
public class Effects {
    shared {
        public var Trace string = ""
        public func Next(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
public data struct Imported {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}`
        const source = `import System
import i5296order
data struct Local {
    public var A int32 = Effects.Next("A", 1)
    public var B int32 = Effects.Next("B", 2)
    public var C int32 = Effects.Next("C", 3)
}
let local = Local{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + local.A.ToString() + "," + local.B.ToString() + "," + local.C.ToString())
Effects.Trace = ""
let imported = Imported{C: Effects.Next("X", 9)}
Console.WriteLine(Effects.Trace + ":" + imported.A.ToString() + "," + imported.B.ToString() + "," + imported.C.ToString())
Effects.Trace = ""
let empty = Imported{}
Console.WriteLine(Effects.Trace + ":" + empty.A.ToString() + "," + empty.B.ToString() + "," + empty.C.ToString())
Effects.Trace = ""
let explicit = Imported{C: Effects.Next("X", 9), B: Effects.Next("Y", 8), A: Effects.Next("Z", 7)}
Console.WriteLine(Effects.Trace + ":" + explicit.A.ToString() + "," + explicit.B.ToString() + "," + explicit.C.ToString())
Effects.Trace = ""
Console.WriteLine(default(Imported).A)
let array = [1]Imported{}
Console.WriteLine(array[0].A)
Console.WriteLine(Effects.Trace.Length)`
        Assert.Equal(
            ExpectedConsoleBytes("ABCX:1,2,9\nABCX:1,2,9\nABC:1,2,3\nABCXYZ:7,8,9\n0\n0\n0\n"),
            CompileAndRunExact(source, library, "i5296order")
        )
    }

    @Fact
    func ImportedDataStruct_InlineInitializersRetainPrivateCallsAndCollectionValues() {
        const library = `package i5296expressions
public data struct Input {
    public var Values []int32 = []int32{Seed()}
    public var Text string = "seed:${Seed()}"
    shared {
        private func Seed() int32 -> 4
    }
}`
        const source = `import System
import i5296expressions
let input = Input{}
Console.WriteLine(input.Values.Length)
if input.Values.Length != 0 {
    Console.WriteLine(input.Values[0])
}
Console.WriteLine(input.Text)`
        Assert.Equal(ExpectedConsoleBytes("1\n4\nseed:4\n"), CompileAndRunExact(source, library, "i5296expressions"))
    }

    @Theory
    @InlineData("Local", false)
    @InlineData("int32", false)
    @InlineData("Local", true)
    func Issue5412_ReadonlyNestedZero_RejectsExternalReconstruction(argument string, primary bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.Compile(`package readonlyzero5412
public data struct Child[T] { public let Items []T }`, "readonlyzero5412", false)
        IlVerifier.Verify(producer)
        let declaration = if primary {
            "data struct Parent(Value Child[" + argument + "])"
        } else {
            "data struct Parent { public var Value Child[" + argument + "] }"
        }
        let source = "import readonlyzero5412\ndata struct Local { public var X int32 }\n" +
            declaration +
            "\nlet value = Parent{}\nSystem.Console.WriteLine(value.Value.Items.Length)"
        let (code, diagnostics) = fixture.TryCompile(source, "rejected", true, "/r:" + producer)
        Assert.NotEqual(0, code)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
        let errors = Regex.Matches(diagnostics, `rejected.gs\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`)
        Assert.Equal(
            if primary {
                "rejected.gs(4,13,4,19): error GS0127:"
            } else {
                "rejected.gs(3,22,3,51): error GS0127:\nrejected.gs(4,13,4,19): error GS0127:"
            },
            string.Join("\n", errors.Cast[Match]().Select((error Match) -> error.Value))
        )
    }

    @Theory
    @InlineData("Local")
    @InlineData("int32")
    func Issue5412_MutableNestedZero_PreservesSymbolicStorageWithoutReplayingDefaults(argument string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.Compile(`package mutablezero5412
public class Effects {
    shared {
        public var Count int32
        public func Next() int32 {
            Count += 1
            return 73
        }
    }
}
public data struct Child[T] {
    public var Items []T
    public var Scalar int32 = Effects.Next()
}`, "mutablezero5412", false, "/deterministic+", "/debug:none")
        IlVerifier.Verify(producer)
        let source = `package consumerzero5412
import mutablezero5412
public data struct Local { public var X int32 }
public data struct Parent { public var Value Child[ARG] }
class Slots { shared { public var Value Child[ARG] } }
func Make() Parent {
    Effects.Count += 1
    return Parent{}
}
func Main() {
    let value = Make() with{}
    var bare Child[ARG]
    let raw = default(Child[ARG])
    System.Console.Write(value.Value.Items.Length)
    System.Console.Write("|")
    System.Console.Write(bare.Items.Length)
    System.Console.Write("|")
    System.Console.Write(Slots.Value.Items.Length)
    System.Console.Write("|")
    System.Console.Write(value.Value.Scalar + bare.Scalar + Slots.Value.Scalar)
    System.Console.Write("|")
    System.Console.Write(Effects.Count)
    System.Console.Write("|")
    System.Console.Write(raw.Items == nil)
}`.Replace("ARG", argument)
        let consumer = fixture.Compile(
            source,
            "consumerzero5412",
            true,
            "/r:" + producer,
            "/deterministic+",
            "/debug:none"
        )
        let first = File.ReadAllBytes(consumer)
        fixture.Compile(source, "consumerzero5412", true, "/r:" + producer, "/deterministic+", "/debug:none")
        Assert.Equal(first, File.ReadAllBytes(consumer))
        IlVerifier.Verify(consumer, []string{producer})
        Assert.Equal(Encoding.UTF8.GetBytes("0|0|0|0|1|True"), fixture.RunBytes(consumer))
        let downstream = fixture.Compile(`import consumerzero5412
var value Parent
System.Console.Write(value.Value.Items.Length)
System.Console.Write("|")
System.Console.Write(value.Value.Scalar)`, "downstream", true, "/r:" + consumer, "/r:" + producer)
        IlVerifier.Verify(downstream, []string{consumer, producer})
        Assert.Equal(Encoding.UTF8.GetBytes("0|0"), fixture.RunBytes(downstream))
    }

    @Fact
    func PlainStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib1

struct S {
    public var Items []int32
}`
        const source = `package i3329a
import i3329lib1

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib1"))
    }

    @Fact
    func DataStruct_EmptyLiteral_SliceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib2

data struct S {
    public var Items []int32
}`
        const source = `package i3329b
import i3329lib2

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib2"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_MapField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib3

struct S {
    public var M map[string, int32]
}`
        const source = `package i3329c
import i3329lib3

func Main() {
    let s = S{}
    System.Console.WriteLine(s.M.Count)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib3"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_SequenceField_ZeroInitializesToEmptyNotNull() {
        const library = `package i3329lib4

struct S {
    public var Seq sequence[int32]
}`
        const source = `package i3329d
import i3329lib4

func Main() {
    let s = S{}
    var n = 0
    for x in s.Seq {
        n = n + 1
    }
    System.Console.WriteLine(n)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib4"))
    }

    @Fact
    func PlainStruct_EmptyLiteral_FixedArrayField_ZeroInitializesToDeclaredLength() {
        const library = `package i3329lib5

struct S {
    public var Buf [4]int32
}`
        const source = `package i3329e
import i3329lib5

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Buf.Length)
}`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source, library, "i3329lib5"))
    }

    @Fact
    func PlainStruct_LiteralWithExplicitFieldInitializer_MagicCollectionFieldStillZeroInits() {
        // The literal explicitly sets ONE field; the OTHER (magic-collection)
        // field is left unset and must still get its sound zero value.
        const library = `package i3329lib6

struct S {
    public var X int32
    public var Items []int32
}`
        const source = `package i3329f
import i3329lib6

func Main() {
    let s = S{X: 7}
    System.Console.WriteLine(s.X.ToString() + "," + s.Items.Length.ToString())
}`
        Assert.Equal("7,0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib6"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralWithExplicitInnerWorks() {
        // Issue #3329 scope note: recursing an OUTER struct literal's own
        // zero-value synthesis INTO an inner struct-typed field that itself
        // needs a magic-collection zero value is issue #3319 (same-assembly
        // recursion — reproduces identically with no library reference at
        // all, confirmed unrelated to #3329's cross-assembly token gap and
        // deliberately left out of this issue's scope). This test instead
        // pins the shape #3329 IS responsible for: an outer struct literal
        // for a type whose nested-struct field is ALSO declared in another
        // assembly, explicitly initialized (not recursively zero-valued).
        const library = `package i3329lib7

struct Inner {
    public var X int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329g
import i3329lib7

func Main() {
    let o = Outer{I: Inner{X: 5}}
    System.Console.WriteLine(o.I.X)
}`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source, library, "i3329lib7"))
    }

    @Fact
    func NestedStructInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Issue #3329 x #3330 composition: PR #3330 (issue #3319) added
        // SAME-ASSEMBLY recursion so an outer struct literal's own
        // zero-value synthesis walks INTO an inner struct-typed field that
        // itself needs a magic-collection zero value. #3330 postdates this
        // PR's original design (which explicitly scoped that case OUT, see
        // the test above), so this pins the case the two fixes need to get
        // right TOGETHER: `Outer{}` constructed from ANOTHER (consumer)
        // assembly, where `Outer.I Inner` is left unset and `Inner` itself
        // has an unset magic-collection field — the composed zero value must
        // reach all the way through the cross-assembly reconstruction AND
        // the nested-struct recursion.
        const library = `package i3329lib8

struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329i
import i3329lib8

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib8"))
    }

    @Fact
    func DataStructNestedInStruct_BothDeclaredInLibrary_OuterLiteralZeroInitsInnerMagicField() {
        // Same composed shape as above, but the INNER struct is a `data
        // struct` (routes through ImportedTypeSymbol.BuildSemanticAggregate
        // on reconstruction, rather than ExpressionBinder.
        // BindImportedTypeObjectInitializer's plain-struct fallback) —
        // confirms the composition holds on both cross-assembly
        // reconstruction paths, not just the plain-struct one.
        const library = `package i3329lib9

data struct Inner {
    public var Items []int32
}

struct Outer {
    public var I Inner
}`
        const source = `package i3329j
import i3329lib9

func Main() {
    let o = Outer{}
    System.Console.WriteLine(o.I.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source, library, "i3329lib9"))
    }

    @Fact
    func SameAssembly_StructLiteral_SliceField_RegressionPin() {
        // Control: a same-compilation struct literal must keep working
        // exactly as before (no library reference at all).
        const source = `package i3329h

struct S {
    public var Items []int32
}

func Main() {
    let s = S{}
    System.Console.WriteLine(s.Items.Length)
}`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainStruct_MixedCompositeInitializerAddTouchesOmittedField_ZeroInitBeforeOrderedAdd() {
        // ADR-0180 reviewer finding: the ordered content-element/spread Add(...)
        // calls a mixed composite initializer lowers to (Basket{ Touches: 0, 1, 2,
        // ...extra }) must not run before this struct's own #3329/ADR-0159
        // magic-collection zero-value reconstruction — otherwise Add's own body,
        // which reads the omitted `Items` slice field, observes the raw (unsound)
        // CLR null instead of a zero-initialized empty slice and NREs on the very
        // first Add.
        const library = `package i3785lib1

struct Basket {
    public var Items []int32
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + item
    }
}`
        const source = `package i3785a
import System.Collections.Generic
import i3785lib1

func Main() {
    let extra = List[int32]{ 3, 4 }
    let b = Basket{ Touches: 0, 1, 2, ...extra }
    System.Console.WriteLine(b.Touches)
    System.Console.WriteLine(b.Items.Length)
}`
        Assert.Equal("10${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source, library, "i3785lib1"))
    }

    @Theory
    @InlineData("", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket{ Touches: 0, 1, Items: []int32{ 2 }, Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    @InlineData("data ", "Basket(){ .Touches: 0, 1, .Items: []int32{ 2 }, .Counts: map[string, int32]{ \"last\": 3 } }")
    func MixedInitializer_LaterExplicitMagicFieldsAreSoundBeforeAdd(modifier string, initializer string) {
        let library = (`package i3785later
` + "$modifier" + `struct Basket {
    public var Items []int32
    public var Counts map[string, int32]
    public var Touches int32
    func Add(item int32) {
        Touches = Touches + Items.Length + Counts.Count + item
    }
}`)
        let source = (`import i3785later
let value = ` + "$initializer" + `
System.Console.WriteLine(value.Touches)
System.Console.WriteLine(value.Items.Length)
System.Console.WriteLine(value.Counts.Count)`)
        Assert.Equal(
            "1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source, library, "i3785later")
        )
    }

    shared {
        private func ExpectedConsoleBytes(lines string)[]uint8 -> System
            .Text
            .Encoding
            .UTF8
            .GetBytes(lines.Replace("\n", Environment.NewLine, StringComparison.Ordinal))

        private func CompileAndRunExact(
            source string,
            library string,
            libraryName string,
            useReferenceAssembly bool = false
        )[]uint8 {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let reference = Path.Combine(fixture.Directory, "producer.ref.dll")
            let producer = fixture.Compile(library, libraryName, executable: false, "/refout:" + reference)
            IlVerifier.Verify(producer)
            let consumer = fixture.Compile(
                source,
                "consumer",
                executable: true,
                "/r:" +
                    (
                    if useReferenceAssembly {
                        reference
                    } else {
                        producer
                    }
                )
            )
            IlVerifier.Verify(consumer, []string{producer})
            return fixture.RunBytes(consumer)
        }

        private func AssertOrdinaryConstructorMetadata(path string, typeName string) {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            Assert.NotEmpty(reader.TypeDefinitions)
            for handle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(handle)
                Assert.NotEqual("<>FieldInitializers", reader.GetString(type.Name))
                for methodHandle in type.GetMethods() {
                    Assert.False(
                        reader.GetString(reader.GetMethodDefinition(methodHandle).Name).StartsWith(
                            "<>fieldInitializer$",
                            StringComparison.Ordinal
                        )
                    )
                }
            }
            let target = reader.GetTypeDefinition(
                Assert.Single(
                    reader.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == typeName
                )
            )
            let constructors = target
                .GetMethods()
                .Select((handle MethodDefinitionHandle) -> reader.GetMethodDefinition(handle))
                .Where(
                (method MethodDefinition) -> reader.GetString(method.Name) == ".ctor" &&
                    (method.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public
            )
                .Where(
                (method MethodDefinition) -> {
                    var signature = reader.GetBlobReader(method.Signature)
                    signature.ReadSignatureHeader()
                    return signature.ReadCompressedInteger() == 0
                }
            )
                .ToArray()
            Assert.Single(constructors)
        }

        private func AssertConstructorStores(path string, ns string, typeName string, readonlyField string) {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            var constructorCalls = 0
            for handle in reader.MethodDefinitions {
                let method = reader.GetMethodDefinition(handle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let bytes = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()!!
                for instruction in IlInstructionReader.Read(bytes) {
                    if instruction.OpCode != OpCodes.Newobj && instruction.OpCode != OpCodes.Stfld {
                        continue
                    }
                    let token = BitConverter.ToInt32(bytes, instruction.Offset + instruction.OpCode.Size)
                    let target = MetadataTokens.EntityHandle(token)
                    if target.Kind != HandleKind.MemberReference {
                        continue
                    }
                    let member = reader.GetMemberReference(cast[MemberReferenceHandle](target))
                    if member.Parent.Kind != HandleKind.TypeReference {
                        continue
                    }
                    let owner = reader.GetTypeReference(cast[TypeReferenceHandle](member.Parent))
                    if reader.GetString(owner.Namespace) != ns || reader.GetString(owner.Name) != typeName {
                        continue
                    }
                    if instruction.OpCode == OpCodes.Newobj {
                        Assert.Equal(".ctor", reader.GetString(member.Name))
                        var signature = reader.GetBlobReader(member.Signature)
                        signature.ReadSignatureHeader()
                        Assert.Equal(0, signature.ReadCompressedInteger())
                        constructorCalls++
                    } else {
                        Assert.NotEqual(readonlyField, reader.GetString(member.Name))
                    }
                }
            }
            Assert.Equal(1, constructorCalls)
        }

        private func CompileAndRun(
            source string,
            library string? = nil,
            libraryAssemblyName string? = nil,
            useReferenceAssembly bool = false
        ) string {
            let tempDir = Directory.CreateDirectory(
                Path.Combine(AppContext.BaseDirectory, "gs_3329_" + Guid.NewGuid().ToString("N"))
            )
                .FullName
            try {
                let dllPath = BuildExecutable(
                    tempDir,
                    source,
                    library,
                    libraryAssemblyName,
                    out var libDll,
                    useReferenceAssembly
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
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
                } catch (IOException) { }
            }
        }

        private func BuildExecutable(
            tempDir string,
            source string,
            library string?,
            libraryAssemblyName string?,
            out libDll string?,
            useReferenceAssembly bool
        ) string {
            libDll = nil
            var libReference string? = nil
            if library != nil {
                // ilverify resolves `-r` references by FILE NAME, so the library
                // must be written out under its assembly identity.
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                let libraryArgs = List[string]{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc}
                if useReferenceAssembly {
                    libReference = Path.Combine(
                        Directory.CreateDirectory(Path.Combine(tempDir, "ref")).FullName,
                        libraryAssemblyName + ".dll"
                    )
                    libraryArgs.Add("/refout:" + libReference)
                }
                Compile(libraryArgs.ToArray())
                IlVerifier.Verify(libDll!!)
            }
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            if libDll != nil {
                args.Add("/r:" + (libReference ?? libDll))
            }
            args.Add(srcPath)
            Compile(args.ToArray())
            return dllPath
        }

        private func Compile(args[]string) {
            let result = TryCompile(args)
            Assert.True(result.Code == 0, result.Output)
        }

        private func TryCompile(args[]string)(Code int32, Output string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
