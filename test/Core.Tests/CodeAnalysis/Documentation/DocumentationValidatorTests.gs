// <copyright file="DocumentationValidatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System.IO
import Xunit

/// Tests the post-binding documentation validation pass and its emit wiring.
open class DocumentationValidatorTests {
    @Fact
    func FloatingDocComment_ProducesGS0227() {
        let result = Compile(`package Lib

/// Floating.

func Foo() {}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0227")
    }

    @Fact
    func ParamMismatch_ProducesGS0229() {
        let result = Compile(`package Lib

/// Adds one number.
/// @param b wrong parameter
func Add(a int32) int32 {
    return a
}`)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0229" && d.Message.Contains("'b'") && d.Message.Contains("'Add'")
        )
    }

    @Fact
    func ValidParamNames_DoNotProduceGS0229() {
        let result = Compile(`package Lib

/// Adds one number.
/// @param a value
func Add(a int32) int32 {
    return a
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0229")
    }

    @Fact
    func MissingDocs_WhenOptedIn_ProduceGS0228() {
        let result = Compile(`package Lib

func Foo() {}`, warnOnMissingDocs: true)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0228" && d.Message.Contains("'Foo'"))
    }

    @Fact
    func UnknownDocTag_ProducesGS0231() {
        let result = Compile(`package Lib

/// Gets a value.
/// @return the value
func Get() int32 {
    return 0
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0231" && d.Message.Contains("'@return'"))
    }

    @Fact
    func KnownDocTag_DoesNotProduceGS0231() {
        let result = Compile(`package Lib

/// Gets a value.
/// @returns the value
func Get() int32 {
    return 0
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0231")
    }

    @Fact
    func DocCommentOnDeinit_DoesNotProduceGS0227() {
        let result = Compile(`package Lib

class Widget {
    /// Finalizes an instance of the Widget class.
    deinit {
    }
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0227")
    }

    shared {
        private func Compile(source string, warnOnMissingDocs bool = false) EmitResult {
            let tree = SyntaxTree.Parse(source)
            let compilation = Compilation(tree){WarnOnMissingDocumentation = warnOnMissingDocs}
            using let peStream = MemoryStream()
            return compilation.Emit(peStream)
        }
    }
}
