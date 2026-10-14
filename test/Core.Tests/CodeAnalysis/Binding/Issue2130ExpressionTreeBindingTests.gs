// <copyright file="Issue2130ExpressionTreeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2130: binding diagnostics for expression-tree conversions.
open class Issue2130ExpressionTreeBindingTests {
    @Fact
    func StatementBodyLambda_IsRejectedForExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> { return x + 1 }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("statement body"))
    }

    @Fact
    func AsyncLambda_IsRejectedForExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions
import System.Threading.Tasks

let expr Expression[Func[int32, Task[int32]]] = async (x int32) -> x + 1
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("async lambda"))
    }

    @Fact
    func AssignmentInsideExpressionTree_IsRejected() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

var outer = 1
let expr Expression[Func[int32, int32]] = (x int32) -> outer = x
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("assignment"))
    }

    @Fact
    func StatementBearingGeneralBlockExpression_IsRejectedPrecisely() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> 2 * { let value = x + 1 value }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("block expression"))
    }

    @Fact
    func GeneralBlockExpressionWithoutPrefixStatements_IsRejectedPrecisely() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> ({ x + 1 })
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("block expression"))
    }

    @Fact
    func TupleLiteral_IsRejected() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32, (int32, int32)]] = (x int32) -> (x, x + 1)
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("tuple"))
    }

    @Fact
    func NonDelegateExpressionTreeTarget_IsRejected() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[int32] = (x int32) -> x
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0474")
    }

    @Fact
    func ConditionalOperator_IsAllowedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32, int32]] = (x int32) -> x > 0 ? x : -x
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func Indexers_AreAllowedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

class Repo(data [3]int32) {
    prop this[index int32] int32 -> this.data[index]
}

let expr Expression[Func[int32]] = () -> [3]int32{ 10, 20, 30 }[1] + Repo([3]int32{ 1, 2, 3 })[1]
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func ObjectConstructionAndInitializers_AreAllowedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

class Box {
    prop Width int32
    prop Height int32
    init() { }
}

let expr Expression[Func[int32]] = () -> Box() { Width = 40, Height = 2 }.Width
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func ArrayCreationAndTypeTests_AreAllowedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[object, int32]] = (value object) -> (value is string) ? [2]int32{ (value as string).Length, 40 }[0] : 0
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func NestedLambdaArguments_AreAllowedForDelegateAndExpressionParameters() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

class Helpers {
    shared {
        func UseDelegate(f (int32) -> int32, value int32) int32 {
            return f(value)
        }

        func UseExpression(f Expression[(int32) -> int32], value int32) int32 {
            let compiled = f.Compile()
            return compiled(value)
        }
    }
}

let expr Expression[Func[int32, int32]] = (x int32) -> Helpers.UseDelegate((y int32) -> y + 1, x) + Helpers.UseExpression((z int32) -> z + 1, 0)
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func CollectionInitializer_RemainsRejectedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions
import System.Collections.Generic

let expr Expression[Func[List[int32]]] = () -> List[int32]{ 1, 2, 3 }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    /// ADR-0160 / issue #3349: a REFERENCE-type null-assertion is pure static
    /// annotation — the CLR has no distinct `T?`, and
    /// `Expression.TypeAs(x, T).Type` is already `T` — so it erases
    /// cleanly and must be permitted. Banning it made a downcast unwritable
    /// inside an expression-tree lambda once `as T` started yielding
    /// `T?`: narrowing the result requires `!!` and no other spelling
    /// exists.
    @Fact
    func ReferenceTypeNullAssertion_IsAllowedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[object, int32]] = (value object) -> (value is string) ? (value as string)!!.Length : 0
`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    /// ADR-0160 / issue #3349: stripping a nullable VALUE type stays rejected —
    /// `T?` to `T` is a real CLR conversion (`Nullable<T>.Value`)
    /// with no System.Linq.Expressions counterpart that preserves G#'s
    /// throw-on-nil contract.
    @Fact
    func NullableValueTypeNullAssertion_RemainsRejectedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[int32?, int32]] = (value int32?) -> value!!
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0473")
    }

    @Fact
    func DelegateCombination_IsRejectedInsideExpressionTree() {
        let diagnostics = GetDiagnostics(`
import System
import System.Linq.Expressions

let expr Expression[Func[Action, Action, Action]] = (left Action, right Action) -> left + right
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Id == "GS0473" && d.Message.Contains("delegate combination operator")
        )
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result.Diagnostics
        }
    }
}
