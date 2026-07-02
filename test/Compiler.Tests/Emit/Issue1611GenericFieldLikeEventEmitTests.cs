// <copyright file="Issue1611GenericFieldLikeEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1611 regression tests: field-like event add/remove accessors on a
/// generic type previously loaded their backing field with a bare FieldDef
/// token even though the accessor body runs on a constructed (self-)generic
/// receiver. ECMA-335 requires such member refs to go through the self-TypeSpec,
/// exactly like the auto-property fix for issue #989. Invoking add/remove on a
/// constructed generic instance used to throw <c>InvalidOperationException</c>
/// at runtime ("containing type is not fully instantiated").
/// </summary>
public class Issue1611GenericFieldLikeEventEmitTests
{
    [Fact]
    public void GenericFieldLikeEvent_InstanceAddRemove_RunsWithoutCrash()
    {
        var source = """
            package Gh1611Instance
            import System

            class Holder1611A[T] {
                public event Changed func()
            }
            """;

        var assembly = CompileToAssembly(source);
        var openType = assembly.GetTypes().Single(t => t.Name == "Holder1611A`1");
        var closedType = openType.MakeGenericType(typeof(int));
        var instance = Activator.CreateInstance(closedType)!;
        var ev = closedType.GetEvent("Changed")!;

        bool invoked = false;
        Action handler = () => invoked = true;

        // Invoking add_Changed on a constructed generic instance is exactly
        // where the bare-FieldDef token used to crash with
        // InvalidOperationException ("containing type is not fully instantiated").
        ev.AddEventHandler(instance, handler);

        var backingField = closedType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Instance);
        var del = backingField!.GetValue(instance) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        invoked = false;
        ev.RemoveEventHandler(instance, handler);
        del = backingField.GetValue(instance) as Delegate;
        Assert.Null(del);
        Assert.False(invoked);
    }

    [Fact]
    public void GenericFieldLikeEvent_StaticAddRemove_RunsWithoutCrash()
    {
        var source = """
            package Gh1611Static
            import System

            class Holder1611B[T] {
                shared {
                    public event Changed func()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var openType = assembly.GetTypes().Single(t => t.Name == "Holder1611B`1");
        var closedType = openType.MakeGenericType(typeof(int));
        var ev = closedType.GetEvent("Changed")!;

        bool invoked = false;
        Action handler = () => invoked = true;

        // Static add/remove on a constructed generic type: same bare-FieldDef
        // (ldsfld/ldsflda) crash as the instance case above.
        ev.AddMethod!.Invoke(null, new object[] { handler });

        var backingField = closedType.GetField("Changed", BindingFlags.NonPublic | BindingFlags.Static);
        var del = backingField!.GetValue(null) as Delegate;
        Assert.NotNull(del);
        del!.DynamicInvoke();
        Assert.True(invoked);

        invoked = false;
        ev.RemoveMethod!.Invoke(null, new object[] { handler });
        del = backingField.GetValue(null) as Delegate;
        Assert.Null(del);
        Assert.False(invoked);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1611_").FullName;
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
