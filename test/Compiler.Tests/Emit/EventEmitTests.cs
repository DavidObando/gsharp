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

    [Fact]
    public void RaiseAccessor_EmitsRaiseMethod()
    {
        var source = """
            package MyLib
            import System

            type Notifier class {
                public event Changed func() {
                    add { }
                    remove { }
                    raise { }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var notifierType = assembly.GetTypes().Single(t => t.Name == "Notifier");
        var ev = notifierType.GetEvent("Changed");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        Assert.Equal("raise_Changed", ev.RaiseMethod!.Name);
        Assert.True(ev.RaiseMethod.IsSpecialName);
    }

    [Fact]
    public void RaiseAccessor_MatchesHandlerParams()
    {
        var source = """
            package MyLib
            import System

            type Emitter class {
                public event Notify func(int32, string) {
                    add { }
                    remove { }
                    raise { }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var emitterType = assembly.GetTypes().Single(t => t.Name == "Emitter");
        var ev = emitterType.GetEvent("Notify");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        var raiseParams = ev.RaiseMethod!.GetParameters();
        Assert.Equal(2, raiseParams.Length);
        Assert.Equal(typeof(int), raiseParams[0].ParameterType);
        Assert.Equal(typeof(string), raiseParams[1].ParameterType);
    }

    [Fact]
    public void StaticEvent_EmitsStaticAccessors()
    {
        var source = """
            package MyLib
            import System

            type EventBus class {
                shared {
                    public event OnNotify func()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var busType = assembly.GetTypes().Single(t => t.Name == "EventBus");
        var ev = busType.GetEvent("OnNotify");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.AddMethod);
        Assert.NotNull(ev!.RemoveMethod);
        Assert.True(ev.AddMethod!.IsStatic);
        Assert.True(ev.RemoveMethod!.IsStatic);
    }

    [Fact]
    public void StaticEvent_AddRemove_WorksAtRuntime()
    {
        var source = """
            package MyLib
            import System

            type Bus class {
                shared {
                    public event Ping func()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var busType = assembly.GetTypes().Single(t => t.Name == "Bus");
        var ev = busType.GetEvent("Ping")!;

        bool invoked = false;
        Action handler = () => invoked = true;
        ev.AddMethod!.Invoke(null, new object[] { handler });

        // Read backing field and invoke
        var backingField = busType.GetField("Ping", BindingFlags.NonPublic | BindingFlags.Static);
        var del = backingField!.GetValue(null) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        // Remove
        invoked = false;
        ev.RemoveMethod!.Invoke(null, new object[] { handler });
        del = backingField.GetValue(null) as Delegate;
        Assert.Null(del);
    }

    [Fact]
    public void StaticEvent_WithRaiseAccessor_Emits()
    {
        var source = """
            package MyLib
            import System

            type Hub class {
                shared {
                    public event Alert func() {
                        add { }
                        remove { }
                        raise { }
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var hubType = assembly.GetTypes().Single(t => t.Name == "Hub");
        var ev = hubType.GetEvent("Alert");

        Assert.NotNull(ev);
        Assert.NotNull(ev!.RaiseMethod);
        Assert.Equal("raise_Alert", ev.RaiseMethod!.Name);
        Assert.True(ev.RaiseMethod.IsStatic);
        Assert.True(ev.RaiseMethod.IsSpecialName);
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
