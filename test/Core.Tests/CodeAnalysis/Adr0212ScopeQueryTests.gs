// <copyright file="Adr0212ScopeQueryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Threading
import Xunit

/// ADR-0212 slice S3: (cref:SemanticModel.GetEnclosingSymbol) and
/// (cref:SemanticModel.LookupSymbols). One test per row of the contract tables in the
/// documentation of the two queries. The marker `// Pname` in `Source` is the position
/// the row queries: the start of the comment, inside the construct the row names.
open class Adr0212ScopeQueryTests {
    // ---- LookupSymbols, tier 1: locals ----

    @Fact
    func Local_IsNotVisibleBeforeItsDeclaration() {
        // A name declared later in the block is not offered where it cannot yet be read.
        Assert.DoesNotContain("outer", Names("PTop"))
        Assert.DoesNotContain("later", Names("PCatch"))
    }

    @Fact
    func Local_IsVisibleAfterItsDeclaration() {
        Assert.Contains("outer", Names("PAfter"))
        Assert.Contains("early", Names("PMethod"))
    }

    @Fact
    func Local_IsNotVisibleAfterItsBlockEnds() {
        Assert.Contains("innerOnly", Names("PInBlock"))
        Assert.DoesNotContain("innerOnly", Names("PAfterBlock"))
    }

    @Fact
    func Parameter_IsVisibleInTheBodyAndShadowsAGlobal() {
        let total = Single("PTop", "Total")
        Assert.IsType[ParameterSymbol](total)
    }

    @Fact
    func Parameter_IsNotVisibleOutsideItsFunction() {
        Assert.DoesNotContain("seed", Names("PTop"))
    }

    @Fact
    func IfLet_BindingIsVisibleInTheThenRegionOnly() {
        let outer = Single("PAfter", "outer")
        let inThen = Single("PThen", "outer")
        let inElse = Single("PElse", "outer")
        Assert.NotSame(outer, inThen)
        Assert.Same(outer, inElse)
        Assert.Contains("inside", Names("PThen"))
        Assert.DoesNotContain("inside", Names("PElse"))
    }

    @Fact
    func WhileLet_BindingIsVisibleInTheBodyOnly() {
        Assert.Contains("w", Names("PWhile"))
        Assert.DoesNotContain("w", Names("PFor"))
        Assert.DoesNotContain("w", Names("PAfter"))
    }

    @Fact
    func GuardLet_EarlierBindingIsVisibleToLaterClausesButNotTheElseBody() {
        let model = Compiled.Model
        let inSecondClause = Source.IndexOf("Next(guarded)", StringComparison.Ordinal) + 5
        Assert.IsType[LocalVariableSymbol](Assert.Single(model.LookupSymbols(inSecondClause, "guarded")))
        Assert.DoesNotContain("guarded", Names("PGuardElse"))
        Assert.DoesNotContain("secondValue", Names("PGuardElse"))
    }

    @Fact
    func IfLetInsideAGuardElse_SeesItsOwnBinding() {
        // The nearest binding form owns a clause; the enclosing guard is not it.
        Assert.IsType[LocalVariableSymbol](Single("PNestedIf", "inner"))
        Assert.Empty(Compiled.Model.LookupSymbols(Position("PNestedIf"), "outer"))
    }

    @Fact
    func FieldTypeClause_IsMatchedToItsOwnFieldNotItsArrayIndex() {
        // `id` and `extra` are primary-constructor fields prepended to the symbols and `Cap` is a constant held
        // apart from them: an index would pair `string` with int32.
        let model = Compiled.Model
        let label = Compiled
            .Tree
            .Root
            .DescendantNodes()
            .OfType[FieldDeclarationSyntax]()
            .Single((f FieldDeclarationSyntax) -> f.Identifier.Text == "Label")
        Assert.Same(TypeSymbol.String, model.GetSymbolInfo(label.Type.Identifier).Symbol)
    }

    @Fact
    func IsPatternVariable_IsScopedToItsStatement() {
        Assert.Contains("text", Names("PInIs"))
        Assert.DoesNotContain("text", Names("PAfterIs"))
    }

    @Fact
    func PartialInterface_EveryPartHasAnEnclosingSymbol() {
        Assert.Equal("IParts", Assert.IsType[InterfaceSymbol](Enclosing("PPartInterface")).Name)
    }

