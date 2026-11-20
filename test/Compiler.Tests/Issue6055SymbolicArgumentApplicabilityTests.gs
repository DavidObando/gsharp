package GSharp.Compiler.Tests

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6055SymbolicArgumentApplicabilityTests {
    @Fact
    func ClosedSourceArguments_UseSymbolicConversionsAcrossErasureSurrogates() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "Contract6055")
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import Contracts6055
internal enum Failure { Suspension, NestedClosure }
class Values : Dictionary[string, Failure] {}
func ReadNullable(values Values?) int32 -> Sink[Failure].Read(values)
class State {
    init() { Failures = Dictionary[string, Failure](StringComparer.Ordinal) }
    prop Failures Dictionary[string, Failure] { get; }
    var Reads int32
    prop Snapshot Dictionary[string, Failure] {
        get {
            Reads++
            return Failures
        }
    }
}
let state = State()
let empty = Dictionary[string, Failure](state.Failures, StringComparer.Ordinal)
Console.WriteLine(empty.Count)
state.Failures.Add("failure", Failure.NestedClosure)
let copy = Dictionary[string, Failure](state.Snapshot, StringComparer.Ordinal)
let local = Dictionary[string, Failure](StringComparer.Ordinal)
local.Add("failure", Failure.Suspension)
let localCopy = Dictionary[string, Failure](local, StringComparer.Ordinal)
Console.WriteLine(copy["failure"] == Failure.NestedClosure)
Console.WriteLine(localCopy["failure"] == Failure.Suspension)
Console.WriteLine(state.Reads)
Console.WriteLine(Sink[Failure](state.Failures).Count)
Console.WriteLine(Sink[Failure].Read(state.Failures))
Console.WriteLine(Sink[Failure](local).Count)
Console.WriteLine(Sink[Failure].Read(local))
Console.WriteLine(Exact[Failure](state.Failures).Count)
Console.WriteLine(Sink[Failure].Read(nil))
Console.WriteLine(ReadNullable(nil))
Console.WriteLine(ReadNullable(Values()))
var optional Failure? = Failure.Suspension
Console.WriteLine(Sink[Failure].Read(optional))
Console.WriteLine(object.ReferenceEquals(copy.Comparer, StringComparer.Ordinal))
copy.Clear()
Console.WriteLine(state.Failures.Count)
var writable Dictionary[string, Failure] = state.Failures
Sink[Failure].Clear(&writable)
Console.WriteLine(state.Failures.Count)
`, "Source6055", executable: true, "/r:" + contract)
        IlVerifier.Verify(dll, []string{contract})
        let native = fixture.CompileCSharpExecutable(`using System;
