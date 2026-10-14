// <copyright file="Issue1103ExtensionInstanceCallTests.cs" company="GSharp">
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

/// Issue #1103. A receiver-clause extension (ADR-0019) on an imported/BCL or
/// primitive CLR type must bind with instance/member syntax
/// (`receiver.Ext()`) and not only as a free function
/// (`Ext(receiver)`).
///
/// Two defects produced `GS0159 Cannot find function` on the member-syntax
/// form: (1) the body-binding pass rebuilt its lookup scope from the previous
/// global scope without re-registering the flattened extension functions as
/// extensions, so (cref:BoundScope.TryLookupExtensionFunction) found
/// nothing inside any function/method body; and (2) the receiver match compared
/// the declared and call-site receiver type symbols by reference, which fails
/// for imported CLR types whose symbols are distinct instances wrapping the same
/// CLR type. The match is now structural (CLR-type identity) with reference
/// equality kept as the fast path for interned user types.
open class Issue1103ExtensionInstanceCallTests {
    @Fact
    func PrimitiveExtension_InstanceSyntax_InsideFunctionBody_Binds() {
        const source = `
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return x.Doubled()
}

run(21)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PrimitiveExtension_InstanceSyntax_InsideClassMethod_Binds() {
        const source = `
package P

func (n int32) Doubled() int32 {
    return n * 2
}

class Calc {
    func Run(x int32) int32 {
        return x.Doubled()
    }
}

var c = Calc()
c.Run(21)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PrimitiveExtension_InstanceSyntax_AtTopLevel_Binds() {
        const source = `
package P

func (n int32) Doubled() int32 {
    return n * 2
}

var x int32 = 21
x.Doubled()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Extension_FreeCallForm_InsideFunctionBody_Control_StillBinds() {
        // Control: the free-call form always bound; it must keep working.
        const source = `
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return Doubled(x)
}

run(21)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PrimitiveExtension_InstanceSyntax_InsideFunctionBody_NoGS0159() {
        const source = `
package P

func (n int32) Doubled() int32 {
    return n * 2
}

func run(x int32) int32 {
    return x.Doubled()
}

run(5)
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find function"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
