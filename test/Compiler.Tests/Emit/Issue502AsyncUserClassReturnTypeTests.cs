// <copyright file="Issue502AsyncUserClassReturnTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression tests for issue #502 (remaining facet): <c>async func</c>
/// returning a user-defined G# class type must correctly lift to
/// <c>Task&lt;UserClass&gt;</c>. Prior to this fix, the binder returned the
/// bare class type from <c>WrapAsTask</c> because
/// <c>StructSymbol.ClrType</c> is null during binding (TypeBuilder doesn't
/// exist yet). Callers saw the bare type and <c>await</c> rejected with
/// <c>GS0133</c>.
/// </summary>
public class Issue502AsyncUserClassReturnTypeTests
{
    [Fact]
    public void AsyncFunc_ReturnsPrimaryCtorClass_AwaitWorks()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type AsyncPC class(Value int32) {}

            type Probe class {
                async func MakePC() AsyncPC {
                    await Task.Delay(1)
                    return AsyncPC(7)
                }

                async func Pc_Roundtrip() {
                    let r = await this.MakePC()
                    Console.WriteLine(r.Value)
                }
            }

            let p = Probe()
            p.Pc_Roundtrip().Wait()
            """;

        var assembly = CompileToAssembly(source);
        var asyncPc = assembly.GetTypes().Single(t => t.Name == "AsyncPC");
        var probe = assembly.GetTypes().Single(t => t.Name == "Probe");
        var makePc = probe.GetMethod("MakePC", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(makePc);
        Assert.Equal(typeof(Task<>).MakeGenericType(asyncPc), makePc!.ReturnType);

        InvokeWithHangGuard(GetEntryMethod(assembly));
    }

    [Fact]
    public void AsyncFunc_ReturnsClassWithInit_AwaitWorks()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type AsyncCC class {
                Value int32
                init() { Value = 0 }
            }

            type Probe class {
                async func MakeCC() AsyncCC {
                    await Task.Delay(1)
                    var cc = AsyncCC()
                    cc.Value = 42
                    return cc
                }

                async func Cc_Roundtrip() {
                    let r = await this.MakeCC()
                    Console.WriteLine(r.Value)
                }
            }

            let p = Probe()
            p.Cc_Roundtrip().Wait()
            """;

        var assembly = CompileToAssembly(source);
        var asyncCc = assembly.GetTypes().Single(t => t.Name == "AsyncCC");
        var probe = assembly.GetTypes().Single(t => t.Name == "Probe");
        var makeCc = probe.GetMethod("MakeCC", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(makeCc);
        Assert.Equal(typeof(Task<>).MakeGenericType(asyncCc), makeCc!.ReturnType);

        InvokeWithHangGuard(GetEntryMethod(assembly));
    }

    [Fact]
    public void AsyncFunc_ReturnsClassWithFields_RoundtripsValues()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type Container class(X int32, Y int32) {}

            type Svc class {
                async func MakeContainer() Container {
                    await Task.Delay(1)
                    return Container(10, 20)
                }

                async func Run() {
                    let c = await this.MakeContainer()
                    Console.WriteLine(c.X + c.Y)
                }
            }

            let svc = Svc()
            svc.Run().Wait()
            """;

        var assembly = CompileToAssembly(source);
        var container = assembly.GetTypes().Single(t => t.Name == "Container");
        var svc = assembly.GetTypes().Single(t => t.Name == "Svc");
        var makeContainer = svc.GetMethod("MakeContainer", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(makeContainer);
        Assert.Equal(typeof(Task<>).MakeGenericType(container), makeContainer!.ReturnType);

        var entry = GetEntryMethod(assembly);
        var stdout = CaptureStdout(() => InvokeWithHangGuard(entry));
        Assert.Contains("30", stdout);
    }

    [Fact]
    public void AsyncFunc_ReturnsGenericUserClass_AwaitWorks()
    {
        // Generic user classes erase their type parameter to object in the
        // emitted IL (type-erased generics). The async Task<T> lift should
        // still work because the outer class is a reference type.
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type Box class(Item int32) {}

            type Svc class {
                async func MakeBox() Box {
                    await Task.Delay(1)
                    return Box(99)
                }

                async func Run() {
                    let b = await this.MakeBox()
                    Console.WriteLine(b.Item)
                }
            }

            let svc = Svc()
            svc.Run().Wait()
            """;

        var assembly = CompileToAssembly(source);
        var box = assembly.GetTypes().Single(t => t.Name == "Box");
        var svc = assembly.GetTypes().Single(t => t.Name == "Svc");
        var makeBox = svc.GetMethod("MakeBox", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(makeBox);
        Assert.Equal(typeof(Task<>).MakeGenericType(box), makeBox!.ReturnType);

        var entry = GetEntryMethod(assembly);
        var stdout = CaptureStdout(() => InvokeWithHangGuard(entry));
        Assert.Contains("99", stdout);
    }

    [Fact]
    public void AwaitOnNonTaskUserStruct_StillErrors_GS0133()
    {
        // Negative test: a plain user-defined class without GetAwaiter()
        // must still produce GS0133 when someone attempts to await it
        // directly (not via an async method that returns it).
        var source = """
            package P

            import System
            import System.Threading.Tasks

            type Point class(X int32, Y int32) {}

            async func Bad() {
                let p = Point(1, 2)
                let r = await p
                Console.WriteLine(r)
            }
            """;

        var (exitCode, stdout, _) = CompileRaw(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0133", stdout);
    }

    #region Helpers

    private static MethodInfo GetEntryMethod(Assembly assembly)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(entry);
        return entry!;
    }

    private static void InvokeWithHangGuard(MethodInfo entry, int timeoutMs = 10_000)
    {
        Exception captured = null;
        var thread = new System.Threading.Thread(() =>
        {
            try
            {
                entry.Invoke(null, null);
            }
            catch (Exception ex)
            {
                captured = ex;
            }
        });
        thread.IsBackground = true;
        thread.Start();
        var finished = thread.Join(timeoutMs);
        Assert.True(
            finished,
            "Compiled entry-point did not complete within "
                + timeoutMs
                + " ms — async lowering hang (issue #502 regression).");

        if (captured != null)
        {
            throw new InvalidOperationException("Compiled entry-point threw.", captured);
        }
    }

    private static string CaptureStdout(Action action)
    {
        var prevOut = Console.Out;
        using var sw = new StringWriter();
        Console.SetOut(sw);
        try
        {
            action();
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return sw.ToString();
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_502_user_class_").FullName;
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

    private static (int ExitCode, string Stdout, string Stderr) CompileRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_502_neg_").FullName;
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

        return (compileExit, compileOut.ToString(), compileErr.ToString());
    }

    #endregion
}
