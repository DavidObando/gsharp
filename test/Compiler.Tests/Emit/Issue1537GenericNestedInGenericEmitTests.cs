// <copyright file="Issue1537GenericNestedInGenericEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1537 — a <b>generic</b> type nested inside a <b>generic</b> type
/// (<c>struct Middle[T any]</c> inside <c>struct Outer[U any]</c>) constructed
/// externally through the per-segment type-clause syntax
/// (<c>Outer[int32].Middle[string]</c>) failed at BIND time with
/// <c>GS0159 Cannot find function</c> and, once bound, could not be emitted
/// verifiably. This is the follow-up to issue #1521, which only covered a
/// NON-generic nested type of a generic (<c>Box[T].Tag</c>).
/// <para>
/// The fix threads a COMBINED type-argument vector — the enclosing
/// construction's arguments first, then the nested type's own arguments — from
/// both the binder (member lookup substitutes enclosing <c>U</c> and own
/// <c>T</c>) and the emitter (the nested <c>TypeDef</c> is reified over the
/// flattened <c>[U, T]</c> parameter list per ECMA-335 §II.10.3.1, so
/// <c>Middle</c> emits as <c>Outer`1+Middle`2</c>). Both the constructed
/// external use site (<c>&lt;int32, string&gt;</c>) and the open self/internal
/// reference (<c>&lt;!0, !1&gt;</c>) encode with the correct combined vector,
/// generalised to arbitrary nesting depth and arity.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed and not cleared between tests.
/// </summary>
public class Issue1537GenericNestedInGenericEmitTests
{
    [Fact]
    public void EndToEnd_BaseRepro_GenericNestedInGeneric_VerifiesAndRuns()
    {
        // The exact issue repro: external construction of a generic nested type
        // of a generic via `Outer[int32].Middle[string]`, then a member call on
        // the result. Before the fix member lookup failed with GS0159.
        const string source = """
            package Issue1537BaseRepro
            import System

            struct Issue1537Outer[U any] {
                struct Issue1537Middle[T any] {
                    var Label string
                    func Hello() string { return "hi" }
                }
            }

            func Main() {
                var m = Issue1537Outer[int32].Issue1537Middle[string]{Label: "x"}
                System.Console.WriteLine(m.Hello())
                System.Console.WriteLine(m.Label)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\nx\n", output);
    }

    [Fact]
    public void EndToEnd_MultiArityAtEachLevel_VerifiesAndRuns()
    {
        // Generalization: multi-parameter arity at BOTH levels
        // (`Outer`2+Middle`4<int32, bool, string, int64>`). The combined vector
        // must be [A, B, C, D] with the enclosing pair on the low ordinals.
        const string source = """
            package Issue1537MultiArity
            import System

            struct Issue1537OuterMA[A any, B any] {
                struct Issue1537MiddleMA[C any, D any] {
                    var Tag string
                    func Ping() string { return "ma" }
                }
            }

            func Main() {
                var m = Issue1537OuterMA[int32, bool].Issue1537MiddleMA[string, int64]{Tag: "z"}
                System.Console.WriteLine(m.Ping())
                System.Console.WriteLine(m.Tag)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ma\nz\n", output);
    }

    [Fact]
    public void EndToEnd_NestedMemberUsesOuterTypeParameter_VerifiesAndRuns()
    {
        // Generalization: the nested type has a field AND a method mentioning
        // the ENCLOSING type parameter `U`. On the constructed context these
        // must surface `U` as `int32` in the field signature, the field-access
        // token, and the method's return signature.
        const string source = """
            package Issue1537OuterTypeParam
            import System

            struct Issue1537OuterUP[U any] {
                struct Issue1537MiddleUP[T any] {
                    var OwnT T
                    var FromU U
                    func Combine() U { return FromU }
                }
            }

            func Main() {
                var m = Issue1537OuterUP[int32].Issue1537MiddleUP[string]{OwnT: "s", FromU: 42}
                System.Console.WriteLine(m.OwnT)
                System.Console.WriteLine(m.Combine())
                System.Console.WriteLine(m.FromU)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("s\n42\n42\n", output);
    }

    [Fact]
    public void EndToEnd_TripleNesting_NonGenericInnermost_VerifiesAndRuns()
    {
        // Generalization: three levels of nesting where the innermost is
        // non-generic (`Outer[int32].Middle[string].Inner`). The Inner TypeDef
        // is reified over the flattened `[U, T]` enclosing list.
        const string source = """
            package Issue1537TripleNonGen
            import System

            struct Issue1537OuterTNG[U any] {
                struct Issue1537MiddleTNG[T any] {
                    struct Issue1537InnerTNG {
                        var Note string
                        func Speak() string { return "tng" }
                    }
                }
            }

            func Main() {
                var i = Issue1537OuterTNG[int32].Issue1537MiddleTNG[string].Issue1537InnerTNG{Note: "n"}
                System.Console.WriteLine(i.Speak())
                System.Console.WriteLine(i.Note)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("tng\nn\n", output);
    }

    [Fact]
    public void EndToEnd_TripleNesting_GenericInnermost_VerifiesAndRuns()
    {
        // Generalization: three levels of nesting where the innermost is ALSO
        // generic (`Outer[int32].Middle[string].Inner[bool]`). Inner is reified
        // over the flattened `[U, T, W]` list — arity 3.
        const string source = """
            package Issue1537TripleGen
            import System

            struct Issue1537OuterTG[U any] {
                struct Issue1537MiddleTG[T any] {
                    struct Issue1537InnerTG[W any] {
                        var Note string
                        func Speak() string { return "tg" }
                    }
                }
            }

            func Main() {
                var i = Issue1537OuterTG[int32].Issue1537MiddleTG[string].Issue1537InnerTG[bool]{Note: "n"}
                System.Console.WriteLine(i.Speak())
                System.Console.WriteLine(i.Note)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("tg\nn\n", output);
    }

    [Fact]
    public void EndToEnd_NestedTypeAsFieldParamReturnLocal_VerifiesAndRuns()
    {
        // Generalization: the generic-nested-in-generic type used as a
        // top-level function PARAMETER, RETURN, and LOCAL, plus a member access
        // on each — every signature/slot position that risks a `<!0, !1>`
        // encoding in a constructed context.
        const string source = """
            package Issue1537FieldParam
            import System

            struct Issue1537OuterFP[U any] {
                struct Issue1537MiddleFP[T any] {
                    var Label string
                    func Tag() string { return "fp" }
                }
            }

            func Issue1537Grab(m Issue1537OuterFP[int32].Issue1537MiddleFP[string]) string {
                var local Issue1537OuterFP[int32].Issue1537MiddleFP[string] = m
                return local.Label
            }

            func Issue1537Make() Issue1537OuterFP[int32].Issue1537MiddleFP[string] {
                return Issue1537OuterFP[int32].Issue1537MiddleFP[string]{Label: "r"}
            }

            func Main() {
                var m = Issue1537Make()
                System.Console.WriteLine(m.Tag())
                System.Console.WriteLine(Issue1537Grab(m))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("fp\nr\n", output);
    }

    [Fact]
    public void EndToEnd_InternalConstructionControlB_StillVerifiesAndRuns()
    {
        // Control B: a generic nested type of a generic constructed from WITHIN
        // the enclosing generic's own member (open, `<!0, !1>` context). This
        // worked before the fix and must keep working after the nested type is
        // reified to arity 2.
        const string source = """
            package Issue1537ControlB
            import System

            struct Issue1537OuterCB[U any] {
                struct Issue1537MiddleCB[T any] {
                    var Label string
                    func Hello() string { return "hi" }
                }
                func Make() string {
                    var m = Issue1537MiddleCB[string]{Label: "y"}
                    return m.Hello()
                }
            }

            func Main() {
                var o = Issue1537OuterCB[int32]{}
                System.Console.WriteLine(o.Make())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    [Fact]
    public void EndToEnd_NonGenericOuterControlA_StillVerifiesAndRuns()
    {
        // Control A: a generic nested type of a NON-generic outer
        // (`Outer.Middle[string]`). Enclosing arity is 0, so the nested type is
        // NOT reified — this must stay unaffected by the #1537 changes.
        const string source = """
            package Issue1537ControlA
            import System

            struct Issue1537OuterCA {
                struct Issue1537MiddleCA[T any] {
                    var Label string
                    func Hello() string { return "hi" }
                }
            }

            func Main() {
                var m = Issue1537OuterCA.Issue1537MiddleCA[string]{Label: "x"}
                System.Console.WriteLine(m.Hello())
                System.Console.WriteLine(m.Label)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\nx\n", output);
    }

    [Fact]
    public void EndToEnd_Issue1521NonOwnParamsGuard_StillVerifiesAndRuns()
    {
        // Guard: the #1521 case (a NON-generic nested type of a generic,
        // `Box[int32].Tag`) must keep binding, verifying and running — the
        // #1537 combined-vector threading must not regress the enclosing-only
        // path.
        const string source = """
            package Issue1537Box1521Guard
            import System

            struct Issue1537BoxGuard[T any] {
                var Value T
                struct TagGuard { var Name string }
                func MakeTag() TagGuard { return TagGuard{Name: "guard"} }
            }

            func Issue1537GrabGuard(t Issue1537BoxGuard[int32].TagGuard) string { return t.Name }

            func Main() {
                var b = Issue1537BoxGuard[int32]{Value: 5}
                System.Console.WriteLine(b.MakeTag().Name)
                var t Issue1537BoxGuard[int32].TagGuard = b.MakeTag()
                System.Console.WriteLine(Issue1537GrabGuard(t))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("guard\nguard\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1537_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
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
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
