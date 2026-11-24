// <copyright file="Issue6199FunctionValueCalleeGapTests.gs" company="GSharp">
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

/// Issues #6197 and #6199: the callee of a call through a function value answers its member or variable
/// when the call binds and its result is used further (#6197), and when the call fails before the binder
/// commits to the callee (#6199): an inaccessible member, or an argument list that does not analyse.
open class Issue6199FunctionValueCalleeGapTests {
    @Theory
    @InlineData("c.G(x).ToString()", "") // #6197: the call binds and is the receiver of a call
    @InlineData("c.G(x).ToString().Length", "")
    @InlineData("c.G(x) + 1", "")
    @InlineData("c.H(x)", "GS0472") // #6199: an inaccessible member
    @InlineData("c.G(v: x, v: x)", "GS0245") // #6199: a named argument twice
    @InlineData("c.G(v: x, v: x).ToString()", "GS0245")
    func MemberCallee_AnswersTheField(statement string, diagnostic string) {
        let (model, tree, compilation) = CreateModel(MemberSource.Replace("@@CALL", statement))
        AssertDiagnostic(compilation, diagnostic)
        let callee = Callee(
            tree,
            if statement.StartsWith("c.H", StringComparison.Ordinal) {
                "H"
            } else {
                "G"
            }
        )
        Assert.Equal(callee.ValueText, Assert.IsType[FieldSymbol](model.GetSymbolInfo(callee).Symbol).Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(callee).Type?.ToString())
    }

    @Theory
    @InlineData("f(v: x, v: x)", "f", "ParameterSymbol", "(int32) -> int32", "GS0245") // a parameter
    @InlineData("l(v: x, v: x)", "l", "LocalVariableSymbol", "(int32) -> int32", "GS0245") // a local
    @InlineData("G(v: x, v: x)", "G", "FieldSymbol", "(int32) -> int32", "GS0245") // an implicit field
    @InlineData(
        "0\n        if n != nil {\n            let j = n(v: x, v: x)\n        }",
        "n",
        "ParameterSymbol",
        "(int32) -> int32",
        "GS0245"
    ) // a narrowed nullable parameter answers its narrowed type
    func DirectCalleeOfACallWhoseArgumentsDoNotAnalyse_AnswersTheVariable(
        statement string,
        name string,
        symbolType string,
        type string,
        diagnostic string
    ) {
        let (model, tree, compilation) = CreateModel(DirectSource.Replace("@@CALL", statement))
        AssertDiagnostic(compilation, diagnostic)
        let callee = Callee(tree, name)
        let symbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(callee).Symbol)
        Assert.Equal(symbolType, symbol.GetType().Name)
        Assert.Equal(name, symbol.Name)
        Assert.Equal(type, model.GetTypeInfo(callee).Type?.ToString())
    }

    @Theory
    @InlineData("G(x)", "GS0472") // an inherited member that the derived class cannot access
    @InlineData("G(v: x, v: x)", "GS0245")
    func InheritedImplicitMemberCallee_AnswersTheField(statement string, diagnostic string) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nopen class B {\n    private var G (int32) -> int32 = (v int32) -> v\n}\n\nclass D : B {\n    func F() {\n        let x = 1\n        let k = @@CALL\n    }\n}\n"
                .Replace("@@CALL", statement)
        )
        AssertDiagnostic(compilation, diagnostic)
        let callee = Callee(tree, "G")
        Assert.Equal("G", Assert.IsType[FieldSymbol](model.GetSymbolInfo(callee).Symbol).Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(callee).Type?.ToString())
    }

    @Theory
    @InlineData("c.P(v: x, v: x)", "P")
    @InlineData("c.G(v: x, v: x)", "G")
    func MemberCalleeOfACallWhoseArgumentsDoNotAnalyse_AnswersAndKeepsTheMemberGroup(statement string, name string) {
        // The member is resolved for the semantic model only: the call keeps the member group and the
        // diagnostics that it has without the resolution.
        let (model, tree, compilation) = CreateModel(MemberSource.Replace("@@CALL", statement))
        AssertDiagnostic(compilation, "GS0245")
        let callee = Callee(tree, name)
        Assert.Equal(name, model.GetSymbolInfo(callee).Symbol?.Name)
        Assert.Equal("(int32) -> int32", model.GetTypeInfo(callee).Type?.ToString())
        let call = tree.Root.DescendantNodes().OfType[CallExpressionSyntax]().Single()
        Assert.Empty(model.GetMemberGroup(call))
        Assert.Empty(model.GetMemberGroup(Assert.IsType[AccessorExpressionSyntax](call.Parent)))
    }

    @Fact
    func FieldDeclarationToken_AnswersAsBeforeWhenACallFails() {
        // A failed call of an implicit field keeps its callee load. The declaration's token answers what it
        // answers when the call binds.
        for statement in[]string{"G(v: x, v: x)", "G(x, 2)", "G(x)"} {
            let (model, tree, _) = CreateModel(DirectSource.Replace("@@CALL", statement))
            let declaration = FirstIdentifier(tree, "G")
            let (boundModel, boundTree, _) = CreateModel(DirectSource.Replace("@@CALL", "G(x)"))
            let boundDeclaration = FirstIdentifier(boundTree, "G")
            Assert.Equal(
                boundModel.GetSymbolInfo(boundDeclaration).Symbol?.Name,
                model.GetSymbolInfo(declaration).Symbol?.Name
            )
        }
    }

    @Fact
    func CallOfAFunctionWhoseArgumentsDoNotAnalyse_KeepsItsDiagnostics() {
        // Only the callee gets an answer: the layout report stays the only diagnostic, also for a member
        // that the caller cannot access.
        let (_, _, compilation) = CreateModel(MemberSource.Replace("@@CALL", "c.H(v: x, v: x)"))
        Assert.Equal([]string{"GS0245"}, compilation.GetDiagnostics().Select((d Diagnostic) -> d.Id).ToArray())
    }

    shared {
        private const MemberSource string = "package P\n\nclass C {\n    var G (int32) -> int32 = (v int32) -> v\n    private var H (int32) -> int32 = (v int32) -> v\n    prop P (int32) -> int32 {\n        get { return (v int32) -> v }\n    }\n}\n\nfunc F(c C) {\n    let x = 1\n    let k = @@CALL\n}\n"

        private const DirectSource string = "package P\n\nclass C {\n    var G (int32) -> int32 = (v int32) -> v\n    func M(f (int32) -> int32, n ((int32) -> int32)?) {\n        let x = 1\n        var l (int32) -> int32 = (v int32) -> v\n        let k = @@CALL\n    }\n}\n"

        private func AssertDiagnostic(compilation Compilation, diagnostic string) {
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .Select((d Diagnostic) -> d.Id)
                .ToArray()
            if diagnostic == "" {
                Assert.Empty(errors)
            } else {
                Assert.Equal(diagnostic, Assert.Single(errors))
            }
        }

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6199.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        // The first identifier token named [`name`](paramref) in source order.
        private func FirstIdentifier(tree SyntaxTree, name string) SyntaxToken {
            var found SyntaxToken? = nil
            let pending = System.Collections.Generic.Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                if node is SyntaxToken token &&
                    token.Kind == SyntaxKind.IdentifierToken &&
                    token.ValueText == name &&
                    (found == nil || token.Span.Start < found.Span.Start) {
                    found = token
                }
                for child in node.GetChildren() {
                    pending.Push(child)
                }
            }
            return found!!
        }

        private func Callee(tree SyntaxTree, name string) SyntaxToken -> tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == name)
            .Identifier
    }
}