using System.Collections.Generic;
internal enum Failure { Suspension, NestedClosure }
class Values : Dictionary<string, Failure> {}
class State {
    public Dictionary<string, Failure> Failures { get; } = new(StringComparer.Ordinal);
    public int Reads;
    public Dictionary<string, Failure> Snapshot { get { Reads++; return Failures; } }
}
class P {
    static int ReadNullable(Values? values) => Sink<Failure>.Read(values);
    static void Main() {
        var state = new State();
        var empty = new Dictionary<string, Failure>(state.Failures, StringComparer.Ordinal);
        Console.WriteLine(empty.Count);
        state.Failures.Add("failure", Failure.NestedClosure);
        var copy = new Dictionary<string, Failure>(state.Snapshot, StringComparer.Ordinal);
        var local = new Dictionary<string, Failure>(StringComparer.Ordinal);
        local.Add("failure", Failure.Suspension);
        var localCopy = new Dictionary<string, Failure>(local, StringComparer.Ordinal);
        Console.WriteLine(copy["failure"] == Failure.NestedClosure);
        Console.WriteLine(localCopy["failure"] == Failure.Suspension);
        Console.WriteLine(state.Reads);
        Console.WriteLine(new Sink<Failure>(state.Failures).Count);
        Console.WriteLine(Sink<Failure>.Read(state.Failures));
        Console.WriteLine(new Sink<Failure>(local).Count);
        Console.WriteLine(Sink<Failure>.Read(local));
        Console.WriteLine(new Exact<Failure>(state.Failures).Count);
        Console.WriteLine(Sink<Failure>.Read(null));
        Console.WriteLine(ReadNullable(null));
        Console.WriteLine(ReadNullable(new Values()));
        Failure? optional = Failure.Suspension;
        Console.WriteLine(Sink<Failure>.Read(optional));
        Console.WriteLine(ReferenceEquals(copy.Comparer, StringComparer.Ordinal));
        copy.Clear();
        Console.WriteLine(state.Failures.Count);
        Dictionary<string, Failure> writable = state.Failures;
        Sink<Failure>.Clear(ref writable);
        Console.WriteLine(state.Failures.Count);
    }
}
public sealed class Sink<T> {
    public Sink(IDictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Sink(object? values) { Count = -1; }
    public int Count { get; }
    public static int Read(IDictionary<string, T>? values) => values?.Count ?? 99;
    public static int Read(object? values) => -1;
    public static void Clear(ref Dictionary<string, T> values) => values.Clear();
}
public sealed class Exact<T> {
    public Exact(Dictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Exact(params Dictionary<string, T>[] values) { Count = values.Length; }
    public int Count { get; }
}`, "Native6055")
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes(
            "0\nTrue\nTrue\n1\n1\n1\n1\n1\n1\n99\n99\n0\n-1\nTrue\n1\n0\n".Replace("\n", Environment.NewLine)
        )
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
        for target in[]string{"Other", "object", "int32"} {
            let (code, diagnostics) = fixture.TryCompile(`import System
import System.Collections.Generic
enum Failure { Suspension }
enum Other { Suspension }
class State {
    init() { Values = Dictionary[string, Failure]() }
    prop Values Dictionary[string, Failure] { get; }
}
let copy = Dictionary[string, TARGET](State().Values, StringComparer.Ordinal)
`.Replace("TARGET", target), "Reject6055", executable: true)
            Assert.True(code != 0, target + ": " + diagnostics)
            Assert.Contains("Reject6055.gs(9,12,9,22): error GS0267", diagnostics)
            AssertNativeRejects(
                "Dictionary<string, " +
                    (
                    if target == "int32" {
                        "int"
                    } else {
                        target
                    }
                ) +
                    ">",
                "new State().Values, StringComparer.Ordinal",
                contract
            )
        }
    }

    @Theory
    @InlineData("State().Values")
    @InlineData("State().Values, State().Values")
    func ErasedClrIdentity_DoesNotAdmitInvariantArguments(arguments string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "Contract6056")
        let (code, diagnostics) = fixture.TryCompile(`import Contracts6055
import System.Collections.Generic
enum Failure { Suspension }
class State {
    init() { Values = Dictionary[string, Failure]() }
    prop Values Dictionary[string, Failure] { get; }
}
let copy = Exact[int32](ARGUMENTS)
`.Replace("ARGUMENTS", arguments), "Reject6056", executable: true, "/r:" + contract)
        Assert.True(code != 0, diagnostics)
        Assert.Contains("Reject6056.gs(8,12,8,17): error GS0267", diagnostics)
        AssertNativeRejects("Exact<int>", arguments.Replace("State()", "new State()"), contract)
    }

    @Fact
    func GenericArrayArgument_RetainsIdentityRankAcrossImportedAnnotations() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
import System.Collections.Immutable
class Item {}
let items = []Item{Item(), Item()}
let values = ImmutableArray.Create(items)
Console.WriteLine(values.Length)
Console.WriteLine(values[0].GetType().Name)
`, "Bulk6056", executable: true)
        let native = fixture.CompileCSharpExecutable(`using System;
using System.Collections.Immutable;
class Item {}
class P {
    static void Main() {
        var items = new Item[] { new(), new() };
        var values = ImmutableArray.Create(items);
        Console.WriteLine(values.Length);
        Console.WriteLine(values[0].GetType().Name);
    }
}`, "NativeBulk6056")
        IlVerifier.Verify(dll)
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes("2\nItem\n".Replace("\n", Environment.NewLine))
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
    }

    @Fact
    func UnrelatedImplicitOperator_DoesNotVetoContextualProjection() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "ProjectionContract6056")
        let dll = fixture.Compile(`import System
import Contracts6055
class PtSource {
    var x int32
    var y int32
    func operator implicit(value PtSource) int32 -> -1
}
Console.WriteLine(Projection.Read(PtSource{x: 3, y: 4}))
Console.WriteLine(Projection.ReadMany(PtSource{x: 3, y: 4}, PtSource{x: 5, y: 6}))
Console.WriteLine(object.Equals(default(PtSource?), nil))
`, "Projection6056", executable: true, "/r:" + contract)
        let native = fixture.CompileCSharpExecutable(ContractSource + `
class PtSource { public static implicit operator int(PtSource value) => -1; }
class P {
    static void Main() {
        System.Console.WriteLine(Projection.Read(new Point(3, 4)));
        System.Console.WriteLine(Projection.ReadMany(new Point(3, 4), new Point(5, 6)));
        System.Console.WriteLine(object.Equals(default(PtSource), null));
    }
}`, "NativeProjection6056")
        IlVerifier.Verify(dll, []string{contract})
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes("7\n18\nTrue\n".Replace("\n", Environment.NewLine))
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
    }

    @Fact
    func ImportedGenericParamsConstructors_AcceptSymbolicAndSameClosedArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource + ExtraContractSource, "ParamsContract6061")
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import Contracts6055
enum Failure { Suspension, NestedClosure }
struct BoxVal {
    var Value int32
    init(value int32) { Value = value }
    override func ToString() string -> Value.ToString()
}
class BoxRef {
    var Name string
    init(name string) { Name = name }
    override func ToString() string -> Name
}
class State {
    init() {
        Values = Dictionary[string, Failure](StringComparer.Ordinal)
        Values.Add("k", Failure.Suspension)
    }
    prop Values Dictionary[string, Failure] { get; }
}
let s = State()
let two = Exact[Failure](s.Values, s.Values)
let normal = Exact[Failure]([]Dictionary[string, Failure]{ s.Values, s.Values })
let zero = Exact[Failure]()
let single = Exact[Failure](s.Values)
let nilSingle = Exact[Failure](cast[Dictionary[string, Failure]?](nil))
let enumParams = ParamsBox[Failure](Failure.Suspension, Failure.NestedClosure)
let structParams = ParamsBox[BoxVal](BoxVal(11), BoxVal(22))
let refParams = ParamsBox[BoxRef](BoxRef("a"), BoxRef("b"))
let nullableRefParams = NullableParamsBox[BoxRef](nil, BoxRef("ok"))
let taggedParams = TaggedParamsBox[Failure](7, s.Values, s.Values)
let methodCount = Exact[Failure].CountAll(s.Values, s.Values)
Console.WriteLine(two.Count)
Console.WriteLine(normal.Count)
Console.WriteLine(zero.Count)
Console.WriteLine(single.Count)
Console.WriteLine(nilSingle.Count)
Console.WriteLine("${enumParams.Count}:${enumParams.Describe()}")
Console.WriteLine("${structParams.Count}:${structParams.Describe()}")
Console.WriteLine("${refParams.Count}:${refParams.Describe()}")
Console.WriteLine("${nullableRefParams.Count}:${nullableRefParams.Describe()}")
Console.WriteLine("${taggedParams.Tag}:${taggedParams.Count}")
Console.WriteLine(methodCount)
`, "Params6061", executable: true, "/r:" + contract)
        IlVerifier.Verify(dll, []string{contract})
        let native = fixture.CompileCSharpExecutable(`using System;
