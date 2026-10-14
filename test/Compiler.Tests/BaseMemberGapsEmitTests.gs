// <copyright file="BaseMemberGapsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// ADR-0192 follow-on 2: base-member shapes that the real
/// `[GeneratedRegex]` output uses once cs2gs back-translates it to G#.
/// A feasibility spike that ran the generator and translated its
/// `RegexRunner` subclass found three general gsc gaps:
/// 1. compound assignment and increment/decrement of a base-qualified member (`base.runtextpos++`)
/// reported GS0125;
/// 2. `base.M()` inside a function literal (a translated C# local function) reported GS0383;
/// 3. a `protected` static member of an imported base (`Regex.ValidateMatchTimeout`) could not be
/// called from the derived class.
///
/// Every case compiles with gsc, passes ILVerify, and runs: binding alone
/// cannot show that a base accessor was called non-virtually, or that a
/// base call hosted in a closure verifies.
open class BaseMemberGapsEmitTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func BaseMemberShape_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_").FullName
        try {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, name + ".dll")
            IlVerifier.Verify(outPath)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Gap 3 against an imported base that declares `protected` static
    /// fields, properties and methods. The BCL has no public base class with
    /// a protected static field or property, so a C# library supplies one. A
    /// protected static member is reached qualified by the base's name and,
    /// for methods, unqualified; an unrelated class is still refused.
    @Fact
    func ImportedProtectedStaticFieldPropertyAndMethod_CompileVerifyAndRun() {
        const csSource = `namespace BaseGaps.CSharp
{
    public class Counter
    {
        protected static int count = 1;
        protected internal static int Scale { get; set; } = 2;
        protected static string Tag(int value) => "t" + value;
        public static int Peek() => count * 1000 + Scale;
    }
}`
        const source = `
package P
import System
import BaseGaps.CSharp

class Derived : Counter {
    func Go() string {
        Counter.count += 4
        Counter.count++
        Counter.Scale = Counter.Scale * 10
        Counter.Scale--
        return Tag(Counter.count) + " " + Counter.Tag(Counter.Scale)
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Counter.Peek().ToString())
`
        const rejected = `
package P
import BaseGaps.CSharp

class Unrelated {
    func Go() int32 -> Counter.count
}
`
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_cs_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csSource, "BaseGaps.CSharp")
            let (exit, stdout, stderr) = Compile(tempDir, "imported-protected-static", source, library)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, "imported-protected-static.dll")
            IlVerifier.Verify(outPath, []string{library})
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"t6 t19", "6019"}, lines)
            let (rejectedExit, rejectedStdout, rejectedStderr) = Compile(
                tempDir,
                "imported-protected-static-rejected",
                rejected,
                library
            )
            Assert.True(rejectedExit != 0, (`an unrelated class must not reach a protected static field.
stdout:
` + "$rejectedStdout" + `
stderr:
` + "$rejectedStderr"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A function literal (or async body) inside a generic member passes the
    /// member's type parameter to a generic IMPORTED base method. The
    /// forwarder must declare its own clone of that parameter (constraints
    /// remapped) instead of naming the enclosing method's MVAR while
    /// declaring none (BadImageFormatException, StackUnexpected).
    @Fact
    func ImportedGenericBaseCall_WithEnclosingMethodTypeParameter_CompileVerifyAndRun() {
        const csSource = `using System;

namespace BaseGaps.Enclosing
{
    public class GBase
    {
        public virtual string Echo<U>(U x) => "base " + x;
        public virtual U Id<U>(U x) => x;
        public virtual string Max<U>(U a, U b) where U : IComparable<U> => a.CompareTo(b) >= 0 ? "max " + a : "max " + b;
    }
}`
        const source = `
package P
import System
import System.Threading.Tasks
import BaseGaps.Enclosing

class D : GBase {
    override func Echo[U](x U) string -> "derived"
    override func Id[U](x U) U -> x
    override func Max[U IComparable[U]](a U, b U) string -> "derived"

    func Go[T IComparable[T]](x T, y T) string {
        let f = () -> base.Echo[T](x)
        let g = () -> base.Id(x)
        let m = () -> base.Max(x, y)
        return f() + " | " + g().ToString() + " | " + m()
    }

    async func GoAsync[T](x T) Task[string] {
        await Task.Yield()
        return base.Echo(x)
    }
}

Console.WriteLine(D().Go("a", "b"))
Console.WriteLine(D().Go(4, 2))
Console.WriteLine(D().GoAsync(9).Result)
`
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_mvar_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csSource, "BaseGaps.Enclosing")
            let (exit, stdout, stderr) = Compile(tempDir, "imported-enclosing-mvar", source, library)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, "imported-enclosing-mvar.dll")
            IlVerifier.Verify(outPath, []string{library})
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"base a | a | max b", "base 4 | 4 | max 4", "base 9"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Only a DEPENDENT type parameter reaches the imported base call
    /// (`TDerived TBase`, or the chain `A`, `B A`, `C B` using only `C`). The
    /// forwarder must clone the whole constraint closure; cloning `TDerived`
    /// alone left its bound naming an MVAR the forwarder does not declare
    /// (TypeLoadException, ILVerify crash). Async bodies are used because a
    /// function literal capturing a dependent-bound value fails independently
    /// of base calls (closure-class reification, reproducible on main).
    @Fact
    func ImportedGenericBaseCall_WithDependentEnclosingTypeParameter_CompileVerifyAndRun() {
        const csSource = `namespace BaseGaps.Dependent
{
    public class GBase
    {
        public virtual string Echo<U>(U x) => "base " + x;
    }
}`
        const source = `
package P
import System
import System.Threading.Tasks
import BaseGaps.Dependent

class D : GBase {
    override func Echo[U](x U) string -> "derived"

    async func GoAsync[TBase, TDerived TBase](x TDerived) Task[string] {
        await Task.Yield()
        return base.Echo(x)
    }

    async func Chain[A, B A, C B](x C) Task[string] {
        await Task.Yield()
        return base.Echo(x)
    }
}

Console.WriteLine(D().GoAsync[object, string]("a").Result)
Console.WriteLine(D().Chain[object, Exception, ArgumentException](ArgumentException("c")).Result)
`
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_dep_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csSource, "BaseGaps.Dependent")
            let (exit, stdout, stderr) = Compile(tempDir, "imported-dependent-mvar", source, library)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, "imported-dependent-mvar.dll")
            IlVerifier.Verify(outPath, []string{library})
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"base a", "base System.ArgumentException: c"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Two imported-base shapes against an in-process C# contract:
    /// - a protected static property with one private accessor is read or written only through its visible
    /// accessor (the read used to emit a call to the private getter: MethodAccessException);
    /// - `base.Changed += h` on `Source[Item]` over a same-compilation `Item` uses the constructed
    /// `EventHandler[Item]` and add/remove parent, directly and in a function literal (the erased
    /// `EventHandler[object]` was rejected, GS0155).
    @Fact
    func ImportedStaticAccessorVisibilityAndConstructedBaseEvent_CompileVerifyAndRun() {
        const csSource = `using System;

namespace BaseGaps.Accessors
{
    public class Holder
    {
        protected static int ReadHidden { private get; set; } = 1;
        protected static int WriteHidden { get; private set; } = 2;
        public static int Peek() => ReadHidden * 10 + WriteHidden;
    }

    public class Source<T>
    {
        public event EventHandler<T>? Changed;
        public void Raise(T value) => Changed?.Invoke(this, value);
    }
}`
        const source = `
package P
import System
import BaseGaps.Accessors

class D : Holder {
    func Go() string {
        Holder.ReadHidden = 7
        let w = Holder.WriteHidden
        return w.ToString() + " " + Holder.Peek().ToString()
    }
}

class Item {
    var Name string = "item"
}

class Derived : Source[Item] {
    func Go() {
        base.Changed += func (s object?, e Item) { Console.WriteLine("direct ${e.Name}") }
        let subscribe = func () {
            base.Changed += func (s object?, e Item) { Console.WriteLine("lambda ${e.Name}") }
        }
        subscribe()
        this.Raise(Item())
    }
}

Console.WriteLine(D().Go())
Derived().Go()
`
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_acc_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csSource, "BaseGaps.Accessors")
            let (exit, stdout, stderr) = Compile(tempDir, "imported-accessors", source, library)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, "imported-accessors.dll")
            IlVerifier.Verify(outPath, []string{library})
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"2 72", "direct item", "lambda item"}, lines)
            const rejected = `
package P
import BaseGaps.Accessors

class D : Holder {
    func Go() int32 -> Holder.ReadHidden
}
`
            let (rejectedExit, rejectedStdout, rejectedStderr) = Compile(
                tempDir,
                "imported-accessors-rejected",
                rejected,
                library
            )
            Assert.True(rejectedExit != 0, (`reading a property through its private getter must not compile.
stdout:
` + "$rejectedStdout" + `
stderr:
` + "$rejectedStderr"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// An imported base whose nearer level declares a delegate FIELD named
    /// like a farther level's event: `base.E += h` combines into the
    /// field, and the farther event stays unsubscribed.
    @Fact
    func ImportedNearerValueMember_HidesFartherBaseEvent_CompileVerifyAndRun() {
        const csSource = `using System;

namespace BaseGaps.Hiding
{
    public class Far
    {
        public event EventHandler? E;
        public void FireFar() => E?.Invoke(this, EventArgs.Empty);
    }

    public class Mid : Far
    {
        public new EventHandler? E;
    }
}`
        const source = `
package P
import System
import BaseGaps.Hiding

class Derived : Mid {
    func Go() {
        base.E += func (s object?, e EventArgs) { Console.WriteLine("field handler") }
        this.FireFar()
        Console.WriteLine("far fired")
        base.E?.Invoke(this, EventArgs.Empty)
    }
}

Derived().Go()
`
        let tempDir = Directory.CreateTempSubdirectory("gs_basegaps_hiding_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csSource, "BaseGaps.Hiding")
            let (exit, stdout, stderr) = Compile(tempDir, "imported-hiding", source, library)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, "imported-hiding.dll")
            IlVerifier.Verify(outPath, []string{library})
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"far fired", "field handler"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // Gap 1: every compound form on a protected field of an imported base.
            yield[]object{"compound-imported-base-field", `
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
        return "$old $now ${base.runtextpos}"
    }
}

Console.WriteLine(Runner().Step())
`, []string{"16 18 18"}}
            // Gap 1: same-compilation base, overridden property. The base
            // accessors must be called non-virtually for both halves of the
            // compound, or the override's x100 read shows up.
            yield[]object{"compound-overridden-base-property", `
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
        return "$old ${base.P} $P ${base.f}"
    }
}

Console.WriteLine(Derived().Go())
`, []string{"7 6 600 2"}}
            // Gap 3: the generated Regex constructor validates its timeout through
            // the protected internal static Regex.ValidateMatchTimeout, qualified
            // and unqualified, and from a static member.
            yield[]object{"protected-static-imported-regex", `
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
                return "valid"
            } catch (e ArgumentOutOfRangeException) {
                return "rejected"
            }
        }
    }
}

let g = Generated(Regex.InfiniteMatchTimeout)
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(-1.0)))
Console.WriteLine(Generated.Probe(TimeSpan.FromSeconds(2.0)))
`, []string{"rejected", "valid"}}
            // Gap 3: same-compilation base. Unqualified inherited static methods,
            // and qualified protected static field and property compound writes.
            yield[]object{"protected-static-source-base", `
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
`, []string{"21", "7"}}
            // Gap 2: base calls, base auto-property accessors and a base method
            // group inside function literals, including a nested literal and an
            // async member. Every one targets a virtual member the derived class
            // overrides, so a non-virtual call left in the closure method would
            // fail ILVerify (ThisMismatch / LdftnNonFinalVirtual); the forwarder
            // keeps the call on the class's own `this`.
            yield[]object{"base-in-function-literal", `
package P
import System
import System.Threading.Tasks

open class Base {
    open func Name() string { return "base" }
    open prop Auto int32 { get; set; }
}

class Derived : Base {
    override func Name() string { return "derived" }
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
        return "${call()} ${prop(41)} ${group()} ${Name()}"
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        let f = () -> base.Name()
        return f()
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
`, []string{"base 42 base derived", "base"}}
            // The forwarder pass now also forwards base auto-property accessors
            // in async and iterator bodies, where `this` is a hoisted state
            // machine field; before, they were left as non-virtual calls there.
            yield[]object{"base-auto-property-in-async-body", `
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
`, []string{"7"}}
            // Generic, ref, out and in base calls, called directly. A generic base
            // method must be called through a MethodSpec; before, the call named
            // the open method (StackUnexpected, InvalidProgramException).
            yield[]object{"generic-and-byref-base-calls-direct", `
package P
import System

open class Base {
    var total int32 = 5
    open func Id[T](x T) string { return "base " + x.ToString() }
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
    override func Id[T](x T) string { return "derived" }
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
        var a = "x"
        var b = "y"
        base.Swap(ref a, ref b)
        let slot = base.Slot()
        return base.Id[int32](7) + " " + base.Id("s") + " $n $ok $v ${base.Peek(in k)} $a$b $slot"
    }
}

Console.WriteLine(Derived().Go())
`, []string{"base 7 base s 2 True 42 10 yx 5"}}
            // The same shapes inside function literals and an async body, where
            // each goes through a forwarder: a generic forwarder for a generic
            // base method (constraints carried over), by-reference parameters kept
            // by-reference, and a ref-returning forwarder for a ref return.
            yield[]object{"generic-and-byref-base-calls-forwarded", `
package P
import System
import System.Threading.Tasks

open class Base {
    var total int32 = 5
    open func Id[T](x T) string { return "base " + x.ToString() }
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
    override func Id[T](x T) string { return "derived" }
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
            var a = "x"
            var b = "y"
            base.Swap[string](ref a, ref b)
            let slot = base.Slot()
            let group (int32) -> string = base.Id
            return base.Id[int32](7) + " " + base.Id("s") + " $n $ok $v ${base.Peek(in k)} $a$b ${base.Pick(3, 9)} $slot " + group(1)
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
        return base.Id[int32](8) + " $n $ok $v $a$b ${base.Pick(4, 2)}"
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
`, []string{"base 7 base s 2 True 42 10 yx 9 5 base 1", "base 8 2 True 42 21 4"}}
            // A forwarder for a method of a generic base class names the type
            // arguments the derived class passes to that base, not the base's
            // own type parameters. An imported base's out parameter stays out.
            yield[]object{"forwarded-generic-base-class-and-imported-out", `
package P
import System
import System.Collections.Generic
import System.Threading.Tasks

open class Base[T] {
    open func M(x T) string -> "base " + x.ToString()
    open func G[U](x T, y U) string -> "baseG " + x.ToString() + y.ToString()
}

class D : Base[int32] {
    override func M(x int32) string -> "derived"
    override func G[U](x int32, y U) string -> "derivedG"
    func Go() string {
        let f = () -> base.M(3) + " " + base.G(4, "u")
        return f()
    }
}

class E[V] : Base[V] {
    override func M(x V) string -> "derivedE"
    func Go(v V) string {
        let f = () -> base.M(v)
        return f()
    }
}

class Dict : Dictionary[string, int32] {
    func Go() string {
        base.Add("k", 5)
        let f = func () string {
            var v int32 = 0
            let ok = base.TryGetValue("k", out v)
            return "$ok $v"
        }
        return f()
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        var v int32 = 0
        let ok = base.TryGetValue("k", out v)
        return "$ok $v"
    }
}

Console.WriteLine(D().Go())
Console.WriteLine(E[string]().Go("s"))
let d = Dict()
Console.WriteLine(d.Go())
Console.WriteLine(d.GoAsync().Result)
`, []string{"base 3 baseG 4u", "base s", "True 5", "True 5"}}
            // `base.E += h` / `base.E -= h` on non-virtual source and imported
            // events, including from a function literal.
            yield[]object{"base-event-subscription", `
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
        let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine("handler") }
        let subscribe = func () { base.Changed += h }
        subscribe()
        this.Fire()
        base.Changed -= h
        this.Fire()
    }
}

class Part : Component {
    func Go() {
        base.Disposed += func (s object?, e EventArgs) { Console.WriteLine("disposed") }
        this.Dispose()
    }
}

Derived().Go()
Part().Go()
`, []string{"handler", "disposed"}}
            // `base.P ??= v` on source and imported properties, directly and in a
            // function literal.
            yield[]object{"base-property-null-coalescing-assignment", `
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
        get -> "d"
        set { }
    }
    override prop Auto string? {
        get -> "d"
        set { }
    }

    func Go() string {
        base.Q ??= "q1"
        base.Q ??= "q2"
        let f = func () { base.Auto ??= "a1" }
        f()
        base.Auto ??= "a2"
        return "${base.Q} ${base.Auto}"
    }
}

class Err : Exception {
    func Go() string? {
        base.HelpLink ??= "h1"
        base.HelpLink ??= "h2"
        return base.HelpLink
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Err().Go())
`, []string{"q1 a1", "h1"}}
            // Issue #2834 on base-qualified targets: a user-defined compound
            // operator on the member's type runs (not GS0129, and not the binary
            // `+` when both are declared). A property is read once and a
            // value-type result is written back through the base setter.
            yield[]object{"base-member-user-compound-operators", `
package P
import System

class Bag {
    var total int32
    prop Total int32 { get { return total } }
    func operator +=(amount int32) {
        Console.WriteLine("Bag.+= $amount")
        total = total + amount
    }
}

struct Meter {
    var Total int32
    func operator +=(amount int32) {
        Console.WriteLine("Meter.+= $amount")
        Total = Total + amount
    }
}

struct Both {
    var Total int32
    func operator +=(amount int32) {
        Console.WriteLine("Both.+= $amount")
        Total = Total + amount
    }
}

func (a Both) operator +(amount int32) Both {
    Console.WriteLine("Both.+ $amount")
    return Both{Total: a.Total + amount}
}

open class Base {
    protected var bag Bag = Bag()
    protected var meter Meter
    protected var both Both
    var backing Meter
    var reads int32
    prop Value Meter {
        get {
            reads = reads + 1
            return backing
        }
        set { backing = value }
    }
    prop Reads int32 { get { return reads } }
}

class Derived : Base {
    func Go() string {
        base.bag += 2
        base.meter += 3
        base.both += 4
        base.Value += 5
        base.Value++
        let f = func () { base.meter++ }
        f()
        let old = base.meter++
        let updated = ++base.meter
        Console.WriteLine("old ${old.Total} updated ${updated.Total}")
        return "${base.bag.Total} ${base.meter.Total} ${base.both.Total} ${base.Value.Total} ${base.Reads}"
    }
}

Console.WriteLine(Derived().Go())
`, []string{
                    "Bag.+= 2",
                    "Meter.+= 3",
                    "Both.+= 4",
                    "Meter.+= 5",
                    "Meter.+= 1",
                    "Meter.+= 1",
                    "Meter.+= 1",
                    "Meter.+= 1",
                    "old 4 updated 6",
                    "2 6 4 6 3"
                }}
            // A generic base method whose type parameter is bounded by the base
            // class's own type parameter (`M[U T1, V T2]` on `Base2[T1, T2]`).
            // When the derived class closes `T1`, the forwarder's clone must carry
            // the concrete bound (`Animal`), not a VAR the forwarder's class does
            // not have (UnsatisfiedMethodInst / VerificationException). The test
            // covers fully and partially closed bases, a call and a method group.
            yield[]object{"forwarded-generic-method-with-dependent-bound", `
package P
import System

open class Animal {
    open func Name() string -> "animal"
}
class Dog : Animal {
    override func Name() string -> "dog"
}

open class Base2[T1, T2] {
    open func M[U T1, V T2](u U, v V) string -> "base2 " + u.ToString() + " " + v.ToString()
}

class Derived[B] : Base2[Animal, B] {
    override func M[U Animal, V B](u U, v V) string -> "derived"
    func Go(b B) string {
        let f = () -> base.M(Dog(), b)
        return f()
    }
}

class Zoo : Base2[Animal, Animal] {
    override func M[U Animal, V Animal](u U, v V) string -> "zoo"
    func Go() string {
        let f = () -> base.M(Dog(), Animal())
        let group = func () string {
            let m (Dog, Dog) -> string = base.M
            return m(Dog(), Dog())
        }
        return f() + " | " + group()
    }
}

Console.WriteLine(Derived[string]().Go("s"))
Console.WriteLine(Zoo().Go())
`, []string{"base2 P.Dog s", "base2 P.Dog P.Animal | base2 P.Dog P.Dog"}}
            // The source-base counterpart: an enclosing method's type parameter
            // flows into a generic source base method and a generic base class's
            // method from function literals, as a call and a method group.
            yield[]object{"forwarded-source-base-call-with-enclosing-method-type-parameter", `
package P
import System

open class SBase[V] {
    open func Echo[U](x U) string { return "sbase " + x.ToString() }
    open func M(v V) string { return "sbase.M " + v.ToString() }
}

class S[V] : SBase[V] {
    override func Echo[U](x U) string -> "derived"
    override func M(v V) string -> "derived.M"
    func Go[T](x T, v V) string {
        let f = () -> base.Echo[T](x)
        let g = () -> base.Echo(x)
        let m = () -> base.M(v)
        let h = func () string {
            let e (T) -> string = base.Echo
            return e(x)
        }
        return f() + " | " + g() + " | " + m() + " | " + h()
    }
}

Console.WriteLine(S[int32]().Go("s", 3))
`, []string{"sbase s | sbase s | sbase.M 3 | sbase s"}}
            // A dependent bound closed over a VALUE type (`M[U T]` reached through
            // `Derived : Base[int32]`) gives the forwarder's clone the constraint
            // `U : System.Int32`. C# source cannot spell that, but ECMA-335
            // allows any type as a generic-parameter constraint, and Roslyn emits
            // the same `<>n__0<U> where U : System.Int32` for the equivalent C#
            // lambda / async base call. Pinned so it stays verifiable and runs.
            yield[]object{"forwarded-dependent-bound-closed-over-value-type", `
package P
import System
import System.Threading.Tasks

open class Base[T] {
    open func M[U T](u U) string { return "base " + u.ToString() }
}

class Derived : Base[int32] {
    func Go() string {
        let f = () -> base.M[int32](5)
        let g = () -> base.M(6)
        return f() + " | " + g()
    }

    async func GoAsync() Task[string] {
        await Task.Yield()
        return base.M(7)
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Derived().GoAsync().Result)
`, []string{"base 5 | base 6", "base 7"}}
            // A direct call and a method group of the same base method can observe
            // different return types (a `() -> object` group over a `string`
            // method, a `() -> Task` group over a `Task<int32>` one). Each gets
            // its own forwarder; one shared forwarder handed one of them a value
            // of the wrong type (StackUnexpected, DelegateCtor).
            yield[]object{"forwarder-per-observed-return-type", `
package P
import System
import System.Threading.Tasks

open class Base {
    open func Name() string { return "base" }
    open async func Count() int32 {
        await Task.Yield()
        return 7
    }
}

class Derived : Base {
    override func Name() string { return "derived" }
    override async func Count() int32 { return -1 }

    func Go() string {
        let f = func () string {
            let h () -> object = base.Name
            let direct = base.Name()
            return direct + " " + h().ToString()
        }
        let g = func () string {
            let t () -> Task = base.Count
            t().Wait()
            let direct = base.Count().Result
            let group () -> Task[int32] = base.Count
            return direct.ToString() + " " + group().Result.ToString()
        }
        return f() + " | " + g()
    }
}

Console.WriteLine(Derived().Go())
`, []string{"base base | 7 7"}}
            // A constructor with managed-reference work moves into an
            // initialization plan before the forwarder pass runs; a base call in a
            // function literal there must still be forwarded.
            yield[]object{"base-call-in-initialization-plan-constructor", `
package P
import System

open class Base {
    open func Name() string { return "base" }
}

class Derived : Base {
    var Other readonly managed[int32]
    var Result string = ""
    init(value int32) {
        this.Other = readonly managed(value)
        let f = () -> base.Name()
        this.Result = f()
    }
    override func Name() string { return "derived" }
}

Console.WriteLine(Derived(3).Result)
`, []string{"base"}}
            // An async base method converted to a delegate inside a function
            // literal: the forwarder returns the Task the delegate observes, not
            // the declared `void`/`int32` result.
            yield[]object{"async-base-method-group-in-function-literal", `
package P
import System
import System.Threading.Tasks

open class Base {
    open async func Count() int32 {
        await Task.Yield()
        return 7
    }
    open async func Run() {
        await Task.Yield()
        Console.WriteLine("base run")
    }
    open async func Echo[T](x T) T {
        await Task.Yield()
        return x
    }
}

class Derived : Base {
    override async func Count() int32 { return -1 }
    override async func Run() { Console.WriteLine("derived run") }
    override async func Echo[T](x T) T { return x }

    func Go() string {
        let f = func () Task[int32] {
            let h () -> Task[int32] = base.Count
            return h()
        }
        let g = func () Task {
            let r () -> Task = base.Run
            return r()
        }
        let e = func () Task[string] {
            let echo (string) -> Task[string] = base.Echo
            return echo("e")
        }
        g().Wait()
        return f().Result.ToString() + " " + e().Result
    }
}

Console.WriteLine(Derived().Go())
`, []string{"base run", "7 e"}}
            // `base.E += h` / `-=` when the derived class declares a same-named
            // event: the subscription must reach the base event's accessors.
            yield[]object{"base-event-shadowed-by-derived-event", `
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
        let h EventHandler = func (s object?, e EventArgs) { Console.WriteLine("base handler") }
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
        base.Disposed += func (s object?, e EventArgs) { Console.WriteLine("component disposed") }
        this.Dispose()
    }
}

Derived().Go()
Comp().Go()
`, []string{"base handler", "base handler", "component disposed"}}
            // A field or property at a nearer base level hides a farther event of
            // the same name: `base.E += h` combines into the nearer delegate
            // member rather than subscribing to the farther event.
            yield[]object{"nearer-value-member-hides-farther-base-event", `
package P
import System

open class Far {
    event E EventHandler?
    event Q EventHandler?
    func FireFar() {
        E?.Invoke(this, EventArgs.Empty)
        Q?.Invoke(this, EventArgs.Empty)
    }
}

open class Mid : Far {
    var E EventHandler?
    var qStore EventHandler?
    prop Q EventHandler? {
        get -> qStore
        set { qStore = value }
    }
}

class Derived : Mid {
    func Go() {
        base.E += func (s object?, e EventArgs) { Console.WriteLine("E handler") }
        base.Q += func (s object?, e EventArgs) { Console.WriteLine("Q handler") }
        this.FireFar()
        Console.WriteLine("far fired")
        base.E?.Invoke(this, EventArgs.Empty)
        base.Q?.Invoke(this, EventArgs.Empty)
    }
}

Derived().Go()
`, []string{"far fired", "E handler", "Q handler"}}
            // Forwarded calls to async and iterator base methods of a generic base
            // class: the forwarder returns what the base method returns as
            // emitted (Task, Task<T>, the sequence), not the G#-declared result.
            // A `void` forwarder for `async func Complete()` left the Task on the
            // stack (ILVerify ReturnVoid / StackUnderflow).
            yield[]object{"forwarded-async-and-iterator-base-calls", `
package P
import System
import System.Threading.Tasks

open class FilterC[TInput] {
    open async func Complete() {
        await Task.Yield()
        Console.WriteLine("base complete")
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
        let a = await base.Echo("e")
        let g = () -> base.Echo(4)
        let b = await g()
        let c = await base.Count()
        let h = () -> base.Count()
        let d = await h()
        var sum = 0
        let it = () -> base.Items()
        for x in it() { sum += x }
        return "$a $b $c $d $sum"
    }
}

let t = TransformC[int32, string]()
t.Complete().Wait()
Console.WriteLine(t.Go().Result)
`, []string{"base complete", "base complete", "e 4 7 7 3"}}
            // Issue #4331: postfix chains after a base member, read and write,
            // on source and imported bases, directly and in a function literal.
            yield[]object{"base-member-postfix-chains", `
package P
import System
import System.Text
import System.Text.RegularExpressions

class Box {
    var Field int32
    func M() StringBuilder -> StringBuilder("sb")
}

open class Base {
    protected var f int32 = 1
    protected var arr []int32 = []int32{4, 5}
    protected var obj Box = Box()
    var p string = "hello"
    open prop P string {
        get -> p
        set { p = value }
    }
}

class Derived : Base {
    override prop P string {
        get -> "overridden!"
        set { }
    }

    func Go() string {
        base.arr[0] = 9
        base.obj.Field = 7
        base.obj.Field += 1
        let direct = "${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[0]} ${base.obj.Field}"
        let inLiteral = func () string {
            base.arr[1] = 6
            base.obj.Field = 3
            return "${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[1]} ${base.obj.Field}"
        }
        return direct + " | " + inLiteral()
    }
}

class Pattern : Regex {
    init() : base("abcd") { }

    func Go() string {
        let inLiteral = () -> base.pattern?.Length ?? -1
        return "${base.pattern?.Length ?? -1} ${inLiteral()}"
    }
}

Console.WriteLine(Derived().Go())
Console.WriteLine(Pattern().Go())
`, []string{"1 5 2 9 8 | 1 5 2 6 3", "4 4"}}
            // All three gaps in the shape the [GeneratedRegex] output takes after
            // cs2gs: a Regex subclass validating its timeout through the
            // protected static Regex.ValidateMatchTimeout, and a RegexRunner
            // subclass that increments base.runtextpos and calls base.Crawlpos()
            // from a translated local function.
            yield[]object{"regex-generated-shape", `
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
        return "${base.runtextpos} $crawled"
    }
}

let r = GeneratedRegex(Regex.InfiniteMatchTimeout)
Console.WriteLine(GeneratedRunner().Scan(10))
`, []string{"15 3"}}
            // Issue #4392: a suspend override calling `base.M()` on a suspend
            // base method. The call came back from overload resolution already
            // completed (an implicit await around the instance call), so it was
            // never marked as a base call: it dispatched virtually, re-entered
            // the override and overflowed the stack.
            yield[]object{"suspend-base-call", `
package P
import System

open class A {
    open suspend func M() string {
        return "A"
    }
}

class B : A {
    override suspend func M() string {
        return "B>" + base.M()
    }
}

suspend func run() string {
    let b A = B()
    return b.M()
}

Console.WriteLine(run())
`, []string{"B>A"}}
            // Issue #4392: A -> B -> C. C's `base` reaches B's implementation (not
            // A's, not C's own), from the suspend body itself and from a function
            // literal inside it; generic and void suspend methods too.
            yield[]object{"suspend-base-call-three-levels", `
package P
import System

open class A {
    open suspend func M(x int32) string {
        return "A$x"
    }

    open suspend func G[T](v T) string {
        return "A.G:${v}"
    }

    open suspend func V() {
        Console.WriteLine("A.V")
    }
}

open class B : A {
    open override suspend func M(x int32) string {
        return "B(" + base.M(x + 1) + ")"
    }

    open override suspend func G[T](v T) string {
        return "B.G(" + base.G[T](v) + ")"
    }

    open override suspend func V() {
        base.V()
        Console.WriteLine("B.V")
    }
}

class C : B {
    override suspend func M(x int32) string {
        let f = () -> base.M(x * 10)
        return "C[" + base.M(x) + "|" + f() + "]"
    }

    override suspend func G[T](v T) string {
        return "C.G(" + base.G[T](v) + ")"
    }

    override suspend func V() {
        base.V()
        Console.WriteLine("C.V")
    }
}

suspend func run() {
    let a A = C()
    Console.WriteLine(a.M(1))
    Console.WriteLine(a.G[int32](5))
    a.V()
}

run()
`, []string{"C[B(A2)|B(A11)]", "C.G(B.G(A.G:5))", "A.V", "B.V", "C.V"}}
            // Issue #4392: the other places a base call to a suspending method can
            // sit: a plain method (the blocking bridge), an `async func`, a nested
            // function literal, a `go` operand and an `async let` initializer (both
            // run in a goroutine closure), and a non-virtual base method that
            // inference colours suspending, which colours its base caller too.
            yield[]object{"suspend-base-call-other-shapes", (`
package P
import System
import System.Threading.Tasks

open class A {
    open suspend func M(x int32) string {
        return "A$x"
    }

    open suspend func Send(ch chan[string], x int32) {
        ch <- "A.Send$x"
    }

    func Receive(ch chan[int32]) int32 {
        return <-ch
    }

    open func Put(ch chan[string], s string) {
        ch <- s
    }
}

class B : A {
    override suspend func M(x int32) string {
        return "B(" + base.M(x) + ")"
    }

    override suspend func Send(ch chan[string], x int32) {
        go base.Send(ch, x + 1)
    }

    func Blocking() string {
        return base.M(2)
    }

    async func ViaAsync() Task[string] {
        return base.M(3)
    }

    suspend func Nested() string {
        let outer = () -> {
            let inner = () -> base.M(4)
            return inner()
        }
        return outer()
    }

    suspend func Later(x int32) string {
        scope {
            async let v = base.M(x)
            return "later:" + await v
        }
    }

    func ViaInferred(ch chan[int32]) int32 {
        return base.Receive(ch)
    }

    override func Put(ch chan[string], s string) {
        ch <- "override"
    }

    // A plain member, so only the ` + "`" + `go` + "`" + ` operand (not a state-machine body)
    // makes the base call need a forwarder; ` + "`" + `Put` + "`" + ` is virtual, so a base call
    // on the goroutine closure's captured ` + "`" + `this` + "`" + ` would not verify.
    func GoPlain(ch chan[string]) {
        go base.Put(ch, "put")
    }
}

suspend func run() {
    let b = B()
    Console.WriteLine(b.M(1))
    Console.WriteLine(b.Blocking())
    Console.WriteLine(await b.ViaAsync())
    Console.WriteLine(b.Nested())
    Console.WriteLine(b.Later(5))
    let ch = chan[string](1)
    b.Send(ch, 6)
    Console.WriteLine(<-ch)
    b.GoPlain(ch)
    Console.WriteLine(<-ch)
    let ints = chan[int32](1)
    ints <- 42
    Console.WriteLine(b.ViaInferred(ints))
}

run()
`), []string{"B(A1)", "A2", "A3", "A4", "later:A5", "A.Send7", "put", "42"}}
        }

        /// Compiles an imported C# contract in-process with Roslyn and returns the
        /// assembly path, to be passed explicitly to gsc (docs/self-migration-policy.md,
        /// "Preserve compiler-test fixture provenance"; the same pattern as
        /// ConstantNarrowingCoverageTests).
        private func BuildCsLibrary(workDir string, source string, assemblyName string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let contracts = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let libraryDir = Path.Combine(workDir, "csref")
            Directory.CreateDirectory(libraryDir)
            let dll = Path.Combine(libraryDir, assemblyName + ".dll")
            {
                using let output = File.Create(dll)
                let emitted = contracts.Emit(output)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            return dll
        }

        private func Compile(tempDir string, name string, source string, extraReferences ...string)(
            Exit int32,
            Stdout string,
            Stderr string
        ) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies().Concat(extraReferences) {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
