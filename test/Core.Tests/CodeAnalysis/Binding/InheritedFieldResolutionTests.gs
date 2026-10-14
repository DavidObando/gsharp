// <copyright file="InheritedFieldResolutionTests.cs" company="GSharp">
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

/// ADR-0112 A7: focused coverage for inherited-field resolution in the binder
/// sites routed through (cref:TypeMemberModel.TryGetFieldIncludingInherited).
/// Each method uses unique type names because FunctionTypeSymbol.Cache aliases by
/// type-name string across in-process compilations.
open class InheritedFieldResolutionTests {
    @Fact
    func PropertyPattern_MatchesInheritedField() {
        // PatternBinder: property pattern resolves a field declared on a base type.
        let source = `
open class InhPatBase { var PatField int32 }
class InhPatDerived : InhPatBase {}
let d = InhPatDerived{PatField: 5}
let r = switch d { case { PatField: 5 }: 1 default: 0 }
r
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func NamedDeconstruction_BindsInheritedField() {
        // StatementBinder: `let { Field = local } = expr` resolves an inherited field.
        let source = `
open data class InhDecBase { var DecField int32 }
data class InhDecDerived : InhDecBase { var Own int32 }
let d = InhDecDerived{DecField: 9, Own: 0}
let { DecField = a } = d
a
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
