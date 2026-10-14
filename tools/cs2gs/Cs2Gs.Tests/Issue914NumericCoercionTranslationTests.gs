// <copyright file="Issue914NumericCoercionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Translation tests for the three numeric/guard translator defects discovered
/// migrating `Oahu.Decrypt` (issue #914):
/// (1) numeric coercion to a non-nullable value type must use the
/// conversion-call form `T(x)`, not `(x as T)` (GS0270);
/// (2) numeric promotion must extend to bitwise / null-coalescing / char /
/// compound-assignment operands (GS0129);
/// (3) a negated type-pattern guard (`is not T t`) must keep its binding
/// available after the `if` (GS0157) — since ADR-0166 / issue #3409 as a
/// native pattern variable leaked past `if !(x is T t) { exit }`.
open class Issue914NumericCoercionTranslationTests {
    /// Task 1: coercing a constant operand to a non-nullable value type emits the
    /// conversion-call form `uint8(1)` (not the GS0270-rejected
    /// `(1 as uint8)`).
    @Fact
    func NumericCoercion_NonNullableValueTarget_UsesConversionCallForm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public bool F(byte b) => b > 1;
    }
}`)
        Assert.Contains("uint8(1)", printed)
        Assert.DoesNotContain("as uint8", printed)
    }

    /// Task 1 guard: a nullable value-type target keeps the `as` form, which
    /// G# accepts (`(2 as uint16?)`).
    @Fact
    func NumericCoercion_NullableValueTarget_KeepsAsForm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Entry { public ushort ChannelCount { get; set; } }

    public class C
    {
        public bool IsStereo(Entry? e) => e?.ChannelCount == 2;
    }
}`)
        Assert.Contains("(2 as uint16?)", printed)
    }

    /// Task 2: a bitwise operator over differing numeric operands is promoted, so
    /// the constant operand is retyped via the conversion-call form
    /// (`a & uint32(255)`).
    @Fact
    func BitwiseOperator_DifferingNumericOperands_Promoted() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint B(uint a) => a & 0xFF;
    }
}`)
        Assert.Contains("& uint32(", printed)
        Assert.DoesNotContain("as uint32", printed)
    }

    /// Task 2: null-coalescing over a nullable numeric coerces the right operand
    /// to the left operand's underlying numeric type (`x ?? uint32(0)`).
    @Fact
    func NullCoalescing_NullableNumeric_CoercesRightToUnderlying() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint N(uint? x) => x ?? 0;
    }
}`)
        Assert.Contains("?? uint32(0)", printed)
    }

    /// Task 2: null-coalescing over non-numeric operands is left untouched (no
    /// spurious numeric conversion is inserted).
    @Fact
    func NullCoalescing_NonNumericOperands_NotPerturbed() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public string N(string? a, string b) => a ?? b;
    }
}`)
        Assert.Contains("a ?? b", printed)
    }

    /// Task 2: a char operand participates in promotion; comparing a byte with a
    /// char literal coerces the char to the byte's numeric type
    /// (`b == uint8('A')`).
    @Fact
    func CharOperand_InComparison_Promoted() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public bool Ch(byte b) => b == 'A';
    }
}`)
        Assert.Contains("uint8(", printed)
        Assert.Contains("'A'", printed)
    }

    /// Task 2: a compound numeric assignment with a differing RHS numeric type
    /// coerces the RHS to the LHS type (`total += int64(count)`).
    @Fact
    func CompoundAssignment_DifferingNumericRhs_Coerced() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public long T(int count)
        {
            long total = 0;
            total += count;
            return total;
        }
    }
}`)
        Assert.Contains("total += int64(count)", printed)
    }

    /// Task 3: a negated type-pattern guard (`is not T t`) whose then-branch
    /// always exits. ADR-0166 / issue #3409: it is emitted as the native
    /// `if !(x is T t) { throw }` and the pattern variable `t` is in
    /// scope after the `if` — no hoisted nullable local, no nil-guard.
    @Fact
    func NegatedTypePatternGuard_LeaksNativePatternVariablePastIf() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class TrunBox { public int DoThing() => 1; }

    public class C
    {
        public int G(object box)
        {
            if (box is not TrunBox trun)
            {
                throw new System.InvalidOperationException();
            }

            return trun.DoThing();
        }
    }
}`)
        Assert.Contains("if box is not TrunBox trun {", printed)
        Assert.Contains("return trun.DoThing()", printed)
        Assert.DoesNotContain("as TrunBox", printed)
        Assert.DoesNotContain("== nil", printed)
    }

    /// Task 3: a negated type-pattern guard over a property-path receiver
    /// (`child.Box is not T t`), which G# cannot smart-cast in place.
    /// ADR-0166 / issue #3409: the native pattern variable binds the matched
    /// value itself, so no receiver hoist is needed.
    @Fact
    func NegatedTypePatternGuard_PropertyPathReceiver_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Header { }
    public class TrunBox : Header { public int DoThing() => 1; }
    public class Child { public Header Box { get; set; } }

    public class C
    {
        public int G(Child child)
        {
            if (child.Box is not TrunBox trun)
            {
                return 0;
            }

            return trun.DoThing();
        }
    }
}`)
        Assert.Contains("if child.Box is not TrunBox trun {", printed)
        Assert.Contains("return trun.DoThing()", printed)
        Assert.DoesNotContain("as TrunBox", printed)
        Assert.DoesNotContain("== nil", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// Issue #1232: a shift count of a narrower-order integral (here `byte`,
    /// which C# implicitly widens to `int`) is emitted idiomatically — gsc now
    /// implicitly widens the count to `int32`, so no `int32(count)` wrap
    /// is produced.
    @Fact
    func Shift_NonInt32Count_LeftIdiomatic() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint F(uint value, byte count) => value << count;
    }
}`)
        Assert.Contains("value << count", printed)
        Assert.DoesNotContain("int32(count)", printed)
    }

    /// A shift whose count is already `int32` is left unchanged (no redundant
    /// conversion).
    @Fact
    func Shift_Int32Count_LeftUnchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint F(uint value, int count) => value << count;
    }
}`)
        Assert.Contains("value << count", printed)
        Assert.DoesNotContain("int32(count)", printed)
    }

    /// Issue #1232: a compound shift-assignment `value <<= count` with a
    /// narrower-order count is emitted idiomatically (no count coercion). gsc widens
    /// the count to `int32`; the translator must NOT coerce it to the left
    /// operand's numeric type (which previously produced the GS0129-rejected
    /// `uint32(count)`).
    @Fact
    func CompoundShiftAssignment_NonInt32Count_LeftIdiomatic() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint F(uint value, byte count)
        {
            value <<= count;
            return value;
        }
    }
}`)
        Assert.Contains("value <<= count", printed)
        Assert.DoesNotContain("int32(count)", printed)
        Assert.DoesNotContain("uint32(count)", printed)
    }

    /// Issue #1232: a ternary whose arms are differing numeric primitives where one
    /// arm is an in-range constant literal is emitted idiomatically — gsc now adapts
    /// the literal to the other arm's type, so `b ? 1u : 0` translates to
    /// `if b { 1u } else { 0 }` with no `uint32(0)` cast.
    @Fact
    func Ternary_DivergingNumericArms_LeftIdiomatic() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint F(bool b) => b ? 1u : 0;
    }
}`)
        // The 1u arm already matches the uint32 result type; the int32 literal 0
        // arm must be coerced independently to uint32 so gsc does not reject the
        // conditional with GS0263 (G# has no implicit cross-type numeric promotion
        // and does not adapt an integer literal in a ternary arm to a sibling
        // arm's unsigned type).
        Assert.Contains("if b { 1u } else { uint32(0) }", printed)
    }

    /// When the <em>first</em> arm is the mismatched one, it is the arm that gets
    /// coerced; the already-matching arm is left untouched.
    @Fact
    func Ternary_DivergingNumericArms_CoercesMismatchedTrueArm() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint F(bool b) => b ? 0 : 1u;
    }
}`)
        Assert.Contains("if b { uint32(0) } else { 1u }", printed)
    }

    /// A direct delegate/event `Invoke(...)` is rewritten to G#'s native
    /// invocation form (`d(args)`); G# has no `Delegate.Invoke` member.
    @Fact
    func DelegateInvoke_IdentifierReceiver_RewritesToNativeCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private System.Action<int> handler;
        public void Raise(int x) => handler.Invoke(x);
    }
}`)
        Assert.Contains("handler(x)", printed)
        Assert.DoesNotContain(".Invoke(x)", printed)
    }

    /// A null-conditional delegate invocation with a simple identifier receiver
    /// renders as G#'s `d?(args)` (the parser disambiguates `name?(` as a
    /// null-conditional invoke).
    @Fact
    func NullConditionalInvoke_IdentifierReceiver_RewritesToNullConditionalCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private System.Action<int> handler;
        public void Raise(int x) => handler?.Invoke(x);
    }
}`)
        Assert.Contains("handler?(x)", printed)
        Assert.DoesNotContain(".Invoke(x)", printed)
    }

    /// A null-conditional delegate invocation whose receiver is a call now renders
    /// directly as `GetHandler()?(args)`; gsc parses and single-evaluates the
    /// complete postfix receiver (issue #3356).
    @Fact
    func NullConditionalInvoke_CallReceiver_InvokesDirectlyWithoutSpill() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private System.Action<int> GetHandler() => null;
        public void Raise(int x) => GetHandler()?.Invoke(x);
    }
}`)
        Assert.DoesNotContain(".Invoke", printed)
        Assert.Contains("GetHandler()?(x)", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// Parenthesized and coalescing receivers also stay direct.
    @Fact
    func NullConditionalInvoke_ParenthesizedAndCoalescingReceivers_StayDirect() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Holder
    {
        public System.Action<int> Handler;
    }

    public class C
    {
        private System.Action<int> Left() => null;
        private System.Action<int> Right() => null;
        private System.Action<int>[] Handlers() => new[] { Left() };
        private Holder GetHolder() => new Holder();
        private int Index() => 0;
        public void Raise(int x)
        {
            (Left())?.Invoke(x);
            (Left() ?? Right())?.Invoke(x);
            Handlers()[Index()]?.Invoke(x);
            GetHolder().Handler?.Invoke(x);
        }
    }
}`, "G# currently keeps a nullable result type after coalescing nullable delegates.")
        Assert.Contains("(Left())?(x)", printed)
        Assert.Contains("(Left() ?? Right())?(x)", printed)
        Assert.Contains("Handlers()[Index()]?(x)", printed)
        Assert.Contains("GetHolder().Handler?(x)", printed)
        Assert.DoesNotContain(".Invoke", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    /// Direct output preserves C# receiver/argument evaluation order: receiver once,
    /// argument only when the delegate exists.
    @Fact
    func NullConditionalInvoke_CallReceiver_DirectOutputCompilesAndRunsOnce() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private int receiverCalls;
        private int argumentCalls;
        private int invokeCalls;
        private bool present;

        private int Argument()
        {
            argumentCalls++;
            return 5;
        }

        private Func<int, int>? GetHandler()
        {
            receiverCalls++;
            return present ? value => { invokeCalls++; return value * 2; } : null;
        }

        public int Run()
        {
            int missing = GetHandler()?.Invoke(Argument()) ?? -1;
            present = true;
            int called = GetHandler()?.Invoke(Argument()) ?? -1;
            return missing * 10000 + called * 1000 + receiverCalls * 100 + argumentCalls * 10 + invokeCalls;
        }
    }
}`)
        Assert.Contains("GetHandler()?(Argument())", printed)
        Assert.DoesNotContain("__spill", printed)
        Assert.Equal("211", CompileAndRun(printed, "C().Run()").Trim())
    }

    /// A nullable-enabled local declaration (`Box? t1 = null`) keeps its `?` in the
    /// emitted G# type. The local symbol's flow annotation is honored (not the bare
    /// type-syntax info, which drops `?`), so the binding is `var t1 Box? = nil` and
    /// later `t1 = nil` / `t1 == nil` type-check.
    @Fact
    func NullableLocal_AnnotatedReference_KeepsNullableType() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Box { }
    public class C
    {
        Box Source() => new Box();
        public Box? M(bool flag)
        {
            Box? t1 = null;
            if (flag)
            {
                t1 = Source();
                Use(t1);
            }
            return t1;
        }
        void Use(Box b) { }
    }
}`)
        Assert.Contains("var t1 Box? = nil", printed)
    }

    /// A C# constant `or` pattern on a nullable numeric property uses a
    /// native G# pattern. The pattern binder types its constants against the
    /// subject and evaluates the property once.
    @Fact
    func ConstantOrPattern_NullableNumericPropertyReceiver_UsesNativePattern() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        public byte? Mode { get; set; }
        public bool M() => Mode is 11 or 12 or 13;
    }
}`)
        Assert.Contains("Mode is 11 or 12 or 13", printed)
        Assert.DoesNotContain("Mode ==", printed)
    }

    /// A C# conversion operator with a block body must keep that body when
    /// translated. The body switch in `TranslateBodyCore` previously had no
    /// arm for `ConversionOperatorDeclarationSyntax`, so the operator was
    /// emitted with an empty block (silently dropping the conversion logic, which
    /// also yielded GS0100 "not all code paths return a value").
    @Fact
    func ConversionOperator_BlockBody_IsTranslated() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public readonly struct Meters
    {
        public Meters(int value) { Value = value; }
        public int Value { get; }

        public static implicit operator Meters(int value)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(value);
            return new Meters(value);
        }
    }
}`)
        Assert.Contains("func operator implicit", printed)
        Assert.Contains("ThrowIfNegative", printed)
        Assert.Contains("return Meters", printed)
    }

    /// An argument whose declared numeric type differs from the type C# implicitly
    /// converted it to at the call site (here a `ushort` constant passed where
    /// generic inference selected `int`) must carry that conversion explicitly
    /// when the parameter is GENERIC: gsc applies the implicit widening/constant
    /// narrowing only at a concrete numeric parameter, and an un-coerced operand
    /// defeats CLR generic inference (GS0159). Issue #1281 keeps the wrap for this
    /// generic case while dropping it for concrete-parameter targets.
    @Fact
    func Argument_ImplicitNumericConversion_EmitsExplicitConversion() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public void M(int x)
        {
            ArgumentOutOfRangeException.ThrowIfGreaterThan(x, ushort.MaxValue);
        }
    }
}`)
        Assert.Contains("int32(uint16.MaxValue)", printed)
    }

    shared {
        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.NotNull(compiler)
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3356-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(
                    gsPath,
                    printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
                )
                let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
                Assert.True(
                    compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile translated null-conditional invocation with " +
                        compiler +
                        ". Output:\n" +
                        compileOut +
                        `

Translated G#:
` +
                        printed
                )
                let (runExit, output) = RunDotnet("\"$dllPath\"")
                Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + output)
                return output
            } finally {
                Directory.Delete(workDir, recursive: true)
            }
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(startInfo)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
            for configuration in[]string{"Debug", "Release"} {
                let candidate = Path.Combine(repoRoot, "out", "bin", configuration, "Compiler", "gsc.dll")
                if File.Exists(candidate) {
                    return candidate
                }
            }
            return nil
        }
    }
}
