// <copyright file="EventAndBaseMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Three gaps the review of PR #4380 (base-call forwarders) found, each
/// compiled with gsc, verified with ILVerify and run, and where the shape has
/// a C# spelling, compared against the same program compiled by Roslyn:
/// <list type="bullet">
///   <item>issue #4391: the add/remove accessors of a field-like event on a
///   generic class (<c>event Got EventHandler[T]?</c>) cast the combined
///   delegate to the erased <c>EventHandler&lt;object&gt;</c>, failing ILVerify
///   and throwing <c>InvalidCastException</c> on the first subscription;
///   a subscription through a constructed receiver (<c>g.Got += h</c> on a
///   <c>GB[string]</c>) wanted an <c>EventHandler[T]</c> handler;</item>
///   <item>issue #4393: <c>let f (T) -> string = base.Name</c> in a member
///   body loaded the method through a MemberRef parented at the derived
///   class (so it bound the override: "derived" where C# prints "base"), or,
///   for a non-generic class deriving a constructed generic base, through
///   the bare MethodDef of the open base (ILVerify <c>DelegateCtor</c>);</item>
///   <item>issue #4394: subscribing to an event the subscriber cannot reach
///   compiled; the reachable cells of the access matrix must still run.</item>
/// </list>
/// </summary>
public class EventAndBaseMethodGroupEmitTests
{
    /// <summary>
    /// Issue #4391: subscribe, unsubscribe, raise and multiple handlers on a
    /// generic class's field-like event, through <c>this.</c>, <c>base.</c>,
    /// a bare name, an external constructed receiver, and a class deriving a
    /// constructed base, with a same-compilation type argument.
    /// </summary>
    /// <remarks>
    /// Function literals passed straight to a <c>EventHandler[T]</c>
    /// parameter are bound to typed locals first: that argument conversion is
    /// a separate gap (#4433) unrelated to the event accessors.
    /// </remarks>
    [Fact]
    public void GenericSourceEvent_AccessorsVerifyAndRun_LikeCSharp()
    {
        const string source = @"
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
        base.Got += func (s object?, e T) { Console.WriteLine(""base lambda ${e}"") }
    }
}

class DC : GB[string] {
    func Hook() {
        Got += func (s object?, e string) { Console.WriteLine(""dc bare $e"") }
        base.Got += func (s object?, e string) { Console.WriteLine(""dc base $e"") }
        PGot += func (s object?, e string) { Console.WriteLine(""dc bare prot $e"") }
        this.PGot += func (s object?, e string) { Console.WriteLine(""dc this prot $e"") }
    }
}

class Item {
    var Name string = ""item""
}

let g = GD[string]()
let h1 EventHandler[string] = func (s object?, e string) { Console.WriteLine(""h1 $e"") }
let h2 EventHandler[string] = func (s object?, e string) { Console.WriteLine(""h2 $e"") }
g.Sub(h1)
g.BaseSub(h2)
g.Got += h1
g.Fire(""a"")
g.Unsub(h1)
g.Fire(""b"")
g.BaseUnsub(h2)
g.Got -= h1
g.Fire(""c"")
g.BaseSubLambda()
g.Fire(""d"")

let dc = DC()
dc.Hook()
dc.Got += func (s object?, e string) { Console.WriteLine(""dc ext $e"") }
dc.Fire(""e"")

let gi = GD[Item]()
let hi EventHandler[Item] = func (s object?, e Item) { Console.WriteLine(""item ${e.Name}"") }
gi.Got += hi
gi.Got += func (s object?, e Item) { Console.WriteLine(""item lambda ${e.Name}"") }
gi.Fire(Item())
gi.Got -= hi
gi.Fire(Item())
";

        const string csSource = """
            using System;

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
            }
            """;

        var expected = new[]
        {
            "h1 a", "h2 a", "h1 a",
            "h1 b", "h2 b",
            "base lambda d",
            "dc bare e", "dc base e", "dc ext e", "dc bare prot e", "dc this prot e",
            "item item", "item lambda item",
            "item lambda item",
        };

        AssertMatchesCSharp("generic-event", source, csSource, expected);
    }

    /// <summary>
    /// Issue #4391, through a class-constrained type parameter: the receiver
    /// is a <c>T</c> constrained to a construction of the generic class
    /// (directly or through a class deriving it), so the handler type is the
    /// event's type as that construction names it.
    /// </summary>
    [Fact]
    public void GenericSourceEvent_ThroughClassConstrainedTypeParameter_RunsLikeCSharp()
    {
        const string source = @"
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
        y.Got += func (s object?, e string) { Console.WriteLine(""lambda $e"") }
        y.Got -= h
    }
}

