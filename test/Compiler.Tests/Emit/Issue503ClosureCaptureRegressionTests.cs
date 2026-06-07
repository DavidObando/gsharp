using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

// Regression coverage for #503 ("closure-capturing lambda bound to a CLR event
// silently fails with MSB4181"). The base single-level capture case was fixed
// up-stream; this file pins the additional shapes I discovered while
// reproducing the bug end to end, including the nested-closure transitive
// capture path that previously surfaced as GS9998 "compiler-internal error".
//
// Each test compiles a small G# source to a real DLL, IL-verifies it, loads
// it into the current AppDomain, and exercises the closure via reflection.
// `Assembly.Load(byte[])` is used deliberately — multiple fixtures share the
// "MyLib" assembly name, and `Assembly.LoadFrom` would collide.
public class Issue503ClosureCaptureRegressionTests
{
    // -----------------------------------------------------------------------
    // Single-level closure capture — must compile, IL-verify, and fire.
    // -----------------------------------------------------------------------

    [Fact]
    public void CapturedLocal_InInstanceMethod_UserEvent_FiresAndIncrements()
    {
        var source = """
            package MyLib
            import System

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                Src Source
                Cnt Counter
                init() {
                    Src = Source()
                    Cnt = Counter()
                }
                func Subscribe() {
                    var src = Src
                    var counter = Cnt
                    src.Changed += func(sender object, e EventArgs) {
                        counter.Increment()
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        probeType.GetMethod("Subscribe")!.Invoke(probe, Array.Empty<object>());

        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var cnt = probeType.GetField("Cnt")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(cnt)!);
    }

    [Fact]
    public void CapturedLocal_InLoopBody_UserEvent_FiresOncePerSubscription()
    {
        var source = """
            package MyLib
            import System

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                Src Source
                Cnt Counter
                init() {
                    Src = Source()
                    Cnt = Counter()
                    var i = 0
                    for i < 3 {
                        var counter = Cnt
                        Src.Changed += func(sender object, e EventArgs) {
                            counter.Increment()
                        }
                        i = i + 1
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var cnt = probeType.GetField("Cnt")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(3, (int)counterType.GetField("Value")!.GetValue(cnt)!);
    }

    [Fact]
    public void CapturedField_AsClosureVariable_UserEvent_Fires()
    {
        var source = """
            package MyLib
            import System

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                Src Source
                Cnt Counter
                init() {
                    Src = Source()
                    Cnt = Counter()
                    Src.Changed += func(sender object, e EventArgs) {
                        Cnt.Increment()
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var cnt = probeType.GetField("Cnt")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(cnt)!);
    }

    [Fact]
    public void CapturesThis_UserEvent_Fires()
    {
        var source = """
            package MyLib
            import System

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Probe class {
                Src Source
                Hits int32
                init() {
                    Src = Source()
                    Hits = 0
                    var me = this
                    Src.Changed += func(sender object, e EventArgs) {
                        me.Bump()
                    }
                }
                func Bump() { Hits = Hits + 1 }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(1, (int)probeType.GetField("Hits")!.GetValue(probe)!);
    }

    [Fact]
    public void MultipleCaptures_InOneLambda_AllObserved()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Add(n int32) { Value = Value + n }
            }

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Probe class {
                Src Source
                A Counter
                B Counter
                init() {
                    Src = Source()
                    A = Counter()
                    B = Counter()
                    var a = A
                    var b = B
                    var step = 3
                    Src.Changed += func(sender object, e EventArgs) {
                        a.Add(step)
                        b.Add(step + 1)
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var a = probeType.GetField("A")!.GetValue(probe)!;
        var b = probeType.GetField("B")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(3, (int)counterType.GetField("Value")!.GetValue(a)!);
        Assert.Equal(4, (int)counterType.GetField("Value")!.GetValue(b)!);
    }

    // -----------------------------------------------------------------------
    // CLR (BCL) event sinks — closure must subscribe without aborting emit.
    // -----------------------------------------------------------------------

    [Fact]
    public void ClrEvent_InsideInstanceMethod_CapturingLocal_CompilesAndVerifies()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                init() { }
                func Subscribe() {
                    var counter = Counter()
                    var domain = AppDomain.CurrentDomain
                    domain.ProcessExit += func(sender object, e EventArgs) {
                        counter.Increment()
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        Assert.NotNull(assembly);
    }

    [Fact]
    public void ClrEvent_ChainedReceiver_CapturingLocal_CompilesAndVerifies()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                init() { }
                func Subscribe() {
                    var counter = Counter()
                    AppDomain.CurrentDomain.ProcessExit += func(sender object, e EventArgs) {
                        counter.Increment()
                    }
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        Assert.NotNull(assembly);
    }

    // -----------------------------------------------------------------------
    // Top-level statement program — closure-into-event from script-style code.
    // -----------------------------------------------------------------------

    [Fact]
    public void TopLevel_LocalCapture_UserEvent_CompilesAndVerifies()
    {
        var source = """
            package MyLib
            import System

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            var src = Source()
            var counter = Counter()
            src.Changed += func(sender object, e EventArgs) {
                counter.Increment()
            }
            """;

        var assembly = CompileToAssembly(source);
        Assert.NotNull(assembly);
    }

    // -----------------------------------------------------------------------
    // Snapshot capture semantics — pinned for future intentional change.
    // -----------------------------------------------------------------------

    [Fact]
    public void CapturedLocalReassignedAfterSubscription_SnapshotsAtSubscriptionTime()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Probe class {
                Src Source
                Original Counter
                init() {
                    Src = Source()
                    var c = Counter()
                    Original = c
                    Src.Changed += func(sender object, e EventArgs) {
                        c.Increment()
                    }
                    // Reassign after subscription. Whatever the capture
                    // semantics, the build must not silently abort and the
                    // closure must fire on raise.
                    c = Counter()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var original = probeType.GetField("Original")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");

        // Snapshot-capture semantics: the original counter (captured at
        // subscription time) was incremented. This pins current behavior
        // so a future change to reference-capture semantics is intentional.
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(original)!);
    }

    // -----------------------------------------------------------------------
    // Nested closures — outer lambda body contains an inner lambda that
    // captures (transitively) a variable from the enclosing method. This is
    // the path that previously surfaced as GS9998 "compiler-internal error:
    // Variable 'counter' has no local slot or parameter index in the current
    // method." It is the broader fix landed alongside #503.
    // -----------------------------------------------------------------------

    [Fact]
    public void NestedClosure_NoEvent_TransitiveCapture_CompilesAndVerifies()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Probe class {
                Cnt Counter
                init() {
                    Cnt = Counter()
                    var counter = Cnt
                    var outer = func() {
                        var inner = func() {
                            counter.Increment()
                        }
                        inner()
                    }
                    outer()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var cnt = probeType.GetField("Cnt")!.GetValue(probe)!;
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(cnt)!);
    }

    [Fact]
    public void NestedClosure_OuterCapture_InnerSubscribesEvent_FiresAndIncrements()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Probe class {
                Src Source
                Cnt Counter
                init() {
                    Src = Source()
                    Cnt = Counter()
                    var src = Src
                    var counter = Cnt
                    var subscribe = func() {
                        src.Changed += func(sender object, e EventArgs) {
                            counter.Increment()
                        }
                    }
                    subscribe()
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var probeType = assembly.GetTypes().Single(t => t.Name == "Probe");
        var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");

        var probe = Activator.CreateInstance(probeType)!;
        var src = probeType.GetField("Src")!.GetValue(probe)!;
        var cnt = probeType.GetField("Cnt")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(cnt)!);
    }

    // -----------------------------------------------------------------------
    // Negative guard — a type error inside a capturing lambda must produce a
    // precise GS#### diagnostic, never a silent MSB4181-style abort.
    // -----------------------------------------------------------------------

    [Fact]
    public void LambdaBodyTypeError_InCapturingLambda_ProducesGSDiagnostic()
    {
        var source = """
            package MyLib
            import System

            type Counter class {
                Value int32
                init() { Value = 0 }
                func Increment() { Value = Value + 1 }
            }

            type Source class {
                public event Changed EventHandler
                init() { }
            }

            type Probe class {
                init() {
                    var s = Source()
                    var c = Counter()
                    s.Changed += func(sender object, e EventArgs) {
                        c.NotARealMethod()
                    }
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_503_neg_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var compileOut = new StringWriter();
        var compileErr = new StringWriter();
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

        Assert.NotEqual(0, compileExit);
        var combined = compileOut.ToString() + compileErr.ToString();
        // Must surface as a GS#### code, not as a swallowed exception.
        Assert.Matches(@"GS\d{4}", combined);
    }

    // -----------------------------------------------------------------------
    // Shared helpers.
    // -----------------------------------------------------------------------

    private static void InvokeBackingDelegate(Type containingType, object instance, string eventName)
    {
        var backingField = containingType.GetField(
            eventName,
            BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Public);
        Assert.NotNull(backingField);
        var del = (Delegate)backingField!.GetValue(instance)!;
        del.DynamicInvoke(instance, EventArgs.Empty);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_503_").FullName;
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
