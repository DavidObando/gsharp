// <copyright file="Issue4010NilLiteralAtOpenParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4010: a bare <c>nil</c> literal at an OPEN non-nullable parameter was
/// accepted for every shape, where every CLOSED spelling reports
/// <c>GS0154</c>.
/// </summary>
/// <remarks>
/// <para><b>Cause.</b> The <c>ContainsTypeParameter</c> bypass in
/// <c>OverloadResolver.CallBinding</c>'s argument loop — the same clause #3988
/// amended in #3999. When the substituted parameter type still mentions a type
/// parameter, <c>Conversion.Classify</c> is not asked at all. #3988 taught the
/// clause to look at a <c>NullableTypeSymbol</c> ARGUMENT; a bare <c>nil</c>
/// literal has type <c>TypeSymbol.Null</c>, not a nullable annotation, so that
/// gate never saw it and the argument again flowed through unchecked.</para>
/// <para><b>Fix.</b> A <c>nil</c> argument is routed to
/// <c>Conversion.Classify</c> whether or not the parameter is open. That is not
/// a closed-world judgement smuggled into an open pair: <c>Classify(nil, X)</c>
/// answers from <c>Conversion.IsNilAssignableWithoutNullableWrapper</c>, which
/// decides on <c>X</c>'s SYMBOL KIND alone — a G#-declared class, an interface,
/// a reference-CONSTRAINED type parameter and any nullable target accept
/// <c>nil</c>; a <c>chan[T]</c>, <c>[]T</c>, <c>map[K,V]</c>,
/// <c>sequence[T]</c>, <c>[4]T</c>, <c>(T) -&gt; T</c> and an UNCONSTRAINED
/// <c>T</c> do not. So the OPEN spelling now answers exactly what the CLOSED
/// spelling already answered, which is the whole content of the change.</para>
/// <para><b>Unsound, not merely silent.</b> Measured on the parent:
/// <c>takesMap[K, V](nil)</c> forwarded out of a generic and instantiated at
/// <c>[string, int32]</c> compiled with NO diagnostic, IL-verified
/// (<c>dotnet ilverify</c>: <i>All Classes and Methods … Verified</i>, on the
/// parent's own output), and threw <c>NullReferenceException</c> when the
/// callee read <c>m.Count</c>.</para>
/// <para><b>The issue's DIRECT form was already rejected, and the issue is
/// corrected here.</b> <c>takesMap[string, int32](nil)</c> written at a closed
/// instantiation reports <c>GS0154</c> on the parent: the substituted parameter
/// is <c>map[string,int32]</c>, which mentions no type parameter, so the bypass
/// is not taken. The unsound form is the FORWARDED one, where the substituted
/// parameter stays open. A correction was posted on the issue
/// (comment 5559871459).</para>
/// <para><b>Three shapes beyond the four the issue named also change.</b> An
/// unconstrained <c>T</c>, a fixed array <c>[4]T</c> and a function type
/// <c>(T) -&gt; T</c> were silently accepting <c>nil</c> at their OPEN
/// spellings too. All three are red rows here, and each one's CLOSED sibling
/// was already <c>GS0154</c> on the parent — measured, not assumed.</para>
/// <para><b>The green rows are the point.</b> <c>nil</c> still reaches every
/// null-tolerant OPEN shape: a reference-constrained <c>[T class]</c> (and it
/// genuinely arrives — the callee compares it against <c>nil</c>), an open
/// <c>T?</c>, an open <c>chan[T]?</c>, a G#-declared open class
/// <c>Node[T]</c> and an open interface <c>IThing[T]</c>. Real values still
/// forward through open <c>map</c> and <c>chan</c> parameters and are read back
/// out, so a gate that had become timid would show as a wrong number rather
/// than merely as a compile error.</para>
/// </remarks>
public class Issue4010NilLiteralAtOpenParameterTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The <c>nil</c> arguments that must now be refused.</summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The issue's four shapes, each at an OPEN parameter. All four compiled
        // with NO diagnostic on the parent.
        yield return new object[]
        {
            "an-open-channel-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesChan[T](c chan[T]) int32 { return 1 }
            func nilChan[T]() int32 { return takesChan[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "an-open-slice-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesSlice[T](s []T) int32 { return 1 }
            func nilSlice[T]() int32 { return takesSlice[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "an-open-map-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesMap[K, V](m map[K, V]) int32 { return 1 }
            func nilMap[K, V]() int32 { return takesMap[K, V](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "an-open-sequence-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesSeq[T](s sequence[T]) int32 { return 1 }
            func nilSeq[T]() int32 { return takesSeq[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        // Three shapes the issue did not name, found by sweeping the OPEN
        // spellings. Each one's CLOSED sibling was already GS0154 on the
        // parent, so these are the same hole, not a widening.
        yield return new object[]
        {
            "an-open-unconstrained-type-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesBareT[T](x T) int32 { return 1 }
            func fwdBareT[T]() int32 { return takesBareT[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "an-open-fixed-array-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesFixed[T](a [4]T) int32 { return 1 }
            func fwdFixed[T]() int32 { return takesFixed[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "an-open-function-type-parameter-rejects-a-nil-literal",
            """
            package Demo
            import System

            func takesFunc[T](f (T) -> T) int32 { return 1 }
            func fwdFunc[T]() int32 { return takesFunc[T](nil) }

            Console.WriteLine("x")
            """,
            "GS0154",
        };

        // THE SOUNDNESS ROW. On the parent this compiled, IL-verified, ran, and
        // threw NullReferenceException at `m.Count`.
        yield return new object[]
        {
            "the-forwarded-nil-that-reached-a-real-dereference-is-now-a-compile-error",
            """
            package Demo
            import System

            func takesMap[K, V](m map[K, V]) int32 { return m.Count }
            func forwardMap[K, V]() int32 { return takesMap[K, V](nil) }

            let n int32 = forwardMap[string, int32]()
            Console.WriteLine(n)
            """,
            "GS0154",
        };

        // The CLOSED controls the issue lists. Rejected before and after — the
        // rows that establish what "the open spelling now agrees with the
        // closed one" is agreeing WITH.
        yield return new object[]
        {
            "control-the-closed-channel-spelling-was-always-rejected",
            """
            package Demo
            import System

            func takesClosedChan(c chan[int32]) int32 { return 1 }
            Console.WriteLine(takesClosedChan(nil))
            """,
            "GS0154",
        };

        yield return new object[]
        {
            "control-the-closed-map-spelling-was-always-rejected",
            """
            package Demo
            import System

            func takesClosedMap(m map[string, int32]) int32 { return 1 }
            Console.WriteLine(takesClosedMap(nil))
            """,
            "GS0154",
        };

        // The issue's own DIRECT form, whose diagnosis the issue got wrong: a
        // closed instantiation mentions no type parameter, so the bypass was
        // never taken and this reported GS0154 on the parent too.
        yield return new object[]
        {
            "control-the-direct-closed-instantiation-was-always-rejected",
            """
            package Demo
            import System

            func takesMap[K, V](m map[K, V]) int32 { return m.Count }

            let n int32 = takesMap[string, int32](nil)
            Console.WriteLine(n)
            """,
            "GS0154",
        };
    }

    /// <summary>Every legitimate neighbour that must keep binding.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> LegitimateCases()
    {
        // `nil` still reaches every null-tolerant OPEN shape. The
        // reference-constrained `[T class]` arm is exercised by its own
        // compile-verify-and-run fact below rather than here, because it also
        // asserts the value that ARRIVES. It used to skip verification for a
        // pre-existing emit defect; #4027 fixed that and the skip is gone.
        yield return new object[]
        {
            "control-nil-still-reaches-every-null-tolerant-open-shape",
            """
            package Demo
            import System

            func takesNullableT[T](x T?) int32 { return 3 }
            func fwdNullableT[T]() int32 { return takesNullableT[T](nil) }

            func takesNullableChan[T](c chan[T]?) int32 { return 4 }
            func fwdNullableChan[T]() int32 { return takesNullableChan[T](nil) }

            class Node[T] { public var V T }
            func takesNode[T](n Node[T]) int32 { return 5 }
            func fwdNode[T]() int32 { return takesNode[T](nil) }

            interface IThing[T] { func Do() int32; }
            func takesIface[T](i IThing[T]) int32 { return 6 }
            func fwdIface[T]() int32 { return takesIface[T](nil) }

            Console.WriteLine(fwdNullableT[int32]())
            Console.WriteLine(fwdNullableChan[int32]())
            Console.WriteLine(fwdNode[int32]())
            Console.WriteLine(fwdIface[int32]())
            """,
            new[] { "3", "4", "5", "6" },
        };

        // The gate must not become timid: a REAL map forwarded through the very
        // open parameter the repro used still binds, and its contents are read
        // back out, so a wrong argument would print a wrong number rather than
        // merely verify.
        yield return new object[]
        {
            "control-a-real-map-still-forwards-through-the-open-parameter",
            """
            package Demo
            import System

            func countMap[K, V](m map[K, V]) int32 { return m.Count }
            func forwardReal[K, V](m map[K, V]) int32 { return countMap[K, V](m) }

            let real = map[string, int32]{}
            real["a"] = 1
            real["b"] = 2
            Console.WriteLine(forwardReal[string, int32](real))
            """,
            new[] { "2" },
        };

        // The channel spelling of the same control, and it MOVES A VALUE: the
        // relay sends through an open `chan[T]` parameter and the caller reads
        // the value back, so a dropped or mis-shaped argument would deadlock or
        // print the wrong number.
        yield return new object[]
        {
            "control-a-real-channel-still-moves-a-value-through-the-open-parameter",
            """
            package Demo
            import System

            func sendOne[T](c chan[T], v T) {
                c <- v
            }

            func relay[T](c chan[T], v T) {
                sendOne[T](c, v)
            }

            let ch = chan[int32](1)
            relay[int32](ch, 41)
            let got = <-ch
            Console.WriteLine(got)
            """,
            new[] { "41" },
        };

        // The remedy the diagnostic leaves the author for a genuinely optional
        // slot: annotate the parameter. Kept green so the change cannot be read
        // as "an open channel can never be absent".
        yield return new object[]
        {
            "control-the-annotation-remedy-accepts-nil-and-narrows-back-to-a-value",
            """
            package Demo
            import System

            func maybeCount[K, V](m (map[K, V])?) int32 {
                if m != nil {
                    return 10
                }

                return 20
            }

            func fwdNil[K, V]() int32 { return maybeCount[K, V](nil) }

            let real = map[string, int32]{}
            real["a"] = 1
            Console.WriteLine(fwdNil[string, int32]())
            Console.WriteLine(maybeCount[string, int32](real))
            """,
            new[] { "20", "10" },
        };
    }

    /// <summary>
    /// A <c>nil</c> literal at an OPEN non-nullable parameter now reports the
    /// same <c>GS0154</c> its closed sibling always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void ANilLiteralAtANonNullableParameter_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4010_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

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
    /// Every legitimate neighbour still compiles, IL-verifies, runs, and prints
    /// what it always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(LegitimateCases))]
    public void ALegitimateNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4010_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, Array.Empty<string>());

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

    /// <summary>
    /// A reference-constrained <c>[T class]</c> parameter still accepts a
    /// <c>nil</c> literal at an OPEN call site, and the <c>nil</c> genuinely
    /// ARRIVES: the callee compares the parameter against <c>nil</c> and takes
    /// the nil branch, so a change that had merely stopped emitting the
    /// argument would print <c>2</c>.
    /// </summary>
    /// <remarks>
    /// <para><b>This row used to skip <c>IlVerifier</c>; #4027 fixed the emit
    /// defect and the skip is gone.</b> The IL the compiler emitted for the
    /// call was <c>ldnull</c> at a slot typed <c>!!0</c>, which ILVerify
    /// rejects: <c>[StackUnexpected] [found Nullobjref 'NullReference']
    /// [expected value 'T']</c>. That was a PRE-EXISTING emit defect, not a
    /// consequence of #4010's change — <c>Classify(nil, [T class])</c> is
    /// <c>Implicit</c> (via
    /// <c>Conversion.IsNilAssignableWithoutNullableWrapper</c>'s
    /// reference-constrained arm) before and after it, so the argument reached
    /// emit by the same path and the same bytes came out. It was filed as
    /// #4027 and the row was kept unverified because it is the control that
    /// stops #4010's gate from becoming timid. #4027 lowers a <c>nil</c> at a
    /// bare open type-parameter slot to <c>default(T)</c>, so the call site now
    /// emits <c>ldloca.s N; initobj !!T; ldloc.N</c> — the same shape
    /// <c>csc</c> emits for the equivalent C# — and this row verifies. The
    /// run-and-print assertion is unchanged, so the <c>nil</c> must still
    /// ARRIVE: <c>default(T)</c> at a <c>[T class]</c> slot is the null
    /// reference in every instantiation.</para>
    /// </remarks>
    [Fact]
    public void AReferenceConstrainedTypeParameterStillAcceptsNil_AndTheNilArrives()
    {
        const string Source = """
            package Demo
            import System

            func takesClassT[T class](x T) int32 { if x == nil { return 1 } else { return 2 } }
            func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

            Console.WriteLine(fwdClassT[string]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4010_cls_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "ClassConstrained.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"a reference-constrained slot must still accept nil. Log:\n{appLog}");

            // #4027: no longer exempt. This assembly IL-verifies.
            IlVerifier.Verify(appPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the case must run to completion. Exit {exit}:\n{output}");
            Assert.Equal("1", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
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
