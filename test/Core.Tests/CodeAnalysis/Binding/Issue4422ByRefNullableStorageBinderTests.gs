// <copyright file="Issue4422ByRefNullableStorageBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit
import GSharp.Core.Tests
import System

/// Issue #4422: the storage behind a by-reference argument (`&x` at a
/// `ref`, `out` or `in` parameter of a G# callee) must have the
/// parameter's type, except that it may differ in reference nullability, as
/// in C#. Such an argument is accepted with a GS0612 warning in the direction
/// a nil can flow through the shared storage, and never with one for a
/// platform (`T!`) position. A value-type `int32?` is
/// `Nullable<int32>`, a different runtime type, and stays GS0154.
///
/// Before the fix the gate compared CLR types when exactly one side was a
/// nullable wrapper, and a nullable wrapper relays its underlying CLR type.
/// So same-compilation `T?` storage was accepted with no diagnostic at
/// all, `int32?` storage at `ref int32` compiled and wrote an
/// `int32` over the `Nullable<int32>`, and an imported
/// `int[]?` field was rejected with GS0154.
open class Issue4422ByRefNullableStorageBinderTests {
    @Theory
    @InlineData("Clear(&slot)")
    @InlineData("Writer().Clear(&slot)")
    @InlineData("let sink = Sink(&slot)")
    func GenericOutInference_UsesDeclaredSupertypeStorage(call string) {
        let result = EmittedOracle.Evaluate(`
func Clear[T](out target T) { target = default(T) }
class Writer {
    func Clear[T](out target T) { target = default(T) }
}
class Sink[T] {
    init(out target T) { target = default(T) }
}
func Run(input object?) bool {
    var slot object? = input
    if slot == nil {
        slot = "unused"
        return false
    }
    if slot !is string { return false }
    ` + call + `
    return slot == nil
}
Console.WriteLine(Run("before"))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.Output.Trim())
    }

    @Theory
    @InlineData("Write(&value)")
    @InlineData("Write(&{ let marker = 0\nvalue })")
    @InlineData("Writer().Write(&value)")
    @InlineData("let sink = Sink(&value)")
    func OutParameter_UsesDeclaredNullableStorageAfterAnExitingWrite(call string) {
        let result = EmittedOracle.Evaluate(`
func Write(out target string?) { target = nil }
class Writer {
    func Write(out target string?) { target = nil }
}
class Sink {
    init(out target string?) { target = nil }
}
func Run(input string?) bool {
    var value string? = input
    if value == nil {
        value = "unused"
        return false
    }
    ` + call + `
    return value == nil
}
Console.WriteLine(Run("before"))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("True", result.Output.Trim())
    }

    @Fact
    func OutOverload_PrefersTheDeclaredNullableStorage() {
        let result = EmittedOracle.Evaluate(`
func Pick(out target string) string {
    target = "non-null"
    return "non-null"
}
func Pick(out target string?) string {
    target = nil
    return "nullable"
}
func Run(input string?) string {
    var value string? = input
    if value == nil {
        value = "unused"
        return ""
    }
    return Pick(&value)
}
Console.WriteLine(Run("before"))
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nullable", result.Output.Trim())
    }

    @Theory
    @InlineData("var v string? = nil\nRefS(&v)", "ref")
    @InlineData("var v string? = if true { \"a\" } else { nil }\nInS(&v)", "in")
    @InlineData("var v string = \"a\"\nRefNs(&v)", "ref")
    @InlineData("var v string = \"a\"\nOutNs(&v)", "out")
    @InlineData("var v List[string?] = List[string?]()\nRefList(&v)", "ref")
    @InlineData("var v List[string?] = List[string?]()\nOutList(&v)", "out")
    @InlineData("var v List[string?] = List[string?]()\nInList(&v)", "in")
    @InlineData("var v []string? = []string?{\"a\"}\nRefS(&v[0])", "ref")
    func NullabilityOnlyDifference_IsAcceptedWithGS0612(body string, refKind string) {
        let result = EmittedOracle.Evaluate(Callees + body)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let warning = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity)
        Assert.Contains(refKind + " parameter", warning.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`var v string? = nil
OutS(&v)
Console.WriteLine(v)`, "o")
    @InlineData("var v string = \"abc\"\nConsole.WriteLine(InNs(&v))", "3")
    @InlineData(`var v string = "a"
RefS(&v)
Console.WriteLine(v)`, "r")
    @InlineData(`var v string? = nil
RefNs(&v)
Console.WriteLine(v)`, "rn")
    @InlineData(`var v string? = "a"
RefS(&v)
Console.WriteLine(InS(&v))`, "1")
    @InlineData(`var v string? = nil
OutS(&v)
RefS(&v)
Console.WriteLine(v)`, "r")
    func SafeDirection_IsAcceptedWithoutWarning(body string, expected string) {
        let result = EmittedOracle.Evaluate(Callees + body)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Output.Trim())
    }

    @Fact
    func FlowProvenNonNullNullableLocal_DoesNotWarnGS0612_UntilReassignedToNullable() {
        let result = EmittedOracle.Evaluate(Callees + `
var g string? = "x"
RefS(&g)
let len = InS(&g)
g = nil
RefS(&g)
Console.WriteLine("${len} ${g!!}")
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let warning = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        Assert.Contains("ref parameter", warning.Message, StringComparison.Ordinal)
        Assert.Equal("1 r", result.Output.Trim())
    }

    @Fact
    func NullableStorage_ReachesTheCalleeAndRuns() {
        let result = EmittedOracle.Evaluate(Callees + `
var s string? = nil
RefS(&s)
var l List[string?] = List[string?]()
RefList(&l)
var n []string? = []string?{nil, "z"}
RefS(&n[0])
Console.WriteLine("${s!!} ${l.Count} ${n[0]!!}")
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(3, result.Diagnostics.Count((d Diagnostic) -> d.Id == "GS0612"))
        Assert.Equal("r 1 r", result.Output.Trim())
    }

    @Theory
    @InlineData("var v int32? = 1\nRefInt(&v)")
    @InlineData("var v []int32? = []int32?{1}\nRefInts(&v)")
    @InlineData("var v List[int32?] = List[int32?]()\nRefIntList(&v)")
    func ValueTypeNullableStorage_IsStillGS0154(body string) {
        let result = EmittedOracle.Evaluate(Callees + body)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
    }

    @Fact
    func Overloads_WarnOnceForTheSelectedCandidate() {
        // Both candidates take the same `ref string`, so the gate would fire
        // twice if it ran per candidate rather than on the selected one.
        // (Overloads that differ only in a by-ref pointee type are GS0266 on
        // main for exact types too, so they are not the shape tested here.)
        let result = EmittedOracle.Evaluate(`
func Pick(ref s string, n int32) { s = "int" }
func Pick(ref s string, t string) { s = "string" }

class Box {
    func Pick(ref s string, n int32) { s = "method-int" }
    func Pick(ref s string, t string) { s = "method-string" }
}

var s string? = nil
Pick(&s, "x")
Console.WriteLine(s)
Box().Pick(&s, 1)
Console.WriteLine(s)
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(2, result.Diagnostics.Count((d Diagnostic) -> d.Id == "GS0612"))
        Assert.Equal(
            []string{"string", "method-int"},
            result.Output.Trim().Split('\n').Select((l string) -> l.Trim()).ToArray()
        )
    }

    @Fact
    func MethodAndConstructorCallees_UseTheSameGate() {
        let result = EmittedOracle.Evaluate(`
class Sink {
    var seen string = ""
    init(ref s string) { s = "ctor" }
    func Put(ref s string) { s = "method" }
}

var a string? = nil
let sink = Sink(&a)
Console.WriteLine(a)
sink.Put(&a)
Console.WriteLine(a)
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(2, result.Diagnostics.Count((d Diagnostic) -> d.Id == "GS0612"))
        Assert.Equal(
            []string{"ctor", "method"},
            result.Output.Trim().Split('\n').Select((l string) -> l.Trim()).ToArray()
        )
    }

    @Fact
    func ImportedAnnotatedField_IsAcceptedWithGS0612() {
        using let fixture = CSharpFixture(`#nullable enable
namespace Issue4422Fixture
{
    public class AnnotatedBase
    {
        protected internal int[]? stack = new int[] { 1, 2 };
        protected string? name = "n";
    }
}`)
        let result = EmittedOracle.Evaluate(`
import Issue4422Fixture

func Push(ref stack []int32, v int32) { stack[0] = v }
func Name(ref s string) { s = s + "!" }

class Runner : AnnotatedBase {
    func Go() string {
        Push(&base.stack, 9)
        Name(&base.name)
        return "${base.stack!![0]} ${base.name!!}"
    }
}

Console.WriteLine(Runner().Go())
`, []string{fixture.AssemblyPath})
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(2, result.Diagnostics.Count((d Diagnostic) -> d.Id == "GS0612"))
        Assert.Equal("9 n!", result.Output.Trim())
    }

    @Fact
    func ImportedObliviousField_IsAcceptedWithoutWarning() {
        // ADR-0186: an oblivious field is a platform (`T!`) position, which
        // states nothing and so differs from neither `T` nor `T?`.
        using let fixture = CSharpFixture(`#nullable disable
namespace Issue4422ObliviousFixture
{
    public class ObliviousBase
    {
        protected internal int[] stack = new int[] { 1, 2 };
    }
}`)
        let result = EmittedOracle.Evaluate(`
import Issue4422ObliviousFixture

func Push(ref stack []int32, v int32) { stack[0] = v }
func PushN(ref stack []?int32, v int32) { stack!![0] = v }

class Runner : ObliviousBase {
    func Go() int32 {
        Push(&base.stack, 9)
        PushN(&base.stack, 8)
        return base.stack[0]
    }
}

Console.WriteLine(Runner().Go())
`, []string{fixture.AssemblyPath})
        Assert.Empty(result.Diagnostics)
        Assert.Equal("8", result.Output.Trim())
    }

    @Fact
    func OverloadResolution_PrefersTheExactStorageType() {
        // Review finding: selection ignored the by-ref storage rule, so
        // `int32?` storage picked `ref int32` and then failed with GS0154
        // (on main it compiled to unverifiable IL), and `string?` storage
        // picked `ref string` with a GS0612 where C# picks the exact match.
        // Each declaration order is covered, for every call shape.
        let result = EmittedOracle.Evaluate(`
func P(ref x int32) { Console.WriteLine("p int32") }
func P(ref x int32?) { Console.WriteLine("p int32?") }
func R(ref x int32?) { Console.WriteLine("r int32?") }
func R(ref x int32) { Console.WriteLine("r int32") }
func Q(ref s string) { Console.WriteLine("q string") }
func Q(ref s string?) { Console.WriteLine("q string?") }

class K {
    init() {}
    init(ref x int32) { Console.WriteLine("ctor int32") }
    init(ref x int32?) { Console.WriteLine("ctor int32?") }
    func M(ref x int32?) { Console.WriteLine("m int32?") }
    func M(ref x int32) { Console.WriteLine("m int32") }
    func N(ref s string) { Console.WriteLine("n string") }
    func N(ref s string?) { Console.WriteLine("n string?") }
}

var a int32? = 1
var b int32 = 1
var s string? = nil
var t string = ""
P(&a)
P(&b)
R(&a)
R(&b)
Q(&s)
Q(&t)
K().M(&a)
K().M(&b)
K().N(&s)
K().N(&t)
let k1 = K(&a)
let k2 = K(&b)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            []string{
                "p int32?",
                "p int32",
                "r int32?",
                "r int32",
                "q string?",
                "q string",
                "m int32?",
                "m int32",
                "n string?",
                "n string",
                "ctor int32?",
                "ctor int32"
            },
            result.Output.Trim().Split('\n').Select((l string) -> l.Trim()).ToArray()
        )
    }

    @Theory
    @InlineData("var a int32? = 1\nP(&a)", "func P(ref x int32) {}")
    @InlineData("var a int32 = 1\nP(&a)", "func P(ref x int32?) {}")
    @InlineData("var a int32? = 1\nK().M(&a)", `class K {
 init() {}
 func M(ref x int32) {}
}`)
    @InlineData("var a int32? = 1\nlet k = K(&a)", `class K {
 init(ref x int32) {}
}`)
    func ValueTypeNullableMismatch_ExplainsTheRuntimeType(body string, declarations string) {
        let result = EmittedOracle.Evaluate(declarations + "\n" + body)
        let error = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.Contains(
            "'int32?' is a Nullable<int32>, a different runtime type",
            error.Message,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("*int32", error.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("var x int32? = 41\nInterlocked.Increment(&x)", "location")
    @InlineData("var x int32? = 41\nInt32.TryParse(\"5\", &x)", "result")
    @InlineData("var a int32? = 41\nvar b int32? = 42\nvar c = true\nInterlocked.Increment(&(c ? a : b))", "location")
    @InlineData(
        "var a int32? = 41\nvar b int32? = 42\nvar c = true\nInterlocked.Increment(ref (c ? ref a : ref b))",
        "location"
    )
    func ClrCallee_ValueTypeNullableStorage_IsGS0154(body string, parameterName string) {
        // Review finding: an imported `ref int` accepted `&int32?` storage (the
        // address's CLR type was built from the relayed `int32`) and emitted
        // IL that ILVerify rejects; the program printed 41 twice.
        let result = EmittedOracle.Evaluate("import System.Threading\n" + body)
        let error = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0154", error.Id)
        Assert.Contains("'" + parameterName + "'", error.Message, StringComparison.Ordinal)
        Assert.Contains("Nullable<int32>", error.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("var x int32? = 1\nlet _ = CtorBox(&x)", "seed")
    @InlineData("var x int32? = 1\nlet _ = CtorOptBox(&x)", "seed")
    @InlineData("let _ = CtorBox(out var x int32?, 1)", "result")
    @InlineData("var a int32? = 1\nvar b int32? = 2\nvar c = true\nlet _ = CtorBox(&(c ? a : b))", "seed")
    @InlineData("var x int32? = 1\n\"hi\".BumpExt(&x)", "delta")
    @InlineData("var x int32? = 1\n\"hi\".BumpOptExt(&x)", "delta")
    @InlineData("var a int32? = 1\nvar b int32? = 2\nvar c = true\n\"hi\".BumpExt(ref (c ? ref a : ref b))", "delta")
    @InlineData("class D : CtorBox {\n    init(ref x int32?) : base(&x) { }\n}\n0", "seed")
    @InlineData("class D : CtorOptBox {\n    init(ref x int32?) : base(&x) { }\n}\n0", "seed")
    func ClrConstructorConditionalRefAndExtension_ValueTypeNullableStorage_IsGS0154(body string, parameterName string) {
        using let fixture = CSharpFixture(`namespace Issue4464Fixture
{
    public class CtorBox
    {
        public CtorBox(ref string label) { }
        public CtorBox(ref int seed) { seed += 1; }
        public CtorBox(out int result, int tag) { result = tag; }
    }

    public class CtorOptBox
    {
        public CtorOptBox(ref int seed, int tag = 0) { seed += tag + 1; }
    }

    public static class CtorBoxExtensions
    {
        public static void BumpExt(this string receiver, ref long wide) { }
        public static void BumpExt(this string receiver, ref int delta) { delta += receiver.Length; }
        public static void BumpOptExt(this string receiver, ref int delta, int tag = 0) { delta += receiver.Length + tag; }
    }
}`)
        let result = EmittedOracle.Evaluate("import Issue4464Fixture\n" + body, []string{fixture.AssemblyPath})
        let error = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0154", error.Id)
        Assert.Contains("'" + parameterName + "'", error.Message, StringComparison.Ordinal)
        Assert.Contains("Nullable<int32>", error.Message, StringComparison.Ordinal)
    }

    @Fact
    func ClrOverloadResolution_ByValueVsByRefAndRefKindModifiers_SelectsMatchingCandidate() {
        using let fixture = CSharpFixture(`namespace Issue4418Fixture
{
    public class BasePick
    {
        public string Mode(in int x) => "in:" + x;
        public string InOrOut(in int x) => "in:" + x;
    }

    public class DerivedPick : BasePick
    {
        public string Mode(ref int x) { x += 10; return "ref:" + x; }
        public string Mode(int x) => "val:" + x;
        public string InOrOut(out int x) { x = 77; return "out:" + x; }
    }

    public class Overloads
    {
        public string Tag;

        public Overloads(int x) { Tag = "ctor-val:" + x; }
        public Overloads(in int x) { Tag = "ctor-in:" + x; }

        public static string PickIn(int x) => "val:" + x;
        public static string PickIn(in int x) => "in:" + x;

        public static string PickRef(int x) => "val:" + x;
        public static string PickRef(ref int x) { x += 1; return "ref:" + x; }

        public static string PickOut(int x) => "val:" + x;
        public static string PickOut(out int x) { x = 99; return "out:" + x; }

        public string InstIn(int x) => "inst-val:" + x;
        public string InstIn(in int x) => "inst-in:" + x;

        public string InstRef(int x) => "inst-val:" + x;
        public string InstRef(ref int x) { x += 2; return "inst-ref:" + x; }

        public static string RefShortOrLong(ref short x) { x += 1; return "ref-short:" + x; }
        public static string RefShortOrLong(long x) => "long:" + x;

        public static string MultiInVsRef(in int x, long y) => $"in-long:{x}:{y}";
        public static string MultiInVsRef(ref int x, int y) { x += y; return $"ref-int:{x}:{y}"; }
    }

    public static class OverloadExtensions
    {
        public static string ExtIn(this string s, int x) => s + ":val:" + x;
        public static string ExtIn(this string s, in int x) => s + ":in:" + x;

        public static string ExtRef(this string s, int x) => s + ":val:" + x;
        public static string ExtRef(this string s, ref int x) { x += 3; return s + ":ref:" + x; }
    }
}`)
        let result = EmittedOracle.Evaluate(`import System
import Issue4418Fixture

var v = 3
let a1 = Overloads.PickIn(v)
let a2 = Overloads.PickIn(5)
let a3 = Overloads.PickIn(default)
let a4 = Overloads.PickIn(in v)
let b1 = Overloads.PickRef(v)
let b2 = Overloads.PickRef(5)
let b3 = Overloads.PickRef(default)
let b4 = Overloads.PickRef(ref v)
let c1 = Overloads.PickOut(v)
let c2 = Overloads.PickOut(5)
var outSlot = 0
let c3 = Overloads.PickOut(out outSlot)
let dp = DerivedPick()
let d1 = dp.InOrOut(v)
let d2 = dp.InOrOut(in v)
let d3 = dp.InOrOut(out var outInl)
let inst = Overloads(v)
let instIn = Overloads(in v)
let e1 = inst.InstIn(v)
let e2 = inst.InstIn(in v)
let e3 = inst.InstRef(v)
let e4 = inst.InstRef(ref v)
let f1 = dp.Mode(v)
let f2 = dp.Mode(in v)
let f3 = dp.Mode(ref v)
let g1 = "s".ExtIn(v)
let g2 = "s".ExtIn(in v)
let g3 = "s".ExtRef(v)
let g4 = "s".ExtRef(ref v)
let h1 = Overloads.RefShortOrLong(v)
let h1c = Overloads.RefShortOrLong(5)
let h2 = Overloads.MultiInVsRef(v, 1)
let h3 = Overloads.MultiInVsRef(in v, 1)
let h4 = Overloads.MultiInVsRef(ref v, 1)
Console.WriteLine("${a1} ${a2} ${a3} ${a4}")
Console.WriteLine("${b1} ${b2} ${b3} ${b4}")
Console.WriteLine("${c1} ${c2} ${c3} ${d1} ${d2} ${d3}:${outInl}")
Console.WriteLine("${inst.Tag} ${instIn.Tag} ${e1} ${e2} ${e3} ${e4}")
Console.WriteLine("${f1} ${f2} ${f3} ${g1} ${g2} ${g3} ${g4}")
Console.WriteLine("${h1} ${h1c} ${h2} ${h3} ${h4}")`, []string{fixture.AssemblyPath})
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            []string{
                "val:3 val:5 val:0 in:3",
                "val:3 val:5 val:0 ref:4",
                "val:4 val:5 out:99 in:4 in:4 out:77:77",
                "ctor-val:4 ctor-in:4 inst-val:4 inst-in:4 inst-val:4 inst-ref:6",
                "val:6 in:6 ref:16 s:val:16 s:in:16 s:val:16 s:ref:19",
                "long:19 long:5 in-long:19:1 in-long:19:1 ref-int:20:1"
            },
            result.Output.Trim().Split('\n').Select((l string) -> l.Trim()).ToArray()
        )
    }

    @Fact
    func ClrCallee_ValueStorageAtNullableRefParameter_IsGS0154() {
        using let fixture = CSharpFixture(`namespace Issue4422NullableRefFixture
{
    public static class Bumper
    {
        public static void Bump(ref int? x) { x = (x ?? 0) + 1; }
    }
}`)
        let result = EmittedOracle.Evaluate(`import Issue4422NullableRefFixture
var y int32 = 1
Bumper.Bump(&y)
var z int32? = 1
Bumper.Bump(&z)
Console.WriteLine(z)`, []string{fixture.AssemblyPath})
        let error = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0154", error.Id)
        Assert.Contains("'x'", error.Message, StringComparison.Ordinal)
    }

    @Fact
    func ClrCallee_ReferenceNullableStorage_StaysSilent() {
        // Reference nullability at an imported by-ref parameter is unchanged:
        // no GS0612, no error.
        let result = EmittedOracle.Evaluate(`
import System.Threading

var arr []?int32 = []int32{1}
Array.Resize(&arr, 3)
var o string? = nil
Interlocked.Exchange(&o, "a")
Interlocked.CompareExchange(&o, "b", "a")
var y int32 = 1
Interlocked.Increment(&y)
Console.WriteLine("${arr!!.Length} ${Volatile.Read(&o)} $y")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("3 b 2", result.Output.Trim())
    }

    @Theory
    @InlineData("var h int32 = 1\nConsole.Write(S.R(&h))", "x")
    @InlineData("var h int32 = 1\nConsole.Write(S.I(&h))", "x")
    @InlineData("var h int32 = 1\nConsole.Write(S.I(in h))", "x")
    @InlineData("var f () -> int32 = () -> 1\nConsole.Write(S.F(&f))", "f")
    @InlineData("var h Func[int32] = () -> 1\nConsole.Write(S.In(&h, 1))", "f")
    @InlineData("enum E { A = 1 }\nvar h int32 = 1\nConsole.Write(Holder[E](&h).Value)", "value")
    @InlineData(
        "import System.Collections.Generic\nclass A {}\nclass B {}\nvar bs = List[B]()\nConsole.Write(Holder[List[A]](&bs).Value.Count)",
        "value"
    )
    @InlineData("var x = (1, 2)\nConsole.Write(S.RT(&x))", "x")
    @InlineData("var a = [1, 1](int32, (int32, int32)){(1, (2, 3))}\nConsole.Write(S.RTGrid[int32](&a))", "x")
    func ClrCallee_DifferentStorageTypeAtByRefParameter_IsGS0154(body string, parameterName string) {
        using let fixture = CSharpFixture(`namespace Storage {
    public static class S {
        public static long R(ref long x) => x;
        public static long I(in long x) => x;
        public static long F(in System.Func<long> f) => f();
        public static string In(in System.Func<long> f, int x) => "F";
        public static string In(object o, long x) => "O";
        public static int RT(ref System.Tuple<int, int> x) => x.Item1;
        public static int RTGrid<T>(ref (T, System.Tuple<int, int>)[,] x) => x[0, 0].Item2.Item1;
    }
    public class Holder<T> {
        public T Value;
        public Holder(ref T value) { Value = value; }
    }
}`)
        let result = EmittedOracle.Evaluate("import System\nimport Storage\n" + body, []string{fixture.AssemblyPath})
        let error = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0154", error.Id)
        Assert.Contains("'" + parameterName + "'", error.Message, StringComparison.Ordinal)
    }

    @Fact
    func ClrGenericConstructor_WithSourceEnumByRefStorage_CompilesAndRuns() {
        using let fixture = CSharpFixture(`namespace Storage {
    public class B { }
    public static class S {
        public static int Read(ref int[] a) => a[0];
        public static T ReadG<T>(ref T[] a) => a[0];
        public static int RTPair(ref (System.Tuple<int, int>, int) x) => x.Item1.Item1 + x.Item2;
        public static int RT8(ref System.Tuple<int, int, int, int, int, int, int, System.Tuple<int>> x) => x.Rest.Item1;
        public static int RT9(ref System.Tuple<int, int, int, int, int, int, int, System.Tuple<int, int>> x) => x.Rest.Item2;
        public static T ReadExt<T>(this System.Collections.Generic.List<T> xs, ref T value) { value = xs[0]; return value; }
        public static string PickRefKind(in int x, int y) => "in:" + (x + y);
        public static string PickRefKind(ref int x, long y) => "ref:" + (x + y);
        public static string PickNil(int? x) => "val:" + (x.HasValue ? x.Value.ToString() : "null");
        public static string PickNil(in int? x) => "in:" + (x.HasValue ? x.Value.ToString() : "null");
        public static string MG<T>(ref T x) => "ref";
        public static string MG<T>(long x) => "long:" + x;
        public static int ExtGeneric<R, T>(this System.Collections.Generic.List<R> s, ref int delta, int tag = 0, T? value = default) => s.Count + delta + tag;
        public static void Bump<T>(this System.Collections.Generic.List<T> xs, ref T delta) { }
        public static void Copy<T>(this string s, ref T destination, ref T source) { destination = source; }
    }
    public class Holder<T> {
        public T Value;
        public Holder(ref T value) { Value = value; }
    }
}`)
        let result = EmittedOracle.Evaluate(`import System
import System.Collections.Generic
import Storage
enum E { A = 1, B = 2 }
class D : B {}
var e = E.B
let h = Holder[E](&e)
var a = [3]int32{7, 8, 9}
var xs = List[E]{E.B}
var next = E.A
var pairRt = (System.Tuple[int32, int32](1, 2), 3)
var rt8 = System.Tuple[int32, int32, int32, int32, int32, int32, int32, System.Tuple[int32]](1, 2, 3, 4, 5, 6, 7, System.Tuple[int32](8))
var rt9 = System.Tuple[int32, int32, int32, int32, int32, int32, int32, System.Tuple[int32, int32]](1, 2, 3, 4, 5, 6, 7, System.Tuple[int32, int32](8, 9))
var ds = List[D]{D()}
var d = D()
var rv = 10
Console.WriteLine("${int32(h.Value)} ${S.Read(&a)} ${S.ReadG[int32](&a)} ${int32(xs.ReadExt[E](&next))} ${S.RTPair(&pairRt)} ${S.RT8(&rt8)} ${S.RT9(&rt9)} ${ds.ReadExt(&d) == ds[0]} ${S.PickRefKind(ref rv, 1)} ${S.MG[int16](5)} ${S.PickNil(nil)}")`, []string{
                fixture.AssemblyPath
            })
        Assert.Empty(result.Diagnostics)
        Assert.Equal("2 7 7 2 4 8 9 True ref:11 long:5 val:null", result.Output.Trim())

        let outMismatch = EmittedOracle.Evaluate(`import Storage
var v = 1
let _ = Holder[int32](out v)`, []string{fixture.AssemblyPath})
        let outDiag = Assert.Single(outMismatch.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0235", outDiag.Id)
        Assert.Contains("parameter 'value'", outDiag.Message, StringComparison.Ordinal)

        let extNullable = EmittedOracle.Evaluate(`import System.Collections.Generic
import Storage
var list = List[string]()
var x int32? = 1
let _ = list.ExtGeneric(&x, value: 1)`, []string{fixture.AssemblyPath})
        let extDiag = Assert.Single(extNullable.Diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal("GS0154", extDiag.Id)
        Assert.Contains("Nullable", extDiag.Message, StringComparison.Ordinal)

        let extInferredNullable = EmittedOracle.Evaluate(`import System.Collections.Generic
import Storage
var list = List[int32]()
var x int32? = 1
list.Bump(&x)`, []string{fixture.AssemblyPath})
        let extInferredDiag = Assert.Single(
            extInferredNullable.Diagnostics,
            (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
        )
        Assert.Equal("GS0154", extInferredDiag.Id)
        Assert.Contains("Nullable", extInferredDiag.Message, StringComparison.Ordinal)

        let extInferredFromByRefArg = EmittedOracle.Evaluate(`import Storage
var x int32? = 1
var y = 2
"s".Copy(&x, &y)`, []string{fixture.AssemblyPath})
        let extFromByRefDiag = Assert.Single(
            extInferredFromByRefArg.Diagnostics,
            (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
        )
        Assert.Equal("GS0154", extFromByRefDiag.Id)
        Assert.Contains("Nullable", extFromByRefDiag.Message, StringComparison.Ordinal)

        let condInMismatch = EmittedOracle.Evaluate(`import System.Threading
var a = 1
var b = 2
var c = true
let _ = Interlocked.Increment(in (c ? a : b))`)
        let condDiag = Assert.Single(
            condInMismatch.Diagnostics,
            (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
        )
        Assert.Equal("GS0235", condDiag.Id)
        Assert.Contains("parameter 'location'", condDiag.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`func Clear(ref s string?) bool { s = nil; return true }
func Use(ok bool, ref s string) {}
var s string? = "x"
Use(Clear(&s), &s)`, "s")
    @InlineData(`var flag = true
var s string? = nil
if flag {
    OutS(&s)
} else {
    let _ = InS(&s)
}`, "s")
    @InlineData(`var flag = true
var s string? = nil
if flag {
    OutS(&s)
}
let _ = InS(&s)`, "s")
    @InlineData(`func Clear(ref s string?) bool { s = nil; return false }
var s string? = "x"
switch 0 {
    case _ when Clear(&s) {}
    default { let _ = InS(&s) }
}`, "s")
    @InlineData(`import System
var s string? = "x"
try {
    s = nil
    throw Exception()
} catch {
    let _ = InS(&s)
}`, "s")
    @InlineData(`func Reset() {}
var s string? = nil
{
    defer Reset()
    OutS(&s)
}
let _ = InS(&s)`, "s")
    func SubExpressionWriteAndConditionalOut_InvalidateOrIsolateNonNullByRefFact(body string, parameterName string) {
        let result = EmittedOracle.Evaluate(Callees + "\n" + body)
        let warning = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0612")
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity)
        Assert.Contains("'" + parameterName + "'", warning.Message, StringComparison.Ordinal)
    }

    @Fact
    func BothBranchesAssignNonNullOut_PreservesNonNullByRefFactAfterJoin() {
        let result = EmittedOracle.Evaluate(Callees + `
var flag = true
var s string? = nil
if flag {
    OutS(&s)
} else {
    OutS(&s)
}
let n = InS(&s)
Console.WriteLine(n)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", result.Output.Trim())
    }

    shared {
        private const Callees string = `
import System.Collections.Generic

func RefS(ref s string) { s = "r" }
func OutS(out s string) { s = "o" }
func InS(in s string) int32 -> s.Length
func RefNs(ref s string?) { s = "rn" }
func OutNs(out s string?) { s = "on" }
func InNs(in s string?) int32 -> s?.Length ?? -1
func RefList(ref l List[string]) { l.Add("x") }
func OutList(out l List[string]) { l = List[string]() }
func InList(in l List[string]) int32 -> l.Count
func RefInt(ref i int32) { i = 42 }
func RefInts(ref a []int32) { a[0] = 42 }
func RefIntList(ref l List[int32]) { l.Add(1) }
`
    }
}
