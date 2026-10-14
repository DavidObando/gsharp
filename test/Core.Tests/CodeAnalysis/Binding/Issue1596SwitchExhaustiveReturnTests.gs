// <copyright file="Issue1596SwitchExhaustiveReturnTests.cs" company="GSharp">
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

/// Issue #1596. gsc's definite-return analysis (the `AllPathsReturn`
/// check that powers GS0100, "Not all code paths return a value") used to
/// treat every `switch` statement as possibly falling through, even
/// when a `default` clause was present and every arm definitely
/// returned or threw. That wrongly rejected value-returning functions whose
/// body was an exhaustive switch, while the equivalent if/else compiled
/// fine. A switch WITHOUT a `default` arm must still be treated as
/// possibly-falling-through.
open class Issue1596SwitchExhaustiveReturnTests {
    @Fact
    func SwitchWithDefaultOnly_DoesNotReport_AllPathsMustReturn() {
        const Source = `func I(value object) object {
    switch value {
        default {
            return "d"
        }
    }
}
`
        AssertNoGs0100(Source)
    }

    @Fact
    func SwitchWithDefaultAndCase_DoesNotReport_AllPathsMustReturn() {
        const Source = `func F(value object) object {
    switch value {
        default {
            return "d"
        }
        case val is bool {
            return "b"
        }
    }
}
`
        AssertNoGs0100(Source)
    }

    @Fact
    func SwitchWithCaseThenDefault_DoesNotReport_AllPathsMustReturn() {
        const Source = `func G(value object) object {
    switch value {
        case val is bool {
            return "b"
        }
        default {
            return "d"
        }
    }
}
`
        AssertNoGs0100(Source)
    }

    @Fact
    func SwitchWithThrowingArm_DoesNotReport_AllPathsMustReturn() {
        const Source = `package Issue1596.Throw

import System

func T(value object) object {
    switch value {
        case val is bool {
            throw InvalidOperationException("no")
        }
        default {
            return "d"
        }
    }
}
`
        AssertNoGs0100(Source)
    }

    @Fact
    func SwitchWithoutDefault_StillReports_AllPathsMustReturn() {
        const Source = `func N(value object) object {
    switch value {
        case val is bool {
            return "b"
        }
    }
}
`
        let diagnostics = Compile(Source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0100")
    }

    shared {
        private func Compile(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let emitResult = compilation.Emit(peStream)
            return emitResult.Diagnostics
        }

        private func AssertNoGs0100(source string) {
            let diagnostics = Compile(source)
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0100")
        }
    }
}
