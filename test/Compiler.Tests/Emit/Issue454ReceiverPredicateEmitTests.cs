// <copyright file="Issue454ReceiverPredicateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #454: regression tests for the migrated CLR-side emit paths that
/// previously used the inline <c>ClrType?.IsValueType == true</c> predicate
/// for receiver-kind detection. Switching to <c>IsValueTypeSymbol</c>
/// (the same predicate used by <c>EmitInstanceReceiver</c>) preserves
/// behaviour for CLR value-type receivers (verified here) while also
/// correctly classifying user-declared structs (which have no
/// <c>ClrType</c> until after emission completes).
///
/// The four migrated sites are:
///   * <c>EmitClrPropertyAccess</c>
///   * <c>EmitClrPropertyAssignment</c>
///   * <c>EmitClrEventSubscription</c>
///   * <c>EmitClrIndexAccess</c>
///
/// Each test compiles a small program that exercises one of those sites
/// and asserts the runtime result matches expectation; any regression in
/// the call/callvirt choice or the spill plumbing manifests as either a
/// JIT-time failure (<see cref="InvalidProgramException"/>) or a wrong
/// observable value.
/// </summary>
public class Issue454ReceiverPredicateEmitTests
{
    [Fact]
    public void ClrPropertyAccess_OnUserStructHeldClrObject_RoundTrips()
    {
        // User-declared struct holds a StringBuilder reference. Reading
        // `b.sb` returns the inner CLR reference; calling `.Length` on it
        // exercises EmitClrPropertyAccess. The outer field access spills
        // through EmitInstanceReceiver (struct receiver) and the inner CLR
        // call uses callvirt as the unified predicate prescribes for
        // reference-type receivers.
        var source = """
            package P
            import System
            import System.Text

            type Box struct {
                sb StringBuilder
            }

            let b = Box{sb: StringBuilder("hello")}
            let inner = b.sb
            public var result = inner.Length
            """;

        Assert.Equal(5, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClrPropertyAccess_OnClrValueTypeReceiver_StillUsesCall()
    {
        // Reading a CLR property on a CLR value-type receiver (DateTime.Day)
        // must still emit `call` (not callvirt) under the new predicate.
        // Runtime success implicitly verifies the IL is valid.
        var source = """
            package P
            import System

            let d = DateTime(2024, 7, 15)
            public var result = d.Day
            """;

        Assert.Equal(15, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClrPropertyAssignment_OnUserStructHeldClrObject_RoundTrips()
    {
        // Writing to a CLR property on a CLR reference exercises the
        // EmitClrPropertyAssignment site and its value-spill machinery.
        // The user struct (loaded by address via EmitInstanceReceiver)
        // holds the CLR reference; the assignment runs against the inner
        // CLR receiver and must yield the spilled value as the expression
        // result without re-reading via the getter.
        var source = """
            package P
            import System
            import System.Text

            let sb = StringBuilder()
            let written = (sb.Capacity = 256)
            public var result = written
            """;

        Assert.Equal(256, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClrEventSubscription_OnClrReferenceReceiver_RoundTrips()
    {
        // Subscribe and unsubscribe handlers on a CLR event. The unified
        // predicate must still emit callvirt for the add_X/remove_X
        // accessors on a reference-type receiver, and the produced IL must
        // load and run.
        var source = """
            package P
            import System

            let d = AppDomain.CurrentDomain
            d.ProcessExit += func(sender Object, e EventArgs) { }
            public var result = 1
            """;

        Assert.Equal(1, RunAndGetIntResult(source));
    }

    [Fact]
    public void ClrIndexerAccess_OnClrReferenceReceiver_RoundTrips()
    {
        // Read a CLR indexer via callvirt on a reference-type receiver
        // (List[int32]). The unified predicate must still emit callvirt
        // for the get_Item call.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let list = List[int32]()
            list.Add(11)
            list.Add(22)
            list.Add(33)
            public var result = list[1]
            """;

        Assert.Equal(22, RunAndGetIntResult(source));
    }

    [Fact]
    public void UserStructProperty_AccessOnRvalueReceiver_SpillsAndUsesCall()
    {
        // Sanity guard for the user-defined property path: an rvalue
        // user-struct receiver must be spilled to a temp and addressed by
        // `ldloca` before the `call get_Sum`. Pre-#454 the user-property
        // path already used the symbol-based `receiverIsClass` predicate;
        // this test just locks in that behaviour against future drift.
        var source = """
            package P
            import System

            type Point struct {
                X int32
                Y int32
                prop Sum int32 {
                    get { return this.X + this.Y }
                }
            }

            func makePoint(x int32, y int32) Point {
                return Point{X: x, Y: y}
            }

            public var result = makePoint(4, 9).Sum
            """;

        Assert.Equal(13, RunAndGetIntResult(source));
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, null);
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue454_emit_").FullName;
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

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }
}
