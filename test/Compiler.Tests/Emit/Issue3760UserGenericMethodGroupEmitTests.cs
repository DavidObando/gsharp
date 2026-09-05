// <copyright file="Issue3760UserGenericMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3760: a <em>user-declared</em> generic function could not accept a
/// method group in a delegate-typed parameter.
/// <para>
/// Two distinct defects sat on the same path, and both are covered here:
/// </para>
/// <list type="number">
///   <item>Inference — a method group carries no type of its own, so the
///   positional inference pass contributed nothing from an
///   <c>f Func[int32, TOut]</c> slot and <c>TOut</c> (reachable only through
///   the group's return type) never received a bound: GS0151. The
///   imported-call binder already ran a deferred method-group inference step
///   (<c>ClrOverloadResolution.TryInferMethodGroupArgument</c>); the
///   user-generic path had no equivalent — the #3705 "inconsistent sibling
///   probe" class.</item>
///   <item>Conversion — the argument-conversion loop skipped the
///   method-group-to-delegate branch whenever the <em>declared</em> parameter
///   type mentioned a type parameter, which for a generic callee is always.
///   Even a call site that had already pinned the type argument (explicitly,
///   or from another argument) left the group unresolved and Error-typed, and
///   it reached the emitter as <c>GS9998</c> — an internal compiler error on
///   valid user code.</item>
/// </list>
/// <para>
/// Every positive case is compiled, IL-verified and RUN, asserting stdout: a
/// method group that binds to the wrong overload — or to the right one over
/// the wrong instantiation — compiles clean and only misbehaves at runtime.
/// </para>
/// </summary>
public class Issue3760UserGenericMethodGroupEmitTests
{
    private const string Preamble = """
        package P
        import System

        class Helper {
            shared {
                func ToText(value int32) string { return value.ToString() }
                func Twice(value int32) int32 { return value * 2 }
                func Emit(value int32) { Console.WriteLine("emit" + value.ToString()) }
                func Show(value int32) string { return "i" + value.ToString() }
                func Show(value string) int32 { return value.Length }
            }
        }

        class Box {
            var Tag string = "box"

            func Decorate(value int32) string { return Tag + value.ToString() }

            func Map[TOut](value int32, f Func[int32, TOut]) TOut { return f(value) }
        }

        func Map[TOut](value int32, f Func[int32, TOut]) TOut { return f(value) }
        func RunG[TIn](value TIn, a Action[TIn]) { a(value) }
        func RunOnly[TIn](a Action[TIn]) { }

        """;

    /// <summary>
    /// Issue #3766: a type parameter reachable only through a single-candidate
    /// method group's parameter positions is inferred from that candidate.
    /// </summary>
    [Fact]
    public void FreeGenericFunction_InfersTIn_FromSingleCandidateMethodGroup()
    {
        string output = CompileAndRun(Preamble + """
            RunOnly(Helper.Emit)
            """);

        Assert.Equal(string.Empty, output);
    }

