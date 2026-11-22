// <copyright file="Issue6189FunctionValueCalleeTests.gs" company="GSharp">
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

/// Issue #6189: the callee of a call through a function value answers its symbol and type in the
/// semantic model when the call fails to bind, as it does when the call binds. The callee of a
/// member function value called through a receiver (`c.G(x)`) answers too.
open class Issue6189FunctionValueCalleeTests {
    @Theory
    @InlineData("l(x, 2)", "l(x)", "GS0144") // a local
    @InlineData("p(x, 2)", "p(x)", "GS0144") // a parameter
    @InlineData("l()", "l(x)", "GS0144") // too few arguments
    @InlineData("l() + 1", "l(x) + 1", "GS0144") // the failed call is an operand
    @InlineData("() -> l(x, 2)", "() -> l(x)", "GS0144") // inside a function literal
    @InlineData("d(x, 2)", "d(x)", "GS0144") // a CLR delegate
    @InlineData("n?(x, 2)", "n?(x)", "GS0144") // a nullable value called with `?(...)`
    @InlineData("n(x)", "n?(x)", "GS0503") // a nullable value called without `?(...)`
    @InlineData(
        "0\n    if n != nil {\n        let j = n(x, 2)\n    }",
        "0\n    if n != nil {\n        let j = n(x)\n    }",
        "GS0144"
    ) // a narrowed nullable value
    func FailedCallThroughAFunctionValue_CalleeAnswersAsInACallThatBinds(
        failed string,
        bound string,
        diagnostic string
    ) {
        let template = "package P\n\nimport System\n\nfunc F(p (int32) -> int32, n ((int32) -> int32)?, d Func[int32, int32]) {\n    let x = 1\n    var l (int32) -> int32 = (v int32) -> v\n    let k = @@CALL\n}\n"
        AssertCalleeAnswersAsInACallThatBinds(template, failed, bound, diagnostic)
    }

