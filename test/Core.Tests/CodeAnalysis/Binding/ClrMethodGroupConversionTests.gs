// <copyright file="ClrMethodGroupConversionTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #337: converting a CLR member method group (static or instance) to a
/// delegate value, with overload selection driven by the target delegate
/// signature.
open class ClrMethodGroupConversionTests {
    @Fact
    func StaticMethodGroup_ToFunc_SelectsOverloadAndInvokes() {
        // Int32.Parse(string) is selected by the Func[string, int32] target.
        let result = Evaluate(`
import System

var parse Func[string, int32] = Int32.Parse
parse.Invoke("41")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(41, result.Value)
    }

    @Fact
    func StaticMethodGroup_ToAction_SelectsVoidOverload() {
        // Console.WriteLine has many overloads; the Action[string] target picks
        // WriteLine(string). The resulting value is a real System.Action<string>.
        let result = Evaluate(`
import System

var write Action[string] = Console.WriteLine
write
`)
        Assert.Empty(result.Diagnostics)
        Assert.IsType[(string) -> void](result.Value)
    }

    @Fact
    func InstanceMethodGroup_ToFunc_CapturesReceiver() {
        // sb.Append(string) is selected; the receiver `sb` is captured as the
        // delegate target, so invoking the delegate mutates that instance.
        let result = Evaluate(`
import System.Text

var sb = StringBuilder()
var append Func[string, StringBuilder] = sb.Append
append.Invoke("ab")
append.Invoke("cd")
sb.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("abcd", result.Value)
    }

    @Fact
    func MethodGroup_ToNonDelegateType_ReportsRequiresTargetDiagnostic() {
        // A method group in an ordinary value slot has no delegate target.
        let result = Evaluate(`
import System

var x int32 = Console.WriteLine
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0582")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