    /// <summary>
    /// The issue's headline repro (free function, inferred type argument).
    /// Reported GS0151 on origin/main.
    /// </summary>
    [Fact]
    public void FreeGenericFunction_InfersTOut_FromUserMethodGroup()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Map(5, Helper.ToText))
            """);

        // "5" — not "10": the STRING-returning overload of the two `Helper`
        // one-argument int32 members had to win the slot.
        Assert.Equal($"5{Environment.NewLine}", output);
    }

    /// <summary>
    /// A non-string <c>TOut</c>, so the assertion cannot pass by accident on a
    /// group that erased to <c>object</c> and round-tripped through
    /// <c>ToString</c>.
    /// </summary>
    [Fact]
    public void FreeGenericFunction_InfersNonStringTOut_FromUserMethodGroup()
    {
        string output = CompileAndRun(Preamble + """
            let doubled = Map(5, Helper.Twice)
            Console.WriteLine(doubled + 1)
            """);

        // `doubled` is int32, so `+ 1` is arithmetic (11), not concatenation
        // ("101") — proving TOut inferred as int32 and not string/object.
        Assert.Equal($"11{Environment.NewLine}", output);
    }

    /// <summary>
    /// The GS9998 half: an explicit type argument closed the parameter, and
    /// the conversion branch still refused the group because the DECLARED
    /// parameter type mentioned <c>TOut</c>. The unresolved group reached code
    /// emission as an internal compiler error.
    /// </summary>
    [Fact]
    public void ExplicitTypeArgument_MethodGroup_NoLongerReachesTheEmitterUnresolved()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Map[string](7, Helper.ToText))
            """);

        Assert.Equal($"7{Environment.NewLine}", output);
    }

    /// <summary>
    /// The same crash reached through successful inference rather than an
    /// explicit type argument: <c>TIn</c> is pinned by the first argument, so
    /// inference never failed — only the conversion did. This case is the
    /// clearest proof the two defects are independent.
    /// </summary>
    [Fact]
    public void TypeParameterInDelegateInputPosition_MethodGroup_Runs()
    {
        string output = CompileAndRun(Preamble + """
            RunG(13, Helper.Emit)
            """);

        Assert.Equal($"emit13{Environment.NewLine}", output);
    }

    /// <summary>
    /// The issue's second repro: a generic INSTANCE member of a user class.
    /// That call binds through a different site
    /// (<c>OverloadResolver.Invocations</c>), which needed the same
    /// method-group inference step.
    /// </summary>
    [Fact]
    public void GenericInstanceMember_InfersTOut_FromUserMethodGroup()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Box().Map(9, Helper.ToText))
            """);

        Assert.Equal($"9{Environment.NewLine}", output);
    }

    /// <summary>
    /// An INSTANCE method group as the argument: the emitted delegate must
    /// carry the receiver, so the assertion reads a value only the bound
    /// instance's field can produce.
    /// <para>
    /// ANTI-VACUITY GUARD RAIL — this one already passed on origin/main. A
    /// single-candidate instance group (<c>b.Decorate</c>) binds with a
    /// resolved function type, so the positional pass could unify it; only
    /// the shapes that reach the binder still unresolved were broken. Kept
    /// so a regression on the working half is caught too.
    /// </para>
    /// </summary>
    [Fact]
    public void InstanceMethodGroupArgument_KeepsItsReceiver()
    {
        string output = CompileAndRun(Preamble + """
            let b = Box()
            b.Tag = "tag"
            Console.WriteLine(Map(3, b.Decorate))
            """);

        Assert.Equal($"tag3{Environment.NewLine}", output);
    }

    /// <summary>
    /// An overloaded group is picked by the delegate's CLOSED input type, and
    /// the winner's return type is what <c>TOut</c> binds to. `Show` has an
    /// <c>(int32) string</c> and a <c>(string) int32</c> overload, so a
    /// mis-picked candidate produces a different value AND a different type.
    /// </summary>
    [Fact]
    public void OverloadedMethodGroup_ResolvedByTheClosedDelegateInput()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Map(4, Helper.Show))
            """);

        // "i4" from `Show(int32) string`, not "1" from `Show(string) int32`.
        Assert.Equal($"i4{Environment.NewLine}", output);
    }

    /// <summary>
    /// The imported (CLR) sibling of the group above: <c>Convert.ToString</c>
    /// is a large imported overload set that must resolve against the closed
    /// <c>int32</c> input and contribute <c>string</c> as <c>TOut</c>.
    /// </summary>
    [Fact]
    public void ImportedMethodGroup_InfersTOut_ForAUserGenericFunction()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Map(11, Convert.ToString) + "!")
            """);

        // The `+ "!"` is string concatenation, so TOut really is `string`.
        Assert.Equal($"11!{Environment.NewLine}", output);
    }

    /// <summary>
    /// ANTI-VACUITY GUARD RAIL — passes on origin/main too. A lambda in the
    /// same slot always inferred; if this ever fails, the fix broke the
    /// working control rather than the reverse.
    /// </summary>
    [Fact]
    public void GuardRail_LambdaInTheSameSlot_StillInfers()
    {
        string output = CompileAndRun(Preamble + """
            Console.WriteLine(Map(5, func(v int32) string { return v.ToString() }))
            """);

        Assert.Equal($"5{Environment.NewLine}", output);
    }

    /// <summary>
    /// ANTI-VACUITY GUARD RAIL — passes on origin/main too. A NON-generic user
    /// function always accepted a method group; the guard that broke the
    /// generic case never applied here.
    /// </summary>
    [Fact]
    public void GuardRail_NonGenericFunction_StillAcceptsAMethodGroup()
    {
        string output = CompileAndRun(Preamble + """
            func MapS(value int32, f Func[int32, string]) string { return f(value) }

            Console.WriteLine(MapS(5, Helper.ToText))
            """);

        Assert.Equal($"5{Environment.NewLine}", output);
    }

    /// <summary>
    /// The new inference step is a RETRY on the failure path only, and it must
    /// stay a diagnostic — never a crash — when the group genuinely cannot be
    /// resolved. Here both overloads have the target arity and the delegate's
    /// INPUT type is itself unbound, so choosing either candidate would be
    /// unsound: GS0151 stands, and no GS9998 follows it.
    /// <para>
    /// ANTI-VACUITY GUARD RAIL — this also passed on origin/main; it pins that
    /// the retry did not turn an honest diagnostic into a crash or a wrong
    /// binding.
    /// </para>
    /// </summary>
    [Fact]
    public void UnresolvableMethodGroup_StillReportsTheInferenceDiagnostic()
    {
        (int exitCode, string output) = Compile(Preamble + """
            func Both[TIn, TOut](f Func[TIn, TOut]) TOut { return f(default) }

            Console.WriteLine(Both(Helper.Show))
            """);

        Assert.True(exitCode != 0, "expected the un-inferable call to be rejected:\n" + output);
        Assert.Contains("GS0151", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
    }

    private static (int ExitCode, string Output) Compile(string source)
    {
        string tempDir = Directory.CreateTempSubdirectory("gs_issue3760_").FullName;
        try
        {
            return CompileTo(source, tempDir, out _);
        }
        finally
        {
            TryDelete(tempDir);
        }
    }

    private static string CompileAndRun(string source)
    {
        string tempDir = Directory.CreateTempSubdirectory("gs_issue3760_").FullName;
        try
        {
            (int compileExit, string compileOutput) = CompileTo(source, tempDir, out string outPath);
            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOutput}");

            // #3712 landed a bug that compiled clean on main and was caught
            // only here, so verification is not optional for this family.
            IlVerifier.Verify(outPath);

            string runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add(outPath);

            using Process proc = Process.Start(psi)
                ?? throw new InvalidOperationException("failed to start dotnet exec");
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            TryDelete(tempDir);
        }
    }

    private static (int ExitCode, string Output) CompileTo(string source, string tempDir, out string outPath)
    {
        string srcPath = Path.Combine(tempDir, "test.gs");
        outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        TextWriter prevOut = Console.Out;
        TextWriter prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            int exitCode = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
            return (exitCode, compileOut.ToString() + compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
