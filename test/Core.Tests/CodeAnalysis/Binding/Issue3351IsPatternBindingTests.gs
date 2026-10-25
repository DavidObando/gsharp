// <copyright file="Issue3351IsPatternBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binder and bound-tree coverage for issue #3351.
class Issue3351IsPatternBindingTests {
    @Theory
    @InlineData("let matched = value is Role.TextInput text", "Role")
    @InlineData("let matched = value is Role.TextInput {}", "Role")
    @InlineData("let matched = value is Missing.TextInput text", "Missing")
    @InlineData("let item Missing.TextInput = TextInput{}", "Missing")
    func InvalidQualifiedType_DoesNotResolveByFinalName(statement string, qualifier string) {
        let source = `package Repro
enum Role { TextInput, Other }
class TextInput { }
let value object = TextInput{}
` + statement
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0113", diagnostic.Id)
        Assert.Equal(qualifier, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Equal(source.LastIndexOf(qualifier, StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(qualifier.Length, diagnostic.Location.Span.Length)
    }

    @Fact
    func IsExpression_BindsThroughPatternBinderWithBooleanResult() {
        const Source = "let value object = \"hello\"\nlet matched = value is string { Length: > 0 } and not nil"
        let program = BindProgram(Source)
        Assert.Empty(program.Diagnostics)
        let declaration = program.Statement.Statements.OfType[BoundVariableDeclaration]().Last()
        let expression = Assert.IsType[BoundIsExpression](declaration.Initializer)
        let andPattern = Assert.IsType[BoundBinaryPattern](expression.Pattern)
        let typePattern = Assert.IsType[BoundTypePattern](andPattern.Left)
        Assert.Same(TypeSymbol.Bool, expression.Type)
        Assert.False(typePattern.HasBinding)
        Assert.NotNull(typePattern.PropertyPattern)
        Assert.Same(typePattern.Variable, andPattern.RightInputVariable)
        Assert.IsType[BoundNotPattern](andPattern.Right)
    }

    @Fact
    func TypePropertyPattern_NarrowsIsExpressionReceiverInThenBody() {
        let diagnostics = Bind(`func Length(value object) int32 {
    if value is string { Length: > 0 } {
        return value.Length
    }
    return 0
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func AndPattern_BindsRightPropertyAgainstNarrowedTypeInSwitch() {
        let diagnostics = Bind(`open class Animal { }
class Dog : Animal {
    prop Name string { get; init; }
    func Bark() string { return Name }
}
func Speak(value Animal) string {
    return switch value {
        case Dog and { Name: "Rex" }: value.Bark()
        default: "other"
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IsExpressionSwitchSpellingBinding_ReportsGS0525AtBindingName() {
        // ADR-0166: the designation spelling (`value is string text`) and the
        // slice capture (`[..rest]`) now bind pattern variables; only the switch
        // spelling `name is Type` keeps GS0525 in boolean position.
        const Source = `let value object = "hello"
if value is text is string { }
let values = []int32{1, 2}
if values is [..rest] { }`
        let diagnostics = Bind(Source).Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0525").ToArray()
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("text", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("'is Type text'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func IfLet_RemainsBindingAlternative() {
        let diagnostics = Bind(`let maybe string? = "hello"
if let text = maybe {
    let length = text.Length
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func GeneralPatternIsExpression_IsRejectedInsideExpressionTreeWithoutCrashingLowering() {
        let diagnostics = Bind(`import System
import System.Linq.Expressions
let expression Expression[Func[int32, bool]] = (value int32) -> value is 1 or 2`)
        Assert.Contains(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0473" && diagnostic.Message.Contains(
                "general pattern 'is' expression",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func BareTypeAndEnumConstPatterns_CoexistWithoutSwitchRegression() {
        let diagnostics = Bind(`enum Color { Red, Green }
const limit = 5
let color = Color.Red
let value object = "hello"
let enumLabel = switch color {
    case Color.Red: "red"
    case Color.Green: "green"
    default: "other"
}
let constLabel = switch 5 {
    case limit: "limit"
    default: "other"
}
let typeLabel = switch value {
    case string: "string"
    default: "other"
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func LocalConstSwitchPattern_RemainsValuePattern() {
        let diagnostics = Bind(`func Match(value int32) string {
    const limit = 5
    return switch value {
        case limit: "limit"
        default: "other"
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func BareTypePatternsParticipateInSealedExhaustiveness() {
        let diagnostics = Bind(`sealed interface Shape { }
class Circle : Shape { }
class Square : Shape { }
func Name(shape Shape) string {
    return switch shape {
        case Circle: "circle"
        case Square: "square"
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ValueTypeAndNotNil_IsAcceptedOnlyInBooleanPatternPosition() {
        Assert.Empty(Bind(`func Match(value object) bool {
    return value is int32 and not nil
}`))
        let switchDiagnostic = Assert.Single(Bind(`func Match(value int32) string {
    return switch value {
        case not nil: "present"
        default: "other"
    }
}`))
        Assert.Equal("GS0171", switchDiagnostic.Id)
        Assert.Equal(
            "Switch case value of type 'nil' is incompatible with switch expression of type 'int32'.",
            switchDiagnostic.Message
        )
        Assert.Equal("nil", switchDiagnostic.Location.Text!!.ToString(switchDiagnostic.Location.Span))
    }

    @Theory
    @InlineData("let value object = 1\nlet matched = value is somethingMisspelled", "somethingMisspelled")
    @InlineData(`enum Color { Red, Green }
let color = Color.Red
let matched = color is Red`, "Red")
    func UnresolvedTypeOrValueNameInIs_ReportsValueDiagnostic(source string, unresolvedName string) {
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0125", diagnostic.Id)
        Assert.Equal("Variable '$unresolvedName' doesn't exist.", diagnostic.Message)
        Assert.Equal(unresolvedName, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func QualifiedEnumConstantAndValidTypeFirstName_StillBind() {
        let diagnostics = Bind(`enum Color { Red, Green }
const string = 5
let color = Color.Red
let value object = "hello"
let enumMatch = color is Color.Red
let typeMatch = value is string`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope).Diagnostics
        }

        private func BindProgram(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            Assert.Empty(tree.Diagnostics)
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            Assert.Empty(globalScope.Diagnostics)
            return Binder.BindProgram(globalScope)
        }
    }
}
