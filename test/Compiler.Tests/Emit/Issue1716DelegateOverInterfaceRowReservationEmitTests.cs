// <copyright file="Issue1716DelegateOverInterfaceRowReservationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1716: a compilation declaring a user interface alongside a named
/// <c>delegate</c> type failed to emit with <c>error GS9998:
/// InvalidOperationException: Delegate '…' .ctor MethodDef row N did not
/// match the reserved row M</c>.
///
/// <para>Root cause: MethodDef rows are RESERVED (during row planning) in the
/// order interface abstract/default methods, then delegate <c>.ctor</c>/
/// <c>Invoke</c>, then class/struct members. But the rows were actually
/// EMITTED (via <c>AddMethodDefinition</c>) in a different order —
/// <c>EmitDelegateTypeDef</c> adds its ctor/Invoke MethodDefs eagerly during
/// the TypeDef-emission pass, while interface method bodies were deferred to
/// a later pass shared with classes/structs. So whenever a compilation had at
/// least one interface member, the delegate's eager rows landed first in the
/// metadata even though they were reserved second, producing a mismatched
/// (and invalid) MethodDef row / TypeDef.methodList pointer.</para>
///
/// <para>Fix: emit interface method bodies (<c>EmitInterfaceMethodBodies</c>)
/// immediately after interface TypeDefs and BEFORE delegate TypeDefs are
/// emitted, so the actual <c>AddMethodDefinition</c> call order matches the
/// reserved row plan for every interface + delegate combination, not just a
/// single hard-coded shape. Each test below uses a UNIQUE package/type name
/// because the in-process <c>FunctionTypeSymbol</c> cache is name-keyed.</para>
/// </summary>
public class Issue1716DelegateOverInterfaceRowReservationEmitTests
{
    [Fact]
    public void EndToEnd_InterfaceAndNamedDelegate_Coexist_Runs()
    {
        const string source = """
            package i1716basic
            import System

            interface IGreeter1716 {
                func Greet() string;
            }

            class Greeter1716 : IGreeter1716 {
                func Greet() string { return "hi-1716" }
            }

            type StringFn1716 = delegate func() string

            func Main() {
                var g IGreeter1716 = Greeter1716()
                var d StringFn1716 = g.Greet
                System.Console.WriteLine(d.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi-1716\n", output);
    }

    [Fact]
    public void EndToEnd_MultipleInterfacesAndDelegates_Interleaved_Runs()
    {
        // Generalization check: several interfaces (with default-body AND
        // abstract methods, properties, events) and several named delegates
        // in one compilation. This exercises the full MethodDef row plan
        // (interfaces first, then all delegate ctor/Invoke pairs, then
        // classes) so the fix isn't specific to "one interface, one delegate".
        const string source = """
            package i1716multi
            import System

            interface IFirst1716 {
                func FirstOp() int32;
                func FirstDefault() int32 { return 100 }
            }

            interface ISecond1716 {
                func SecondOp() int32;
            }

            class Impl1716 : IFirst1716, ISecond1716 {
                func FirstOp() int32 { return 1 }
                func SecondOp() int32 { return 2 }
            }

            type IntFn1716 = delegate func() int32
            type IntFn1716B = delegate func() int32

            func Main() {
                var f IFirst1716 = Impl1716()
                var s ISecond1716 = Impl1716()
                var d1 IntFn1716 = f.FirstOp
                var d2 IntFn1716B = s.SecondOp
                var d3 IntFn1716 = f.FirstDefault
                System.Console.WriteLine(d1.Invoke() + d2.Invoke() + d3.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("103\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceBodyConstructsPrimaryCtorStruct_Runs()
    {
        // Latent hazard #1 flagged in PR #1796 review: same root cause as the
        // class ctor regression (ClassCtorHandles / ClassPrimaryCtorHandles
        // populated too late for interface bodies to see), but for a VALUE
        // TYPE. A data struct's primary-ctor handle is registered inside
        // EmitDataStructSynthesizedMembers, called from EmitStructMethodBodies
        // — which still runs AFTER EmitInterfaceMethodBodies. An interface
        // `shared func` that `newobj`s a primary-ctor struct should still
        // resolve the ctor handle.
        const string source = """
            package i1716struct
            import System

            inline struct Box1716(N int32) { }

            interface IBoxFactory1716 {
                shared {
                    func Make(n int32) Box1716 {
                        return Box1716(n)
                    }
                }
            }

            func Main() {
                let b = IBoxFactory1716.Make(42)
                System.Console.WriteLine(b.N)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_InterfaceBodyConstructsNamedDelegate_Runs()
    {
        // Latent hazard #2 flagged in PR #1796 review: DelegateCtorHandles is
        // populated inside EmitDelegateTypeDef, which still runs AFTER
        // EmitInterfaceMethodBodies. An interface body performing a
        // method-group -> named-delegate conversion should still resolve the
        // delegate's .ctor MethodDef.
        // The method-group source is another `shared` method on the SAME
        // interface, emitted earlier in interface-body emission order — a
        // top-level `func` source would additionally hit the (out-of-scope,
        // unrelated) fact that top-level function MethodDef handles aren't
        // registered until phase B4, later still than interface bodies.
        const string source = """
            package i1716del
            import System

            type IntFn1716D = delegate func(n int32) int32

            interface IConverter1716 {
                shared {
                    func Double1716D(n int32) int32 { return n * 2 }
                    func GetDoubler() IntFn1716D {
                        var d IntFn1716D = IConverter1716.Double1716D
                        return d
                    }
                }
            }

            func Main() {
                let fn = IConverter1716.GetDoubler()
                System.Console.WriteLine(fn.Invoke(21))
            }
            """;

        // Issue #755's static-virtual interface members are always emitted
        // Virtual|NewSlot (even the sole implementation), so ldftn on one for
        // delegate creation trips ilverify's non-final-virtual check — a
        // known, already-tracked ilverify gap for this feature (see
        // IlVerifier.KnownIssues.StaticVirtualInterface for the sibling
        // CallAbstract/Constrained codes); the CLR JIT accepts and dispatches
        // the IL correctly, confirmed by the successful run below.
        var output = CompileAndRun(
            source,
            ignoredIlVerifyErrorCodes: new[] { "LdftnNonFinalVirtual" });
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source, IEnumerable<string> ignoredIlVerifyErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1716mg_exe_").FullName;
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

            IlVerifier.Verify(dllPath, ignoredErrorCodes: ignoredIlVerifyErrorCodes);

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
