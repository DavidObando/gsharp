package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

// Regression coverage for #503 ("closure-capturing lambda bound to a CLR event
// silently fails with MSB4181"). The base single-level capture case was fixed
// up-stream; this file pins the additional shapes I discovered while
// reproducing the bug end to end, including the nested-closure transitive
// capture path that previously surfaced as GS9998 "compiler-internal error".
//
// Each test compiles a small G# source to a real DLL, IL-verifies it, loads
// it into the current AppDomain, and exercises the closure via reflection.
// `EmittedFixture.Load(byte[])` is used deliberately — multiple fixtures share the
// "MyLib" assembly name, and `Assembly.LoadFrom` would collide.
open class Issue503ClosureCaptureRegressionTests {
    // -----------------------------------------------------------------------
    // Single-level closure capture — must compile, IL-verify, and fire.
    // -----------------------------------------------------------------------
    @Fact
    func CapturedLocal_InInstanceMethod_UserEvent_FiresAndIncrements() {
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    var Src Source
    var Cnt Counter
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
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        probeType.GetMethod("Subscribe")!!.Invoke(probe, Array.Empty[object]())
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let cnt = probeType.GetField("Cnt")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(cnt)!!))
    }

    @Fact
    func CapturedLocal_InLoopBody_UserEvent_FiresOncePerSubscription() {
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    var Src Source
    var Cnt Counter
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
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let cnt = probeType.GetField("Cnt")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(3, int32(counterType.GetField("Value")!!.GetValue(cnt)!!))
    }

    @Fact
    func CapturedField_AsClosureVariable_UserEvent_Fires() {
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    var Src Source
    var Cnt Counter
    init() {
        Src = Source()
        Cnt = Counter()
        Src.Changed += func(sender object, e EventArgs) {
            Cnt.Increment()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let cnt = probeType.GetField("Cnt")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(cnt)!!))
    }

    @Fact
    func CapturesThis_UserEvent_Fires() {
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Hits int32
    init() {
        Src = Source()
        Hits = 0
        var me = this
        Src.Changed += func(sender object, e EventArgs) {
            me.Bump()
        }
    }
    func Bump() { Hits = Hits + 1 }
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(1, int32(probeType.GetField("Hits")!!.GetValue(probe)!!))
    }

    @Fact
    func MultipleCaptures_InOneLambda_AllObserved() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Add(n int32) { Value = Value + n }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var A Counter
    var B Counter
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
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let a = probeType.GetField("A")!!.GetValue(probe)!!
        let b = probeType.GetField("B")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(3, int32(counterType.GetField("Value")!!.GetValue(a)!!))
        Assert.Equal(4, int32(counterType.GetField("Value")!!.GetValue(b)!!))
    }

    // -----------------------------------------------------------------------
    // CLR (BCL) event sinks — closure must subscribe without aborting emit.
    // -----------------------------------------------------------------------
    @Fact
    func ClrEvent_InsideInstanceMethod_CapturingLocal_CompilesAndVerifies() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    init() { }
    func Subscribe() {
        var counter = Counter()
        var domain = AppDomain.CurrentDomain
        domain.ProcessExit += func(sender object, e EventArgs) {
            counter.Increment()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        Assert.NotNull(assembly)
    }

    @Fact
    func ClrEvent_ChainedReceiver_CapturingLocal_CompilesAndVerifies() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    init() { }
    func Subscribe() {
        var counter = Counter()
        AppDomain.CurrentDomain.ProcessExit += func(sender object, e EventArgs) {
            counter.Increment()
        }
    }
}`
        let assembly = CompileToAssembly(source)
        Assert.NotNull(assembly)
    }

    // -----------------------------------------------------------------------
    // Top-level statement program — closure-into-event from script-style code.
    // -----------------------------------------------------------------------
    @Fact
    func TopLevel_LocalCapture_UserEvent_CompilesAndVerifies() {
        let source = `package MyLib
import System

class Source {
    public event Changed EventHandler
    init() { }
}

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

