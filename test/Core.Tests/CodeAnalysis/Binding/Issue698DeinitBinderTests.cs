// <copyright file="Issue698DeinitBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #698 / ADR-0068: binder-level tests for the Swift-style
/// <c>deinit { … }</c> destructor on classes.
/// </summary>
public class Issue698DeinitBinderTests
{
    [Fact]
    public void Deinit_PopulatesDeinitializerSymbol()
    {
        var source = @"
type Resource class {
    var Handle int32 = 0
    deinit {
    }
}
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

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
type Resource class {
    var Tag string = """"
    deinit {
        Console.WriteLine(Tag)
    }
}
";
        var (result, _) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Deinit_OnStruct_IsRejected()
    {
        var source = @"
type Point struct {
    var X int32 = 0
    deinit {
    }
}
";
        var (result, _) = EvaluateAndGetStructs(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0289");
    }

    [Fact]
    public void Deinit_DuplicateOnSameClass_IsRejected()
    {
        var source = @"
type Resource class {
    var Handle int32 = 0
    deinit {
    }
    deinit {
    }
}
";
        var (result, _) = EvaluateAndGetStructs(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0290");
    }

    [Fact]
    public void Deinit_CannotBeCalledExplicitly()
    {
        // ADR-0068: the synthesized Finalize override is not in the user's
        // member-lookup surface — `obj.deinit()` cannot resolve.
        var source = @"
import System
type Resource class {
    var Handle int32 = 0
    deinit {
    }
}

var r = Resource()
r.deinit()
";
        var (result, _) = EvaluateAndGetStructs(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Deinit_OnSubclass_BindsSeparately()
    {
        var source = @"
type Resource open class(Tag string) {
    deinit {
    }
}
type CachedResource class : Resource {
    var Key string = """"
    init(t string) : base(t) {
    }
    deinit {
    }
}
";
        var (result, structs) = EvaluateAndGetStructs(source);
        Assert.Empty(result.Diagnostics);

        var resource = structs.Single(s => s.Name == "Resource");
        var cached = structs.Single(s => s.Name == "CachedResource");

        Assert.NotNull(resource.Deinitializer);
        Assert.NotNull(cached.Deinitializer);
        Assert.NotSame(resource.Deinitializer, cached.Deinitializer);
    }

    private static (EvaluationResult Result, IEnumerable<StructSymbol> Structs) EvaluateAndGetStructs(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        var structs = compilation.GlobalScope.Structs;
        return (result, structs);
    }
}
