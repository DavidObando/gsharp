// <copyright file="Issue1019StaticInterfacePropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0089 / issue #1019 — static-virtual interface *properties*. Pins the
/// binder behaviour for the `shared { prop … }` interface member shape:
/// the issue repro now binds, the implementer-satisfaction contract is
/// enforced (GS0397), default-bodied static interface properties are rejected
/// (GS0396), and genuine interface static *state* (`var` / `let`)
/// is still rejected (GS0330).
open class Issue1019StaticInterfacePropertyTests {
    @Fact
    func IssueRepro_BareStaticProperty_Binds() {
        // The exact #1019 repro must now parse and bind cleanly.
        let source = `
interface IData {
  shared {
    prop Name string;
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GetOnlyStaticProperty_Binds() {
        let source = `
sealed interface IData {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GetSetStaticProperty_Binds() {
        let source = `
sealed interface IData {
  shared {
    prop Tag int32 { get; set }
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Implementer_WithMatchingStaticProperty_NoDiagnostics() {
        let source = `
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { get { return "apple" } }
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Implementer_MissingStaticProperty_ReportsGS0397() {
        let source = `
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0397")
    }

    @Fact
    func Implementer_StaticPropertyMissingGetter_ReportsGS0397() {
        let source = `
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { set { } }
  }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0397")
    }

    @Fact
    func Interface_StaticInitProperty_ReportsGS0374() {
        let source = `
sealed interface IData {
  shared {
    prop Tag int32 { get; init; }
  }
}
`
        let diagnostic = Assert.Single(Evaluate(source).Diagnostics)
        Assert.Equal("GS0374", diagnostic.Id)
    }

    @Fact
    func ConstructedGenericInterface_MatchingStaticProperty_EmitsAndLoads() {
        let source = `
sealed interface IData[T] {
  shared {
    prop Tag T { get; }
  }
}

struct AppleData : IData[int32] {
  shared {
    prop Tag int32 -> 1
  }
}
`
        AssertEmitsAndLoads(source)
    }

    @Fact
    func DefaultBodiedStaticInterfaceProperty_Binds() {
        // Issue #1030: default-bodied (with accessor bodies) static-virtual
        // interface properties are now supported — they emit non-abstract
        // Static|Virtual accessor slots with bodies. The implementer is not
        // required to provide them.
        let source = `
sealed interface IData {
  shared {
    prop Name string { get { return "x" } }
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericReadThroughConstraint_Binds() {
        let source = `
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { get { return "apple" } }
  }
}

func Describe[T IData](witness T) string {
  return T.Name
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceStaticState_Var_Binds() {
        // Issue #1030: genuine interface static *state* (storage) is now
        // supported — a `var` field in an interface shared block emits a real
        // CLR static field on the interface TypeDef.
        let source = `
sealed interface IData {
  shared {
    var Count int32
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceStaticState_Let_Binds() {
        let source = `
sealed interface IData {
  shared {
    let Count int32 = 0
  }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func AssertEmitsAndLoads(source string) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            let _ = EmittedFixture.Load(peStream.ToArray()).GetTypes()
        }
    }
}
