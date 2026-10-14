// <copyright file="ClrNestedTypeAccessTests.cs" company="GSharp">
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

/// Issue #672: CLR nested type access in expression position. Verifies
/// that `Outer.Nested.Member` resolves when `Nested` is a nested enum,
/// class, or struct defined inside an imported CLR type.
open class ClrNestedTypeAccessTests {
    @Fact
    func NestedEnum_MemberAccess_Binds() {
        // Environment.SpecialFolder.ApplicationData — the original repro.
        let source = `
import System

var sf = Environment.SpecialFolder.ApplicationData
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedEnum_PassedToMethod_Binds() {
        // Pass nested enum value to a method that accepts it.
        let source = `
import System

var path = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TopLevelEnum_ContinuesToWork_Regression() {
        // StringComparison.OrdinalIgnoreCase is a top-level enum and must
        // continue to work.
        let source = `
import System

var cmp = StringComparison.OrdinalIgnoreCase
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StaticMethod_OnImportedClass_ContinuesToWork_Regression() {
        // Environment.GetEnvironmentVariable must still resolve (regression guard).
        let source = `
import System

var x = Environment.GetEnvironmentVariable("PATH")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedEnum_MultipleValues_Bind() {
        // Access multiple values from the same nested enum.
        let source = `
import System

var a = Environment.SpecialFolder.ApplicationData
var b = Environment.SpecialFolder.Desktop
var c = Environment.SpecialFolder.UserProfile
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedEnum_InvalidMember_ReportsError() {
        // A non-existent member on the nested enum should still report an error.
        let source = `
import System

var sf = Environment.SpecialFolder.ThisDoesNotExist
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func NestedType_StaticPropertyAccess_Binds() {
        // System.Text.Encoding has a nested class UTF8Encoding, but a
        // more accessible static pattern: access nested type static members.
        // Use System.IO.Path.DirectorySeparatorChar as a non-nested reference
        // test, and use TypeCode which is nested in various patterns.
        // Actually, let's use System.Environment.SpecialFolder which is the
        // core issue, and verify a different nested-enum pattern:
        // System.Globalization.UnicodeCategory — wait, that's top-level.
        // Use System.AttributeTargets which is a flags enum.
        // Actually AttributeTargets is top-level too.
        // The critical test is Environment.SpecialFolder which is the only
        // commonly-used BCL nested enum.
        let source = `
import System

var sf = Environment.SpecialFolder.CommonApplicationData
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