let g = GD()
let h EventHandler[string] = func (s object?, e string) { Console.WriteLine(""h $e"") }
Hooker().Hook(g, h)
Hooker().HookD(g, h)
g.Fire(""a"")
";

        const string csSource = """
            using System;

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
            }
            """;

        AssertMatchesCSharp("constrained-generic-event", source, csSource, new[] { "h a", "lambda a" });
    }

    /// <summary>
    /// Issue #4393: a base method group converted to a delegate directly in a
    /// member body observes the base implementation, in a generic class, a
    /// non-generic class, a class closing a generic base, across an
    /// intermediate generic class, for a generic base method, and (through
    /// #4380's forwarder) inside a function literal. The non-base groups
    /// (<c>this.Name</c> dispatching virtually, an inherited non-virtual
    /// method) keep their meaning.
    /// </summary>
    [Fact]
    public void BaseMethodGroup_DirectConversion_BindsBaseImplementation_LikeCSharp()
    {
        const string source = @"
package P
import System

open class Base[T] {
    open func Name(x T) string -> ""base""
    func Plain(x T) string -> ""plain""
    open func Gen[U](x T, u U) string -> ""base gen""
}

class Derived[T] : Base[T] {
    override func Name(x T) string -> ""derived""
    override func Gen[U](x T, u U) string -> ""derived gen""
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
    open func Name(x int32) string -> ""nbase""
}

class ND : NB {
    override func Name(x int32) string -> ""nderived""
    func Get() (int32) -> string {
        let f (int32) -> string = base.Name
        return f
    }
}

class DC : Base[string] {
    override func Name(x string) string -> ""dc""
    func Get() (string) -> string {
        let f (string) -> string = base.Name
        return f
    }
}

open class Mid[V] : Base[V] {}

class Deep[W] : Mid[W] {
    override func Name(x W) string -> ""deep""
    func Get() (W) -> string {
        let f (W) -> string = base.Name
        return f
    }
}

let d = Derived[string]()
Console.WriteLine(d.Get()(""a""))
Console.WriteLine(d.GetPlain()(""a""))
Console.WriteLine(d.GetVirtual()(""a""))
Console.WriteLine(d.GetGen()(""a"", 1))
Console.WriteLine(d.GetInLiteral()(""a""))
Console.WriteLine(ND().Get()(1))
Console.WriteLine(DC().Get()(""a""))
Console.WriteLine(Deep[int32]().Get()(1))
";

        const string csSource = """
            using System;

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
            }
            """;

        var expected = new[] { "base", "plain", "derived", "base gen", "base", "nbase", "base", "base" };
        AssertMatchesCSharp("base-method-group", source, csSource, expected);
    }

    /// <summary>
    /// Issue #4394: the reachable cells of the source-event access matrix run
    /// as in C#: the declaring class subscribes to its own private event
    /// through another instance and by bare name, a derived class to a
    /// protected event by bare name and through <c>this</c>, and an unrelated
    /// class to internal and public events. (The unreachable cells are
    /// binder diagnostics, covered in Core.Tests'
    /// <c>EventSubscriptionAccessibilityBinderTests</c>.)
    /// </summary>
    [Fact]
    public void SourceEventAccessMatrix_ReachableCells_RunLikeCSharp()
    {
        const string source = @"
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
        other.Priv += func (o object?, e EventArgs) { Console.WriteLine(""same priv"") }
        Priv += func (o object?, e EventArgs) { Console.WriteLine(""same bare priv"") }
        other.Prot += func (o object?, e EventArgs) { Console.WriteLine(""same prot"") }
    }
}

class Derived : Source {
    func HookDerived() {
        Prot += func (o object?, e EventArgs) { Console.WriteLine(""derived bare prot"") }
        this.Prot += func (o object?, e EventArgs) { Console.WriteLine(""derived this prot"") }
        this.Intl += func (o object?, e EventArgs) { Console.WriteLine(""derived intl"") }
    }
}

class Other {
    func Hook(s Source) {
        s.Intl += func (o object?, e EventArgs) { Console.WriteLine(""other intl"") }
        s.Pub += func (o object?, e EventArgs) { Console.WriteLine(""other pub"") }
    }
}

