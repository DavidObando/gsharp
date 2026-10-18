// <copyright file="Issue4989AssignmentNarrowingJoinTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4989: a nullable variable declared at an interface and assigned a
/// different implementation on each incoming path is read, after the paths
/// merge, at the declared interface. ADR-0069's assignment narrowing proves
/// only that the value is not nil; it never narrows to the type of the
/// assigned value, and every join keeps a narrowing only when every incoming
/// path proves the same one. Each row assigns `MacStore` on one path and
/// `LinuxStore` on another, and is checked three ways: the bound receiver
/// is the interface, a `MacStore`-only member is a compile error, and the
/// program runs the `LinuxStore` implementation the input selects.
open class Issue4989AssignmentNarrowingJoinTests {
    @Theory
    @MemberData("MergeKinds")
    func JoinedVariable_IsBoundAtTheDeclaredInterface(kind string, body string) {
        let receiverType = BoundReceiverTypeOfLastCall(Program(body, "Name"), "Name")
        Assert.True(receiverType is InterfaceSymbol, "$kind: receiver bound at ${receiverType}")
        Assert.Equal("IStore", receiverType.Name)
    }

    @Theory
    @MemberData("MergeKinds")
    func JoinedVariable_ConcreteOnlyMember_IsAnError(kind string, body string) {
        let result = EmittedOracle.Evaluate(Program(body, "MacOnly") + Entry)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0159", diagnostic.Id)
        Assert.Contains("MacOnly", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @MemberData("MergeKinds")
    func JoinedVariable_DispatchesToTheAssignedImplementation(kind string, body string) {
        // The input selects LinuxStore; a receiver narrowed to MacStore would
        // be an invalid cast here.
        let result = EmittedOracle.Evaluate(Program(body, "Name") + Entry)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("linux" + Environment.NewLine, result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func Assignment_NarrowsToTheDeclaredInterface() {
        // Positive: one straight-line assignment proves the variable non-nil,
        // so its interface members need no `!!`.
        let body = `    var a IStore? = nil
    a = MacStore()
    return a.Name() + a.MEMBER()`
        let receiverType = BoundReceiverTypeOfLastCall(Program(body, "Name"), "Name")
        Assert.True(receiverType is InterfaceSymbol, "receiver bound at ${receiverType}")
        Assert.Equal("IStore", receiverType.Name)
        let result = EmittedOracle.Evaluate(Program(body, "Name") + Entry)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("macmac" + Environment.NewLine, result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func Assignment_DoesNotNarrowToTheAssignedClass() {
        // The non-nil proof says nothing about which implementation was
        // assigned, so a MacStore-only member is not reachable.
        let body = `    var a IStore? = nil
    a = MacStore()
    return a.MEMBER()`
        let result = EmittedOracle.Evaluate(Program(body, "MacOnly") + Entry)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0159", diagnostic.Id)
    }

    shared {
        private const Prelude string = `import System

interface IStore {
    func Name() string;
}

class MacStore : IStore {
    func Name() string -> "mac"
    func MacOnly() string -> "mac-only"
}

class LinuxStore : IStore {
    func Name() string -> "linux"
}

`

        private const Entry string = `
Console.WriteLine(Run(1))
`

        prop MergeKinds TheoryData[string, string] -> {
            let values = TheoryData[string, string]()
            values.Add("IfElseIfChain", `    var store IStore? = nil
    if k == 0 {
        store = MacStore()
    } else if k == 1 {
        store = LinuxStore()
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("IfElseBothBranches", `    var store IStore? = nil
    if k == 0 {
        store = MacStore()
    } else {
        store = LinuxStore()
    }
    return store.MEMBER()`)
            values.Add("SwitchStatementArms", `    var store IStore? = nil
    switch k {
        case 0 {
            store = MacStore()
        }
        default {
            store = LinuxStore()
        }
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("SwitchExpressionArms", `    var store IStore? = nil
    store = switch k {
        case 0: MacStore()
        default: LinuxStore()
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("LoopBackEdge", `    var store IStore? = MacStore()
    for var i = 0; i < k; i++ {
        store = LinuxStore()
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("LoopBreak", `    var store IStore? = nil
    for {
        store = MacStore()
        if k == 1 {
            store = LinuxStore()
            break
        }
        break
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("LoopContinue", `    var store IStore? = nil
    for var i = 0; i < 2; i++ {
        if i == 0 {
            store = MacStore()
            continue
        }
        if k == 1 {
            store = LinuxStore()
        }
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("TryCatch", `    var store IStore? = nil
    try {
        store = MacStore()
        if k == 1 {
            throw Exception("linux")
        }
    } catch (Exception) {
        store = LinuxStore()
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("TryFinally", `    var store IStore? = nil
    try {
        store = MacStore()
    } finally {
        if k == 1 {
            store = LinuxStore()
        }
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("NullCoalescing", `    let mac IStore? = if k == 0 {
        MacStore()
    } else {
        nil
    }
    let store IStore? = mac ?? LinuxStore()
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("TernaryBranches", `    var store IStore? = nil
    store = k == 0 ? MacStore() : LinuxStore()
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("IfExpressionBranches", `    var store IStore? = nil
    store = if k == 0 {
        MacStore()
    } else {
        LinuxStore()
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("EarlyReturn", `    var store IStore? = nil
    if k == 0 {
        store = MacStore()
    } else if k == 1 {
        store = LinuxStore()
        if k == 2 {
            return ""
        }
    }
    guard let s = store else {
        return ""
    }
    return s.MEMBER()`)
            values.Add("GotoLabel", `    var store IStore? = nil
    if k == 1 {
        store = LinuxStore()
        goto Done
    }
    store = MacStore()
Done:
    return store.MEMBER()`)
            values.Add("IfLetBinding", `    var store IStore? = nil
    if k == 0 {
        store = MacStore()
    } else if k == 1 {
        store = LinuxStore()
    }
    if let s = store {
        return s.MEMBER()
    }
    return ""`)
            values.Add("WhileLetBinding", `    var store IStore? = nil
    if k == 0 {
        store = MacStore()
    } else if k == 1 {
        store = LinuxStore()
    }
    while let s = store {
        return s.MEMBER()
    }
    return ""`)
            values.Add("PatternBinding", `    let picked object = if k == 0 {
        MacStore()
    } else {
        LinuxStore()
    }
    if picked is IStore s {
        return s.MEMBER()
    }
    return ""`)
            values.Add("IsTestOr", `    var store IStore = LinuxStore()
    if k == 0 {
        store = MacStore()
    }
    if store is MacStore || store is LinuxStore {
        return store.MEMBER()
    }
    return ""`)
            values.Add("IsTestAndEarlyExit", `    var store IStore = LinuxStore()
    if k == 0 {
        store = MacStore()
    }
    if store !is MacStore && store !is LinuxStore {
        return ""
    }
    return store.MEMBER()`)
            values
        }

        private func Program(body string, member string) string -> Prelude +
            "func Run(k int32) string {\n" +
            body.Replace("MEMBER", member) + "\n}\n"

        /// Binds [`source`](paramref) and returns the bound receiver type of
        /// the last `receiver.member()` call in it.
        private func BoundReceiverTypeOfLastCall(source string, member string) TypeSymbol {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue4989.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.BoundProgram.Diagnostics.Where((d Diagnostic) -> d.IsError))
            let call = Descendants(tree.Root).OfType[AccessorExpressionSyntax]().Last(
                (a AccessorExpressionSyntax) -> a.RightPart is CallExpressionSyntax c && c.Identifier.Text == member
            )
            let bound = compilation.GetSemanticModel(tree).GetBoundNode(call)
            let instanceCall = Assert.IsType[BoundUserInstanceCallExpression](bound)
            var receiver = instanceCall.Receiver
            while receiver is BoundConversionExpression conversion {
                receiver = conversion.Expression
            }
            return receiver.Type
        }

        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}
