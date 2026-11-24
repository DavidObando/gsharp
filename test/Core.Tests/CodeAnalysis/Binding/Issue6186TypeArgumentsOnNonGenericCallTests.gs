// <copyright file="Issue6186TypeArgumentsOnNonGenericCallTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6186: a type-argument list on a call to a callee that declares no type parameters
/// reports GS0148 (C# CS0308). Each type argument is bound, so an undefined type name reports
/// GS0113.
open class Issue6186TypeArgumentsOnNonGenericCallTests {
    @Theory
    @InlineData("let k = Use[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let k = Use[int32](x)", "GS0148 [int32]")
    @InlineData("let k = Use[int32, string](x)", "GS0148 [int32, string]")
    @InlineData("let k = Use[Nope]()", "GS0113 Nope|GS0148 [Nope]") // before the value-argument count
    @InlineData("let k = Use[int32](x, x)", "GS0148 [int32]")
    @InlineData("let k = c.M[int32]()", "GS0148 [int32]")
    @InlineData("let k = C.S[Nope]()", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let k = f[Nope]()", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let k = Over[int32]()", "GS0148 [int32]") // before overload selection
    @InlineData("let k = Over[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let k = c.O[int32]()", "GS0148 [int32]")
    @InlineData("let k = C.SO[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let k = c.Ext[int32]()", "GS0148 [int32]")
    @InlineData("let k = c.EO[int32]()", "GS0148 [int32]")
    @InlineData("let k = n.Invoke[int32](x)", "GS0148 [int32]") // the Invoke of a named delegate
    @InlineData("let k = n.Invoke[Nope](x)", "GS0113 Nope|GS0148 [Nope]") // #6200: no cascading GS0159
    @InlineData("let k = Over[int32](x)", "GS0148 [int32]") // an overload set without a generic candidate
    @InlineData("let k = c.M[int32](x)", "GS0148 [int32]") // an instance method
    @InlineData("let k = C.S[int32](x)", "GS0148 [int32]") // a static method
    @InlineData("let k = c.Ext[int32](x)", "GS0148 [int32]") // an extension function
    @InlineData("let k = f[int32](x)", "GS0148 [int32]") // a function value
    @InlineData("let k = c.Fn[int32](x)", "GS0148 [int32]") // a function-typed field
    @InlineData("let k = c.P[int32](x)", "GS0148 [int32]") // a function-typed property
    @InlineData("let k = c.O[int32](x)", "GS0148 [int32]") // overloaded methods without a generic candidate
    @InlineData("let k = C.SO[int32](x)", "GS0148 [int32]") // overloaded static methods
    @InlineData("let k = c.EO[int32](x)", "GS0148 [int32]") // overloaded extension functions
    @InlineData("let k = i.IM[int32](x)", "GS0148 [int32]") // an interface method
    @InlineData("let k = b.Get[int32](x)", "GS0148 [int32]") // a method of a constructed generic class
    @InlineData("let k = Gen[int32, int32](x)", "GS0148 [int32, int32]") // a generic function, wrong arity
    @InlineData("let k = c.G[int32, int32](x)", "GS0148 [int32, int32]") // a generic method, wrong arity
    @InlineData("let k = c.M[Nope](x)", "GS0113 Nope|GS0148 [Nope]") // #6200: no cascading GS0159
    @InlineData("let k = arr[int32?](x)", "GS0131 arr") // unambiguously type-shaped argument stays on GS0131
    @InlineData("let k = ints[x](x)", "GS0131 ints[x]") // non-callable indexed element reports GS0131
    func TypeArgumentsThatDoNotMatchTheCallee_ReportTheArity(statement string, expected string) {
        let source = Source(statement)
        Assert.Equal(expected.Split('|'), Errors(source))
    }

