// <copyright file="Issue3465InferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections
import System.Collections.Generic
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

class Issue3465InferenceTests {
    @Fact
    func GenericMethod_InfersThroughImportedImplementedInterface() {
        let result = Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding
import System.Collections.Generic

func Count[T](items IReadOnlyCollection[T]) int32 {
    return items.Count
}

Count(Issue3465ImportedIntCollection())`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func GenericMethod_InfersThroughImportedGenericBase() {
        let result = Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Read[T](item Issue3465ImportedGenericBase[T]) T {
    return item.Value
}

Read(Issue3465ImportedStringContainer())`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("base", result.Value)
    }

    @Fact
    func GenericMethod_UsesImplementedInterfaceProjection_NotConcreteTypeArguments() {
        let result = Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding
import System.Collections.Generic

func First[T](items IEnumerable[T]) T {
    for item in items {
        return item
    }

    return default(T)
}

First(Issue3465ProjectedCollection[int32]())`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("projected", result.Value)
    }

    @Fact
    func GenericMethod_UsesBaseProjection_NotConcreteTypeArguments() {
        let result = Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding

func Read[T](item Issue3465ImportedGenericBase[T]) T {
    return item.Value
}

Read(Issue3465ProjectedBase[int32]())`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("projected-base", result.Value)
    }

    @Fact
    func GenericMethod_ConflictingImportedInterfaceProjections_DoNotInferArbitrarily() {
        for typeName in[]string{"Issue3465ConflictingCollectionForward", "Issue3465ConflictingCollectionReverse"} {
            let result = Evaluate((`import GSharp.Core.Tests.CodeAnalysis.Binding
import System.Collections.Generic

func Count[T](items IReadOnlyCollection[T]) int32 {
    return items.Count
}

Count(` + "$typeName" + `())`))
            Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0151")
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
        }
    }

