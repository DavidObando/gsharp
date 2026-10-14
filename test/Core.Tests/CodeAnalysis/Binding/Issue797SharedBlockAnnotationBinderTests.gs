// <copyright file="Issue797SharedBlockAnnotationBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #797: confirms that Kotlin-style `@Foo` annotations parsed on
/// members of a `shared { … }` block (ADR-0053) reach the bound member
/// symbol via (cref:DeclarationBinder). Prior to #797 the parser
/// silently dropped the annotation by reinterpreting the leading `@`
/// as the start of a field declaration; the binder never saw it.
open class Issue797SharedBlockAnnotationBinderTests {
    @Fact
    func AnnotationOnStaticMethod_BindsToStaticMethodSymbol() {
        const source = `
package P

class Sample {
    shared {
        @Obsolete
        func Run() {
        }
    }
}
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let sample = scope_.Structs.Single((s StructSymbol) -> s.Name == "Sample")
        let run = Assert.Single(sample.StaticMethods)
        Assert.Equal("Run", run.Name)
        Assert.True(run.IsStatic)
        let attr = Assert.Single(run.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Method, attr.Target)
    }

    @Fact
    func AnnotationWithStringArgument_OnStaticMethod_BindsArgument() {
        const source = `
package P

class Sample {
    shared {
        @Obsolete("please call NewRun instead")
        func Run() {
        }
    }
}
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let run = scope_.Structs.Single((s StructSymbol) -> s.Name == "Sample").StaticMethods.Single()
        let attr = Assert.Single(run.Attributes)
        let posArg = Assert.Single(attr.PositionalArguments)
        Assert.Equal("please call NewRun instead", posArg.Value)
    }

    @Fact
    func StackedAnnotations_OnStaticMethod_AreAllBound() {
        // Mirrors `AttributeBinderTests.Binds_Multiple_Stacked_Annotations` —
        // both attribute applications are recorded on the symbol even though
        // the binder emits a duplicate-application diagnostic for `[Obsolete]`
        // (AllowMultiple = false).
        const source = `
package P

class Sample {
    shared {
        @Obsolete
        @Obsolete("again")
        func Run() {
        }
    }
}
`
        let scope_ = BindSource(source)
        let run = scope_.Structs.Single((s StructSymbol) -> s.Name == "Sample").StaticMethods.Single()
        Assert.Equal(2, run.Attributes.Length)
    }

    @Fact
    func AnnotationOnStaticField_BindsToFieldSymbol() {
        const source = `
package P

class Config {
    shared {
        @Obsolete
        var Threshold int32 = 0
    }
}
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let config = scope_.Structs.Single((s StructSymbol) -> s.Name == "Config")
        let threshold = Assert.Single(config.StaticFields)
        Assert.Equal("Threshold", threshold.Name)
        Assert.True(threshold.IsStatic)
        let attr = Assert.Single(threshold.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Field, attr.Target)
    }

    @Fact
    func AnnotationOnStaticProperty_BindsToPropertySymbol() {
        const source = `
package P

class Config {
    shared {
        @Obsolete
        prop Name string
    }
}
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let config = scope_.Structs.Single((s StructSymbol) -> s.Name == "Config")
        let name = Assert.Single(config.StaticProperties)
        Assert.True(name.IsStatic)
        let attr = Assert.Single(name.Attributes)
        Assert.Equal("System.ObsoleteAttribute", attr.AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Property, attr.Target)
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