using System.Collections.Generic;
` + ContractSource.Replace("using System.Collections.Generic;\nnamespace Contracts6055;", "") + ExtraContractSource + `
enum Failure { Suspension, NestedClosure }
struct BoxVal {
    public int Value;
    public BoxVal(int value) { Value = value; }
    public override string ToString() => Value.ToString();
}
class BoxRef {
    public string Name;
    public BoxRef(string name) { Name = name; }
    public override string ToString() => Name;
}
class State {
    public Dictionary<string, Failure> Values { get; } = new(StringComparer.Ordinal) { ["k"] = Failure.Suspension };
}
class P {
    static void Main() {
        var s = new State();
        var two = new Exact<Failure>(s.Values, s.Values);
        var normal = new Exact<Failure>(new Dictionary<string, Failure>[] { s.Values, s.Values });
        var zero = new Exact<Failure>();
        var single = new Exact<Failure>(s.Values);
        var nilSingle = new Exact<Failure>((Dictionary<string, Failure>?)null);
        var enumParams = new ParamsBox<Failure>(Failure.Suspension, Failure.NestedClosure);
        var structParams = new ParamsBox<BoxVal>(new BoxVal(11), new BoxVal(22));
        var refParams = new ParamsBox<BoxRef>(new BoxRef("a"), new BoxRef("b"));
        var nullableRefParams = new NullableParamsBox<BoxRef>(null, new BoxRef("ok"));
        var taggedParams = new TaggedParamsBox<Failure>(7, s.Values, s.Values);
        var methodCount = Exact<Failure>.CountAll(s.Values, s.Values);
        Console.WriteLine(two.Count);
        Console.WriteLine(normal.Count);
        Console.WriteLine(zero.Count);
        Console.WriteLine(single.Count);
        Console.WriteLine(nilSingle.Count);
        Console.WriteLine($"{enumParams.Count}:{enumParams.Describe()}");
        Console.WriteLine($"{structParams.Count}:{structParams.Describe()}");
        Console.WriteLine($"{refParams.Count}:{refParams.Describe()}");
        Console.WriteLine($"{nullableRefParams.Count}:{nullableRefParams.Describe()}");
        Console.WriteLine($"{taggedParams.Tag}:{taggedParams.Count}");
        Console.WriteLine(methodCount);
    }
}`, "NativeParams6061")
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes(
            "2\n2\n0\n1\n99\n2:Suspension,NestedClosure\n2:11,22\n2:a,b\n2:null,ok\n7:2\n2\n".Replace(
                "\n",
                Environment.NewLine
            )
        )
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("Exact[Other](State().Values, State().Values)")
    @InlineData("Exact[Other]([]Dictionary[string, Failure]{ State().Values })")
    @InlineData("Exact[int32]([]Dictionary[string, Failure]{ State().Values })")
    @InlineData("Exact[Failure]([]Dictionary[string, int32]{ Dictionary[string, int32]() })")
    func ImportedGenericParamsConstructors_RejectInvariantSymbolicMismatches(callExpr string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource, "RejectParamsContract6061")
        let (code, diagnostics) = fixture.TryCompile(`import Contracts6055
