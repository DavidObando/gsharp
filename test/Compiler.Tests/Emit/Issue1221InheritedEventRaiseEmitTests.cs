// <copyright file="Issue1221InheritedEventRaiseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1221 (follow-up to #1213): an <c>event</c> declared on a base class
/// must be raisable from a derived class. Raising an inherited event
/// (<c>Changed?(args)</c> / <c>Changed?.Invoke(args)</c>) from a derived method
/// loads the base type's backing delegate field on <c>this</c>, null-checks it,
/// and invokes it. The backing field is emitted as <c>family</c> (protected) so
/// the derived-class read verifies and runs. These tests prove the emitted IL
/// verifies and runs: a derived raise reaches a subscribed handler, a multi-level
/// (grandparent) event raises from a grandchild, and a null backing field makes
/// the raise a safe no-op.
/// </summary>
public class Issue1221InheritedEventRaiseEmitTests
{
    [Fact]
    public void DerivedRaisesInheritedEvent_WithHandler_InvokesHandler()
    {
        var source = """
            package MyLib

            open class Base {
                event Changed (int32) -> void
            }

            class Derived : Base {
                func RaiseFromDerived(v int32) { Changed?(v) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var derivedType = assembly.GetTypes().Single(t => t.Name == "Derived");
        var instance = Activator.CreateInstance(derivedType)!;

        int observed = 0;
        var ev = derivedType.GetEvent("Changed")!;
        Action<int> handler = v => observed = v;
        ev.AddEventHandler(instance, handler);

        derivedType.GetMethod("RaiseFromDerived")!.Invoke(instance, new object[] { 42 });
        Assert.Equal(42, observed);
    }

    [Fact]
    public void DerivedRaisesInheritedEvent_NullBackingField_IsSafeNoOp()
    {
        var source = """
            package MyLib

            open class Base {
                event Changed (int32) -> void
            }

            class Derived : Base {
                func RaiseFromDerived(v int32) { Changed?(v) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var derivedType = assembly.GetTypes().Single(t => t.Name == "Derived");
        var instance = Activator.CreateInstance(derivedType)!;

        // No handler subscribed: the inherited backing delegate field is null,
        // so raising must be a no-op rather than throwing a
        // NullReferenceException (or a FieldAccessException for the base field).
        var raise = derivedType.GetMethod("RaiseFromDerived")!;
        var ex = Record.Exception(() => raise.Invoke(instance, new object[] { 5 }));
        Assert.Null(ex);
    }

    [Fact]
    public void GrandchildRaisesGrandparentEvent_WithHandler_InvokesHandler()
    {
        var source = """
            package MyLib

            open class A {
                event Changed (int32) -> void
            }

            open class B : A {
            }

            class C : B {
                func RaiseFromC(v int32) { Changed?(v) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var cType = assembly.GetTypes().Single(t => t.Name == "C");
        var instance = Activator.CreateInstance(cType)!;

        int observed = 0;
        var ev = cType.GetEvent("Changed")!;
        Action<int> handler = v => observed = v;
        ev.AddEventHandler(instance, handler);

        cType.GetMethod("RaiseFromC")!.Invoke(instance, new object[] { 99 });
        Assert.Equal(99, observed);
    }

    [Fact]
    public void DerivedRaisesInheritedEvent_QualifiedInvokeForm_InvokesHandler()
    {
        var source = """
            package MyLib

            open class Base {
                event Changed (int32) -> void
            }

            class Derived : Base {
                func RaiseFromDerived(v int32) { this.Changed?.Invoke(v) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var derivedType = assembly.GetTypes().Single(t => t.Name == "Derived");
        var instance = Activator.CreateInstance(derivedType)!;

        int observed = 0;
        var ev = derivedType.GetEvent("Changed")!;
        Action<int> handler = v => observed = v;
        ev.AddEventHandler(instance, handler);

        derivedType.GetMethod("RaiseFromDerived")!.Invoke(instance, new object[] { 7 });
        Assert.Equal(7, observed);
    }

    [Fact]
    public void BaseAndDerivedRaiseSameInheritedEvent_BothReachHandler()
    {
        var source = """
            package MyLib

            open class Base {
                event Changed (int32) -> void
                func RaiseFromBase(v int32) { Changed?(v) }
            }

            class Derived : Base {
                func RaiseFromDerived(v int32) { Changed?(v) }
            }
            """;

        var assembly = CompileToAssembly(source);
        var derivedType = assembly.GetTypes().Single(t => t.Name == "Derived");
        var instance = Activator.CreateInstance(derivedType)!;

        int observed = 0;
        var ev = derivedType.GetEvent("Changed")!;
        Action<int> handler = v => observed = v;
        ev.AddEventHandler(instance, handler);

        // The same-type raise (declared on Base) and the inherited raise (from
        // Derived) both bind to the one backing field and reach the handler.
        derivedType.GetMethod("RaiseFromBase")!.Invoke(instance, new object[] { 11 });
        Assert.Equal(11, observed);

        derivedType.GetMethod("RaiseFromDerived")!.Invoke(instance, new object[] { 22 });
        Assert.Equal(22, observed);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1221_emit_").FullName;
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
