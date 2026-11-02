package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import NominalConversion = GSharp.Core.CodeAnalysis.Binding.Conversion
import SymbolAccessibility = GSharp.Core.CodeAnalysis.Symbols.Accessibility
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions
import Xunit
import Xunit.Abstractions

class Issue5388ImportedBaseUpcastDriverTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func SourceClassObjectRelation_PreservesNarrowingAndReceiverRecovery() {
        let source = StructSymbol(
            "Source",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        Assert.True(NominalConversion.IsRepresentationPreservingImplicit(source, TypeSymbol.Object))
        Assert.True(NarrowingState.IsNoStrongerThan(TypeSymbol.Object, source))
        Assert.True(ExpressionBinder.CanRecoverDeclaredMemberWriteReceiver(source, TypeSymbol.Object))
        Assert.False(NominalConversion.IsRepresentationPreservingImplicit(TypeSymbol.Object, source))
        let parent = StructSymbol(
            "Parent",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        source.SetBaseClass(parent)
        let path = AccessPath.ForVariable(LocalVariableSymbol("value", false, TypeSymbol.Object))
        Assert.Same(parent, NarrowingState.JoinTypes(path, []TypeSymbol{source, parent}))
        Assert.Same(parent, NarrowingState.JoinTypes(path, []TypeSymbol{parent, source}))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceClrInterface_PreservesDispatchIdentityAndReceiverOnce(inherited bool) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Resource : IDisposable {
    func Dispose() { Console.Write("D") }
}
class Derived : Resource {}
shared class Counts { var Receivers int32 = 0 }
func Target(value @TYPE@) @TYPE@ {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Main() {
    let value = @TYPE@()
    let view IDisposable = Target(value)
    view.Dispose()
    Console.Write(Counts.Receivers)
    Console.Write(Object.ReferenceEquals(view, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@TYPE@",
            if inherited {
                "Derived"
            } else {
                "Resource"
            }
        )
        let oracle = `using System;
using UpcastControl;
class Resource : IDisposable { public void Dispose() { Console.Write("D"); } }
class Derived : Resource {}
class Program {
    static int receivers;
    static @TYPE@ Target(@TYPE@ value) { receivers++; Console.Write("R"); return value; }
    static void Main() {
        var value = new @TYPE@();
        IDisposable view = Target(value);
        view.Dispose();
        Console.Write(receivers);
        Console.Write(Object.ReferenceEquals(view, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace(
            "@TYPE@",
            if inherited {
                "Derived"
            } else {
                "Resource"
            }
        )
        Check(fixture, source, oracle, "RD1True1")
    }

    @Fact
    func CompositeNominalProof_PreservesJoinGainAndReceiverRecovery() {
        let item = StructSymbol(
            "Item",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        let other = StructSymbol(
            "Other",
            ImmutableArray[FieldSymbol].Empty,
            SymbolAccessibility.Public,
            nil,
            "probe",
            false,
            false,
            true
        )
        let items = SequenceTypeSymbol.Get(item)
        let objects = SequenceTypeSymbol.Get(TypeSymbol.Object)
        let slice = SliceTypeSymbol.Get(item)
        let asyncItems = AsyncSequenceTypeSymbol.Get(item)
        let asyncObjects = AsyncSequenceTypeSymbol.Get(TypeSymbol.Object)
        let path = AccessPath.ForVariable(LocalVariableSymbol("value", false, TypeSymbol.Object))
        Assert.True(NominalConversion.IsRepresentationPreservingImplicit(items, objects))
        Assert.True(NominalConversion.IsRepresentationPreservingImplicit(slice, items))
        Assert.True(NominalConversion.IsRepresentationPreservingImplicit(asyncItems, asyncObjects))
        Assert.True(NarrowingState.IsNoStrongerThan(objects, items))
        Assert.True(ExpressionBinder.CanRecoverDeclaredMemberWriteReceiver(slice, items))
        Assert.Same(objects, NarrowingState.JoinTypes(path, []TypeSymbol{items, objects}))
        Assert.Same(objects, NarrowingState.JoinTypes(path, []TypeSymbol{objects, items}))
        Assert.Same(items, NarrowingState.JoinTypes(path, []TypeSymbol{slice, items}))
        Assert.Same(asyncObjects, NarrowingState.JoinTypes(path, []TypeSymbol{asyncItems, asyncObjects}))
        Assert.False(NominalConversion.IsRepresentationPreservingImplicit(items, SequenceTypeSymbol.Get(other)))
        Assert.False(
            NominalConversion.IsRepresentationPreservingImplicit(SequenceTypeSymbol.Get(TypeSymbol.Int32), objects)
        )
        Assert.False(
            NominalConversion.IsRepresentationPreservingImplicit(
                AsyncSequenceTypeSymbol.Get(TypeSymbol.Int32),
                asyncObjects
            )
        )
    }

    @Theory
    @InlineData("int32?", "int32", "int?", "int")
    @InlineData("int32", "int32?", "int", "int?")
    @InlineData("List[int32?]", "List[int32]", "List<int?>", "List<int>")
    func NullableValueArgument_RejectsDifferentRuntimeStorage(
        sourceArgument string,
        targetArgument string,
        oracleSourceArgument string,
        oracleTargetArgument string
    ) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func Up(x D) List[" + targetArgument + "] -> "
        let source = "import System.Collections.Generic\nclass D : List[" +
            sourceArgument +
            "] {}\n" +
            declaration +
            "x\nfunc Main() {}\n"
        let oracle = "using System.Collections.Generic;\nclass D : List<" +
            oracleSourceArgument +
            "> {}\nclass Program { static List<" +
            oracleTargetArgument +
            "> Up(D x) => x; }\n"
        Reject(fixture, source, oracle, "CS0029", 3, declaration.Length + 1, 1)
    }

    @Fact
    func NullableValueArgument_PreservesOptionalValuesAndReferenceIdentity() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Collections.Generic
import UpcastControl
class D : List[int32?] {}
func Up(x D) List[int32?] -> x
func Main() {
    let value = D()
    value.Add(nil)
    value.Add(7)
    let view = Up(value)
    Console.Write(view[0] == nil)
    Console.Write(view[1] == 7)
    Console.Write(Object.ReferenceEquals(view, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
class D : List<int?> {}
class Program {
    static List<int?> Up(D x) => x;
    static void Main() {
        var value = new D { null, 7 };
        var view = Up(value);
        Console.Write(view[0] == null);
        Console.Write(view[1] == 7);
        Console.Write(Object.ReferenceEquals(view, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "TrueTrueTrue1")
    }

    // Issue #5544: tuple elements that differ only by reference annotations are one CLR type.
    @Theory
    @InlineData("(Name string, Scope object)", "(string Name, object Scope)")
    @InlineData("(string, object)", "(string, object)")
    @InlineData("(string?, object?)", "(string?, object?)")
    func SourceClassTupleInterface_ErasesReferenceAnnotationsAndKeepsIdentity(key string, oracleKey string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Collections.Generic
import UpcastControl
class KeyComparer : IEqualityComparer[@KEY@] {
    func Equals(x @KEY@, y @KEY@) bool {
        Console.Write("E")
        return string.Equals(x.Item1, y.Item1) && Object.ReferenceEquals(x.Item2, y.Item2)
    }
    func GetHashCode(obj @KEY@) int32 {
        Console.Write("H")
        return HashCode.Combine(obj.Item1)
    }
}
shared class Counts { var Receivers int32 = 0 }
func Target(value KeyComparer) KeyComparer {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func View(value KeyComparer) IEqualityComparer[(string?, object?)] -> value
func Main() {
    let comparer = KeyComparer()
    let owner = Object()
    let keys = Dictionary[(string?, object?), bool](Target(comparer))
    keys[("a", owner)] = true
    Console.Write(keys.ContainsKey(("a", owner)))
    let set = HashSet[(string?, object?)](Target(comparer))
    Console.Write(set.Add(("b", owner)))
    let view IEqualityComparer[(string?, object?)] = Target(comparer)
    Console.Write(Object.ReferenceEquals(view, comparer))
    Console.Write(Object.ReferenceEquals(View(comparer), comparer))
    Console.Write(Counts.Receivers)
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace("@KEY@", key)
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
class KeyComparer : IEqualityComparer<@KEY@> {
    public bool Equals(@KEY@ x, @KEY@ y) {
        Console.Write("E");
        return string.Equals(x.Item1, y.Item1) && Object.ReferenceEquals(x.Item2, y.Item2);
    }
    public int GetHashCode(@KEY@ obj) {
        Console.Write("H");
        return HashCode.Combine(obj.Item1);
    }
}
class Program {
    static int receivers;
    static KeyComparer Target(KeyComparer value) { receivers++; Console.Write("R"); return value; }
    static IEqualityComparer<(string?, object?)> View(KeyComparer value) => value;
    static void Main() {
        var comparer = new KeyComparer();
        var owner = new Object();
        var keys = new Dictionary<(string?, object?), bool>(Target(comparer));
        keys[("a", owner)] = true;
        Console.Write(keys.ContainsKey(("a", owner)));
        var set = new HashSet<(string?, object?)>(Target(comparer));
        Console.Write(set.Add(("b", owner)));
        IEqualityComparer<(string?, object?)> view = Target(comparer);
        Console.Write(Object.ReferenceEquals(view, comparer));
        Console.Write(Object.ReferenceEquals(View(comparer), comparer));
        Console.Write(receivers);
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace("@KEY@", oracleKey)
        Check(fixture, source, oracle, "RHHETrueRHTrueRTrueTrue31")
    }

    // Issue #5544: an optional value tuple element is a different CLR type, so the interface view stays rejected.
    @Fact
    func SourceClassTupleInterface_RejectsOptionalValueElement() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func Up(x KeyComparer) IEqualityComparer[(int32?, string)] -> "
        let source = "import System.Collections.Generic\n" +
            "class KeyComparer : IEqualityComparer[(int32, string)] {\n" +
            "    func Equals(x (int32, string), y (int32, string)) bool -> x.Item1 == y.Item1\n" +
            "    func GetHashCode(obj (int32, string)) int32 -> obj.Item1\n" +
            "}\n" +
            declaration +
            "x\nfunc Main() {}\n"
        let oracle = "using System.Collections.Generic;\n" +
            "sealed class KeyComparer : IEqualityComparer<(int, string)> {\n" +
            "    public bool Equals((int, string) x, (int, string) y) => x.Item1 == y.Item1;\n" +
            "    public int GetHashCode((int, string) obj) => obj.Item1;\n" +
            "}\n" +
            "class Program { static IEqualityComparer<(int?, string)> Up(KeyComparer x) => x; }\n"
        Reject(fixture, source, oracle, "CS0029", 6, declaration.Length + 1, 1)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ImportedMultipleInstantiations_KeepEveryOwnerDispatchAndIdentity(inherited bool, symbolic bool) {
        using let fixture = CSharpFixture(MultiContract, assemblyName: "UpcastContract", deterministic: true)
        let parent = if symbolic {
            if inherited {
                "GenericBoth[Item]"
            } else {
                "IGenericBoth[Item]"
            }
        } else {
            if inherited {
                "Both"
            } else {
                "IBoth"
            }
        }
        let oracleParent = parent.Replace("[Item]", "<Item>")
        let argument = if symbolic {
            "List[Item]"
        } else {
            "int32"
        }
        let oracleArgument = if symbolic {
            "List<Item>"
        } else {
            "int"
        }
        let source = `import System
import System.Collections.Generic
import UpcastControl
import MultiControl
class Item {}
class C : @PARENT@ {}
shared class Counts { var Receivers int32 = 0 }
func Target(value C) C {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func First(value C) ITag[@ARG@] -> value
func Second(value C) ITag[string] -> value
func Main() {
    let value = C()
    let first = First(Target(value))
    let second = Second(Target(value))
    @READ@(first)
    Observe.String(second)
    Console.Write(Object.ReferenceEquals(value, first))
    Console.Write(Object.ReferenceEquals(value, second))
    Console.Write(Counts.Receivers)
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@PARENT@",
            parent
        ).Replace(
            "@ARG@",
            argument
        ).Replace(
            "@READ@",
            if symbolic {
                "Observe.Source[Item]"
            } else {
                "Observe.Int"
            }
        )
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
using MultiControl;
class Item {}
class C : @PARENT@ {}
class Program {
    static int receivers;
    static C Target(C value) { receivers++; Console.Write("R"); return value; }
    static ITag<@ARG@> First(C value) => value;
    static ITag<string> Second(C value) => value;
    static void Main() {
        var value = new C();
        var first = First(Target(value));
        var second = Second(Target(value));
        @READ@(first);
        Observe.String(second);
        Console.Write(Object.ReferenceEquals(value, first));
        Console.Write(Object.ReferenceEquals(value, second));
        Console.Write(receivers);
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace(
            "@PARENT@",
            oracleParent
        ).Replace(
            "@ARG@",
            oracleArgument
        ).Replace(
            "@READ@",
            if symbolic {
                "Observe.Source<Item>"
            } else {
                "Observe.Int"
            }
        )
        Check(
            fixture,
            source,
            oracle,
            if symbolic {
                "RRT7S5TrueTrue21"
            } else {
                "RRI3S5TrueTrue21"
            },
            contractSource: MultiContract
        )
    }

    @Theory
    @InlineData("sequence", "sequence[Item]", "sequence[object]")
    @InlineData("array", "[]Item", "sequence[Item]")
    @InlineData("async", "async sequence[Item]", "async sequence[object]")
    func SymbolicSequenceJoin_PreservesEnumerationIdentityAndEffects(kind string, from string, to string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let isAsync = kind == "async"
        let asyncPrefix = if isAsync {
            "async "
        } else {
            ""
        }
        let awaitPrefix = if isAsync {
            "await "
        } else {
            ""
        }
        let source = `import System
import UpcastControl
class Item {
    let Value int32
    init(value int32) { Value = value }
}
shared class Counts { var Visits int32 = 0 }
@ASYNC@func Values() @VALUESFROM@ {
    yield Item(3)
    yield Item(4)
}
func Up(value @FROM@) @TO@ -> value
@ASYNC@func Read(value object, flag bool) int32 {
    if flag {
        if value !is @FROM@ { return 0 }
    } else {
        if value !is @TO@ { return 0 }
    }
    var sum = 0
    @AWAIT@for item in value {
        Counts.Visits += 1
        Console.Write("E")
        if item is Item found { sum += found.Value }
    }
    return sum
}
@ASYNC@func Main() {
    let value = @VALUE@
    Console.Write(@AWAIT@Read(value, true))
    Console.Write(@AWAIT@Read(value, false))
    Console.Write(Counts.Visits)
    Console.Write(Object.ReferenceEquals(value, Up(value)))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@ASYNC@",
            asyncPrefix
        ).Replace(
            "@AWAIT@",
            awaitPrefix
        ).Replace(
            "@VALUESFROM@",
            if isAsync {
                "async sequence[Item]"
            } else {
                "sequence[Item]"
            }
        ).Replace(
            "@FROM@",
            from
        ).Replace(
            "@TO@",
            to
        ).Replace(
            "@VALUE@",
            if kind == "array" {
                "[]Item{Item(3), Item(4)}"
            } else {
                "Values()"
            }
        )
        let oracle = `using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UpcastControl;
class Item { public readonly int Value; public Item(int value) { Value = value; } }
class Program {
    static int visits;
    static @ASYNC@@VALUESFROM@ Values() {
        @WAIT@
        yield return new Item(3);
        yield return new Item(4);
    }
    static @TO@ Up(@FROM@ value) => value;
    static @ASYNC@@RETURN@ Read(object value, bool flag) {
        if (flag) { if (value is not @FROM@) return 0; }
        else { if (value is not @TO@) return 0; }
        var sum = 0;
        @AWAIT@foreach (var item in (@TO@)value) {
            visits++;
            Console.Write("E");
            if (item is Item found) sum += found.Value;
        }
        return sum;
    }
    static @ASYNC@@MAIN@ Main() {
        var value = @VALUE@;
        Console.Write(@AWAIT@Read(value, true));
        Console.Write(@AWAIT@Read(value, false));
        Console.Write(visits);
        Console.Write(Object.ReferenceEquals(value, Up(value)));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace(
            "@ASYNC@",
            asyncPrefix
        ).Replace(
            "@AWAIT@",
            awaitPrefix
        ).Replace(
            "@VALUESFROM@",
            if isAsync {
                "IAsyncEnumerable<Item>"
            } else {
                "IEnumerable<Item>"
            }
        ).Replace(
            "@FROM@",
            if isAsync {
                "IAsyncEnumerable<Item>"
            } else if kind == "array" {
                "Item[]"
            } else {
                "IEnumerable<Item>"
            }
        ).Replace(
            "@TO@",
            if isAsync {
                "IAsyncEnumerable<object>"
            } else if kind == "array" {
                "IEnumerable<Item>"
            } else {
                "IEnumerable<object>"
            }
        ).Replace(
            "@RETURN@",
            if isAsync {
                "Task<int>"
            } else {
                "int"
            }
        ).Replace(
            "@MAIN@",
            if isAsync {
                "Task"
            } else {
                "void"
            }
        ).Replace(
            "@WAIT@",
            if isAsync {
                "await Task.CompletedTask;"
            } else {
                ""
            }
        ).Replace(
            "@VALUE@",
            if kind == "array" {
                "new[] { new Item(3), new Item(4) }"
            } else {
                "Values()"
            }
        )
        Check(fixture, source, oracle, "EE7EE74True1")
    }

    @Theory
    @InlineData("sequence[Item]", "sequence[Other]", "IEnumerable<Item>", "IEnumerable<Other>", "CS0266", "GS0156")
    @InlineData("sequence[int32]", "sequence[object]", "IEnumerable<int>", "IEnumerable<object>", "CS0266", "GS0156")
    @InlineData(
        "async sequence[int32]",
        "async sequence[object]",
        "IAsyncEnumerable<int>",
        "IAsyncEnumerable<object>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "sequence[Channel[int32]]",
        "sequence[ChannelReader[int32]]",
        "IEnumerable<Channel<int>>",
        "IEnumerable<ChannelReader<int>>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "[]Channel[int32]",
        "sequence[ChannelReader[int32]]",
        "Channel<int>[]",
        "IEnumerable<ChannelReader<int>>",
        "CS0029",
        "GS0155"
    )
    @InlineData(
        "[,]Channel[int32]",
        "[,]ChannelReader[int32]",
        "Channel<int>[,]",
        "ChannelReader<int>[,]",
        "CS0029",
        "GS0155"
    )
    @InlineData(
        "sequence[[,]Channel[int32]]",
        "sequence[[,]ChannelReader[int32]]",
        "IEnumerable<Channel<int>[,]>",
        "IEnumerable<ChannelReader<int>[,]>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "sequence[() -> int32]",
        "sequence[() -> int64]",
        "IEnumerable<System.Func<int>>",
        "IEnumerable<System.Func<long>>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "sequence[() -> Channel[int32]]",
        "sequence[() -> ChannelReader[int32]]",
        "IEnumerable<System.Func<Channel<int>>>",
        "IEnumerable<System.Func<ChannelReader<int>>>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "sequence[(Item) -> void]",
        "sequence[(object) -> void]",
        "IEnumerable<System.Action<Item>>",
        "IEnumerable<System.Action<object>>",
        "CS0266",
        "GS0156"
    )
    @InlineData(
        "sequence[(ChannelReader[int32]) -> void]",
        "sequence[(Channel[int32]) -> void]",
        "IEnumerable<System.Action<ChannelReader<int>>>",
        "IEnumerable<System.Action<Channel<int>>>",
        "CS0266",
        "GS0156"
    )
    func NominalVariance_RejectsWrongOwnerValueTypesAndNestedProjections(
        from string,
        to string,
        oracleFrom string,
        oracleTo string,
        oracleDiagnostic string,
        diagnostic string
    ) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func Up(x " + from + ") " + to + " -> "
        let source = "import System.Threading.Channels\nclass Item {}\nclass Other {}\n" +
            declaration +
            "x\nfunc Main() {}\n"
        let oracle = "using System.Collections.Generic;\nusing System.Threading.Channels;\nclass Item {}\n" +
            "class Other {}\nclass Program { static " +
            oracleTo +
            " Up(" +
            oracleFrom +
            " x) => x; }\n"
        Reject(fixture, source, oracle, oracleDiagnostic, 4, declaration.Length + 1, 1, diagnostic: diagnostic)
    }

    @Fact
    func NestedReferenceVariance_KeepsBoundMapAndDelegateUpcasts() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Collections.Generic
import UpcastControl
open class Animal {}
class Dog : Animal {}
class Item {}
delegate Handler(x Item) Item;
func Bound[T Animal](x sequence[T]) sequence[Animal] -> x
func Maps(x sequence[map[string, Item]]) sequence[IReadOnlyDictionary[string, Item]] -> x
func Delegates(x sequence[Handler]) sequence[Delegate] -> x
func Main() {
    let leaves sequence[Dog] = []Dog{Dog(), Dog()}
    let maps sequence[map[string, Item]] = []map[string, Item]{map[string, Item]{"a": Item()}}
    let handlers sequence[Handler] = []Handler{(x Item) -> x}
    let bases = Bound[Dog](leaves)
    let views = Maps(maps)
    let delegates = Delegates(handlers)
    var count = 0
    for b in bases { if b is Dog { count += 1 } }
    for view in views { count += view.Count * 10 }
    for d in delegates { if d is Handler { count += 100 } }
    Console.Write(count)
    Console.Write(Object.ReferenceEquals(object(leaves), object(bases)))
    Console.Write(Object.ReferenceEquals(object(maps), object(views)))
    Console.Write(Object.ReferenceEquals(object(handlers), object(delegates)))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
class Animal {}
class Dog : Animal {}
class Item {}
delegate Item Handler(Item x);
class Program {
    static IEnumerable<Animal> Bound<T>(IEnumerable<T> x) where T : Animal => x;
    static IEnumerable<IReadOnlyDictionary<string, Item>> Maps(IEnumerable<Dictionary<string, Item>> x) => x;
    static IEnumerable<Delegate> Delegates(IEnumerable<Handler> x) => x;
    static void Main() {
        IEnumerable<Dog> leaves = new[] { new Dog(), new Dog() };
        IEnumerable<Dictionary<string, Item>> maps = new[] { new Dictionary<string, Item> { ["a"] = new Item() } };
        IEnumerable<Handler> handlers = new Handler[] { x => x };
        var bases = Bound<Dog>(leaves);
        var views = Maps(maps);
        var delegates = Delegates(handlers);
        var count = 0;
        foreach (var b in bases) { if (b is Dog) count += 1; }
        foreach (var view in views) { count += view.Count * 10; }
        foreach (var d in delegates) { if (d is Handler) count += 100; }
        Console.Write(count);
        Console.Write(Object.ReferenceEquals(leaves, bases));
        Console.Write(Object.ReferenceEquals(maps, views));
        Console.Write(Object.ReferenceEquals(handlers, delegates));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "112TrueTrueTrue1")
    }

    @Fact
    func NestedArrayAndFunctionVariance_KeepReferences() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Animal {}
class Dog : Animal {}
func Grids(x sequence[[,]Dog]) sequence[[,]Animal] -> x
func Makers(x sequence[() -> Dog]) sequence[() -> Animal] -> x
func Nested(x sequence[() -> () -> Dog]) sequence[() -> () -> Animal] -> x
func Main() {
    let grid = [1, 2]Dog{Dog(), Dog()}
    let grids sequence[[,]Dog] = [][,]Dog{grid}
    let maker = () -> Dog()
    let makers sequence[() -> Dog] = []() -> Dog{maker}
    let nested sequence[() -> () -> Dog] = []() -> () -> Dog{() -> maker}
    var count = 0
    for g in Grids(grids) { count += g.Length }
    for m in Makers(makers) { if m() is Dog { count += 10 } }
    for n in Nested(nested) { if n()() is Dog { count += 100 } }
    Console.Write(count)
    Console.Write(Object.ReferenceEquals(grids, Grids(grids)))
    Console.Write(Object.ReferenceEquals(makers, Makers(makers)))
    Console.Write(Object.ReferenceEquals(nested, Nested(nested)))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
class Animal {}
class Dog : Animal {}
class Program {
    static IEnumerable<Animal[,]> Grids(IEnumerable<Dog[,]> x) => x;
    static IEnumerable<Func<Animal>> Makers(IEnumerable<Func<Dog>> x) => x;
    static IEnumerable<Func<Func<Animal>>> Nested(IEnumerable<Func<Func<Dog>>> x) => x;
    static void Main() {
        var grid = new Dog[1, 2] { { new Dog(), new Dog() } };
        IEnumerable<Dog[,]> grids = new[] { grid };
        Func<Dog> maker = () => new Dog();
        IEnumerable<Func<Dog>> makers = new[] { maker };
        IEnumerable<Func<Func<Dog>>> nested = new Func<Func<Dog>>[] { () => maker };
        var count = 0;
        foreach (var g in Grids(grids)) count += g.Length;
        foreach (var m in Makers(makers)) { if (m() is Dog) count += 10; }
        foreach (var n in Nested(nested)) { if (n()() is Dog) count += 100; }
        Console.Write(count);
        Console.Write(Object.ReferenceEquals(grids, Grids(grids)));
        Console.Write(Object.ReferenceEquals(makers, Makers(makers)));
        Console.Write(Object.ReferenceEquals(nested, Nested(nested)));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "112TrueTrueTrue1")
    }

    @Fact
    func ArrowFunctionVariance_UsesNaturalDelegateVariance() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Animal {}
class Dog : Animal {}
class Item {}
shared class Counts { var Calls int32 = 0 }
func Results(x sequence[(int32) -> string]) sequence[(int32) -> object] -> x
func Mixed(x sequence[() -> Item]) sequence[Func[object]] -> x
func Sinks(x sequence[(Animal, ...int32) -> void]) sequence[(Dog, ...int32) -> void] -> x
func Nested(x sequence[sequence[(Animal) -> Dog]]) sequence[sequence[(Dog) -> Animal]] -> x
func Text(n int32) string -> n.ToString()
func Make() Item -> Item()
func Adopt(a Animal) Dog -> Dog()
func ResultsOf() sequence[(int32) -> string] {
    let f (int32) -> string = Text
    yield f
}
func MakersOf() sequence[() -> Item] {
    let f () -> Item = Make
    yield f
}
func SinksOf() sequence[(Animal, ...int32) -> void] {
    let f (Animal, ...int32) -> void = (a Animal, values []int32) -> { Counts.Calls += values.Length }
    yield f
}
func InnerOf() sequence[(Animal) -> Dog] {
    let f (Animal) -> Dog = Adopt
    yield f
}
func NestedOf() sequence[sequence[(Animal) -> Dog]] {
    yield InnerOf()
}
func Main() {
    let results = ResultsOf()
    let makers = MakersOf()
    let sinks = SinksOf()
    let nested = NestedOf()
    var count = 0
    for r in Results(results) { if r(42) is string text { count += text.Length } }
    for m in Mixed(makers) { if m() is Item { count += 10 } }
    for s in Sinks(sinks) { s(Dog(), 1, 2, 3) }
    for inner in Nested(nested) {
        for f in inner { if f(Dog()) is Dog { count += 1000 } }
    }
    Console.Write(count + Counts.Calls * 100)
    Console.Write(Object.ReferenceEquals(results, Results(results)))
    Console.Write(Object.ReferenceEquals(makers, Mixed(makers)))
    Console.Write(Object.ReferenceEquals(sinks, Sinks(sinks)))
    Console.Write(Object.ReferenceEquals(nested, Nested(nested)))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using System.Collections.Generic;
using UpcastControl;
class Animal {}
class Dog : Animal {}
class Item {}
class Program {
    static int calls;
    static IEnumerable<Func<int, object>> Results(IEnumerable<Func<int, string>> x) => x;
    static IEnumerable<Func<object>> Mixed(IEnumerable<Func<Item>> x) => x;
    static IEnumerable<Action<Dog, int[]>> Sinks(IEnumerable<Action<Animal, int[]>> x) => x;
    static IEnumerable<IEnumerable<Func<Dog, Animal>>> Nested(IEnumerable<IEnumerable<Func<Animal, Dog>>> x) => x;
    static IEnumerable<Func<int, string>> ResultsOf() { Func<int, string> f = n => n.ToString(); yield return f; }
    static IEnumerable<Func<Item>> MakersOf() { Func<Item> f = () => new Item(); yield return f; }
    static IEnumerable<Action<Animal, int[]>> SinksOf() { Action<Animal, int[]> f = (a, values) => calls += values.Length; yield return f; }
    static IEnumerable<Func<Animal, Dog>> InnerOf() { Func<Animal, Dog> f = a => new Dog(); yield return f; }
    static IEnumerable<IEnumerable<Func<Animal, Dog>>> NestedOf() { yield return InnerOf(); }
    static void Main() {
        var results = ResultsOf();
        var makers = MakersOf();
        var sinks = SinksOf();
        var nested = NestedOf();
        var count = 0;
        foreach (var r in Results(results)) { if (r(42) is string text) count += text.Length; }
        foreach (var m in Mixed(makers)) { if (m() is Item) count += 10; }
        foreach (var s in Sinks(sinks)) { s(new Dog(), new[] { 1, 2, 3 }); }
        foreach (var inner in Nested(nested)) {
            foreach (var f in inner) { if (f(new Dog()) is Dog) count += 1000; }
        }
        Console.Write(count + calls * 100);
        Console.Write(Object.ReferenceEquals(results, Results(results)));
        Console.Write(Object.ReferenceEquals(makers, Mixed(makers)));
        Console.Write(Object.ReferenceEquals(sinks, Sinks(sinks)));
        Console.Write(Object.ReferenceEquals(nested, Nested(nested)));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "1312TrueTrueTrueTrue1")
    }

    @Fact
    func FixedArrayAndSliceJoin_PreservesSliceFact() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
class Item {
    let Value int32
    init(value int32) { Value = value }
}
func Up(value [2]Item) []Item -> value
func Read(value object, flag bool) int32 {
    if flag {
        if value !is [2]Item { return 0 }
    } else {
        if value !is []Item { return 0 }
    }
    var sum = 0
    for item in value { sum += item.Value }
    return sum + value.Length
}
func Main() {
    let fixed = [2]Item{Item(3), Item(4)}
    Console.Write(Read(fixed, true))
    Console.Write(Read(fixed, false))
    Console.Write(Object.ReferenceEquals(fixed, Up(fixed)))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using UpcastControl;
class Item { public readonly int Value; public Item(int value) { Value = value; } }
class Program {
    static Item[] Up(Item[] value) => value;
    static int Read(object value, bool flag) {
        if (value is not Item[] items) return 0;
        var sum = 0;
        foreach (var item in items) sum += item.Value;
        return sum + items.Length;
    }
    static void Main() {
        var fixedItems = new[] { new Item(3), new Item(4) };
        Console.Write(Read(fixedItems, true));
        Console.Write(Read(fixedItems, false));
        Console.Write(Object.ReferenceEquals(fixedItems, Up(fixedItems)));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "99True1")
    }

    @Fact
    func DeepNestedCovariance_ProvesEachArgumentPairOnce() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        // Proving each nested pair more than once grows exponentially; this depth cannot finish then.
        let depth = 32
        var from = "string"
        var to = "object"
        var oracleFrom = "string"
        var oracleTo = "object"
        for var i = 0; i < depth; i++ {
            from = "IReadOnlyList[" + from + "]"
            to = "IReadOnlyList[" + to + "]"
            oracleFrom = "IReadOnlyList<" + oracleFrom + ">"
            oracleTo = "IReadOnlyList<" + oracleTo + ">"
        }
        let element = from.Substring("IReadOnlyList[".Length, from.Length - "IReadOnlyList[".Length - 1)
        let oracleElement = oracleFrom.Substring(
            "IReadOnlyList<".Length,
            oracleFrom.Length - "IReadOnlyList<".Length - 1
        )
        let source = "import System\nimport System.Collections.Generic\nimport UpcastControl\nfunc Up(x " +
            from +
            ") " +
            to +
            " -> x\nfunc Main() {\n    let value " +
            from +
            " = []" +
            element +
            "{}\n    Console.Write(Object.ReferenceEquals(value, Up(value)))\n" +
            "    Console.Write(Base[uint32].Read(Base[uint32]()))\n}\n"
        let oracle = "using System;\nusing System.Collections.Generic;\nusing UpcastControl;\nclass Program {\n" +
            "    static " +
            oracleTo +
            " Up(" +
            oracleFrom +
            " x) => x;\n    static void Main() {\n        " +
            oracleFrom +
            " value = new " +
            oracleElement +
            "[0];\n        Console.Write(Object.ReferenceEquals(value, Up(value)));\n" +
            "        Console.Write(Base<uint>.Read(new Base<uint>()));\n    }\n}\n"
        Check(fixture, source, oracle, "True1")
    }

    @Fact
    func FunctionVariance_RejectsNamedDelegateMaterialization() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func Up(x sequence[() -> Item]) sequence[Maker] -> "
        let source = "class Item {}\ndelegate Maker() Item;\n" + declaration + "x\nfunc Main() {}\n"
        let oracle = `using System;
using System.Collections.Generic;
class Item {}
delegate Item Maker();
class Program { static IEnumerable<Maker> Up(IEnumerable<Func<Item>> x) => x; }
`
        Reject(fixture, source, oracle, "CS0266", 3, declaration.Length + 1, 1, diagnostic: "GS0156")
    }

    @Fact
    func MultipleHierarchy_RejectsWrongSymbolicOwner() {
        using let fixture = CSharpFixture(MultiContract, assemblyName: "UpcastContract", deterministic: true)
        let declaration = "func Up(x C) ITag[List[Other]] -> "
        let source = "import System.Collections.Generic\nimport MultiControl\nclass Item {}\nclass Other {}\n" +
            "class C : IGenericBoth[Item] {}\n" +
            declaration +
            "x\nfunc Main() {}\n"
        let oracle = `using System.Collections.Generic;
using MultiControl;
class Item {}
class Other {}
class C : IGenericBoth<Item> {}
class Program { static ITag<List<Other>> Up(C x) => x; }
`
        Reject(fixture, source, oracle, "CS0266", 6, declaration.Length + 1, 1, MultiContract)
    }

    @Fact
    func SourceConstructedBaseJoin_PreservesValidBaseMember() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
open class Parent[T] { func Read() int32 -> 7 }
class Child : Parent[int32] {}
func Read(value object, flag bool) int32 {
    if flag {
        if value !is Child { return 0 }
    } else {
        if value !is Parent[int32] { return 0 }
    }
    return value.Read()
}
func Main() {
    let value = Child()
    Console.Write(Read(value, true))
    Console.Write(Read(value, false))
    let boxed object = value
    Console.Write(Object.ReferenceEquals(boxed, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using UpcastControl;
class Parent<T> { public int Read() => 7; }
class Child : Parent<int> {}
class Program {
    static int Read(object value, bool flag) {
        if (flag) { if (value is not Child) return 0; }
        else if (value is not Parent<int>) return 0;
        return ((Parent<int>)value).Read();
    }
    static void Main() {
        var value = new Child();
        Console.Write(Read(value, true));
        Console.Write(Read(value, false));
        object boxed = value;
        Console.Write(Object.ReferenceEquals(boxed, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "77True1")
    }

    @Fact
    func SourceInterfaceJoin_PreservesInheritedClrContract() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import UpcastControl
interface Lifetime : IDisposable {}
class Resource : Lifetime { func Dispose() { Console.Write("D") } }
shared class Counts { var Receivers int32 = 0 }
func Target(value Resource) object {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Join(value object, flag bool) IDisposable {
    if flag {
        if value !is Lifetime { return Resource() }
    } else {
        if value !is IDisposable { return Resource() }
    }
    return value
}
func Main() {
    let value = Resource()
    let boxed = Target(value)
    let left = Join(boxed, true)
    let right = Join(boxed, false)
    left.Dispose()
    right.Dispose()
    Console.Write(Counts.Receivers)
    Console.Write(Object.ReferenceEquals(left, value))
    Console.Write(Object.ReferenceEquals(right, value))
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using UpcastControl;
interface Lifetime : IDisposable {}
class Resource : Lifetime { public void Dispose() { Console.Write("D"); } }
class Program {
    static int receivers;
    static object Target(Resource value) { receivers++; Console.Write("R"); return value; }
    static IDisposable Join(object value, bool flag) {
        if (flag) { if (value is not Lifetime) return new Resource(); }
        else if (value is not IDisposable) return new Resource();
        return (IDisposable)value;
    }
    static void Main() {
        var value = new Resource();
        var boxed = Target(value);
        var left = Join(boxed, true);
        var right = Join(boxed, false);
        left.Dispose();
        right.Dispose();
        Console.Write(receivers);
        Console.Write(Object.ReferenceEquals(left, value));
        Console.Write(Object.ReferenceEquals(right, value));
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "RDD1TrueTrue1")
    }

    @Fact
    func SourceClrInterface_ExtensionArgumentsKeepTheirSymbolicOwnerAndReceiverOnce() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Collections.Generic
import System.Linq
import UpcastControl
open class Symbol {
    let Name string
    init(name string) { Name = name }
}
class FunctionSymbol : Symbol { init(name string) : base(name) {} }
class Comparer : IComparer[Symbol], IComparer[FunctionSymbol] {
    func Compare(x Symbol?, y Symbol?) int32 {
        Console.Write("S")
        return StringComparer.Ordinal.Compare(y?.Name, x?.Name)
    }
    func Compare(x FunctionSymbol?, y FunctionSymbol?) int32 {
        Console.Write("F")
        return StringComparer.Ordinal.Compare(x?.Name, y?.Name)
    }
}
shared class Counts { var Receivers int32 = 0 }
func Target() Comparer {
    Counts.Receivers += 1
    Console.Write("R")
    return Comparer()
}
func Main() {
    for item in []FunctionSymbol{FunctionSymbol("B"), FunctionSymbol("A")}.OrderBy(
        (value FunctionSymbol) -> value, Target()) {
        Console.Write(item.Name)
    }
    Console.Write(Counts.Receivers)
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`
        let oracle = `using System;
using System.Collections.Generic;
using System.Linq;
using UpcastControl;
class Symbol { public readonly string Name; public Symbol(string name) { Name = name; } }
class FunctionSymbol : Symbol { public FunctionSymbol(string name) : base(name) {} }
class Comparer : IComparer<Symbol>, IComparer<FunctionSymbol> {
    public int Compare(Symbol? x, Symbol? y) {
        Console.Write("S");
        return StringComparer.Ordinal.Compare(y?.Name, x?.Name);
    }
    public int Compare(FunctionSymbol? x, FunctionSymbol? y) {
        Console.Write("F");
        return StringComparer.Ordinal.Compare(x?.Name, y?.Name);
    }
}
class Program {
    static int receivers;
    static Comparer Target() { receivers++; Console.Write("R"); return new Comparer(); }
    static void Main() {
        foreach (var item in new[] { new FunctionSymbol("B"), new FunctionSymbol("A") }
            .OrderBy((FunctionSymbol value) => value, Target())) {
            Console.Write(item.Name);
        }
        Console.Write(receivers);
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`
        Check(fixture, source, oracle, "RFAB11")
    }

    @Fact
    func SourceConstructedBase_RejectsWrongOwner() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let result = Compile(
            fixture,
            "open class Parent[T] {}\nclass Child : Parent[int32] {}\n" +
                "func Up(value Child) Parent[string] -> value\nfunc Main() {}\n"
        )
        Assert.NotEqual(0, result.Code)
        let error = Assert.Single(
            Regex.Matches(
                Encoding.UTF8.GetString(result.Bytes) + result.Error,
                `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
            )
        )
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal("40", error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal("45", error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceStruct_UpcastsToImportedUnmanagedBase(nullable bool) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import UpcastControl
struct Payload { var Value uint32 }
class Derived : Base[Payload] {}
func Main() {
    let value = Derived()
    System.Console.Write(Base[Payload].Read(value))
` + (
            if nullable {
                `    let present Base[Payload]? = value
    System.Console.Write(System.Object.ReferenceEquals(present, value))
    let missing Base[Payload]? = nil
    System.Console.Write(missing == nil)
`
            } else {
                ""
            }
        ) + "}\n"
        let oracle = `using UpcastControl;
struct Payload { public uint Value; }
class Derived : Base<Payload> {}
class Program {
    static void Main() {
        var value = new Derived();
        System.Console.Write(Base<Payload>.Read(value));
` + (
            if nullable {
                `        Base<Payload>? present = value;
        System.Console.Write(System.Object.ReferenceEquals(present, value));
        Base<Payload>? missing = null;
        System.Console.Write(missing == null);
`
            } else {
                ""
            }
        ) + `    }
    }
`
        Check(
            fixture,
            source,
            oracle,
            if nullable {
                "1TrueTrue"
            } else {
                "1"
            }
        )
    }

    @Fact
    func ReorderedImportedOwner_PreservesIdentityDispatchAndNilContracts() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        Check(fixture, `import UpcastControl
import System
struct Payload { var Value uint32 }
open class Derived[T] : Forward[T] {
    override func Tag() int32 {
        Console.Write("V")
        return 7
    }
}
class Leaf : Derived[Payload] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value Leaf) Leaf {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Up[T](value Derived[T]) Pair[string, T] -> value
func Main() {
    let value = Leaf()
    let parent Pair[string, Payload] = Up[Payload](Target(value))
    Console.Write(Pair[string, Payload].Read(parent))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    Console.Write(Object.ReferenceEquals(parent, value))
    let missing Pair[string, Payload]? = nil
    Console.Write("|")
    Console.Write(Pair[string, Payload].IsNil(missing))
    Console.Write("|")
    Console.Write(Pair[string, Payload].IsNil(value))
}
`, `using UpcastControl;
using System;
struct Payload { public uint Value; }
class Derived<T> : Forward<T> {
    public override int Tag() { Console.Write("V"); return 7; }
}
class Leaf : Derived<Payload> {}
class Program {
    static int receivers;
    static Leaf Target(Leaf value) { receivers++; Console.Write("R"); return value; }
    static Pair<string,T> Up<T>(Derived<T> value) => value;
    static void Main() {
        var value = new Leaf();
        Pair<string,Payload> parent = Up<Payload>(Target(value));
        Console.Write(Pair<string,Payload>.Read(parent));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        Console.Write(Object.ReferenceEquals(parent, value));
        Pair<string,Payload>? missing = null;
        Console.Write("|");
        Console.Write(Pair<string,Payload>.IsNil(missing));
        Console.Write("|");
        Console.Write(Pair<string,Payload>.IsNil(value));
    }
}
`, "RV7|1|True|True|False")
    }

    @Theory
    @InlineData("class Derived : Base[Payload] {}", "Base[Other]", "Derived()")
    @InlineData("class Derived : Base[Other] {}", "Base[Payload]", "Derived()")
    @InlineData("class Derived {}", "Base[Payload]", "Derived()")
    @InlineData("class Derived : Forward[Payload] {}", "Pair[Payload, string]", "Derived()")
    @InlineData("class Derived : Forward[Payload] {}", "Pair[string, Payload]", "nil as Pair[string, Payload]")
    func RejectsWrongIdentityAndGenericInstantiation(declaration string, target string, initializer string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = "import UpcastControl\nstruct Payload { var Value uint32 }\n" +
            "struct Other { var Value uint32 }\n" +
            declaration +
            "\nfunc Main() {\n    let value = " +
            initializer +
            "\n    let rejected " +
            target +
            " = value\n}\n"
        let result = Compile(fixture, source)
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("7", error.Groups[1].Value)
        let column = (5 + "let rejected ".Length + target.Length + " = ".Length).ToString()
        Assert.Equal(column, error.Groups[2].Value)
        Assert.Equal("7", error.Groups[3].Value)
        Assert.Equal((int32.Parse(column) + 5).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData("Reader", "int32")
    @InlineData("Writer", "int32")
    @InlineData("Reader", "Payload")
    @InlineData("Writer", "Payload")
    @InlineData("in chan", "int32")
    @InlineData("out chan", "int32")
    @InlineData("in chan", "Payload")
    @InlineData("out chan", "Payload")
    func SourceClass_DoesNotInheritReferenceChangingProjection(view string, element string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let target = if view == "Reader" || view == "Writer" {
            "Channel" + view
        } else {
            view
        }
        let declaration = "func View(value Wrap) " + target + "[" + element + "] -> "
        let source = "import System.Threading.Channels\nstruct Payload { var Value uint32 }\n" +
            "class Wrap : Channel[" +
            element +
            "] {}\n" +
            declaration +
            "value\nfunc Main() {}\n"
        let result = Compile(fixture, source, RuntimeReferences())
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("4", error.Groups[1].Value)
        Assert.Equal((declaration.Length + 1).ToString(), error.Groups[2].Value)
        Assert.Equal("4", error.Groups[3].Value)
        Assert.Equal((declaration.Length + 6).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Theory
    @InlineData("Reader")
    @InlineData("Writer")
    func DirectChannelProjection_UsesGetterAndPreservesNominalBaseUpcast(view string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Threading.Channels
import UpcastControl
class Wrap : Channel[int32] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value Channel[int32]) Channel[int32] {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func View(value Channel[int32]) Channel@VIEW@[int32] -> value
func Up(value Wrap) Channel[int32] -> value
func Main() {
    let channel = Channel.CreateUnbounded[int32]()
    let view = View(Target(channel))
    Console.Write(Object.ReferenceEquals(view, channel.@VIEW@))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    @TRANSFER@
    Console.Write(value)
    Console.Write("|")
    let wrap = Wrap()
    Console.Write(Object.ReferenceEquals(Up(wrap), wrap))
    Console.Write("|")
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(37))\n    Console.Write(view.TryRead(out var value))"
            } else {
                "Console.Write(view.TryWrite(37))\n    Console.Write(channel.Reader.TryRead(out var value))"
            }
        )
        let oracle = `using System;
using System.Threading.Channels;
using UpcastControl;
class Wrap : Channel<int> {}
class Program {
    static int receivers;
    static Channel<int> Target(Channel<int> value) { receivers++; Console.Write("R"); return value; }
    static Channel@VIEW@<int> View(Channel<int> value) => value.@VIEW@;
    static Channel<int> Up(Wrap value) => value;
    static void Main() {
        var channel = Channel.CreateUnbounded<int>();
        var view = View(Target(channel));
        Console.Write(Object.ReferenceEquals(view, channel.@VIEW@));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        @TRANSFER@
        Console.Write(value);
        Console.Write("|");
        var wrap = new Wrap();
        Console.Write(Object.ReferenceEquals(Up(wrap), wrap));
        Console.Write("|");
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(37));\n        Console.Write(view.TryRead(out var value));"
            } else {
                "Console.Write(view.TryWrite(37));\n        Console.Write(channel.Reader.TryRead(out var value));"
            }
        )
        Check(fixture, source, oracle, "RTrue|1|TrueTrue37|True|1", RuntimeReferences())
    }

    @Theory
    @InlineData("Reader", "in chan")
    @InlineData("Writer", "out chan")
    func NativeChannelProjection_UsesGetterAndPreservesSymbolicNominalUpcast(view string, alias string) {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let source = `import System
import System.Threading.Channels
import UpcastControl
struct Payload { var Value int32 }
class Wrap : Channel[Payload] {}
shared class Counts { var Receivers int32 = 0 }
func Target(value chan[Payload]) chan[Payload] {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func View(value chan[Payload]) @ALIAS@[Payload] -> value
func Up(value Wrap) chan[Payload] -> value
func Main() {
    let channel = Channel.CreateUnbounded[Payload]()
    let view = View(Target(channel))
    Console.Write(Object.ReferenceEquals(view, channel.@VIEW@))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    @TRANSFER@
    Console.Write(value.Value)
    Console.Write("|")
    let wrap = Wrap()
    Console.Write(Object.ReferenceEquals(Up(wrap), wrap))
    Console.Write("|")
    Console.Write(Base[uint32].Read(Base[uint32]()))
}
`.Replace(
            "@ALIAS@",
            alias
        ).Replace(
            "@VIEW@",
            view
        ).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(Payload{Value: 37}))\n    Console.Write(view.TryRead(out var value))"
            } else {
                "Console.Write(view.TryWrite(Payload{Value: 37}))\n    Console.Write(channel.Reader.TryRead(out var value))"
            }
        )
        let oracle = `using System;
using System.Threading.Channels;
using UpcastControl;
struct Payload { public int Value; }
class Wrap : Channel<Payload> {}
class Program {
    static int receivers;
    static Channel<Payload> Target(Channel<Payload> value) { receivers++; Console.Write("R"); return value; }
    static Channel@VIEW@<Payload> View(Channel<Payload> value) => value.@VIEW@;
    static Channel<Payload> Up(Wrap value) => value;
    static void Main() {
        var channel = Channel.CreateUnbounded<Payload>();
        var view = View(Target(channel));
        Console.Write(Object.ReferenceEquals(view, channel.@VIEW@));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        @TRANSFER@
        Console.Write(value.Value);
        Console.Write("|");
        var wrap = new Wrap();
        Console.Write(Object.ReferenceEquals(Up(wrap), wrap));
        Console.Write("|");
        Console.Write(Base<uint>.Read(new Base<uint>()));
    }
}
`.Replace("@VIEW@", view).Replace(
            "@TRANSFER@",
            if view == "Reader" {
                "Console.Write(channel.Writer.TryWrite(new Payload {Value = 37}));\n        Console.Write(view.TryRead(out var value));"
            } else {
                "Console.Write(view.TryWrite(new Payload {Value = 37}));\n        Console.Write(channel.Reader.TryRead(out var value));"
            }
        )
        Check(fixture, source, oracle, "RTrue|1|TrueTrue37|True|1", RuntimeReferences())
    }

    @Theory
    @InlineData("Closed")
    @InlineData("Middle")
    func SourceClass_UpcastsThroughClosedImportedBase(parent string) {
        using let fixture = CSharpFixture(ClosedContract, assemblyName: "ClosedContract", deterministic: true)
        let source = `import System
import ClosedControl
class Derived : @PARENT@ {
    override func Tag() int32 {
        Console.Write("V")
        return 9
    }
}
shared class Counts { var Receivers int32 = 0 }
func Target(value Derived) Derived {
    Counts.Receivers += 1
    Console.Write("R")
    return value
}
func Up(value Derived) Base[int32] -> value
func Main() {
    let value = Derived()
    let parent = Up(Target(value))
    Console.Write(Base[int32].Read(parent))
    Console.Write("|")
    Console.Write(Counts.Receivers)
    Console.Write("|")
    Console.Write(Object.ReferenceEquals(parent, value))
}
`.Replace("@PARENT@", parent)
        let oracle = `using System;
using ClosedControl;
class Derived : @PARENT@ {
    public override int Tag() { Console.Write("V"); return 9; }
}
class Program {
    static int receivers;
    static Derived Target(Derived value) { receivers++; Console.Write("R"); return value; }
    static Base<int> Up(Derived value) => value;
    static void Main() {
        var value = new Derived();
        var parent = Up(Target(value));
        Console.Write(Base<int>.Read(parent));
        Console.Write("|");
        Console.Write(receivers);
        Console.Write("|");
        Console.Write(Object.ReferenceEquals(parent, value));
    }
}
`.Replace("@PARENT@", parent)
        Check(fixture, source, oracle, "RV9|1|True", contractSource: ClosedContract)
    }

    @Theory
    @InlineData("Closed", "string")
    @InlineData("Middle", "uint32")
    func ClosedImportedBase_RejectsMismatchedOwner(parent string, argument string) {
        using let fixture = CSharpFixture(ClosedContract, assemblyName: "ClosedContract", deterministic: true)
        output.WriteLine("Contract source:\n" + ClosedContract)
        let declaration = "func Up(value Derived) Base[" + argument + "] -> "
        let source = "import ClosedControl\nclass Derived : " +
            parent +
            " {}\n" +
            declaration +
            "value\nfunc Main() {}\n"
        let result = Compile(fixture, source)
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal("GS0155", error.Groups[5].Value)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal((declaration.Length + 1).ToString(), error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((declaration.Length + 6).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    @Fact
    func RuntimeReferenceDiscovery_ExcludesUntrustedFiles() {
        using let fixture = CSharpFixture(Contract, assemblyName: "UpcastContract", deterministic: true)
        let unmanaged = Path.Combine(fixture.DirectoryPath, "not-managed.dll")
        File.WriteAllBytes(unmanaged, []uint8{0, 1, 2, 3})
        Assert.NotEmpty(RuntimeReferences())
        Assert.Contains(typeof(object).Assembly.Location, RuntimeReferences())
        Assert.True(File.Exists(fixture.AssemblyPath))
        Assert.True(File.Exists(unmanaged))
        Assert.Empty(RuntimeReferences(fixture.DirectoryPath))
    }

    private let MultiContract string = Contract + `
namespace MultiControl {
    public interface ITag<T> {
        int Read() => typeof(T) == typeof(int) ? 3 : typeof(T) == typeof(string) ? 5 : 7;
    }
    public interface IBoth : ITag<int>, ITag<string> {}
    public class Both : IBoth {}
    public interface IGenericBoth<T> : ITag<System.Collections.Generic.List<T>>, ITag<string> {}
    public class GenericBoth<T> : IGenericBoth<T> {}
    public static class Observe {
        public static void Int(ITag<int> value) { System.Console.Write("I"); System.Console.Write(value.Read()); }
        public static void String(ITag<string> value) { System.Console.Write("S"); System.Console.Write(value.Read()); }
        public static void Source<T>(ITag<System.Collections.Generic.List<T>> value) { System.Console.Write("T"); System.Console.Write(value.Read()); }
    }
}
`

    private func Reject(
        fixture CSharpFixture,
        source string,
        oracle string,
        oracleDiagnostic string,
        line int32,
        column int32,
        length int32,
        contractSource string? = nil,
        diagnostic string = "GS0155"
    ) {
        output.WriteLine("Contract source:\n" + (contractSource ?? Contract))
        output.WriteLine("Oracle source:\n" + oracle)
        let compilation = CSharpCompilation.Create(
            "RejectedOracle",
            []SyntaxTree{CSharpSyntaxTree.ParseText(oracle)},
            RuntimeMetadataReferences.Value.Append(MetadataReference.CreateFromFile(fixture.AssemblyPath)),
            CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable
            )
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.False(emitted.Success)
        let oracleError = Assert.Single(
            emitted.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
        )
        Assert.Equal(oracleDiagnostic, oracleError.Id)
        let result = Compile(fixture, source)
        output.WriteLine("Oracle diagnostic: " + oracleError.ToString())
        Assert.NotEqual(0, result.Code)
        let errors = Regex.Matches(
            Encoding.UTF8.GetString(result.Bytes) + result.Error,
            `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`
        )
        let error = Assert.Single(errors)
        Assert.Equal(diagnostic, error.Groups[5].Value)
        Assert.Equal(line.ToString(), error.Groups[1].Value)
        Assert.Equal(column.ToString(), error.Groups[2].Value)
        Assert.Equal(line.ToString(), error.Groups[3].Value)
        Assert.Equal((column + length).ToString(), error.Groups[4].Value)
        for path in[]string{"Consumer.dll", "Consumer.ref.dll", "Consumer.pdb"} {
            Assert.False(File.Exists(Path.Combine(fixture.DirectoryPath, path)))
        }
    }

    private func Check(
        fixture CSharpFixture,
        source string,
        oracle string,
        expected string,
        references IEnumerable[string]? = nil,
        contractSource string? = nil
    ) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        output.WriteLine("Contract source:\n" + (contractSource ?? Contract))
        output.WriteLine("Oracle source:\n" + oracle)
        let result = Compile(fixture, source, references)
        Assert.True(result.Code == 0, Encoding.UTF8.GetString(result.Bytes) + result.Error)
        Assert.Empty(result.Error)
        let image = Path.Combine(fixture.DirectoryPath, "Consumer.dll")
        let paths = []string{
            image,
            Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
            Path.Combine(fixture.DirectoryPath, "Consumer.pdb")
        }
        let bytes = paths.Select((path string) -> File.ReadAllBytes(path)).ToArray()
        for content in bytes {
            Assert.NotEmpty(content)
        }
        let repeat = Compile(fixture, source, references)
        Assert.Equal(0, repeat.Code)
        Assert.Equal(result.Bytes, repeat.Bytes)
        Assert.Equal(result.Error, repeat.Error)
        for var index = 0; index < paths.Length; index++ {
            Assert.Equal(bytes[index], File.ReadAllBytes(paths[index]))
        }
        let oraclePath = Path.Combine(fixture.DirectoryPath, "Oracle.dll")
        let compilation = CSharpCompilation.Create(
            "Oracle",
            []SyntaxTree{CSharpSyntaxTree.ParseText(oracle)},
            RuntimeMetadataReferences.Value.Append(MetadataReference.CreateFromFile(fixture.AssemblyPath)),
            CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
                nullableContextOptions: NullableContextOptions.Enable,
                deterministic: true
            )
        )
        let emitted = compilation.Emit(oraclePath)
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        for path in paths.Concat([]string{oraclePath}) {
            RecordArtifact(path)
        }
        File.Copy(
            Path.ChangeExtension(image, ".runtimeconfig.json"),
            Path.ChangeExtension(oraclePath, ".runtimeconfig.json")
        )
        VerifyContractOnce(fixture.AssemblyPath, contractSource ?? Contract)
        Verify(image, fixture.AssemblyPath)
        Verify(oraclePath, fixture.AssemblyPath)
        let missing = VerifyResult(image, nil)
        Assert.NotEqual(0, missing.Code)
        Assert.Contains(
            Path.GetFileNameWithoutExtension(fixture.AssemblyPath),
            Encoding.UTF8.GetString(missing.Bytes) + missing.Error,
            StringComparison.Ordinal
        )
        for executable in[]string{image, oraclePath} {
            let executed = Run([]string{executable})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Bytes)
        }
    }

    private func Compile(fixture CSharpFixture, source string, references IEnumerable[string]? = nil)(
        Code int32,
        Bytes[]uint8,
        Error string
    ) {
        let path = Path.Combine(fixture.DirectoryPath, "Consumer.gs")
        File.WriteAllText(path, source)
        output.WriteLine("G# source:\n" + source)
        RecordArtifact(fixture.AssemblyPath)
        RecordArtifact(typeof(Issue5388ImportedBaseUpcastDriverTests).Assembly.Location)
        RecordArtifact(typeof(Program).Assembly.Location)
        RecordArtifact(Path.Combine(Path.GetDirectoryName(typeof(Program).Assembly.Location)!!, "GSharp.Core.dll"))
        let arguments = List[string]{
            typeof(Program).Assembly.Location,
            path,
            "/target:exe",
            "/targetframework:net10.0",
            "/deterministic+",
            "/debug:portable",
            "/out:" + Path.Combine(fixture.DirectoryPath, "Consumer.dll"),
            "/refout:" + Path.Combine(fixture.DirectoryPath, "Consumer.ref.dll"),
            "/reference:" + fixture.AssemblyPath
        }
        if references != nil {
            arguments.AddRange(references.Select((reference string) -> "/reference:" + reference))
        }
        return Run(arguments)
    }

    private func Verify(image string, contract string?) {
        let verified = VerifyResult(image, contract)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Bytes) + verified.Error)
        Assert.Empty(verified.Error)
    }

    private func VerifyResult(image string, contract string?)(Code int32, Bytes[]uint8, Error string) {
        let arguments = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in RuntimeReferences() {
            arguments.Add("-r")
            arguments.Add(path)
        }
        if contract != nil {
            arguments.Add("-r")
            arguments.Add(contract)
        }
        return Run(arguments)
    }

    private func Run(arguments IEnumerable[string])(Code int32, Bytes[]uint8, Error string) {
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in arguments {
            start.ArgumentList.Add(argument)
        }
        output.WriteLine("argv: dotnet " + string.Join(" ", arguments))
        output.WriteLine("cwd: " + Environment.CurrentDirectory)
        for name in start.Environment.Keys.OrderBy((name string) -> name, StringComparer.Ordinal) {
            if name == "PATH" || name == "HOME" || name == "TMPDIR" || name.StartsWith(
                "DOTNET_",
                StringComparison.Ordinal
            ) ||
                name.StartsWith("GSHARP_", StringComparison.Ordinal) {
                output.WriteLine("env " + name + "=" + start.Environment[name])
            }
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
        using let stdout = MemoryStream()
        let read = process.StandardOutput.BaseStream.CopyToAsync(stdout)
        let error = process.StandardError.ReadToEndAsync()
        let exited = process.WaitForExit(30_000)
        if !exited {
            process.Kill(entireProcessTree: true)
        }
        process.WaitForExit()
        read.GetAwaiter().GetResult()
        let stderr = error.GetAwaiter().GetResult()
        output.WriteLine(
            "exit: " + process.ExitCode.ToString() + "; stdout hex: " + Convert.ToHexString(stdout.ToArray()) +
                "; stderr: " +
                stderr
        )
        Assert.True(exited, "Imported-base driver exceeded 30 seconds.")
        return (process.ExitCode, stdout.ToArray(), stderr)
    }

    private func RecordArtifact(path string) -> output.WriteLine(
        "SHA256 " + path + ": " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
    )

    private func VerifyContractOnce(contractPath string, contractSource string) {
        if VerifiedContracts.Add(contractSource) {
            Verify(contractPath, nil)
        }
    }

    shared {
        private let VerifiedContracts HashSet[string] = HashSet[string](StringComparer.Ordinal)

        private let CachedDefaultRuntimeReferences Lazy[[]string] = Lazy[[]string](
            () -> {
                let directory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                return ReferenceResolver
                    .HostTrustedPlatformAssemblyPaths()
                    .Where((path string) -> Path.GetDirectoryName(path) == directory)
                    .OrderBy((path string) -> path, StringComparer.Ordinal)
                    .ToArray()
            }
        )

        private let RuntimeMetadataReferences Lazy[[]MetadataReference] = Lazy[[]MetadataReference](
            () -> RuntimeReferences().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToArray()
        )

        private func RuntimeReferences(runtime string? = nil)[]string {
            if runtime == nil {
                return CachedDefaultRuntimeReferences.Value
            }
            return ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where((path string) -> Path.GetDirectoryName(path) == runtime)
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
        }

        private const ClosedContract string = `#nullable enable
namespace ClosedControl {
    public class Base<T> {
        public virtual int Tag() => 3;
        public static int Read(Base<T> value) => value.Tag();
    }
    public class Closed : Base<int> {}
    public class Reordered<A,B> : Base<B> {}
    public class Middle : Reordered<string,int> {}
}
`

        private const Contract string = `#nullable disable
namespace UpcastControl {
    public class Base<T> where T : unmanaged {
        public static int Read(Base<T> value) => 1;
    }
#nullable enable
    public class Pair<A, B> {
        public virtual int Tag() => 3;
        public static int Read(Pair<A,B> value) => value.Tag();
        public static bool IsNil(Pair<A,B>? value) => value is null;
    }
    public class Forward<T> : Pair<string, T> { }
}
`
    }
}
