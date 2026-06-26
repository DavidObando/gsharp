// <copyright file="Issue1213EventInvokeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1213: an <c>event</c> member declared on a class must be referenceable
/// in expression position (bare and <c>this.</c>-qualified) inside the declaring
/// type so the canonical raise pattern <c>MyEvent?.Invoke(args)</c> binds and
/// emits. Inside the type an event read resolves to its private backing delegate
/// field; the null-conditional invoke lowers to a null-check plus a delegate
/// <c>Invoke</c>. These tests prove the emitted IL verifies and runs: a null
/// backing field makes the raise a safe no-op, and a subscribed handler is
/// invoked with the raised arguments.
/// </summary>
public class Issue1213EventInvokeEmitTests
{
    [Fact]
    public void BareEventRaise_NullBackingField_IsSafeNoOp()
    {
        var source = """
            package MyLib

            class Counter {
                event Bumped (int32) -> void
                func Raise(n int32) { Bumped?.Invoke(n) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType)!;

        // No handler subscribed: the backing delegate field is null, so raising
        // must be a no-op rather than throwing a NullReferenceException.
        var raise = counterType.GetMethod("Raise")!;
        var ex = Record.Exception(() => raise.Invoke(instance, new object[] { 5 }));
        Assert.Null(ex);
    }

    [Fact]
    public void BareEventRaise_WithHandler_InvokesHandler()
    {
        var source = """
            package MyLib

            class Counter {
                event Bumped (int32) -> void
                func Raise(n int32) { Bumped?.Invoke(n) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType)!;

        int total = 0;
        var ev = counterType.GetEvent("Bumped")!;
        Action<int> handler = n => total += n;
        ev.AddEventHandler(instance, handler);

        counterType.GetMethod("Raise")!.Invoke(instance, new object[] { 7 });
        Assert.Equal(7, total);
    }

    [Fact]
    public void QualifiedEventRaise_WithHandler_InvokesHandler()
    {
        var source = """
            package MyLib

            class Counter {
                event Bumped (int32) -> void
                func RaiseQualified(n int32) { this.Bumped?.Invoke(n) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType)!;

        int total = 0;
        var ev = counterType.GetEvent("Bumped")!;
        Action<int> handler = n => total += n;
        ev.AddEventHandler(instance, handler);

        counterType.GetMethod("RaiseQualified")!.Invoke(instance, new object[] { 3 });
        Assert.Equal(3, total);
    }

    [Fact]
    public void EventNilCheck_ReflectsSubscriptionState()
    {
        var source = """
            package MyLib

            class Counter {
                event Bumped (int32) -> void
                func HasSub() bool { return Bumped != nil }
            }
            """;

        var assembly = CompileToAssembly(source);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType)!;
        var hasSub = counterType.GetMethod("HasSub")!;

        Assert.False((bool)hasSub.Invoke(instance, null)!);

        var ev = counterType.GetEvent("Bumped")!;
        Action<int> handler = _ => { };
        ev.AddEventHandler(instance, handler);

        Assert.True((bool)hasSub.Invoke(instance, null)!);
    }

    [Fact]
    public void MultiArgVoidEventRaise_PassesAllArguments()
    {
        var source = """
            package MyLib

            class Emitter {
                event Notify (int32, string) -> void
                func Fire(n int32, s string) { Notify?.Invoke(n, s) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var emitterType = assembly.GetTypes().Single(t => t.Name == "Emitter");
        var instance = Activator.CreateInstance(emitterType)!;

        int seenInt = 0;
        string seenStr = null;
        var ev = emitterType.GetEvent("Notify")!;
        Action<int, string> handler = (n, s) =>
        {
            seenInt = n;
            seenStr = s;
        };
        ev.AddEventHandler(instance, handler);

        emitterType.GetMethod("Fire")!.Invoke(instance, new object[] { 42, "hi" });
        Assert.Equal(42, seenInt);
        Assert.Equal("hi", seenStr);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1213_emit_").FullName;
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
                "/target:exe",
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
