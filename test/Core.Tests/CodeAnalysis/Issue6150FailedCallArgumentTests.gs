// <copyright file="Issue6150FailedCallArgumentTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6150: the arguments of a call that fails to bind keep their symbol and type in the
/// semantic model, whatever the error.
open class Issue6150FailedCallArgumentTests {
    @Theory
    @InlineData("let k = Use(x, 2)") // arity
    @InlineData("let k = Use(x, \"s\")") // arity, second argument of another type
    @InlineData("let k = Use(\"s\" + x.ToString(), x)") // no overload
    @InlineData("let k = Pick(x)") // no applicable overload
    @InlineData("let k = Missing(x)") // no such function
    @InlineData("let k = Use(x, 2) + 1") // the failed call is an operand
    @InlineData("let k = Use(Use(x, 2))") // the failed call is an argument of a call that binds
    @InlineData("let k = Use(v: x, w: 2)") // named arguments
    @InlineData("let k = R(ref x, x)") // a `ref` argument
    func LocalArgument_AnswersItsSymbolAndType(statement string) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc Use(v int32) int32 -> v\n\nfunc Pick(s string) int32 -> 0\nfunc Pick(b bool) int32 -> 1\n\nfunc R(ref v int32) int32 -> v\n\nfunc F() {\n    var x = 1\n    " +
                statement +
                "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        for argument in Names(tree, "x") {
            let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol)
            Assert.Equal("x", local.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
            Assert.Same(local, model.GetSymbolInfo(argument.IdentifierToken).Symbol)
        }
    }

    @Fact
    func ArgumentWithANullableReceiver_ReceiverAnswersItsSymbolAndType() {
        // The call fails because of its argument (GS0158 on `N`).
        let (model, tree, _) = CreateModel(
            "package P\n\nclass C {\n    var N int32\n}\n\nfunc Use(v int32) int32 -> v\n\nfunc F(c C?) {\n    let k = Use(c.N)\n}\n"
        )
        let receiver = Assert.Single(Names(tree, "c"))
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
    }

    @Fact
    func ConstructorCallThatFails_ArgumentsAnswerTheirSymbolAndType() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    init(v int32) { }\n}\n\nfunc F(s string) {\n    let x = 1\n    let c = C(x, s)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let s = Assert.Single(Names(tree, "s"))
        Assert.Equal("s", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(s).Symbol).Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(s).Type)
    }

    @Fact
    func MethodCallThatFails_ReceiverAndArgumentsAnswer() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    func M(v int32) int32 -> v\n}\n\nfunc F(c C) {\n    let x = 1\n    let k = c.M(x, x)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let receiver = Assert.Single(Names(tree, "c"))
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol).Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
        for argument in Names(tree, "x") {
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
        }
    }

    @Fact
    func TypedFunctionLiteralArgumentOfAFailedCall_BodyAnswers() {
        // A literal with typed parameters is bound without a target type, so it is kept (#6149,
        // #6150). An untyped literal waits for the target type of an overload the call never selects.
        let (model, tree, _) = CreateModel(
            "package P\n\nfunc Apply(g (int32) -> int32) int32 -> g(1)\n\nfunc F() {\n    let x = 1\n    let k = Apply((v int32) -> v + x, 2)\n}\n"
        )
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let v = Assert.Single(Names(tree, "v"))
        Assert.Equal("v", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(v).Symbol).Name)
    }

    @Fact
    func FailedTupleElementCall_ArgumentAndReceiverAnswer() {
        // A call through a tuple element is bound outside the accessor-call path.
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc F() {\n    let x = 1\n    let t = (f: (v int32) -> v + 1, n: 0)\n    let k = t.f(x, 2)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let t = Assert.Single(Names(tree, "t"))
        Assert.Equal("t", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(t).Symbol).Name)
    }

    @Fact
    func FailedColorColorUnifiedCall_ArgumentsAnswer() {
        // `Box.Get(...)` names both a property value and a type with instance and static `Get`;
        // the unified overload selection binds the arguments itself.
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass Tag { }\n\nclass Box {\n    func Get(name string) int32 -> 0\n    shared {\n        func Get(tag Tag?) int32 -> 1\n    }\n}\n\nclass Owner {\n    prop Box Box {\n        get { return Box() }\n    }\n\n    func Use(x int32) int32 {\n        return Box.Get(x, x)\n    }\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        for argument in Names(tree, "x") {
            Assert.Equal("x", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(argument).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
        }
    }

    @Fact
    func ConditionalRefArgumentOfAFailedCall_ConditionAndBranchesAnswer() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc R(ref v int32) int32 -> v\n\nfunc F(flag bool) {\n    var a = 1\n    var b = 2\n    let k = R(ref (flag ? a : b), 2)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        Assert.Equal(
            "flag",
            Assert.IsType[ParameterSymbol](model.GetSymbolInfo(Assert.Single(Names(tree, "flag"))).Symbol).Name
        )
        for name in[]string{"a", "b"} {
            let branch = Assert.Single(Names(tree, name))
            Assert.Equal(name, Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(branch).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(branch).Type)
        }
    }

    @Fact
    func InlineOutDeclarationOfAFailedCall_AnswersAsInACallThatBinds() {
        let source = "package P\n\nfunc Try(s string, out v int32) bool {\n    v = 0\n    return true\n}\n\nfunc F(s string) {\n    let k = Try(s, out var y int32"
        let (model, tree, compilation) = CreateModel(source + ", 2)\n}\n")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let (boundModel, boundTree, _) = CreateModel(source + ")\n}\n")
        let s = Assert.Single(Names(tree, "s"))
        Assert.Equal("s", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(s).Symbol).Name)
        let outArgument = tree.Root.DescendantNodes().OfType[RefArgumentExpressionSyntax]().Single()
        let boundOutArgument = boundTree.Root.DescendantNodes().OfType[RefArgumentExpressionSyntax]().Single()
        let expected = boundModel.GetTypeInfo(boundOutArgument).Type
        Assert.NotNull(expected)
        Assert.Equal(expected?.ToString(), model.GetTypeInfo(outArgument).Type?.ToString())
    }

    @Theory
    @InlineData("values.FindAll((v int32) -> v > x, 2)")
    @InlineData("values.FindAll(checked((v int32) -> v > x), 2)")
    @InlineData("values.FindAll(((v int32) -> v > x), 2)")
    func FunctionLiteralArgumentOfAFailedImportedCall_BodyAnswers(call string) {
        // The literal is bound against the candidates' delegate type, not through the expression
        // dispatch, before the arity check rejects the call.
        let (model, tree, compilation) = CreateModel(
            "package P\n\nimport System.Collections.Generic\n\nfunc F(values List[int32]) {\n    let x = 1\n    let k = " +
                call +
                "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let v = Assert.Single(Names(tree, "v"))
        Assert.Equal("v", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(v).Symbol).Name)
        let values = Assert.Single(Names(tree, "values"))
        Assert.Equal("values", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(values).Symbol).Name)
    }

    @Fact
    func DeeplyNestedFailedCalls_WithMemberGroups_IndexEachFailureOnce() {
        // With member groups recorded, an inner failed call is both an inner failed call and a
        // failed argument of the call around it. Walking both at every level doubles the work per
        // level; 40 levels would not finish.
        var call = "Use(x, 2)"
        for var i = 0; i < 40; i++ {
            call = "Use(" + call + ", 2)"
        }
        let source = "package P\n\nfunc Use(v int32) int32 -> v\n\nfunc F() {\n    let x = 1\n    let k = " +
            call +
            "\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "nested.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        let model = compilation.GetSemanticModel(tree)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
    }

    @Theory
    @InlineData("let k = s.Missing(x)")
    @InlineData("let k = s.Missing(x) + 1") // the failed call is a binary operand
    @InlineData("let k = -s.Missing(x)") // the failed call is a unary operand
    func FailedNativeSliceCall_ArgumentAndReceiverAnswer(statement string) {
        // A call on a native slice saves the receiver in a block around the call.
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc F() {\n    let x = 1\n    let s = slice[int32]{1, 2}\n    " + statement + "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let s = Assert.Single(Names(tree, "s"))
        Assert.Equal("s", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(s).Symbol).Name)
    }

    @Theory
    @InlineData("let k = (f!!)(x, 2)", true) // arity
    @InlineData("let k = (f)(x, 2)", false) // a nullable callee fails before the arguments bind
    func FailedIndirectCall_CalleeAndArgumentsAnswer(statement string, argumentsBound bool) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc F(f ((int32) -> int32)?) {\n    let x = 1\n    " + statement + "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let callee = Assert.Single(Names(tree, "f"))
        Assert.Equal("f", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(callee).Symbol).Name)
        Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(callee).Type)
        if argumentsBound {
            let x = Assert.Single(Names(tree, "x"))
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        }
    }

    @Theory
    @InlineData("let b = Box(x, 2) { N = x }") // object initializer
    @InlineData("let l = List[int32](x, \"s\") { x }") // collection initializer
    func FailedConstructorCallWithAnInitializer_ArgumentsAnswer(statement string) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nimport System.Collections.Generic\n\nclass Box {\n    var N int32\n    init(v int32) { }\n}\n\nfunc F() {\n    let x = 1\n    " +
                statement +
                "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let argument = Names(tree, "x").First()
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
    }

    @Fact
    func FailedConstructorCallWithAnObjectInitializer_MemberValueAnswers() {
        let (model, tree, _) = CreateModel(
            "package P\n\nclass Box {\n    var N int32\n    init(v int32) { }\n}\n\nfunc F(k int32) {\n    let b = Box(1, 2) { N = k }\n}\n"
        )
        let k = Assert.Single(Names(tree, "k"))
        Assert.Equal("k", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(k).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(k).Type)
    }

    @Fact
    func FailedCollectionInitializerAdd_ElementAnswers() {
        // The initializer binds a synthesized `Add(x)` whose argument's syntax parent is the
        // initializer, not a call.
        let (model, tree, compilation) = CreateModel(
            "package P\n\nimport System.Collections.Generic\n\nfunc F(x string) {\n    let items = List[int32]() { x }\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(x).Type)
    }

    @Fact
    func Diagnostics_AreUnchangedByTheIndex() {
        let source = "package P\n\nfunc Use(v int32) int32 -> v\n\nfunc F() {\n    let x = 1\n    let k = Use(x, 2)\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6150.gs"))
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        let model = compilation.GetSemanticModel(tree)
        Assert.NotNull(model.GetSymbolInfo(Assert.Single(Names(tree, "x"))).Symbol)
        let after = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        Assert.Equal(before, after)
        Assert.Single(before.Where((d string) -> d.Contains("requires 1 arguments but was given 2")))
    }

    shared {
        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6150.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