    @Fact
    func Members_ExcludeIndexersAndInheritedPrivateMembersAndIncludeConstants() {
        let names = Names("PDerived")
        Assert.Contains("Mine", names)
        Assert.Contains("Shown", names)
        Assert.DoesNotContain("Hidden", names)
        Assert.Contains("Max", names)
        Assert.IsType[FieldSymbol](Single("PDerived", "Max"))
        // The indexer does not hide the global function of the same name.
        Assert.IsType[FunctionSymbol](Single("PDerived", "Item"))
        Assert.Empty(Compiled.Model.LookupSymbols(Position("PDerived"), "Hidden"))
    }

    @Fact
    func GuardLet_BindingIsVisibleAfterTheStatement() {
        Assert.Contains("guarded", Names("PAfterGuard"))
        Assert.DoesNotContain("guarded", Names("PBeforeGuard"))
    }

    @Fact
    func ForRange_VariableIsVisibleInTheBodyOnly() {
        Assert.Contains("item", Names("PFor"))
        Assert.DoesNotContain("item", Names("PCatch"))
    }

    @Fact
    func Catch_VariableIsVisibleInTheCatchBodyOnly() {
        Assert.Contains("e", Names("PCatch"))
        Assert.DoesNotContain("e", Names("PAfterTry"))
    }

    @Fact
    func LambdaParameter_IsVisibleInTheLambdaBody() {
        Assert.IsType[ParameterSymbol](Single("PLambda", "q"))
        Assert.DoesNotContain("q", Names("PAfterTry"))
    }

    @Fact
    func FunctionLiteralParameter_IsNotVisibleAfterTheLiteral() {
        Assert.IsType[ParameterSymbol](Single("PLambda", "q"))
        Assert.DoesNotContain("q", Names("PAfterLiteral"))
        Assert.DoesNotContain("unusedParam", Names("PAfterLiteral"))
    }

    @Fact
    func UnusedFunctionLiteralParameter_IsVisibleInTheLiteralBody() {
        Assert.IsType[ParameterSymbol](Single("PUnusedParam", "unusedParam"))
    }

    @Fact
    func CatchVariable_IsVisibleInTheWhenFilter() {
        let model = Compiled.Model
        let inFilter = Source.IndexOf("e.Message.Length > 0", StringComparison.Ordinal) + 2
        Assert.IsType[LocalVariableSymbol](Assert.Single(model.LookupSymbols(inFilter, "e")))
    }

    @Fact
    func UnusedCatchVariable_IsVisibleInItsHandler() {
        Assert.IsType[LocalVariableSymbol](Single("PUnusedCatch", "unusedCatch"))
        Assert.DoesNotContain("unusedCatch", Names("PCatch"))
    }

    @Fact
    func DestructuredLambdaElement_IsVisibleInTheLambdaBody() {
        let model = Compiled.Model
        let tree = Compiled.Tree
        let position = Source.IndexOf("dx + dy", StringComparison.Ordinal) + 3
        let found = model.LookupSymbols(position, "dx")
        Assert.Single(found)
        Assert.IsType[LocalVariableSymbol](found[0])
    }

    @Fact
    func LocalFunction_IsVisibleBeforeItsDeclarationSoItsGroupCanRecurse() {
        let found = Single("PFirst", "second")
        Assert.IsType[FunctionSymbol](found)
        Assert.Equal("second", found.Name)
    }

    @Fact
    func LetBoundFunctionLiteral_SeesItselfInItsBody() {
        Assert.IsType[LocalVariableSymbol](Single("PSelf", "fact"))
    }

    @Fact
    func PatternVariable_IsVisibleAfterItsDeclarationInTheBlock() {
        // A switch case's pattern variable belongs to its case alone.
        Assert.Contains("typed", Names("PInCase"))
        Assert.DoesNotContain("typed", Names("PInOtherCase"))
        Assert.DoesNotContain("typed", Names("PAfterPattern"))
    }

    // ---- LookupSymbols, tier 2: members and this ----

    @Fact
    func InstanceMethod_SeesInstanceAndStaticMembersAndThis() {
        let names = Names("PMethod")
        Assert.Contains("Value", names)
        Assert.Contains("Other", names)
        Assert.Contains("Area", names)
        Assert.Contains("Count", names)
        Assert.Contains("this", names)
    }

    @Fact
    func Constructor_SeesMembersAndThis() {
        let names = Names("PCtor")
        Assert.Contains("Value", names)
        Assert.Contains("start", names)
        Assert.Contains("this", names)
    }