    @Fact
    func GenericMethod_RegexGroupCollectionConflict_DoesNotInferArbitrarily() {
        let result = Evaluate(`import System.Collections.Generic
import System.Text.RegularExpressions

func Count[T](items IReadOnlyCollection[T]) int32 {
    return items.Count
}

Count(Regex.Match("a", "a").Groups)`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0151")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
    }

    @Fact
    func GenericMethod_InfersThroughSourceGenericBase() {
        let result = Evaluate(`open class Base[T any] {}
class Derived : Base[string] {}

func Read[T](item Base[T]) T -> default(T)

let value string? = Read(Derived())
value == nil ? 1 : 0`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func GenericMethod_InfersThroughSourceImplementedClrInterface() {
        let result = Evaluate(`import System.Collections
import System.Collections.Generic

class Repo[T] : IEnumerable[T] {
    private let items List[T] = List[T]()

    init(value T) {
        items.Add(value)
    }

    func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}

func First[T](items IEnumerable[T]) T {
    for item in items {
        return item
    }

    return default(T)
}

First(items: (Repo[int32](23)))`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(23, result.Value)
    }

    @Fact
    func SequenceInference_InfersThroughSourceImplementedClrInterface() {
        let result = Evaluate(`import System.Collections
import System.Collections.Generic

class Repo[T] : IEnumerable[T] {
    private let items List[T] = List[T]()

    init(value T) {
        items.Add(value)
    }

    func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}

func First[T](items sequence[T]) T {
    for item in items {
        return item
    }

    return default(T)
}

First(Repo[int32](29))`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(29, result.Value)
    }

    @Fact
    func SequenceInference_ConflictingImportedProjections_DoNotInferArbitrarily() {
        for typeName in[]string{"Issue3465ConflictingCollectionForward", "Issue3465ConflictingCollectionReverse"} {
            let result = Evaluate((`import GSharp.Core.Tests.CodeAnalysis.Binding

func First[T](items sequence[T]) T -> default(T)

First(` + "$typeName" + `())`))
            Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0151"))
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
        }
    }

    @Fact
    func GenericMethod_ConflictingSourceImplementedClrInterfaces_DoNotInferArbitrarily() {
        for baseTypes in[]string{"IEnumerable[int32], IEnumerable[string]", "IEnumerable[string], IEnumerable[int32]"} {
            let result = Evaluate((`import System.Collections
import System.Collections.Generic

class Conflict : ` + "$baseTypes" + ` {
    private func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] ->
        List[int32]().GetEnumerator()
    private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] ->
        List[string]().GetEnumerator()
    private func (IEnumerable) GetEnumerator() IEnumerator ->
        List[int32]().GetEnumerator()
}

func First[T](items IEnumerable[T]) T -> default(T)

First(Conflict())`))
            Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0151"))
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
        }
    }

    @Fact
    func AsyncSequenceInference_ConflictingImportedProjections_DoNotInferArbitrarily() {
        for typeName in[]string{
            "Issue3465ConflictingAsyncCollectionForward",
            "Issue3465ConflictingAsyncCollectionReverse"
        } {
            let result = Evaluate((`import GSharp.Core.Tests.CodeAnalysis.Binding

func First[T](items async sequence[T]) T -> default(T)

First(` + "$typeName" + `())`))
            Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0151"))
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
        }
    }

    @Fact
    func GenericMethod_InfersThroughTransitiveSourceInterface() {
        let result = Evaluate(`interface Root[T] {}
interface Middle[T] : Root[T] {}
class Leaf : Middle[int32] {}

func Read[T](item Root[T]) T -> default(T)

let value int32 = Read(Leaf())
value + 1`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func GenericMethod_ConflictingSourceInterfaceProjections_DoNotInfer() {
        let result = Evaluate(`interface Root[T] {}
interface Left : Root[int32] {}
interface Right : Root[string] {}
class Both : Left, Right {}

func Read[T](item Root[T]) T -> default(T)

Read(Both())`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0151")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
    }

    @Fact
    func GenericConstructor_InfersThroughImportedImplementedInterface() {
        let result = Evaluate(`import GSharp.Core.Tests.CodeAnalysis.Binding
import System.Collections.Generic

class Holder[T] {
    var Count int32

    init(items IReadOnlyCollection[T]) {
        Count = items.Count
    }
}

Holder(Issue3465ImportedIntCollection()).Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func SourceStaticCall_ContextuallyBindsVoidBlockLambda() {
        let result = Evaluate(`class Visitor {
    shared {
        func Visit(action (int32)->void) {
            action(0)
            action(7)
        }
    }
}

var seen = 0
Visitor.Visit((value int32) -> {
    if value == 0 {
        return
    }
    seen = value
})
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func SourceStaticOverload_UsesVoidReturnShape() {
        let result = Evaluate(`class Visitor {
    shared {
        func Visit(action (int32)->void) {
            action(0)
            action(7)
        }

        func Visit(action (int32)->bool) {
        }
    }
}

var seen = 0
Visitor.Visit((value int32) -> {
    if value == 0 {
        return
    }
    seen = value
})
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func SourceStaticOverload_UsesVoidReturnShape_WithImportedParameter() {
        let result = Evaluate(`import System.Collections.Generic
import System.Reflection.Emit

class Visitor {
    shared {
        func Visit(action (OperandType, int32)->void) {
            action(OperandType.InlineI, 7)
        }

        func Visit(action (OperandType, int32)->bool) {
        }
    }
}

let seen = HashSet[int32]()
Visitor.Visit((operandType OperandType, token int32) -> {
    if operandType != OperandType.InlineI {
        return
    }
    seen.Add(token)
})
seen.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func SourceInstanceCall_ContextuallyBindsVoidBlockLambda() {
        let result = Evaluate(`import System.Collections.Generic

class Visitor {
    func Visit(action (int32)->void) {
        action(0)
        action(9)
    }
}

let seen = HashSet[int32]()
Visitor().Visit((value int32) -> {
    if value == 0 {
        return
    }
    seen.Add(value)
})
seen.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func SourceExtensionCall_ContextuallyBindsVoidBlockLambda() {
        let result = Evaluate(`import System.Collections.Generic

func (visitor string) Visit(action (int32)->void) {
    action(0)
    action(11)
}

let seen = HashSet[int32]()
"visitor".Visit((value int32) -> {
    if value == 0 {
        return
    }
    seen.Add(value)
})
seen.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func GenericFunction_ContextuallyBindsVoidBlockLambda() {
        let result = Evaluate(`import System.Collections.Generic

func Visit[T](value T, action (T)->void) {
    action(value)
}

let seen = HashSet[int32]()
Visit(17, (value int32) -> {
    if value == 0 {
        return
    }
    seen.Add(value)
})
seen.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NestedDelegateTarget_ContextuallyBindsVoidBlockLambda() {
        let result = Evaluate(`import System
import System.Collections.Generic

func Accept(factory ()->Action[int32]) {
    let action = factory()
    action(0)
    action(13)
}

let seen = HashSet[int32]()
Accept(() -> (value int32) -> {
    if value == 0 {
        return
    }
    seen.Add(value)
})
seen.Count`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NestedUntypedDelegateTarget_DefersUntilOuterTargetIsKnown() {
        let result = Evaluate(`import System

func Accept(factory ()->Action[int32]) int32 {
    let action = factory()
    action(13)
    return 1
}

Accept(() -> (value) -> {})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NestedUntypedDelegateTarget_FlowsThroughConditionalSwitchAndBlock() {
        let result = Evaluate(`import System

func Accept(factory ()->Action[int32]) {
    factory()(2)
}

var seen = 0
let flag = true
Accept(() -> flag
    ? ((value) -> { seen = seen + value })
    : ((value) -> { seen = seen + 100 }))
Accept(() -> switch flag {
    case true: (value) -> { seen = seen + value }
    default: (value) -> { seen = seen + 100 }
})
Accept(() -> {
    let ignored = 1
    (value) -> { seen = seen + value }
})
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func NestedUntypedLambdaReturnShape_DisambiguatesOverloads() {
        let result = Evaluate(`import System

func Choose(factory ()->Action[int32]) int32 -> 1
func Choose(factory ()->Func[int32, int32]) int32 -> 2

Choose(() -> (value) -> {})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NestedUntypedLambdaExplicitReturnShape_DisambiguatesOverloadsRegardlessOfOrder() {
        let overloadOrders = []string{
            "func Choose(factory ()->Action[int32]) int32 -> 1\nfunc Choose(factory ()->Func[int32, int32]) int32 -> 2",
            "func Choose(factory ()->Func[int32, int32]) int32 -> 2\nfunc Choose(factory ()->Action[int32]) int32 -> 1"
        }
        for overloads in overloadOrders {
            for call in[]string{
                "Choose(() -> { return ((value) -> {}) })",
                "Choose(factory: () -> { return (((value) -> {})) })",
                "Choose(() -> { return true ? ((value) -> {}) : ((value) -> {}) })",
                `Choose(() -> {
    return switch true {
        case true: (value) -> {}
        default: (value) -> {}
    }
})`
            } {
                let result = Evaluate((`import System

` + "$overloads" + `

` + "$call"))
                Assert.Empty(result.Diagnostics)
                Assert.Equal(1, result.Value)
            }
        }
    }

    @Theory
    @InlineData("(value) -> {}")
    @InlineData("(value) -> { return }")
    @InlineData("(value) -> { let copy = value }")
    func UntypedNoValueBlock_DisambiguatesToVoidOverload(lambda string) {
        let result = Evaluate((`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose(` + "$lambda" + `)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Theory
    @InlineData("{ throw Exception(\"stop\") }")
    @InlineData("{ for { } }")
    @InlineData("{ while true { } }")
    @InlineData("{ do { } while true }")
    func NonCompletingBlock_IsCompatibleWithValueDelegate(body string) {
        let result = Evaluate((`import System

func Visit(action (int32)->int32) {}

func BindOnly() {
    Visit((value) -> ` + "$body" + `)
}

0`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Theory
    @InlineData("{ throw Exception(\"stop\") }")
    @InlineData("{ for { } }")
    @InlineData("{ while true { } }")
    @InlineData("{ do { } while true }")
    func NonCompletingBlock_DoesNotPreferVoidOverload(body string) {
        let result = Evaluate((`import System

func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> ` + "$body" + `)`))
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155"))
    }

    @Fact
    func NestedLoopBreak_DoesNotMakeOuterInfiniteLoopComplete() {
        let result = Evaluate(`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    for {
        for { break }
    }
})`)
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155"))
    }

    @Fact
    func InternalGoto_DoesNotMakeInfiniteLoopComplete() {
        let result = Evaluate(`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    for {
        goto repeat
        repeat: let copy = value
    }
})`)
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155"))
    }

    @Fact
    func OuterLoopBreak_StillMakesLambdaVoidOnly() {
        let result = Evaluate(`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    for { break }
})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NestedLabeledLoopBreak_DoesNotMakeOuterInfiniteLoopComplete() {
        let result = Evaluate(`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    for {
        inner: for { break inner }
    }
})`)
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
    }

    @Fact
    func LabeledBreakTargetingOuterLoop_MakesLambdaVoidOnly() {
        let result = Evaluate(`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    outer: for {
        for { break outer }
    }
})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Theory
    @InlineData("while true { break }")
    @InlineData("do { break } while true")
    func ConstantTrueLoopWithOwnedBreak_MakesLambdaVoidOnly(loop string) {
        let result = Evaluate((`func Choose(action (int32)->void) int32 -> 1
func Choose(action (int32)->int32) int32 -> 2

Choose((value) -> {
    ` + "$loop" + `
})`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func OverloadedConstructor_ContextuallyBindsUntypedLambda() {
        let result = Evaluate(`class Visitor {
    init(action (int32)->void) {}
    init(action (int32)->int32) {}
}

Visitor((value) -> {})
0`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func ConstructorNamedArguments_ContextuallyBindLambdaToAssociatedParameter() {
        let result = Evaluate(`class Visitor {
    init(transform (int32)->int32, action (string)->void) {
        action("ok")
    }
}

var seen = ""
Visitor(
    action: (text) -> { seen = text },
    transform: (value) -> value + 1)
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func NestedUntypedLambdaInExplicitReturn_DefersThroughWrappers() {
        let result = Evaluate(`import System

func Accept(factory ()->Action[int32]) {
    factory()(2)
}

var seen = 0
let flag = true
Accept(factory: () -> {
    return (((value) -> { seen = seen + value }))
})
Accept(() -> {
    return flag
        ? ((value) -> { seen = seen + value })
        : ((value) -> { seen = seen + 100 })
})
Accept(() -> {
    return switch flag {
        case true: (value) -> { seen = seen + value }
        default: (value) -> { seen = seen + 100 }
    }
})
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func NestedUntypedLambda_CoalesceOperandReceivesDelegateTarget() {
        let result = Evaluate(`import System

func Accept(factory ()->Action[int32]) {
    factory()(5)
}

var seen = 0
Accept(factory: () -> nil ?? ((value) -> { seen = value }))
seen`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func VoidTarget_RejectsExplicitValueReturnWithoutEmitterFailure() {
        let result = Evaluate(`func Visit(action ()->void) int32 {
    action()
    return 1
}

Visit(() -> { return 1 })`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0154")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
    }

    @Fact
    func VoidOverload_RejectsExplicitValueReturnAndSelectsValueOverload() {
        let result = Evaluate(`func Visit(action ()->void) int32 -> 1
func Visit(action ()->int32) int32 -> action() + 1

Visit(() -> { return 41 })`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func VoidTarget_StillDiscardsExpressionAndBlockTailValues() {
        let result = Evaluate(`func Visit(action ()->void) {
    action()
}

Visit(() -> 1)
Visit(() -> { 2 })
3`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func InvalidTypedLambdaBody_ReportsDiagnosticsOnceAcrossCallPaths() {
        let sources = []string{`func Visit(action (int32)->void) {
    action(0)
}

Visit((value int32) -> { nonexistentName })`, `class Visitor {
    func Visit(action (int32)->void) {
        action(0)
    }
}

Visitor().Visit((value int32) -> { nonexistentName })`, `class Visitor {
    init(action (int32)->void) {
        action(0)
    }
}

Visitor((value int32) -> { nonexistentName })`, `class Visitor {
    shared {
        func Visit(action (int32)->void) {
            action(0)
        }
    }
}

Visitor.Visit((value int32) -> { nonexistentName })`}
        for source in sources {
            let result = Evaluate(source)
            Assert.Equal(
                []string{"GS0125", "GS0154"},
                result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id).OrderBy((id string) -> id)
            )
        }
    }

    @Fact
    func ContextuallyReboundLambda_WarningIsReportedOnceAcrossCallPaths() {
        for source in LambdaDiagnosticOwnershipSources("called = called + 1\ns == nil") {
            let result = Evaluate(source)
            Assert.Equal([]string{"GS0523"}, result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id))
            Assert.Equal(1, result.Value)
        }
    }

    @Fact
    func ContextuallyReboundLambda_NonTrailingErrorAndWarningAreReportedOnceAcrossCallPaths() {
        for source in LambdaDiagnosticOwnershipSources("undefinedThing()\ns == nil") {
            let result = Evaluate(source)
            Assert.Equal(
                []string{"GS0130", "GS0523"},
                result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id).OrderBy((id string) -> id)
            )
        }
    }

    @Fact
    func ContextuallyReboundLambda_DuplicateParameterIsReportedOnce() {
        let result = Evaluate(`func Visit(action (int32, int32)->void) {}

Visit((value int32, value int32) -> 1)
0`)
        Assert.Equal([]string{"GS0101"}, result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id))
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func AsyncNoValueTarget_RejectsExplicitValueReturn(taskType string) {
        let result = Evaluate((`import System.Threading.Tasks

func Visit(action ()->` + "$taskType" + `) int32 -> 1

Visit(async () -> { return 1 })`))
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0154")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9999")
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func AsyncNoValueOverload_RejectsExplicitValueReturn(taskType string) {
        let result = Evaluate((`import System.Threading.Tasks

func Visit(action ()->` + "$taskType" + `) int32 -> 1
func Visit(action ()->Task[int32]) int32 -> 2

Visit(async () -> { return 1 })`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func AsyncValueTaskAndTaskOverloads_ContextuallyAcceptTargetlessLambda() {
        let result = Evaluate(`import System.Threading.Tasks

func Choose(action ()->Task[int32]) int32 -> 1
func Choose(action ()->ValueTask[int32]) int32 -> 2

Choose(async () -> { return 7 })`)
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155"))
    }

    @Theory
    @InlineData("Choose((async () -> { return 7 }))")
    @InlineData("Choose(action: ((async () -> { return 7 })))")
    func WrappedAsyncValueTaskAndTaskOverloads_ContextuallyAcceptTargetlessLambda(call string) {
        let result = Evaluate((`import System.Threading.Tasks

func Choose(action ()->Task[int32]) int32 -> 1
func Choose(action ()->ValueTask[int32]) int32 -> 2

` + "$call"))
        Assert.Equal(1, result.Diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0266"))
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0154" or "GS0155"))
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func AsyncNoValueTarget_AcceptsVoidBlock(taskType string) {
        let result = Evaluate((`import System.Threading.Tasks

func Visit(action ()->` + "$taskType" + `) int32 -> 7

Visit(async () -> {})`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ValueReturningBlockLambda_KeepsValueReturnType() {
        let result = Evaluate(`class Visitor {
    shared {
        func Visit(transform (int32)->int32) int32 {
            return transform(4)
        }
    }
}

Visitor.Visit((value int32) -> {
    if value < 0 {
        return 0
    }
    value + 1
})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func SourceStaticOverload_UsesValueReturnShape() {
        let result = Evaluate(`class Visitor {
    shared {
        func Visit(action (int32)->void) int32 {
            return 0
        }

        func Visit(action (int32)->bool) int32 {
            return action(4) ? 1 : -1
        }
    }
}

Visitor.Visit((value int32) -> {
    if value < 0 {
        return false
    }
    return value == 4
})`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func ExpressionTreeReturn_ContextuallyBindsUntypedLambda() {
        let result = Evaluate(`import System
import System.Linq.Expressions

func Make() Expression[Func[int32, int32]] {
    return (value) -> value + 1
}

0`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Theory
    @InlineData("Expression[Func[Func[int32, int32]]]", "() -> (value) -> value + 1")
    @InlineData("Expression[Func[int32, Func[int32, int32]]]", "(outer int32) -> (value) -> value + 1")
    func ExpressionTreeReturn_PropagatesNestedLambdaTarget(returnType string, lambda string) {
        let result = Evaluate((`import System
import System.Linq.Expressions

func Make() ` + "$returnType" + ` {
    return ` + "$lambda" + `
}

0`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    shared {
        private func LambdaDiagnosticOwnershipSources(body string) sequence[string] {
            let sources = []string{`func Visit(action ()->void) {
    action()
}

var called = 0
var s = []int32{1}
Visit(() -> {
    __BODY__
})
called`, `func Visit(action (int32)->void) {
    action(0)
}

var called = 0
var s = []int32{1}
Visit((ignored) -> {
    __BODY__
})
called`, `class Visitor {
    func Visit(action ()->void) {
        action()
    }
}

var called = 0
var s = []int32{1}
Visitor().Visit(() -> {
    __BODY__
})
called`, `class Visitor {
    init(action ()->void) {
        action()
    }
}

var called = 0
var s = []int32{1}
Visitor(() -> {
    __BODY__
})
called`, `class Visitor {
    shared {
        func Visit(action ()->void) {
            action()
        }
    }
}

var called = 0
var s = []int32{1}
Visitor.Visit(() -> {
    __BODY__
})
called`, `import System

func Accept(factory ()->Action) {
    factory()()
}

var called = 0
var s = []int32{1}
Accept(() -> () -> {
    __BODY__
})
called`}
            for source in sources {
                yield source.Replace("__BODY__", body)
            }
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source, []string{typeof(Issue3465InferenceTests).Assembly.Location})
        }
    }
}

class Issue3465ImportedIntCollection : IReadOnlyCollection[int32] {
    prop Count int32 -> Values.Length
    func GetEnumerator() IEnumerator[int32] -> (cast[IEnumerable[int32]](Values)).GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    shared {
        private let Values[]int32 = []int32{1, 2, 3}
    }
}

open class Issue3465ImportedGenericBase[T] {
    prop Value T {
        get;
        protected init;
    }
}

class Issue3465ImportedStringContainer : Issue3465ImportedGenericBase[string] {
    init() {
        Value = "base"
    }
}

class Issue3465ProjectedCollection[TMarker] : IReadOnlyCollection[string] {
    prop Count int32 -> Values.Length
    func GetEnumerator() IEnumerator[string] -> (cast[IEnumerable[string]](Values)).GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    shared {
        private let Values[]string = []string{"projected"}
    }
}

class Issue3465ProjectedBase[TMarker] : Issue3465ImportedGenericBase[string] {
    init() {
        Value = "projected-base"
    }
}

class Issue3465ConflictingCollectionForward : IReadOnlyCollection[int32], IReadOnlyCollection[string] {
    prop Count int32 -> 0
    private func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] -> (
        cast[IEnumerable[int32]](Array.Empty[int32]())
    ).GetEnumerator()

    private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] -> (
        cast[IEnumerable[string]](Array.Empty[string]())
    ).GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> (cast[IEnumerable[int32]](this)).GetEnumerator()
}

class Issue3465ConflictingCollectionReverse : IReadOnlyCollection[string], IReadOnlyCollection[int32] {
    prop Count int32 -> 0
    private func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] -> (
        cast[IEnumerable[int32]](Array.Empty[int32]())
    ).GetEnumerator()

    private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] -> (
        cast[IEnumerable[string]](Array.Empty[string]())
    ).GetEnumerator()

    private func (IEnumerable) GetEnumerator() IEnumerator -> (cast[IEnumerable[string]](this)).GetEnumerator()
}

class Issue3465ConflictingAsyncCollectionForward : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    private func (IAsyncEnumerable[int32]) GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[
        int32
    ] -> Issue3465EmptyAsyncEnumerator[int32]()

    private func (IAsyncEnumerable[string]) GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[
        string
    ] -> Issue3465EmptyAsyncEnumerator[string]()
}

class Issue3465ConflictingAsyncCollectionReverse : IAsyncEnumerable[string], IAsyncEnumerable[int32] {
    private func (IAsyncEnumerable[int32]) GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[
        int32
    ] -> Issue3465EmptyAsyncEnumerator[int32]()

    private func (IAsyncEnumerable[string]) GetAsyncEnumerator(cancellationToken CancellationToken) IAsyncEnumerator[
        string
    ] -> Issue3465EmptyAsyncEnumerator[string]()
}

class Issue3465EmptyAsyncEnumerator[T] : IAsyncEnumerator[T] {
    prop Current T -> default(T)
    func DisposeAsync() ValueTask -> ValueTask.CompletedTask

    func MoveNextAsync() ValueTask[bool] -> ValueTask.FromResult(false)
}