import System.Collections.Generic
enum Failure { Suspension }
enum Other { Suspension }
class State {
    init() { Values = Dictionary[string, Failure]() }
    prop Values Dictionary[string, Failure] { get; }
}
let copy = CALL_EXPR
`.Replace("CALL_EXPR", callExpr), "RejectParams6061", executable: true, "/r:" + contract)
        Assert.True(code != 0, diagnostics)
        Assert.True(
            diagnostics.Contains("error GS0267", StringComparison.Ordinal) || diagnostics.Contains(
                "error GS0155",
                StringComparison.Ordinal
            ),
            diagnostics
        )
    }

    @Fact
    func ImportedNullableGenericConstructors_AcceptNilAndEnforceNullabilityContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource + ExtraContractSource, "NullableCtorContract6059")
        let obliviousContract = fixture.CompileCSharp(ObliviousContractSource, "ObliviousCtorContract6059")
        let dll = fixture.Compile(`import System
import System.Collections.Generic
import Contracts6055
enum Failure { Suspension }
class BoxRef {
    var Name string
    init(name string) { Name = name }
}
func MakeClass[U class]() string -> OpenSlotBox[U](nil).Tag
let nilBox = NullableBox[Failure](nil)
let defaultBox = NullableBox[Failure](default(List[Failure]?))
let items = List[Failure]()
items.Add(Failure.Suspension)
let nonNullBox = NullableBox[Failure](items)
let objBox = NullableBox[Failure]("hello")
let nestedNil = Outer[Failure].Inner[BoxRef](nil, nil)
let nestedNonNull = Outer[Failure].Inner[BoxRef](items, List[BoxRef]())
let valNil = ValueNullableBox[Failure](nil)
let valSet = ValueNullableBox[Failure](Failure.Suspension)
let openRefStr = OpenSlotBox[string](nil)
let openRefUser = OpenSlotBox[BoxRef](nil)
let openRefGeneric = MakeClass[BoxRef]()
let obliviousNil = ObliviousBox[Failure](nil)
Console.WriteLine(nilBox.Tag)
Console.WriteLine(defaultBox.Tag)
Console.WriteLine(nonNullBox.Tag)
Console.WriteLine(objBox.Tag)
Console.WriteLine(nestedNil.Tag)
Console.WriteLine(nestedNonNull.Tag)
Console.WriteLine("${valNil.HasValue}:${valSet.HasValue}:${valSet.Value}")
Console.WriteLine("${openRefStr.Tag}:${openRefUser.Tag}:${openRefGeneric}")
Console.WriteLine(obliviousNil.Tag)
`, "NullableCtor6059", executable: true, "/r:" + contract, "/r:" + obliviousContract)
        IlVerifier.Verify(dll, []string{contract, obliviousContract})
        let native = fixture.CompileCSharpExecutable(`using System;
