// <copyright file="Adr0212SpeculativeTypeInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Threading
import Xunit

/// ADR-0212 slice S5: (cref:SemanticModel.GetSpeculativeTypeInfo) replaces `Binder.TryInferExpressionType`.
///
/// Contract (one test per row):
///
/// | Input | Answer | Test |
/// | --- | --- | --- |
/// | local or parameter of the enclosing function, declared before `position` | its declared type | `EnclosingLocal_IsInScope` |
/// | local function of the enclosing block (non-generic or generic, inferred or explicit type arguments) | its return type; shadows globals and members; inner block shadows outer; sibling block out of scope | `NonGenericLocalFunction_IsInScope`, `GenericLocalFunction_IsInScope_InferredAndExplicitTypeArguments`, `LocalFunction_ShadowsGlobalFunctionAndInstanceMethod`, `NestedAndOutOfScopeLocalFunctions_RespectBlockScopes` |
/// | local declared after `position` | not in scope: no type | `LocalDeclaredAfterPosition_IsNotInScope` |
/// | receiver inside a method | `this` and the members resolve | `MethodBody_SeesThisAndMembers` |
/// | no enclosing declared function | the globals resolve | `TopLevel_SeesGlobals` |
/// | arguments of a constructor's `: base(...)` | no instance access, as in normal binding | `ConstructorBaseArguments_RejectInstanceAccess_BodyAcceptsIt` (static members stay reachable) |
/// | expression parsed on its own | the model's tree supplies the imports | `DetachedExpression_UsesTheModelsImports` |
/// | narrowing in force at `position` (Q15) | excluded: the declared type | `FlowNarrowing_IsExcluded_FromTheContract` |
/// | bind fails, `void` or error type | `TypeInfo.None` | `FailedBind_AnswersNone`, `VoidCall_AnswersNone` |
/// | diagnostics | none escape | `NoDiagnosticEscapes` |
/// | imported CLR member | the binder's type with its nullability kind (`T?`, `T!`, `T` stay distinct, ADR-0186) | `ImportedMember_KeepsTheBindersNullability` |
/// | repeated query | equal answers | `RepeatedQuery_IsDeterministic` |
/// | cancelled token | `OperationCanceledException` | `CancelledToken_Throws` |
/// | every simple name the binder bound, in the corpus | the binder's type, unless the binder narrowed it | the two `AgreesWithTheBinder` tests |
open class Adr0212SpeculativeTypeInfoTests {
    @Fact
    func EnclosingLocal_IsInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func Parameter_IsInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "n + 1", "InParam")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func LocalDeclaredAfterPosition_IsNotInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "later", "BeforeLater")
        Assert.Null(model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func NonGenericLocalFunction_IsInScope() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Local(3)", "InLocalFunc")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func GenericLocalFunction_IsInScope_InferredAndExplicitTypeArguments() {
        let (model, tree) = Create(Program)
        let inferredInt = Expression(tree, "Twice(3)", "InLocalFunc")
        let inferredString = Expression(tree, "Twice(\"abc\")", "InLocalFunc")
        let explicitLong = Expression(tree, "Twice[int64](3)", "InLocalFunc")
        let overloadedTwo = Expression(tree, "Pick(3, 0)", "InLocalFunc")
        let overloadedOne = Expression(tree, "Pick(3)", "InLocalFunc")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(inferredInt.Span.Start, inferredInt).Type)
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(inferredString.Span.Start, inferredString).Type)
        Assert.Same(TypeSymbol.Int64, model.GetSpeculativeTypeInfo(explicitLong.Span.Start, explicitLong).Type)
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(overloadedTwo.Span.Start, overloadedTwo).Type)
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(overloadedOne.Span.Start, overloadedOne).Type)
    }

    @Fact
    func LocalFunction_ShadowsGlobalFunctionAndInstanceMethod() {
        let (model, tree) = Create(Program)
        let beforeGroupGlobal = Expression(tree, "ShadowedGlobal(3)", "BeforeLocalFunc")
        let shadowsGlobal = Expression(tree, "ShadowedGlobal(3)", "InLocalFunc")
        let twiceCall = Expression(tree, "Twice(3)", "InLocalFunc")
        let forwardCall = Expression(tree, "ForwardSecond[T](x)", "InForwardGroup")
        let unshadowedGlobal = Expression(tree, "ShadowedGlobal(\"hi\")", "TopLevel")
        let shadowsMethod = Expression(tree, "ShadowedMethod(3)", "InMethod")
        Assert.Same(
            TypeSymbol.String,
            model.GetSpeculativeTypeInfo(beforeGroupGlobal.Span.Start, beforeGroupGlobal).Type
        )
        Assert.Null(model.GetSpeculativeTypeInfo(beforeGroupGlobal.Span.Start, twiceCall).Type)
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(forwardCall.Span.Start, forwardCall).Type)
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(shadowsGlobal.Span.Start, shadowsGlobal).Type)
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(unshadowedGlobal.Span.Start, unshadowedGlobal).Type)
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(shadowsMethod.Span.Start, shadowsMethod).Type)
    }

    @Fact
    func NestedAndOutOfScopeLocalFunctions_RespectBlockScopes() {
        let (model, tree) = Create(Program)
        let innerCall = Expression(tree, "Scoped(3)", "InInnerBlock")
        let innerTwoArgCall = Expression(tree, "Scoped(3, 1)", "InInnerBlock")
        let innerDefaultedOuterCall = Expression(tree, "DefaultedOuter(3)", "InInnerBlock")
        let innerConstrainedOuterCall = Expression(tree, "ConstrainedOuter(3)", "InInnerBlock")
        let innerReclaimedCall = Expression(tree, "Reclaimed(3)", "InReclaimedBlock")
        let siblingCall = Expression(tree, "SiblingOnly(3)", "InSiblingBlock")
        let outerCall = Expression(tree, "Scoped(3)", "AfterBlocks")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(innerCall.Span.Start, innerCall).Type)
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(innerTwoArgCall.Span.Start, innerTwoArgCall).Type)
        Assert.Same(
            TypeSymbol.String,
            model.GetSpeculativeTypeInfo(innerDefaultedOuterCall.Span.Start, innerDefaultedOuterCall).Type
        )
        Assert.Same(
            TypeSymbol.String,
            model.GetSpeculativeTypeInfo(innerConstrainedOuterCall.Span.Start, innerConstrainedOuterCall).Type
        )
        Assert.Same(
            TypeSymbol.String,
            model.GetSpeculativeTypeInfo(innerReclaimedCall.Span.Start, innerReclaimedCall).Type
        )
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(siblingCall.Span.Start, siblingCall).Type)
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(outerCall.Span.Start, outerCall).Type)
        Assert.Null(model.GetSpeculativeTypeInfo(outerCall.Span.Start, siblingCall).Type)
    }

    @Fact
    func MethodBody_SeesThisAndMembers() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Count + 1", "InMethod")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    @Fact
    func TopLevel_SeesGlobals() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Global + 1", "TopLevel")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type)
    }

    // ADR-0212 Q15: flow-sensitive state is not part of the contract. The speculative binder starts
    // with empty narrowing state, so `p` inside `if p != nil` is the declared `Point?`. A later change
    // that seeds the narrowing is a visible change to this test.
    @Fact
    func FlowNarrowing_IsExcluded_FromTheContract() {
        let (model, tree) = Create(Program)
        let name = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Single(
            (n NameExpressionSyntax) -> n.IdentifierToken.Text == "p" && n.Span.Start > Program.IndexOf(
                "// Narrowed",
                StringComparison.Ordinal
            ) &&
                Program.Substring(n.Span.Start - 8, 8) == "        "
        )
        let speculative = model.GetSpeculativeTypeInfo(name.Span.Start, name).Type
        let nullable = Assert.IsType[NullableTypeSymbol](speculative)
        Assert.Equal("Point", nullable.UnderlyingType.Name)
        // The bound tree has the narrowed type here: the exclusion is what separates the two queries.
        Assert.IsNotType[NullableTypeSymbol](model.GetReceiverTypeInfo(name).Type)
    }

    @Fact
    func LocalShadowingAField_IsTheLocal() {
        const source = `class Index {
    private let declarations string
    func Canonical(member string) int32 {
        let declarations = member.Length
        return if declarations > 0 { declarations } else { 0 }
    }
}
`
        let (model, tree) = Create(source)
        let uses = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "declarations")
            .ToArray()
        Assert.NotEmpty(uses)
        for use in uses {
            Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(use.Span.Start, use).Type)
        }
    }

    @Fact
    func PatternVariable_FollowsBinderFlowRegions() {
        const source = `func Flow(x object, items []object) int32 {
    if x is string s {
        let inThen = s.Length
    } else {
        let inElse = 0
    }
    let afterIf = 0
    if !(x is string bang) {
        return 1
    }
    let afterBang = bang.Length
    for item in items {
        if item is not string token {
            continue
        }
        let afterNot = token.Length
    }
    let afterLoop = 0
    let andOk = x is string a && a.Length > 0
    let orOut = x is string b || x == nil
    let notOrOk = x is not string c || c.Length == 0
    let condPos = x is string d ? d.Length : 10
    let condNeg = x is not string e ? 20 : e.Length
    while x is string w {
        let inWhile = w.Length
        break
    }
    while !(x is string wNeg) {
        let inWhileNeg = 0
        break
    }
    let afterWhile = 0
    return afterBang + condPos + condNeg + afterIf + afterLoop + afterWhile
}
`
        let (model, tree) = Create(source)
        let Speculate = func (anchorSnippet string, exprText string) TypeSymbol? {
            let pos = source.IndexOf(anchorSnippet, StringComparison.Ordinal)
            Assert.True(pos >= 0, anchorSnippet)
            let parsed = SyntaxTree.Parse(SourceText.From("func f() {\n    " + exprText + "\n}\n", "probe.gs"))
            let expr = parsed.Root.DescendantNodes().OfType[ExpressionStatementSyntax]().Single().Expression
            return model.GetSpeculativeTypeInfo(pos, expr).Type
        }
        Assert.Same(TypeSymbol.Int32, Speculate("let inThen", "s.Length"))
        Assert.Null(Speculate("let inElse", "s.Length"))
        Assert.Null(Speculate("let afterIf", "s.Length"))
        Assert.Null(Speculate("return 1", "bang.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("let afterBang", "bang.Length"))
        Assert.Null(Speculate("continue", "token.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("let afterNot", "token.Length"))
        Assert.Null(Speculate("let afterLoop", "token.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("a.Length > 0", "a.Length"))
        Assert.Null(Speculate("x == nil", "b.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("c.Length == 0", "c.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("d.Length", "d.Length"))
        Assert.Null(Speculate("10", "d.Length"))
        Assert.Null(Speculate("20", "e.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("e.Length", "e.Length"))
        Assert.Same(TypeSymbol.Int32, Speculate("let inWhile =", "w.Length"))
        Assert.Null(Speculate("let inWhileNeg", "wNeg.Length"))
        Assert.Null(Speculate("let afterWhile", "w.Length"))
    }

    // The scope query leaves `this` out of the arguments of `: base(...)`; the speculative bind must not
    // accept instance access there, while the constructor body keeps it.
    @Fact
    func ConstructorBaseArguments_RejectInstanceAccess_BodyAcceptsIt() {
        let (model, tree) = Create(Program)
        let inArguments = Expression(tree, "Field2", "BaseArg")
        Assert.Null(model.GetSpeculativeTypeInfo(inArguments.Span.Start, inArguments).Type)
        // The static members of the type stay reachable there.
        let inConst = Expression(tree, "Poly", "BaseConst")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(inConst.Span.Start, inConst).Type)
        let inBody = Expression(tree, "Field2 + 1", "CtorBody")
        Assert.Same(TypeSymbol.Int32, model.GetSpeculativeTypeInfo(inBody.Span.Start, inBody).Type)
    }

    // An expression parsed on its own has no imports; the model's tree supplies them.
    @Fact
    func DetachedExpression_UsesTheModelsImports() {
        let (model, tree) = Create(Program)
        let detachedTree = SyntaxTree.Parse(SourceText.From("func f() {\n    Path.GetTempPath()\n}\n", "detached.gs"))
        let detached = detachedTree.Root.DescendantNodes().OfType[ExpressionStatementSyntax]().Single().Expression
        let anchor = Expression(tree, "s.Length", "InLocal")
        Assert.Same(TypeSymbol.String, model.GetSpeculativeTypeInfo(anchor.Span.Start, detached).Type)
    }

    @Fact
    func FailedBind_AnswersNone() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Missing(1)", "Failed")
        Assert.Equal(TypeInfo.None, model.GetSpeculativeTypeInfo(expression.Span.Start, expression))
    }

    @Fact
    func VoidCall_AnswersNone() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "Nothing()", "Void")
        Assert.Equal(TypeInfo.None, model.GetSpeculativeTypeInfo(expression.Span.Start, expression))
    }

    @Fact
    func NoDiagnosticEscapes() {
        let tree = SyntaxTree.Parse(SourceText.From(Program, "speculative.gs"))
        let compilation = Compilation(tree)
        let model = compilation.GetSemanticModel(tree)
        let before = compilation.GetDiagnostics().Length
        for marker in[]string{"Failed", "Void", "BeforeLater", "InLocal"} {
            let expression = tree
                .Root
                .DescendantNodes()
                .OfType[ExpressionStatementSyntax]()
                .First(
                (s ExpressionStatementSyntax) -> Program.Substring(0, s.Span.Start).EndsWith(
                    "// " + marker + "\n    ",
                    StringComparison.Ordinal
                )
            )
                .Expression
            let _ = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        }
        Assert.Equal(before, compilation.GetDiagnostics().Length)
    }

    @Fact
    func ImportedMember_KeepsTheBindersNullability() {
        let (model, tree) = Create(Program)
        for text in[]string{"Console.ReadLine()", "Path.GetTempPath()"} {
            let expression = Expression(tree, text, "Platform")
            let bound = model.GetTypeInfo(expression).Type!!
            let speculative = model.GetSpeculativeTypeInfo(expression.Span.Start, expression).Type!!
            Assert.Equal(bound.GetType(), speculative.GetType())
            Assert.Equal(bound.ToString(), speculative.ToString())
        }
    }

    @Fact
    func RepeatedQuery_IsDeterministic() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        let first = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        let second = model.GetSpeculativeTypeInfo(expression.Span.Start, expression)
        Assert.Equal(first, second)
    }

    @Fact
    func CancelledToken_Throws() {
        let (model, tree) = Create(Program)
        let expression = Expression(tree, "s.Length", "InLocal")
        using let source = CancellationTokenSource()
        source.Cancel()
        Assert.Throws[OperationCanceledException](
            () -> model.GetSpeculativeTypeInfo(expression.Span.Start, expression, source.Token)
        )
    }

    // ---- Differential: the model must agree with the binder ----

    @Fact
    func GetSpeculativeTypeInfo_AgreesWithTheBinder_OnTheSamples() {
        let mismatches = List[string]()
        var compared = 0
        for file in Directory.GetFiles(Path.Combine(RepositoryRoot(), "samples"), "*.gs").OrderBy(
            (f string) -> f,
            StringComparer.Ordinal
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            compared += CompareCompilation(Compilation(tree), mismatches)
        }
        Assert.True(compared > 1000, "compared ${compared} expressions")
        AssertNoMismatches(mismatches)
    }

    @Fact
    func GetSpeculativeTypeInfo_AgreesWithTheBinder_OnTheLanguageServerSources() {
        let directory = Path.Combine(RepositoryRoot(), "src", "LanguageServer")
        let trees = Directory
            .GetFiles(directory, "*.gs")
            .OrderBy((f string) -> f, StringComparer.Ordinal)
            .Select((f string) -> SyntaxTree.Parse(SourceText.From(File.ReadAllText(f), f)))
            .ToArray()
        let mismatches = List[string]()
        let compared = CompareCompilation(Compilation(trees), mismatches)
        Assert.True(compared > 1000, "compared ${compared} expressions")
        AssertNoMismatches(mismatches)
    }

    shared {
        private const Program string = `import System
import System.IO
class Point { var X int32 }
var Global = 1
func Nothing() { }
func ShadowedGlobal(x object) string { return "global" }
func ShadowedGlobal(x object, y object) string { return "global2" }
func Probe(p Point?, n int32) {
    let s = "abc"
    // InLocal
    s.Length
    // InParam
    n + 1
    // BeforeLater
    later
    let later = 2
    // BeforeLocalFunc
    ShadowedGlobal(3)
    let Local = func(x int32) int32 { return LocalStep(x) }
    let LocalStep = func(x int32) int32 { return x + 1 }
    let Twice[T] = func(x T) T { return x }
    let Pick[T] = func(x T, n int32) string { return "two" }
    let Pick[T] = func(x T) T { return x }
    let ForwardFirst[T] = func(x T) int32 {
        // InForwardGroup
        return ForwardSecond[T](x)
    }
    let ForwardSecond[U] = func(x U) int32 { return 7 }
    let ShadowedGlobal[T] = func(x T) T { return x }
    // InLocalFunc
    Local(3)
    Twice(3)
    Twice("abc")
    Twice[int64](3)
    Pick(3, 0)
    Pick(3)
    ForwardFirst(3)
    ShadowedGlobal(3)
    let Scoped[T] = func(x T, extra int32 = 0) string { return "outer" }
    let DefaultedOuter[T] = func(x T, extra int32 = 0) string { return "outer-default" }
    let ConstrainedOuter[T] = func(x T) string { return "outer-unconstrained" }
    let Reclaimed[T] = func(x T, extra int32 = 0) string { return "outer-reclaimed" }
    if true {
        let Scoped[T] = func(x T) T { return x }
        let DefaultedOuter[U] = func(x U, extra int32) int32 { return extra }
        let ConstrainedOuter[U IDisposable] = func(x U) int32 { return 1 }
        // InInnerBlock
        Scoped(3)
        Scoped(3, 1)
        DefaultedOuter(3)
        ConstrainedOuter(3)
    }
    if true {
        let Reclaimed = 0
        if Reclaimed == 0 {
            let Reclaimed[U] = func(x U, extra int32) int32 { return extra }
            // InReclaimedBlock
            Reclaimed(3)
        }
    }
    if true {
        let SiblingOnly[T] = func(x T) T { return x }
        // InSiblingBlock
        SiblingOnly(3)
    }
    // AfterBlocks
    Scoped(3)
    // Failed
    Missing(1)
    // Void
    Nothing()
    // Platform
    Console.ReadLine()
    Path.GetTempPath()
    // Narrowed
    if p != nil {
        p
    }
}
class Holder {
    var Count int32
    func ShadowedMethod[T](x T) string { return "member" }
    func M() {
        let ShadowedMethod[T] = func(x T) T { return x }
        // InMethod
        Count + 1
        ShadowedMethod(3)
    }
}
open class Base2 {
    var Field2 int32
    init(v int32) { }
}
class Derived2 : Base2 {
    init(n int32) : base(
        // BaseArg
        Field2
    ) {
        // CtorBody
        Field2 + 1
    }
}
class Derived3 : Base2 {
    init() : base(
        // BaseConst
        Poly
    ) { }
    shared { const Poly int32 = 5 }
}
// TopLevel
Global + 1
ShadowedGlobal("hi")
`

        private func Create(source string)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "speculative.gs"))
            return (Compilation(tree).GetSemanticModel(tree), tree)
        }

        /// The expression statement that follows the `// marker` comment.
        private func Expression(tree SyntaxTree, text string, marker string) ExpressionSyntax {
            let start = Program.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(start >= 0, marker)
            return tree
                .Root
                .DescendantNodes()
                .OfType[ExpressionSyntax]()
                .Where(
                (e ExpressionSyntax) -> e.Span.Start > start && Program.Substring(e.Span.Start, e.Span.Length) == text
            )
                .OrderBy((e ExpressionSyntax) -> e.Span.Start)
                .ThenByDescending((e ExpressionSyntax) -> e.Span.Length)
                .First()
        }

        private func RepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return directory!!.FullName
        }

        /// Compares every simple-name read of [`compilation`](paramref) that names a variable, field or
        /// property: the speculative type must be the symbol's declared type, which is the contract
        /// (flow narrowing is excluded, Q15). Member segments of a chain are not expressions on their own.
        /// Returns the number compared.
        private func CompareCompilation(compilation Compilation, mismatches List[string]) int32 {
            var compared = 0
            for tree in compilation.SyntaxTrees {
                let model = compilation.GetSemanticModel(tree)
                let file = Path.GetFileName(tree.Text?.FileName ?? string.Empty)
                for name in tree.Root.DescendantNodes().OfType[NameExpressionSyntax]() {
                    if name.IdentifierToken.IsMissing || IsMemberSegment(name) {
                        continue
                    }
                    if model.GetReceiverTypeInfo(name).Type == nil {
                        continue
                    }
                    let referenced = model.GetSymbolInfo(name.IdentifierToken).Symbol
                    let declared TypeSymbol? = switch referenced {
                        case v is VariableSymbol: v.Type
                        case f is FieldSymbol: f.Type
                        case p is PropertySymbol: p.Type
                        default: default(TypeSymbol?)
                    }
                    if declared == nil || object.ReferenceEquals(declared, TypeSymbol.Error) {
                        continue
                    }
                    compared += 1
                    let speculative = model.GetSpeculativeTypeInfo(name.Span.Start, name).Type
                    let expected = declared.ToString()
                    let actual = speculative?.ToString() ?? "<none>"
                    if expected != actual {
                        let category = if speculative == nil {
                            "no answer"
                        } else {
                            "different type"
                        }
                        mismatches.Add(
                            "${category} @ ${file}:${name.Span.Start} ${name.IdentifierToken.Text} in ${name.Parent?.GetType()?.Name}: declared ${expected}, speculative ${actual}"
                        )
                    }
                }
                for call in tree.Root.DescendantNodes().OfType[CallExpressionSyntax]() {
                    if call.Identifier.IsMissing || model.GetSymbolInfo(call.Identifier)
                        .Symbol is not FunctionSymbol{LocalDeclaration: not nil} {
                        continue
                    }
                    let boundType = model.GetTypeInfo(call).Type
                    if boundType == nil || object.ReferenceEquals(boundType, TypeSymbol.Error) ||
                        object.ReferenceEquals(boundType, TypeSymbol.Void) {
                        continue
                    }
                    compared += 1
                    let speculative = model.GetSpeculativeTypeInfo(call.Span.Start, call).Type
                    let expected = boundType.ToString()
                    let actual = speculative?.ToString() ?? "<none>"
                    if expected != actual {
                        let category = if speculative == nil {
                            "no answer"
                        } else {
                            "different type"
                        }
                        mismatches.Add(
                            "${category} @ ${file}:${call.Span.Start} ${call.Identifier.Text}(...) in ${call.Parent?.GetType()?.Name}: declared ${expected}, speculative ${actual}"
                        )
                    }
                }
            }
            return compared
        }

        private func IsMemberSegment(name NameExpressionSyntax) bool {
            // Chains parse right-nested: `a.b.c` is `a.(b.c)`, so `b` leads an accessor that is a right part.
            var current SyntaxNode = name
            while true {
                if current.Parent is IndexExpressionSyntax indexed && object.ReferenceEquals(indexed.Target, current) {
                    current = indexed
                } else if current.Parent is AccessorExpressionSyntax accessor {
                    if object.ReferenceEquals(accessor.RightPart, current) {
                        return true
                    }
                    current = accessor
                } else {
                    return false
                }
            }
        }

        private func AssertNoMismatches(mismatches List[string]) {
            if mismatches.Count == 0 {
                return
            }
            let byCategory = mismatches
                .GroupBy((m string) -> m.Substring(0, m.IndexOf(" @ ", StringComparison.Ordinal)))
                .OrderBy((g IGrouping[string, string]) -> g.Key, StringComparer.Ordinal)
                .ToArray()
            let text = StringBuilder()
            text.AppendLine("${mismatches.Count} expressions disagree with the binder:")
            for group in byCategory {
                text.AppendLine("  ${group.Key}: ${group.Count()}")
                for example in group.Take(5) {
                    text.AppendLine("      " + example.Substring(example.IndexOf(" @ ", StringComparison.Ordinal) + 3))
                }
            }
            Assert.Fail(text.ToString())
        }
    }
}