    @Theory
    @InlineData("let k = Gen[int32](x)")
    @InlineData("let k = c.G[int32](x)")
    @InlineData("let k = Mixed[int32](x)") // the generic candidate of a mixed overload set
    @InlineData("let k = Mixed(x)") // the non-generic candidate of a mixed overload set
    @InlineData("let k = c.Mixed[int32](x)")
    @InlineData("let k = c.Mixed(x)")
    @InlineData("let k = Use(x)")
    @InlineData("let k = arr[x](x)") // #6206: indexable callable slice indexed by local and invoked
    func TypeArgumentsThatMatchTheCallee_Bind(statement string) {
        Assert.Empty(Errors(Source(statement)))
    }

    @Theory
    @InlineData("let ok = Type.FilterName[int32](nil, nil)") // an imported static delegate field
    @InlineData(
        "let ok = HttpClientHandler().ServerCertificateCustomValidationCallback[int32](nil, nil, nil, default)"
    ) // an imported instance delegate property
    func ImportedDelegateMembers_ReportTheArity(statement string) {
        let source = "package P\n\nimport System\nimport System.Net.Http\n\nfunc F() {\n    " + statement + "\n}\n"
        Assert.Contains("GS0148 [int32]", Errors(source))
    }

    @Fact
    func CallsInsideAClass_ReportTheArity() {
        // A bare method, a bare static method, `this.M`, `base.BM` and a bare function-typed field.
        Assert.Equal(
            []string{"GS0148 [int32]", "GS0148 [int32]", "GS0148 [int32]", "GS0148 [int32]", "GS0148 [int32]"},
            Errors(Source("let k = 0") + Inside)
        )
    }

    @Fact
    func Issue6186Repro_ReportsEveryError() {
        let source = "package P\n\nfunc Use(x int32) int32 -> x\n\nfunc F() {\n    let x = 1\n    let y = Use[Nope](x)\n    let z = Use[int32](x)\n    let w = y + z\n}\n"
        Assert.Equal([]string{"GS0113 Nope", "GS0148 [Nope]", "GS0148 [int32]"}, Errors(source))
    }

    shared {
        private func Source(statement string) string -> Declarations +
            "\nfunc F(c C, i I, b Box[int32], f (int32) -> int32, arr [](int32) -> int32, ints []int32, n Named) {\n    let x = 1\n    " +
            statement +
            "\n}\n"

        private let Inside string = `
class D : B {
    var Fn (int32) -> int32 = (v int32) -> v
    func M(x int32) int32 -> x
    func Inside() {
        let a1 = M[int32](1)
        let a2 = S[int32](1)
        let a3 = this.M[int32](1)
        let a4 = base.BM[int32](1)
        let a5 = Fn[int32](1)
    }
    shared {
        func S(x int32) int32 -> x
    }
}
`

        private let Declarations string = `package P

interface I {
    func IM(x int32) int32;
}

open class B {
    func BM(x int32) int32 -> x
}

class C : B, I {
    var Fn (int32) -> int32 = (v int32) -> v
    prop P (int32) -> int32 {
        get { return Fn }
    }
    func M(x int32) int32 -> x
    func G[T](x T) T -> x
    func Mixed(x int32) int32 -> x
    func Mixed[T](x T) T -> x
    func IM(x int32) int32 -> x
    func O(x int32) int32 -> x
    func O(x string) int32 -> 0
    shared {
        func S(x int32) int32 -> x
        func SO(x int32) int32 -> x
        func SO(x string) int32 -> 0
    }
}

class Box[T] {
    func Get(x int32) int32 -> x
}

func (c C) Ext(x int32) int32 -> x
func (c C) EO(x int32) int32 -> x
func (c C) EO(x string) int32 -> 0

delegate Named(x int32) int32;

func Use(x int32) int32 -> x

func Gen[T](x T) T -> x

func Over(x int32) int32 -> x
func Over(x string) int32 -> 0

func Mixed(x int32) int32 -> x
func Mixed[T](x T) T -> x
`

        private func Errors(source string)[]string {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6186.gs"))
            let compilation = Compilation(tree)
            return compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .Select((d Diagnostic) -> d.Id + " " + source.Substring(d.Location.Span.Start, d.Location.Span.Length))
                .ToArray()
        }
    }
}
