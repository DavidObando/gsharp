// <copyright file="Issue1566MemberVsExtensionShadowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1566 — an unqualified, receiver-less call inside a type to a name that
/// ALSO exists as a top-level extension function bound the EXTENSION instead of
/// the type's own in-scope instance/static member, producing a spurious GS0144
/// (wrong arity). Extension functions are flattened into the global function
/// table (issue #1103) so a bare <c>Display(val)</c> resolved to the extension's
/// full parameter list (receiver + args) rather than the enclosing type's member.
/// <para>
/// The fix makes an accessible in-scope member of the enclosing type SHADOW a
/// same-named top-level extension for an unqualified receiver-less call, matching
/// C# (an in-scope member hides an extension method). When the enclosing type
/// exposes no matching member the extension still binds, and explicit-receiver
/// calls (<c>x.Ext(...)</c>) are unaffected.
/// </para>
/// Each test uses a UNIQUE package and user-type names because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed and leaks across tests.
/// </summary>
public class Issue1566MemberVsExtensionShadowEmitTests
{
    [Fact]
    public void EndToEnd_InstanceMember_ShadowsExtension_Repro()
    {
        // The minimal repro from issue #1566: a private 1-arg member and a
        // same-named receiver-clause extension. The unqualified call must bind
        // the member.
        const string source = """
            package i1566instance
            import System

            class WidgetA {
                private func Describe(value bool) string { return "member" }
                func Use(val bool) string { return Describe(val) }
            }

            func (value T) Describe[T](rm int32) string { return "extension" }

            func Main() {
                let w = WidgetA()
                System.Console.WriteLine(w.Use(true))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("member\n", output);
    }

    [Fact]
    public void EndToEnd_InstanceMember_ShadowsExtension_MultipleArities()
    {
        // Member overloading is unaffected: a zero-arg and a two-arg member both
        // shadow the same-named one-arg-plus-receiver extension.
        const string source = """
            package i1566arities
            import System

            class GadgetB {
                private func Combine() string { return "zero" }
                private func Combine(a int32, b int32) string { return "two" }
                func Use() string { return Combine() + "-" + Combine(1, 2) }
            }

            func (value T) Combine[T](rm int32) string { return "ext" }

            func Main() {
                System.Console.WriteLine(GadgetB().Use())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("zero-two\n", output);
    }

    [Fact]
    public void EndToEnd_StaticMember_ShadowsExtension()
    {
        // A `shared` (static) member of the enclosing type also shadows a
        // same-named extension for an unqualified call.
        const string source = """
            package i1566static
            import System

            class RegistryC {
                shared {
                    func Lookup(a int32) string { return "static-member" }
                }
                func Use() string { return Lookup(1) }
            }

            func (value T) Lookup[T](rm int32) string { return "ext" }

            func Main() {
                System.Console.WriteLine(RegistryC().Use())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("static-member\n", output);
    }

    [Fact]
    public void EndToEnd_StructMember_ShadowsExtension()
    {
        // The shadowing rule generalizes to struct receivers.
        const string source = """
            package i1566struct
            import System

            struct PointD {
                var X int32
                func Render() string { return "struct-member" }
            }

            func (value T) Render[T]() string { return "ext" }

            func Main() {
                let p = PointD{X: 1}
                System.Console.WriteLine(p.Render())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("struct-member\n", output);
    }

    [Fact]
    public void EndToEnd_MemberAndExplicitReceiverExtension_Coexist()
    {
        // A member shadows the extension for the unqualified call, but an
        // explicit-receiver call to the SAME name still binds the extension.
        const string source = """
            package i1566coexist
            import System

            class BoxE {
                private func Tag(value bool) string { return "member" }
                func UseSelf(val bool) string { return Tag(val) }
                func UseExt(n int32) string { return n.Tag(0) }
            }

            func (value T) Tag[T](rm int32) string { return "extension" }

            func Main() {
                let b = BoxE()
                System.Console.WriteLine(b.UseSelf(true))
                System.Console.WriteLine(b.UseExt(9))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("member\nextension\n", output);
    }

    [Fact]
    public void EndToEnd_NoMember_ExplicitReceiverExtension_StillBinds()
    {
        // When the enclosing type has NO member of that name the extension is
        // still found via explicit-receiver syntax (control: existing behavior
        // preserved).
        const string source = """
            package i1566nomember
            import System

            class HolderF {
                func Use(val int32) string { return val.Stringify(0) }
            }

            func (value T) Stringify[T](rm int32) string { return "ext-called" }

            func Main() {
                System.Console.WriteLine(HolderF().Use(3))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ext-called\n", output);
    }

    [Fact]
    public void EndToEnd_OahuCase_GenericExtension_MembersAcrossTypes()
    {
        // The real Oahu shape: several types each declare a private member of a
        // name that also exists as a generic (multi-type-parameter) extension.
        // Every enclosing type binds its own member for the unqualified call.
        const string source = """
            package i1566oahu
            import System

            class AlphaG {
                private func ToDisplayString(x int32) string { return "alpha" }
                func Use(x int32) string { return ToDisplayString(x) }
            }

            class BetaG {
                private func ToDisplayString(x int32) string { return "beta" }
                func Use(x int32) string { return ToDisplayString(x) }
            }

            func (value TEnum) ToDisplayString[TEnum, TPunct](rm int32) string { return "ext" }

            func Main() {
                System.Console.WriteLine(AlphaG().Use(1))
                System.Console.WriteLine(BetaG().Use(2))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("alpha\nbeta\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1566_exe_").FullName;
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
