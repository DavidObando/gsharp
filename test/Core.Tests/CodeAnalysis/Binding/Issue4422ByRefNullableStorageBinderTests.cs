// <copyright file="Issue4422ByRefNullableStorageBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4422: the storage behind a by-reference argument (<c>&amp;x</c> at a
/// <c>ref</c>, <c>out</c> or <c>in</c> parameter of a G# callee) must have the
/// parameter's type, except that it may differ in reference nullability, as
/// in C#. Such an argument is accepted with a GS0612 warning in the direction
/// a nil can flow through the shared storage, and never with one for a
/// platform (<c>T!</c>) position. A value-type <c>int32?</c> is
/// <c>Nullable&lt;int32&gt;</c>, a different runtime type, and stays GS0154.
/// <para>
/// Before the fix the gate compared CLR types when exactly one side was a
/// nullable wrapper, and a nullable wrapper relays its underlying CLR type.
/// So same-compilation <c>T?</c> storage was accepted with no diagnostic at
/// all, <c>int32?</c> storage at <c>ref int32</c> compiled and wrote an
/// <c>int32</c> over the <c>Nullable&lt;int32&gt;</c>, and an imported
/// <c>int[]?</c> field was rejected with GS0154.
/// </para>
/// </summary>
public class Issue4422ByRefNullableStorageBinderTests
{
    private const string Callees = @"
import System.Collections.Generic

func RefS(ref s string) { s = ""r"" }
func OutS(out s string) { s = ""o"" }
func InS(in s string) int32 -> s.Length
func RefNs(ref s string?) { s = ""rn"" }
func OutNs(out s string?) { s = ""on"" }
func InNs(in s string?) int32 -> s?.Length ?? -1
func RefList(ref l List[string]) { l.Add(""x"") }
func OutList(out l List[string]) { l = List[string]() }
func InList(in l List[string]) int32 -> l.Count
func RefInt(ref i int32) { i = 42 }
func RefInts(ref a []int32) { a[0] = 42 }
func RefIntList(ref l List[int32]) { l.Add(1) }
";

    [Theory]
    [InlineData("var v string? = \"a\"\nRefS(&v)", "ref")]
    [InlineData("var v string? = \"a\"\nInS(&v)", "in")]
    [InlineData("var v string = \"a\"\nRefNs(&v)", "ref")]
    [InlineData("var v string = \"a\"\nOutNs(&v)", "out")]
    [InlineData("var v List[string?] = List[string?]()\nRefList(&v)", "ref")]
    [InlineData("var v List[string?] = List[string?]()\nOutList(&v)", "out")]
    [InlineData("var v List[string?] = List[string?]()\nInList(&v)", "in")]
    [InlineData("var v []string? = []string?{\"a\"}\nRefS(&v[0])", "ref")]
    public void NullabilityOnlyDifference_IsAcceptedWithGS0612(string body, string refKind)
    {
        var result = EmittedOracle.Evaluate(Callees + body);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        var warning = Assert.Single(result.Diagnostics, d => d.Id == "GS0612");
        Assert.Equal(DiagnosticSeverity.Warning, warning.Severity);
        Assert.Contains(refKind + " parameter", warning.Message, System.StringComparison.Ordinal);
    }