    @Fact
    func SharedMethod_SeesStaticMembersOnly() {
        let names = Names("PShared")
        Assert.Contains("Count", names)
        Assert.DoesNotContain("Value", names)
        Assert.DoesNotContain("this", names)
    }

    @Fact
    func SharedClass_SeesItsMembersAndHasAnEnclosingSymbol() {
        Assert.Contains("Items", Names("PStatic"))
        Assert.Equal("Statics", Assert.IsType[StructSymbol](Enclosing("PStaticType")).Name)
    }

    @Fact
    func SetterParameter_IsVisibleInTheSetterBody() {
        // The binder gives the setter's `value` no syntax; it is the accessor function's parameter.
        Assert.IsType[ParameterSymbol](Single("PSet", "value"))
        Assert.DoesNotContain("value", Names("PGet"))
    }

    @Fact
    func PartialType_EveryPartSeesTheMembersOfAllParts() {
        let names = Names("PPart")
        Assert.Contains("One", names)
        Assert.Contains("Two", names)
        Assert.Equal("Parts", Assert.IsType[StructSymbol](Enclosing("PPartBody")).Name)
    }

    @Fact
    func Accessor_SeesMembers() {
        Assert.Contains("Other", Names("PSet"))
        Assert.Contains("Value", Names("PGet"))
    }

    @Fact
    func Member_ShadowsAGlobalOfTheSameName() {
        let model = Compiled.Model
        let found = model.LookupSymbols(Position("PMember"), "Helper")
        Assert.IsType[FunctionSymbol](Assert.Single(found))
        Assert.NotNull(Assert.Single(found).DeclaringSyntaxNodes[0].FirstAncestorOrSelf[StructDeclarationSyntax]())
    }

    // ---- LookupSymbols, tier 3: globals ----

    @Fact
    func Globals_ListFunctionsVariablesTypesAndAliases() {
        let names = Names("PTop")
        Assert.Contains("Helper", names)
        Assert.Contains("Counter", names)
        Assert.Contains("IShape", names)
        Assert.Contains("Color", names)
    }

    @Fact
    func TypeAlias_AnswersTheTypeItNamesWhenQueriedByName() {
        // An alias has no symbol of its own: the name answers the aliased type.
        Assert.Same(TypeSymbol.Int32, Single("PTop", "Alias"))
        Assert.Same(TypeSymbol.Int32, Single("PTop", "Alias2"))
    }

    @Fact
    func TypeAlias_IsNotListedUnderTheTargetsName() {
        // Two aliases of one target would otherwise give two symbols named `int32`.
        Assert.DoesNotContain("int32", Names("PTop"))
    }

    @Fact
    func Name_FiltersToThatNameAndUnknownNamesAnswerNothing() {
        let model = Compiled.Model
        let position = Position("PAfter")
        Assert.Single(model.LookupSymbols(position, "outer"))
        Assert.True(model.LookupSymbols(position, "NoSuchName").IsEmpty)
    }

    @Fact
    func Result_HasOneSymbolPerName() {
        let names = Names("PThen")
        Assert.Equal(names.Count, names.Distinct().Count())
    }

    @Fact
    func Result_IsInnermostScopeFirstThenDeclarationOrder() {
        let names = Names("PThen")
        // `inside` (then block) before `outer` (the if-let binding), before the function's
        // parameters and earlier locals; globals come last.
        Assert.True(names.IndexOf("inside") < names.IndexOf("outer"))
        Assert.True(names.IndexOf("outer") < names.IndexOf("Helper"))
        Assert.True(names.IndexOf("maybe") < names.IndexOf("Helper"))
    }

    @Fact
    func Result_IsTheSameOnEveryCall() {
        let first = Names("PThen")
        let second = Names("PThen")
        Assert.Equal(first, second)
    }

    @Fact
    func Queries_HonourACancelledToken() {
        let model = Compiled.Model
        let cancelled = CancellationToken(true)
        Assert.Throws[OperationCanceledException](() -> model.LookupSymbols(0, nil, cancelled))
        Assert.Throws[OperationCanceledException](() -> model.GetEnclosingSymbol(0, cancelled))
    }

    // ---- GetEnclosingSymbol ----

    @Fact
    func Enclosing_Function_IsTheDeclaredFunction() {
        let symbol = Enclosing("PTop")
        Assert.Equal("Shadow", Assert.IsType[FunctionSymbol](symbol).Name)
    }

