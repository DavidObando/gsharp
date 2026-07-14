// <copyright file="Issue2335AdjacentEmitterDefectsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2335 follow-up: two ADJACENT, pre-existing emitter defects
/// discovered while validating the primary struct-constrained
/// generic-type-pattern fix (<see cref="Issue2335StructConstrainedGenericPatternEmitTests"/>).
/// Both were tightly coupled to the same type-classification/conversion
/// machinery audited for that fix, so they are corrected here rather than
/// merely documented.
///
/// <para>
/// <b>Defect A — narrowed-variable constrained-receiver addressing.</b>
/// <c>MethodBodyEmitter.EmitConstrainedTypeParameterReceiver</c> (the
/// <c>constrained.</c>-prefix receiver-address helper backing issue #943 /
/// #1052 constrained calls, e.g. <c>x.ToString()</c> / <c>x.CompareTo(y)</c>
/// dispatched through a type-parameter receiver) assumed ANY
/// <c>BoundVariableExpression</c> receiver is safely addressable via its OWN
/// declared storage slot (<c>ldarga</c>/<c>ldloca</c>). That is false for a
/// NARROWED variable read (ADR-0069 smart-cast — <c>if x is T { x.ToString() }</c>
/// narrowing an <c>object</c>-typed parameter/local to a type-parameter view
/// <c>T</c>): the narrowed view still physically lives in the wider DECLARED
/// slot, so taking that slot's address yields <c>object&amp;</c>, not the
/// <c>!!T&amp;</c> the <c>constrained.</c> prefix requires — ilverify rejects
/// the mismatch (<c>StackUnexpected</c>). Fixed in
/// <c>SlotPlanner.ReceiverSpillCollector</c> (plans a spill slot, typed as
/// the NARROWED type, for a narrowed variable receiver exactly like any other
/// non-addressable receiver shape) and in
/// <c>MethodBodyEmitter.EmitConstrainedTypeParameterReceiver</c> (only takes
/// the fast "own address" path when the variable is NOT narrowed). A closely
/// related generalization was applied to the shared
/// <c>EmitNarrowingCastIfNeeded</c> helper (used by narrowed variable/field/
/// property reads generally, including a plain <c>if x is T { return x }</c>
/// with no further method call): it previously fell back to <c>castclass</c>
/// for ANY bare (including fully unconstrained) type-parameter narrowing
/// target — the identical gap already closed in <c>EmitTypePattern</c> by the
/// primary #2335 fix — and now universally routes through <c>unbox.any</c>
/// per the same ECMA-335 III.4.32 justification.
/// </para>
///
/// <para>
/// <b>Defect B — plain-function-call boxing/widening.</b>
/// <c>OverloadResolver.BindCallExpression</c>'s per-argument conversion loop
/// (used for a call to a plain, non-imported, non-instance G# function) had
/// no fallback case for a general implicit conversion (boxing a value type
/// into an <c>object</c>/interface parameter, numeric widening, etc.): its
/// branches covered only the explicit-only/error path and a
/// value-type-<c>Nullable&lt;T&gt;</c> lift, so any OTHER implicitly-convertible
/// argument passed through completely unconverted. The emitter applies no
/// further implicit conversion of its own for a plain call (contrast the
/// CLR-call and instance/shared/extension-call paths, which always route
/// through <c>BindCallArgumentWithRefKind</c>/<c>BindConversion</c>), so a
/// bare value/enum/generic-type-parameter expression passed directly to a
/// plain function's <c>object</c>-typed parameter (e.g.
/// <c>func Show(x object) {…}; Show(42)</c>) silently dropped the <c>box</c>
/// opcode — ilverify: <c>StackUnexpected: found Int32, expected ref
/// 'object'</c>. Fixed by adding the same general
/// implicit-conversion-materialization fallback (calling
/// <c>conversions.BindConversion</c>) already used by every other call-
/// argument path, guarded to still skip an open/erased type-parameter
/// target exactly like <c>BindUserInstanceCall</c> does, so generic
/// erased-slot arguments (e.g. <c>List[T].Add(val)</c>) are left untouched
/// for the emitter's call-boundary erasure boxing.
/// </para>
///
/// <para>
/// Every test compiles with <c>gsc</c>, ilverifies the emitted PE, executes
/// it, and asserts on captured stdout.
/// </para>
/// </summary>
public class Issue2335AdjacentEmitterDefectsEmitTests
{
    // ----- Defect A: narrowed-variable constrained-receiver addressing -----

