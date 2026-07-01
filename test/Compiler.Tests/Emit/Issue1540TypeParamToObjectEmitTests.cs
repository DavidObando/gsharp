// <copyright file="Issue1540TypeParamToObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1540 — a generic type-parameter value <c>T</c> converting to a GENUINE
/// <c>object</c> slot (return, assignment, explicit cast, argument) was rejected
/// with <c>GS0155 'Cannot convert type T to object'</c>. Converting <c>T</c> to
/// <c>object</c> is always valid: a boxing conversion for a value <c>T</c>, a
/// reference conversion for a reference <c>T</c>, and <c>box !!T</c> (verifier
/// correct for both) for an unconstrained <c>T</c>.
/// <para>
/// The delicate part is that an ERASED open generic parameter slot (e.g. the
/// <c>!0</c> element type of <c>List[T].Add(!0)</c>, compiled inside the generic
/// method that declares <c>T</c>) presents as <c>System.Object</c> at the raw CLR
/// signature level, so a blanket <c>T -&gt; object</c> boxing rule reintroduced the
/// #1196 regression (a spurious <c>box T</c> before the call → invalid IL). The
/// fix classifies <c>T -&gt; object</c> as an implicit conversion but recovers the
/// real type-parameter slot for erased-<c>!0</c> arguments in
/// <c>ConversionClassifier.BindClrParameterConversions</c> — for both erased
/// RECEIVER slots (<c>List[T].Add</c>) and erased METHOD-level slots
/// (<c>Enumerable.Repeat[T]</c>) — so such arguments stay <c>T -&gt; T</c> identity
/// (no box) while genuine <c>object</c> targets box.
/// </para>
/// Every test round-trips through compile → <c>IlVerifier.Verify</c> → run, so any
/// spurious box or missing box surfaces as invalid IL. The final two tests are
/// #1196 controls proving a <c>List[T].Add</c> / <c>Dictionary[K,V].Add</c>
/// argument still passes straight through with NO box. Each uses a UNIQUE
/// package/type name.
/// </summary>
public class Issue1540TypeParamToObjectEmitTests
{
    [Fact]
    public void ValueTypeParam_ImplicitReturn_Boxes_Roundtrips()
    {
        const string source = """
            package i1540valimplicit
            import System

            class Ext {
                shared {
                    func Box[T](val T) object { return val }
                    func Back[T](o object) T { return T(o) }
                }
            }

            func Main() {
                let o = Ext.Box[int32](42)
                let back = Ext.Back[int32](o)
                System.Console.WriteLine(o)
                System.Console.WriteLine(back)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n42\n", output);
    }

    [Fact]
    public void ValueTypeParam_ExplicitCast_Boxes()
    {
        const string source = """
            package i1540valexplicit
            import System

            class Ext {
                shared {
                    func Box[T](val T) object { return object(val) }
                }
            }

            func Main() { System.Console.WriteLine(Ext.Box[int32](7)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void ValueTypeParam_LocalAssignment_Boxes()
    {
        const string source = """
            package i1540valassign
            import System

            class Ext {
                shared {
                    func Box[T](val T) object {
                        let o object = val
                        return o
                    }
                }
            }

            func Main() { System.Console.WriteLine(Ext.Box[int32](9)) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("9\n", output);
    }

    [Fact]
    public void ReferenceTypeParam_ImplicitReturn_ReferenceConversion()
    {
        const string source = """
            package i1540refimplicit
            import System

            class Ext {
                shared {
                    func Box[T](val T) object { return val }
                    func Back[T](o object) T { return T(o) }
                }
            }

            func Main() {
                let o = Ext.Box[string]("hello")
                let back = Ext.Back[string](o)
                System.Console.WriteLine(o)
                System.Console.WriteLine(back)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\nhello\n", output);
    }

    [Fact]
    public void TypeParam_PassedToObjectParameter_Boxes()
    {
        const string source = """
            package i1540objparam
            import System

            class Ext {
                shared {
                    func Consume(o object) string { return o.ToString() ?? "" }
                    func Feed[T](val T) string { return Ext.Consume(val) }
                }
            }

            func Main() {
                System.Console.WriteLine(Ext.Feed[int32](11))
                System.Console.WriteLine(Ext.Feed[string]("z"))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\nz\n", output);
    }

    [Fact]
    public void ClassConstrainedTypeParam_Boxes()
    {
        const string source = """
            package i1540classconstraint
            import System

            class Ext {
                shared {
                    func Box[T class](val T) object { return val }
                }
            }

            func Main() { System.Console.WriteLine(Ext.Box[string]("cc")) }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("cc\n", output);
    }

    [Fact]
    public void StructConstrainedTypeParam_Boxes_Roundtrips()
    {
        const string source = """
            package i1540structconstraint
            import System

            class Ext {
                shared {
                    func Box[T struct](val T) object { return object(val) }
                    func Back[T struct](o object) T { return T(o) }
                }
            }

            func Main() {
                let o = Ext.Box[int32](33)
                System.Console.WriteLine(o)
                System.Console.WriteLine(Ext.Back[int32](o))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("33\n33\n", output);
    }

    [Fact]
    public void Control_ListTAdd_ErasedSlot_NoSpuriousBox()
    {
        // #1196 regression control: `T` fed into the erased `!0` element slot of
        // `List[T].Add(!0)` (compiled inside the generic method that declares
        // `T`) must remain a NO-OP identity conversion with NO `box T`. A
        // spurious box makes ilverify report `[found ref 'T'][expected value
        // 'T']` and the program throws InvalidProgramException. This coexists in
        // ONE compilation with a genuine `T -> object` boxing method to prove the
        // two paths stay independent after the #1540 change.
        const string source = """
            package i1540listcontrol
            import System
            import System.Collections.Generic

            class Ext {
                shared {
                    func Box[T](val T) object { return val }
                    func DoubleViaList[T](val T) []T {
                        var list = List[T]()
                        list.Add(val)
                        list.Add(val)
                        return list.ToArray()
                    }
                }
            }

            func Main() {
                var arr = Ext.DoubleViaList[int32](5)
                System.Console.WriteLine(arr.Length)
                System.Console.WriteLine(arr[0])
                System.Console.WriteLine(Ext.Box[int32](5))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n5\n5\n", output);
    }

    [Fact]
    public void Control_DictionaryAdd_ErasedSlots_NoSpuriousBox()
    {
        // #1196 regression control across TWO erased slots: both `K` and `V` are
        // fed into the erased `!0`/`!1` parameter slots of
        // `Dictionary[K,V].Add(!0, !1)`. Neither may emit a spurious box; the
        // count read-back proves the entry was stored.
        const string source = """
            package i1540dictcontrol
            import System
            import System.Collections.Generic

            class Ext {
                shared {
                    func Store[K comparable, V any](k K, v V) int32 {
                        var d = Dictionary[K, V]()
                        d.Add(k, v)
                        return d.Count
                    }
                }
            }

            func Main() {
                System.Console.WriteLine(Ext.Store[int32, string](1, "a"))
                System.Console.WriteLine(Ext.Store[string, int32]("k", 7))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n1\n", output);
    }

    [Fact]
    public void Control_StaticGenericMethodArg_ErasedMethodSlot_NoSpuriousBox()
    {
        // #1196 regression control for an erased METHOD-level type-parameter slot
        // (distinct from the receiver-slot controls above). `Enumerable.Repeat[T]`
        // has element parameter `TSource`, which closes over the enclosing open
        // `T`; at the raw CLR signature level that slot presents as `System.Object`.
        // The #1540 `T -> object` implicit rule must NOT box the `v T` argument
        // here — the classifier recovers the real `T` slot from the method's own
        // type arguments, keeping the argument `T -> T` identity. A spurious box
        // would produce `[found ref 'T'][expected value 'T']` invalid IL.
        const string source = """
            package i1540staticgenmethod
            import System
            import System.Linq
            import System.Collections.Generic

            func RepeatVal[T](v T, n int32) IEnumerable[T] {
                return Enumerable.Repeat[T](v, n)
            }

            func Main() {
                for x in RepeatVal[int32](42, 3) {
                    System.Console.WriteLine(x)
                }
                for s in RepeatVal[string]("a", 2) {
                    System.Console.WriteLine(s)
                }
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n42\n42\na\na\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1540_exe_").FullName;
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
