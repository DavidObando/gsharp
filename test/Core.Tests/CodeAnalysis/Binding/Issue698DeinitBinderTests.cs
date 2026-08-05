// <copyright file="Issue698DeinitBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #698 / ADR-0068: binder-level tests for the Swift-style
/// <c>deinit { … }</c> destructor on classes. The interpreter-boundary
/// GS0510 warning ("deinitializer will not run under the interpreter")
/// retired with the tree-walking evaluator in ADR-0156 Phase 3c (#3176) —
/// deinit simply works under emitted execution, so valid deinit sources now
/// bind clean.
/// </summary>
public class Issue698DeinitBinderTests
{
    [Fact]
    public void Deinit_PopulatesDeinitializerSymbol()
    {
        var source = @"
class Resource {
    var Handle int32 = 0
    deinit {
    }
}
";
        var (diagnostics, structs) = BindAndGetStructs(source);
        Assert.Empty(diagnostics);

        var resource = structs.Single(s => s.Name == "Resource");
        Assert.NotNull(resource.Deinitializer);
        Assert.Equal("Finalize", resource.Deinitializer.Function.Name);
        Assert.Empty(resource.Deinitializer.Function.Parameters);
        Assert.True(resource.Deinitializer.Function.ReceiverType == resource);
    }

    [Fact]
    public void Deinit_BodyHasAccessToFieldsAndThis()
    {
        var source = @"
import System
class Resource {
    var Tag string = """"
    deinit {
        Console.WriteLine(Tag)
    }
}
";
        var (diagnostics, _) = BindAndGetStructs(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Deinit_OnStruct_IsRejected()
    {
        var source = @"
struct Point {
    var X int32 = 0
    deinit {
    }
}
";
        var (diagnostics, _) = BindAndGetStructs(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0289");
    }

    [Fact]
    public void Deinit_DuplicateOnSameClass_IsRejected()
    {
        var source = @"
class Resource {
    var Handle int32 = 0
    deinit {
    }
    deinit {
    }
}
";
        var (diagnostics, _) = BindAndGetStructs(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0290");
    }

    [Fact]
    public void Deinit_CannotBeCalledExplicitly()
    {
        // ADR-0068: the synthesized Finalize override is not in the user's
        // member-lookup surface — `obj.deinit()` cannot resolve.
        var source = @"
import System
class Resource {
    var Handle int32 = 0
    deinit {
    }
}

var r = Resource()
r.deinit()
";
        var (diagnostics, _) = BindAndGetStructs(source);
        Assert.NotEmpty(diagnostics);
    }

    [Fact]
    public void Deinit_OnSubclass_BindsSeparately()
    {
        var source = @"
open class Resource(Tag string) {
    deinit {
    }
}
class CachedResource : Resource {
    var Key string = """"
    init(t string) : base(t) {
    }
    deinit {
    }
}
";
        var (diagnostics, structs) = BindAndGetStructs(source);
        Assert.Empty(diagnostics);

        var resource = structs.Single(s => s.Name == "Resource");
        var cached = structs.Single(s => s.Name == "CachedResource");

        Assert.NotNull(resource.Deinitializer);
        Assert.NotNull(cached.Deinitializer);
        Assert.NotSame(resource.Deinitializer, cached.Deinitializer);
    }

    // Binder-inspection shape (ADR-0156 Phase 3c, #3176): fully bind and
    // collect diagnostics without executing — these tests assert bound
    // symbols and binder diagnostics, never runtime behavior.
    private static (ImmutableArray<Diagnostic> Diagnostics, IEnumerable<StructSymbol> Structs) BindAndGetStructs(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        var structs = compilation.GlobalScope.Structs;
        return (diagnostics, structs);
    }
}
