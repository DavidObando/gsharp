// <copyright file="Issue797SharedBlockAnnotationBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #797: confirms that Kotlin-style <c>@Foo</c> annotations parsed on
/// members of a <c>shared { … }</c> block (ADR-0053) reach the bound member
/// symbol via <see cref="DeclarationBinder"/>. Prior to #797 the parser
/// silently dropped the annotation by reinterpreting the leading <c>@</c>
/// as the start of a field declaration; the binder never saw it.
/// </summary>
public class Issue797SharedBlockAnnotationBinderTests
{
    [Fact]
    public void AnnotationOnStaticMethod_BindsToStaticMethodSymbol()
    {
        const string source = @"
package P

class Sample {
    shared {
        @Obsolete
        func Run() {
        }
    }
}
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var sample = scope.Structs.Single(s => s.Name == "Sample");
        var run = Assert.Single(sample.StaticMethods);
        Assert.Equal("Run", run.Name);
        Assert.True(run.IsStatic);
        var attr = Assert.Single(run.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Method, attr.Target);
    }

    [Fact]
    public void AnnotationWithStringArgument_OnStaticMethod_BindsArgument()
    {
        const string source = @"
package P

class Sample {
    shared {
        @Obsolete(""please call NewRun instead"")
        func Run() {
        }
    }
}
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var run = scope.Structs.Single(s => s.Name == "Sample").StaticMethods.Single();
        var attr = Assert.Single(run.Attributes);
        var posArg = Assert.Single(attr.PositionalArguments);
        Assert.Equal("please call NewRun instead", posArg.Value);
    }

    [Fact]
    public void StackedAnnotations_OnStaticMethod_AreAllBound()
    {
        // Mirrors `AttributeBinderTests.Binds_Multiple_Stacked_Annotations` —
        // both attribute applications are recorded on the symbol even though
        // the binder emits a duplicate-application diagnostic for `[Obsolete]`
        // (AllowMultiple = false).
        const string source = @"
package P

class Sample {
    shared {
        @Obsolete
        @Obsolete(""again"")
        func Run() {
        }
    }
}
";
        var scope = BindSource(source);

        var run = scope.Structs.Single(s => s.Name == "Sample").StaticMethods.Single();
        Assert.Equal(2, run.Attributes.Length);
    }

    [Fact]
    public void AnnotationOnStaticField_BindsToFieldSymbol()
    {
        const string source = @"
package P

class Config {
    shared {
        @Obsolete
        var Threshold int32 = 0
    }
}
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var config = scope.Structs.Single(s => s.Name == "Config");
        var threshold = Assert.Single(config.StaticFields);
        Assert.Equal("Threshold", threshold.Name);
        Assert.True(threshold.IsStatic);
        var attr = Assert.Single(threshold.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Field, attr.Target);
    }

    [Fact]
    public void AnnotationOnStaticProperty_BindsToPropertySymbol()
    {
        const string source = @"
package P

class Config {
    shared {
        @Obsolete
        prop Name string
    }
}
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var config = scope.Structs.Single(s => s.Name == "Config");
        var name = Assert.Single(config.StaticProperties);
        Assert.True(name.IsStatic);
        var attr = Assert.Single(name.Attributes);
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name);
        Assert.Equal(AttributeTargetKind.Property, attr.Target);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