    @Theory
    @InlineData("G(x, 2)", "G(x)", "G", "FieldSymbol", "(int32) -> int32", "GS0144") // an implicit field
    @InlineData("P(x, 2)", "P(x)", "P", "PropertySymbol", "(int32) -> int32", "GS0144") // an implicit property
    @InlineData("D(x, 2)", "D(x)", "D", "FieldSymbol", "System.Func[int32, int32]", "GS0144") // a CLR delegate field
    @InlineData("c.G(x, 2)", "c.G(x)", "G", "FieldSymbol", "(int32) -> int32", "GS0144") // a field through a receiver
    @InlineData(
        "c.P(x, 2)",
        "c.P(x)",
        "P",
        "PropertySymbol",
        "(int32) -> int32",
        "GS0144"
    ) // a property through a receiver
    @InlineData(
        "c.G?(x, 2)",
        "c.G?(x)",
        "G",
        "FieldSymbol",
        "(int32) -> int32",
        "GS0144"
    ) // `?(...)` through a receiver
    @InlineData("c.N?(x, 2)", "c.N?(x)", "N", "FieldSymbol", "((int32) -> int32)?", "GS0144") // a nullable field
    @InlineData(
        "c.D(x, 2)",
        "c.D(x)",
        "D",
        "FieldSymbol",
        "System.Func[int32, int32]",
        "GS0131"
    ) // a CLR delegate field
    @InlineData("c.Inner.G(x, 2)", "c.Inner.G(x)", "G", "FieldSymbol", "(int32) -> int32", "GS0144") // a longer chain
    @InlineData("G(x, a: 2)", "G(x)", "G", "FieldSymbol", "(int32) -> int32", "GS0144") // a named argument
    func FailedCallThroughAMemberFunctionValue_CalleeAnswersTheMember(
        failed string,
        bound string,
        member string,
        symbolKind string,
        type string,
        diagnostic string
    ) {
        AssertCalleeAnswersAsInACallThatBinds(MemberTemplate, failed, bound, diagnostic)
        for source in[]string{failed, bound} {
            let (model, tree, _) = CreateModel(MemberTemplate.Replace("@@CALL", source))
            let callee = LastCall(tree).Identifier
            let symbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(callee).Symbol)
            Assert.Equal(symbolKind, symbol.GetType().Name)
            Assert.Equal(member, symbol.Name)
            Assert.Equal(type, model.GetTypeInfo(callee).Type?.ToString())
        }
    }

    @Theory
    @InlineData("c.G(x, 2).ToString()") // the failed call is the receiver of a call
    @InlineData("c.G(x, 2) + 1") // the failed call is an operand
    @InlineData("c.Inner.G(x, 2).ToString()")
    func FailedMemberCallThatIsNotTheEndOfItsExpression_CalleeAnswersTheMember(statement string) {
        let (model, tree, compilation) = CreateModel(MemberTemplate.Replace("@@CALL", statement))
        Assert.Equal("GS0144", Assert.Single(compilation.GetDiagnostics()).Id)
        let callee = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == "G")
            .Identifier
        Assert.Equal("G", Assert.IsType[FieldSymbol](model.GetSymbolInfo(callee).Symbol).Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(callee).Type?.ToString())
    }

    @Theory
    @InlineData("c.G.Invoke(x)", "Invoke", "", "") // `Invoke` of a function value
    @InlineData("c.D.Invoke(x)", "Invoke", "Invoke", "") // `Invoke` of a CLR delegate
    @InlineData("c.G(x).ToString()", "ToString", "ToString", "") // a call on the result
    @InlineData("c.Inner.M2(x)", "M2", "M2", "") // a method at the end of a chain
    func OtherIdentifiersOfACallThroughAMember_AnswerWhatTheyName(
        statement string,
        name string,
        symbolName string,
        type string
    ) {
        // Only the identifier that names the member answers the member's load.
        let (model, tree, compilation) = CreateModel(
            MemberTemplate.Replace("@@CALL", statement).Replace(
                "    func M(c C) {",
                "    func M2(v int32) int32 -> v\n    func M(c C) {"
            )
        )
        Assert.Empty(compilation.GetDiagnostics())
        let token = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == name)
            .Identifier
        Assert.Equal(symbolName, model.GetSymbolInfo(token).Symbol?.Name ?? "")
        Assert.Equal(type, model.GetTypeInfo(token).Type?.ToString() ?? "")
    }

    @Fact
    func FailedCallThroughAWriteOnlyProperty_ReportsTheReadOnce() {
        // The callee's load reports that the property cannot be read; the load the semantic model
        // keeps is built again, and its report is dropped.
        let (model, tree, compilation) = CreateModel(MemberTemplate.Replace("@@CALL", "W(x, 2)"))
        Assert.Equal(
            []string{
                "GS0127 Error 393..394 Variable 'W' is read-only and cannot be assigned to.",
                "GS0144 Error 393..394 Function 'W' requires 1 arguments but was given 2."
            },
            compilation.GetDiagnostics().Select(Describe).ToArray()
        )
        Assert.Null(model.GetSymbolInfo(LastCall(tree).Identifier).Symbol)
    }

    @Fact
    func MemberFunctionValueThroughAReceiver_CallThatBinds_CalleeAnswersTheMember() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    var G (int32) -> int32 = (v int32) -> v\n}\n\nfunc F(c C) {\n    let x = 1\n    let k = c.G(x)\n}\n"
        )
        Assert.Empty(compilation.GetDiagnostics())
        let call = LastCall(tree)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(call.Identifier).Symbol)
        Assert.Equal("G", field.Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(call.Identifier).Type?.ToString())
        // The call and the accessor keep their answers: the member, and the call's type.
        Assert.Same(field, model.GetSymbolInfo(call).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(call).Type)
        let accessor = Assert.IsType[AccessorExpressionSyntax](call.Parent)
        Assert.Same(field, model.GetSymbolInfo(accessor).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(accessor).Type)
        let receiver = Assert.Single(Names(tree, "c"))
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol).Name)
    }

    @Fact
    func FailedCallThroughAGenericFunctionValue_CalleeAnswersAsInACallThatBinds() {
        AssertCalleeAnswersAsInACallThatBinds(
            "package P\n\nfunc Gen[T](g (T) -> T, t T) {\n    let x = t\n    let k = @@CALL\n}\n",
            "g(x, 2)",
            "g(x)",
            "GS0144"
        )
    }

    @Fact
    func FailedCallThroughANamedDelegate_CalleeAnswersAsInACallThatBinds() {
        AssertCalleeAnswersAsInACallThatBinds(
            "package P\n\ndelegate H(v int32) int32;\n\nfunc F(h H) {\n    let x = 1\n    let k = @@CALL\n}\n",
            "h(x, 2)",
            "h(x)",
            "GS0144"
        )
    }

    @Fact
    func FailedRaiseOfAFieldLikeEvent_CalleeAnswersAsInARaiseThatBinds() {
        // The event's token answers no backing field, whether the raise binds or not; its type is
        // the delegate type.
        AssertCalleeAnswersAsInACallThatBinds(
            "package P\n\nimport System\n\nclass C {\n    event E Action[int32]\n    func M() {\n        let x = 1\n        @@CALL\n    }\n}\n",
            "E(x, 2)",
            "E(x)",
            "GS0144"
        )
    }

    @Fact
    func FailedCallThroughAFunctionValue_WithMemberGroups_CalleeAnswers() {
        let source = "package P\n\nfunc F(p (int32) -> int32) {\n    let x = 1\n    let k = p(p(x, 2), 2)\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6189.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        let model = compilation.GetSemanticModel(tree)
        let calls = tree.Root.DescendantNodes().OfType[CallExpressionSyntax]().ToArray()
        Assert.Equal(2, calls.Length)
        for call in calls {
            Assert.Equal("p", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(call.Identifier).Symbol).Name)
            Assert.Equal("(int32) -> int32", model.GetTypeInfo(call.Identifier).Type?.ToString())
        }
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
    }

    @Fact
    func Diagnostics_AreUnchanged() {
        let source = "package P\n\nfunc F(p (int32) -> int32, n ((int32) -> int32)?) {\n    let x = 1\n    let a = p(x, 2)\n    let b = n(x)\n    let c = p() + 1\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6189.gs"))
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics().Select(Describe).ToArray()
        let model = compilation.GetSemanticModel(tree)
        for call in tree.Root.DescendantNodes().OfType[CallExpressionSyntax]() {
            Assert.NotNull(model.GetSymbolInfo(call.Identifier).Symbol)
        }
        let after = compilation.GetDiagnostics().Select(Describe).ToArray()
        Assert.Equal(before, after)
        // The binder reports what it reported before the callee was kept.
        Assert.Equal(
            []string{
                "GS0144 Error 89..90 Function 'p' requires 1 arguments but was given 2.",
                "GS0503 Error 109..110 Nullable delegate receiver 'n' may be nil. Use '?(...)' for null-safe invocation, bind it with 'if let', or assert non-null with '!!' before calling.",
                "GS0144 Error 126..127 Function 'p' requires 1 arguments but was given 0."
            },
            before
        )
    }

    shared {
        private const MemberTemplate string = "package P\n\nimport System\n\nclass C {\n    var G (int32) -> int32 = (v int32) -> v\n    var N ((int32) -> int32)? = nil\n    var D Func[int32, int32] = (v int32) -> v\n    prop P (int32) -> int32 {\n        get { return (v int32) -> v }\n    }\n    prop Inner C {\n        get { return this }\n    }\n    prop W (int32) -> int32 {\n        set { }\n    }\n    func M(c C) {\n        let x = 1\n        let k = @@CALL\n    }\n}\n"

        private func AssertCalleeAnswersAsInACallThatBinds(
            template string,
            failed string,
            bound string,
            diagnostic string
        ) {
            let (model, tree, compilation) = CreateModel(template.Replace("@@CALL", failed))
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToArray()
            let error = Assert.Single(errors)
            Assert.Equal(diagnostic, error.Id)
            let (boundModel, boundTree, boundCompilation) = CreateModel(template.Replace("@@CALL", bound))
            Assert.DoesNotContain(
                boundCompilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let callee = LastCall(tree).Identifier
            let boundCallee = LastCall(boundTree).Identifier
            let expected = boundModel.GetTypeInfo(boundCallee).Type
            Assert.NotNull(expected)
            Assert.Equal(expected?.ToString(), model.GetTypeInfo(callee).Type?.ToString())
            let expectedSymbol = boundModel.GetSymbolInfo(boundCallee).Symbol
            let symbol = model.GetSymbolInfo(callee).Symbol
            Assert.Equal(expectedSymbol?.GetType(), symbol?.GetType())
            Assert.Equal(expectedSymbol?.Name, symbol?.Name)
            for argument in Names(tree, "x") {
                Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol).Name)
            }
        }

        private func Describe(d Diagnostic) string -> d.Id + " " + d.Severity.ToString() +
            " " +
            d
            .Location
            .Span
            .ToString() +
            " " +
            d.ToString()

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6189.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func LastCall(tree SyntaxTree) CallExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Last()

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
