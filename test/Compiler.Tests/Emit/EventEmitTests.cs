// <copyright file="EventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0052: compiler emit tests for event declarations.
/// </summary>
public class EventEmitTests
{
    [Fact]
    public void FieldLikeEvent_EmitsEventDef()
    {
        var source = """
            package MyLib
            import System

            type MyButton class {
                public event Click func(Object, EventArgs)
            }
            """;

        var assembly = CompileToAssembly(source);
        var button = assembly.GetTypes().Single(t => t.Name == "MyButton");
        var ev = button.GetEvent("Click");

        Assert.NotNull(ev);
        Assert.Equal("Click", ev!.Name);
        Assert.NotNull(ev.AddMethod);
        Assert.NotNull(ev.RemoveMethod);
        Assert.Equal("add_Click", ev.AddMethod!.Name);
        Assert.Equal("remove_Click", ev.RemoveMethod!.Name);
        Assert.True(ev.AddMethod.IsSpecialName);
        Assert.True(ev.RemoveMethod.IsSpecialName);
    }

    [Fact]
    public void FieldLikeEvent_HasBackingField()
    {
        var source = """
            package MyLib
            import System

            type MyButton class {
                public event Click func(Object, EventArgs)
            }
            """;

        var assembly = CompileToAssembly(source);
        var button = assembly.GetTypes().Single(t => t.Name == "MyButton");
        var backingField = button.GetField("Click", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(backingField);
        Assert.True(backingField!.IsPrivate);
    }

    [Fact]
    public void FieldLikeEvent_AddRemove_WorksAtRuntime()
    {
        var source = """
            package MyLib
            import System

            type Notifier class {
                public event Changed func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var notifierType = assembly.GetTypes().Single(t => t.Name == "Notifier");
        var instance = Activator.CreateInstance(notifierType)!;
        var ev = notifierType.GetEvent("Changed")!;

        bool invoked = false;
        Action handler = () => invoked = true;
        ev.AddEventHandler(instance, handler);

        // Raise by reading the backing field and invoking
        var backingField = notifierType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        // Remove handler
        invoked = false;
        ev.RemoveEventHandler(instance, handler);
        del = backingField.GetValue(instance) as Delegate;
        Assert.Null(del);
    }

    [Fact]
    public void Event_MultipleHandlers()
    {
        var source = """
            package MyLib
            import System

            type Emitter class {
                public event Ping func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var emitterType = assembly.GetTypes().Single(t => t.Name == "Emitter");
        var instance = Activator.CreateInstance(emitterType)!;
        var ev = emitterType.GetEvent("Ping")!;

        int count = 0;
        Action h1 = () => count++;
        Action h2 = () => count += 10;
        ev.AddEventHandler(instance, h1);
        ev.AddEventHandler(instance, h2);

        var backingField = emitterType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        del!.DynamicInvoke();
        Assert.Equal(11, count);
    }

    [Fact]
    public void InterfaceEvent_EmitsAbstractAccessors()
    {
        var source = """
            package MyLib

            type IObservable interface {
                event Changed func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var iface = assembly.GetTypes().Single(t => t.Name == "IObservable");
        var ev = iface.GetEvent("Changed");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.AddMethod);
        Assert.NotNull(ev!.RemoveMethod);
        Assert.True(ev.AddMethod!.IsAbstract);
        Assert.True(ev.RemoveMethod!.IsAbstract);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_event_emit_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
