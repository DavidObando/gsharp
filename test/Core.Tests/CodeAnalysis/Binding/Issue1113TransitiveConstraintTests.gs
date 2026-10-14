// <copyright file="Issue1113TransitiveConstraintTests.cs" company="GSharp">
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

/// Issue #1113: a generic interface constraint (`[T IFace]`) is satisfied
/// when the type argument implements the interface ANYWHERE in its hierarchy —
/// directly, through a base class, or via a transitively-inherited base
/// interface (mirrors C#'s `where T : IFace`). The former check only
/// considered interfaces directly declared on the type argument, wrongly
/// reporting GS0152 for a class inheriting the interface through its base class.
/// A genuinely non-implementing type argument must still report GS0152.
open class Issue1113TransitiveConstraintTests {
    @Fact
    func InterfaceInheritedFromBaseClass_SatisfiesConstraint_NoGS0152() {
        let source = `
interface IBox {
    func F() int32;
}

open class Box : IBox {
    func F() int32 { return 1 }
}

class FreeBox : Box {
}

func Use[T IBox](x T) int32 { return x.F() }
Use(FreeBox())
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func InterfaceInheritedFromGrandparent_SatisfiesConstraint_NoGS0152() {
        let source = `
interface IBox {
    func F() int32;
}

open class Box : IBox {
    func F() int32 { return 1 }
}

open class MidBox : Box {
}

class LeafBox : MidBox {
}

func Use[T IBox](x T) int32 { return x.F() }
Use(LeafBox())
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    @Fact
    func NonImplementingTypeArgument_StillReportsGS0152() {
        // Negative control: a class that does not implement the interface
        // anywhere in its hierarchy must still be rejected.
        let source = `
interface IBox {
    func F() int32;
}

class NotABox {
}

func Use[T IBox](x T) int32 { return 0 }
Use[NotABox](NotABox())
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0152")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