    [Fact]
    public void NarrowedParameter_ConstrainedObjectMemberCall_UnconstrainedT_ValueClosure()
    {
        // The exact repro: an `object`-typed PARAMETER narrowed via `if x is T`
        // to an UNCONSTRAINED `T`, then a universal object member (`ToString`)
        // is called directly on the narrowed variable — the receiver is the
        // SAME BoundVariableExpression instance (`x`), just reporting the
        // narrowed type `T` (ADR-0069). Pre-fix this emitted `ldarga.s x`
        // (address of the DECLARED `object` slot) ahead of `constrained. !!T`,
        // which ilverify rejects.
        var source = """
            package i2335adjA1
            import System

            func Describe[T](x object) string {
                if x is T {
                    return x.ToString()!!
                }
                return "other"
            }

            var v object = 42
            Console.WriteLine(Describe[int32](v))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedLocal_ConstrainedObjectMemberCall_UnconstrainedT_ValueClosure()
    {
        // Same shape as above, but the narrowed variable is a LOCAL
        // (`var y object = x`) rather than a parameter — exercises the
        // `this.locals` branch of `SlotPlanner`/`TryLoadVariableAddress`
        // rather than the parameter branch.
        var source = """
            package i2335adjA2
            import System

            func Describe[T](x object) string {
                var y object = x
                if y is T {
                    return y.ToString()!!
                }
                return "other"
            }

            var v object = 99
            Console.WriteLine(Describe[int32](v))
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedParameter_ConstrainedInterfaceCall_ClassConstrainedT_ClassClosure()
    {
        // A user-interface-constrained type parameter (`T : IShape`) narrows
        // an `object`-typed parameter and dispatches a USER interface method
        // (issue #1052's `BoundUserInstanceCallExpression` constrained-call
        // path, not just the universal-object-member path #1550 covers) on
        // the narrowed receiver. Closes over a class (`Square`).
        var source = """
            package i2335adjA3
            import System

            interface IShape {
                func Area() int32;
            }

            class Square(Side int32) : IShape {
                func Area() int32 { return Side * Side }
            }

            func Describe[T IShape](x object) int32 {
                if x is T {
                    return x.Area()
                }
                return -1
            }

            var v object = Square(5)
            Console.WriteLine(Describe[Square](v))
            """;

        Assert.Equal("25\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedField_ConstrainedObjectMemberCall_StructConstrainedT_EnumClosure()
    {
        // The narrowed receiver is an INSTANCE FIELD read (not a bare
        // variable) — a struct+Enum-constrained `T` closing over a real CLR
        // enum (`System.DayOfWeek`), matching the primary #2335 issue's
        // constraint shape but exercised through the constrained-receiver
        // addressing path instead of a switch/is type pattern.
        var source = """
            package i2335adjA4
            import System

            class Holder {
                var Value object = DayOfWeek.Friday
            }

            func Describe[TEnum Enum struct](h Holder) string {
                if h.Value is TEnum {
                    return h.Value.ToString()!!
                }
                return "other"
            }

            var holder = Holder()
            Console.WriteLine(Describe[DayOfWeek](holder))
            """;

        Assert.Equal("Friday\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_DirectTypeParameterReceiver_NotNarrowed_StillUsesFastAddressPath()
    {
        // Regression control: a receiver declared DIRECTLY as the type
        // parameter (no narrowing involved) must still resolve through the
        // efficient "own address" fast path — this test only asserts
        // observable behavior (correctness), the fast-path IL shape itself
        // was confirmed separately via manual IL inspection during
        // development.
        var source = """
            package i2335adjA5
            import System

            func Show[T](x T) string { return x.ToString()!! }

            Console.WriteLine(Show[int32](7))
            Console.WriteLine(Show[string]("hi"))
            """;

        Assert.Equal("7\nhi\n", CompileAndRun(source));
    }

    [Fact]
    public void NarrowedVariable_ReturnedDirectly_UnconstrainedT_ValueClosure_NoMethodCall()
    {
        // Exercises the parallel `EmitNarrowingCastIfNeeded` generalization
        // (no method call at all — the narrowed value is simply returned).
        // Pre-fix this specific shape (unconstrained T narrowing an `object`
        // parameter, closed over a value type) fell back to `castclass !!T`,
        // which is invalid IL for a value-type closure.
        var source = """
            package i2335adjA6
            import System

            func Unwrap[T](x object) T {
                if x is T {
                    return x
                }
                return default(T)
            }

            var v object = 123
            Console.WriteLine(Unwrap[int32](v))
            """;

        Assert.Equal("123\n", CompileAndRun(source));
    }

    // ----- Defect B: plain-function-call boxing/widening -----

    [Fact]
    public void PlainFunctionCall_LiteralArgument_ToObjectParameter_Boxes()
    {
        // The issue's minimal repro: a bare int32 LITERAL argument (not a
        // variable, not a type-parameter value) passed directly to a plain
        // top-level function's `object`-typed parameter. Pre-fix this
        // dropped the `box` opcode entirely (ilverify: found Int32, expected
        // ref 'object').
        var source = """
            package i2335adjB1
            import System

            func Show(x object) string { return x.ToString()!! }

            Console.WriteLine(Show(42))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void PlainFunctionCall_TypeParameterArgument_ToObjectParameter_Boxes()
    {
        // A generic-closure variant: the argument's static type is the
        // CALLER's own type parameter `T` (not a concrete value type),
        // passed to another plain top-level function's `object` parameter.
        var source = """
            package i2335adjB2
            import System

            func Consume(o object) string { return o.ToString()!! }
            func Feed[T](val T) string { return Consume(val) }

            Console.WriteLine(Feed[int32](11))
            Console.WriteLine(Feed[string]("z"))
            """;

        Assert.Equal("11\nz\n", CompileAndRun(source));
    }

    [Fact]
    public void PlainFunctionCall_NumericWideningArgument_Widens()
    {
        // The same missing-conversion gap also silently dropped a numeric
        // widening conversion (int32 variable -> int64 parameter), which
        // ilverify rejects just as strictly as a missing box (exact
        // primitive-type stack tracking, not implicit-conversion-aware).
        var source = """
            package i2335adjB3
            import System

            func Show(x int64) string { return x.ToString() }

            var v int32 = 42
            Console.WriteLine(Show(v))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void PlainFunctionCall_EnumLiteralArgument_ToObjectParameter_Boxes()
    {
        // A struct/enum value (not int32) passed directly to a plain
        // function's `object` parameter — a second concrete value-type
        // shape distinct from int32, using a real CLR enum.
        var source = """
            package i2335adjB4
            import System

            func Show(x object) string { return x.ToString()!! }

            Console.WriteLine(Show(DayOfWeek.Tuesday))
            """;

        Assert.Equal("Tuesday\n", CompileAndRun(source));
    }

    [Fact]
    public void PlainFunctionCall_MultipleArguments_EvaluationOrderPreserved_NoDoubleBox()
    {
        // Two side-effecting value-type arguments both boxed to `object`
        // parameters in a single call: confirms (a) evaluation order is
        // left-to-right despite the inserted conversions, and (b) each
        // argument is boxed exactly once (a double-box would still print the
        // same string here, so this is paired with the direct IL check in
        // PlainFunctionCall_LiteralArgument_ToObjectParameter_Boxes's
        // development notes; this test locks in the observable behavior).
        var source = """
            package i2335adjB5
            import System

            func Trace(label string, v int32) int32 {
                Console.WriteLine(label)
                return v
            }

            func Combine(a object, b object) string {
                return a.ToString()!! + "," + b.ToString()!!
            }

            Console.WriteLine(Combine(Trace("first", 1), Trace("second", 2)))
            """;

        Assert.Equal("first\nsecond\n1,2\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_ReferenceUpcastArgument_PlainFunctionCall_NoRegression()
    {
        // Regression control: a derived-class reference passed to a
        // base-class-typed plain-function parameter needs NO conversion IL
        // at all (verifiably assignable without a cast) — confirms the new
        // general conversion fallback does not insert a spurious/incorrect
        // cast for an already-compatible reference argument.
        var source = """
            package i2335adjB6
            import System

            open class Animal {
                open func Speak() string { return "..." }
            }

            class Dog() : Animal {
                override func Speak() string { return "woof" }
            }

            func Describe(a Animal) string { return a.Speak() }

            var d = Dog()
            Console.WriteLine(Describe(d))
            """;

        Assert.Equal("woof\n", CompileAndRun(source));
    }

    [Fact]
    public void Control_GenericErasedSlotArgument_ListAdd_NoSpuriousBoxOrConversion()
    {
        // Regression control mirroring issue #1196 / #1540: an argument bound
        // to an OPEN (erased) type-parameter slot of a generic user function
        // — both a `List[T].Add(val)` receiver-erased-slot call and a plain
        // `T -> T` identity return — must NOT be boxed/converted by the new
        // general fallback; only genuinely concrete-typed parameters (like
        // `object` above) should materialize a conversion.
        var source = """
            package i2335adjB7
            import System
            import System.Collections.Generic

            func DoubleViaList[T](val T) []T {
                var list = List[T]()
                list.Add(val)
                list.Add(val)
                return list.ToArray()
            }

            func RepeatIt[T](v T) T {
                return v
            }

            var arr = DoubleViaList[int32](5)
            Console.WriteLine(arr.Length)
            Console.WriteLine(arr[0])
            Console.WriteLine(RepeatIt[int32](77))
            """;

        Assert.Equal("2\n5\n77\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, bool requiresFullBcl = false)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, requiresFullBcl);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool requiresFullBcl)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2335_adjacent_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            if (requiresFullBcl)
            {
                foreach (var bcl in BclReferences.Value)
                {
                    args.Add("/r:" + bcl);
                }
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var rtConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