using System.Collections.Generic;
` + ContractSource.Replace("using System.Collections.Generic;\nnamespace Contracts6055;", "") +
                ExtraContractSource +
                "\n" +
                ObliviousContractSource
                .Replace("#nullable disable", "")
                .Replace("using System.Collections.Generic;", "")
                .Replace("namespace Contracts6055;", "") +
                `
enum Failure { Suspension }
class BoxRef {
    public string Name;
    public BoxRef(string name) { Name = name; }
}
class P {
    static string MakeClass<U>() where U : class => new OpenSlotBox<U>(null).Tag;
    static void Main() {
        var nilBox = new NullableBox<Failure>(null);
        var defaultBox = new NullableBox<Failure>(default(List<Failure>?));
        var items = new List<Failure> { Failure.Suspension };
        var nonNullBox = new NullableBox<Failure>(items);
        var objBox = new NullableBox<Failure>("hello");
        var nestedNil = new Outer<Failure>.Inner<BoxRef>(null, null);
        var nestedNonNull = new Outer<Failure>.Inner<BoxRef>(items, new List<BoxRef>());
        var valNil = new ValueNullableBox<Failure>(null);
        var valSet = new ValueNullableBox<Failure>(Failure.Suspension);
        var openRefStr = new OpenSlotBox<string>(null);
        var openRefUser = new OpenSlotBox<BoxRef>(null);
        var openRefGeneric = MakeClass<BoxRef>();
        var obliviousNil = new ObliviousBox<Failure>(null);
        Console.WriteLine(nilBox.Tag);
        Console.WriteLine(defaultBox.Tag);
        Console.WriteLine(nonNullBox.Tag);
        Console.WriteLine(objBox.Tag);
        Console.WriteLine(nestedNil.Tag);
        Console.WriteLine(nestedNonNull.Tag);
        Console.WriteLine($"{valNil.HasValue}:{valSet.HasValue}:{valSet.Value}");
        Console.WriteLine($"{openRefStr.Tag}:{openRefUser.Tag}:{openRefGeneric}");
        Console.WriteLine(obliviousNil.Tag);
    }
}`, "NativeNullableCtor6059")
        IlVerifier.Verify(native)
        File.Copy(Path.ChangeExtension(dll, ".runtimeconfig.json"), Path.ChangeExtension(native, ".runtimeconfig.json"))
        let expected = Encoding.UTF8.GetBytes(
            "list:null\nlist:null\nlist:1\nobject\nnull,null\n1,0\nFalse:True:Suspension\nnull:null:null\nob-null\n"
                .Replace("\n", Environment.NewLine)
        )
        Assert.Equal(expected, fixture.RunBytes(native))
        Assert.Equal(expected, fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("let b = StrictBox[Failure](nil)")
    @InlineData("let b = OpenSlotBox[Failure](nil)")
    @InlineData("let b = OpenSlotBox[int32](nil)")
    @InlineData("func bad[U]() -> OpenSlotBox[U](nil)")
    @InlineData("class R {}\nlet b = ParamsBox[R](nil)")
    func ImportedNonNullableGenericConstructors_RejectNil(body string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(ContractSource + ExtraContractSource, "RejectNullableCtor6059")
        let (code, diagnostics) = fixture.TryCompile(`import Contracts6055
import System.Collections.Generic
enum Failure { Suspension }
` + body, "RejectNullableCtorCase6059", executable: false, "/r:" + contract)
        Assert.True(code != 0, diagnostics)
        Assert.True(
            diagnostics.Contains("error GS0155", StringComparison.Ordinal) || diagnostics.Contains(
                "error GS0267",
                StringComparison.Ordinal
            ),
            diagnostics
        )
    }

    shared {
        private func AssertNativeRejects(target string, arguments string, contract string) {
            let source = `using System;