var src = Source()
var counter = Counter()
src.Changed += func(sender object, e EventArgs) {
    counter.Increment()
}`
        let assembly = CompileToAssembly(source)
        Assert.NotNull(assembly)
    }

    // -----------------------------------------------------------------------
    // Reference-capture semantics — issue #523. A lambda captures the
    // *cell*, not the value at construction time; reassigning the local
    // after subscription is observed by the lambda body.
    // -----------------------------------------------------------------------
    @Fact
    func CapturedLocalReassignedAfterSubscription_LambdaObservesNewBinding() {
        let source = (`package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Original Counter
    var Replacement Counter
    init() {
        Src = Source()
        var c = Counter()
        Original = c
        Src.Changed += func(sender object, e EventArgs) {
            c.Increment()
        }
        // Reassign after subscription. Reference-capture
        // semantics (issue #523): the lambda holds the variable
        // cell, so it observes the new binding and ` + "`" + `c.Increment()` + "`" + `
        // hits the replacement instance, not the original.
        c = Counter()
        Replacement = c
    }
}`)
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let original = probeType.GetField("Original")!!.GetValue(probe)!!
        let replacement = probeType.GetField("Replacement")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        // Reference-capture (issue #523): the lambda follows the cell, so the
        // post-subscription assignment is the one observed. The original
        // counter is untouched; the replacement is the one that fires.
        Assert.Equal(0, int32(counterType.GetField("Value")!!.GetValue(original)!!))
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(replacement)!!))
    }

    // -----------------------------------------------------------------------
    // Nested closures — outer lambda body contains an inner lambda that
    // captures (transitively) a variable from the enclosing method. This is
    // the path that previously surfaced as GS9998 "compiler-internal error:
    // Variable 'counter' has no local slot or parameter index in the current
    // method." It is the broader fix landed alongside #503.
    // -----------------------------------------------------------------------
    @Fact
    func NestedClosure_NoEvent_TransitiveCapture_CompilesAndVerifies() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Probe {
    var Cnt Counter
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
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let cnt = probeType.GetField("Cnt")!!.GetValue(probe)!!
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(cnt)!!))
    }

    @Fact
    func NestedClosure_OuterCapture_InnerSubscribesEvent_FiresAndIncrements() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    var Src Source
    var Cnt Counter
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
}`
        let assembly = CompileToAssembly(source)
        let probeType = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let probe = Activator.CreateInstance(probeType)!!
        let src = probeType.GetField("Src")!!.GetValue(probe)!!
        let cnt = probeType.GetField("Cnt")!!.GetValue(probe)!!
        InvokeBackingDelegate(sourceType, src, "Changed")
        Assert.Equal(1, int32(counterType.GetField("Value")!!.GetValue(cnt)!!))
    }

    @Fact
    func ClosureCapturingLocal_BoundToClrEvent_CompilesAndRuns() {
        let gSource = `package MyLib
import System
import Probe.CSharp

var counter = 0
var src = ClrSource()
src.Changed += func(sender object, e EventArgs) {
    counter = counter + 1
}
src.OnChanged()
src.OnChanged()
System.Console.WriteLine(counter)`
        let output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp")
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func ClosureCapturingLocal_PassedAsClrActionParameter_CompilesAndRuns() {
        let gSource = `package MyLib
import Probe.CSharp

var x = 0
CliEnvironment.RegisterRestore(func() {
    x = x + 1
})
CliEnvironment.FireRestore()
CliEnvironment.FireRestore()
CliEnvironment.FireRestore()
System.Console.WriteLine(x)`
        let output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp")
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func ClosureCapturingLocal_PassedAsClrFuncParameter_CompilesAndRuns() {
        let gSource = `package MyLib
import Probe.CSharp

var x = 10
CliEnvironment.RegisterProvider(func() int32 {
    x = x + 5
    return x
})
var a = CliEnvironment.GetProvidedValue()
var b = CliEnvironment.GetProvidedValue()
System.Console.WriteLine(a)
System.Console.WriteLine(b)`
        let output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp")
        Assert.Equal("15${Environment.NewLine}20${Environment.NewLine}", output)
    }

    @Fact
    func ClosureCapturingMutableLocal_ObservesMutationsThroughDelegate() {
        let gSource = `package MyLib
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
System.Console.WriteLine(x)`
        let output = CompileAndRunWithSiblingCs(SiblingCsSource, gSource, "Probe.CSharp")
        Assert.Equal("0${Environment.NewLine}1${Environment.NewLine}101${Environment.NewLine}", output)
    }

    @Fact
    func NonExistentDelegateTarget_ProducesGSDiagnostic() {
        // Calling a method that doesn't exist should produce a precise GS####
        // diagnostic, not a silent MSB4181 or unhandled exception.
        let gSource = `package MyLib
import Probe.CSharp

var x = 0
CliEnvironment.NoSuchMethod(func() {
    x = x + 1
})`
        let tempDir = Directory.CreateTempSubdirectory("gs_503_neg2_").FullName
        try {
            let csDir = Path.Combine(tempDir, "csref")
            Directory.CreateDirectory(csDir)
            File.WriteAllText(Path.Combine(csDir, "Lib.cs"), SiblingCsSource)
            File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>Probe.CSharp</AssemblyName>
    <RootNamespace>Probe.CSharp</RootNamespace>
  </PropertyGroup>
</Project>`)
            let siblingDll = BuildCsProject(csDir, "Probe.CSharp")
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, gSource)
            let gscArgs = List[string]{
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + siblingDll
            }
            for reference in TrustedPlatformAssemblies() {
                gscArgs.Add("/reference:" + reference)
            }
            gscArgs.Add("/nowarn:GS9100")
            gscArgs.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(gscArgs.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.NotEqual(0, compileExit)
            let combined = compileOut.ToString() + compileErr.ToString()
            // Must surface as a GS#### code, not a silent abort.
            Assert.Matches("GS\\d{4}", combined)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    // -----------------------------------------------------------------------
    // Negative guard — a type error inside a capturing lambda must produce a
    // precise GS#### diagnostic, never a silent MSB4181-style abort.
    // -----------------------------------------------------------------------
    @Fact
    func LambdaBodyTypeError_InCapturingLambda_ProducesGSDiagnostic() {
        let source = `package MyLib
import System

class Counter {
    var Value int32
    init() { Value = 0 }
    func Increment() { Value = Value + 1 }
}

class Source {
    public event Changed EventHandler
    init() { }
}

class Probe {
    init() {
        var s = Source()
        var c = Counter()
        s.Changed += func(sender object, e EventArgs) {
            c.NotARealMethod()
        }
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_503_neg_").FullName
        let srcPath = Path.Combine(tempDir, "test.gs")
        let outPath = Path.Combine(tempDir, "test.dll")
        File.WriteAllText(srcPath, source)
        let compileOut = StringWriter()
        let compileErr = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(compileOut)
        Console.SetError(compileErr)
        var compileExit int32
        try {
            compileExit = Program.Main(
                []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            )
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
        }
        Assert.NotEqual(0, compileExit)
        let combined = compileOut.ToString() + compileErr.ToString()
        // Must surface as a GS#### code, not as a swallowed exception.
        Assert.Matches("GS\\d{4}", combined)
    }

    shared {
        // -----------------------------------------------------------------------
        // CLR delegate parameter shapes — closure → Action / Func / EventHandler
        // passed directly to a CLR method/event declared in a sibling C# assembly.
        // These are the shapes from issue #503's second comment (closure-capturing
        // lambda → CLR delegate conversion via static method parameter).
        // -----------------------------------------------------------------------
        private const SiblingCsSource string = `using System;

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
}`

        // -----------------------------------------------------------------------
        // Shared helpers.
        // -----------------------------------------------------------------------
        private func InvokeBackingDelegate(containingType Type, instance object, eventName string) {
            let backingField FieldInfo? = containingType.GetField(
                eventName,
                BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Public
            )
            Assert.NotNull(backingField)
            let del Delegate? = cast[Delegate](backingField!!.GetValue(instance)!!)
            del!!.DynamicInvoke(instance, EventArgs.Empty)
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_503_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileAndRunWithSiblingCs(csSource string, gSource string, siblingName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_503_sib_").FullName
            try {
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSource)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$siblingName" + `</AssemblyName>
    <RootNamespace>` + "$siblingName" + `</RootNamespace>
  </PropertyGroup>
</Project>`))
                let siblingDll = BuildCsProject(csDir, siblingName)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + siblingDll
                }
                for reference in TrustedPlatformAssemblies() {
                    gscArgs.Add("/reference:" + reference)
                }
                gscArgs.Add("/nowarn:GS9100")
                gscArgs.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(gscArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                File.Copy(siblingDll, Path.Combine(tempDir, Path.GetFileName(siblingDll)), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{siblingDll})
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func BuildCsProject(csDir string, siblingName string) string {
            RunDotnet(csDir, "restore")
            let stdout = RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dll = Path.Combine(csDir, "bin", "Release", "net10.0", siblingName + ".dll")
            Assert.True(File.Exists(dll), "sibling assembly not found at $dll")
            return dll
        }

        private func RunDotnet(workingDir string, args ...string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
            return stdout
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
