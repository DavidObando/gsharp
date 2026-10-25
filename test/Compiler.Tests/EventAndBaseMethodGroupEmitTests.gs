// <copyright file="EventAndBaseMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Text
import Xunit

/// Three gaps the review of PR #4380 (base-call forwarders) found, each
/// compiled with gsc, verified with ILVerify and run, and where the shape has
/// a C# spelling, compared against the same program compiled by Roslyn:
/// - issue #4391: the add/remove accessors of a field-like event on a generic class
/// (`event Got EventHandler[T]?`) cast the combined delegate to the erased `EventHandler<object>`,
/// failing ILVerify and throwing `InvalidCastException` on the first subscription; a subscription
/// through a constructed receiver (`g.Got += h` on a `GB[string]`) wanted an `EventHandler[T]` handler;
/// - issue #4393: `let f (T) -> string = base.Name` in a member body loaded the method through a
/// MemberRef parented at the derived class (so it bound the override: "derived" where C# prints
/// "base"), or, for a non-generic class deriving a constructed generic base, through the bare MethodDef
/// of the open base (ILVerify `DelegateCtor`);
/// - issue #4394: subscribing to an event the subscriber cannot reach compiled; the reachable cells of
/// the access matrix must still run.
open class EventAndBaseMethodGroupEmitTests {
    @Fact
    func Issue5270_ExactOverrideForwardingRepro_UsesNonvirtualBaseAccessors() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `import System

open class Parent {
    open event Changed Action?
}

class Child : Parent {
    override event Changed Action? {
        add { base.Changed += value }
        remove { base.Changed -= value }
    }
}`
        let dll = fixture.Compile(source, "base-event-repro", false, "/deterministic+", "/debug:none")
        let first = File.ReadAllBytes(dll)
        fixture.Compile(source, "base-event-repro", false, "/deterministic+", "/debug:none")
        Assert.Equal(first, File.ReadAllBytes(dll))
        IlVerifier.Verify(dll)
        AssertBaseEventCalls(dll)
    }

    @Fact
    func Issue5270_AbstractBaseEvent_RejectsCallsWithLocatedDiagnosticsAndNoImage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`using System;
namespace Contracts;
public abstract class Parent {
    public abstract event Action? Changed;
}`, "AbstractEventContract")
        let (code, diagnostics) = fixture.TryCompile(`import Contracts
import System
class Child : Parent {
    override event Changed Action? {
        add { base.Changed += value }
        remove { base.Changed -= value }
    }
}`, "abstract-base-event", false, "/reference:" + library)
        Assert.NotEqual(0, code)
        Assert.Contains("abstract-base-event.gs(5,20,5,27): error GS0413:", diagnostics, StringComparison.Ordinal)
        Assert.Contains("abstract-base-event.gs(6,23,6,30): error GS0413:", diagnostics, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "abstract-base-event.dll")))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Issue5270_BaseEvent_PreservesDispatchAndEvaluationOrder(imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const sourceBase = `open class Parent {
    private event handlers Action[string]?
    open event Changed Action[string]? {
        add {
            Console.Write("A")
            handlers += value
        }
        remove {
            Console.Write("R")
            handlers -= value
        }
    }
    func Fire(value string) { handlers?.Invoke(value) }
}
`
        let library = if imported {
            fixture.CompileCSharp(`using System;
namespace Contracts;
public class Parent<T> {
    private event Action<T>? handlers;
    public virtual event Action<T>? Changed {
        add { Console.Write("A"); handlers += value; }
        remove { Console.Write("R"); handlers -= value; }
    }
    public void Fire(T value) { handlers?.Invoke(value); }
}`, "BaseEventContract")
        } else {
            string.Empty
        }
        let parentType = if imported {
            "Parent[string]"
        } else {
            "Parent"
        }
        let source = "import System\n" +
            (
            if imported {
                "import Contracts\n"
            } else {
                sourceBase
            }
        ) +
            `
class Child : PARENT {
    override event Changed Action[string]? {
        add {
            Console.Write("a")
            base.Changed += value
        }
        remove {
            Console.Write("r")
            base.Changed -= value
        }
    }
    func Direct(h Action[string]?) {
        base.Changed += h
        base.Changed -= h
    }
}
func Pick(c Child) Child {
    Console.Write("x")
    return c
}
func Handler() Action[string] {
    Console.Write("h")
    return func(text string) { Console.Write(text) }
}
func Main() {
    let c = Child()
    let p PARENT = c
    let h = Handler()
    Pick(c).Changed += h
    p.Changed += nil
    c.Fire("F")
    Pick(c).Changed -= h
    c.Fire("F")
    c.Direct(nil)
}`
        let program = source.Replace("PARENT", parentType, StringComparison.Ordinal)
        let references = if imported {
            []string{library}
        } else {
            Array.Empty[string]()
        }
        let options = []string{"/deterministic+", "/debug:none"}.Concat(
            references.Select((path string) -> "/reference:" + path)
        )
            .ToArray()
        let dll = fixture.Compile(program, "base-event-runtime", true, options)
        let image = File.ReadAllBytes(dll)
        fixture.Compile(program, "base-event-runtime", true, options)
        Assert.Equal(image, File.ReadAllBytes(dll))
        IlVerifier.Verify(dll, references)
        AssertBaseEventCalls(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("hxaAaAFxrRAR"), RunBaseEventBytes(dll))
    }

    private func AssertBaseEventCalls(dll string) {
        let assembly = EmittedFixture.Load(dll)
        let child = assembly.GetTypes().Single((type Type) -> type.Name == "Child")
        for name in[]string{"add_Changed", "remove_Changed"} {
            let method = child.GetMethod(name)!!
            let calls = IlInstructionReader
                .Read(method.GetMethodBody()!!.GetILAsByteArray()!!)
                .Where(
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Call ||
                    instruction.OpCode == OpCodes.Callvirt
            )
                .Where(
                (instruction IlInstruction) -> method.Module.ResolveMethod(instruction.MetadataToken!!)!!.Name == name
            )
                .ToArray()
            let call = Assert.Single(calls)
            Assert.Equal(OpCodes.Call, call.OpCode)
            let target = method.Module.ResolveMethod(call.MetadataToken!!)!!
            Assert.Equal(child.BaseType, target.DeclaringType)
        }
    }

    private func RunBaseEventBytes(dll string)[]uint8 {
        let start = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(dll)!!
        }
        start.ArgumentList.Add(dll)
        using let process = Process.Start(start) ?? throw InvalidOperationException("could not start dotnet")
        using let output = MemoryStream()
        let stdout = process.StandardOutput.BaseStream.CopyToAsync(output)
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(30_000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            Assert.Fail("base event program timed out")
        }
        stdout.GetAwaiter().GetResult()
        Assert.Equal(string.Empty, stderr.Result)
        Assert.Equal(0, process.ExitCode)
        return output.ToArray()
    }

    /// Issue #4433: a function literal passed directly to a delegate parameter
    /// on a constructed user-generic receiver must use the receiver-substituted
    /// target, not the open declaration's erased delegate shape.
    @Fact
    func ConstructedReceiver_DelegateParameterTargetsDirectFunctionLiteral() {
        const source = `package P
import System

class Box[T] {
    func Take(h EventHandler[T]) { h.Invoke(this, default(T)) }
}

let b = Box[string]()
b.Take(func (s object?, e string?) { Console.WriteLine("took") })`
        const csSource = `using System;

sealed class Box<T>
{
    public void Take(EventHandler<T> h) => h(this, default!);
}

static class Program
{
    static void Main()
    {
        var b = new Box<string>();
        b.Take((s, e) => Console.WriteLine("took"));
    }
}`
        AssertMatchesCSharp("constructed-receiver-direct-literal", source, csSource, []string{"took"})
    }

    /// Issue #4391: subscribe, unsubscribe, raise and multiple handlers on a
    /// generic class's field-like event, through `this.`, `base.`,
    /// a bare name, an external constructed receiver, and a class deriving a
    /// constructed base, with a same-compilation type argument.
    @Fact
    func GenericSourceEvent_AccessorsVerifyAndRun_LikeCSharp() {
        const source = `
package P
import System

open class GB[T] {
    event Got EventHandler[T]?
    protected event PGot EventHandler[T]?
    func Fire(v T) {
        Got?.Invoke(this, v)
        PGot?.Invoke(this, v)
    }
    func Sub(h EventHandler[T]) { this.Got += h }
    func Unsub(h EventHandler[T]) { this.Got -= h }
}

class GD[T] : GB[T] {
    func BaseSub(h EventHandler[T]) { base.Got += h }
    func BaseUnsub(h EventHandler[T]) { base.Got -= h }
    func BaseSubLambda() {
        base.Got += func (s object?, e T) { Console.WriteLine("base lambda ${e}") }
    }
}

class DC : GB[string] {
    func Hook() {
        Got += func (s object?, e string) { Console.WriteLine("dc bare $e") }
        base.Got += func (s object?, e string) { Console.WriteLine("dc base $e") }
        PGot += func (s object?, e string) { Console.WriteLine("dc bare prot $e") }
        this.PGot += func (s object?, e string) { Console.WriteLine("dc this prot $e") }
    }
}

class Item {
    var Name string = "item"
}

let g = GD[string]()
let h1 EventHandler[string] = func (s object?, e string) { Console.WriteLine("h1 $e") }
let h2 EventHandler[string] = func (s object?, e string) { Console.WriteLine("h2 $e") }
g.Sub(h1)
g.BaseSub(h2)
g.Got += h1
g.Fire("a")
g.Unsub(h1)
g.Fire("b")
g.BaseUnsub(h2)
g.Got -= h1
g.Fire("c")
g.BaseSubLambda()
g.Fire("d")

let dc = DC()
dc.Hook()
dc.Got += func (s object?, e string) { Console.WriteLine("dc ext $e") }
dc.Fire("e")

let gi = GD[Item]()
let hi EventHandler[Item] = func (s object?, e Item) { Console.WriteLine("item ${e.Name}") }
gi.Got += hi
gi.Got += func (s object?, e Item) { Console.WriteLine("item lambda ${e.Name}") }
gi.Fire(Item())
gi.Got -= hi
gi.Fire(Item())
`
        const csSource = `using System;

class GB<T>
{
    public event EventHandler<T>? Got;
    protected event EventHandler<T>? PGot;
    public void Fire(T v) { Got?.Invoke(this, v); PGot?.Invoke(this, v); }
    public void Sub(EventHandler<T> h) { this.Got += h; }
    public void Unsub(EventHandler<T> h) { this.Got -= h; }
}

class GD<T> : GB<T>
{
    public void BaseSub(EventHandler<T> h) { base.Got += h; }
    public void BaseUnsub(EventHandler<T> h) { base.Got -= h; }
    public void BaseSubLambda() { base.Got += (s, e) => Console.WriteLine($"base lambda {e}"); }
}

class DC : GB<string>
{
    public void Hook()
    {
        Got += (s, e) => Console.WriteLine($"dc bare {e}");
        base.Got += (s, e) => Console.WriteLine($"dc base {e}");
        PGot += (s, e) => Console.WriteLine($"dc bare prot {e}");
        this.PGot += (s, e) => Console.WriteLine($"dc this prot {e}");
    }
}

class Item { public string Name = "item"; }

static class Program
{
    static void Main()
    {
        var g = new GD<string>();
        EventHandler<string> h1 = (s, e) => Console.WriteLine($"h1 {e}");
        EventHandler<string> h2 = (s, e) => Console.WriteLine($"h2 {e}");
        g.Sub(h1);
        g.BaseSub(h2);
        g.Got += h1;
        g.Fire("a");
        g.Unsub(h1);
        g.Fire("b");
        g.BaseUnsub(h2);
        g.Got -= h1;
        g.Fire("c");
        g.BaseSubLambda();
        g.Fire("d");

        var dc = new DC();
        dc.Hook();
        dc.Got += (s, e) => Console.WriteLine($"dc ext {e}");
        dc.Fire("e");

        var gi = new GD<Item>();
        EventHandler<Item> hi = (s, e) => Console.WriteLine($"item {e.Name}");
        gi.Got += hi;
        gi.Got += (s, e) => Console.WriteLine($"item lambda {e.Name}");
        gi.Fire(new Item());
        gi.Got -= hi;
        gi.Fire(new Item());
    }
}`
        let expected = []string{
            "h1 a",
            "h2 a",
            "h1 a",
            "h1 b",
            "h2 b",
            "base lambda d",
            "dc bare e",
            "dc base e",
            "dc ext e",
            "dc bare prot e",
            "dc this prot e",
            "item item",
            "item lambda item",
            "item lambda item"
        }
        AssertMatchesCSharp("generic-event", source, csSource, expected)
    }

    /// Issue #4391, through a class-constrained type parameter: the receiver
    /// is a `T` constrained to a construction of the generic class
    /// (directly or through a class deriving it), so the handler type is the
    /// event's type as that construction names it.
    @Fact
    func GenericSourceEvent_ThroughClassConstrainedTypeParameter_RunsLikeCSharp() {
        const source = `
package P
import System

open class GB[T] {
    event Got EventHandler[T]?
    func Fire(v T) { Got?.Invoke(this, v) }
}

open class GD : GB[string] {}

class Hooker {
    func Hook[X GB[string]](x X, h EventHandler[string]) { x.Got += h }
    func HookD[Y GD](y Y, h EventHandler[string]) {
        y.Got += h
        y.Got += func (s object?, e string) { Console.WriteLine("lambda $e") }
        y.Got -= h
    }
}

let g = GD()
let h EventHandler[string] = func (s object?, e string) { Console.WriteLine("h $e") }
Hooker().Hook(g, h)
Hooker().HookD(g, h)
g.Fire("a")
`
        const csSource = `using System;

class GB<T>
{
    public event EventHandler<T>? Got;
    public void Fire(T v) { Got?.Invoke(this, v); }
}

class GD : GB<string> { }

class Hooker
{
    public void Hook<X>(X x, EventHandler<string> h) where X : GB<string> { x.Got += h; }
    public void HookD<Y>(Y y, EventHandler<string> h) where Y : GD
    {
        y.Got += h;
        y.Got += (s, e) => Console.WriteLine($"lambda {e}");
        y.Got -= h;
    }
}

static class Program
{
    static void Main()
    {
        var g = new GD();
        EventHandler<string> h = (s, e) => Console.WriteLine($"h {e}");
        new Hooker().Hook(g, h);
        new Hooker().HookD(g, h);
        g.Fire("a");
    }
}`
        AssertMatchesCSharp("constrained-generic-event", source, csSource, []string{"h a", "lambda a"})
    }

    /// Issue #4393: a base method group converted to a delegate directly in a
    /// member body observes the base implementation, in a generic class, a
    /// non-generic class, a class closing a generic base, across an
    /// intermediate generic class, for a generic base method, and (through
    /// #4380's forwarder) inside a function literal. The non-base groups
    /// (`this.Name` dispatching virtually, an inherited non-virtual
    /// method) keep their meaning.
    @Fact
    func BaseMethodGroup_DirectConversion_BindsBaseImplementation_LikeCSharp() {
        const source = `
package P
import System

open class Base[T] {
    open func Name(x T) string -> "base"
    func Plain(x T) string -> "plain"
    open func Gen[U](x T, u U) string -> "base gen"
}

class Derived[T] : Base[T] {
    override func Name(x T) string -> "derived"
    override func Gen[U](x T, u U) string -> "derived gen"
    func Get() (T) -> string {
        let f (T) -> string = base.Name
        return f
    }
    func GetPlain() (T) -> string {
        let f (T) -> string = this.Plain
        return f
    }
    func GetVirtual() (T) -> string {
        let f (T) -> string = this.Name
        return f
    }
    func GetGen() (T, int32) -> string {
        let f (T, int32) -> string = base.Gen
        return f
    }
    func GetInLiteral() (T) -> string {
        let g = func () (T) -> string {
            let f (T) -> string = base.Name
            return f
        }
        return g()
    }
}

open class NB {
    open func Name(x int32) string -> "nbase"
}

class ND : NB {
    override func Name(x int32) string -> "nderived"
    func Get() (int32) -> string {
        let f (int32) -> string = base.Name
        return f
    }
}

class DC : Base[string] {
    override func Name(x string) string -> "dc"
    func Get() (string) -> string {
        let f (string) -> string = base.Name
        return f
    }
}

open class Mid[V] : Base[V] {}

class Deep[W] : Mid[W] {
    override func Name(x W) string -> "deep"
    func Get() (W) -> string {
        let f (W) -> string = base.Name
        return f
    }
}

let d = Derived[string]()
Console.WriteLine(d.Get()("a"))
Console.WriteLine(d.GetPlain()("a"))
Console.WriteLine(d.GetVirtual()("a"))
Console.WriteLine(d.GetGen()("a", 1))
Console.WriteLine(d.GetInLiteral()("a"))
Console.WriteLine(ND().Get()(1))
Console.WriteLine(DC().Get()("a"))
Console.WriteLine(Deep[int32]().Get()(1))
`
        const csSource = `using System;

class Base<T>
{
    public virtual string Name(T x) => "base";
    public string Plain(T x) => "plain";
    public virtual string Gen<U>(T x, U u) => "base gen";
}

class Derived<T> : Base<T>
{
    public override string Name(T x) => "derived";
    public override string Gen<U>(T x, U u) => "derived gen";
    public Func<T, string> Get() { Func<T, string> f = base.Name; return f; }
    public Func<T, string> GetPlain() { Func<T, string> f = this.Plain; return f; }
    public Func<T, string> GetVirtual() { Func<T, string> f = this.Name; return f; }
    public Func<T, int, string> GetGen() { Func<T, int, string> f = base.Gen; return f; }
    public Func<T, string> GetInLiteral()
    {
        Func<Func<T, string>> g = () => { Func<T, string> f = base.Name; return f; };
        return g();
    }
}

class NB { public virtual string Name(int x) => "nbase"; }

class ND : NB
{
    public override string Name(int x) => "nderived";
    public Func<int, string> Get() { Func<int, string> f = base.Name; return f; }
}

class DC : Base<string>
{
    public override string Name(string x) => "dc";
    public Func<string, string> Get() { Func<string, string> f = base.Name; return f; }
}

class Mid<V> : Base<V> { }

class Deep<W> : Mid<W>
{
    public override string Name(W x) => "deep";
    public Func<W, string> Get() { Func<W, string> f = base.Name; return f; }
}

static class Program
{
    static void Main()
    {
        var d = new Derived<string>();
        Console.WriteLine(d.Get()("a"));
        Console.WriteLine(d.GetPlain()("a"));
        Console.WriteLine(d.GetVirtual()("a"));
        Console.WriteLine(d.GetGen()("a", 1));
        Console.WriteLine(d.GetInLiteral()("a"));
        Console.WriteLine(new ND().Get()(1));
        Console.WriteLine(new DC().Get()("a"));
        Console.WriteLine(new Deep<int>().Get()(1));
    }
}`
        let expected = []string{"base", "plain", "derived", "base gen", "base", "nbase", "base", "base"}
        AssertMatchesCSharp("base-method-group", source, csSource, expected)
    }

    /// Issue #4394: the reachable cells of the source-event access matrix run
    /// as in C#: the declaring class subscribes to its own private event
    /// through another instance and by bare name, a derived class to a
    /// protected event by bare name and through `this`, and an unrelated
    /// class to internal and public events. (The unreachable cells are
    /// binder diagnostics, covered in Core.Tests'
    /// `EventSubscriptionAccessibilityBinderTests`.)
    @Fact
    func SourceEventAccessMatrix_ReachableCells_RunLikeCSharp() {
        const source = `
package P
import System

open class Source {
    private event Priv EventHandler?
    protected event Prot EventHandler?
    internal event Intl EventHandler?
    event Pub EventHandler?
    func Fire() {
        Priv?.Invoke(this, EventArgs.Empty)
        Prot?.Invoke(this, EventArgs.Empty)
        Intl?.Invoke(this, EventArgs.Empty)
        Pub?.Invoke(this, EventArgs.Empty)
    }
    func HookSame(other Source) {
        other.Priv += func (o object?, e EventArgs) { Console.WriteLine("same priv") }
        Priv += func (o object?, e EventArgs) { Console.WriteLine("same bare priv") }
        other.Prot += func (o object?, e EventArgs) { Console.WriteLine("same prot") }
    }
}

class Derived : Source {
    func HookDerived() {
        Prot += func (o object?, e EventArgs) { Console.WriteLine("derived bare prot") }
        this.Prot += func (o object?, e EventArgs) { Console.WriteLine("derived this prot") }
        this.Intl += func (o object?, e EventArgs) { Console.WriteLine("derived intl") }
    }
}

class Other {
    func Hook(s Source) {
        s.Intl += func (o object?, e EventArgs) { Console.WriteLine("other intl") }
        s.Pub += func (o object?, e EventArgs) { Console.WriteLine("other pub") }
    }
}

let s = Source()
s.HookSame(s)
Other().Hook(s)
s.Fire()
let d = Derived()
d.HookDerived()
d.Fire()
`
        const csSource = `using System;

class Source
{
    private event EventHandler? Priv;
    protected event EventHandler? Prot;
    internal event EventHandler? Intl;
    public event EventHandler? Pub;
    public void Fire()
    {
        Priv?.Invoke(this, EventArgs.Empty);
        Prot?.Invoke(this, EventArgs.Empty);
        Intl?.Invoke(this, EventArgs.Empty);
        Pub?.Invoke(this, EventArgs.Empty);
    }
    public void HookSame(Source other)
    {
        other.Priv += (o, e) => Console.WriteLine("same priv");
        Priv += (o, e) => Console.WriteLine("same bare priv");
        other.Prot += (o, e) => Console.WriteLine("same prot");
    }
}

class Derived : Source
{
    public void HookDerived()
    {
        Prot += (o, e) => Console.WriteLine("derived bare prot");
        this.Prot += (o, e) => Console.WriteLine("derived this prot");
        this.Intl += (o, e) => Console.WriteLine("derived intl");
    }
}

class Other
{
    public void Hook(Source s)
    {
        s.Intl += (o, e) => Console.WriteLine("other intl");
        s.Pub += (o, e) => Console.WriteLine("other pub");
    }
}

static class Program
{
    static void Main()
    {
        var s = new Source();
        s.HookSame(s);
        new Other().Hook(s);
        s.Fire();
        var d = new Derived();
        d.HookDerived();
        d.Fire();
    }
}`
        let expected = []string{
            "same priv",
            "same bare priv",
            "same prot",
            "other intl",
            "other pub",
            "derived bare prot",
            "derived this prot",
            "derived intl"
        }
        AssertMatchesCSharp("source-event-access", source, csSource, expected)
    }

    /// Issue #4394: imported events against a C# library. A class deriving
    /// the declaring type subscribes to its `protected` and
    /// `protected internal` events through its own instance (as C#
    /// allows), and an unrelated class to a public one. Each accessor call
    /// must verify and run: an unreachable accessor would fail at run time
    /// with MethodAccessException.
    @Fact
    func ImportedEventAccess_ReachableCells_VerifyAndRun() {
        const csLibrary = `using System;

namespace EventAccess.Library
{
    public class CSource
    {
        private event EventHandler? Priv;
        protected event EventHandler? Prot;
        internal event EventHandler? Intl;
        public event EventHandler? Pub;
        protected internal event EventHandler? ProtIntl;

        public void Fire()
        {
            Priv?.Invoke(this, EventArgs.Empty);
            Prot?.Invoke(this, EventArgs.Empty);
            Intl?.Invoke(this, EventArgs.Empty);
            Pub?.Invoke(this, EventArgs.Empty);
            ProtIntl?.Invoke(this, EventArgs.Empty);
        }
    }
}`
        const source = `
package P
import System
import EventAccess.Library

class Der : CSource {
    func Hook() {
        let h EventHandler = func (o object?, e EventArgs) { Console.WriteLine("removed prot") }
        this.Prot += h
        this.Prot += func (o object?, e EventArgs) { Console.WriteLine("this prot") }
        this.ProtIntl += func (o object?, e EventArgs) { Console.WriteLine("this protintl") }
        this.Prot -= h
    }
    func HookOther(other Der) {
        other.Prot += func (o object?, e EventArgs) { Console.WriteLine("other der prot") }
    }
}

class Other {
    func Hook(s CSource) {
        s.Pub += func (o object?, e EventArgs) { Console.WriteLine("other pub") }
    }
}

let d = Der()
d.Hook()
d.Fire()
let d2 = Der()
d.HookOther(d2)
Other().Hook(d2)
d2.Fire()
`
        let tempDir = Directory.CreateTempSubdirectory("gs_event_access_").FullName
        try {
            let library = BuildCsLibrary(tempDir, csLibrary, "EventAccess.Library")
            let lines = CompileVerifyAndRun(tempDir, "imported-event-access", source, library)
            Assert.Equal([]string{"this prot", "this protintl", "other der prot", "other pub"}, lines)
        } finally {
            DeleteBestEffort(tempDir)
        }
    }

    shared {
        /// Compiles [`source`](paramref) with gsc, verifies it with ILVerify
        /// and runs it, runs [`csSource`](paramref) compiled by Roslyn, and
        /// asserts both print [`expected`](paramref). Shared with
        /// (cref:ProtectedReceiverAccessEmitTests).
        internal func AssertMatchesCSharp(name string, source string, csSource string, expected[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_event_mg_").FullName
            try {
                let gsLines = CompileVerifyAndRun(tempDir, name, source)
                let csLines = RunCSharpProgram(tempDir, name + "-cs", csSource)
                Assert.Equal(expected, csLines)
                Assert.Equal(csLines, gsLines)
            } finally {
                DeleteBestEffort(tempDir)
            }
        }

        private func CompileVerifyAndRun(tempDir string, name string, source string, libraries ...string)[]string {
            let (exit, stdout, stderr) = Compile(tempDir, name, source, libraries)
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let outPath = Path.Combine(tempDir, name + ".dll")
            IlVerifier.Verify(outPath, libraries)
            for library in libraries {
                File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true)
            }
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run to completion. Exit ` + "$runExit" + `:
` + "$output"))
            return SplitLines(output)
        }

        /// Compiles the C# reference program in-process with Roslyn and runs it,
        /// so the expected output is what C# itself produces for the same shape.
        private func RunCSharpProgram(tempDir string, name string, csSource string)[]string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(csSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.ConsoleApplication,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let dll = Path.Combine(tempDir, name + ".dll")
            {
                using let output = File.Create(dll)
                let emitted = compilation.Emit(output)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            let runtimeVersion = Environment.Version
            File.WriteAllText(
                Path.ChangeExtension(dll, ".runtimeconfig.json"),
                "{\"runtimeOptions\":{\"tfm\":\"net" + runtimeVersion.Major.ToString() +
                    ".0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"" +
                    runtimeVersion
                    .Major
                    .ToString() + "." + runtimeVersion.Minor.ToString() + ".0\"}}}"
            )
            let (exit, text) = RunDotnet(dll)
            Assert.True(exit == 0, (`C# reference program failed. Exit ` + "$exit" + `:
` + "$text"))
            return SplitLines(text)
        }

        private func DeleteBestEffort(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException {
                // A handle the child `dotnet` process releases late must not fail the test.

            }
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

        /// Compiles an imported C# contract in-process with Roslyn and returns the
        /// assembly path, to be passed explicitly to gsc (the same pattern as
        /// BaseMemberGapsEmitTests).
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
            let srcPath = Path.Combine(tempDir, name + ".gs")
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
            // Read both streams concurrently (a full stderr buffer cannot block
            // the child while stdout is drained) and bound the run, so a hung
            // program fails the test instead of stalling the suite.
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(TimeSpan.FromMinutes(2)) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail((`'` + "$assemblyPath" + `' did not exit within 2 minutes.
stdout:
` + "${stdout.Result}" + `
stderr:
` + "${stderr.Result}"))
            }
            let output = StringBuilder()
            output.Append(stdout.Result)
            output.Append(stderr.Result)
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
