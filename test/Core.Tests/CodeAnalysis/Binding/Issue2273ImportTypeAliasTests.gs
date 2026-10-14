// <copyright file="Issue2273ImportTypeAliasTests.cs" company="GSharp">
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
import Xunit

/// Issue #2273: `import R = Namespace.Type` (the analog of C#
/// `using R = Namespace.Type;`) must let a bare `R` resolve as the
/// aliased TYPE at use sites — static member access, type-clause position,
/// and nested-type access — for both a same-compilation SOURCE type declared
/// in another package (the conventional resx `using R = ...Properties.Resources;`
/// pattern) and an imported CLR type.
open class Issue2273ImportTypeAliasTests {
    @Fact
    func Alias_To_CrossPackage_Source_Type_Resolves_Static_Member_Access() {
        let holderTree = `
package App.Nested

class Holder {
    shared {
        const Message string = "hi"
    }
}
`
        let mainTree = `
package App

import R = App.Nested.Holder

var result = R.Message
`
        let result = Evaluate(holderTree, mainTree)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi", result.Value)
    }

    @Fact
    func Alias_To_Imported_Clr_Type_Resolves_Static_Member_Access() {
        let result = Evaluate(`
import R = System.Math

var result = R.Sqrt(16.0)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4.0, result.Value)
    }

    @Fact
    func Alias_To_Imported_Open_Generic_Type_Accepts_Type_Arguments() {
        let result = Evaluate(`
import L = System.Collections.Generic.List

let values = L[int32]()
values.Add(42)
var result = values[0]
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Alias_To_CrossPackage_Source_Type_Resolves_In_TypeClause_Position() {
        let holderTree = `
package App.Nested

class Holder {
    prop Value int32

    shared {
        func MakeOne() Holder {
            var h Holder = Holder{Value: 42}
            return h
        }
    }
}
`
        let mainTree = `
package App

import R = App.Nested.Holder

var h R = R.MakeOne()
var result = h.Value
`
        let result = Evaluate(holderTree, mainTree)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Alias_To_Outer_Type_Resolves_Nested_Type_Access() {
        let outerTree = `
package App.Nested

class Outer {
    class Inner {
        shared {
            const Message string = "nested-hi"
        }
    }
}
`
        let mainTree = `
package App

import R = App.Nested.Outer

var result = R.Inner.Message
`
        let result = Evaluate(outerTree, mainTree)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nested-hi", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Evaluate(sources ...string) EmittedOracleResult {
            return EmittedOracle.Evaluate(sources)
        }
    }
}
