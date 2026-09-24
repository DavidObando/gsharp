// <copyright file="BaseMemberGapsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0192 follow-on 2: base-member shapes that the real
/// <c>[GeneratedRegex]</c> output uses once cs2gs back-translates it to G#.
/// A feasibility spike that ran the generator and translated its
/// <c>RegexRunner</c> subclass found three general gsc gaps:
/// <list type="number">
///   <item>compound assignment and increment/decrement of a base-qualified
///   member (<c>base.runtextpos++</c>) reported GS0125;</item>
///   <item><c>base.M()</c> inside a function literal (a translated C# local
///   function) reported GS0383;</item>
///   <item>a <c>protected</c> static member of an imported base
///   (<c>Regex.ValidateMatchTimeout</c>) could not be called from the derived
///   class.</item>
/// </list>
/// <para>
/// Every case compiles with gsc, passes ILVerify, and runs: binding alone
/// cannot show that a base accessor was called non-virtually, or that a
/// base call hosted in a closure verifies.
/// </para>
/// </summary>
public class BaseMemberGapsEmitTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // Gap 1: every compound form on a protected field of an imported base.
        yield return new object[]
        {
            "compound-imported-base-field",
            @"
package P
import System
import System.Text.RegularExpressions

class Runner : RegexRunner {
    func Step() string {
        base.runtextpos = 5
        base.runtextpos++
        ++base.runtextpos
        base.runtextpos += 10
        base.runtextpos--
        let old = base.runtextpos++
        let now = ++base.runtextpos
        return ""$old $now ${base.runtextpos}""
    }
}

Console.WriteLine(Runner().Step())
",
            new[] { "16 18 18" },
        };

        // Gap 1: same-compilation base, overridden property. The base
        // accessors must be called non-virtually for both halves of the
        // compound, or the override's x100 read shows up.
        yield return new object[]
        {
            "compound-overridden-base-property",
            @"
package P
import System

open class Base {
    var store int32 = 1
    protected var f int32
    open prop P int32 {
        get -> store
        set { store = value }
    }
}

class Derived : Base {
    override prop P int32 {
        get -> base.P * 100
        set { }
    }

    func Go() string {
        base.P++
        base.P += 5
        let old = base.P--
        base.f += 3
        --base.f
        return ""$old ${base.P} $P ${base.f}""
    }
}

Console.WriteLine(Derived().Go())
",
            new[] { "7 6 600 2" },
        };

        // Gap 3: the generated Regex constructor validates its timeout through
        // the protected internal static Regex.ValidateMatchTimeout, qualified
        // and unqualified, and from a static member.
        yield return new object[]
        {
            "protected-static-imported-regex",
            @"
package P
import System
import System.Text.RegularExpressions

class Generated : Regex {
    init(timeout TimeSpan) {
        Regex.ValidateMatchTimeout(timeout)
        ValidateMatchTimeout(timeout)
    }

    shared {
        func Probe(timeout TimeSpan) string {
            try {
                ValidateMatchTimeout(timeout)
                return ""valid""
            } catch (e ArgumentOutOfRangeException) {
                return ""rejected""
            }
        }
    }
}

let g = Generated(Regex.InfiniteMatchTimeout)
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(-1.0)))
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(2.0)))
",
            new[] { "rejected", "valid" },
        };

        // Gap 3: same-compilation base. Unqualified inherited static methods,
        // and qualified protected static field and property compound writes.
        yield return new object[]
        {
            "protected-static-source-base",
            @"
package P
import System

open class Base {
    shared {
        protected func Guarded() int32 -> 7
        protected var count int32 = 3
        protected prop Scale int32 { get; set; }
    }
}

class Derived : Base {
    func Go() int32 {
        Base.count++
        Base.Scale = 2
        Base.Scale *= 5
        return Guarded() + Base.count + Base.Scale
    }

    shared {
        func GoStatic() int32 -> Guarded()
    }
}

Console.WriteLine(Derived().Go().ToString())
Console.WriteLine(Derived.GoStatic().ToString())
",
            new[] { "21", "7" },
        };

        // Gap 2: base calls, base auto-property accessors and a base method
        // group inside function literals, including a nested literal and an
        // async member. Every one targets a virtual member the derived class
        // overrides, so a non-virtual call left in the closure method would
        // fail ILVerify (ThisMismatch / LdftnNonFinalVirtual); the forwarder
        // keeps the call on the class's own `this`.
        yield return new object[]
        {
            "base-in-function-literal",
            @"
package P
import System
import System.Threading.Tasks

open class Base {
    open func Name() string { return ""base"" }
    open prop Auto int32 { get; set; }
}

class Derived : Base {
    override func Name() string { return ""derived"" }
    override prop Auto int32 {
        get -> 1000
        set { }
    }

    func Go() string {
        let call = func () string { return base.Name() }
        let prop = func (n int32) int32 {
            base.Auto = n
            let inner = () -> base.Auto + 1
            return inner()
        }
        let group = func () string {
            let h () -> string = base.Name
            return h()
        }
        return ""${call()} ${prop(41)} ${group()} ${Name()}""
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        let f = () -> base.Name()
        return f()
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
",
            new[] { "base 42 base derived", "base" },
        };

        // The forwarder pass now also forwards base auto-property accessors
        // in async and iterator bodies, where `this` is a hoisted state
        // machine field; before, they were left as non-virtual calls there.
        yield return new object[]
        {
            "base-auto-property-in-async-body",
            @"
package P
import System
import System.Threading.Tasks

open class Base {
    open prop Auto int32 { get; set; }
}

class Derived : Base {
    override prop Auto int32 {
        get -> 1000
        set { }
    }

    async func GoAsync(n int32) Task[int32] {
        await Task.Yield()
        base.Auto = n
        base.Auto++
        return base.Auto
    }
}

Console.WriteLine(Derived().GoAsync(6).Result.ToString())
",
            new[] { "7" },
        };

        // Generic, ref, out and in base calls, called directly. A generic base
        // method must be called through a MethodSpec; before, the call named
        // the open method (StackUnexpected, InvalidProgramException).
        yield return new object[]
        {
            "generic-and-byref-base-calls-direct",
            @"
package P
import System

open class Base {
    var total int32 = 5
    open func Id[T](x T) string { return ""base "" + x.ToString() }
    open func Swap[T](ref a T, ref b T) {
        let t = a
        a = b
        b = t
    }
    open func Bump(ref n int32) { n = n + 1 }
    open func TryGet(out v int32) bool {
        v = 42
        return true
    }
    open func Peek(in n int32) int32 -> n * 2
    open func Slot() ref int32 { return ref this.total }
}

class Derived : Base {
    var other int32 = 0
    override func Id[T](x T) string { return ""derived"" }
    override func Swap[T](ref a T, ref b T) { }
    override func Bump(ref n int32) { n = 1000 }
    override func TryGet(out v int32) bool {
        v = -1
        return false
    }
    override func Peek(in n int32) int32 -> -1
    override func Slot() ref int32 { return ref this.other }

    func Go() string {
        var n int32 = 1
        base.Bump(ref n)
        var v int32 = 0
        let ok = base.TryGet(out v)
        let k int32 = 5
        var a = ""x""
        var b = ""y""
        base.Swap(ref a, ref b)
        let slot = base.Slot()
        return base.Id[int32](7) + "" "" + base.Id(""s"") + "" $n $ok $v ${base.Peek(in k)} $a$b $slot""
    }
}

Console.WriteLine(Derived().Go())
",
            new[] { "base 7 base s 2 True 42 10 yx 5" },
        };

        // The same shapes inside function literals and an async body, where
        // each goes through a forwarder: a generic forwarder for a generic
        // base method (constraints carried over), by-reference parameters kept
        // by-reference, and a ref-returning forwarder for a ref return.
        yield return new object[]
        {
            "generic-and-byref-base-calls-forwarded",
            @"
package P
import System
import System.Threading.Tasks

open class Base {
    var total int32 = 5
    open func Id[T](x T) string { return ""base "" + x.ToString() }
    open func Swap[T](ref a T, ref b T) {
        let t = a
        a = b
        b = t
    }
    open func Pick[T IComparable[T]](a T, b T) T -> a.CompareTo(b) > 0 ? a : b
    open func Bump(ref n int32) { n = n + 1 }
    open func TryGet(out v int32) bool {
        v = 42
        return true
    }
    open func Peek(in n int32) int32 -> n * 2
    open func Slot() ref int32 { return ref this.total }
}

class Derived : Base {
    var other int32 = 0
    override func Id[T](x T) string { return ""derived"" }
    override func Swap[T](ref a T, ref b T) { }
    override func Pick[T IComparable[T]](a T, b T) T -> b
    override func Bump(ref n int32) { n = 1000 }
    override func TryGet(out v int32) bool {
        v = -1
        return false
    }
    override func Peek(in n int32) int32 -> -1
    override func Slot() ref int32 { return ref this.other }

    func Go() string {
        let f = func () string {
            var n int32 = 1
            base.Bump(ref n)
            var v int32 = 0
            let ok = base.TryGet(out v)
            let k int32 = 5
            var a = ""x""
            var b = ""y""
            base.Swap[string](ref a, ref b)
            let slot = base.Slot()
            let group (int32) -> string = base.Id
            return base.Id[int32](7) + "" "" + base.Id(""s"") + "" $n $ok $v ${base.Peek(in k)} $a$b ${base.Pick(3, 9)} $slot "" + group(1)
        }
        return f()
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        var n int32 = 1
        base.Bump(ref n)
        var v int32 = 0
        let ok = base.TryGet(out v)
        var a = 1
        var b = 2
        base.Swap(ref a, ref b)
        return base.Id[int32](8) + "" $n $ok $v $a$b ${base.Pick(4, 2)}""
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
",
            new[] { "base 7 base s 2 True 42 10 yx 9 5 base 1", "base 8 2 True 42 21 4" },
        };

        // A forwarder for a method of a generic base class names the type
        // arguments the derived class passes to that base, not the base's
        // own type parameters. An imported base's out parameter stays out.
        yield return new object[]
        {
            "forwarded-generic-base-class-and-imported-out",
            @"
package P
import System
import System.Collections.Generic
import System.Threading.Tasks

open class Base[T] {
    open func M(x T) string -> ""base "" + x.ToString()
    open func G[U](x T, y U) string -> ""baseG "" + x.ToString() + y.ToString()
}

class D : Base[int32] {
    override func M(x int32) string -> ""derived""
    override func G[U](x int32, y U) string -> ""derivedG""
    func Go() string {
        let f = () -> base.M(3) + "" "" + base.G(4, ""u"")
        return f()
    }
}

class E[V] : Base[V] {
    override func M(x V) string -> ""derivedE""
    func Go(v V) string {
        let f = () -> base.M(v)
        return f()
    }
}

class Dict : Dictionary[string, int32] {
    func Go() string {
        base.Add(""k"", 5)
        let f = func () string {
            var v int32 = 0
            let ok = base.TryGetValue(""k"", out v)
            return ""$ok $v""
        }
        return f()
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        var v int32 = 0
        let ok = base.TryGetValue(""k"", out v)
        return ""$ok $v""
    }
}

Console.WriteLine(D().Go())
Console.WriteLine(E[string]().Go(""s""))
let d = Dict()
Console.WriteLine(d.Go())
Console.WriteLine(d.GoAsync().Result)
",
            new[] { "base 3 baseG 4u", "base s", "True 5", "True 5" },
        };

        // `base.E += h` / `base.E -= h` on non-virtual source and imported
        // events, including from a function literal.
        yield return new object[]
        {
            "base-event-subscription",
            @"
package P
import System
import System.ComponentModel

open class Base {
    event Changed EventHandler?
    func Fire() {
        Changed?.Invoke(this, EventArgs.Empty)
    }
}

class Derived : Base {
    func Go() {
        let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine(""handler"") }
        let subscribe = func () { base.Changed += h }
        subscribe()
        this.Fire()
        base.Changed -= h
        this.Fire()
    }
}

class Part : Component {
    func Go() {
        base.Disposed += func (s object?, e EventArgs) { Console.WriteLine(""disposed"") }
        this.Dispose()
    }
}

Derived().Go()
Part().Go()
",
            new[] { "handler", "disposed" },
        };

        // `base.P ??= v` on source and imported properties, directly and in a
        // function literal.
        yield return new object[]
        {
            "base-property-null-coalescing-assignment",
            @"
package P
import System

open class Base {
    var store string?
    open prop Q string? {
        get -> store
        set { store = value }
    }
    open prop Auto string? { get; set; }
}

class Derived : Base {
    override prop Q string? {
        get -> ""d""
        set { }
    }
    override prop Auto string? {
        get -> ""d""
        set { }
    }

    func Go() string {
        base.Q ??= ""q1""
        base.Q ??= ""q2""
        let f = func () { base.Auto ??= ""a1"" }
        f()
        base.Auto ??= ""a2""
        return ""${base.Q} ${base.Auto}""
    }
}

class Err : Exception {
    func Go() string? {
        base.HelpLink ??= ""h1""
        base.HelpLink ??= ""h2""
        return base.HelpLink
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Err().Go())
",
            new[] { "q1 a1", "h1" },
        };

        // `base.E += h` / `-=` when the derived class declares a same-named
        // event: the subscription must reach the base event's accessors.
        yield return new object[]
        {
            "base-event-shadowed-by-derived-event",
            @"
package P
import System
import System.ComponentModel

open class Base {
    event Changed EventHandler?
    func FireBase() { Changed?.Invoke(this, EventArgs.Empty) }
}

class Derived : Base {
    event Changed EventHandler?
    func FireDerived() { Changed?.Invoke(this, EventArgs.Empty) }

    func Go() {
        let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine(""base handler"") }
        base.Changed += h
        this.FireDerived()
        this.FireBase()
        let unsubscribe = func () { base.Changed -= h }
        unsubscribe()
        this.FireBase()
        let subscribe = func () { base.Changed += h }
        subscribe()
        this.FireBase()
    }
}

class Comp : Component {
    event Disposed EventHandler?
    func Go() {
        base.Disposed += func (s object?, e EventArgs) { Console.WriteLine(""component disposed"") }
        this.Dispose()
    }
}

Derived().Go()
Comp().Go()
",
            new[] { "base handler", "base handler", "component disposed" },
        };

        // Forwarded calls to async and iterator base methods of a generic base
        // class: the forwarder returns what the base method returns as
        // emitted (Task, Task<T>, the sequence), not the G#-declared result.
        // A `void` forwarder for `async func Complete()` left the Task on the
        // stack (ILVerify ReturnVoid / StackUnderflow).
        yield return new object[]
        {
            "forwarded-async-and-iterator-base-calls",
            @"
package P
import System
import System.Threading.Tasks

open class FilterC[TInput] {
    open async func Complete() {
        await Task.Yield()
        Console.WriteLine(""base complete"")
    }
    open async func Echo[T](x T) T {
        await Task.Yield()
        return x
    }
    open async func Count() int32 {
        await Task.Yield()
        return 7
    }
    open func Items() sequence[int32] {
        yield 1
        yield 2
    }
}

class TransformC[TInput, TOutput] : FilterC[TInput] {
    override async func Complete() {
        await base.Complete()
        let f = () -> base.Complete()
        await f()
    }
    override async func Echo[T](x T) T { return x }
    override async func Count() int32 { return -1 }
    override func Items() sequence[int32] { yield 9 }

    async func Go() string {
        let a = await base.Echo(""e"")
        let g = () -> base.Echo(4)
        let b = await g()
        let c = await base.Count()
        let h = () -> base.Count()
        let d = await h()
        var sum = 0
        let it = () -> base.Items()
        for x in it() { sum += x }
        return ""$a $b $c $d $sum""
    }
}

let t = TransformC[int32, string]()
t.Complete().Wait()
Console.WriteLine(t.Go().Result)
",
            new[] { "base complete", "base complete", "e 4 7 7 3" },
        };

        // Issue #4331: postfix chains after a base member, read and write,
        // on source and imported bases, directly and in a function literal.
        yield return new object[]
        {
            "base-member-postfix-chains",
            @"
package P
import System
import System.Text
import System.Text.RegularExpressions

class Box {
    var Field int32
    func M() StringBuilder -> StringBuilder(""sb"")
}

open class Base {
    protected var f int32 = 1
    protected var arr []int32 = []int32{4, 5}
    protected var obj Box = Box()
    var p string = ""hello""
    open prop P string {
        get -> p
        set { p = value }
    }
}

class Derived : Base {
    override prop P string {
        get -> ""overridden!""
        set { }
    }

    func Go() string {
        base.arr[0] = 9
        base.obj.Field = 7
        base.obj.Field += 1
        let direct = ""${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[0]} ${base.obj.Field}""
        let inLiteral = func () string {
            base.arr[1] = 6
            base.obj.Field = 3
            return ""${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[1]} ${base.obj.Field}""
        }
        return direct + "" | "" + inLiteral()
    }
}

class Pattern : Regex {
    init() : base(""abcd"") { }

    func Go() string {
        let inLiteral = () -> base.pattern?.Length ?? -1
        return ""${base.pattern?.Length ?? -1} ${inLiteral()}""
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Pattern().Go())
",
            new[] { "1 5 2 9 8 | 1 5 2 6 3", "4 4" },
        };

        // All three gaps in the shape the [GeneratedRegex] output takes after
        // cs2gs: a Regex subclass validating its timeout through the
        // protected static Regex.ValidateMatchTimeout, and a RegexRunner
        // subclass that increments base.runtextpos and calls base.Crawlpos()
        // from a translated local function.
        yield return new object[]
        {
            "regex-generated-shape",
            @"
package P
import System
import System.Text.RegularExpressions

class GeneratedRegex : Regex {
    init(timeout TimeSpan) {
        ValidateMatchTimeout(timeout)
        Regex.ValidateMatchTimeout(timeout)
    }
}

class GeneratedRunner : RegexRunner {
    func Scan(start int32) string {
        base.runtextpos = start
        base.runcrawl = []int32{0, 0, 0, 0, 0}
        base.runcrawlpos = 2
        let uncapture = func () int32 {
            base.runtextpos++
            return base.Crawlpos()
        }
        let crawled = uncapture()
        ++base.runtextpos
        base.runtextpos += crawled
        return ""${base.runtextpos} $crawled""
    }
}

let r = GeneratedRegex(Regex.InfiniteMatchTimeout)
Console.WriteLine(GeneratedRunner().Scan(10))
",
            new[] { "15 3" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void BaseMemberShape_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_basegaps_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(exit == 0, $"gsc failed for '{name}':\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var outPath = Path.Combine(tempDir, name + ".dll");
            IlVerifier.Verify(outPath);

            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"'{name}' must run to completion. Exit {runExit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Gap 3 against an imported base that declares <c>protected</c> static
    /// fields, properties and methods. The BCL has no public base class with
    /// a protected static field or property, so a C# library supplies one. A
    /// protected static member is reached qualified by the base's name and,
    /// for methods, unqualified; an unrelated class is still refused.
    /// </summary>
    [Fact]
    public void ImportedProtectedStaticFieldPropertyAndMethod_CompileVerifyAndRun()
    {
        const string csSource = """
            namespace BaseGaps.CSharp
            {
                public class Counter
                {
                    protected static int count = 1;
                    protected internal static int Scale { get; set; } = 2;
                    protected static string Tag(int value) => "t" + value;
                    public static int Peek() => count * 1000 + Scale;
                }
            }
            """;

        const string source = @"
package P
import System
import BaseGaps.CSharp

class Derived : Counter {
    func Go() string {
        Counter.count += 4
        Counter.count++
        Counter.Scale = Counter.Scale * 10
        Counter.Scale--
        return Tag(Counter.count) + "" "" + Counter.Tag(Counter.Scale)
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Counter.Peek().ToString())
";

        const string rejected = @"
package P
import BaseGaps.CSharp

class Unrelated {
    func Go() int32 -> Counter.count
}
";

        var tempDir = Directory.CreateTempSubdirectory("gs_basegaps_cs_").FullName;
        try
        {
            var library = BuildCsLibrary(tempDir, csSource, "BaseGaps.CSharp");

            var (exit, stdout, stderr) = Compile(tempDir, "imported-protected-static", source, library);
            Assert.True(exit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var outPath = Path.Combine(tempDir, "imported-protected-static.dll");
            IlVerifier.Verify(outPath, new[] { library });
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true);

            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"program must run to completion. Exit {runExit}:\n{output}");
            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(new[] { "t6 t19", "6019" }, lines);

            var (rejectedExit, rejectedStdout, rejectedStderr) = Compile(tempDir, "imported-protected-static-rejected", rejected, library);
            Assert.True(
                rejectedExit != 0,
                $"an unrelated class must not reach a protected static field.\nstdout:\n{rejectedStdout}\nstderr:\n{rejectedStderr}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var csDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <RunAnalyzers>false</RunAnalyzers>
                <NoWarn>1591</NoWarn>
                <AssemblyName>{assemblyName}</AssemblyName>
              </PropertyGroup>
            </Project>
            """);

        var outDir = Path.Combine(csDir, "out");
        var (exit, output) = RunProcess(csDir, "dotnet", "build", "-c", "Release", "--nologo", "-o", outDir);
        Assert.True(exit == 0, $"building the C# library failed:\n{output}");
        var dll = Path.Combine(outDir, assemblyName + ".dll");
        Assert.True(File.Exists(dll), $"C# library not found at {dll}");
        return dll;
    }

    private static (int Exit, string Output) RunProcess(string workingDir, string fileName, params string[] args)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException($"could not start {fileName}");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdoutTask.Result + stderr);
    }

    private static (int Exit, string Stdout, string Stderr) Compile(string tempDir, string name, string source, params string[] extraReferences)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, name + ".dll");

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies().Concat(extraReferences))
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
