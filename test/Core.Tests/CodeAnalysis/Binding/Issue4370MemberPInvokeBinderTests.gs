// <copyright file="Issue4370MemberPInvokeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import Xunit

/// Binder coverage for issue #4370: `@LibraryImport` / `@DllImport`
/// on class and struct members. A `shared`-block member is the supported
/// static P/Invoke shape (its emit is pinned by the Compiler.Tests
/// `Issue4370MemberPInvokeEmitTests`); an instance member and a member
/// of a generic type are rejected with GS0326, because the CLR only runs
/// static P/Invoke methods whose declaring type is not generic.
open class Issue4370MemberPInvokeBinderTests {
    @Theory
    @InlineData("LibraryImport")
    @InlineData("DllImport")
    func InstanceMethod_WithPInvokeAttribute_ReportsGS0326_NotGS0388(attribute string) {
        let source = (`
package P
import System.Runtime.InteropServices

class Native {
    @` + "$attribute" + `("libc", EntryPoint: "getpid")
    func GetPid() int32;
}
`)
        let scope_ = BindSource(source)
        let diagnostic = Assert.Single(scope_.Diagnostics)
        Assert.Equal("GS0326", diagnostic.Id)
        Assert.Contains("instance methods are not supported", diagnostic.Message)
        Assert.Contains("shared", diagnostic.Message)
        // The message names the attribute actually written.
        Assert.StartsWith("'@$attribute' is not valid on 'GetPid'", diagnostic.Message)
    }

    @Fact
    func InstanceMethod_OnStruct_WithPInvokeAttributeAndBody_ReportsGS0326() {
        const source = `
package P
import System.Runtime.InteropServices

struct Native {
    var v int32
    @LibraryImport("libc", EntryPoint: "getpid")
    func GetPid() int32 {
        return 0
    }
}
`
        let scope_ = BindSource(source)
        Assert.Contains(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0326" && d.Message.Contains("instance methods are not supported")
        )
    }

    @Theory
    @InlineData("LibraryImport")
    @InlineData("DllImport")
    func SharedPInvoke_InGenericClass_ReportsGS0326(attribute string) {
        let source = (`
package P
import System.Runtime.InteropServices

class Native[T] {
    shared {
        @` + "$attribute" + `("libc", EntryPoint: "getpid")
        func GetPid() int32;
    }
}
`)
        let scope_ = BindSource(source)
        let diagnostic = Assert.Single(scope_.Diagnostics)
        Assert.Equal("GS0326", diagnostic.Id)
        Assert.Contains("members of generic types are not supported", diagnostic.Message)
        Assert.StartsWith("'@$attribute' is not valid on 'GetPid'", diagnostic.Message)
    }

    @Fact
    func SharedLibraryImport_InGenericClass_WithInvalidArguments_NamesLibraryImport() {
        // An empty library name fails metadata extraction (GS0322), so the
        // attribute name must come from the bound attributes, not the
        // (absent) P/Invoke metadata.
        const source = `
package P
import System.Runtime.InteropServices

class Native[T] {
    shared {
        @LibraryImport("", EntryPoint: "getpid")
        func GetPid() int32;
    }
}
`
        let scope_ = BindSource(source)
        let diagnostic = Assert.Single(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0326")
        Assert.StartsWith("'@LibraryImport' is not valid on 'GetPid'", diagnostic.Message)
        Assert.Contains("members of generic types are not supported", diagnostic.Message)
    }

    @Fact
    func SharedPInvoke_InClassNestedInGenericClass_ReportsGS0326() {
        const source = `
package P
import System.Runtime.InteropServices

class Outer[T] {
    class Native {
        shared {
            @DllImport("libc", EntryPoint: "getpid")
            func GetPid() int32;
        }
    }
}
`
        let scope_ = BindSource(source)
        Assert.Contains(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0326" && d.Message.Contains("members of generic types are not supported")
        )
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
