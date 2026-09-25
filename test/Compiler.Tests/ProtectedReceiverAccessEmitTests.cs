// <copyright file="ProtectedReceiverAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4453: the cells of the protected-receiver matrix that C# allows
/// compile, pass ILVerify and print what the same program compiled by Roslyn
/// prints. A derived class reaches its base's <c>protected</c> fields,
/// methods, properties and events through <c>this</c>, <c>base</c>, a bare
/// name, a receiver of its own type, a receiver of a subclass, a type
/// parameter constrained to itself, inside a lambda and as a method group;
/// static protected members are reached through the declaring type; and the
/// declaring class reaches its own members through any receiver. (The
/// rejected cells are binder diagnostics, covered in Core.Tests'
/// <c>ProtectedReceiverAccessBinderTests</c>.)
/// </summary>
public class ProtectedReceiverAccessEmitTests
{
    [Fact]
    public void ReachableCells_VerifyAndRun_LikeCSharp()
    {
        const string source = @"
package P
import System

open class Source {
    protected var f int32
    protected func M() int32 -> f * 10
    protected prop P int32 { get -> f + 100 }
    protected prop Q int32 { get; set; }
    protected event E EventHandler?
    shared {
        protected var sf int32 = 7
        protected func SM() int32 -> 8
    }
    func Raise() { E?.Invoke(this, EventArgs.Empty) }
    func Same(o Source, d Derived) int32 {
        o.f = 1
        d.f = 2
        return o.M() + d.P
    }
}

open class Derived : Source {
    func Hook(d Derived, m More, h EventHandler) {
        this.f = 3
        d.f = 4
        m.f = 5
        m.f += 1
        d.Q = 9
        d.Q += 1
        d.E += h
        m.E += h
        this.E += h
        E += h
        Console.WriteLine(""fields ${f} ${d.f} ${m.f}"")
        Console.WriteLine(""methods ${this.M()} ${d.M()} ${m.M()} ${base.M()}"")
        Console.WriteLine(""props ${d.P} ${m.P} ${d.Q} ${base.P}"")
        let l = func() int32 { return d.f + m.f }
        let g = m.M
        let n = d?.P
        Console.WriteLine(""lambda ${l()} group ${g()} cond ${n ?? 0}"")
        Console.WriteLine(""static ${Source.sf} ${Source.SM()} ${Derived.SM()}"")
    }
    func Constrained[X Derived](x X) int32 {
        x.f = 11
        return x.M()
    }
}

class More : Derived {
}

let s = Source()
let d = Derived()
Console.WriteLine(""same ${s.Same(s, d)}"")
let m = More()
let h EventHandler = func (o object?, e EventArgs) { Console.WriteLine(""raised"") }
d.Hook(d, m, h)
d.Raise()
m.Raise()
Console.WriteLine(""constrained ${d.Constrained(m)}"")
";

        const string csSource = """
            using System;

            class Source
            {
                protected int f;
                protected int M() => f * 10;
                protected int P => f + 100;
                protected int Q { get; set; }
                protected event EventHandler? E;
                protected static int sf = 7;
                protected static int SM() => 8;
                public void Raise() { E?.Invoke(this, EventArgs.Empty); }
                public int Same(Source o, Derived d)
                {
                    o.f = 1;
                    d.f = 2;
                    return o.M() + d.P;
                }
            }

            class Derived : Source
            {
                public void Hook(Derived d, More m, EventHandler h)
                {
                    this.f = 3;
                    d.f = 4;
                    m.f = 5;
                    m.f += 1;
                    d.Q = 9;
                    d.Q += 1;
                    d.E += h;
                    m.E += h;
                    this.E += h;
                    E += h;
                    Console.WriteLine($"fields {f} {d.f} {m.f}");
                    Console.WriteLine($"methods {this.M()} {d.M()} {m.M()} {base.M()}");
                    Console.WriteLine($"props {d.P} {m.P} {d.Q} {base.P}");
                    Func<int> l = () => d.f + m.f;
                    Func<int> g = m.M;
                    int? n = d?.P;
                    Console.WriteLine($"lambda {l()} group {g()} cond {n ?? 0}");
                    Console.WriteLine($"static {Source.sf} {Source.SM()} {Derived.SM()}");
                }

                public int Constrained<X>(X x) where X : Derived
                {
                    x.f = 11;
                    return x.M();
                }
            }

            class More : Derived
            {
            }

            static class Program
            {
                static void Main()
                {
                    var s = new Source();
                    var d = new Derived();
                    Console.WriteLine($"same {s.Same(s, d)}");
                    var m = new More();
                    EventHandler h = (o, e) => Console.WriteLine("raised");
                    d.Hook(d, m, h);
                    d.Raise();
                    m.Raise();
                    Console.WriteLine($"constrained {d.Constrained(m)}");
                }
            }
            """;

        var expected = new[]
        {
            "same 112",
            "fields 4 4 6",
            "methods 40 40 60 40",
            "props 104 106 10 104",
            "lambda 10 group 60 cond 104",
            "static 7 8 8",
            "raised",
            "raised",
            "raised",
            "raised",
            "constrained 110",
        };
        EventAndBaseMethodGroupEmitTests.AssertMatchesCSharp("protected-receiver", source, csSource, expected);
    }
}
