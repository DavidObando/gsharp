// <copyright file="Issue2798NullConditionalValueEventRaiseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2798: the null-conditional raise form <c>Evt?(args)</c> of a
/// field-like event whose delegate <b>returns a value</b> must short-circuit to
/// the correct optional/null result when the backing delegate is null (no
/// subscribers), mirroring C# <c>Evt?.Invoke(args)</c>. PR #2797 (issue #2796)
/// fixed the <c>void</c>-returning raise on both the nominal CLR-delegate path
/// (<c>OverloadResolver.CallBinding</c>) and the structural
/// <see cref="Symbols.FunctionTypeSymbol"/> path
/// (<c>OverloadResolver.Invocations.BuildIndirectDelegateCall</c>), but both
/// guarded only the <c>void</c> result and emitted an unconditional
/// <c>callvirt Invoke</c> for value-returning delegates — NRE-ing on a fresh
/// event with no subscribers.
/// <para>
/// This fix generalizes the established nullable-delegate invocation result-slot
/// lowering (the same lowering <c>TryBindNullableDelegateInvocation</c> uses for
/// nullable delegate properties, issue #2772) to both paths so a null receiver
/// yields <c>null</c>/<c>default</c>, the receiver is evaluated once, and a
/// non-null delegate invokes normally. These tests cover nominal
/// <c>Func&lt;...&gt;</c> and structural function delegates, reference- and
/// value-returning shapes, zero-subscriber / subscribed / unsubscribe-then-call
/// cases, side-effectful argument single-evaluation and short-circuit, natural
/// <c>??</c> fallback consumption (including value-type null coalescing), runtime
/// behavior, metadata, and ILVerify.
/// </para>
/// </summary>
public class Issue2798NullConditionalValueEventRaiseEmitTests
{
    [Fact]
    public void NominalFuncValueReturn_NoSubscribers_YieldsNullFallback()
    {
        // Nominal CLR `Func<int, int>` event, value-returning. With no
        // subscribers the null-conditional raise must produce a null optional
        // whose `?? -1` fallback yields -1 rather than throwing NRE.
        var source = """
            package MyLib
            import System

            class Poll {
                event Ask Func[int32,int32]
                func Run() int32 {
                    var r = Ask?(5)
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Assert.Equal(-1, run.Invoke(instance, null));
    }

    [Fact]
    public void NominalFuncValueReturn_WithSubscriber_InvokesAndReturnsValue()
    {
        var source = """
            package MyLib
            import System

            class Poll {
                event Ask Func[int32,int32]
                func Run() int32 {
                    var r = Ask?(5)
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Subscribe(poll, instance, nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
    }

    [Fact]
    public void StructuralFunctionValueReturn_NoSubscribers_YieldsNullFallback()
    {
        // Structural `(int32) -> int32` event routes through
        // BuildIndirectDelegateCall. The value-returning raise must yield the
        // null fallback with no subscribers.
        var source = """
            package MyLib

            class Poll {
                event Ask (int32) -> int32
                func Run() int32 {
                    var r = Ask?(5)
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Assert.Equal(-1, run.Invoke(instance, null));
    }

    [Fact]
    public void StructuralFunctionValueReturn_WithSubscriber_InvokesAndReturnsValue()
    {
        var source = """
            package MyLib

            class Poll {
                event Ask (int32) -> int32
                func Run() int32 {
                    var r = Ask?(5)
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Subscribe(poll, instance, nameof(IntDoubler));
        Assert.Equal(10, run.Invoke(instance, null));
    }

    [Fact]
    public void NominalFuncReferenceReturn_ZeroSubscriberAndSubscribed_Behaves()
    {
        // Reference-returning shape: the null branch leaves `ldnull` (a valid
        // Nullable<ref>), no value-type result slot involved.
        var source = """
            package MyLib
            import System

            class Poll {
                event Ask Func[string,string]
                func Run() string {
                    var r = Ask?("hi")
                    return r ?? "none"
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Assert.Equal("none", run.Invoke(instance, null));

        Subscribe(poll, instance, nameof(StringShout));
        Assert.Equal("HI", run.Invoke(instance, null));
    }

    [Fact]
    public void StructuralFunctionReferenceReturn_ZeroSubscriberAndSubscribed_Behaves()
    {
        var source = """
            package MyLib

            class Poll {
                event Ask (string) -> string
                func Run() string {
                    var r = Ask?("hi")
                    return r ?? "none"
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;

        Assert.Equal("none", run.Invoke(instance, null));

        Subscribe(poll, instance, nameof(StringShout));
        Assert.Equal("HI", run.Invoke(instance, null));
    }

    [Fact]
    public void ValueReturn_BareResult_IsNilWhenNoSubscribers()
    {
        // Without a `??` fallback the null-conditional result is a genuine
        // optional; `r == nil` must be true with no subscribers and false once
        // a subscriber is attached.
        var source = """
            package MyLib
            import System

            class Poll {
                event Ask Func[int32,int32]
                func IsNil() bool {
                    var r = Ask?(5)
                    return r == nil
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var isNil = poll.GetMethod("IsNil")!;

        Assert.Equal(true, isNil.Invoke(instance, null));

        Subscribe(poll, instance, nameof(IntDoubler));
        Assert.Equal(false, isNil.Invoke(instance, null));
    }

    [Fact]
    public void ValueReturn_UnsubscribeThenCall_YieldsNullFallbackAgain()
    {
        // After the last subscriber is removed the backing delegate is null
        // again, so a subsequent value-returning raise must yield the null
        // fallback rather than NRE (the SettingsBase.OnChange failure mode,
        // value-returning variant).
        var source = """
            package MyLib
            import System

            class Poll {
                event Ask Func[int32,int32]
                func Run() int32 {
                    var r = Ask?(5)
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;
        var ev = poll.GetEvent("Ask")!;
        var handler = Delegate.CreateDelegate(ev.EventHandlerType!, typeof(Issue2798NullConditionalValueEventRaiseEmitTests).GetMethod(nameof(IntDoubler))!);

        ev.AddEventHandler(instance, handler);
        Assert.Equal(10, run.Invoke(instance, null));

        ev.RemoveEventHandler(instance, handler);
        Assert.Equal(-1, run.Invoke(instance, null));
    }

    [Fact]
    public void ValueReturn_SideEffectfulArgument_EvaluatedOnceAndShortCircuits()
    {
        // The raised argument must be evaluated exactly once on the non-null
        // path and not at all when the receiver is null (C# `Evt?.Invoke(arg)`
        // short-circuit). `Bump()` increments an observable counter.
        var source = """
            package MyLib
            import System

            class Poll {
                var counter int32
                event Ask Func[int32,int32]
                func Bump() int32 {
                    counter = counter + 1
                    return counter
                }
                func Count() int32 { return counter }
                func Run() int32 {
                    var r = Ask?(Bump())
                    return r ?? -1
                }
            }
            """;

        var poll = CompilePollType(source, out _);
        var instance = Activator.CreateInstance(poll)!;
        var run = poll.GetMethod("Run")!;
        var count = poll.GetMethod("Count")!;

        // No subscriber: the argument (Bump) must NOT be evaluated.
        Assert.Equal(-1, run.Invoke(instance, null));
        Assert.Equal(0, count.Invoke(instance, null));

        // Subscribed: the argument is evaluated exactly once (counter -> 1),
        // and the doubled result (2) is returned.
        Subscribe(poll, instance, nameof(IntDoubler));
        Assert.Equal(2, run.Invoke(instance, null));
        Assert.Equal(1, count.Invoke(instance, null));
    }

    /// <summary>Doubles its argument; bound to `Func&lt;int, int&gt;` / `(int32) -&gt; int32` events.</summary>
    public static int IntDoubler(int x) => x * 2;

    /// <summary>Uppercases its argument; bound to `Func&lt;string, string&gt;` / `(string) -&gt; string` events.</summary>
    public static string StringShout(string s) => s.ToUpperInvariant();

    private static void Subscribe(Type pollType, object instance, string handlerMethodName)
    {
        var ev = pollType.GetEvent("Ask")!;
        var handler = Delegate.CreateDelegate(
            ev.EventHandlerType!,
            typeof(Issue2798NullConditionalValueEventRaiseEmitTests).GetMethod(handlerMethodName)!);
        ev.AddEventHandler(instance, handler);
    }

    private static Type CompilePollType(string source, out Assembly assembly)
    {
        assembly = CompileToAssembly(source);
        return assembly.GetTypes().Single(t => t.Name == "Poll");
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2798_emit_").FullName;
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