using System.Collections.Generic;
using Contracts6055;
enum Failure { Suspension }
enum Other { Suspension }
class State {
    public Dictionary<string, Failure> Values { get; } = new();
}
class Check { static void Main() { var copy = new TARGET(ARGUMENTS); } }
`.Replace("TARGET", target).Replace("ARGUMENTS", arguments)
            let references = cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                .Split(Path.PathSeparator)
                .Append(contract)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "NativeRejected6056",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            let errors = compilation
                .GetDiagnostics()
                .Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                .ToArray()
            Assert.NotEmpty(errors)
            Assert.All(errors, (diagnostic Diagnostic) -> Assert.Equal("CS1503", diagnostic.Id))
        }

        private const ContractSource string = `using System.Collections.Generic;
namespace Contracts6055;
public sealed class Sink<T> {
    public Sink(IDictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Sink(object? values) { Count = -1; }
    public int Count { get; }
    public static int Read(IDictionary<string, T>? values) => values?.Count ?? 99;
    public static int Read(object? values) => -1;
    public static void Clear(ref Dictionary<string, T> values) => values.Clear();
}
public sealed class Exact<T> {
    public Exact(Dictionary<string, T>? values) { Count = values?.Count ?? 99; }
    public Exact(params Dictionary<string, T>[] values) { Count = values.Length; }
    public int Count { get; }
    public static int CountAll(params Dictionary<string, T>[] values) => values.Length;
}
public sealed class Point {
    public Point(int x, int y) { X = x; Y = y; }
    public int X { get; }
    public int Y { get; }
}
public static class Projection {
    public static int Read(Point value) => value.X + value.Y;
    public static int ReadMany(params Point[] values) {
        int total = 0;
        foreach (var value in values) total += Read(value);
        return total;
    }
}`

        private const ExtraContractSource string = `
public sealed class ParamsBox<T> {
    private readonly T[] _values;
    public ParamsBox(params T[] values) { _values = values; }
    public int Count => _values.Length;
    public string Describe() => string.Join(",", System.Array.ConvertAll(_values, v => v?.ToString() ?? "null"));
}
public sealed class NullableParamsBox<T> {
    private readonly T?[] _values;
    public NullableParamsBox(params T?[] values) { _values = values; }
    public int Count => _values.Length;
    public string Describe() => string.Join(",", System.Array.ConvertAll(_values, v => v?.ToString() ?? "null"));
}
public sealed class TaggedParamsBox<T> {
    public TaggedParamsBox(int tag, params Dictionary<string, T>[] values) { Tag = tag; Count = values.Length; }
    public int Tag { get; }
    public int Count { get; }
}
public sealed class NullableBox<T> {
    public NullableBox(List<T>? values) { Tag = values == null ? "list:null" : "list:" + values.Count; }
    public NullableBox(object? values) { Tag = "object"; }
    public string Tag { get; }
}
public sealed class StrictBox<T> {
    public StrictBox(List<T> values) { Count = values.Count; }
    public int Count { get; }
}
public sealed class OpenSlotBox<T> {
    public OpenSlotBox(T? value) { Tag = value == null ? "null" : "nonnull"; }
    public string Tag { get; }
}
public sealed class ValueNullableBox<T> where T : struct {
    public ValueNullableBox(T? value) { HasValue = value.HasValue; Value = value.GetValueOrDefault(); }
    public bool HasValue { get; }
    public T Value { get; }
}
public static class Outer<T> {
    public sealed class Inner<U> {
        public Inner(List<T>? left, List<U>? right) {
            Tag = (left?.Count.ToString() ?? "null") + "," + (right?.Count.ToString() ?? "null");
        }
        public string Tag { get; }
    }
}`

        private const ObliviousContractSource string = `#nullable disable
using System.Collections.Generic;
namespace Contracts6055;
public sealed class ObliviousBox<T> {
    public ObliviousBox(List<T> values) { Tag = values == null ? "ob-null" : "ob:" + values.Count; }
    public string Tag { get; }
}`
    }
}
