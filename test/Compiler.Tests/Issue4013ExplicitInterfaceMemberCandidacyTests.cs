// <copyright file="Issue4013ExplicitInterfaceMemberCandidacyTests.cs" company="GSharp">
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
/// Issue #4013: an explicitly-implemented non-generic interface member was a
/// candidate for an ordinary member call on the implementing type, so
/// <c>List[int32]().Add("x")</c> compiled and threw at run time.
/// </summary>
/// <remarks>
/// <para><b>The hole.</b> <c>MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces</c>
/// finishes by walking the receiver's transitive interfaces, a step whose
/// stated purpose is to surface DEFAULT interface methods the concrete type
/// does not re-declare. It admitted every interface member, abstract ones
/// included. <c>List&lt;T&gt;</c> implements the non-generic
/// <c>System.Collections.IList</c>, whose <c>Add(object)</c> accepts anything,
/// so when the argument did not fit the generic <c>Add(T)</c> resolution fell
/// through to the interface member instead of reporting an error. The stack
/// trace named <c>List`1.System.Collections.IList.Add</c>, so the call really
/// did bind to the explicit implementation. This is the unsound direction: a
/// static type error became a run-time <c>ArgumentException</c>, and it
/// silently widened every such call site to <c>object</c>.</para>
/// <para><b>The rule, and why it is spelled <c>!IsAbstract</c>.</b> In C# an
/// explicitly-implemented interface member is not a member of the implementing
/// type's own surface; it is reachable only through an interface-typed
/// reference. A class MUST implement every abstract member of the interfaces it
/// declares, and how it did so decides the answer: implemented IMPLICITLY, the
/// class's own public method is already in the candidate set from the self/base
/// walk, so the interface's copy adds nothing; implemented EXPLICITLY, C# says
/// it is off the surface. Either way an ABSTRACT interface member has no
/// business being offered on a class receiver — which leaves exactly the
/// non-abstract ones, i.e. genuine DIMs, which is what the walk was for.
/// Reconstructing C#'s dotted <c>Namespace.IFace&lt;T&gt;.Method</c> metadata
/// names would be fragile, and <c>Type.GetInterfaceMap</c> throws under the
/// <c>MetadataLoadContext</c> reference assemblies are loaded in (it is used
/// nowhere in this repo for that reason), so neither is needed here.</para>
/// <para><b>An interface receiver keeps the full walk.</b> A base interface's
/// abstract members really are members of the derived interface, so the rule is
/// gated on the receiver not being an interface. That is the
/// <c>an-interface-receiver-still-reaches-its-base-interface-members</c> row.</para>
/// <para><b>Two exemptions the compiler still depends on, both measured, both
/// leaving the hole open where they apply.</b> The member stays offered in
/// exactly two situations.</para>
/// <list type="number">
/// <item><b>A synthesized collection-initializer <c>Add</c>.</b> ADR-0117
/// literals and the #3096 spread form synthesize an <c>Add</c> and bind it
/// through this same path. <c>Dictionary[K, V](){ ...pairs }</c> fills through
/// the explicitly-implemented <c>ICollection&lt;KeyValuePair&lt;K, V&gt;&gt;.Add</c>;
/// narrowing it reported <c>GS0369</c> ("no accessible 'Add' method or settable
/// indexer"). Restricting the exemption to GENERIC interfaces, which would have
/// closed the literal hole too, broke
/// <c>Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions_ArrayAndCollection_RunAndVerify</c>:
/// a <c>[]Celsius</c> spread into a <c>List[float64]</c> cannot match
/// <c>Add(double)</c> through its user-defined conversion, because a
/// same-compilation struct has no CLR type while binding, and
/// <c>IList.Add(object)</c> was what accepted it.</item>
/// <item><b>An argument carrying a SAME-COMPILATION type</b>, where
/// <c>IList.Add(object)</c> is an erasure escape hatch wherever two erasures of
/// one type disagree. <c>List[System.Action[Mode]].Add((item Mode) -> …)</c>
/// for a same-compilation enum <c>Mode</c>
/// (<c>Issue2918InlineLambdaErasedReceiverTests</c>) is that shape: the
/// receiver is built over the flat <c>System.Object</c> placeholder and
/// presents as <c>List&lt;Action&lt;object&gt;&gt;</c>, while the lambda erases
/// the enum to <c>int</c> and presents as <c>Action&lt;int&gt;</c>, so the
/// type's own <c>Add(Action&lt;object&gt;)</c> is inapplicable. That is #4016's
/// defect at the generic-CONSTRUCTION placeholder rather than at the
/// method-type-argument one.</item>
/// </list>
/// <para>Both exemptions turn on something the CALL SITE has, not on the
/// member: a synthesized node, or an argument with no CLR identity. The
/// reported hole is closed because its argument is a genuine <c>string</c> at a
/// genuine <c>int32</c> and so qualifies for neither. What remained open was
/// <c>List[int32]{"x"}</c> (the literal form, exemption 1) and an ordinary call
/// passing a same-compilation argument (exemption 2); both were filed as #4028
/// and are now closed there — not by narrowing this candidate-collection rule
/// further, but by asking at APPLICABILITY, where the receiver's and the
/// arguments' real types are in hand, whether a NON-GENERIC interface's
/// widening member has an erasure to repair at all. See
/// <c>Issue4028CollectionLiteralExplicitInterfaceTests</c>. The exemptions
/// themselves are unchanged, and so is every row here.</para>
/// <para><b>Blast radius, measured.</b> An instrumented compiler logged every
/// drop this rule makes while compiling the whole <c>samples/</c> +
/// <c>e2etests/</c> <c>.gs</c> corpus: 27 drops, all of
/// <c>IList.Add(object)</c>, <c>IDictionary.Add(object, object)</c>,
/// <c>ICollection&lt;KeyValuePair&lt;K, V&gt;&gt;.Add</c> and
/// <c>IFormattable.ToString(string, IFormatProvider)</c>, and EVERY one of them
/// had another candidate of the same name already on the type's own surface
/// (<c>onlyCandidate=False</c> on all 27). Nothing in the corpus depended on an
/// explicit member as its only candidate, and the corpus still compiles.</para>
/// <para><b>The adjacent question the issue does not settle.</b> A call with no
/// other candidate at all now has nothing to bind to. It used to reach the
/// explicit member; it now reports <c>GS0577</c>, which names the member, the
/// interface that declares it and the way to reach it, rather than the
/// <c>GS0159 Cannot find function Contains</c> a misspelling produces. That is
/// the <c>map-contains</c> row, and it is a BEHAVIOUR CHANGE: the call used to
/// compile.</para>
/// <para><b>GS0577 is chosen only when an excluded member is APPLICABLE.</b> A
/// name match alone would make the diagnostic lie: its advice — reach it
/// through an interface-typed receiver — is a dead end unless one of the
/// excluded members could really have taken the call. So the finder ranks them
/// against the bound arguments and keeps <c>GS0159</c> otherwise
/// (<c>map[string, int32]{}.Contains(1, 2)</c> and <c>Greeter{}.Secret(1)</c>
/// are those rows, from the review on PR #4031). Ranking also picks the RIGHT
/// interface to name: for <c>d.Contains("k")</c> it reports <c>IDictionary</c>,
/// whose <c>Contains(object)</c> accepts the string, rather than
/// <c>ICollection&lt;KeyValuePair&lt;K, V&gt;&gt;</c>, whose does not — so
/// <c>cast[IDictionary](d).Contains("k")</c> is advice that actually
/// works.</para>
/// <para><b>What the issue expected, and what the compiler actually does.</b>
/// The issue expects <c>ys.Add("x")</c> to report <c>GS0154</c> naming
/// <c>int32</c> and <c>string</c>. It reports <c>GS0159</c> — and so does the
/// control <c>Stack[int32]().Push("x")</c>, whose <c>Push(T)</c> has no
/// non-generic sibling and never had this hole. GS0159 is simply what an
/// inapplicable imported overload reports, before and after this change; the
/// fix makes <c>List.Add</c> behave EXACTLY like that control, which is the
/// point. The control is pinned as the
/// <c>a-member-with-no-interface-sibling-reports-the-same-thing</c> row so the
/// equivalence stays measured.</para>
/// </remarks>
public class Issue4013ExplicitInterfaceMemberCandidacyTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library the DIM and explicit-implementation rows link against.</summary>
    private const string LibrarySource = """
        namespace Interop;

        public interface IGreeter
        {
            // A genuine DEFAULT interface method: the implementing class need
            // not declare it at all, so it stays a candidate on a class
            // receiver. This is what the interface walk exists for.
            string Greet() => "dim:" + this.Name;

            string Name { get; }
        }

        public interface IHidden
        {
            // Abstract, and implemented EXPLICITLY below: off the class surface.
            string Secret();
        }

        public interface IBase
        {
            string FromBase();
        }

        public interface IDerivedIface : IBase
        {
            string FromDerived();
        }

        public sealed class Greeter : IGreeter, IHidden, IDerivedIface
        {
            public string Name => "g";

            public string FromBase() => "frombase";

            public string FromDerived() => "fromderived";

            // Explicit: `new Greeter().Secret()` is CS1061 in C# too.
            string IHidden.Secret() => "secret";
        }
        """;

    /// <summary>
    /// Calls that must no longer bind to an explicitly-implemented interface
    /// member.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The reported repro. `IList.Add(object)` accepted the string, and the
        // program threw `ArgumentException` at run time.
        yield return new object[]
        {
            "the-reported-repro-a-string-does-not-reach-ilist-add-object",
            """
            package P
            import System.Collections.Generic

            func main2() {
                var ys = List[int32]()
                ys.Add("x")
            }

            main2()
            """,
            "GS0159",
        };

        // Not specific to `List`: `Dictionary<K, V>` implements
        // `IDictionary.Add(object, object)` explicitly and had the same hole.
        yield return new object[]
        {
            "a-dictionary-does-not-reach-idictionary-add-object-object",
            """
            package P
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d.Add(1, "x")
            """,
            "GS0159",
        };

        // The same hole in a user-written imported type, with an explicit
        // implementation that has NO same-named sibling on the class surface.
        // Before #4013 this bound and printed `secret`; now the type has no
        // member of that name at all, so the new GS0577 explains why.
        yield return new object[]
        {
            "an-explicit-implementation-with-no-sibling-reports-gs0577",
            """
            package P
            import System
            import Interop

            let g = Greeter{}
            Console.WriteLine(g.Secret())
            """,
            "GS0577",
        };

        // The no-other-candidate case on a BCL type, and the behaviour change
        // this PR is explicit about: `Dictionary<K, V>` has no public
        // `Contains`, so the call used to bind `IDictionary.Contains(object)`
        // and compile. It now names the interface instead of reading like a
        // misspelling.
        yield return new object[]
        {
            "map-contains-had-no-other-candidate-and-now-reports-gs0577",
            """
            package P
            import System
            import System.Collections.Generic

            let d = map[string, int32]{}
            Console.WriteLine(d.Contains("k"))
            """,
            "GS0577",
        };

        // Review finding on PR #4031: GS0577 must not fire when NO excluded
        // interface member could have taken the call. `Contains` matches by
        // name, but every `Contains` on `Dictionary<K, V>` is unary, so
        // "reach it through an interface-typed receiver" would be a dead end.
        // The ordinary GS0159 is the honest answer here.
        yield return new object[]
        {
            "an-inapplicable-arity-keeps-gs0159-rather-than-gs0577",
            """
            package P
            import System
            import System.Collections.Generic

            let d = map[string, int32]{}
            Console.WriteLine(d.Contains(1, 2))
            """,
            "GS0159",
        };

        // The same rule on a user-written type: `IHidden.Secret()` is
        // parameterless, so a one-argument call cannot reach it either.
        yield return new object[]
        {
            "an-inapplicable-explicit-member-keeps-gs0159-rather-than-gs0577",
            """
            package P
            import System
            import Interop

            let g = Greeter{}
            Console.WriteLine(g.Secret(1))
            """,
            "GS0159",
        };
    }

    /// <summary>Every legitimate neighbour that must keep binding.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> LegitimateCases()
    {
        // The type's own public members are untouched — this is the overload
        // that was always meant to win, and the surrounding collection surface
        // still works.
        yield return new object[]
        {
            "the-types-own-public-members-still-bind",
            """
            package P
            import System
            import System.Collections.Generic

            let ys = List[int32]()
            ys.Add(3)
            ys.Add(4)
            Console.WriteLine(ys.Count)
            Console.WriteLine(ys.Contains(4))
            Console.WriteLine(ys.IndexOf(4))

            let d = Dictionary[string, int32]()
            d.Add("k", 1)
            Console.WriteLine(d.Count)
            Console.WriteLine(d.ContainsKey("k"))
            """,
            new[] { "2", "True", "1", "1", "True" },
        };

        // The issue's own "Expected" section: the explicit member is still
        // reachable, through an interface-typed receiver. `IList.Add` returns
        // the new index, and the value really does land in the list.
        yield return new object[]
        {
            "an-interface-typed-receiver-still-reaches-the-explicit-member",
            """
            package P
            import System
            import System.Collections
            import System.Collections.Generic

            let ys = List[int32]()
            let il = cast[IList](ys)
            Console.WriteLine(il.Add(7))
            Console.WriteLine(ys.Count)
            Console.WriteLine(ys[0])
            """,
            new[] { "0", "1", "7" },
        };

        // A genuine DEFAULT interface method is exactly what the interface walk
        // exists to surface, and it is NOT abstract, so it survives the rule.
        // Without this row the change would only have been shown to say no.
        yield return new object[]
        {
            "a-default-interface-method-is-still-a-candidate-on-a-class-receiver",
            """
            package P
            import System
            import Interop

            let g = Greeter{}
            Console.WriteLine(g.Greet())
            """,
            new[] { "dim:g" },
        };

        // An interface receiver keeps the full walk: a base interface's
        // abstract members are members of the derived interface.
        yield return new object[]
        {
            "an-interface-receiver-still-reaches-its-base-interface-members",
            """
            package P
            import System
            import Interop

            let g = Greeter{}
            let i = cast[IDerivedIface](g)
            Console.WriteLine(i.FromBase())
            Console.WriteLine(i.FromDerived())
            """,
            new[] { "frombase", "fromderived" },
        };

        // An IMPLICIT implementation is on the class surface and must still
        // bind from a class-typed receiver — the case the rule must not catch.
        yield return new object[]
        {
            "an-implicitly-implemented-interface-member-still-binds-on-the-class",
            """
            package P
            import System
            import Interop

            let g = Greeter{}
            Console.WriteLine(g.FromBase())
            Console.WriteLine(g.FromDerived())
            """,
            new[] { "frombase", "fromderived" },
        };

        // `for … in` over a `List[T]` goes through the enumerator, whose
        // `GetEnumerator` on `List<T>` has both a public struct-returning
        // overload and explicit `IEnumerable`/`IEnumerable<T>` ones. The public
        // one must keep winning.
        yield return new object[]
        {
            "iteration-and-collection-literals-still-work",
            """
            package P
            import System
            import System.Collections.Generic

            let ys = List[int32]{1, 2, 3}
            var total = 0
            for v in ys {
                total = total + v
            }

            Console.WriteLine(total)

            let m = map[string, int32]{"a": 1, "b": 2}
            Console.WriteLine(m.Count)
            Console.WriteLine(m["b"])
            """,
            new[] { "6", "2", "2" },
        };
    }

    /// <summary>
    /// The control: an imported member with NO non-generic interface sibling
    /// reported <c>GS0159</c> for an inapplicable argument before this change
    /// and still does. This is what pins the claim that the fix makes
    /// <c>List.Add</c> behave like every other imported overload, rather than
    /// inventing a new failure mode for it.
    /// </summary>
    [Fact]
    public void AMemberWithNoInterfaceSibling_ReportsTheSameThing()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4013_ctl_").FullName;
        try
        {
            const string Source = """
                package P
                import System.Collections.Generic

                let s = Stack[int32]()
                s.Push("x")
                """;

            var appPath = Path.Combine(tempDir, "control.dll");
            var log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"the control must not compile. Log:\n{log}");
            Assert.Contains("GS0159", log, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// An explicitly-implemented interface member is no longer a candidate for
    /// an ordinary call on the implementing type.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnExplicitInterfaceMember_IsNotACandidateForAnOrdinaryCall(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4013_neg_").FullName;
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
    /// IL-verifies, runs, and prints what it always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(LegitimateCases))]
    public void ALegitimateNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4013_").FullName;
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