    [Theory]
    // `out` into nullable storage: the callee only writes a non-null value.
    [InlineData("var v string? = nil\nOutS(&v)\nConsole.WriteLine(v)", "o")]
    // `in` from non-null storage to a nullable parameter: the callee only reads.
    [InlineData("var v string = \"abc\"\nConsole.WriteLine(InNs(&v))", "3")]
    // Exact types never warn.
    [InlineData("var v string = \"a\"\nRefS(&v)\nConsole.WriteLine(v)", "r")]
    [InlineData("var v string? = nil\nRefNs(&v)\nConsole.WriteLine(v)", "rn")]
    public void SafeDirection_IsAcceptedWithoutWarning(string body, string expected)
    {
        var result = EmittedOracle.Evaluate(Callees + body);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Output.Trim());
    }

    [Fact]
    public void NullableStorage_ReachesTheCalleeAndRuns()
    {
        var result = EmittedOracle.Evaluate(Callees + @"
var s string? = ""abc""
RefS(&s)
var l List[string?] = List[string?]()
RefList(&l)
var n []string? = []string?{nil, ""z""}
RefS(&n[0])
Console.WriteLine(""${s!!} ${l.Count} ${n[0]!!}"")
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(3, result.Diagnostics.Count(d => d.Id == "GS0612"));
        Assert.Equal("r 1 r", result.Output.Trim());
    }

    [Theory]
    [InlineData("var v int32? = 1\nRefInt(&v)")]
    [InlineData("var v []int32? = []int32?{1}\nRefInts(&v)")]
    [InlineData("var v List[int32?] = List[int32?]()\nRefIntList(&v)")]
    public void ValueTypeNullableStorage_IsStillGS0154(string body)
    {
        var result = EmittedOracle.Evaluate(Callees + body);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0154");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0612");
    }

    [Fact]
    public void Overloads_WarnOnceForTheSelectedCandidate()
    {
        // Both candidates take the same `ref string`, so the gate would fire
        // twice if it ran per candidate rather than on the selected one.
        // (Overloads that differ only in a by-ref pointee type are GS0266 on
        // main for exact types too, so they are not the shape tested here.)
        var result = EmittedOracle.Evaluate(@"
func Pick(ref s string, n int32) { s = ""int"" }
func Pick(ref s string, t string) { s = ""string"" }

class Box {
    func Pick(ref s string, n int32) { s = ""method-int"" }
    func Pick(ref s string, t string) { s = ""method-string"" }
}

var s string? = nil
Pick(&s, ""x"")
Console.WriteLine(s)
Box().Pick(&s, 1)
Console.WriteLine(s)
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0612"));
        Assert.Equal(new[] { "string", "method-int" }, result.Output.Trim().Split('\n').Select(l => l.Trim()).ToArray());
    }

    [Fact]
    public void MethodAndConstructorCallees_UseTheSameGate()
    {
        var result = EmittedOracle.Evaluate(@"
class Sink {
    var seen string = """"
    init(ref s string) { s = ""ctor"" }
    func Put(ref s string) { s = ""method"" }
}

var a string? = nil
let sink = Sink(&a)
Console.WriteLine(a)
sink.Put(&a)
Console.WriteLine(a)
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0612"));
        Assert.Equal(new[] { "ctor", "method" }, result.Output.Trim().Split('\n').Select(l => l.Trim()).ToArray());
    }

    [Fact]
    public void ImportedAnnotatedField_IsAcceptedWithGS0612()
    {
        using var fixture = new CSharpFixture("""
            #nullable enable
            namespace Issue4422Fixture
            {
                public class AnnotatedBase
                {
                    protected internal int[]? stack = new int[] { 1, 2 };
                    protected string? name = "n";
                }
            }
            """);
        var result = EmittedOracle.Evaluate(
            @"
import Issue4422Fixture

func Push(ref stack []int32, v int32) { stack[0] = v }
func Name(ref s string) { s = s + ""!"" }

class Runner : AnnotatedBase {
    func Go() string {
        Push(&base.stack, 9)
        Name(&base.name)
        return ""${base.stack!![0]} ${base.name!!}""
    }
}

Console.WriteLine(Runner().Go())
",
            new[] { fixture.AssemblyPath });

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal(2, result.Diagnostics.Count(d => d.Id == "GS0612"));
        Assert.Equal("9 n!", result.Output.Trim());
    }

    [Fact]
    public void ImportedObliviousField_IsAcceptedWithoutWarning()
    {
        // ADR-0186: an oblivious field is a platform (`T!`) position, which
        // states nothing and so differs from neither `T` nor `T?`.
        using var fixture = new CSharpFixture("""
            #nullable disable
            namespace Issue4422ObliviousFixture
            {
                public class ObliviousBase
                {
                    protected internal int[] stack = new int[] { 1, 2 };
                }
            }
            """);
        var result = EmittedOracle.Evaluate(
            @"
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
",
            new[] { fixture.AssemblyPath });

        Assert.Empty(result.Diagnostics);
        Assert.Equal("8", result.Output.Trim());
    }

    [Fact]
    public void OverloadResolution_PrefersTheExactStorageType()
    {
        // Review finding: selection ignored the by-ref storage rule, so
        // `int32?` storage picked `ref int32` and then failed with GS0154
        // (on main it compiled to unverifiable IL), and `string?` storage
        // picked `ref string` with a GS0612 where C# picks the exact match.
        // Each declaration order is covered, for every call shape.
        var result = EmittedOracle.Evaluate(@"
func P(ref x int32) { Console.WriteLine(""p int32"") }
func P(ref x int32?) { Console.WriteLine(""p int32?"") }
func R(ref x int32?) { Console.WriteLine(""r int32?"") }
func R(ref x int32) { Console.WriteLine(""r int32"") }
func Q(ref s string) { Console.WriteLine(""q string"") }
func Q(ref s string?) { Console.WriteLine(""q string?"") }

class K {
    init() {}
    init(ref x int32) { Console.WriteLine(""ctor int32"") }
    init(ref x int32?) { Console.WriteLine(""ctor int32?"") }
    func M(ref x int32?) { Console.WriteLine(""m int32?"") }
    func M(ref x int32) { Console.WriteLine(""m int32"") }
    func N(ref s string) { Console.WriteLine(""n string"") }
    func N(ref s string?) { Console.WriteLine(""n string?"") }
}

var a int32? = 1
var b int32 = 1
var s string? = nil
var t string = """"
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
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            new[]
            {
                "p int32?", "p int32", "r int32?", "r int32", "q string?", "q string",
                "m int32?", "m int32", "n string?", "n string", "ctor int32?", "ctor int32",
            },
            result.Output.Trim().Split('\n').Select(l => l.Trim()).ToArray());
    }

    [Theory]
    [InlineData("var a int32? = 1\nP(&a)", "func P(ref x int32) {}")]
    [InlineData("var a int32 = 1\nP(&a)", "func P(ref x int32?) {}")]
    [InlineData("var a int32? = 1\nK().M(&a)", "class K {\n init() {}\n func M(ref x int32) {}\n}")]
    [InlineData("var a int32? = 1\nlet k = K(&a)", "class K {\n init(ref x int32) {}\n}")]
    public void ValueTypeNullableMismatch_ExplainsTheRuntimeType(string body, string declarations)
    {
        var result = EmittedOracle.Evaluate(declarations + "\n" + body);

        var error = Assert.Single(result.Diagnostics, d => d.Id == "GS0154");
        Assert.Contains("'int32?' is a Nullable<int32>, a different runtime type", error.Message, System.StringComparison.Ordinal);
        Assert.DoesNotContain("*int32", error.Message, System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("var x int32? = 41\nInterlocked.Increment(&x)", "location")]
    [InlineData("var x int32? = 41\nInt32.TryParse(\"5\", &x)", "result")]
    public void ClrCallee_ValueTypeNullableStorage_IsGS0154(string body, string parameterName)
    {
        // Review finding: an imported `ref int` accepted `&int32?` storage (the
        // address's CLR type was built from the relayed `int32`) and emitted
        // IL that ILVerify rejects; the program printed 41 twice.
        var result = EmittedOracle.Evaluate("import System.Threading\n" + body);

        var error = Assert.Single(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal("GS0154", error.Id);
        Assert.Contains("'" + parameterName + "'", error.Message, System.StringComparison.Ordinal);
        Assert.Contains("Nullable<int32>", error.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ClrCallee_ValueStorageAtNullableRefParameter_IsGS0154()
    {
        using var fixture = new CSharpFixture("""
            namespace Issue4422NullableRefFixture
            {
                public static class Bumper
                {
                    public static void Bump(ref int? x) { x = (x ?? 0) + 1; }
                }
            }
            """);
        var result = EmittedOracle.Evaluate(
            "import Issue4422NullableRefFixture\nvar y int32 = 1\nBumper.Bump(&y)\nvar z int32? = 1\nBumper.Bump(&z)\nConsole.WriteLine(z)",
            new[] { fixture.AssemblyPath });

        var error = Assert.Single(result.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.Equal("GS0154", error.Id);
        Assert.Contains("'x'", error.Message, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ClrCallee_ReferenceNullableStorage_StaysSilent()
    {
        // Reference nullability at an imported by-ref parameter is unchanged:
        // no GS0612, no error.
        var result = EmittedOracle.Evaluate(@"
import System.Threading

var arr []?int32 = []int32{1}
Array.Resize(&arr, 3)
var o string? = nil
Interlocked.Exchange(&o, ""a"")
Interlocked.CompareExchange(&o, ""b"", ""a"")
var y int32 = 1
Interlocked.Increment(&y)
Console.WriteLine(""${arr!!.Length} ${Volatile.Read(&o)} $y"")
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("3 b 2", result.Output.Trim());
    }
}
