// <copyright file="AnonymousClassExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// ADR-0146 (issue #2243): Kotlin-style anonymous-object literals. Members are
/// newline/semicolon separated (no commas); field types are optional and
/// inferred from the initializer; `object : Type` / `object : Type(args)`
/// supply an interface or base class; `data object` synthesizes value
/// semantics and supports `with`. Methods and events are permitted; init
/// and deinit are rejected.
open class AnonymousClassExpressionTests {
    @Fact
    func FieldOnly_InferredTypes_MemberAccessReturnsValue() {
        let source = `
let x = object { let Name = "Foo"; let Age = 42 }
x.Name
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Foo", result.Value)
    }

    @Fact
    func FieldOnly_ExplicitTypes_MemberAccessReturnsValue() {
        let source = `
let x = object { let Name string = "Foo"; let Age int32 = 42 }
x.Age
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func FieldOnly_MixedInferredAndExplicit_Binds() {
        let source = `
let x = object { let Name = "Foo"; let Age int32 = 42; let Flag bool = true }
x.Flag
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func FieldOnly_NewlineSeparatedMembers_Binds() {
        let source = `
let x = object {
    let Name = "David"
    let Language = "GSharp"
    let Flag bool = true
    let Number int = 42
}
x.Language
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("GSharp", result.Value)
    }

    @Fact
    func FieldOnly_CommaSeparator_IsRejected() {
        // ADR-0146 hard-breaking change: the old comma-separated member shape
        // is no longer accepted; members are newline/semicolon separated.
        let diagnostics = GetDiagnostics(`
let x = object { let Name = "Foo", let Age = 42 }
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func FieldOnly_SameShape_UnifiesToOneSynthesizedType() {
        let source = `
let a = object { let Id int32 = 1; let Alias string = "x" }
let b = object { let Id int32 = 2; let Alias string = "y" }
1
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state; nothing needs to run.
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        Assert.Single(compilation.GlobalScope.AnonymousTypes)
    }

    @Fact
    func FieldOnly_DifferentShape_ProducesDifferentTypes() {
        let source = `
let a = object { let Id int32 = 1 }
let b = object { let Id int32 = 1; let Alias string = "x" }
1
`
        // Binder-inspection test (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's
        // bound state; nothing needs to run.
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
        Assert.Equal(2, compilation.GlobalScope.AnonymousTypes.Length)
    }

    @Fact
    func DataObject_StructuralEquality_MatchesByValue() {
        let source = `
let a = data object { let Id int32 = 1; let Alias string = "x" }
let b = data object { let Id int32 = 1; let Alias string = "x" }
a == b
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataObject_ToString_ListsMembers() {
        let source = `
let a = data object { let Id int32 = 1; let Alias string = "x" }
a.ToString()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Contains("Id", cast[string](result.Value))
        Assert.Contains("Alias", cast[string](result.Value))
    }

    @Fact
    func DataObject_With_ProducesIndependentCopy() {
        let source = `
let mydata = data object { let Name = "David"; let Language = "GSharp" }
let other = mydata with { Name = "Amelia" }
other.Name + ":" + mydata.Name + ":" + other.Language
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Amelia:David:GSharp", result.Value)
    }

    @Fact
    func DataObject_With_DoesNotMutateOriginal() {
        let source = `
let mydata = data object { let Name = "David" }
let other = mydata with { Name = "Amelia" }
mydata.Name
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("David", result.Value)
    }

    @Fact
    func ImplementsInterface_MethodCallableThroughBothReferences() {
        let output = CompileAndRun(`
import System
interface MouseListener { func onClick() string; }
let listener = object : MouseListener { func onClick() string -> "Button clicked!" }
Console.WriteLine(listener.onClick())
let asIface MouseListener = listener
Console.WriteLine(asIface.onClick())
`)
        Assert.Equal("Button clicked!" + Environment.NewLine + "Button clicked!" + Environment.NewLine, output)
    }

    @Fact
    func ExtendsBaseClass_OverriddenMethodRuns() {
        let output = CompileAndRun(`
import System
open class Animal(Name string) { open func SaySomething() string -> "generic" }
let dog = object : Animal("Fluffy") { override func SaySomething() string -> "woof!" }
Console.WriteLine(dog.SaySomething())
`)
        Assert.Equal("woof!" + Environment.NewLine, output)
    }

    @Fact
    func EventMember_IsEmittedOnSynthesizedType() {
        let diagnostics = GetDiagnostics(`
let e = object { event Clicked () -> void }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func InitMember_IsRejected() {
        let diagnostics = GetDiagnostics(`
let x = object { init() { } }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0485")
    }

    @Fact
    func DeinitMember_IsRejected() {
        let diagnostics = GetDiagnostics(`
let x = object { deinit { } }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0485")
    }

    @Fact
    func MissingInterfaceMember_IsReported() {
        let diagnostics = GetDiagnostics(`
interface MouseListener { func onClick() string; func onHover() string; }
let listener = object : MouseListener { func onClick() string -> "a" }
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func InvalidOverride_NoMatchingBaseMember_IsReported() {
        let diagnostics = GetDiagnostics(`
open class Animal(Name string) { open func SaySomething() string -> "generic" }
let dog = object : Animal("Fluffy") { override func Bark() string -> "woof" }
`)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func FieldOnly_InsideLambda_Binds() {
        let source = `
func project(id int32, alias string) string {
    let f = (i int32, a string) -> object { let Id int32 = i; let Alias string = a }
    let r = f(id, alias)
    return r.Alias
}
project(7, "hi")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func FieldOnly_InsideExpressionTreeLambda_DoesNotReportGS0473() {
        // Issue #2224 (carried forward under ADR-0146): an anonymous-class
        // literal must be legal inside an expression tree, exactly like C#'s
        // `new { ... }`. cs2gs-translated EF Core migrations depend on this.
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

class Row {
    var Id int32
    var Alias string
}

let expr Expression[Func[Row, object]] = (r Row) -> object { let Id = r.Id; let Alias = r.Alias }
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
        Assert.Empty(diagnostics)
    }

    @Fact
    func PublicApiBoundary_NarrowsToDeclaredSupertypeOrObject() {
        // ADR-0146 Kotlin-style visibility narrowing: a public function that
        // returns an `object { ... }` literal with a custom member (and no
        // declared supertype) exposes only the universal top type `object`, so
        // a caller cannot reach the custom member through the call result...
        let diagnostics = GetDiagnostics(`
func make() -> object { let Secret = 42 }
let v = make()
let x = v.Secret
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        // ...while assigning the same literal directly to a local `let` keeps
        // full access to the custom member (this is unaffected by the return-type
        // narrowing rule — it never applies to local bindings).
        let okDiagnostics = GetDiagnostics(`
let v = object { let Secret = 42 }
let x = v.Secret
`)
        Assert.Empty(okDiagnostics)
    }

    @Fact
    func PublicApiBoundary_WithDeclaredSupertype_NarrowsToThatSupertype() {
        // A public function returning `object : SomeInterface { ... }` narrows
        // the call-site's exposed type to SomeInterface: interface members remain
        // callable, but the anonymous body's own custom member does not.
        let diagnostics = GetDiagnostics(`
interface Greeter { func Greet() string; }
func make() -> object : Greeter { func Greet() string -> "hi"; let Secret int32 = 42 }
let v = make()
let greeting = v.Greet()
let x = v.Secret
`)
        Assert.Empty(diagnostics.Where((d Diagnostic) -> d.Id != "GS0158"))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func PrivateFunction_ReturningAnonymousClassLiteral_RetainsFullAccess() {
        // A private function is not a public API boundary, so the Kotlin
        // narrowing rule does not apply: the caller (in the same file) keeps
        // full access to the anonymous type's own custom member.
        let diagnostics = GetDiagnostics(`
private func make() -> object { func Foo() int32 -> 1; let Secret int32 = 42 }
let v = make()
let a = v.Foo()
let x = v.Secret
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func LocalVariable_BoundDirectlyToAnonymousClassLiteral_RetainsFullAccess() {
        // Regression guard (ADR-0146): a local `let`/`var` binding of an
        // anonymous-class literal is never narrowed — it always keeps the
        // actual synthesized type, full custom-member access included.
        let diagnostics = GetDiagnostics(`
let v = object { let Secret = 42 }
let x = v.Secret
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result.Diagnostics
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func CompileAndRun(source string) string {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            peStream.Position = 0
            let context = AssemblyLoadContext("anon-run", isCollectible: true)
            try {
                let assembly = context.LoadFromStream(peStream)
                let programType = assembly.GetTypes().First((t Type) -> t.Name == "<Program>")
                let entry MethodInfo? = programType.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                let savedOut = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(savedOut)
                }
                return captured.ToString()
            } finally {
                context.Unload()
            }
        }
    }
}
