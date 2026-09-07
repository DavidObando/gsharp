// <copyright file="Issue4051UnqualifiedGenericReceiverCascadeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4051: a constraint violation on an <em>unqualified</em> generic
/// receiver reported the accurate <c>GS0152</c> and then invented two more
/// reasons that were false.
/// </summary>
/// <remarks>
/// <para><b>What happened.</b> #4032 (PR #4040) made gsc validate declared
/// generic constraints at every construction site. At the qualified spellings
/// the diagnostic stands alone, because <c>TryWalkQualifiedClrTypePath</c> was
/// given a <c>failureHandled</c> escape. The unqualified spellings had no such
/// hook: when <c>TryResolveConstructedGenericTypeReceiver</c> returned
/// <see langword="false"/> after the close had ALREADY reported, every caller
/// read that as "not a type" and fell through to binding <c>Name[Arg]</c> as an
/// ordinary INDEX expression — so <c>Name</c> and <c>Arg</c> were each looked
/// up as values. <c>Nullable[string].Value</c> told the author
/// <c>GS0125: Variable 'Nullable' doesn't exist.</c> and
/// <c>GS0125: Variable 'string' doesn't exist.</c> — and <c>string</c> is a
/// predefined type keyword.</para>
/// <para><b>Where the false diagnostics actually came from</b> — measured, not
/// read off the issue. Not the <c>else if</c> chain in
/// <c>ExpressionBinder.Access.Accessor.cs</c> the filing agent named: by the
/// time that chain runs, <c>BindAccessorExpression</c> has already executed
/// <c>receiver = BindExpression(leftPart)</c> a few hundred lines earlier, and
/// THAT is what re-reads the receiver as an index expression. The remedy is
/// therefore an early return at the FIRST pair of resolver calls, before that
/// line, plus the matching escape in the write
/// (<c>BindMemberFieldAssignmentExpression</c>) and compound-assignment
/// (<c>BindEventSubscriptionExpression</c>) paths, which each fall through to a
/// <c>BindExpression</c> of their own.</para>
/// <para><b>Scope.</b> The issue tabulated eight spellings. Sweeping every
/// spelling the resolver's call sites actually serve found FOUR more that
/// cascade the same way and were not listed: a static-field read, a
/// static-field write, a static-field compound assignment (each
/// <c>GS0125 x2</c>), and the generic-NAME receiver shape
/// <c>Handler[string?]</c> (<c>GS0124 x1</c> + <c>GS0159 x1</c>). The
/// unqualified-static row also carried a <c>GS0159</c> the issue's table
/// omitted. All twelve are covered here; nothing is left over.</para>
/// <para><b>Four of the eight call sites are deliberately left on the
/// discarding overload</b>, in two pairs.
/// <c>TryResolveInheritedImportedNestedType</c>'s two consume only
/// <c>constructedStruct</c> — the USER-symbol output — and only the imported
/// close can report <c>GS0152</c>, so a wired <c>failureHandled</c> there would
/// be dead code. The <c>else if</c> chain's two are unreachable for this
/// failure once the early return above precedes them. The other four are
/// wired: the two read-path calls that carried the cascade, the write path
/// (<c>BindMemberFieldAssignmentExpression</c>), and the compound-assignment
/// path (<c>BindEventSubscriptionExpression</c>). Every one of those facts is
/// measured by the rows below reporting exactly one diagnostic each.</para>
/// <para><b>Nothing individually correct is suppressed.</b> <c>GS0152</c> is
/// still reported, exactly once, at every spelling. What is removed is only the
/// second reading of a receiver the compiler had already refused.</para>
/// </remarks>
public class Issue4051UnqualifiedGenericReceiverCascadeTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. <c>Handler&lt;TOptions&gt;</c>
    /// carries the constraint, a static method, and a static field, so one type
    /// serves the static-call, static-read, static-write and compound-assignment
    /// spellings.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib4051;

        public class SchemeOptions
        {
            public string? Name { get; set; }
        }

        public class Handler<TOptions>
            where TOptions : SchemeOptions
        {
            public static string Field = "f";

            public string Tag { get; set; } = "t";

            public static string Describe() => "described";
        }
        """;

    /// <summary>
    /// Every spelling that closes a constrained imported generic over an
    /// argument that violates the constraint. The expected value is the EXACT
    /// diagnostic-id multiset, not a containment check: the whole defect was a
    /// correct diagnostic keeping bad company, so a test that only asked
    /// whether <c>GS0152</c> was present would have passed before the fix.
    /// </summary>
    /// <returns>Case name, G# source, and the exact expected diagnostic ids.</returns>
    public static IEnumerable<object[]> ConstraintViolations()
    {
        // The five spellings PR #4040 already left clean. They are here as the
        // control the fix must not disturb.
        yield return new object[]
        {
            "qualified-static",
            """
            package P
            import System

            Console.WriteLine(System.Nullable[string].Value)
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "import-qualified",
            """
            package P
            import System

            let v = System.Nullable[string].Value
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "type-clause",
            """
            package P
            import System
            import HelperLib4051

            var h Handler[string]
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "base-clause",
            """
            package P
            import System
            import HelperLib4051

            class Bad : Handler[string] {
            }

            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "object-literal",
            """
            package P
            import System
            import HelperLib4051

            let h = Handler[string]{Tag: "z"}
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        // THE ISSUE'S THREE. Before the fix: GS0125 x2, GS0125 x2 + GS0159,
        // and GS0130 respectively, each beside the accurate GS0152.
        yield return new object[]
        {
            "import-alias",
            """
            package P
            import System

            let v = Nullable[string].Value
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "unqualified-static-call",
            """
            package P
            import System
            import HelperLib4051

            let d = Handler[string].Describe()
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "constructor",
            """
            package P
            import System
            import HelperLib4051

            let h = Handler[string]()
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        // FOUR MORE, found by sweeping the resolver's other call sites rather
        // than by reading the issue's table. Before the fix: GS0125 x2 each for
        // the three field spellings, and GS0124 + GS0159 for the generic-NAME
        // receiver shape, which reaches a different resolver overload.
        yield return new object[]
        {
            "static-field-read",
            """
            package P
            import System
            import HelperLib4051

            let f = Handler[string].Field
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "static-field-write",
            """
            package P
            import System
            import HelperLib4051

            Handler[string].Field = "z"
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "static-field-compound-assignment",
            """
            package P
            import System
            import HelperLib4051

            Handler[string].Field += "z"
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };

        yield return new object[]
        {
            "generic-name-receiver-shape",
            """
            package P
            import System
            import HelperLib4051

            let d = Handler[string?].Describe()
            Console.WriteLine("x")
            """,
            new[] { "GS0152" },
        };
    }

    /// <summary>
    /// A SATISFYING counterpart for each spelling. These are the programs the
    /// early returns must not swallow: every one has to go on compiling,
    /// IL-verifying, running, and printing what it always printed.
    /// </summary>
    /// <remarks>
    /// <para>Several rows deliberately use an IMPORTED type argument
    /// (<c>Handler[SchemeOptions]</c>) rather than a same-compilation one, and
    /// the qualified-static row names <c>Comparer</c> rather than
    /// <c>Nullable</c>. Three neighbouring shapes are broken for reasons that
    /// have nothing to do with this issue — all three measured on the parent
    /// AND on this change, identical, and filed rather than smuggled in
    /// here:</para>
    /// <list type="number">
    /// <item><c>System.Nullable[int32]()</c> — a fully-qualified generic
    /// CONSTRUCTOR call reports <c>GS0157 Cannot find type System</c>, about a
    /// namespace. Issue #4055.</item>
    /// <item><c>Handler[MyOptions]{Tag: "z"}</c> — an object literal of an
    /// imported generic over a same-compilation type argument does not bind,
    /// reporting <c>GS0157</c>. Already filed as #4042 by the #4032 work.</item>
    /// <item><c>Handler[MyOptions].Field += "z"</c> — a static compound
    /// assignment through a generic receiver over a same-compilation type
    /// argument emits <c>Handler&lt;object&gt;</c>: unverifiable IL and a
    /// run-time <c>TypeLoadException</c>, even though <c>MyOptions</c>
    /// satisfies the constraint. That is the generic-CONSTRUCTION placeholder
    /// erasure of #4016/#4041 one receiver shape over. Issue #4056.</item>
    /// </list>
    /// <para>These rows exercise the receiver-RESOLUTION path this fix touches,
    /// not the emit path those three fail in.</para>
    /// </remarks>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> SatisfyingShapes()
    {
        yield return new object[]
        {
            "qualified-static",
            """
            package P
            import System

            Console.WriteLine(System.Collections.Generic.Comparer[int32].Default.Compare(1, 2))
            """,
            new[] { "-1" },
        };

        yield return new object[]
        {
            "type-clause",
            """
            package P
            import System
            import HelperLib4051

            class MyOptions : SchemeOptions {
            }

            var h Handler[MyOptions]
            Console.WriteLine("x")
            """,
            new[] { "x" },
        };

        yield return new object[]
        {
            "base-clause",
            """
            package P
            import System
            import HelperLib4051

            class MyOptions : SchemeOptions {
            }

            class Good : Handler[MyOptions] {
            }

            let g = Good()
            Console.WriteLine(g.Tag)
            """,
            new[] { "t" },
        };

        yield return new object[]
        {
            "object-literal",
            """
            package P
            import System
            import HelperLib4051

            let h = Handler[SchemeOptions]{Tag: "z"}
            Console.WriteLine(h.Tag)
            """,
            new[] { "z" },
        };

        yield return new object[]
        {
            "import-alias",
            """
            package P
            import System

            let v = Nullable[int32]()
            Console.WriteLine(v.HasValue)
            """,
            new[] { "False" },
        };

        yield return new object[]
        {
            "unqualified-static-call",
            """
            package P
            import System
            import HelperLib4051

            class MyOptions : SchemeOptions {
            }

            Console.WriteLine(Handler[MyOptions].Describe())
            """,
            new[] { "described" },
        };

        yield return new object[]
        {
            "constructor",
            """
            package P
            import System
            import HelperLib4051

            class MyOptions : SchemeOptions {
            }

            let h = Handler[MyOptions]()
            Console.WriteLine(h.Tag)
            """,
            new[] { "t" },
        };

        yield return new object[]
        {
            "static-field-read",
            """
            package P
            import System
            import HelperLib4051

            Console.WriteLine(Handler[SchemeOptions].Field)
            """,
            new[] { "f" },
        };

        yield return new object[]
        {
            "static-field-write",
            """
            package P
            import System
            import HelperLib4051

            Handler[SchemeOptions].Field = "z"
            Console.WriteLine(Handler[SchemeOptions].Field)
            """,
            new[] { "z" },
        };

        yield return new object[]
        {
            "static-field-compound-assignment",
            """
            package P
            import System
            import HelperLib4051

            Handler[SchemeOptions].Field += "z"
            Console.WriteLine(Handler[SchemeOptions].Field)
            """,
            new[] { "fz" },
        };

        yield return new object[]
        {
            "generic-name-receiver-shape",
            """
            package P
            import System
            import System.Collections.Generic

            Console.WriteLine(Comparer[List[int32]].Default.GetType().Name)
            """,
            new[] { "ObjectComparer`1" },
        };
    }


    /// <summary>
    /// A violating spelling reports <c>GS0152</c> and NOTHING ELSE. The
    /// assertion is on the exact multiset of diagnostic ids, in order, so a
    /// consequential error re-appearing is a failure rather than a silence.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedIds">The exact diagnostic ids the log must carry, in order.</param>
    [Theory]
    [MemberData(nameof(ConstraintViolations))]
    public void AViolatingGenericReceiver_ReportsTheConstraintAndNothingElse(
        string name,
        string source,
        string[] expectedIds)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4051_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            var ids = ErrorIds(appLog);
            Assert.Equal(expectedIds, ids);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The two messages the issue calls out by name are gone. Pinned
    /// separately from the id multiset because the complaint was about the
    /// TEXT: telling an author that <c>string</c> is a variable that does not
    /// exist is worse than saying nothing.
    /// </summary>
    [Fact]
    public void ThePredefinedTypeKeywordIsNeverReportedAsAMissingVariable()
    {
        const string Source = """
            package P
            import System

            let v = Nullable[string].Value
            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4051_msg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("Variable 'string' doesn't exist", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("Variable 'Nullable' doesn't exist", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every satisfying spelling still compiles, IL-verifies, runs, and prints
    /// what it always printed. The early returns this fix adds are reached only
    /// after a diagnostic was reported; these rows are what proves that.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(SatisfyingShapes))]
    public void ASatisfyingGenericReceiver_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4051_pos_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
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
            "HelperLib4051",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4051.dll");
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
