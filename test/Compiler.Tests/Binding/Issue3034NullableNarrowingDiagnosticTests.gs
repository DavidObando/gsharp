// <copyright file="Issue3034NullableNarrowingDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import Xunit

/// Issue #3034: GS0159 distinguishes a nullable receiver from unrelated
/// function-lookup failures and explains how to make the call safe.
open class Issue3034NullableNarrowingDiagnosticTests {
    @Theory
    @MemberData("ReceiverKindCases")
    func NullableReceiverGuidance_MatchesReceiverNarrowability(
        receiverKind string,
        state string,
        $scope string,
        expectDiagnostic bool
    ) {
        let source = CreateReceiverKindSource(receiverKind, state, $scope)
        let diagnostics = GetDiagnostics(source, isLibrary: $scope != "top-level" && receiverKind != "global")
        if !expectDiagnostic {
            Assert.Empty(diagnostics)
            return
        }
        if receiverKind == "parameter" && state == "narrowed-before-call" {
            Assert.Equal(2, diagnostics.Length)
            Assert.Contains(
                diagnostics,
                (diagnostic Diagnostic) -> diagnostic.Message == "Variable 'c' is read-only and cannot be assigned to."
            )
        } else {
            Assert.Single(diagnostics)
        }
        let diagnostic = Assert.Single(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0159")
        let receiver = if receiverKind == "field" {
            "b.Inner"
        } else {
            "c"
        }
        Assert.Equal(
            "Cannot call function M because receiver '$receiver' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
        Assert.DoesNotContain("re-narrow", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @MemberData("GuidanceRemedyCases")
    func NullableReceiverGuidance_SuggestedRemediesCompile(
        receiverKind string,
        sourceTemplate string,
        receiver string,
        call string,
        isLibrary bool
    ) {
        let diagnosticSource = sourceTemplate.Replace("/*CALL*/", "$receiver.$call", StringComparison.Ordinal)
        let diagnosticResult = Compile(diagnosticSource, isLibrary)
        let diagnostic = Assert.Single(
            diagnosticResult.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0159"
        )
        let expectedDiagnosticIds = diagnosticResult
            .Diagnostics
            .Where((diagnostic Diagnostic) -> diagnostic.Id != "GS0159")
            .Select((diagnostic Diagnostic) -> diagnostic.Id)
            .Order()
            .ToArray()
        let (nullSafeOperator, bindingKeyword) = GetSuggestedRemedies(diagnostic.Message)
        let remedies = [](Name string, Code string){
            (Name: nullSafeOperator, Code: "$receiver$nullSafeOperator$call"),
            (Name: bindingKeyword, Code: ("$bindingKeyword" + ` narrowed = ` + "$receiver" + ` {
    narrowed.` + "$call" + `
}`))
        }
        for remedy in remedies {
            let source = sourceTemplate.Replace("/*CALL*/", remedy.Item2, StringComparison.Ordinal)
            let result = Compile(source, isLibrary)
            Assert.True(
                result.Success,
                "$receiverKind/${remedy.Item1}: ${string.Join(Environment.NewLine, result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))}"
            )
            Assert.Equal(
                expectedDiagnosticIds,
                result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id).Order()
            )
        }
    }

    @Fact
    func ExpiredBranchNarrowing_ExplainsNeedToRenarrow() {
        let diagnostic = GetGs0159(`class C {
    func M() { }
}

func Run() {
    var c C? = C()
    if c != nil {
        c.M()
    }

    c.M()
}`)
        Assert.Equal(NullableReceiverMessage, diagnostic.Message)
    }

    @Fact
    func MissingMethodOnNullableReceiver_KeepsLookupMessage() {
        let diagnostic = GetGs0159(`class C {
    func M() { }
}

func Run() {
    var c C? = nil
    c.Frobnicate()
}`)
        Assert.Equal("Cannot find function Frobnicate.", diagnostic.Message)
    }

    @Theory
    @InlineData("function")
    @InlineData("top-level")
    func WrongArityOnNullableReceiver_KeepsLookupMessage($scope string) {
        let source = if $scope == "top-level" {
            `class C { func M(value int32) { } }

var c C? = nil
c.M()`
        } else {
            `class C { func M(value int32) { } }

func Run() {
    var c C? = nil
    c.M()
}`
        }
        let diagnostic = GetGs0159(source, isLibrary: $scope != "top-level")
        Assert.Equal("Cannot find function M.", diagnostic.Message)
        AssertDiagnosticSpan(
            diagnostic,
            line: if $scope == "top-level" {
                3
            } else {
                4
            },
            startCharacter: if $scope == "top-level" {
                2
            } else {
                6
            },
            endCharacter: if $scope == "top-level" {
                5
            } else {
                9
            },
            text: "M()"
        )
    }

    @Theory
    @InlineData("function")
    @InlineData("top-level")
    func WrongArgumentTypeOnNullableReceiver_KeepsLookupMessage($scope string) {
        let source = if $scope == "top-level" {
            `class C { func M(value int32) { } }

var c C? = nil
c.M("x")`
        } else {
            `class C { func M(value int32) { } }

func Run() {
    var c C? = nil
    c.M("x")
}`
        }
        let diagnostic = GetGs0159(source, isLibrary: $scope != "top-level")
        Assert.Equal("Cannot find function M.", diagnostic.Message)
        AssertDiagnosticSpan(
            diagnostic,
            line: if $scope == "top-level" {
                3
            } else {
                4
            },
            startCharacter: if $scope == "top-level" {
                2
            } else {
                6
            },
            endCharacter: if $scope == "top-level" {
                8
            } else {
                12
            },
            text: "M(\"x\")"
        )
    }

    @Fact
    func StructNullableReceiver_ExplainsMissingNarrowing() {
        let diagnostic = GetGs0159(`struct S { func M() { } }

func Run() {
    var s S? = nil
    s.M()
}`)
        Assert.Equal(
            "Cannot call function M because receiver 's' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func InterfaceNullableReceiver_ExplainsMissingNarrowing() {
        let diagnostic = GetGs0159(`interface I { func M(); }

func Run() {
    var value I? = nil
    value.M()
}`)
        Assert.Equal(
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func EnumNullableReceiver_ExplainsMissingNarrowing() {
        let diagnostic = GetGs0159(`enum E { A }

func Run() {
    var value E? = nil
    value.ToString()
}`)
        Assert.Equal(
            "Cannot call function ToString because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func ConstrainedTypeParameterNullableReceiver_ExplainsMissingNarrowing() {
        let diagnostic = GetGs0159(`interface I { func M(); }

func Use[T I](value T?) {
    value.M()
}`)
        Assert.Equal(
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func ImportedNullableReceiver_Reports_LikeASourceDeclaredOne() {
        // Issue #4287: an imported instance method on a stated `T?` receiver
        // used to bind with no diagnostic (this test pinned that as "existing
        // successful binding"). It now reports the same GS0159 a G#-declared
        // method gets on the same receiver.
        let diagnostic = GetGs0159(`import System.Text

func Run() {
    var value StringBuilder? = nil
    value.ToString()
}`)
        Assert.Equal(
            "Cannot call function ToString because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func ArrayNullableReceiver_Reports_LikeASourceDeclaredOne() {
        // Issue #4287, the other half this test used to pin as "existing
        // successful binding": a nilable SLICE (`[]?T`, ADR-0132) is a
        // `NullableTypeSymbol` over the array too, so an imported instance
        // method on it now reports the same GS0159.
        let diagnostic = GetGs0159(`func Run() {
    var values []?int32 = nil
    values.ToString()
}`)
        Assert.Equal(
            "Cannot call function ToString because receiver 'values' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func QualifiedNullableReceiver_PreservesQualifier() {
        let diagnostic = GetGs0159(`class C {
    func M() { }
}

class Box {
    var Inner C?
}

func Run() {
    var b Box = Box()
    b.Inner.M()
}`)
        Assert.Equal(
            "Cannot call function M because receiver 'b.Inner' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
    }

    @Fact
    func MultilineNullableReceiver_CollapsesWhitespace() {
        let diagnostic = GetGs0159(`class C { func M() { } }
class Box { var Inner C? }
func Run() {
    var b Box = Box()
    b.
        Inner.M()
}`)
        Assert.Equal(
            "Cannot call function M because receiver 'b. Inner' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message
        )
        Assert.DoesNotContain('\n', diagnostic.Message)
        AssertDiagnosticSpan(diagnostic, line: 5, startCharacter: 14, endCharacter: 17, text: "M()")
    }

    @Fact
    func InvalidExplicitTypeArgument_KeepsLookupMessage() {
        let diagnostic = GetGs0159AllowingOtherDiagnostics(`import System

func Run() {
    Array.Empty[Missing]()
}`)
        Assert.Equal("Cannot find function Empty.", diagnostic.Message)
    }

    @Fact
    func MissingImportedStaticMethod_KeepsLookupMessage() {
        let diagnostic = GetGs0159(`import System

func Run() {
    Console.Nope()
}`)
        Assert.Equal("Cannot find function Nope.", diagnostic.Message)
    }

    @Fact
    func MissingImportedInstanceMethod_KeepsLookupMessage() {
        let diagnostic = GetGs0159(`func Run() {
    "x".Nope()
}`)
        Assert.Equal("Cannot find function Nope.", diagnostic.Message)
    }

    @Fact
    func ImportedDelegateMemberMismatch_KeepsLookupMessage() {
        let diagnostic = GetGs0159(`import GSharp.Compiler.Tests.Binding

func Run() {
    var bag = Issue3034DelegateBag()
    bag.Handler = (value int32) -> value
    bag.Handler?("x")
}`)
        Assert.Equal("Cannot find function Handler.", diagnostic.Message)
    }

    shared {
        private const NullableReceiverMessage string = "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'."

        private func GetGs0159(source string, isLibrary bool = true) Diagnostic {
            let diagnostic = Assert.Single(GetDiagnostics(source, isLibrary))
            Assert.Equal("GS0159", diagnostic.Id)
            return diagnostic
        }

        private func GetGs0159AllowingOtherDiagnostics(source string) Diagnostic -> Assert.Single(
            GetDiagnostics(source),
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0159"
        )

        private func GetDiagnostics(source string, isLibrary bool = true)[]Diagnostic -> Compile(source, isLibrary)
            .Diagnostics
            .ToArray()

        private func Compile(source string, isLibrary bool) EmitResult {
            let sourceText = SourceText.From(source, "issue3034.gs")
            let tree = SyntaxTree.Parse(sourceText)
            let compilation = Compilation(ReferenceResolver.Default(), tree){IsLibrary = isLibrary}
            using let peStream = MemoryStream()
            return compilation.Emit(peStream, refStream: nil)
        }

        prop ReceiverKindCases TheoryData[string, string, string, bool] -> {
            let values = TheoryData[string, string, string, bool]()
            values.Add("local", "never-narrowed", "function", true)
            values.Add("local", "narrowed-before-call", "function", false)
            values.Add("parameter", "never-narrowed", "function", true)
            values.Add("parameter", "narrowed-before-call", "function", true)
            values.Add("field", "never-narrowed", "top-level", true)
            values.Add("field", "narrowed-before-call", "top-level", true)
            values.Add("field", "never-narrowed", "function", true)
            values.Add("field", "narrowed-before-call", "function", true)
            values.Add("global", "never-narrowed", "top-level", true)
            values.Add("global", "narrowed-before-call", "top-level", false)
            values.Add("global", "never-narrowed", "function", true)
            values.Add("global", "narrowed-before-call", "function", false)
            values.Add("let", "never-narrowed", "top-level", true)
            values.Add("let", "narrowed-before-call", "top-level", true)
            values.Add("let", "never-narrowed", "function", true)
            values.Add("let", "narrowed-before-call", "function", true)
            values
        }

        prop GuidanceRemedyCases TheoryData[string, string, string, string, bool] -> {
            let values = TheoryData[string, string, string, string, bool]()
            values.Add("local", `class C { func M() { } }
func Run() {
    var c C? = nil
    /*CALL*/
}`, "c", "M()", true)
            values.Add("parameter", `class C { func M() { } }
func Run(c C?) {
    /*CALL*/
}`, "c", "M()", true)
            values.Add("field", `class C { func M() { } }
class Box { var Inner C? }
func Run() {
    var b Box = Box()
    /*CALL*/
}`, "b.Inner", "M()", true)
            values.Add("global", `class C { func M() { } }
var c C? = nil
func Run() {
    /*CALL*/
}`, "c", "M()", false)
            values.Add("let", `class C { func M() { } }
func Run() {
    let c C? = nil
    /*CALL*/
}`, "c", "M()", true)
            values.Add("struct", `struct S { func M() { } }
func Run() {
    var value S? = nil
    /*CALL*/
}`, "value", "M()", true)
            values.Add("interface", `interface I { func M(); }
func Run(value I?) {
    /*CALL*/
}`, "value", "M()", true)
            values.Add("enum", `enum E { A }
func Run() {
    var value E? = nil
    /*CALL*/
}`, "value", "ToString()", true)
            values.Add("constrained-type-parameter", `interface I { func M(); }
func Run[T I](value T?) {
    /*CALL*/
}`, "value", "M()", true)
            values.Add("extension", `class C { }
func (value C) M() { }
func Run() {
    var c C? = nil
    /*CALL*/
}`, "c", "M()", true)
            values
        }

        private func GetSuggestedRemedies(message string)(NullSafeOperator string, BindingKeyword string) {
            const useMarker = "Use '"
            const bindMarker = "bind it with '"
            let nullSafeStart = message.IndexOf(useMarker, StringComparison.Ordinal) + useMarker.Length
            let nullSafeEnd = message.IndexOf('\'', nullSafeStart)
            let bindingStart = message.IndexOf(bindMarker, StringComparison.Ordinal) + bindMarker.Length
            let bindingEnd = message.IndexOf('\'', bindingStart)
            Assert.True(nullSafeStart >= useMarker.Length && nullSafeEnd > nullSafeStart)
            Assert.True(bindingStart >= bindMarker.Length && bindingEnd > bindingStart)
            return (message[nullSafeStart .. nullSafeEnd], message[bindingStart .. bindingEnd])
        }

        private func CreateReceiverKindSource(receiverKind string, state string, $scope string) string {
            let setNonNull = state == "narrowed-before-call"
            return switch (receiverKind, $scope) {
                case {Item1: "local", Item2: "function"}: (`class C { func M() { } }
func Run() {
    var c C? = nil
    ` + "${(if setNonNull { "c = C()" } else { string.Empty })}" + `
    c.M()
}`)
                case {Item1: "parameter", Item2: "function"}: (`class C { func M() { } }
func Run(c C?) {
    ` + "${(if setNonNull { "c = C()" } else { string.Empty })}" + `
    c.M()
}`)
                case {Item1: "field", Item2: "top-level"}: (`class C { func M() { } }
class Box { var Inner C? }
var b Box = Box()
` + "${(if setNonNull { "b.Inner = C()" } else { string.Empty })}" + `
b.Inner.M()`)
                case {Item1: "field", Item2: "function"}: (`class C { func M() { } }
class Box { var Inner C? }
func Run() {
    var b Box = Box()
    ` + "${(if setNonNull { "b.Inner = C()" } else { string.Empty })}" + `
    b.Inner.M()
}`)
                case {Item1: "global", Item2: "top-level"}: (`class C { func M() { } }
var c C? = nil
` + "${(if setNonNull { "c = C()" } else { string.Empty })}" + `
c.M()`)
                case {Item1: "global", Item2: "function"}: (`class C { func M() { } }
var c C? = nil
func Run() {
    ` + "${(if setNonNull { "c = C()" } else { string.Empty })}" + `
    c.M()
}`)
                case {Item1: "let", Item2: "top-level"}: (`class C { func M() { } }
let c C? = ` + "${(if setNonNull { "C()" } else { "nil" })}" + `
c.M()`)
                case {Item1: "let", Item2: "function"}: (`class C { func M() { } }
func Run() {
    let c C? = ` + "${(if setNonNull { "C()" } else { "nil" })}" + `
    c.M()
}`)
                default: throw ArgumentOutOfRangeException("receiverKind")
            }
        }

        private func AssertDiagnosticSpan(
            diagnostic Diagnostic,
            line int32,
            startCharacter int32,
            endCharacter int32,
            text string
        ) {
            Assert.Equal(line, diagnostic.Location.StartLine)
            Assert.Equal(line, diagnostic.Location.EndLine)
            Assert.Equal(startCharacter, diagnostic.Location.StartCharacter)
            Assert.Equal(endCharacter, diagnostic.Location.EndCharacter)
            Assert.Equal(text, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        }
    }
}

/// Provides an imported delegate member for the GS0159 call-site matrix.
struct Issue3034DelegateBag {
    /// Delegate member invoked with an incompatible argument.
    var Handler(int32) -> int32
}
