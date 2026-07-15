// <copyright file="Issue2363EmptyDataTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2363 / ADR-0029 amendment: a zero-field <c>data class</c>/<c>data
/// struct</c> — needed to translate a C# <c>record Name();</c> or an empty
/// positional <c>record struct Name();</c> — previously failed to bind at
/// all (<c>GS0104</c>, unconditionally rejecting any <c>IsData</c>
/// declaration with zero fields). These tests exercise the full emit-level
/// contract for the degenerate zero-field case: <c>ToString()</c> renders a
/// fixed <c>"Name()"</c> literal, <c>GetHashCode()</c> is a stable
/// (non-process-randomized) constant derived from the type name,
/// <c>Equals</c>/<c>==</c>/<c>!=</c> are trivially true for two instances of
/// the same concrete type, <c>Deconstruct</c> is correctly ABSENT from the
/// emitted metadata (nothing to deconstruct — see ADR-0029 Decision item 6),
/// <c>with</c>/<c>copy()</c> still allocate a genuinely new (reference-
/// distinct) instance, and the row-count planner keeps every MethodDef row
/// correctly aligned (implicitly exercised by <see cref="IlVerifier.Verify"/>
/// in every test below). The final test reproduces the exact Oahu
/// <c>CallbackChallenge</c>/<c>MfaChallenge</c>/<c>CvfChallenge</c>/
/// <c>ApprovalChallenge</c>/<c>CaptchaChallenge</c>/<c>ExternalLoginChallenge</c>
/// hierarchy (<c>Oahu.Cli.App/Auth/CallbackBroker.cs</c>) end to end.
/// </summary>
public class Issue2363EmptyDataTypesEmitTests
{
    [Fact]
    public void DataClass_ZeroFields_NoParens_CompilesAndVerifies()
    {
        var source = """
            package MyLib

            open data class Empty {
            }
            """;

        var assembly = CompileToAssembly(source);
        var empty = assembly.GetTypes().Single(t => t.Name == "Empty");
        Assert.True(empty.IsClass);
    }

    [Fact]
    public void DataStruct_ZeroFields_NoParens_CompilesAndVerifies()
    {
        var source = """
            package MyLib

            data struct Empty {
            }
            """;

        var assembly = CompileToAssembly(source);
        var empty = assembly.GetTypes().Single(t => t.Name == "Empty");
        Assert.True(empty.IsValueType);
    }

