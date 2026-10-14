// <copyright file="ObjectInitializerBinderTests.cs" company="GSharp">
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

/// Issue #522: binder tests for the C#-style object-initializer suffix.
/// Confirms that:
/// * Initializers against a user-defined class assign the named fields.
/// * Initializers against a writable property succeed.
/// * Initializers against an unknown member surface a precise diagnostic.
/// * Initializers against a non-writable member surface a precise
/// diagnostic.
open class ObjectInitializerBinderTests {
    @Fact
    func Binds_AgainstUserDefinedClassFields() {
        let source = `
class Box {
    var Width int32
    var Height int32
    init() { }
}

var b = Box() { Width = 3, Height = 4 }
b.Width + b.Height
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Binds_AgainstUserDefinedClassProperty() {
        let source = `
class Box {
    prop Width int32
    prop Height int32
    init() { }
}

var b = Box() { Width = 5, Height = 6 }
b.Width + b.Height
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func Binds_EmptyInitializerListYieldsConstructedInstance() {
        let source = `
class Box {
    var Width int32
    init() { }
}

var b = Box() { }
b.Width
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func Diagnoses_UnknownMemberName() {
        let source = `
class Box {
    var Width int32
    init() { }
}

var b = Box() { Unknown = 1 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Unknown"))
    }

    @Fact
    func Diagnoses_DuplicatePropertyName() {
        let source = `
class Box {
    var Width int32
    init() { }
}

var b = Box() { Width = 1, Width = 2 }
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Diagnoses_NonWritableProperty() {
        let source = `
class Box {
    prop Width int32 { get }
    init() { }
}

var b = Box() { Width = 1 }
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
