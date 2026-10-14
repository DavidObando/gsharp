// <copyright file="Issue693DictionaryConstructionBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Issue #693 (follow-up to #690): direct binder regression coverage for
/// `Dictionary[K, V]()` construction calls — the case PR #690 worked
/// around via `KeyValuePair[K, V](k, v)` because of a (since-resolved)
/// belief that the parser would treat `Dictionary[K, V]` as a map
/// literal. The companion `Issue693MultiTypeArgGenericCallParserTests`
/// proves the parser commits cleanly to a generic call site; these tests
/// prove the binder accepts the resulting shape with both primitive and
/// G# user-defined type arguments.
open class Issue693DictionaryConstructionBindingTests {
    @Fact
    func DictionaryStringInt32_DefaultConstructor_Binds() {
        let source = `import System.Collections.Generic

var d = Dictionary[string, int32]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryStringInt32_AsExpressionStatement_Binds() {
        let source = `import System.Collections.Generic

Dictionary[string, int32]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryStringUserClass_DefaultConstructor_Binds() {
        // Direct binder coverage for the case that PR #690 worked around
        // with KeyValuePair[string, MyGs].
        let source = `package App
import System.Collections.Generic

class MyGs {
    var Name string = ""
}

let d = Dictionary[string, MyGs]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryUserClassToUserClass_DefaultConstructor_Binds() {
        // Both type arguments are user-defined G# classes — the most
        // demanding case for the symbolic-container path added in #690.
        let source = `package App
import System.Collections.Generic

class K {
    var N int32 = 0
}

class V {
    var N int32 = 0
}

let d = Dictionary[K, V]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SortedDictionaryStringInt32_DefaultConstructor_Binds() {
        let source = `import System.Collections.Generic

var d = SortedDictionary[string, int32]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ConcurrentDictionaryStringInt32_DefaultConstructor_Binds() {
        let source = `import System.Collections.Concurrent

var d = ConcurrentDictionary[string, int32]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryWithNestedListValue_DefaultConstructor_Binds() {
        // Dictionary[string, List[int32]]() — nested generic in the value
        // position exercises the recursive type-clause scan inside the
        // multi-type-arg disambiguation.
        let source = `import System.Collections.Generic

var d = Dictionary[string, List[int32]]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DictionaryWithNestedDictionaryValue_DefaultConstructor_Binds() {
        // Dictionary[string, Dictionary[string, int32]]() — two-type-arg
        // generic nested inside a two-type-arg generic.
        let source = `import System.Collections.Generic

var d = Dictionary[string, Dictionary[string, int32]]()`
        Assert.Empty(Bind(source))
    }

    @Fact
    func QualifiedDictionaryStringInt32_DefaultConstructor_Binds() {
        let source = "var d = System.Collections.Generic.Dictionary[string, int32]()"
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
