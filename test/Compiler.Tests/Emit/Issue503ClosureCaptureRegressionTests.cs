using System;
using System.Collections.Generic;
using System.Diagnostics;
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
    // Reference-capture semantics — issue #523. A lambda captures the
    // *cell*, not the value at construction time; reassigning the local
    // after subscription is observed by the lambda body.
    // -----------------------------------------------------------------------

    [Fact]
    public void CapturedLocalReassignedAfterSubscription_LambdaObservesNewBinding()
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
                Replacement Counter
                init() {
                    Src = Source()
                    var c = Counter()
                    Original = c
                    Src.Changed += func(sender object, e EventArgs) {
                        c.Increment()
                    }
                    // Reassign after subscription. Reference-capture
                    // semantics (issue #523): the lambda holds the variable
                    // cell, so it observes the new binding and `c.Increment()`
                    // hits the replacement instance, not the original.
                    c = Counter()
                    Replacement = c
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
        var replacement = probeType.GetField("Replacement")!.GetValue(probe)!;

        InvokeBackingDelegate(sourceType, src, "Changed");

        // Reference-capture (issue #523): the lambda follows the cell, so the
        // post-subscription assignment is the one observed. The original
        // counter is untouched; the replacement is the one that fires.
        Assert.Equal(0, (int)counterType.GetField("Value")!.GetValue(original)!);
        Assert.Equal(1, (int)counterType.GetField("Value")!.GetValue(replacement)!);
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
    // CLR delegate parameter shapes — closure → Action / Func / EventHandler
    // passed directly to a CLR method/event declared in a sibling C# assembly.
    // These are the shapes from issue #503's second comment (closure-capturing
    // lambda → CLR delegate conversion via static method parameter).
    // -----------------------------------------------------------------------

    private const string SiblingCsSource = """
        using System;

        namespace Probe.CSharp
        {
            public static class CliEnvironment
            {
                private static Action _restoreCallback;
                private static Func<int> _provider;

                public static void RegisterRestore(Action callback)
                {
                    _restoreCallback = callback;
                }

                public static void FireRestore()
                {
                    _restoreCallback?.Invoke();
                }

                public static void RegisterProvider(Func<int> provider)
                {
                    _provider = provider;
                }

                public static int GetProvidedValue()
                {
                    return _provider != null ? _provider() : -1;
                }
            }

            public class ClrSource
            {
                public event EventHandler Changed;

                public void OnChanged()
                {
                    Changed?.Invoke(this, EventArgs.Empty);
                }
            }
        }
        """;

    [Fact]
    public void ClosureCapturingLocal_BoundToClrEvent_CompilesAndRuns()
    {
        var gSource = """
            package MyLib
            import System
            import Probe.CSharp

            var counter = 0
            var src = ClrSource()
            src.Changed += func(sender object, e EventArgs) {
                counter = counter + 1
            }
            src.OnChanged()
            src.OnChanged()
            System.Console.WriteLine(counter)
            """;

        var output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp");
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void ClosureCapturingLocal_PassedAsClrActionParameter_CompilesAndRuns()
    {
        var gSource = """
            package MyLib
            import Probe.CSharp

            var x = 0
            CliEnvironment.RegisterRestore(func() {
                x = x + 1
            })
            CliEnvironment.FireRestore()
            CliEnvironment.FireRestore()
            CliEnvironment.FireRestore()
            System.Console.WriteLine(x)
            """;

        var output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void ClosureCapturingLocal_PassedAsClrFuncParameter_CompilesAndRuns()
    {
        var gSource = """
            package MyLib
            import Probe.CSharp

            var x = 10
            CliEnvironment.RegisterProvider(func() int32 {
                x = x + 5
                return x
            })
            var a = CliEnvironment.GetProvidedValue()
            var b = CliEnvironment.GetProvidedValue()
            System.Console.WriteLine(a)
            System.Console.WriteLine(b)
            """;

        var output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp");
        Assert.Equal("15\n20\n", output);
    }

    [Fact]
    public void ClosureCapturingMutableLocal_ObservesMutationsThroughDelegate()
    {
        var gSource = """
            package MyLib
            import Probe.CSharp

            var x = 0
            CliEnvironment.RegisterRestore(func() {
                x = x + 1
            })
            System.Console.WriteLine(x)
            CliEnvironment.FireRestore()
            System.Console.WriteLine(x)
            x = 100
            CliEnvironment.FireRestore()
            System.Console.WriteLine(x)
            """;

        var output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp");
        Assert.Equal("0\n1\n101\n", output);
    }

    [Fact]
    public void NonExistentDelegateTarget_ProducesGSDiagnostic()
    {
        // Calling a method that doesn't exist should produce a precise GS####
        // diagnostic, not a silent MSB4181 or unhandled exception.
        var gSource = """
            package MyLib
            import Probe.CSharp

            var x = 0
            CliEnvironment.NoSuchMethod(func() {
                x = x + 1
            })
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_503_neg2_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), SiblingCsSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>Probe.CSharp</AssemblyName>
                    <RootNamespace>Probe.CSharp</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, "Probe.CSharp");

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.NotEqual(0, compileExit);
            var combined = compileOut.ToString() + compileErr.ToString();
            // Must surface as a GS#### code, not a silent abort.
            Assert.Matches(@"GS\d{4}", combined);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
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

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_503_sib_").FullName;
        try
        {
            var csDir = Path.Combine(tempDir, "csref");
            Directory.CreateDirectory(csDir);
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource);
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <OutputType>Library</OutputType>
                    <TargetFramework>net10.0</TargetFramework>
                    <AssemblyName>{siblingName}</AssemblyName>
                    <RootNamespace>{siblingName}</RootNamespace>
                  </PropertyGroup>
                </Project>
                """);

            var siblingDll = BuildCsProject(csDir, siblingName);

            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, gSource);

            var gscArgs = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll,
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                gscArgs.Add("/reference:" + reference);
            }

            gscArgs.Add("/nowarn:GS9100");
            gscArgs.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(gscArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true);

            IlVerifier.Verify(outPath, additionalReferences: new[] { siblingDll });

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string BuildCsProject(string csDir, string siblingName)
    {
        RunDotnet(csDir, "restore");

        var stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");
        _ = stdout;

        var dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static string RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
