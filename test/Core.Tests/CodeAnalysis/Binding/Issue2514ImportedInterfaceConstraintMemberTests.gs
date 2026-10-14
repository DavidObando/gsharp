// <copyright file="Issue2514ImportedInterfaceConstraintMemberTests.cs" company="GSharp">
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

/// Binder coverage for imported interface constraint member lookup.
class Issue2514ImportedInterfaceConstraintMemberTests {
    @Fact
    func InheritedPropertyMethodAndIndexer_BindWithGenericSubstitution() {
        const source = `import System.Collections.Generic

func ReadCount[T IList[string]](value T) int32 -> value.Count
func Read[T IList[string]](value T, index int32) string -> value[index]
func Write[T IList[string]](value T, index int32, text string) {
    value[index] = text
}
func Find[T IList[string]](value T, text string) int32 -> value.IndexOf(text)`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ConstructorFlag_CombinesWithImportedInterfaceConstraint() {
        const source = `import System

func Compare[T IComparable[T] init()](value T) int32 -> value.CompareTo(value)`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func SourceInterfaceConstraint_ControlRemainsGreen() {
        const source = `interface ISource {
    prop Name string { get; set; }
}

func Use[T ISource](value T) string {
    value.Name = "ok"
    return value.Name
}`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func UnknownImportedConstraintMember_StillReportsGS0158() {
        const source = `import System.Collections.Generic

func Bad[T IList[string]](value T) int32 -> value.Missing`
        Assert.Contains(Bind(source), (diagnostic Diagnostic) -> diagnostic.Id == "GS0158")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            return EmittedOracle.Evaluate(source).Diagnostics.ToList()
        }
    }
}
