// <copyright file="Issue4027NilAtReferenceConstrainedTypeParameterTests.cs" company="GSharp">
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
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4027: a <c>nil</c> literal at a reference-constrained
/// <c>[T class]</c> slot emitted a bare <c>ldnull</c> against a signature slot
/// typed <c>!!T</c> (or <c>!T</c>), and the IL did not verify.
/// </summary>
/// <remarks>
/// <para><b>Cause.</b> Two sites, one rule. <c>Conversion.Classify(nil, T)</c>
/// is <c>Implicit</c> for a reference-constrained type parameter and that is
/// deliberate (#2354) — a <c>[T class]</c> slot is a reference in every
/// instantiation. But nothing lowered the accepted literal: it stayed a
/// <c>BoundLiteralExpression(null)</c> and
/// <c>MethodBodyEmitter.EmitLiteral</c> emits <c>ldnull</c> for that. ECMA-335
/// III.1.8.1.3 has no rule admitting a null reference at a generic-parameter
/// slot — constraint or no constraint — so ILVerify reported
/// <c>[StackUnexpected] [found Nullobjref 'NullReference'] [expected value
/// 'T']</c>.</para>
/// <para><b>Fix.</b> Lower it to <c>default(T)</c>, which is what the emitter
/// already materialises correctly. <c>MethodBodyEmitter.EmitDefault</c> has
/// routed a type-parameter-typed <c>BoundDefaultExpression</c> through
/// <c>ldloca; initobj; ldloc</c> since #774, and #814 already sent the
/// <c>T?</c> spelling of this very literal there; #4027 sends the BARE
/// spelling too. <c>ConversionClassifier.BindConversion</c> covers the
/// declaration, assignment, return and field sinks; the call-argument sink
/// needed its own clause in <c>OverloadResolver.CallBinding</c>, because
/// #3222's erasure skip deliberately declines to materialise a bare erased
/// slot whose substituted target is still open — which is exactly this
/// shape.</para>
/// <para><b>The IL choice is not invented.</b> Measured: <c>csc</c> compiling
/// <c>static int Fwd&lt;T&gt;() where T : class =&gt; Takes&lt;T&gt;(null);</c>
/// emits <c>ldloca.s 0; initobj !!T; ldloc.0; call</c> and that assembly
/// verifies. gsc now emits the same three opcodes at the same place. A
/// <c>box</c>/<c>unbox.any</c> pair would also type-check on the stack, but it
/// is two extra opcodes and would differ from the reference implementation for
/// no gain.</para>
/// <para><b>Meaning is preserved, and the rows prove it.</b> For a
/// <c>[T class]</c> slot <c>default(T)</c> IS the null reference in every
/// instantiation, so the <c>nil</c> still ARRIVES. Every row here runs and
/// asserts the value the callee observed, so a change that had quietly stopped
/// passing the argument — or started passing something else — would print the
/// wrong number rather than merely verify.</para>
/// <para><b>Six sinks were red, not one.</b> The issue names the call
/// argument. Sweeping every way a <c>nil</c> can reach an open
/// reference-constrained slot found five more: a local declaration, an
/// assignment, a <c>return</c>, and — on a generic CLASS, where the slot is
/// <c>!T</c> rather than <c>!!T</c> — a field write and a member
/// <c>return</c>. All six were <c>StackUnexpected</c> on the parent
/// (<c>565b9a04</c>); all six verify here.</para>
/// </remarks>
public class Issue4027NilAtReferenceConstrainedTypeParameterTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Every sink through which a <c>nil</c> reaches an open
    /// reference-constrained type-parameter slot. Each one reported
    /// <c>StackUnexpected</c> on the parent.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> UnverifiableSinks()
    {
        // The issue's own repro: the CALL ARGUMENT. `ldnull` at a `!!0` slot.
        yield return new object[]
        {
            "the-issues-repro-a-call-argument-at-an-open-class-constrained-slot",
            """
            package Demo
            import System

            func takesClassT[T class](x T) int32 { if x == nil { return 1 } else { return 2 } }
            func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

            Console.WriteLine(fwdClassT[string]())
            """,
            new[] { "1" },
        };

        // A LOCAL DECLARATION whose declared type is the open parameter.
        yield return new object[]
        {
            "a-local-declaration-of-the-open-type-parameter",
            """
            package Demo
            import System

            func localSink[T class]() int32 {
                let x T = nil
                if x == nil { return 1 }
                return 2
            }

            Console.WriteLine(localSink[string]())
            """,
            new[] { "1" },
        };

        // An ASSIGNMENT over a variable already holding a real value, so the
        // printed answer changes if the nil fails to land.
        yield return new object[]
        {
            "an-assignment-over-a-live-value-of-the-open-type-parameter",
            """
            package Demo
            import System

            func assignSink[T class](seed T) int32 {
                var x T = seed
                if x == nil { return 3 }
                x = nil
                if x == nil { return 1 }
                return 2
            }

            Console.WriteLine(assignSink[string]("seed"))
            """,
            new[] { "1" },
        };

        // A RETURN of the open type parameter.
        yield return new object[]
        {
            "a-return-of-the-open-type-parameter",
            """
            package Demo
            import System

            func returnSink[T class]() T {
                return nil
            }

            Console.WriteLine(returnSink[string]() == nil)
            """,
            new[] { "True" },
        };

        // A generic CLASS's own type parameter is `!T`, not `!!T`. Both the
        // field write and the member return were red.
        yield return new object[]
        {
            "a-generic-classs-own-type-parameter-field-write-and-member-return",
            """
            package Demo
            import System

            class Box[T class] {
                public var V T

                public func Seed(v T) {
                    this.V = v
                }

                public func Clear() {
                    this.V = nil
                }

                public func Get() T {
                    return nil
                }
            }

            let b = Box[string]()
            b.Seed("live")
            Console.WriteLine(b.V == nil)
            b.Clear()
            Console.WriteLine(b.V == nil)
            Console.WriteLine(b.Get() == nil)
            """,
            new[] { "False", "True", "True" },
        };

        // The same call-argument sink, closed at a G#-DECLARED class instead of
        // an imported one, so the argument that arrives is a same-compilation
        // reference. Red on the parent for the same reason as the first row
        // (`1x StackUnexpected`), and it also carries a real `Payload` through
        // the same slot, so a timid gate would print a wrong first number.
        yield return new object[]
        {
            "the-open-slot-closed-at-a-same-compilation-class",
            """
            package Demo
            import System

            class Payload { public var N int32 }

            func takesClassT[T class](x T) int32 { if x == nil { return 1 } else { return 2 } }
            func fwdNil[T class]() int32 { return takesClassT[T](nil) }

            let p = Payload()
            p.N = 5
            Console.WriteLine(takesClassT[Payload](p))
            Console.WriteLine(fwdNil[Payload]())
            """,
            new[] { "2", "1" },
        };

        // The whole set in one assembly, which is how the six errors were
        // originally counted. Keeps the rows above from drifting apart.
        yield return new object[]
        {
            "all-six-sinks-in-one-assembly",
            """
            package Demo
            import System

            class Box[T class] {
                public var V T

                public func Set() {
                    this.V = nil
                }

                public func Get() T {
                    return nil
                }
            }

            func takesClassT[T class](x T) int32 { if x == nil { return 1 } else { return 2 } }

            func argSink[T class]() int32 { return takesClassT[T](nil) }

            func localSink[T class]() int32 {
                let x T = nil
                if x == nil { return 1 }
                return 2
            }

            func assignSink[T class](seed T) int32 {
                var x T = seed
                x = nil
                if x == nil { return 1 }
                return 2
            }

            func returnSink[T class]() T {
                return nil
            }

            let b = Box[string]()
            b.Set()
            Console.WriteLine(argSink[string]())
            Console.WriteLine(localSink[string]())
            Console.WriteLine(assignSink[string]("s"))
            Console.WriteLine(returnSink[string]() == nil)
            Console.WriteLine(b.Get() == nil)
            """,
            new[] { "1", "1", "1", "True", "True" },
        };
    }

    /// <summary>
    /// Neighbouring shapes that were already green and must stay green — the
    /// controls that stop the lowering from being read as "every nil is now a
    /// default".
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> GreenNeighbours()
    {
        // A CLOSED reference slot keeps emitting `ldnull`; the lowering is
        // keyed on the target being an open type parameter, not on `nil`.
        yield return new object[]
        {
            "control-a-closed-reference-slot-still-takes-a-plain-nil",
            """
            package Demo
            import System

            class Node { public var Name string }

            func takesNode(n Node) int32 { if n == nil { return 1 } else { return 2 } }

            Console.WriteLine(takesNode(nil))
            """,
            new[] { "1" },
        };

        // `T?` over an open parameter — the spelling #814 already lowered.
        // Both constraint kinds, because they take different representations
        // (`!!T` for [T class], `Nullable<!!T>` for [T struct]).
        yield return new object[]
        {
            "control-the-nullable-spellings-over-an-open-parameter-are-unchanged",
            """
            package Demo
            import System

            func takesNullableClass[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
            func fwdNullableClass[T class]() int32 { return takesNullableClass[T](nil) }

            func takesNullableStruct[T struct](x T?) int32 { if x == nil { return 3 } else { return 4 } }
            func fwdNullableStruct[T struct]() int32 { return takesNullableStruct[T](nil) }

            Console.WriteLine(fwdNullableClass[string]())
            Console.WriteLine(fwdNullableStruct[int32]())
            """,
            new[] { "1", "3" },
        };

        // The gate must not become timid: a REAL value still forwards through
        // the very open parameter the repro used, and is read back out.
        yield return new object[]
        {
            "control-a-real-value-still-forwards-through-the-open-class-constrained-slot",
            """
            package Demo
            import System

            func lengthOf[T class](x T) int32 { if x == nil { return -1 } else { return 7 } }
            func forward[T class](x T) int32 { return lengthOf[T](x) }

            Console.WriteLine(forward[string]("hello"))
            """,
            new[] { "7" },
        };

        // An UNCONSTRAINED `T` still refuses `nil` (#4010). The lowering must
        // not have re-opened that hole by materialising a default.
        yield return new object[]
        {
            "control-an-unconstrained-open-parameter-still-refuses-nil",
            """
            package Demo
            import System

            func takesBareT[T](x T) int32 { return 1 }
            func fwdBareT[T]() int32 { return takesBareT[T](nil) }

            Console.WriteLine("x")
            """,
            Array.Empty<string>(),
        };
    }

    /// <summary>
    /// Every sink compiles, IL-VERIFIES, runs, and prints the value the callee
    /// actually observed.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(UnverifiableSinks))]
    public void ANilAtAnOpenReferenceConstrainedSlot_VerifiesAndArrives(
        string name,
        string source,
        string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// Every neighbour that was already green stays green.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines; empty means the
    /// case must NOT compile.</param>
    [Theory]
    [MemberData(nameof(GreenNeighbours))]
    public void AGreenNeighbour_IsUnchanged(string name, string source, string[] expectedLines)
    {
        if (expectedLines.Length == 0)
        {
            var rejectDir = Directory.CreateTempSubdirectory("gs_4027_neg_").FullName;
            try
            {
                var rejectPath = Path.Combine(rejectDir, name + ".dll");
                var rejectLog = Compile(rejectDir, "App.gs", source, rejectPath, "/target:exe");
                Assert.False(File.Exists(rejectPath), $"'{name}' must not compile. Log:\n{rejectLog}");
                Assert.Contains("GS0154", rejectLog, StringComparison.Ordinal);
            }
            finally
            {
                Directory.Delete(rejectDir, recursive: true);
            }

            return;
        }

        CompileVerifyAndRun(name, source, expectedLines);
    }

    /// <summary>
    /// The emitted call site carries the exact three opcodes <c>csc</c> emits
    /// for the same C# program — <c>ldloca.s N</c>, <c>initobj !!T</c>,
    /// <c>ldloc.N</c> — and NOT a bare <c>ldnull</c>. Pinned as bytes because
    /// "it verifies" alone would also accept a <c>box</c>/<c>unbox.any</c>
    /// pair, and the point of the fix is that gsc matches the reference
    /// implementation.
    /// </summary>
    [Fact]
    public void TheCallSiteEmitsInitobj_NotLdnull()
    {
        const string Source = """
            package Demo
            import System

            func takesClassT[T class](x T) int32 { if x == nil { return 1 } else { return 2 } }
            func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

            Console.WriteLine(fwdClassT[string]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4027_il_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Shape.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"the shape case must compile. Log:\n{appLog}");

            var il = ReadMethodIl(appPath, "fwdClassT");

            // ldloca.s 0 (0x12 0x00), initobj <TypeSpec> (0xFE 0x15 + token),
            // ldloc.0 (0x06), call <MethodSpec> (0x28 + token), ret (0x2A).
            Assert.True(il.Length >= 4, $"fwdClassT body is too short to hold the shape: {Describe(il)}");
            Assert.Equal(0x12, il[0]);
            Assert.Equal(0x00, il[1]);
            Assert.Equal(0xFE, il[2]);
            Assert.Equal(0x15, il[3]);
            Assert.Equal(0x06, il[8]);

            // The defect's own byte must be gone from this body entirely.
            Assert.DoesNotContain((byte)0x14, il);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void CompileVerifyAndRun(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4027_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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

    private static byte[] ReadMethodIl(string assemblyPath, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        foreach (var handle in md.MethodDefinitions)
        {
            var method = md.GetMethodDefinition(handle);
            if (!string.Equals(md.GetString(method.Name), methodName, StringComparison.Ordinal))
            {
                continue;
            }

            if (method.RelativeVirtualAddress == 0)
            {
                continue;
            }

            return pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
                ?? Array.Empty<byte>();
        }

        throw new InvalidOperationException($"method '{methodName}' not found in '{assemblyPath}'");
    }

    private static string Describe(byte[] il)
        => string.Join(" ", il.Select(b => b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture)));

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
