// <copyright file="Issue1962SwitchExprFollowUpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Follow-ups from issue #1962 (PR #1961 / #1890 review) on bare-type
/// switch-expression arms.
///
/// (1) GS0176: a C# switch expression can be exhaustive purely by its TYPE
/// (and `null`) arms — with no `_`/`var` catch-all at all — cases Roslyn
/// itself proves exhaustive (e.g. `int? x switch { int =>, null => }`,
/// since `HasValue` is a closed true/false domain). gsc's own exhaustiveness
/// check has no equivalent proof for type-pattern arms, so the translated
/// arm set trips GS0176 unless a synthesized `default:` arm is added.
///
/// (2) A `null` arm ahead of a type arm (`object? x switch { null => ..,
/// int => .., _ => .. }`) must keep that order in the emitted G#, and
/// the type arm's `_ is int32` test must not accidentally match `null`.
///
/// (3) A bare-type arm over a nullable VALUE type (`int? x switch { int
/// => .. }`) must match only when `HasValue`, mirroring Roslyn's `HasValue`
/// narrowing — verified here by actually compiling and running the emitted
/// G# (gsc's `box`+`isinst` emit strategy for `Nullable<T>` gives this
/// for free per ECMA-335's special `Nullable<T>` boxing rule; see
/// `MethodBodyEmitter.Patterns.EmitTypePattern`).
open class Issue1962SwitchExprFollowUpTests {
    /// `int? x switch { int =>, null => }` has no `_`/`var` catch-all,
    /// but Roslyn proves it exhaustive (HasValue true/false is a closed
    /// domain) — so C# accepts it with no CS8509. The translated G# arms
    /// (`case _ is int32:` / `case nil:`) carry no unguarded discard, which
    /// would trip gsc's GS0176 without the synthesized `default:` arm.
    /// @remarks Structural-only: actually compiling this shape currently hits an
    /// unrelated, pre-existing gsc binder bug — `case nil:` against a
    /// value-type-`Nullable` discriminant (`int32?`) crashes emit with
    /// GS9998 (`PatternBinder.BindConstantPattern` builds the nil-arm's
    /// `BoundConversionExpression` directly instead of through
    /// `ConversionClassifier`'s issue-#504 nil→Nullable-value-type
    /// lowering, so `EmitConversion` never sees the required
    /// `BoundDefaultExpression`). Reproduces with plain hand-written G#,
    /// independent of cs2gs; filed as gsc issue #2072. The runtime
    /// (`HasValue`) semantics for a bare-type arm over a nullable value type
    /// are instead verified end-to-end by
    /// (cref:SwitchExpression_BareTypeArmOverNullableValueType_MatchesOnlyWhenHasValue),
    /// which uses a discard rather than an explicit `null` arm and so never
    /// touches the buggy path.
    @Fact
    func SwitchExpression_ExhaustiveByNullableValueTypeArmsAlone_SynthesizesDefaultArm() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int? x) => x switch
        {
            int => "has value",
            null => "none",
        };
    }
}`)
        Assert.Contains("case _ is int32:", printed, StringComparison.Ordinal)
        Assert.Contains("case nil:", printed, StringComparison.Ordinal)
        Assert.Contains("default: throw", printed, StringComparison.Ordinal)
    }

    /// Item #1962(3): a bare-type arm over a nullable VALUE type (`int? x
    /// switch { int => .. }`) must match only when `HasValue` — Roslyn's
    /// own narrowing rule. Compiled and run end-to-end (avoiding the `case
    /// nil:` gsc bug noted above by using a discard for the null case
    /// instead of an explicit `null` arm).
    @Fact
    func SwitchExpression_BareTypeArmOverNullableValueType_MatchesOnlyWhenHasValue() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int? x) => x switch
        {
            int => "has value",
            _ => "none",
        };
    }
}`)
        Assert.Contains("case _ is int32:", printed, StringComparison.Ordinal)
        Assert.Contains("default:", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("default: throw", printed, StringComparison.Ordinal)
        Assert.Equal("has value", CompileAndRun(printed, "C.Describe(5)").Trim())
        Assert.Equal("none", CompileAndRun(printed, "C.Describe(nil)").Trim())
    }

    /// `bool flag switch { true =>, false => }` is Roslyn-exhaustive
    /// with no discard — same GS0176 gap, but via plain constant patterns
    /// rather than a type pattern (pre-existing, not introduced by #1890,
    /// but the same fix generalizes to it).
    @Fact
    func SwitchExpression_ExhaustiveByBooleanConstantArmsAlone_SynthesizesDefaultArm() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(bool flag) => flag switch
        {
            true => "yes",
            false => "no",
        };
    }
}`)
        Assert.Contains("default: throw", printed, StringComparison.Ordinal)
        Assert.Equal("yes", CompileAndRun(printed, "C.Describe(true)").Trim())
        Assert.Equal("no", CompileAndRun(printed, "C.Describe(false)").Trim())
    }

    /// A guarded discard (`case _ when …`) never satisfies exhaustiveness
    /// (GS0176: "a guarded discard … does not act as a total/default arm"),
    /// so a switch expression whose only catch-all is guarded must still get
    /// a synthesized `default:` arm.
    @Fact
    func SwitchExpression_OnlyCatchAllIsGuarded_StillSynthesizesDefaultArm() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(int n) => n switch
        {
            _ when n > 0 => "positive",
            _ => "other",
        };
    }
}`, "cs2gs currently drops guards from discard switch arms, leaving duplicate default arms in this shape test.")
        // The source's own unguarded `_ =>` already covers the total case —
        // no synthesized arm should be added on top of it.
        Assert.DoesNotContain("default: throw", printed, StringComparison.Ordinal)
    }

    /// `object? x switch { null => .., int => .., _ => .. }`: the
    /// `null` arm must stay ahead of the type arm in the emitted G#, and the
    /// type arm's `_ is int32` test must reject `null` (never accidentally
    /// matching it) and reject a non-`int` value, falling through to the
    /// discard.
    @Fact
    func SwitchExpression_NullArmPrecedesTypeArm_RejectsNullAndNonMatchingType() {
        let printed = TranslateAndValidate(`
using System;

namespace Demo
{
    public sealed class C
    {
        public static string Describe(object? x) => x switch
        {
            null => "none",
            int => "int",
            _ => "other",
        };
    }
}`)
        Assert.True(
            printed.IndexOf("case nil:", StringComparison.Ordinal) < printed.IndexOf(
                "case _ is int32:",
                StringComparison.Ordinal
            ),
            "the `null` arm must precede the type arm in emit order:\n" + printed
        )
        Assert.Equal("int", CompileAndRun(printed, "C.Describe(5)").Trim())
        Assert.Equal("none", CompileAndRun(printed, "C.Describe(nil)").Trim())
        Assert.Equal("other", CompileAndRun(printed, "C.Describe(\"hi\")").Trim())
    }

    shared {
        private func TranslateAndValidate(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
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

        /// Compiles [`printed`](paramref) (with [`callExpression`](paramref)
        /// appended, wrapped in a `Console.WriteLine`, as a top-level entry
        /// statement) with the real `gsc` — proving gsc itself accepts the
        /// synthesized arm (no GS0176) — and runs it, returning stdout.
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-1962-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(
                gsPath,
                printed + Environment.NewLine + "Console.WriteLine($callExpression)" + Environment.NewLine
            )
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout)
            return stdout
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
