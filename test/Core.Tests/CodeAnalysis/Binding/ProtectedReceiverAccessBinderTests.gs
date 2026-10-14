// <copyright file="ProtectedReceiverAccessBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4453: a derived class reaches a `protected` instance member
/// of a source base class only through a receiver of its own type or a
/// subtype (C# CS1540). A base- or sibling-typed receiver used to compile and
/// fail ILVerify (`FieldAccess`/`MethodAccess`); it is now GS0379 at
/// the member name. The rule covers every member kind and every access
/// shape, because it runs over the bound body rather than per binder path.
/// The reachable cells are compiled, verified and run in Compiler.Tests'
/// `ProtectedReceiverAccessEmitTests`.
class ProtectedReceiverAccessBinderTests {
    /// Every member kind and access shape through a receiver typed as the
    /// declaring base class, and through a sibling subclass: one GS0379 at the
    /// member's name, as C# reports one CS1540.
    /// @param statement The access, written against receiver `r`.
    /// @param member The member the diagnostic names and points at.
    @Theory
    @InlineData("let x = r.f", "f")
    @InlineData("r.f = 1", "f")
    @InlineData("r.f += 1", "f")
    @InlineData("let x = r.M()", "M")
    @InlineData("let g = r.M", "M")
    @InlineData("let x = r.P", "P")
    @InlineData("let x = r?.P", "P")
    @InlineData("r.Q = 1", "Q")
    @InlineData("r.Q += 1", "Q")
    @InlineData("r.E += h", "E")
    @InlineData("r.E -= h", "E")
    @InlineData("let l = func() int32 { return r.f }", "f")
    @InlineData("let x = {{T}}{ f: 1 }", "f")
    @InlineData("let x = {{T}}{ Q: 1 }", "Q")
    @InlineData("let x = r is { f: 1 }", "f")
    @InlineData("let x = r is { P: 2 }", "P")
    func ThroughBaseOrSiblingReceiver_IsGS0379AtMember(statement string, member string) {
        for receiverType in[]string{"Source", "Sibling"} {
            // A composite literal is written through the new instance, so
            // its type plays the receiver's part.
            let access = statement.Replace("{{T}}", receiverType, StringComparison.Ordinal)
            let source = Declarations + (`class Accessor : Derived {
    func Hook(r ` + "$receiverType" + `, h EventHandler) {
        ` + "$access" + `
    }
}`)
            AssertSingleGS0379At(source, access, member)
        }
    }

    /// A type parameter whose class constraint is the base stands for the
    /// base: C# reports CS1540 for `x.f` where `X : Source`.
    @Fact
    func ThroughTypeParameterConstrainedToBase_IsGS0379() {
        const statement = "x.f = 1"
        let source = Declarations + (`class Accessor : Derived {
    func Hook[X Source](x X) {
        ` + "$statement" + `
    }
}`)
        AssertSingleGS0379At(source, statement, "f")
    }

    /// A field initializer is code of its class too: `Source().f` in a
    /// derived class's initializer is CS1540 in C#.
    @Fact
    func InFieldInitializer_ThroughBaseReceiver_IsGS0379() {
        const statement = "var g int32 = Source().f"
        let source = Declarations + (`class Accessor : Derived {
    ` + "$statement" + `
}`)
        AssertSingleGS0379At(source, statement, "f")
    }

    /// A `shared` init block of a derived class follows the same rule.
    @Fact
    func InStaticInitializer_ThroughBaseReceiver_IsGS0379() {
        const statement = "Source().M()"
        let source = Declarations + (`class Accessor : Derived {
    shared {
        init {
            ` + "$statement" + `
        }
    }
}`)
        AssertSingleGS0379At(source, statement, "M")
    }

