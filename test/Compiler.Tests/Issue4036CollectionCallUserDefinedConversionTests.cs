// <copyright file="Issue4036CollectionCallUserDefinedConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4036: a user-defined implicit conversion was not APPLIED at an
/// author-written call on a generic collection, so
/// <c>List[float64]().Add(someCelsius)</c> compiled to verifiable IL and threw
/// <c>ArgumentException</c> from inside the BCL.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> A same-compilation struct has no CLR type while
/// binding, so <c>Celsius</c> presents to overload resolution as
/// <c>object</c>. Against a <c>List&lt;double&gt;</c> receiver that is an
/// IDENTITY match for <c>System.Collections.IList.Add(object)</c> and no match
/// at all for <c>Add(double)</c>, so the widening member won every betterness
/// ranking and the <c>Celsius</c> was boxed and handed to the BCL as-is. #4028
/// KEEPS that widening member here on purpose — the user-defined conversion
/// <c>Celsius -&gt; float64</c> genuinely exists, so this is an erasure to
/// repair rather than the widening hole #4028 closes — but nothing ever
/// performed the repair.</para>
/// <para><b>The call-vs-spread asymmetry, measured.</b> The issue's own table
/// says the spread form binds <c>IList.Add(object)</c> too and merely applies
/// the conversion first. Dumping the emitted IL says otherwise, and the
/// difference matters: the spread form calls
/// <c>Celsius::op_Implicit</c> and then
/// <c>List`1&lt;Double&gt;::Add</c>. It reaches that binding because
/// <c>ExpressionBinder.BindConvertedCollectionAddCall</c> types its item
/// placeholder as the collection's ELEMENT type and converts the item to it
/// BEFORE binding <c>Add</c> — overload resolution never sees the erased
/// argument. The ordinary call path binds its argument with no target type at
/// all, so the erased <c>object</c> is what reaches applicability.</para>
/// <para><b>What the fix does about that.</b> It makes the two forms AGREE,
/// not share a path. Sharing would mean routing every call through the
/// collection-shaped lowering, which needs an element type an ordinary call
/// does not have. Instead
/// <c>MemberLookup.FindUserDefinedConversionRepairTargets</c> asks the same
/// question <c>ExcludeUnreachableNonGenericInterfaceCandidates</c> already asks
/// — would the receiver's own non-widening surface have taken this call, and
/// does any position need a user-defined implicit conversion to do so — and
/// names the target type per position. The call site converts, then binds. Both
/// forms now emit <c>op_Implicit</c> followed by
/// <c>List`1&lt;Double&gt;::Add</c>.</para>
/// <para><b>#4028's release note stays literally true.</b> The widening member
/// is still collected and still applicable; nothing removes it. It simply stops
/// WINNING, because a real <c>double</c> beats a boxed one at betterness.</para>
/// <para><b>Six more broken forms the issue did not list</b>, found by
/// sweeping the neighbours rather than by reading the report. The collection
/// LITERAL <c>List[float64]{ celsius }</c> and the two-argument
/// <c>Dictionary[string, float64]().Add("a", celsius)</c> threw the same way;
/// <c>Insert</c> threw; and worse than any throw, <c>Contains</c> answered
/// <c>False</c> and <c>IndexOf</c> answered <c>-1</c> silently, because
/// <c>IList.Contains(object)</c> is perfectly happy to say no. <c>Remove</c>
/// reported <c>GS0124 Expression must have a value</c>, because
/// <c>IList.Remove</c> is <c>void</c> while <c>ICollection&lt;T&gt;.Remove</c>
/// returns <c>bool</c>. The repair keys on the presence of a widening
/// candidate, not on the name <c>Add</c>, so all of them close together.</para>
/// <para><b>Named arguments, added in review of PR #4060.</b> Both this repair
/// and #4028's candidacy filter compared SOURCE-order arguments against
/// DECLARATION-order parameters, so a call that named its arguments out of
/// order asked the wrong question of the wrong slot:
/// <c>Add(value: someCelsius, key: "a")</c> asked whether a <c>Celsius</c> fits
/// <c>key: string</c>, concluded the receiver's own <c>Add</c> could not take
/// the call, removed the widening member and reported <c>GS0159</c>. Measured
/// on the parent as well as here, so the candidacy half is #4028's and
/// PRE-EXISTING; the repair half would have inherited it. Both now reorder
/// through <c>ClrOverloadResolution.TryBuildNamedArgumentReordering</c> — the
/// resolver's own mapping, which is what #4026 reached for when
/// <c>BuildSymbolicMethodTypeArgs</c> hit this same hazard — so no second
/// implementation of named-argument binding can drift from it. Only the two
/// MULTI-argument forms were affected: with a single argument any mapping is
/// the identity, which is why <c>Add</c>, <c>Contains</c>, <c>IndexOf</c> and
/// <c>Remove</c> were already correct in their named spellings. The rows below
/// pin all of them, plus the negative control that reordering must not smuggle
/// a conversion that does not exist.</para>
/// <para><b>Issue #4054 follow-up.</b> The formerly pinned
/// <c>Math.Abs(someCelsius)</c> failure is now a positive row below. Ordinary
/// imported calls preserve the symbolic argument just long enough for CLR
/// overload resolution to classify the same user-defined conversion.</para>
/// </remarks>
public class Issue4036CollectionCallUserDefinedConversionTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The G# preamble every row shares: a same-compilation struct with a
    /// user-defined implicit conversion to <c>float64</c>. Its CLR type does
    /// not exist while binding, which is the whole premise.
    /// </summary>
    private const string Preamble = """
        package P
        import System
        import System.Collections.Generic
        import HelperLib4036

        struct Celsius {
            var Degrees float64
        }

        func operator implicit(value Celsius) float64 {
            return value.Degrees
        }

        """;

    /// <summary>
    /// A referenced C# library whose <c>Fahrenheit</c> carries the same
    /// conversion but DOES have a CLR type. It is the control that separates
    /// "user-defined conversions at a CLR parameter" (which already worked)
    /// from "a same-compilation argument erased to <c>object</c>" (which is the
    /// defect).
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib4036;

        public readonly struct Fahrenheit
        {
            public Fahrenheit(double degrees) => Degrees = degrees;

            public double Degrees { get; }

            public static implicit operator double(Fahrenheit value) => value.Degrees;
        }
        """;

    /// <summary>
    /// Every form that must now apply the conversion, run, and print. All of
    /// them except the spread row compiled before the fix and then either threw
    /// at run time or answered the wrong value in silence. The spread row is
    /// the CONTROL: it always worked, and it pins the behaviour the others now
    /// match.
    /// </summary>
    /// <returns>Case name, the G# body appended to the preamble, expected stdout lines.</returns>
    public static IEnumerable<object[]> ConversionIsApplied()
    {
        // THE ISSUE'S OWN REPRO. Threw ArgumentException from
        // List`1.System.Collections.IList.Add.
        yield return new object[]
        {
            "the-issues-author-written-add",
            """
            let list = List[float64]()
            list.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };

        // THE SPREAD FORM the issue contrasts it with. Green before and after.
        yield return new object[]
        {
            "the-spread-form-that-always-worked",
            """
            let source = []Celsius{ Celsius{ Degrees: 2.5 } }
            let list = List[float64](){ ...source }
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };

        // ISSUE #4054: the pinned ordinary-CLR-call failure. There is no
        // widening interface member beside Math.Abs(double); symbolic
        // conversion classification now makes the overload applicable.
        yield return new object[]
        {
            "an-ordinary-static-clr-parameter",
            """
            Console.WriteLine(Math.Abs(Celsius{ Degrees: 0.0 - 2.5 }))
            """,
            new[] { "2.5" },
        };

        // NOT IN THE ISSUE: the collection LITERAL threw the same way.
        yield return new object[]
        {
            "the-collection-literal-form",
            """
            let list = List[float64]{ Celsius{ Degrees: 2.5 } }
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };

        // NOT IN THE ISSUE: a two-argument widening member, where only the
        // SECOND position needs repairing.
        yield return new object[]
        {
            "a-two-argument-add-where-only-the-value-converts",
            """
            let lookup = Dictionary[string, float64]()
            lookup.Add("a", Celsius{ Degrees: 2.5 })
            Console.WriteLine(lookup["a"])
            """,
            new[] { "2.5" },
        };

        // NOT IN THE ISSUE, and worse than a throw: `IList.Contains(object)`
        // answered False and `IList.IndexOf(object)` answered -1, silently.
        yield return new object[]
        {
            "contains-answered-false-in-silence",
            """
            let list = List[float64]()
            list.Add(2.5)
            Console.WriteLine(list.Contains(Celsius{ Degrees: 2.5 }))
            Console.WriteLine(list.IndexOf(Celsius{ Degrees: 2.5 }))
            """,
            new[] { "True", "0" },
        };

        // NOT IN THE ISSUE: Insert threw; Remove reported GS0124 because
        // `IList.Remove` is void while `ICollection<T>.Remove` returns bool.
        yield return new object[]
        {
            "insert-and-remove",
            """
            let list = List[float64]()
            list.Insert(0, Celsius{ Degrees: 2.5 })
            Console.WriteLine(list[0])
            Console.WriteLine(list.Remove(Celsius{ Degrees: 2.5 }))
            Console.WriteLine(list.Count)
            """,
            new[] { "2.5", "True", "0" },
        };

        // REVIEW FINDING (#4060). Every form above has a NAMED-argument
        // spelling, and the repair compared source-order arguments against
        // declaration-order parameters. The single-argument forms were fine by
        // luck — with one argument any mapping is the identity — but the two
        // multi-argument forms were not, and `Dictionary.Add` reordered was the
        // reviewer's repro.
        yield return new object[]
        {
            "named-arguments-reordered-on-a-two-argument-add",
            """
            let lookup = Dictionary[string, float64]()
            lookup.Add(value: Celsius{ Degrees: 2.5 }, key: "a")
            Console.WriteLine(lookup["a"])
            """,
            new[] { "2.5" },
        };

        yield return new object[]
        {
            "named-arguments-in-source-order-on-a-two-argument-add",
            """
            let lookup = Dictionary[string, float64]()
            lookup.Add(key: "a", value: Celsius{ Degrees: 2.5 })
            Console.WriteLine(lookup["a"])
            """,
            new[] { "2.5" },
        };

        yield return new object[]
        {
            "named-arguments-reordered-on-insert",
            """
            let list = List[float64]()
            list.Insert(item: Celsius{ Degrees: 2.5 }, index: 0)
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };

        yield return new object[]
        {
            "named-arguments-on-the-single-argument-forms",
            """
            let list = List[float64]()
            list.Add(item: Celsius{ Degrees: 2.5 })
            Console.WriteLine(list[0])
            Console.WriteLine(list.Contains(item: Celsius{ Degrees: 2.5 }))
            Console.WriteLine(list.IndexOf(item: Celsius{ Degrees: 2.5 }))
            Console.WriteLine(list.Remove(item: Celsius{ Degrees: 2.5 }))
            """,
            new[] { "2.5", "True", "0", "True" },
        };
    }

    /// <summary>
    /// The neighbours the repair must leave exactly as they are: the shapes a
    /// careless gate would break. #4013's and #4028's own refusal rows are
    /// separate, in <see cref="StillRefused"/>.
    /// </summary>
    /// <returns>Case name, the G# body appended to the preamble, expected stdout lines.</returns>
    public static IEnumerable<object[]> UnchangedNeighbours()
    {
        // The receiver genuinely wants `object`, and `Celsius -> object` is an
        // ordinary boxing conversion — so no position needs repairing and the
        // element stays a boxed Celsius.
        yield return new object[]
        {
            "a-list-of-object-still-boxes",
            """
            let list = List[object]()
            list.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(list.Count)
            """,
            new[] { "1" },
        };

        // The element type IS the same-compilation type, so the RECEIVER is
        // erased and nothing here may judge the call.
        yield return new object[]
        {
            "an-erased-receiver-is-not-judged",
            """
            let list = List[Celsius]()
            list.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(list.Count)
            """,
            new[] { "1" },
        };

        // A conversion at a CLR parameter with a REAL argument CLR type
        // already worked; this row proves the fix did not change how.
        yield return new object[]
        {
            "an-imported-argument-with-a-conversion-was-already-right",
            """
            let list = List[float64]()
            list.Add(Fahrenheit(2.5))
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };

        // A plain float64 argument needs no repair at all.
        yield return new object[]
        {
            "a-plain-float64-argument-is-untouched",
            """
            let list = List[float64]()
            list.Add(2.5)
            Console.WriteLine(list[0])
            """,
            new[] { "2.5" },
        };
    }

    /// <summary>
    /// The rows that must still be REFUSED. #4028's whole point is that a
    /// widening member reachable with no erasure to repair is not a licence,
    /// and a repair that fired without a conversion would undo that.
    /// </summary>
    /// <returns>Case name, the G# body appended to the preamble, expected diagnostic id.</returns>
    public static IEnumerable<object[]> StillRefused()
    {
        // #4028's row: a same-compilation Celsius at an int32 it does not
        // convert to. No conversion exists, so no repair, and the widening
        // member is still removed by the #4028 filter.
        yield return new object[]
        {
            "a-same-compilation-argument-with-no-conversion",
            """
            let list = List[int32]()
            list.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(list.Count)
            """,
            "GS0159",
        };

        // #4013's row: a genuine string at a genuine int32.
        yield return new object[]
        {
            "a-genuine-string-at-a-genuine-int32",
            """
            let list = List[int32]()
            list.Add("x")
            Console.WriteLine(list.Count)
            """,
            "GS0159",
        };

        // REVIEW FINDING (#4060), negative control. Reordering the names must
        // not become a way to smuggle a conversion that does not exist: the
        // repair reorders in order to ask the RIGHT question, not to stop
        // asking it.
        yield return new object[]
        {
            "named-arguments-reordered-with-no-conversion-to-the-value-type",
            """
            let lookup = Dictionary[string, int32]()
            lookup.Add(value: Celsius{ Degrees: 2.5 }, key: "a")
            Console.WriteLine(lookup.Count)
            """,
            "GS0159",
        };
    }

    /// <summary>
    /// The conversion is applied: the program compiles, IL-verifies, RUNS, and
    /// prints the converted value. Compiling and verifying is not enough — the
    /// whole issue is a program that did both and then threw.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared preamble.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ConversionIsApplied))]
    public void AUserDefinedConversionIsAppliedAtACollectionCall(
        string name,
        string body,
        string[] expectedLines)
        => RunAndExpect(name, body, expectedLines);

    /// <summary>
    /// The neighbours are untouched.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared preamble.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(UnchangedNeighbours))]
    public void ANeighbouringShapeIsUnchanged(
        string name,
        string body,
        string[] expectedLines)
        => RunAndExpect(name, body, expectedLines);

    /// <summary>
    /// A call with no conversion to apply is still refused at compile time.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared preamble.</param>
    /// <param name="expectedId">The diagnostic id the log must carry exactly once.</param>
    [Theory]
    [MemberData(nameof(StillRefused))]
    public void ACallWithNoConversionIsStillRefused(string name, string body, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4036_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", Preamble + body + "\n", appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.Equal(new[] { expectedId }, ErrorIds(appLog));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The emitted call names the receiver's OWN member, not the widening
    /// interface one. Asserted on metadata rather than on stdout because a
    /// correct answer could in principle be reached either way, and the point
    /// of the fix is which member is bound.
    /// </summary>
    [Fact]
    public void TheEmittedCallBindsTheReceiversOwnAddNotTheWideningInterfaceMember()
    {
        const string Body = """
            let list = List[float64]()
            list.Add(Celsius{ Degrees: 2.5 })
            Console.WriteLine(list[0])
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4036_il_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", Preamble + Body + "\n", appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"the program must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var referencedMembers = ReferencedMemberNames(appPath);

            // The widening member is a MemberRef whose parent is the
            // NON-GENERIC `System.Collections.IList` TypeRef; the receiver's own
            // `Add` is a MemberRef parented at the constructed
            // `List`1<double>` TypeSpec, so it carries no type-reference
            // prefix. Before the fix the first was present and the second was
            // not; after it, exactly the other way round.
            Assert.DoesNotContain("System.Collections.IList::Add", referencedMembers);
            Assert.Contains("Add", referencedMembers);

            // The same-compilation conversion operator is DEFINED in this
            // assembly, so it is a MethodDef rather than a MemberRef — and the
            // program only prints 2.5 because it is now called.
            Assert.Contains("op_Implicit", DefinedMethodNames(appPath));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void RunAndExpect(string name, string body, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4036_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", Preamble + body + "\n", appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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

    private static IReadOnlyCollection<string> DefinedMethodNames(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        return md.MethodDefinitions
            .Select(handle => md.GetString(md.GetMethodDefinition(handle).Name))
            .ToList();
    }

    private static IReadOnlyCollection<string> ReferencedMemberNames(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        var names = new List<string>();
        foreach (var handle in md.MemberReferences)
        {
            var member = md.GetMemberReference(handle);
            var name = md.GetString(member.Name);
            var parent = member.Parent;
            if (parent.Kind == HandleKind.TypeReference)
            {
                var typeRef = md.GetTypeReference((TypeReferenceHandle)parent);
                var ns = md.GetString(typeRef.Namespace);
                var typeName = md.GetString(typeRef.Name);
                names.Add((ns.Length == 0 ? typeName : ns + "." + typeName) + "::" + name);
            }
            else
            {
                names.Add(name);
            }
        }

        return names;
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4036",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4036.dll");
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