    @Fact
    func Enclosing_Method_IsTheMethod() {
        Assert.Equal("Area", Assert.IsType[FunctionSymbol](Enclosing("PMethod")).Name)
        Assert.Equal("Make", Assert.IsType[FunctionSymbol](Enclosing("PShared")).Name)
    }

    @Fact
    func Enclosing_Constructor_IsTheConstructorFunction() {
        let symbol = Assert.IsType[FunctionSymbol](Enclosing("PCtor"))
        Assert.NotNull(symbol.ThisParameter)
        Assert.Null(symbol.Declaration)
    }

    @Fact
    func Enclosing_Accessor_IsTheAccessorFunction() {
        let getter = Assert.IsType[FunctionSymbol](Enclosing("PGet"))
        let setter = Assert.IsType[FunctionSymbol](Enclosing("PSet"))
        Assert.NotSame(getter, setter)
        Assert.Contains("Name", getter.Name)
    }

    @Fact
    func Enclosing_LambdaBody_IsTheEnclosingDeclaration() {
        Assert.Equal("Shadow", Assert.IsType[FunctionSymbol](Enclosing("PLambda")).Name)
    }

    @Fact
    func Enclosing_TypeBody_IsTheType() {
        let model = Compiled.Model
        let position = Source.IndexOf("var Other", StringComparison.Ordinal)
        Assert.Equal("Counter", Assert.IsType[StructSymbol](model.GetEnclosingSymbol(position)).Name)
        let shape = Source.IndexOf("func Area() int32\n", StringComparison.Ordinal)
        Assert.Equal("IShape", Assert.IsType[InterfaceSymbol](model.GetEnclosingSymbol(shape)).Name)
    }

    @Fact
    func Enclosing_TopLevelLet_IsTheGlobal() {
        let model = Compiled.Model
        let position = Source.IndexOf("var Total", StringComparison.Ordinal) + 5
        Assert.IsType[GlobalVariableSymbol](model.GetEnclosingSymbol(position))
    }

    @Fact
    func Enclosing_TopLevelOutsideADeclaration_IsNull() {
        let model = Compiled.Model
        Assert.Null(model.GetEnclosingSymbol(0))
    }

    // ---- GetSymbolInfo rows S3 adds ----

    @Fact
    func SymbolInfo_OfATypeClauseIdentifier_IsTheType() {
        let model = Compiled.Model
        let tree = Compiled.Tree
        let clause = tree
            .Root
            .DescendantNodes()
            .OfType[FunctionDeclarationSyntax]()
            .First((f FunctionDeclarationSyntax) -> f.Identifier.Text == "Helper")
            .Parameters[0]
            .Type!!
        Assert.Same(TypeSymbol.Int32, model.GetSymbolInfo(clause.Identifier!!).Symbol)
    }

    @Fact
    func SymbolInfo_OfALocalFunctionDeclaration_IsTheFunction() {
        let model = Compiled.Model
        let tree = Compiled.Tree
        let declaration = tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Single((d VariableDeclarationSyntax) -> d.Identifier.Text == "first")
        Assert.IsType[FunctionSymbol](model.GetSymbolInfo(declaration.Identifier).Symbol)
    }

