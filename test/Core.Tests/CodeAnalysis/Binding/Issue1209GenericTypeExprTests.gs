// <copyright file="Issue1209GenericTypeExprTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #1209 — a generic-type reference with explicit type arguments used in
/// expression / member-access receiver position (`Box[int32].Default`,
/// `Comparer[int32].Default`) must bind as the constructed generic type,
/// not as element access on a variable (which previously produced
/// `GS0125 Variable 'Box' doesn't exist`). The disambiguation must NOT
/// regress genuine indexing (`arr[i]`, `dict[key]`), which still
/// binds as element access because the target resolves to a value.
open class Issue1209GenericTypeExprTests {
    @Fact
    func UserGenericStaticField_BindsAsConstructedType() {
        let source = `
class Box[T] {
  shared {
    let Default int32 = 0
  }
}

func F() int32 {
  return Box[int32].Default
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UserGenericStaticProperty_BindsAsConstructedType() {
        let source = `
class Box[T] {
  shared {
    prop Value int32 { get { return 11 } }
  }
}

func F() int32 {
  return Box[int32].Value
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UserGenericStaticMethod_BindsAsConstructedType() {
        let source = `
class Box[T] {
  shared {
    func Make() int32 { return 7 }
  }
}

func F() int32 {
  return Box[int32].Make()
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func BclGenericStaticMember_Comparer_BindsAsConstructedType() {
        let source = `
import System.Collections.Generic

func F() int32 {
  return Comparer[int32].Default.Compare(1, 2)
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedGenericSourceHomonym_InContainingScope_StaticReceiverWinsImportedType() {
        let source = `
import System.Collections.Generic

class Holder {
  class Comparer[T] {
    shared {
      func SourceValue() int32 { return 7 }
    }
  }

  shared {
    func Read() int32 {
      return Comparer[int32].SourceValue()
    }
  }
}

Holder.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NestedGenericSourceHomonym_OutsideContainingScope_StaticReceiverBindsImportedType() {
        let source = `
import System.Collections.Generic

class Holder {
  class Comparer[T] {
    shared {
      func SourceValue() int32 { return 7 }
    }
  }
}

Comparer[int32].Default.Compare(1, 2)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-1, result.Value)
    }

    @Fact
    func ArrayIndexing_StillBindsAsElementAccess() {
        let source = `
func F() int32 {
  var a = [3]int32{10, 20, 30}
  a[0] = 99
  return a[1]
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DictionaryIndexing_StillBindsAsElementAccess() {
        let source = `
import System.Collections.Generic

func F() int32 {
  var d = map[string,int32]{}
  d["a"] = 1
  return d["a"]
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func IndexingWithVariableSubscript_StillBindsAsElementAccess() {
        let source = `
func F() int32 {
  var a = [3]int32{10, 20, 30}
  var sum = 0
  for var i = 0; i < a.Length; i++ {
    sum = sum + a[i]
  }

  return sum
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UnknownGenericTypeReference_StillReportsDiagnostic() {
        // A name that is neither a value nor a known generic type must not be
        // silently accepted as a constructed generic receiver.
        let source = `
func F() int32 {
  return Nope[int32].Default
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
