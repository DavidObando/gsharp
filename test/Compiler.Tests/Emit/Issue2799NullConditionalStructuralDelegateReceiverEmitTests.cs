// <copyright file="Issue2799NullConditionalStructuralDelegateReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// PR #2799 follow-up: the null-conditional invocation form <c>f?(args)</c> of a
/// non-nullable <b>structural function</b>-typed receiver
/// (<c>(int32) -&gt; int32</c>) was only guarded in
/// <c>OverloadResolver.Invocations.BuildIndirectDelegateCall</c> when the
/// receiver was the implicit backing field of a field-like event (an
/// <c>ImplicitFieldVariableSymbol</c>). Every other receiver kind reaching that
/// path — a bare static field (<c>ImplicitStaticFieldVariableSymbol</c>), a bare
/// instance/static property (<c>ImplicitPropertyVariableSymbol</c> /
/// <c>ImplicitStaticPropertyVariableSymbol</c>), and a plain local, parameter,
/// or top-level global (<c>LocalVariableSymbol</c> / <c>ParameterSymbol</c> /
/// <c>GlobalVariableSymbol</c>) — fell through to an <b>unguarded</b>
/// <c>BoundIndirectCallExpression</c>, silently dropping the <c>?</c>: the result
/// was bound as the non-optional return type (so <c>r == nil</c> and value-type
/// <c>??</c> misbehaved) and a null receiver NRE-d instead of short-circuiting.
/// <para>
/// The fix generalizes the null-conditional guard across all receiver kinds,
/// evaluating the receiver exactly once and applying the established result-slot
/// lowering (nullable result type, <c>$nres_</c> slot for value-type returns).
/// These tests prove — for a receiver kind whose runtime value can legally be
/// null (an uninitialized function-typed field's CLR default, read through a
/// local copy / property / static member) — that a null receiver short-circuits
/// to the null/optional result and a non-null receiver invokes once, with clean
/// ILVerify, for both value- and void-returning shapes.
/// </para>
/// <para>
/// This branch additionally fixes a distinct, tightly-related pre-existing
/// defect in the <b>nominal</b> CLR-delegate call path
/// (<c>OverloadResolver.CallBinding</c>): it computed its receiver as a bare
/// <c>BoundVariableExpression</c> and never used <c>TryBuildImplicitMemberLoad</c>,
/// so a nominal <c>Func&lt;...&gt;</c> value exposed as a bare static field or
/// instance/static property ICE-d with GS9998 ("no local slot") on <b>any</b>
/// invocation (conditional or not). The receiver-load fix mirrors the structural
/// path, so those nominal member receivers now invoke — and short-circuit under
/// <c>?</c> — correctly.
/// </para>
/// </summary>
public class Issue2799NullConditionalStructuralDelegateReceiverEmitTests
{
    [Fact]
    public void LocalReceiver_NullShortCircuits_NonNullInvokes()
    {
        // Fallthrough (LocalVariableSymbol) path. The local copies an
        // uninitialized function-typed field whose CLR default is null, so the
        // null branch is genuinely runtime-reachable.
        var source = """
            package MyLib
            class C {
                var backing (int32) -> int32
                func SetBacking(fn (int32) -> int32) { backing = fn }
                func Run() int32 {
                    var f (int32) -> int32 = backing
                    var r = f?(5)
                    return r ?? -1
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;

        Assert.Equal(-1, run.Invoke(instance, null));

        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
    }

    [Fact]
    public void ParameterReceiver_HonorsQuestion_AndInvokesNonNull()
    {
        // Fallthrough (ParameterSymbol) path. A non-nullable function parameter
        // cannot be assigned `nil` by language rules (GS0155/GS0129), so its
        // null branch is not reachable via a literal; the `?` is still honored
        // (the result is optional) and a non-null argument invokes once.
        var source = """
            package MyLib
            class C {
                func Run(f (int32) -> int32) int32 {
                    var r = f?(5)
                    return r ?? -1
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;
        var del = MakeDelegate(run.GetParameters()[0].ParameterType, nameof(IntDoubler));

        Assert.Equal(10, run.Invoke(instance, new object[] { del }));
    }

    [Fact]
    public void InstancePropertyReceiver_NullShortCircuits_NonNullInvokes()
    {
        // Implicit-member (ImplicitPropertyVariableSymbol) path via
        // TryBuildImplicitMemberLoad.
        var source = """
            package MyLib
            class C {
                var backing (int32) -> int32
                prop P (int32) -> int32 {
                    get -> this.backing
                }
                func SetBacking(fn (int32) -> int32) { backing = fn }
                func Run() int32 {
                    var r = P?(5)
                    return r ?? -1
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;

        Assert.Equal(-1, run.Invoke(instance, null));

        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
    }

    [Fact]
    public void StaticFieldAndStaticPropertyReceivers_NullShortCircuit_NonNullInvoke()
    {
        // Implicit-member (ImplicitStaticFieldVariableSymbol /
        // ImplicitStaticPropertyVariableSymbol) paths via
        // TryBuildImplicitMemberLoad.
        var source = """
            package MyLib
            class C {
                shared {
                    var sf (int32) -> int32
                    prop SP (int32) -> int32 {
                        get -> C.sf
                    }
                    func SetSf(fn (int32) -> int32) { sf = fn }
                    func RunField() int32 {
                        var r = sf?(5)
                        return r ?? -1
                    }
                    func RunProp() int32 {
                        var r = SP?(5)
                        return r ?? -1
                    }
                }
            }
            """;

        var c = CompileType(source, "C");
        var runField = c.GetMethod("RunField")!;
        var runProp = c.GetMethod("RunProp")!;

        Assert.Equal(-1, runField.Invoke(null, null));
        Assert.Equal(-1, runProp.Invoke(null, null));

        var setSf = c.GetMethod("SetSf")!;
        setSf.Invoke(null, new object[] { MakeDelegate(setSf.GetParameters()[0].ParameterType, nameof(IntDoubler)) });

        Assert.Equal(10, runField.Invoke(null, null));
        Assert.Equal(10, runProp.Invoke(null, null));
    }

    [Fact]
    public void GlobalReceiver_HonorsQuestion_AndInvokesNonNull()
    {
        // Fallthrough (GlobalVariableSymbol) path: a top-level script variable.
        var source = """
            package MyLib
            import System

            func Ident(x int32) int32 { return x }

            var f (int32) -> int32 = Ident
            var r = f?(5)
            Console.WriteLine((r ?? -1).ToString())
            """;

        var output = CompileAndRunExe(source);
        Assert.Equal("5", output.Trim());
    }

    [Fact]
    public void VoidReturn_LocalReceiver_NullNoOps_NonNullInvokes()
    {
        // Void-returning structural delegate through a local whose value is a
        // genuinely-null uninitialized field default: the null branch is a safe
        // no-op (no NRE), the non-null branch invokes exactly once.
        var source = """
            package MyLib
            class C {
                var sink (int32) -> void
                func SetSink(fn (int32) -> void) { sink = fn }
                func Run() {
                    var s (int32) -> void = sink
                    s?(5)
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;

        // Null sink: raising must be a safe no-op.
        Assert.Null(Record.Exception(() => run.Invoke(instance, null)));

        var counter = new SinkCounter();
        var setSink = c.GetMethod("SetSink")!;
        var del = Delegate.CreateDelegate(
            setSink.GetParameters()[0].ParameterType,
            counter,
            typeof(SinkCounter).GetMethod(nameof(SinkCounter.Sink))!);
        setSink.Invoke(instance, new object[] { del });

        run.Invoke(instance, null);
        Assert.Equal(1, counter.Hits);
    }

    [Fact]
    public void SideEffectfulPropertyReceiver_EvaluatedExactlyOnce()
    {
        // The receiver (property getter) must be evaluated exactly once on both
        // the null (short-circuit) and non-null (invoke) paths — single
        // evaluation preserved across the generalized guard.
        var source = """
            package MyLib
            class C {
                var backing (int32) -> int32
                var getCount int32
                prop P (int32) -> int32 {
                    get {
                        getCount = getCount + 1
                        return backing
                    }
                }
                func SetBacking(fn (int32) -> int32) { backing = fn }
                func GetCount() int32 { return getCount }
                func Run() int32 {
                    var r = P?(5)
                    return r ?? -1
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;
        var getCount = c.GetMethod("GetCount")!;

        // Null backing: getter runs once, then short-circuits.
        Assert.Equal(-1, run.Invoke(instance, null));
        Assert.Equal(1, getCount.Invoke(instance, null));

        // Non-null: getter runs once more, then invokes.
        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
        Assert.Equal(2, getCount.Invoke(instance, null));
    }

    [Fact]
    public void BareResult_IsOptional_NullYieldsNil_NonNullYieldsValue()
    {
        // Proves the `?` is honored semantically: without a `??` fallback the
        // result of `f?(5)` is a genuine optional (`int32?`), so `r == nil` is
        // legal and true with a null receiver, false once assigned. Before the
        // fix `r` was bound as non-optional `int32`, and `r == nil` failed to
        // bind (GS0129).
        var source = """
            package MyLib
            class C {
                var backing (int32) -> int32
                func SetBacking(fn (int32) -> int32) { backing = fn }
                func IsNil() bool {
                    var f (int32) -> int32 = backing
                    var r = f?(5)
                    return r == nil
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var isNil = c.GetMethod("IsNil")!;

        Assert.Equal(true, isNil.Invoke(instance, null));

        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));
        Assert.Equal(false, isNil.Invoke(instance, null));
    }

    [Fact]
    public void NominalFuncInstancePropertyReceiver_NullShortCircuits_NonNullInvokes()
    {
        // Distinct pre-existing defect also fixed on this branch: the nominal
        // CLR-delegate call path (OverloadResolver.CallBinding) computed its
        // receiver as a bare BoundVariableExpression and never used
        // TryBuildImplicitMemberLoad, so a nominal `Func<int, int>` value
        // exposed as a bare instance property ICE-d with GS9998 ("no local
        // slot") on ANY invocation. It now short-circuits on null and invokes
        // when non-null.
        var source = """
            package MyLib
            import System
            class C {
                var backing Func[int32,int32]
                prop P Func[int32,int32] {
                    get -> this.backing
                }
                func SetBacking(fn Func[int32,int32]) { backing = fn }
                func Run() int32 {
                    var r = P?(5)
                    return r ?? -1
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        var run = c.GetMethod("Run")!;

        Assert.Equal(-1, run.Invoke(instance, null));

        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
    }

    [Fact]
    public void NominalFuncInstancePropertyReceiver_NonConditional_Invokes()
    {
        // Non-null-conditional invocation `P(5)` of a nominal CLR-delegate
        // instance property previously ICE-d (GS9998); the receiver-load fix
        // makes it a normal invoke.
        var source = """
            package MyLib
            import System
            class C {
                var backing Func[int32,int32]
                prop P Func[int32,int32] {
                    get -> this.backing
                }
                func SetBacking(fn Func[int32,int32]) { backing = fn }
                func Run() int32 {
                    return P(5)
                }
            }
            """;

        var c = CompileType(source, "C");
        var instance = Activator.CreateInstance(c)!;
        SetDelegate(c, instance, "SetBacking", nameof(IntDoubler));

        Assert.Equal(10, c.GetMethod("Run")!.Invoke(instance, null));
    }

    [Fact]
    public void NominalFuncStaticFieldAndPropertyReceivers_NullShortCircuit_NonNullInvoke()
    {
        var source = """
            package MyLib
            import System
            class C {
                shared {
                    var sf Func[int32,int32]
                    prop SP Func[int32,int32] {
                        get -> C.sf
                    }
                    func SetSf(fn Func[int32,int32]) { sf = fn }
                    func RunField() int32 {
                        var r = sf?(5)
                        return r ?? -1
                    }
                    func RunProp() int32 {
                        var r = SP?(5)
                        return r ?? -1
                    }
                }
            }
            """;

        var c = CompileType(source, "C");
        var runField = c.GetMethod("RunField")!;
        var runProp = c.GetMethod("RunProp")!;

        Assert.Equal(-1, runField.Invoke(null, null));
        Assert.Equal(-1, runProp.Invoke(null, null));

        var setSf = c.GetMethod("SetSf")!;
        setSf.Invoke(null, new object[] { MakeDelegate(setSf.GetParameters()[0].ParameterType, nameof(IntDoubler)) });

        Assert.Equal(10, runField.Invoke(null, null));
        Assert.Equal(10, runProp.Invoke(null, null));
    }

    /// <summary>Doubles its argument; bound to <c>(int32) -&gt; int32</c> receivers.</summary>
    public static int IntDoubler(int x) => x * 2;

    private sealed class SinkCounter
    {
        public int Hits { get; private set; }

        public void Sink(int x) => this.Hits++;
    }

    private static void SetDelegate(Type owner, object instance, string setterName, string handlerName)
    {
        var setter = owner.GetMethod(setterName)!;
        var del = MakeDelegate(setter.GetParameters()[0].ParameterType, handlerName);
        setter.Invoke(instance, new object[] { del });
    }

    private static Delegate MakeDelegate(Type delegateType, string handlerName) =>
        Delegate.CreateDelegate(
            delegateType,
            typeof(Issue2799NullConditionalStructuralDelegateReceiverEmitTests).GetMethod(handlerName)!);

    private static Type CompileType(string source, string typeName) =>
        CompileToAssembly(source, "library").GetTypes().Single(t => t.Name == typeName);

    private static string CompileAndRunExe(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2799_exe_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        CompileFile(srcPath, outPath, "exe");
        IlVerifier.Verify(outPath);

        var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir,
        };
        psi.ArgumentList.Add(outPath);
        using var proc = System.Diagnostics.Process.Start(psi)!;
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(proc.ExitCode == 0, $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static Assembly CompileToAssembly(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2799_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        CompileFile(srcPath, outPath, target);
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }

    private static void CompileFile(string srcPath, string outPath, string target)
    {
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
                "/target:" + target,
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
    }
}