    @Fact
    func SymbolInfo_OfADestructuredLambdaElement_IsItsOwnLocal() {
        let model = Compiled.Model
        let tree = Compiled.Tree
        let element = tree
            .Root
            .DescendantNodes()
            .OfType[LambdaExpressionSyntax]()
            .SelectMany((l LambdaExpressionSyntax) -> l.Parameters)
            .Where((p ParameterSyntax) -> p.DeconstructionPattern != nil)
            .SelectMany((p ParameterSyntax) -> p.DeconstructionPattern!!.Elements)
            .First()
            .Identifier!!
        Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(element).Symbol)
    }

    shared {
        private const Source string = `package Scope
import System
enum Color { Red, Green }
type Alias = int32
type Alias2 = int32
var Total = 0
partial class Parts {
    var One int32
}
partial class Parts {
    var Two int32
    // PPartBody
    func Use() int32 {
        return One + Two // PPart
    }
}
interface IShape {
    func Area() int32
}
func Helper(x int32) int32 { return x }
func Next(s string) string? { return s }
class Primary(id int64, extra int64) {
    const Cap int32 = 5
    var Label string
}
func Nested(input string?, fallback string?) int32 {
    guard let outer = input else {
        if let inner = fallback {
            return inner.Length // PNestedIf
        }
        return 0
    }
    return outer.Length
}
partial interface IParts {
    func A() int32
}
partial interface IParts {
    // PPartInterface
    func B() int32
}
open class BaseHolder {
    private var Hidden int32
    var Shown int32
}
class Derived : BaseHolder {
    private var Mine int32
    const Max int32 = 50
    prop this[i int32] int32 {
        get {
            return i
        }
    }
    func Use() int32 {
        return Mine // PDerived
    }
}
func Item() int32 { return 1 }
class Counter : IShape {
    var Value int32
    var Other int32
    prop Name string {
        get {
            return "n" + Value.ToString() // PGet
        }
        set {
            Other = 1 // PSet
        }
    }
    init(start int32) {
        let local = start // PCtor
        Value = local
    }
    func Helper() int32 { return 0 // PMember
    }
    func Area() int32 {
        let early = 1
        // PMethod
        return Value + early
    }
    shared {
        var Count int32 = 0
        func Make(seed int32) Counter {
            return Counter(seed) // PShared
        }
    }
}
shared class Statics {
    func Items(x int32) int32 {
        return Wrap(x) // PStatic
    }
    func Wrap(x int32) int32 -> x
    // PStaticType
}
func Blocks() int32 {
    if true {
        let innerOnly = 1 // PInBlock
    }
    return 0 // PAfterBlock
}
func Shadow(Total int32, maybe string?, items []int32) int32 {
    // PTop
    let outer = 1
    if let outer = maybe && outer.Length > 0 {
        let inside = outer // PThen
    } else {
        let otherwise = outer // PElse
    }
    let after = outer // PAfter
    // PBeforeGuard
    guard let guarded = maybe, let secondValue = Next(guarded) else {
        return 0 // PGuardElse
    }
    let usesGuarded = guarded // PAfterGuard
    while let w = maybe {
        let body = w // PWhile
        break
    }
    for item in items {
        let x = item // PFor
    }
    try {
        let t = 1
    } catch (e Exception) when e.Message.Length > 0 {
        let m = e // PCatch
    } catch (unusedCatch ArgumentException) {
        let z = 0 // PUnusedCatch
    }
    let afterTry = 2 // PAfterTry
    let g = func(q int32) int32 {
        return q // PLambda
    }
    let afterLiteral = 1 // PAfterLiteral
    let unusedLiteral = func(unusedParam int32) int32 {
        return 0 // PUnusedParam
    }
    let d = ((dx int32, dy int32)) -> dx + dy
    let first[T] = func(v T, depth int32) int32 {
        return second(v, depth) // PFirst
    }
    let second[U] = func(v U, depth int32) int32 {
        if depth == 0 { return 42 }
        return first(v, depth - 1)
    }
    let probe object = items[0]
    switch probe {
        case typed is int32 {
            let seen = typed // PInCase
        }
        case other is string {
            let seenOther = other // PInOtherCase
        }
        default { }
    }
    if probe is string text {
        let inIs = text // PInIs
    }
    let afterIs = 1 // PAfterIs
    let afterPattern = 3 // PAfterPattern
    let fact = func(n int32) int32 {
        if n <= 1 { return 1 }
        return n * fact(n - 1) // PSelf
    }
    let later = 2
    return Total + fact(3) + first("x", 2) + g(1) + d((1, 2))
}
`

        // One compilation for every row, so a row can compare symbols across positions.
        private let Compiled(Model SemanticModel, Tree SyntaxTree) = CreateModel()

        private func CreateModel()(Model SemanticModel, Tree SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(Source, "adr0212-scope.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            return (compilation.GetSemanticModel(tree), tree)
        }

        private func Position(marker string) int32 {
            let at = Source.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(at >= 0, "marker ${marker} is in the source")
            return at
        }

        private func Names(marker string) List[string] {
            let model = Compiled.Model
            return model.LookupSymbols(Position(marker)).Select((s Symbol) -> s.Name).ToList()
        }

        private func Single(marker string, name string) Symbol {
            let model = Compiled.Model
            return Assert.Single(model.LookupSymbols(Position(marker), name))
        }

        private func Enclosing(marker string) Symbol? {
            let model = Compiled.Model
            return model.GetEnclosingSymbol(Position(marker))
        }
    }
}