    /// A protected source indexer through a base-typed receiver: one GS0379
    /// naming the indexer, even for a compound write that calls both the
    /// getter and the setter.
    /// @param statement The indexer access.
    @Theory
    @InlineData("let x = r[0]")
    @InlineData("r[0] = 1")
    @InlineData("r[0] += 1")
    func IndexerThroughBaseReceiver_IsGS0379Once(statement string) {
        let source = `open class Source {
    protected prop this[i int32] int32 {
        get -> i
        set { }
    }
}
open class Derived : Source {
}
` + (`class Accessor : Derived {
    func Hook(r Source) {
        ` + "$statement" + `
    }
}`)
        let errors = EmittedOracle.Evaluate(source).Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        let error = Assert.Single(errors)
        Assert.Equal("GS0379", error.Id)
        Assert.Contains("'Source.Item'", error.Message, StringComparison.Ordinal)
    }

    /// Nested classes that share a simple name and package are still
    /// different classes: inside `B.D`, a receiver of `A.D` is a
    /// sibling, as C# (CS1540) and the CLR see it.
    @Fact
    func ThroughNestedHomonymReceiver_IsGS0379() {
        const statement = "let x = r.f"
        let source = Declarations + (`class A {
    class D : Source { }
}
class B {
    class D : Source {
        func Hook(r A.D) {
            ` + "$statement" + `
        }
    }
}`)
        AssertSingleGS0379At(source, statement, "f")
    }

    /// A `: base(...)` argument is bound outside the constructor body,
    /// for explicit and primary constructors alike, and is still class code.
    /// A block argument is target-dependent: constructor resolution rebinds
    /// it after the first pass, so the check runs on the final arguments.
    /// @param declaration The derived class, reading `s.f` in its base-constructor arguments.
    @Theory
    @InlineData(`class Accessor : Seeded {
    init(s Source) : base(s.f) {}
}`)
    @InlineData("class Accessor(s Source) : Seeded(s.f) {\n}")
    @InlineData(`class Accessor : Seeded {
    init(s Source) : base({ let x = s.f x }) {}
}`)
    @InlineData("class Accessor(s Source) : Seeded({ let x = s.f x }) {\n}")
    func InBaseConstructorArguments_ThroughBaseReceiver_IsGS0379(declaration string) {
        let source = Declarations + `open class Seeded : Source {
    init(v int32) {}
}
` + declaration
        AssertSingleGS0379At(source, "s.f", "f")
    }

    /// Property patterns resolve members without the class-level check the
    /// other access paths make; they now report it too.
    /// @param statement The pattern read.
    /// @param id The expected diagnostic.
    /// @param member The member named in the diagnostic.
    @Theory
    @InlineData("let x = s is { f: 1 }", "GS0379", "f")
    @InlineData("let x = s is { P: 2 }", "GS0379", "P")
    @InlineData("let x = s is { hidden: 3 }", "GS0472", "hidden")
    func PropertyPattern_FromUnrelatedClass_IsReportedInaccessible(statement string, id string, member string) {
        let source = PatternDeclarations + (`class Other {
    func Hook(s Source) {
        ` + "$statement" + `
    }
}`)
        AssertSingleErrorOnMember(source, id, member)
    }

    /// Top-level statements are bound outside any function body; a property
    /// pattern there is checked the same way.
    /// @param statement The pattern read.
    /// @param id The expected diagnostic.
    /// @param member The member named in the diagnostic.
    @Theory
    @InlineData("let x = Source() is { f: 1 }", "GS0379", "f")
    @InlineData("let x = Source() is { hidden: 3 }", "GS0472", "hidden")
    func PropertyPattern_InTopLevelStatement_IsReportedInaccessible(statement string, id string, member string) {
        AssertSingleErrorOnMember(PatternDeclarations + statement + "\n", id, member)
    }

    /// An unrelated class already fails the class-level check; the receiver
    /// rule must not report the same access a second time.
    @Fact
    func FromUnrelatedClass_ReportsOnce() {
        const statement = "r.f = 1"
        let source = Declarations + (`class Other {
    func Hook(r Sibling) {
        ` + "$statement" + `
    }
}`)
        AssertSingleGS0379At(source, statement, "f")
    }