let s = Source()
s.HookSame(s)
Other().Hook(s)
s.Fire()
let d = Derived()
d.HookDerived()
d.Fire()
";

        const string csSource = """
            using System;

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
            }
            """;

        var expected = new[]
        {
            "same priv", "same bare priv", "same prot", "other intl", "other pub",
            "derived bare prot", "derived this prot", "derived intl",
        };
        AssertMatchesCSharp("source-event-access", source, csSource, expected);
    }

    /// <summary>
    /// Issue #4394: imported events against a C# library. A class deriving
    /// the declaring type subscribes to its <c>protected</c> and
    /// <c>protected internal</c> events through its own instance (as C#
    /// allows), and an unrelated class to a public one. Each accessor call
    /// must verify and run: an unreachable accessor would fail at run time
    /// with MethodAccessException.
    /// </summary>
    [Fact]
    public void ImportedEventAccess_ReachableCells_VerifyAndRun()
    {
        const string csLibrary = """
            using System;

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
            }
            """;

        const string source = @"
package P
import System
import EventAccess.Library

class Der : CSource {
    func Hook() {
        let h EventHandler = func (o object?, e EventArgs) { Console.WriteLine(""removed prot"") }
        this.Prot += h
        this.Prot += func (o object?, e EventArgs) { Console.WriteLine(""this prot"") }
        this.ProtIntl += func (o object?, e EventArgs) { Console.WriteLine(""this protintl"") }
        this.Prot -= h
    }
    func HookOther(other Der) {
        other.Prot += func (o object?, e EventArgs) { Console.WriteLine(""other der prot"") }
    }
}

class Other {
    func Hook(s CSource) {
        s.Pub += func (o object?, e EventArgs) { Console.WriteLine(""other pub"") }
    }
}

let d = Der()
d.Hook()
d.Fire()
let d2 = Der()
d.HookOther(d2)
Other().Hook(d2)
d2.Fire()
";

        var tempDir = Directory.CreateTempSubdirectory("gs_event_access_").FullName;
        try
        {
            var library = BuildCsLibrary(tempDir, csLibrary, "EventAccess.Library");
            var lines = CompileVerifyAndRun(tempDir, "imported-event-access", source, library);
            Assert.Equal(new[] { "this prot", "this protintl", "other der prot", "other pub" }, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void AssertMatchesCSharp(string name, string source, string csSource, string[] expected)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_event_mg_").FullName;
        try
        {
            var gsLines = CompileVerifyAndRun(tempDir, name, source);
            var csLines = RunCSharpProgram(tempDir, name + "-cs", csSource);
            Assert.Equal(expected, csLines);
            Assert.Equal(csLines, gsLines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] CompileVerifyAndRun(string tempDir, string name, string source, params string[] libraries)
    {
        var (exit, stdout, stderr) = Compile(tempDir, name, source, libraries);
        Assert.True(exit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        var outPath = Path.Combine(tempDir, name + ".dll");
        IlVerifier.Verify(outPath, libraries);
        foreach (var library in libraries)
        {
            File.Copy(library, Path.Combine(tempDir, Path.GetFileName(library)), overwrite: true);
        }

        var (runExit, output) = RunDotnet(outPath);
        Assert.True(runExit == 0, $"program must run to completion. Exit {runExit}:\n{output}");
        return SplitLines(output);
    }

    /// <summary>
    /// Compiles the C# reference program in-process with Roslyn and runs it,
    /// so the expected output is what C# itself produces for the same shape.
    /// </summary>
    private static string[] RunCSharpProgram(string tempDir, string name, string csSource)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            name,
            new[] { CSharpSyntaxTree.ParseText(csSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication, nullableContextOptions: NullableContextOptions.Enable));
        var dll = Path.Combine(tempDir, name + ".dll");
        using (var output = File.Create(dll))
        {
            var emitted = compilation.Emit(output);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        }

        var runtimeVersion = Environment.Version;
        File.WriteAllText(
            Path.ChangeExtension(dll, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net" + runtimeVersion.Major + ".0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\""
                + runtimeVersion.Major + "." + runtimeVersion.Minor + ".0\"}}}");

        var (exit, text) = RunDotnet(dll);
        Assert.True(exit == 0, $"C# reference program failed. Exit {exit}:\n{text}");
        return SplitLines(text);
    }

    private static string[] SplitLines(string output)
        => output
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

    /// <summary>
    /// Compiles an imported C# contract in-process with Roslyn and returns the
    /// assembly path, to be passed explicitly to gsc (the same pattern as
    /// BaseMemberGapsEmitTests).
    /// </summary>
    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var contracts = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var libraryDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(libraryDir);
        var dll = Path.Combine(libraryDir, assemblyName + ".dll");
        using (var output = File.Create(dll))
        {
            var emitted = contracts.Emit(output);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        }

        return dll;
    }

    private static (int Exit, string Stdout, string Stderr) Compile(string tempDir, string name, string source, params string[] extraReferences)
    {
        var srcPath = Path.Combine(tempDir, name + ".gs");
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
