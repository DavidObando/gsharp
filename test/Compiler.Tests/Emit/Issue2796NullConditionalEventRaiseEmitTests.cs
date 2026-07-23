// <copyright file="Issue2796NullConditionalEventRaiseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2796: the null-conditional raise form <c>Evt?(args)</c> of a
/// field-like event must short-circuit to a no-op when the backing delegate is
/// null (no subscribers), mirroring C# <c>Evt?.Invoke(args)</c>. PR #2792
/// (fix/2726) canonicalizes conventional structural event shapes
/// (<c>(object?, EventArgs) -> void</c>) and nominal <c>EventHandler</c> events
/// to the CLR <c>System.EventHandler</c>/<c>EventHandler&lt;T&gt;</c> delegates,
/// which routes the invocation through the CLR-delegate call path. That path
/// lacked the null guard the FunctionTypeSymbol / named-delegate paths already
/// carried, so a fresh event with no subscribers threw
/// <see cref="NullReferenceException"/> instead of no-opping. These tests prove
/// the emitted IL verifies and runs for the zero-subscriber, subscribed,
/// unsubscribe-then-raise, and generic <c>EventHandler&lt;T&gt;</c> shapes.
/// </summary>
public class Issue2796NullConditionalEventRaiseEmitTests
{
    [Fact]
    public void NominalEventHandlerRaise_NoSubscribers_IsSafeNoOp()
    {
        var source = """
            package MyLib
            import System

            class Bell {
                event Rang EventHandler
                func Ring() { Rang?(this, EventArgs.Empty) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var bellType = assembly.GetTypes().Single(t => t.Name == "Bell");
        var instance = Activator.CreateInstance(bellType)!;

        // No subscriber: the backing delegate is null, so raising must be a
        // no-op rather than throwing a NullReferenceException.
        var ring = bellType.GetMethod("Ring")!;
        var ex = Record.Exception(() => ring.Invoke(instance, null));
        Assert.Null(ex);
    }

    [Fact]
    public void NominalEventHandlerRaise_WithSubscriber_InvokesHandler()
    {
        var source = """
            package MyLib
            import System

            class Bell {
                event Rang EventHandler
                func Ring() { Rang?(this, EventArgs.Empty) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var bellType = assembly.GetTypes().Single(t => t.Name == "Bell");
        var instance = Activator.CreateInstance(bellType)!;

        int hits = 0;
        var ev = bellType.GetEvent("Rang")!;
        EventHandler handler = (_, _) => hits++;
        ev.AddEventHandler(instance, handler);

        bellType.GetMethod("Ring")!.Invoke(instance, null);
        Assert.Equal(1, hits);
    }

    [Fact]
    public void StructuralEventArgsRaise_NoSubscribers_IsSafeNoOp()
    {
        // A conventional structural `(object?, EventArgs) -> void` event is
        // canonicalized to nominal `System.EventHandler` by PR #2792; the raise
        // must still no-op with no subscribers (regression the fix restores).
        var source = """
            package MyLib
            import System

            class Bell {
                event Rang (object?, EventArgs) -> void
                func Ring() { Rang?(this, EventArgs.Empty) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var bellType = assembly.GetTypes().Single(t => t.Name == "Bell");
        var instance = Activator.CreateInstance(bellType)!;

        var ring = bellType.GetMethod("Ring")!;
        var ex = Record.Exception(() => ring.Invoke(instance, null));
        Assert.Null(ex);
    }

    [Fact]
    public void StructuralEventArgsRaise_WithSubscriber_InvokesHandler()
    {
        var source = """
            package MyLib
            import System

            class Bell {
                event Rang (object?, EventArgs) -> void
                func Ring() { Rang?(this, EventArgs.Empty) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var bellType = assembly.GetTypes().Single(t => t.Name == "Bell");
        var instance = Activator.CreateInstance(bellType)!;

        int hits = 0;
        var ev = bellType.GetEvent("Rang")!;
        EventHandler handler = (_, _) => hits++;
        ev.AddEventHandler(instance, handler);

        bellType.GetMethod("Ring")!.Invoke(instance, null);
        Assert.Equal(1, hits);
    }

    [Fact]
    public void NominalEventHandlerRaise_UnsubscribeThenRaise_IsSafeNoOp()
    {
        // The canonical `SettingsBase.OnChange` failure mode: after the last
        // subscriber is removed the backing delegate is null again, so a
        // subsequent raise must no-op rather than NRE.
        var source = """
            package MyLib
            import System

            class Bell {
                event Rang EventHandler
                func Ring() { Rang?(this, EventArgs.Empty) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var bellType = assembly.GetTypes().Single(t => t.Name == "Bell");
        var instance = Activator.CreateInstance(bellType)!;
        var ring = bellType.GetMethod("Ring")!;
        var ev = bellType.GetEvent("Rang")!;

        int hits = 0;
        EventHandler handler = (_, _) => hits++;
        ev.AddEventHandler(instance, handler);
        ring.Invoke(instance, null);
        Assert.Equal(1, hits);

        ev.RemoveEventHandler(instance, handler);
        var ex = Record.Exception(() => ring.Invoke(instance, null));
        Assert.Null(ex);
        Assert.Equal(1, hits);
    }

    [Fact]
    public void GenericEventHandlerRaise_NoSubscribersAndWithSubscriber_Behaves()
    {
        var source = """
            package MyLib
            import System

            class Bus[T EventArgs] {
                event Msg EventHandler[T]
                func Fire(a T) { Msg?(this, a) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var openBus = assembly.GetTypes().Single(t => t.Name == "Bus`1");
        var closedBus = openBus.MakeGenericType(typeof(EventArgs));
        var instance = Activator.CreateInstance(closedBus)!;
        var fire = closedBus.GetMethod("Fire")!;

        // No subscriber: raising the generic event must no-op.
        var ex = Record.Exception(() => fire.Invoke(instance, new object[] { EventArgs.Empty }));
        Assert.Null(ex);

        // With a subscriber the handler is invoked with the raised argument.
        int hits = 0;
        var ev = closedBus.GetEvent("Msg")!;
        EventHandler<EventArgs> handler = (_, _) => hits++;
        ev.AddEventHandler(instance, handler);
        fire.Invoke(instance, new object[] { EventArgs.Empty });
        Assert.Equal(1, hits);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2796_emit_").FullName;
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
