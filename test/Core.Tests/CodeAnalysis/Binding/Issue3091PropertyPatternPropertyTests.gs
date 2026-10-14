// <copyright file="Issue3091PropertyPatternPropertyTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #3091: Emitted-oracle coverage for property pattern property.
class Issue3091PropertyPatternPropertyTests {
    @Fact
    func ReadableProperties_BindAcrossUserAndImportedInheritance() {
        const Source = `import System.Collections.Generic

open class BaseMessage {
    prop Role string { get -> "tool" }
}

class Message : BaseMessage {
    prop Calls IReadOnlyList[string]? { get; init; }
}

func Classify(message Message) int32 {
    return switch message {
        case { Role: "tool" }: 1
        case { Calls: { Count: > 0 } }: 2
        default: 0
    }
}`
        Assert.Empty(Bind(Source))
    }

    @Fact
    func StaticWriteOnlyAndIndexerProperties_AreNotPatternMembers() {
        const Source = `class StaticOnly {
    shared {
        prop Value int32 { get -> 1 }
    }
}

class WriteOnly {
    prop Value int32 { set { } }
}

class Indexed {
    prop this[i int32] int32 { get -> i }
}

let staticOnly = StaticOnly{}
let writeOnly = WriteOnly{}
let indexed = Indexed{}
let a = switch staticOnly { case { Value: _ }: 1 default: 0 }
let b = switch writeOnly { case { Value: _ }: 1 default: 0 }
let c = switch indexed { case { Item: _ }: 1 default: 0 }`
        let diagnostics = Bind(Source)
        Assert.True(
            diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0173") == 3,
            string.Join(Environment.NewLine, diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString()))
        )
    }

    @Fact
    func ComputedProperty_IsEvaluatedOnceForCompoundSubpattern() {
        AssertEvaluates(`class Probe {
    var Reads int32
    prop Value int32 {
        get {
            this.Reads += 1
            return 5
        }
    }
}

let probe = Probe{}
let result = switch probe {
    case { Value: > 0 and < 10 }: 10
    default: 0
}
result + probe.Reads`, 11)
    }

    @Fact
    func DiscardSubpattern_StillEvaluatesGetterOnce() {
        AssertEvaluates(`class Probe {
    var Reads int32
    prop Value int32 {
        get {
            this.Reads += 1
            return 5
        }
    }
}

let probe = Probe{}
let result = switch probe {
    case { Value: _ }: 10
    default: 0
}
result + probe.Reads`, 11)
    }

    @Fact
    func NullNestedProperty_ShortCircuitsBeforeGetter() {
        AssertEvaluates(`class Counter {
    shared {
        var Reads int32
    }
}

class Child {
    prop Count int32 {
        get {
            Counter.Reads += 1
            return 1
        }
    }
}

class Holder {
    prop Child Child? { get; init; }
}

let holder = Holder{Child: nil}
let result = switch holder {
    case { Child: { Count: > 0 } }: 1
    default: 0
}
result + Counter.Reads`, 0)
    }

    @Fact
    func ImportedInheritedProperty_EvaluatesThroughNullableUserProperty() {
        AssertEvaluates(`import System.Collections.Generic

class Message {
    prop Calls IReadOnlyList[string]? { get; init; }
}

func Match(message Message) int32 {
    return switch message {
        case { Calls: { Count: > 0 } }: 1
        default: 0
    }
}

let calls = List[string]()
calls.Add("invoke")
let present = Match(Message{Calls: calls})
let missing = Match(Message{Calls: nil})
present * 10 + missing`, 10)
    }

    @Fact
    func NullableValueProperty_UnwrapsBeforeNestedPattern() {
        AssertEvaluates(`struct Payload {
    prop Count int32 { get -> 2 }
}

class Holder {
    prop Item Payload? { get; init; }
}

func Match(holder Holder) int32 {
    return switch holder {
        case { Item: { Count: 2 } }: 1
        default: 0
    }
}

let present = Match(Holder{Item: Payload{}})
let missing = Match(Holder{Item: nil})
present * 10 + missing`, 10)
    }

    shared {
        private func AssertEvaluates(source string, expected object) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            Assert.Equal(expected, result.Value)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope).Diagnostics.ToImmutableArray()
        }
    }
}
