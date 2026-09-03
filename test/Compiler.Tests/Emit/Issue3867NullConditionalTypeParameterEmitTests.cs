// <copyright file="Issue3867NullConditionalTypeParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3867 — a null-conditional access whose receiver is an OPEN type
/// parameter (<c>func F[T](v T)</c> then <c>v?.M()</c>) probed the receiver with
/// a bare <c>brtrue</c> over the raw <c>!!T</c> stack slot. <c>!!T</c> is not a
/// branchable object reference, so:
/// <list type="bullet">
/// <item>ilverify rejected the body with <c>StackUnexpected</c> (7 of the 19
/// findings in the migrated <c>test/Core.Tests</c>, issue #3863); and</item>
/// <item>at runtime the null probe degenerated into a VALUE test, so
/// <c>F[int32](0)</c> silently took the nil path and produced <c>nil</c>
/// instead of calling the member on <c>0</c>.</item>
/// </list>
/// The receiver is now boxed before the probe, exactly as csc lowers
/// <c>v?.M()</c> (ECMA-335 §III.4.1: boxing an unconstrained type parameter
/// yields <c>null</c> only for an empty <c>Nullable&lt;T&gt;</c>, a real object
/// reference for any other value type, and the reference itself for a reference
/// type).
/// <para>
/// The <c>Nullable&lt;user value type&gt;</c> arm of the same probe already had
/// coverage in <c>Issue1475NullConditionalUserValueTypeEmitTests</c>; these
/// tests pin the open-type-parameter arm. Every test EXECUTES the emitted
/// assembly — ilverify alone would have accepted a body that still answered
/// <c>nil</c> for a zero-valued struct.
/// </para>
/// </summary>
public class Issue3867NullConditionalTypeParameterEmitTests
{
    /// <summary>
    /// The runtime half: a zero-valued <c>int32</c> flowing through
    /// <c>value?.ToString()</c> on an unconstrained <c>T</c> must render
    /// <c>"0"</c>. Before the fix this printed <c>&lt;nil&gt;</c> — a silent
    /// wrong answer that compiled clean.
    /// </summary>
    [Fact]
    public void EndToEnd_UnconstrainedTypeParameter_ZeroValuedStruct_IsNotNil()
    {
        var source = """
            package N3867A
            import System
            class C3867A {
                shared {
                    func Render[T](value T) string {
                        return value?.ToString() ?? "<nil>"
                    }
                }
            }
            func Main() {
                Console.WriteLine(C3867A.Render[int32](0))
                Console.WriteLine(C3867A.Render[int32](7))
                Console.WriteLine(C3867A.Render[string]("hi"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"0{Environment.NewLine}7{Environment.NewLine}hi{Environment.NewLine}",
            output);
    }

    /// <summary>
    /// A user struct type argument whose default instance is all-zero: the same
    /// value test that swallowed <c>int32(0)</c> swallows it too. Also proves
    /// the boxed probe still dispatches through <c>constrained. !!T</c> to the
    /// struct's own <c>ToString</c> rather than boxing away the override.
    /// </summary>
    [Fact]
    public void EndToEnd_UnconstrainedTypeParameter_ZeroValuedUserStruct_IsNotNil()
    {
        var source = """
            package N3867B
            import System
            struct Pt3867B {
                var X int32
                override func ToString() string {
                    return "Pt(" + this.X.ToString() + ")"
                }
            }
            class C3867B {
                shared {
                    func Render[T](value T) string {
                        return value?.ToString() ?? "<nil>"
                    }
                }
            }
            func Main() {
                Console.WriteLine(C3867B.Render[Pt3867B](Pt3867B{X: 0}))
                Console.WriteLine(C3867B.Render[Pt3867B](Pt3867B{X: 5}))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"Pt(0){Environment.NewLine}Pt(5){Environment.NewLine}",
            output);
    }

    /// <summary>
    /// Anti-vacuity guard for the two tests above: a REFERENCE type argument
    /// must still take the nil path when the value really is nil. A "box
    /// everything and always branch" fix would pass the tests above and fail
    /// this one.
    /// </summary>
    [Fact]
    public void EndToEnd_UnconstrainedTypeParameter_NilReference_StillTakesNilPath()
    {
        var source = """
            package N3867C
            import System
            class C3867C {
                shared {
                    func Render[T](value T) string {
                        return value?.ToString() ?? "<nil>"
                    }
                }
            }
            func Main() {
                var s string? = nil
                Console.WriteLine(C3867C.Render[string?](s))
                Console.WriteLine(C3867C.Render[string?]("here"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"<nil>{Environment.NewLine}here{Environment.NewLine}",
            output);
    }

    /// <summary>
    /// The instance-member shape the migrated <c>test/Core.Tests</c> handler
    /// fixtures actually use: a generic method on a STRUCT whose body discards
    /// the result of a call taking <c>value?.ToString()</c>. This is the exact
    /// body that produced <c>StackUnexpected</c> on
    /// <c>PrefixedInterpolatedStringHandler::AppendFormatted(!!0)</c>.
    /// </summary>
    [Fact]
    public void EndToEnd_GenericMethodOnStruct_AppendsZeroValuedStruct()
    {
        var source = """
            package N3867D
            import System
            import System.Text
            struct H3867D {
                var builder StringBuilder
                func AppendFormatted[T](value T) {
                    this.builder.Append(value?.ToString())
                }
                override func ToString() string {
                    return this.builder.ToString()
                }
            }
            func Main() {
                var h = H3867D{builder: StringBuilder()}
                h.AppendFormatted[int32](0)
                h.AppendFormatted[string]("x")
                Console.WriteLine(h.ToString())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"0x{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3867_exe_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort temp cleanup; a locked file must not fail the test.
            }
            catch (UnauthorizedAccessException)
            {
                // Best-effort temp cleanup.
            }
        }
    }
}