    /// The cells C# allows bind without diagnostics: `this`,
    /// `base`, bare names, receivers of the accessing class and of its
    /// subclasses (including inside a lambda, a method group, a
    /// null-conditional access, a composite literal and a property pattern
    /// of the accessing class or a subclass), a type parameter constrained to the
    /// accessing class, any construction of a generic accessing class, static
    /// members through the declaring type, and the declaring class itself
    /// through any receiver.
    @Fact
    func ReachableCells_Bind() {
        let source = Declarations + `open class Accessor : Derived {
    func Hook(a Accessor, m MoreAccessor, h EventHandler) int32 {
        this.f = 1
        a.f = 2
        m.f += 3
        a.Q = 4
        m.Q += 5
        a.E += h
        m.E -= h
        f = 6
        E += h
        let l = func() int32 { return a.f + this.M() }
        let g = m.M
        let n = a?.P
        let s = Source.sf + Source.SM() + Derived.SM()
        let lit = Accessor{ f: 7, Q: 8 }
        let lit2 = MoreAccessor{ f: 9 }
        let pat = a is { f: 1, P: 2 } || m is { Q: 3 }
        return base.f + base.M() + a.M() + m.P + l() + g() + s + (n ?? 0)
    }
    func Constrained[X Accessor](x X) int32 -> x.f + x.M()
}
class MoreAccessor : Accessor {
}
open class G[T] : Source {
    func Hook(o G[int32], p G[T]) int32 -> o.f + p.M() + this.P
}
open class Base2 {
    protected var v int32
    func Any(o Base2, d Sub2) int32 -> o.v + d.v
}
class Sub2 : Base2 {
}`
        let errors = EmittedOracle.Evaluate(source).Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.True(
            errors.Length == 0,
            string.Join(
                Environment.NewLine,
                errors.Select((e Diagnostic) -> "${e.Id} ${e.Location.StartLine + 1}: ${e.Message}")
            )
        )
    }

    shared {
        private const Declarations string = `import System

open class Source {
    protected var f int32
    protected func M() int32 -> 1
    protected prop P int32 { get -> 2 }
    protected prop Q int32 { get; set; }
    protected event E EventHandler?
    shared {
        protected var sf int32
        protected func SM() int32 -> 5
    }
}

open class Derived : Source {
}

class MoreDerived : Derived {
}

class Sibling : Source {
}
`

        private const PatternDeclarations string = `open class Source {
    protected var f int32
    protected prop P int32 { get -> 2 }
    private var hidden int32
}
`

        private func AssertSingleErrorOnMember(source string, id string, member string) {
            let errors = EmittedOracle.Evaluate(source).Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
            let error = Assert.Single(errors)
            Assert.Equal(id, error.Id)
            let text = Assert.IsType[SourceText](error.Location.Text)
            Assert.Equal(member, text.ToString(error.Location.Span))
        }

        private func AssertSingleGS0379At(source string, statement string, member string) {
            let errors = EmittedOracle.Evaluate(source).Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
            let error = Assert.Single(errors)
            Assert.Equal("GS0379", error.Id)
            Assert.Contains("'Source.$member'", error.Message, StringComparison.Ordinal)
            // The diagnostic points at the member's name in the statement.
            let text = Assert.IsType[SourceText](error.Location.Text)
            Assert.Equal(member, text.ToString(error.Location.Span))
            let line = text.Lines[error.Location.StartLine].ToString()
            let statementColumn = line.IndexOf(statement, StringComparison.Ordinal)
            Assert.True(statementColumn >= 0, "GS0379 is on '$line', not on the statement '$statement'")
            // The member follows the receiver's `.`, or a composite literal's `{`.
            let memberColumn = statement.IndexOf(
                member,
                statement.IndexOfAny([]char{'.', '{'}),
                StringComparison.Ordinal
            )
            Assert.Equal(statementColumn + memberColumn, error.Location.StartCharacter)
        }
    }
}