    [Fact]
    public void DataClass_ZeroFields_Deconstruct_IsAbsentFromMetadata()
    {
        var source = """
            package MyLib

            data class Empty() {
            }
            """;

        var assembly = CompileToAssembly(source);
        var empty = assembly.GetTypes().Single(t => t.Name == "Empty");

        Assert.Null(empty.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance));
    }

    [Fact]
    public void DataStruct_ZeroFields_Deconstruct_IsAbsentFromMetadata()
    {
        var source = """
            package MyLib

            data struct Empty() {
            }
            """;

        var assembly = CompileToAssembly(source);
        var empty = assembly.GetTypes().Single(t => t.Name == "Empty");

        Assert.Null(empty.GetMethod("Deconstruct", BindingFlags.Public | BindingFlags.Instance));
    }

    [Fact]
    public void DataClass_ZeroFields_ToString_RendersFixedNameWithEmptyParens()
    {
        var output = CompileAndRun("""
            package MyLib
            import System

            data class Empty() {
            }

            func Main() {
                let e = Empty()
                Console.WriteLine(e.ToString())
                Console.WriteLine(e)
            }
            """);

        Assert.Equal("Empty()\nEmpty()\n", output);
    }

    [Fact]
    public void DataStruct_ZeroFields_ToString_RendersFixedNameWithEmptyParens()
    {
        var output = CompileAndRun("""
            package MyLib
            import System

            data struct Empty() {
            }

            func Main() {
                let e = Empty{}
                Console.WriteLine(e.ToString())
            }
            """);

        Assert.Equal("Empty()\n", output);
    }

    [Fact]
    public void DataClass_ZeroFields_GetHashCode_IsStableAndDiffersByTypeName()
    {
        var output = CompileAndRun("""
            package MyLib
            import System

            data class Foo() {
            }
            data class Bar() {
            }

            func Main() {
                let a = Foo()
                let b = Foo()
                let c = Bar()
                Console.WriteLine(a.GetHashCode() == b.GetHashCode())
                Console.WriteLine(a.GetHashCode() == c.GetHashCode())
            }
            """);

        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void DataClass_ZeroFields_EqualsAndOperators_AreTrivialWithinSameConcreteType()
    {
        var output = CompileAndRun("""
            package MyLib
            import System

            data class Empty() {
            }

            func Main() {
                let a = Empty()
                let b = Empty()
                Console.WriteLine(a == b)
                Console.WriteLine(a != b)
                Console.WriteLine(a.Equals(b))
                let ob Object = b
                Console.WriteLine(a.Equals(ob))
            }
            """);

        Assert.Equal("True\nFalse\nTrue\nTrue\n", output);
    }

    [Fact]
    public void DataStruct_ZeroFields_EqualsAndOperators_AreTrivial()
    {
        var output = CompileAndRun("""
            package MyLib
            import System

            data struct Empty() {
            }

            func Main() {
                let a = Empty{}
                let b = Empty{}
                Console.WriteLine(a == b)
                Console.WriteLine(a != b)
                Console.WriteLine(a.Equals(b))
            }
            """);

        Assert.Equal("True\nFalse\nTrue\n", output);
    }

    [Fact]
    public void DataClass_ZeroFields_CopyAndWith_ProduceValueEqualInstance()
    {
        // `copy()`/`with { }` on a zero-field type have nothing to
        // override, but must still parse/bind/emit and produce a
        // value-equal result (reference-distinctness for `with`/`copy` is a
        // general, pre-existing data-class invariant exercised for
        // nonzero-field types elsewhere, e.g. Issue2228DataClassWithEmitTests;
        // not re-verified here since G# surface syntax has no
        // `ReferenceEquals`/identity-comparison builtin to observe it
        // directly).
        var output = CompileAndRun("""
            package MyLib
            import System

            data class Empty() {
            }

            func Main() {
                let a = Empty()
                let b = a.copy()
                let c = a with { }
                Console.WriteLine(a == b)
                Console.WriteLine(a == c)
            }
            """);

        Assert.Equal("True\nTrue\n", output);
    }

    [Fact]
    public void DataClass_ZeroFields_SiblingTypesUnderOpenBase_AreNotEqual()
    {
        // Leaf-type-only equality is a pre-existing, deliberate limitation
        // (matches C# record semantics): two sibling zero-field data
        // classes derived from a common open base are never equal to one
        // another, even though each is trivially self-equal.
        var output = CompileAndRun("""
            package MyLib
            import System

            open data class Base() {
            }
            data class Mfa() : Base() {
            }
            data class Cvf() : Base() {
            }

            func Main() {
                let mfa = Mfa()
                let cvf Base = Cvf()
                Console.WriteLine(mfa.Equals(cvf))
                Console.WriteLine(mfa.GetType() == cvf.GetType())
            }
            """);

        Assert.Equal("False\nFalse\n", output);
    }

    [Fact]
    public void DataClass_ZeroFields_WithPropertyOverride_MatchesOahuMfaChallengeShape()
    {
        // Minimal shape matching Oahu.Cli.App/Auth/CallbackBroker.cs's
        // MfaChallenge()/CvfChallenge()/ApprovalChallenge(): a zero-field
        // sealed data class overriding an abstract-shaped base property. The
        // BackingField-null filter fix in DataStructSynthesizer.GetSynthesisFields
        // is what makes this compile+run without an ArgumentNullException in
        // field-token resolution.
        var output = CompileAndRun("""
            package Oahu.Cli.App.Auth
            import System

            open data class CallbackChallenge {
                open prop Kind string {
                    get -> "base"
                }
            }
            data class MfaChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "mfa"
                }
            }
            data class CvfChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "cvf"
                }
            }
            data class ApprovalChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "approval"
                }
            }

            func Main() {
                let mfa CallbackChallenge = MfaChallenge()
                let cvf CallbackChallenge = CvfChallenge()
                let approval CallbackChallenge = ApprovalChallenge()
                Console.WriteLine(mfa.Kind)
                Console.WriteLine(cvf.Kind)
                Console.WriteLine(approval.Kind)
                Console.WriteLine(mfa.ToString())
            }
            """);

        Assert.Equal("mfa\ncvf\napproval\nMfaChallenge()\n", output);
    }

    [Fact]
    public void DataClass_ExactOahuCallbackChallengeHierarchy_Shape_Compiles_Runs_And_Verifies()
    {
        // Verbatim shape of Oahu.Cli.App/Auth/CallbackBroker.cs: an open
        // base record with only a computed `Kind` property, three ZERO-FIELD
        // derived sealed records (MfaChallenge, CvfChallenge,
        // ApprovalChallenge — the #2363 scenario) plus two NON-zero-field
        // sibling records (CaptchaChallenge, ExternalLoginChallenge) that
        // must be unaffected.
        var output = CompileAndRun("""
            package Oahu.Cli.App.Auth
            import System

            open data class CallbackChallenge {
                open prop Kind string {
                    get -> "unknown"
                }
            }

            data class CaptchaChallenge(ImageBytes int32) : CallbackChallenge {
                override prop Kind string {
                    get -> "captcha"
                }
            }

            data class MfaChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "mfa"
                }
            }

            data class CvfChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "cvf"
                }
            }

            data class ApprovalChallenge() : CallbackChallenge {
                override prop Kind string {
                    get -> "approval"
                }
            }

            data class ExternalLoginChallenge(LoginUri string) : CallbackChallenge {
                override prop Kind string {
                    get -> "external-login"
                }
            }

            func Main() {
                let captcha CallbackChallenge = CaptchaChallenge(7)
                let mfa CallbackChallenge = MfaChallenge()
                let cvf CallbackChallenge = CvfChallenge()
                let approval CallbackChallenge = ApprovalChallenge()
                let externalLogin CallbackChallenge = ExternalLoginChallenge("https://example.test")

                Console.WriteLine(captcha.Kind + ": " + captcha.ToString())
                Console.WriteLine(mfa.Kind + ": " + mfa.ToString())
                Console.WriteLine(cvf.Kind + ": " + cvf.ToString())
                Console.WriteLine(approval.Kind + ": " + approval.ToString())
                Console.WriteLine(externalLogin.Kind + ": " + externalLogin.ToString())
            }
            """);

        Assert.Equal(
            "captcha: CaptchaChallenge(ImageBytes=7)\n" +
            "mfa: MfaChallenge()\n" +
            "cvf: CvfChallenge()\n" +
            "approval: ApprovalChallenge()\n" +
            "external-login: ExternalLoginChallenge(LoginUri=https://example.test)\n",
            output);
    }

    // ====================================================================
    // Helpers
    // ====================================================================

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2363_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2363_synth_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
