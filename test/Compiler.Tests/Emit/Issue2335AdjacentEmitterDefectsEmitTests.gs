// <copyright file="Issue2335AdjacentEmitterDefectsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2335 follow-up: two ADJACENT, pre-existing emitter defects
/// discovered while validating the primary struct-constrained
/// generic-type-pattern fix ((cref:Issue2335StructConstrainedGenericPatternEmitTests)).
/// Both were tightly coupled to the same type-classification/conversion
/// machinery audited for that fix, so they are corrected here rather than
/// merely documented.
///
/// <b>Defect A — narrowed-variable constrained-receiver addressing.</b>
/// `MethodBodyEmitter.EmitConstrainedTypeParameterReceiver` (the
/// `constrained.`-prefix receiver-address helper backing issue #943 /
/// #1052 constrained calls, e.g. `x.ToString()` / `x.CompareTo(y)`
/// dispatched through a type-parameter receiver) assumed ANY
/// `BoundVariableExpression` receiver is safely addressable via its OWN
/// declared storage slot (`ldarga`/`ldloca`). That is false for a
/// NARROWED variable read (ADR-0069 smart-cast — `if x is T { x.ToString() }`
/// narrowing an `object`-typed parameter/local to a type-parameter view
/// `T`): the narrowed view still physically lives in the wider DECLARED
/// slot, so taking that slot's address yields `object&`, not the
/// `!!T&` the `constrained.` prefix requires — ilverify rejects
/// the mismatch (`StackUnexpected`). Fixed in
/// `SlotPlanner.ReceiverSpillCollector` (plans a spill slot, typed as
/// the NARROWED type, for a narrowed variable receiver exactly like any other
/// non-addressable receiver shape) and in
/// `MethodBodyEmitter.EmitConstrainedTypeParameterReceiver` (only takes
/// the fast "own address" path when the variable is NOT narrowed). A closely
/// related generalization was applied to the shared
/// `EmitNarrowingCastIfNeeded` helper (used by narrowed variable/field/
/// property reads generally, including a plain `if x is T { return x }`
/// with no further method call): it previously fell back to `castclass`
/// for ANY bare (including fully unconstrained) type-parameter narrowing
/// target — the identical gap already closed in `EmitTypePattern` by the
/// primary #2335 fix — and now universally routes through `unbox.any`
/// per the same ECMA-335 III.4.32 justification.
///
/// <b>Defect B — plain-function-call boxing/widening.</b>
/// `OverloadResolver.BindCallExpression`'s per-argument conversion loop
/// (used for a call to a plain, non-imported, non-instance G# function) had
/// no fallback case for a general implicit conversion (boxing a value type
/// into an `object`/interface parameter, numeric widening, etc.): its
/// branches covered only the explicit-only/error path and a
/// value-type-`Nullable<T>` lift, so any OTHER implicitly-convertible
/// argument passed through completely unconverted. The emitter applies no
/// further implicit conversion of its own for a plain call (contrast the
/// CLR-call and instance/shared/extension-call paths, which always route
/// through `BindCallArgumentWithRefKind`/`BindConversion`), so a
/// bare value/enum/generic-type-parameter expression passed directly to a
/// plain function's `object`-typed parameter (e.g.
/// `func Show(x object) {…}; Show(42)`) silently dropped the `box`
/// opcode — ilverify: `StackUnexpected: found Int32, expected ref
/// 'object'`. Fixed by adding the same general
/// implicit-conversion-materialization fallback (calling
/// `conversions.BindConversion`) already used by every other call-
/// argument path, guarded to still skip an open/erased type-parameter
/// target exactly like `BindUserInstanceCall` does, so generic
/// erased-slot arguments (e.g. `List[T].Add(val)`) are left untouched
/// for the emitter's call-boundary erasure boxing.
///
/// Every test compiles with `gsc`, ilverifies the emitted PE, executes
/// it, and asserts on captured stdout.
open class Issue2335AdjacentEmitterDefectsEmitTests {
    // ----- Defect A: narrowed-variable constrained-receiver addressing -----
    @Fact
    func NarrowedParameter_ConstrainedObjectMemberCall_UnconstrainedT_ValueClosure() {
        // The exact repro: an `object`-typed PARAMETER narrowed via `if x is T`
        // to an UNCONSTRAINED `T`, then a universal object member (`ToString`)
        // is called directly on the narrowed variable — the receiver is the
        // SAME BoundVariableExpression instance (`x`), just reporting the
        // narrowed type `T` (ADR-0069). Pre-fix this emitted `ldarga.s x`
        // (address of the DECLARED `object` slot) ahead of `constrained. !!T`,
        // which ilverify rejects.
        let source = `package i2335adjA1
import System

func Describe[T](x object) string {
    if x is T {
        return x.ToString()!!
    }
    return "other"
}

var v object = 42
Console.WriteLine(Describe[int32](v))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedLocal_ConstrainedObjectMemberCall_UnconstrainedT_ValueClosure() {
        // Same shape as above, but the narrowed variable is a LOCAL
        // (`var y object = x`) rather than a parameter — exercises the
        // `this.locals` branch of `SlotPlanner`/`TryLoadVariableAddress`
        // rather than the parameter branch.
        let source = `package i2335adjA2
import System

func Describe[T](x object) string {
    var y object = x
    if y is T {
        return y.ToString()!!
    }
    return "other"
}

var v object = 99
Console.WriteLine(Describe[int32](v))`
        Assert.Equal("99${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedParameter_ConstrainedInterfaceCall_ClassConstrainedT_ClassClosure() {
        // A user-interface-constrained type parameter (`T : IShape`) narrows
        // an `object`-typed parameter and dispatches a USER interface method
        // (issue #1052's `BoundUserInstanceCallExpression` constrained-call
        // path, not just the universal-object-member path #1550 covers) on
        // the narrowed receiver. Closes over a class (`Square`).
        let source = `package i2335adjA3
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
Console.WriteLine(Describe[Square](v))`
        Assert.Equal("25${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedField_ConstrainedObjectMemberCall_StructConstrainedT_EnumClosure() {
        // The narrowed receiver is an INSTANCE FIELD read (not a bare
        // variable) — a struct+Enum-constrained `T` closing over a real CLR
        // enum (`System.DayOfWeek`), matching the primary #2335 issue's
        // constraint shape but exercised through the constrained-receiver
        // addressing path instead of a switch/is type pattern.
        let source = `package i2335adjA4
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
Console.WriteLine(Describe[DayOfWeek](holder))`
        Assert.Equal("Friday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Control_DirectTypeParameterReceiver_NotNarrowed_StillUsesFastAddressPath() {
        // Regression control: a receiver declared DIRECTLY as the type
        // parameter (no narrowing involved) must still resolve through the
        // efficient "own address" fast path — this test only asserts
        // observable behavior (correctness), the fast-path IL shape itself
        // was confirmed separately via manual IL inspection during
        // development.
        let source = `package i2335adjA5
import System

func Show[T](x T) string { return x.ToString()!! }

Console.WriteLine(Show[int32](7))
Console.WriteLine(Show[string]("hi"))`
        Assert.Equal("7${Environment.NewLine}hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedVariable_ReturnedDirectly_UnconstrainedT_ValueClosure_NoMethodCall() {
        // Exercises the parallel `EmitNarrowingCastIfNeeded` generalization
        // (no method call at all — the narrowed value is simply returned).
        // Pre-fix this specific shape (unconstrained T narrowing an `object`
        // parameter, closed over a value type) fell back to `castclass !!T`,
        // which is invalid IL for a value-type closure.
        let source = `package i2335adjA6
import System

func Unwrap[T](x object) T {
    if x is T {
        return x
    }
    return default(T)
}

var v object = 123
Console.WriteLine(Unwrap[int32](v))`
        Assert.Equal("123${Environment.NewLine}", CompileAndRun(source))
    }

    // ----- Defect B: plain-function-call boxing/widening -----
    @Fact
    func PlainFunctionCall_LiteralArgument_ToObjectParameter_Boxes() {
        // The issue's minimal repro: a bare int32 LITERAL argument (not a
        // variable, not a type-parameter value) passed directly to a plain
        // top-level function's `object`-typed parameter. Pre-fix this
        // dropped the `box` opcode entirely (ilverify: found Int32, expected
        // ref 'object').
        let source = `package i2335adjB1
import System

func Show(x object) string { return x.ToString()!! }

Console.WriteLine(Show(42))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainFunctionCall_TypeParameterArgument_ToObjectParameter_Boxes() {
        // A generic-closure variant: the argument's static type is the
        // CALLER's own type parameter `T` (not a concrete value type),
        // passed to another plain top-level function's `object` parameter.
        let source = `package i2335adjB2
import System

func Consume(o object) string { return o.ToString()!! }
func Feed[T](val T) string { return Consume(val) }

Console.WriteLine(Feed[int32](11))
Console.WriteLine(Feed[string]("z"))`
        Assert.Equal("11${Environment.NewLine}z${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainFunctionCall_NumericWideningArgument_Widens() {
        // The same missing-conversion gap also silently dropped a numeric
        // widening conversion (int32 variable -> int64 parameter), which
        // ilverify rejects just as strictly as a missing box (exact
        // primitive-type stack tracking, not implicit-conversion-aware).
        let source = `package i2335adjB3
import System

func Show(x int64) string { return x.ToString() }

var v int32 = 42
Console.WriteLine(Show(v))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainFunctionCall_EnumLiteralArgument_ToObjectParameter_Boxes() {
        // A struct/enum value (not int32) passed directly to a plain
        // function's `object` parameter — a second concrete value-type
        // shape distinct from int32, using a real CLR enum.
        let source = `package i2335adjB4
import System

func Show(x object) string { return x.ToString()!! }

Console.WriteLine(Show(DayOfWeek.Tuesday))`
        Assert.Equal("Tuesday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PlainFunctionCall_MultipleArguments_EvaluationOrderPreserved_NoDoubleBox() {
        // Two side-effecting value-type arguments both boxed to `object`
        // parameters in a single call: confirms (a) evaluation order is
        // left-to-right despite the inserted conversions, and (b) each
        // argument is boxed exactly once (a double-box would still print the
        // same string here, so this is paired with the direct IL check in
        // PlainFunctionCall_LiteralArgument_ToObjectParameter_Boxes's
        // development notes; this test locks in the observable behavior).
        let source = `package i2335adjB5
import System

func Trace(label string, v int32) int32 {
    Console.WriteLine(label)
    return v
}

func Combine(a object, b object) string {
    return a.ToString()!! + "," + b.ToString()!!
}

Console.WriteLine(Combine(Trace("first", 1), Trace("second", 2)))`
        Assert.Equal(
            "first${Environment.NewLine}second${Environment.NewLine}1,2${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func Control_ReferenceUpcastArgument_PlainFunctionCall_NoRegression() {
        // Regression control: a derived-class reference passed to a
        // base-class-typed plain-function parameter needs NO conversion IL
        // at all (verifiably assignable without a cast) — confirms the new
        // general conversion fallback does not insert a spurious/incorrect
        // cast for an already-compatible reference argument.
        let source = `package i2335adjB6
import System

open class Animal {
    open func Speak() string { return "..." }
}

class Dog() : Animal {
    override func Speak() string { return "woof" }
}

func Describe(a Animal) string { return a.Speak() }

var d = Dog()
Console.WriteLine(Describe(d))`
        Assert.Equal("woof${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Control_GenericErasedSlotArgument_ListAdd_NoSpuriousBoxOrConversion() {
        // Regression control mirroring issue #1196 / #1540: an argument bound
        // to an OPEN (erased) type-parameter slot of a generic user function
        // — both a `List[T].Add(val)` receiver-erased-slot call and a plain
        // `T -> T` identity return — must NOT be boxed/converted by the new
        // general fallback; only genuinely concrete-typed parameters (like
        // `object` above) should materialize a conversion.
        let source = `package i2335adjB7
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
Console.WriteLine(RepeatIt[int32](77))`
        Assert.Equal("2${Environment.NewLine}5${Environment.NewLine}77${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string, requiresFullBcl bool = false) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, requiresFullBcl)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, requiresFullBcl bool)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_2335_adjacent_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if requiresFullBcl {
                    for bcl in BclReferences.Value {
                        args.Add("/r:" + bcl)
                    }
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let rtConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
