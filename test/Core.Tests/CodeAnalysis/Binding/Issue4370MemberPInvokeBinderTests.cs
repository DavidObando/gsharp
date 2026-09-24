// <copyright file="Issue4370MemberPInvokeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder coverage for issue #4370: <c>@LibraryImport</c> / <c>@DllImport</c>
/// on class and struct members. A <c>shared</c>-block member is the supported
/// static P/Invoke shape (its emit is pinned by the Compiler.Tests
/// <c>Issue4370MemberPInvokeEmitTests</c>); an instance member and a member
/// of a generic type are rejected with GS0326, because the CLR only runs
/// static P/Invoke methods whose declaring type is not generic.
/// </summary>
public class Issue4370MemberPInvokeBinderTests
{
    [Theory]
    [InlineData("LibraryImport")]
    [InlineData("DllImport")]
    public void InstanceMethod_WithPInvokeAttribute_ReportsGS0326_NotGS0388(string attribute)
    {
        string source = $@"
package P
import System.Runtime.InteropServices

class Native {{
    @{attribute}(""libc"", EntryPoint: ""getpid"")
    func GetPid() int32;
}}
";
        var scope = BindSource(source);

        var diagnostic = Assert.Single(scope.Diagnostics);
        Assert.Equal("GS0326", diagnostic.Id);
        Assert.Contains("instance methods are not supported", diagnostic.Message);
        Assert.Contains("shared", diagnostic.Message);

        // The message names the attribute actually written.
        Assert.StartsWith($"'@{attribute}' is not valid on 'GetPid'", diagnostic.Message);
    }

    [Fact]
    public void InstanceMethod_OnStruct_WithPInvokeAttributeAndBody_ReportsGS0326()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

struct Native {
    var v int32
    @LibraryImport(""libc"", EntryPoint: ""getpid"")
    func GetPid() int32 {
        return 0
    }
}
";
        var scope = BindSource(source);

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0326" && d.Message.Contains("instance methods are not supported"));
    }

    [Theory]
    [InlineData("LibraryImport")]
    [InlineData("DllImport")]
    public void SharedPInvoke_InGenericClass_ReportsGS0326(string attribute)
    {
        string source = $@"
package P
import System.Runtime.InteropServices

class Native[T] {{
    shared {{
        @{attribute}(""libc"", EntryPoint: ""getpid"")
        func GetPid() int32;
    }}
}}
";
        var scope = BindSource(source);

        var diagnostic = Assert.Single(scope.Diagnostics);
        Assert.Equal("GS0326", diagnostic.Id);
        Assert.Contains("members of generic types are not supported", diagnostic.Message);
        Assert.StartsWith($"'@{attribute}' is not valid on 'GetPid'", diagnostic.Message);
    }

    [Fact]
    public void SharedPInvoke_InClassNestedInGenericClass_ReportsGS0326()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

class Outer[T] {
    class Native {
        shared {
            @DllImport(""libc"", EntryPoint: ""getpid"")
            func GetPid() int32;
        }
    }
}
";
        var scope = BindSource(source);

        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0326" && d.Message.Contains("members of generic types are not supported"));
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
