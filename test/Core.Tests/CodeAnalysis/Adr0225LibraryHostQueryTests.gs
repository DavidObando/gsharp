// <copyright file="Adr0225LibraryHostQueryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// The library-host queries of ADR-0225 D6.7 and the Oats design note §6 (#6079): fragment parsing,
/// declared symbols of parameters and locals, the symbol of a constructor call, and the expected type.
open class Adr0225LibraryHostQueryTests {
    @Fact
    func GetDeclaredSymbol_AnswersForParameterAndLocalDeclarations() {
        const source = `package P

func F(p int32, unused string) {
    let x = 1
    var y int64 = 2
}
`
        let (tree, model) = Model(source)
        let parameters = Descendants(tree.Root).OfType[ParameterSyntax]().ToList()
        Assert.Equal(2, parameters.Count)
        let p = Assert.IsAssignableFrom[ParameterSymbol](model.GetDeclaredSymbol(parameters[0]))
        Assert.Equal("p", p.Name)
        Assert.Equal(TypeSymbol.Int32, p.Type)
        // A parameter that the body never reads.
        Assert.Equal("unused", Assert.IsAssignableFrom[ParameterSymbol](model.GetDeclaredSymbol(parameters[1])).Name)
        let locals = Descendants(tree.Root).OfType[VariableDeclarationSyntax]().ToList()
        Assert.Equal(2, locals.Count)
        let x = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(locals[0]))
        Assert.Equal("x", x.Name)
        let y = Assert.IsAssignableFrom[LocalVariableSymbol](model.GetDeclaredSymbol(locals[1]))
        Assert.Equal(TypeSymbol.Int64, y.Type)
        // The identifier token answers the same symbol.
        Assert.Same(x, model.GetDeclaredSymbol(locals[0].Identifier))
    }

    @Fact
    func GetSymbolInfo_OfASourceConstructorCall_IsTheChosenConstructor() {
        const source = `package P

class Box {
    init(v int32) {
    }

    init(s string) {
    }
}

func F() {
    let a = Box(1)
    let b = Box("s")
}
`
        let (tree, model) = Model(source)
        let box = Assert.IsType[StructSymbol](
            model.GetDeclaredSymbol(Descendants(tree.Root).OfType[StructDeclarationSyntax]().Single())
        )
        let calls = Descendants(tree.Root).OfType[CallExpressionSyntax]().ToList()
        Assert.Equal(2, calls.Count)
        Assert.Same(box.ExplicitConstructors[0].Function, model.GetSymbolInfo(calls[0]).Symbol)
        Assert.Same(box.ExplicitConstructors[1].Function, model.GetSymbolInfo(calls[1]).Symbol)
    }

    @Fact
    func ParseExpressionAndStatement_ParseAFragmentOnItsOwn() {
        let expression = Assert.IsType[BinaryExpressionSyntax](SyntaxTree.ParseExpression("a + 1"))
        Assert.Equal(0, expression.Span.Start)
        Assert.Equal(5, expression.Span.End)
        Assert.Empty(expression.SyntaxTree.Diagnostics)
        let statement = Assert.IsType[VariableDeclarationSyntax](SyntaxTree.ParseStatement("let x = 1"))
        Assert.Equal("x", statement.Identifier.Text)
        // A parse error stays on the fragment's tree.
        let broken = SyntaxTree.ParseExpression("a +")
        Assert.NotNull(broken)
        Assert.NotEmpty(broken!!.SyntaxTree.Diagnostics)
        Assert.Null(SyntaxTree.ParseStatement("func F() {}"))
        Assert.Null(SyntaxTree.ParseStatement("let a = 1\nlet b = 2"))
        Assert.Null(SyntaxTree.ParseStatement(""))
        Assert.Null(SyntaxTree.ParseStatement("@assembly:CLSCompliant(true)\nlet x = 1"))
        Assert.Null(SyntaxTree.ParseExpression("let x = 1"))
        Assert.Null(SyntaxTree.ParseExpression(""))
        Assert.Null(SyntaxTree.ParseExpression("a b"))
        // Forms that only the expression grammar reads at the start of a fragment.
        Assert.IsType[FunctionLiteralExpressionSyntax](SyntaxTree.ParseExpression("func () int32 { return 1 }"))
        Assert.NotNull(SyntaxTree.ParseExpression("{ 1 }"))
        // A parsed expression binds speculatively at a position of another tree.
        const source = "package P\n\nfunc F(p int32) {\n    let q = p\n}\n"
        let (_, model) = Model(source)
        let speculative = model.GetSpeculativeTypeInfo(
            source.IndexOf("let q", StringComparison.Ordinal),
            SyntaxTree.ParseExpression("p + 1")!!
        )
        Assert.Equal(TypeSymbol.Int32, speculative.Type)
    }

    @Fact
    func GetExpectedType_AnswersTheTypeOfTheContext() {
        const source = `package P

func Take(a int32, b string, c int64) {
}

func Apply(f (int32) -> int32) {
}

func Pred(p () -> bool) {
}

func F() int64 {
    Apply((n int32) -> n)
    Pred(func () bool {
        return false
    })
    var s string = "x"
    let typed float64 = 1.0
    s = "y"
    Take(1, "z", 3)
    let f = func () bool {
        return true
    }
    let g = (n int32) -> n
    return 4
}
`
        let (_, model) = Model(source)
        Assert.Equal(TypeSymbol.Float64, model.GetExpectedType(source.IndexOf("1.0", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"y\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(source.IndexOf("1, \"z\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"z\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int64, model.GetExpectedType(source.IndexOf("3)", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Bool, model.GetExpectedType(source.IndexOf("true", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int64, model.GetExpectedType(source.IndexOf("4\n", StringComparison.Ordinal)))
        // The header of a literal or lambda argument gets the parameter type; a literal that is an
        // argument gives its declared return type to its `return`.
        Assert.IsType[FunctionTypeSymbol](
            model.GetExpectedType(source.IndexOf("(n int32) ->", StringComparison.Ordinal))
        )
        Assert.IsType[FunctionTypeSymbol](
            model.GetExpectedType(source.IndexOf("func () bool {\n        return false", StringComparison.Ordinal))
        )
        Assert.Equal(TypeSymbol.Bool, model.GetExpectedType(source.IndexOf("false", StringComparison.Ordinal)))
        // A declaration without a type, and a lambda body, expect nothing.
        Assert.Null(model.GetExpectedType(source.IndexOf("let f = func", StringComparison.Ordinal) + 8))
        Assert.Null(model.GetExpectedType(source.IndexOf("-> n", StringComparison.Ordinal) + 3))
    }

    @Fact
    func GetExpectedType_InAnOpenArgumentList_ReadsTheCandidates() {
        const text = `package P

func Put(a int32, b string) {
}

func Put(a int32, b string, c bool) {
}

func Mix(a int32) {
}

func Mix(a string) {
}

func F() {
    Put(1, `
        let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
        let compilation = Compilation(tree){.RecordMemberGroups: true}
        let result = compilation.BindPrefix(tree, text.Length, PrefixBindOptions(PrefixRemainder.Nothing))
        let model = result.Compilation.GetSemanticModel(result.SyntaxTree)
        // Both overloads take a string in the second slot.
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(text.Length))
        let mixText = text.Replace("Put(1, ", "Mix(")
        let mixTree = SyntaxTree.Parse(SourceText.From(mixText, "prefix.gs"))
        let mix = Compilation(mixTree){.RecordMemberGroups: true}.BindPrefix(
            mixTree,
            mixText.Length,
            PrefixBindOptions(PrefixRemainder.Nothing)
        )
        // The candidates disagree.
        Assert.Null(mix.Compilation.GetSemanticModel(mix.SyntaxTree).GetExpectedType(mixText.Length))
    }

    @Fact
    func GetExpectedType_AnswersForSourceImportedGenericAndNamedSlots() {
        const source = `package P

import System

class Box {
    func Put(v int32, w string) {
    }
}

func (b Box) Tag(label string, weight float64) {
}

func Same[T](a T, b T) {
}

func Named(a int32, b string) {
}

func F() {
    let box = Box()
    box.Put(1, "a")
    box.Tag("t", 2.0)
    Same(1, 2)
    Console.WriteLine("x")
    Named(b: "q", a: 3)
}
`
        let (_, model) = Model(source)
        // An instance method and a receiver function map slots to their declared parameters.
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"a\")", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"t\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Float64, model.GetExpectedType(source.IndexOf("2.0", StringComparison.Ordinal)))
        // Before the type parameter is fixed, slot 0 of Same(1, 2) answers nothing; slot 1 gets int32.
        Assert.Null(model.GetExpectedType(source.IndexOf("1, 2)", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(source.IndexOf("2)", StringComparison.Ordinal)))
        // Without member-group recording, the chosen overload of Console.WriteLine expects string?.
        Assert.Equal(
            NullableTypeSymbol.Get(TypeSymbol.String),
            model.GetExpectedType(source.IndexOf("\"x\"", StringComparison.Ordinal))
        )
        // Named arguments resolve by parameter name.
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(source.IndexOf("\"q\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(source.IndexOf("3)", StringComparison.Ordinal)))
        // With member-group recording, Console.WriteLine's disagreeing overloads answer nothing.
        let recordedTree = SyntaxTree.Parse(SourceText.From(source, "recorded.gs"))
        let recorded = Compilation(recordedTree){.RecordMemberGroups: true}
        Assert.Empty(recorded.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Null(
            recorded.GetSemanticModel(recordedTree).GetExpectedType(source.IndexOf("\"x\"", StringComparison.Ordinal))
        )
    }

    @Fact
    func GetExpectedType_ImportedMethodAndConstructorSlots_FollowAdr0193AndOverloadAgreement() {
        const csharpContract = `
#nullable enable
namespace Contract6223 {
    public sealed class SingleCtor {
        public SingleCtor(string path) { }
        public void SetRequired(string value) { }
        public void SetNullable(string? value) { }
    }

    public sealed class AgreeMulti {
        public AgreeMulti(string? label) { }
        public AgreeMulti(string? label, int count) { }
        public static void Agree(string? text) { }
        public static void Agree(string? text, int count) { }
        public static void MixNullability(string text, int count) { }
        public static void MixNullability(string? text, string tag) { }
    }

    public sealed class GenericBox<T> {
        public GenericBox(T value) { }
        public void PutRequired(T value) { }
        public void PutNullable(T? value) { }
    }
    public sealed partial class MixPlatform {
        public static void Take(string text, int count) { }
    }
}

#nullable disable
namespace Contract6223 {
    public sealed class ObliviousApi {
        public ObliviousApi(string text) { }
        public static void Take(string text) { }
    }

    public sealed partial class MixPlatform {
        public static void Take(string text, string tag) { }
    }
}
`
        using let fixture = CSharpFixture(csharpContract)
        using let references = fixture.RuntimeReferences()

        let AssertPrefix = func (prefix string, expected TypeSymbol?) {
            let tree = SyntaxTree.Parse(SourceText.From(prefix, "imported-prefix.gs"))
            let compilation = Compilation(references, tree){.RecordMemberGroups: true}
            let result = compilation.BindPrefix(tree, prefix.Length, PrefixBindOptions(PrefixRemainder.Nothing))
            let actual = result.Compilation.GetSemanticModel(result.SyntaxTree).GetExpectedType(prefix.Length)
            Assert.Equal(expected, actual)
        }

        const header = `package P
import Contract6223
import System
import System.Collections.Generic
import System.IO
import System.Text

func F(
    sb StringBuilder,
    list List[string],
    nullableList List[string?],
    dict Dictionary[string, int32],
    nullableDict Dictionary[string, string?],
    box GenericBox[string]
) {
`
        // Bcl methods and constructors: disagreeing slots return null, agreeing slots return ADR-0193 type.
        AssertPrefix(header + "    sb.Append(", nil)
        AssertPrefix(header + "    sb.Append(\"x\", ", nil)
        AssertPrefix(header + "    sb.Append(\"x\", 0, ", TypeSymbol.Int32)
        AssertPrefix(header + "    StringBuilder(", nil)
        AssertPrefix(header + "    StringBuilder(\"x\", ", TypeSymbol.Int32)
        AssertPrefix(header + "    System.Text.StringBuilder(\"x\", ", TypeSymbol.Int32)
        AssertPrefix(header + "    FileInfo(", TypeSymbol.String)
        AssertPrefix(header + "    Path.GetFullPath(", TypeSymbol.String)
        AssertPrefix(header + "    Console.WriteLine(", nil)

        // Constructed generic receivers preserve type-argument substitution and nullability.
        AssertPrefix(header + "    list.Add(", TypeSymbol.String)
        AssertPrefix(header + "    nullableList.Add(", NullableTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    dict.TryGetValue(", TypeSymbol.String)
        AssertPrefix(header + "    dict.TryGetValue(\"k\", ", ByRefTypeSymbol.Get(TypeSymbol.Int32))
        AssertPrefix(header + "    nullableDict.Add(\"k\", ", NullableTypeSymbol.Get(TypeSymbol.String))

        // ADR-0193 fidelity on custom C# contracts (non-null, stated nullable, oblivious platform type).
        AssertPrefix(header + "    SingleCtor(", TypeSymbol.String)
        AssertPrefix(header + "    SingleCtor(\"a\").SetRequired(", TypeSymbol.String)
        AssertPrefix(header + "    SingleCtor(\"a\").SetNullable(", NullableTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    AgreeMulti.Agree(", NullableTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    AgreeMulti(\"x\", ", TypeSymbol.Int32)
        AssertPrefix(header + "    AgreeMulti.MixNullability(", nil)
        AssertPrefix(header + "    ObliviousApi(", PlatformTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    ObliviousApi.Take(", PlatformTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    GenericBox[string](", TypeSymbol.String)
        AssertPrefix(header + "    GenericBox[string?](", NullableTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    box.PutRequired(", TypeSymbol.String)
        AssertPrefix(header + "    box.PutNullable(", NullableTypeSymbol.Get(TypeSymbol.String))

        // Multi-overload constructors that agree at slot 0 return the agreed type.
        const agreeCtorSource = header + "    let _ = AgreeMulti(\"ok\")\n}\n"
        let agreeTree = SyntaxTree.Parse(SourceText.From(agreeCtorSource, "agree-ctor.gs"))
        let agreeComp = Compilation(references, agreeTree){.RecordMemberGroups: true}
        Assert.Empty(agreeComp.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        Assert.Equal(
            NullableTypeSymbol.Get(TypeSymbol.String),
            agreeComp.GetSemanticModel(agreeTree).GetExpectedType(
                agreeCtorSource.IndexOf("\"ok\"", StringComparison.Ordinal)
            )
        )

        // Disagreeing oblivious vs stated non-null overload returns null.
        AssertPrefix(header + "    MixPlatform.Take(", nil)
    }

    @Fact
    func GetExpectedType_NamedArgumentSlots_ResolveByNameAcrossCandidates() {
        const header = `package P

import System
import System.Collections.Generic
import System.Text

func Named(a int32, b string) {
}

func Over(a int32) {
}

func Over(a int32, b string) {
}

func Disjoint(a int32, b string) {
}

func Disjoint(a string, b int32) {
}

func F(sb StringBuilder, dict Dictionary[string, int32]) {
`
        let AssertPrefix = func (prefix string, expected TypeSymbol?) {
            let tree = SyntaxTree.Parse(SourceText.From(prefix, "named-prefix.gs"))
            let compilation = Compilation(tree){.RecordMemberGroups: true}
            let result = compilation.BindPrefix(tree, prefix.Length, PrefixBindOptions(PrefixRemainder.Nothing))
            let actual = result.Compilation.GetSemanticModel(result.SyntaxTree).GetExpectedType(prefix.Length)
            Assert.Equal(expected, actual)
        }

        // Source named slots: reordered, matching partial overload set, disagreeing, unknown, duplicate.
        AssertPrefix(header + "    Named(b: ", TypeSymbol.String)
        AssertPrefix(header + "    Named(b: \"q\", a: ", TypeSymbol.Int32)
        AssertPrefix(header + "    Named(a: 1, ", TypeSymbol.String)
        AssertPrefix(header + "    Named(b: \"q\", ", nil)
        AssertPrefix(header + "    Over(b: ", TypeSymbol.String)
        AssertPrefix(header + "    Disjoint(b: ", nil)
        AssertPrefix(header + "    Named(unknown: ", nil)
        AssertPrefix(header + "    Named(a: 1, a: ", nil)
        AssertPrefix(header + "    Named(1, a: ", nil)

        // Imported named slots: method, constructor, generic receiver, and unknown name.
        AssertPrefix(header + "    StringBuilder(capacity: ", TypeSymbol.Int32)
        AssertPrefix(header + "    sb.Append(repeatCount: ", TypeSymbol.Int32)
        AssertPrefix(header + "    dict.TryGetValue(key: ", TypeSymbol.String)
        AssertPrefix(header + "    dict.TryGetValue(value: ", ByRefTypeSymbol.Get(TypeSymbol.Int32))
        AssertPrefix(header + "    sb.Append(nope: ", nil)

        // Complete call checks: position on label name before ':' returns null; duplicate name returns null.
        const complete = header + `
    Named(b: "q", a: 3)
    Named(a: 1, a: 2)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(complete, "named-complete.gs"))
        let compilation = Compilation(tree){.RecordMemberGroups: true}
        let model = compilation.GetSemanticModel(tree)
        Assert.Null(model.GetExpectedType(complete.IndexOf("b: \"q\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.String, model.GetExpectedType(complete.IndexOf("\"q\"", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(complete.IndexOf("3)", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(complete.IndexOf("1, a: 2", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(complete.IndexOf("2)", StringComparison.Ordinal)))
    }

    @Fact
    func GetExpectedType_GenericSlots_AnswerWhenFixedBeforeSlotAndNullOtherwise() {
        const csharpGeneric = `
#nullable enable
namespace GenericContract6223 {
    public static class Helpers {
        public static void Pair<T>(T first, T second) { }
        public static void Tri<T>(T a, T b, T c) { }
        public static void OpenNullable<T>(T first, T? second) { }
    }
}
`
        using let fixture = CSharpFixture(csharpGeneric)
        using let references = fixture.RuntimeReferences()

        let AssertPrefix = func (prefix string, expected TypeSymbol?) {
            let tree = SyntaxTree.Parse(SourceText.From(prefix, "generic-prefix.gs"))
            let compilation = Compilation(references, tree){.RecordMemberGroups: true}
            let result = compilation.BindPrefix(tree, prefix.Length, PrefixBindOptions(PrefixRemainder.Nothing))
            let actual = result.Compilation.GetSemanticModel(result.SyntaxTree).GetExpectedType(prefix.Length)
            Assert.Equal(expected, actual)
        }

        const header = `package P
import GenericContract6223
import System
import System.Collections.Generic
import System.Linq

func Pair[T](first T, second T) {
}

func Tri[T](a T, b T, c T) {
}

func Map[T, U](items []T, f (T) -> U) {
}

func Filter[T](items []T, f (T) -> bool) {
}

class GenBox[T](first T, second T) {
    func Combine[U](x T, y U, z U) {
    }
}

class GenInit[T] {
    init(a T, b T) {
    }
}

func (items []T) ZipWith[T, U](other []U, f (T, U) -> int32) {
}

func Outer[E](e E, items []int32, words []string, box GenBox[string]) {
`
        // Source generic function: unfixed slot 0, fixed slot 1, explicit type arg, reordered named, conflict.
        AssertPrefix(header + "    Pair(", nil)
        AssertPrefix(header + "    Pair(1, ", TypeSymbol.Int32)
        AssertPrefix(header + "    Pair[string](", TypeSymbol.String)
        AssertPrefix(header + "    Pair(second: ", nil)
        AssertPrefix(header + "    Pair(second: 1, first: ", TypeSymbol.Int32)
        AssertPrefix(header + "    Tri(1, \"s\", ", nil)
        AssertPrefix(header + "    Tri(1, 2, ", TypeSymbol.Int32)

        // Multi-parameter generic function: Map's U is still unfixed, Filter's T is fixed.
        AssertPrefix(header + "    Map(items, ", nil)
        AssertPrefix(
            header + "    Filter(items, ",
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32), TypeSymbol.Bool)
        )

        // Source generic constructors (primary and explicit init).
        AssertPrefix(header + "    GenBox(", nil)
        AssertPrefix(header + "    GenBox(1, ", TypeSymbol.Int32)
        AssertPrefix(header + "    GenBox[string](", TypeSymbol.String)
        AssertPrefix(header + "    GenInit(", nil)
        AssertPrefix(header + "    GenInit(1, ", TypeSymbol.Int32)

        // Generic instance & extension methods.
        AssertPrefix(header + "    box.Combine(", TypeSymbol.String)
        AssertPrefix(header + "    box.Combine(\"a\", ", nil)
        AssertPrefix(header + "    box.Combine(\"a\", 1, ", TypeSymbol.Int32)
        AssertPrefix(
            header + "    items.ZipWith(words, ",
            FunctionTypeSymbol.Get(
                ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String),
                TypeSymbol.Int32
            )
        )

        // Imported generic methods (static, extension, explicit type args, conflicting inference, [Nullable(2)] T).
        AssertPrefix(header + "    Helpers.Pair(", nil)
        AssertPrefix(header + "    Helpers.Pair(1, ", TypeSymbol.Int32)
        AssertPrefix(header + "    Helpers.Pair[string](", TypeSymbol.String)
        AssertPrefix(header + "    Helpers.Tri(1, \"s\", ", nil)
        AssertPrefix(header + "    Helpers.Tri(1, 2, ", TypeSymbol.Int32)
        AssertPrefix(header + "    Helpers.OpenNullable(\"a\", ", NullableTypeSymbol.Get(TypeSymbol.String))
        AssertPrefix(header + "    Enumerable.Append(", nil)
        AssertPrefix(header + "    Enumerable.Append(items, ", TypeSymbol.Int32)
        AssertPrefix(header + "    items.Append(", TypeSymbol.Int32)

        // Complete generic calls: slot 0 stays null even when later arguments infer T.
        const complete = header + `
    Pair(1, 2)
    Helpers.Pair(1, 2)
    let _ = GenBox(1, 2)
    let _ = GenInit(1, 2)
    let list = List[E]()
    list.Add(e)
    Pair(e, e)
}
`
        let completeTree = SyntaxTree.Parse(SourceText.From(complete, "generic-complete.gs"))
        let completeComp = Compilation(references, completeTree){.RecordMemberGroups: true}
        Assert.Empty(completeComp.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
        let completeModel = completeComp.GetSemanticModel(completeTree)
        Assert.Null(completeModel.GetExpectedType(complete.IndexOf("1, 2)\n    Helpers", StringComparison.Ordinal)))
        Assert.Equal(
            TypeSymbol.Int32,
            completeModel.GetExpectedType(complete.IndexOf("2)\n    Helpers", StringComparison.Ordinal))
        )
        Assert.Null(
            completeModel.GetExpectedType(complete.IndexOf("1, 2)\n    let _ = GenBox", StringComparison.Ordinal))
        )
        Assert.Equal(
            TypeSymbol.Int32,
            completeModel.GetExpectedType(complete.IndexOf("2)\n    let _ = GenBox", StringComparison.Ordinal))
        )
        Assert.Null(
            completeModel.GetExpectedType(complete.IndexOf("1, 2)\n    let _ = GenInit", StringComparison.Ordinal))
        )
        Assert.Null(completeModel.GetExpectedType(complete.IndexOf("1, 2)\n    let list", StringComparison.Ordinal)))

        // Enclosing generic type parameter E fixed via List[E] and Pair(e, ...).
        let outerFn = Assert.IsAssignableFrom[FunctionSymbol](
            completeModel.GetDeclaredSymbol(Descendants(completeTree.Root).OfType[FunctionDeclarationSyntax]().Last())
        )
        let eParam = outerFn.TypeParameters[0]
        Assert.Equal(eParam, completeModel.GetExpectedType(complete.IndexOf("e)\n    Pair", StringComparison.Ordinal)))
        Assert.Equal(eParam, completeModel.GetExpectedType(complete.IndexOf("e)\n}", StringComparison.Ordinal)))

        // Bound-direction preservation, repeated generic position conflicts, recursive nested
        // nullability merging, and target-dependent earlier-argument isolation (#6223 review).
        const edgeSource = `package P

open class Base {
}

class Derived : Base {
}

func KeepExactWithUpper[T](xs []T, predicate (T) -> bool, next T) {
}

func FromPair[T](pair (T, T), next T) {
}

func TriTuple[T](a T, b T, c T) {
}

func PredThenVal[T](predicate (T) -> bool, value T) {
}

func BranchThenVal[T](first T, second T) {
}

func F(
    derivedList []Derived,
    baseList []Base,
    basePred (Base) -> bool,
    derivedPred (Derived) -> bool,
    leftPair (string?, string),
    rightPair (string, string?),
    flag bool
) {
    KeepExactWithUpper(derivedList, basePred, Derived())
    KeepExactWithUpper(baseList, derivedPred, Base())
    FromPair((1, 2), 3)
    FromPair((1, "s"), 0)
    TriTuple(leftPair, rightPair, ("a", "b"))
    PredThenVal((x) -> true, 1)
    PredThenVal((x int32) -> x > 0, 1)
    BranchThenVal(if flag { nil } else { "a" }, "b")
}
`
        let edgeTree = SyntaxTree.Parse(SourceText.From(edgeSource, "generic-edges.gs"))
        let edgeComp = Compilation(edgeTree){.RecordMemberGroups: true}
        let edgeModel = edgeComp.GetSemanticModel(edgeTree)
        let derivedSym = Assert.IsAssignableFrom[TypeSymbol](
            edgeModel.GetDeclaredSymbol(Descendants(edgeTree.Root).OfType[StructDeclarationSyntax]().ElementAt(1))
        )
        Assert.Equal(derivedSym, edgeModel.GetExpectedType(edgeSource.IndexOf("Derived())", StringComparison.Ordinal)))
        Assert.Null(edgeModel.GetExpectedType(edgeSource.IndexOf("Base())", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, edgeModel.GetExpectedType(edgeSource.IndexOf("3)", StringComparison.Ordinal)))
        Assert.Null(edgeModel.GetExpectedType(edgeSource.IndexOf("0)", StringComparison.Ordinal)))
        let mergedTuple = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](
                NullableTypeSymbol.Get(TypeSymbol.String),
                NullableTypeSymbol.Get(TypeSymbol.String)
            )
        )
        Assert.Equal(
            mergedTuple,
            edgeModel.GetExpectedType(edgeSource.IndexOf("(\"a\", \"b\")", StringComparison.Ordinal))
        )
        Assert.Null(edgeModel.GetExpectedType(edgeSource.IndexOf("1)\n    PredThenVal", StringComparison.Ordinal)))
        Assert.Equal(
            TypeSymbol.Int32,
            edgeModel.GetExpectedType(edgeSource.IndexOf("1)\n    BranchThenVal", StringComparison.Ordinal))
        )
        Assert.Equal(
            NullableTypeSymbol.Get(TypeSymbol.String),
            edgeModel.GetExpectedType(edgeSource.IndexOf("\"b\")\n}", StringComparison.Ordinal))
        )
    }

    @Fact
    func GetExpectedType_StopsAtTheNearestDeclarationAndAtAnUntypedInitializer() {
        const source = `package P

func F() int64 {
    let result int32 = {
        let text = "s"
        if false {
        }
        1
    }
    let g = func () int64 {
        let o = object {
            func Run() bool {
                return true
            }
        }
        return 2
    }
    return 3
}
`
        let (_, model) = Model(source)
        // The block gives its target type to its last expression only.
        Assert.Null(model.GetExpectedType(source.IndexOf("\"s\"", StringComparison.Ordinal)))
        Assert.Null(model.GetExpectedType(source.IndexOf("false", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int32, model.GetExpectedType(source.IndexOf("1\n    }", StringComparison.Ordinal)))
        // A rich object's method inside a literal owns its `return`.
        Assert.Equal(TypeSymbol.Bool, model.GetExpectedType(source.IndexOf("true", StringComparison.Ordinal)))
        Assert.Equal(TypeSymbol.Int64, model.GetExpectedType(source.IndexOf("2\n", StringComparison.Ordinal)))
    }

    shared {
        private func Model(source string)(SyntaxTree, SemanticModel) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "query.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
            return (tree, compilation.GetSemanticModel(tree))
        }

        private func Descendants(node SyntaxNode) List[SyntaxNode] {
            let nodes = List[SyntaxNode]()
            let pending = Stack[SyntaxNode]()
            pending.Push(node)
            while pending.Count > 0 {
                let current = pending.Pop()
                nodes.Add(current)
                for child in current.GetChildren().Reverse() {
                    pending.Push(child)
                }
            }
            return nodes
        }
    }
}
