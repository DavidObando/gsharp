// <copyright file="Issue3989ErasedArgumentApplicabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3989: a same-compilation (or open) type argument erases to
/// <c>object</c> at applicability, so <c>List[Pair]</c> bound to a genuine
/// <c>List&lt;object&gt;</c> parameter and emitted IL ILVerify rejects.
/// </summary>
/// <remarks>
/// <para>Applicability ranks imported candidates on CLR shapes, and an element
/// declared in the current compilation has none:
/// <c>MemberLookup.TryProjectErasedClrType</c> presents <c>Pair</c> as
/// <c>System.Object</c>. That erasure is deliberate and is what lets
/// <c>[]Pair{…}.Count()</c> reach LINQ — but at the erased level an element
/// with no CLR identity is INDISTINGUISHABLE from a genuine <c>object</c>, so a
/// parameter that really is <c>List&lt;object&gt;</c> matched by identity. The
/// applicability probe then never got a second opinion:
/// <c>ConversionClassifier.BindClrParameterConversions</c> computes
/// <c>Conversion.Classify(List[Pair], List[object])</c>, which correctly says
/// there is no conversion — and every arm of that method ends in "leave the
/// argument alone" (the silence that makes G# lenient about a CLR parameter's
/// declared nullability), so the raw <c>List&lt;Pair&gt;</c> was pushed.</para>
/// <para>The reported case at least survives to print. The covariant sibling
/// does not: CLR variance does not apply to a value-type element, so a
/// <c>List[Pair]</c> or <c>[]Pair</c> reaching a genuine
/// <c>IEnumerable&lt;object&gt;</c> parameter throws
/// <c>EntryPointNotFoundException</c> from inside the callee. Both are
/// rejection rows.</para>
/// <para><b>The fix, and its relation to #3982.</b> #3995 asked exactly this
/// question for channels — could this slot's <c>object</c> have come from
/// erasure? — and answered it with <c>IsErasedGenericParameterSlot</c>. This
/// uses the SAME predicate with the opposite polarity: the channel gate ADDS
/// applicability where the answer is yes, and
/// <c>MakeErasedArgumentMismatchCheck</c> REMOVES it where the answer is no. It
/// sits BESIDE the channel gate rather than subsuming it — the two are
/// complementary halves of one question, and both are needed.</para>
/// <para>Two refinements the issue did not predict, both measured:</para>
/// <list type="number">
/// <item><c>IsErasedGenericParameterSlot</c> was slot-BLIND for a generic
/// CLASS, so a <c>SlotHolder[T]</c> declaring a genuine
/// <c>SlotHolder(List&lt;object&gt;)</c> beside <c>TakeOpen(List[T])</c> still
/// let a <c>List[Pair]</c> through. It is now slot-precise, locating the open
/// member by metadata token on the generic definition.</item>
/// <item>Only a NESTED <c>object</c> is suspect. A parameter with no
/// <c>object</c> inside a constructed generic was matched on the argument's own
/// CLR shape, which erasure did not invent — a <c>map[string, Pair]</c> really
/// is an <c>IDictionary</c> and a <c>[]Pair</c> really is a
/// <c>System.Array</c>. Those are green rows.</item>
/// </list>
/// <para>Every fixture member returns a TAGGED string naming which overload
/// ran, so the green rows assert the selection rather than merely proving that
/// something compiled and verified.</para>
/// </remarks>
public class Issue3989ErasedArgumentApplicabilityTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library every fixture case links against.</summary>
    private const string LibrarySource = """
        using System;
        using System.Collections;
        using System.Collections.Generic;

        namespace Interop;

        public static class Probes
        {
            public static string CountObjList(List<object> items) => "objlist:" + items.Count;

            public static string CountObjEnumerable(IEnumerable<object> items)
            {
                var n = 0;
                foreach (var _ in items)
                {
                    n++;
                }

                return "objseq:" + n;
            }

            public static string CountAny<T>(List<T> items) => "any:" + items.Count;

            public static string Describe(object value) => "obj:" + value.GetType().Name;

            // An `object` overload declared BESIDE a valid generic one: the
            // mirror of #3982's overload-set row.
            public static string Pick(List<object> items) => "pick-object:" + items.Count;

            public static string Pick<T>(List<T> items) => "pick-generic:" + items.Count;

            public static string TakeArray(Array a) => "array:" + a.Length;

            public static string TakeEnumerable(IEnumerable e)
            {
                var n = 0;
                foreach (var _ in e)
                {
                    n++;
                }

                return "enum:" + n;
            }

            public static string TakeCollection(ICollection c) => "coll:" + c.Count;

            public static string TakeList(IList l) => "ilist:" + l.Count;

            public static string TakeDictionary(IDictionary d) => "idict:" + d.Count;

            public static string FormatAll(string fmt, params object[] parts)
                => "fmt:" + string.Format(fmt, parts);
        }

        public class SlotHolder<T>
        {
            public SlotHolder(List<object> items)
            {
                this.Tag = "ctor-object:" + items.Count;
            }

            public SlotHolder(int capacity)
            {
                this.Tag = "ctor-int:" + capacity;
            }

            public string Tag { get; }

            public string TakeObjList(List<object> items) => "take-object:" + items.Count;

            public string TakeOpen(List<T> items) => "take-open:" + items.Count;

            // Review finding 2: an open position and a GENUINE nested one in
            // the same parameter. A parameter-wide exemption covered both.
            public string TakeMixed(Dictionary<T, List<object>> entries)
                => "take-mixed:" + entries.Count;

            // Every nested position open: must stay applicable.
            public string TakeAllOpen(Dictionary<T, List<T>> entries)
                => "take-allopen:" + entries.Count;
        }

        // Review finding 1: `object` is not the only erasure surrogate — a
        // same-compilation enum erases to `int`.
        public static class SurrogateProbes
        {
            public static string CountIntList(List<int> items) => "intlist:" + items.Count;

            public static string TakeInt(int n) => "int:" + n;
        }

        public static class ListExtensions
        {
            public static string CountObjListExt(this List<object> items)
                => "ext-object:" + items.Count;

            public static string CountAnyExt<T>(this List<T> items)
                => "ext-generic:" + items.Count;
        }
        """;

    /// <summary>The rejection cases: the unsound binds that used to compile.</summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The issue's own repro. Compiled on `main`, printed `1`, and ilverify
        // reported StackUnexpected [found List`1<Pair>] [expected List`1<object>].
        yield return new object[]
        {
            "the-reported-repro-is-rejected",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(Probes.CountObjList(items))
            """,
            "GS0159",
        };

        // The covariant sibling, and the stronger repro: CLR variance does not
        // reach a value-type element, so this one CRASHES rather than merely
        // failing to verify.
        yield return new object[]
        {
            "a-covariant-object-parameter-does-not-accept-a-value-type-element",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(Probes.CountObjEnumerable(items))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "a-slice-of-a-same-compilation-struct-does-not-reach-an-object-enumerable",
            """
            package P
            import System
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            Console.WriteLine(Probes.CountObjEnumerable([]Pair{Pair{a: 3, b: 4}}))
            """,
            "GS0159",
        };

        // The issue's own second shape: an open type parameter erases exactly
        // the same way.
        yield return new object[]
        {
            "an-open-type-parameter-erases-the-same-way",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            func countThem[T](items List[T]) string {
                return Probes.CountObjList(items)
            }

            Console.WriteLine(countThem[int32](List[int32]()))
            """,
            "GS0159",
        };

        // Invariance is not about value types: `List<Node>` is not
        // `List<object>` either, however reference-typed `Node` is.
        yield return new object[]
        {
            "an-invariant-object-parameter-refuses-a-reference-element-too",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Node {
                var name string
            }

            let items = List[Node]()
            items.Add(Node{name: "n"})
            Console.WriteLine(Probes.CountObjList(items))
            """,
            "GS0159",
        };

        // The extension path: slot 0 is the `this` receiver, and it goes
        // through the same check with the same offset every other argument does.
        yield return new object[]
        {
            "a-non-generic-extension-on-an-object-list-is-invisible",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(items.CountObjListExt())
            """,
            "GS0159",
        };

        // The slot-blind hole #3982 left open: every slot on a constructed
        // generic class answered "possibly erased", so a genuine
        // `List<object>` constructor accepted a `List[Pair]`.
        yield return new object[]
        {
            "a-genuine-object-slot-on-a-generic-class-constructor-is-refused",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(SlotHolder[Pair](items).Tag)
            """,
            "GS0267",
        };

        // Review finding 2: a GENUINE nested position (`List<object>`) sitting
        // beside an open one (`T`) in the same parameter. The parameter-wide
        // exemption this gate uses does cover the genuine position too, so the
        // gate declines — but the call is still refused, by
        // `BindClrParameterConversions` a few steps later, on `main` and here
        // alike. Measured both ways; no unverifiable IL is emitted either way,
        // which is why this row pins the diagnostic rather than claiming a fix.
        //
        // Moving the refusal up to applicability was attempted (a per-POSITION
        // test on the candidate's open declaration) and REVERTED: the open
        // parameter of `Task.ContinueWith[TResult](Func[Task, TResult])` has
        // the identical shape — one concrete nested position beside one open
        // one — so the position-aware test rejected every lambda passed to it.
        // See the `a-lambda-at-a-partly-concrete-generic-slot-still-binds` row
        // below, and Issue1512GenericClosureInferenceEmitTests.
        yield return new object[]
        {
            "a-genuine-nested-slot-beside-an-open-one-is-still-refused-by-conversion",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let inner = List[Pair]()
            inner.Add(Pair{a: 1, b: 2})
            let m = map[Pair, List[Pair]]{}
            m[Pair{a: 1, b: 2}] = inner
            let holder = SlotHolder[Pair](4)
            Console.WriteLine(holder.TakeMixed(m))
            """,
            "GS0155",
        };

        // Review finding 1: a same-compilation ENUM erases to `int`, not to
        // `object`. Measured refused on `main` too — the surrogate has no hole
        // here — so this row pins the behaviour rather than claiming a fix.
        yield return new object[]
        {
            "a-same-compilation-enum-element-does-not-reach-an-int-list",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            enum MyEnum {
                A,
                B
            }

            let enums = List[MyEnum]()
            enums.Add(MyEnum.B)
            Console.WriteLine(SurrogateProbes.CountIntList(enums))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "a-genuine-object-slot-on-a-generic-class-method-is-refused",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            let holder = SlotHolder[Pair](4)
            Console.WriteLine(holder.TakeObjList(items))
            """,
            "GS0159",
        };
    }

    /// <summary>The cases that must keep binding: each compiles, IL-verifies, runs, prints.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The case the erasure exists to serve: an INFERRED generic slot. This
        // is what the fix must not touch, and it is why the check is gated on
        // `IsErasedGenericParameterSlot` rather than applied everywhere.
        yield return new object[]
        {
            "the-inferred-generic-slot-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(Probes.CountAny(items))
            Console.WriteLine(Probes.CountAny[Pair](items))
            Console.WriteLine(items.CountAnyExt())
            """,
            new[] { "any:1", "any:1", "ext-generic:1" },
        };

        // The issue's own control, and #3982's: `[]Pair{…}.Count()` reaches
        // LINQ's `Count[TSource](IEnumerable[TSource])`.
        yield return new object[]
        {
            "control-the-linq-count-over-a-same-compilation-element",
            """
            package P
            import System
            import System.Linq

            struct Pair {
                var a int32
                var b int32
            }

            Console.WriteLine([]Pair{Pair{a: 1, b: 2}, Pair{a: 3, b: 4}}.Count().ToString())
            """,
            new[] { "2" },
        };

        // A parameter that genuinely IS `object` accepts the argument for real
        // — nothing about the erasure was involved in that match.
        yield return new object[]
        {
            "a-genuine-object-parameter-still-accepts-anything",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(Probes.Describe(items))
            Console.WriteLine(Probes.Describe(Pair{a: 5, b: 6}))
            """,
            new[] { "obj:List`1", "obj:Pair" },
        };

        // Where variance genuinely applies — a REFERENCE element — the
        // covariant parameter keeps binding, and the IL verifies.
        yield return new object[]
        {
            "a-reference-element-still-rides-covariance",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Node {
                var name string
            }

            let items = List[Node]()
            items.Add(Node{name: "n"})
            Console.WriteLine(Probes.CountObjEnumerable(items))
            """,
            new[] { "objseq:1" },
        };

        // The open slot on the very generic class whose `object` slot is now
        // refused: making the predicate slot-PRECISE has to keep this one.
        yield return new object[]
        {
            "the-open-slot-on-a-generic-class-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            let holder = SlotHolder[Pair](4)
            Console.WriteLine(holder.Tag)
            Console.WriteLine(holder.TakeOpen(items))
            """,
            new[] { "ctor-int:4", "take-open:1" },
        };

        // Review finding 2's counterexample, kept as a regression row. The open
        // parameter of `Task.ContinueWith[TResult](Func[Task, TResult])` holds
        // a CONCRETE nested position (`Task`) beside an open one (`TResult`) —
        // the same shape as `Dictionary[T, List[object]]`. Nothing structural
        // separates them, so a gate that treats "a concrete nested position" as
        // suspicion rejects this lambda too. Lifted from
        // Issue1512GenericClosureInferenceEmitTests, which is where the attempt
        // to make the #3989 gate position-aware was measured and abandoned.
        yield return new object[]
        {
            "a-lambda-at-a-partly-concrete-generic-slot-still-binds",
            """
            package P
            import System
            import System.Threading.Tasks

            class CwOp[T] {
                var cont Task[T]?
                init() { }
                func SetIt(readerTask Task, v T) Task[T] {
                    let r = readerTask.ContinueWith((t Task) -> v)
                    cont = r
                    return r
                }
            }

            let op = CwOp[int32]()
            let task = op.SetIt(Task.CompletedTask, 42)
            Console.WriteLine(task.Result)
            """,
            new[] { "42" },
        };

        // Review finding 2's control: when EVERY nested position of the open
        // parameter is generic, nothing is suspect and the call still binds.
        yield return new object[]
        {
            "a-parameter-whose-nested-positions-are-all-open-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let inner = List[Pair]()
            inner.Add(Pair{a: 1, b: 2})
            let m = map[Pair, List[Pair]]{}
            m[Pair{a: 1, b: 2}] = inner
            let holder = SlotHolder[Pair](4)
            Console.WriteLine(holder.TakeAllOpen(m))
            """,
            new[] { "take-allopen:1" },
        };

        // Only a NESTED `object` is suspect. A parameter with no `object`
        // inside a constructed generic was matched on the argument's real CLR
        // shape: a `[]Pair` IS a `System.Array`, an `ICollection`, an `IList`;
        // a `map[string, Pair]` IS an `IDictionary`.
        yield return new object[]
        {
            "non-generic-targets-are-untouched",
            """
            package P
            import System
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            func sliceOpen[T](items []T) string {
                return Probes.TakeArray(items)
            }

            func mapOpen[K, V](entries map[K, V]) string {
                return Probes.TakeDictionary(entries)
            }

            let arr = []Pair{Pair{a: 1, b: 2}}
            Console.WriteLine(Probes.TakeArray(arr))
            Console.WriteLine(Probes.TakeEnumerable(arr))
            Console.WriteLine(Probes.TakeCollection(arr))
            Console.WriteLine(Probes.TakeList(arr))
            Console.WriteLine(sliceOpen[Pair](arr))
            let m = map[string, Pair]{}
            m["p"] = Pair{a: 1, b: 2}
            Console.WriteLine(Probes.TakeDictionary(m))
            Console.WriteLine(mapOpen[string, Pair](m))
            """,
            new[] { "array:1", "enum:1", "coll:1", "ilist:1", "array:1", "idict:1", "idict:1" },
        };

        // A `params object[]` slot expands to an `object` ELEMENT, which is a
        // genuine `object` and not an erased one — the expanded-form loop takes
        // the same second opinion and must reach the same conclusion.
        yield return new object[]
        {
            "a-params-object-array-still-packs-an-erased-argument",
            """
            package P
            import System
            import Interop

            class Node {
                var name string
            }

            Console.WriteLine(Probes.FormatAll("{0}", Node{name: "n"}))
            """,
            new[] { "fmt:P.Node" },
        };

        // The mirror of #3982's overload-set row. With a genuine
        // `Pick(List[object])` declared BESIDE `Pick[T](List[T])`, betterness
        // used to prefer the concrete one — so the call bound to the overload
        // that cannot hold the argument. Removing the spurious candidate is
        // what lets the generic one win.
        yield return new object[]
        {
            "an-object-overload-beside-the-generic-one-does-not-steal-the-call",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            struct Pair {
                var a int32
                var b int32
            }

            let items = List[Pair]()
            items.Add(Pair{a: 1, b: 2})
            Console.WriteLine(Probes.Pick(items))
            """,
            new[] { "pick-generic:1" },
        };

        // A genuinely CLOSED `List[object]` argument still reaches every one of
        // the refused parameters: nothing was erased, so nothing is suspect.
        yield return new object[]
        {
            "control-a-real-object-list-still-reaches-every-object-parameter",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let items = List[object]()
            items.Add("a")
            Console.WriteLine(Probes.CountObjList(items))
            Console.WriteLine(Probes.CountObjEnumerable(items))
            Console.WriteLine(items.CountObjListExt())
            Console.WriteLine(SlotHolder[int32](items).Tag)
            """,
            new[] { "objlist:1", "objseq:1", "ext-object:1", "ctor-object:1" },
        };
    }

    /// <summary>
    /// An erased argument that reached a genuine <c>object</c> slot is now
    /// refused, rather than emitting IL that does not verify.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnErasedArgumentAtAGenuineObjectSlot_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3989_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every legitimate neighbour of the refused bind still compiles,
    /// IL-verifies, runs, and selects the member it always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void ALegitimateErasedBind_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3989_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
