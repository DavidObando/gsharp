// <copyright file="ClrConstructorCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4 exit — CLR class instantiation at call sites. Covers both
/// non-generic (<c>StringBuilder()</c>) and closed-generic
/// (<c>List[int]()</c>, <c>Dictionary[string, int]()</c>) imports through
/// the new <see cref="BoundClrConstructorCallExpression"/>.
/// </summary>
public class ClrConstructorCallTests
{
    [Fact]
    public void StringBuilder_DefaultConstructor_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListInt_WithNestedNonGenericSourceHomonym_BindsImportedGeneric()
    {
        var source = @"
package Demo
import System.Collections.Generic

class DocInline {
    class List {}
}

var lst = List[int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedTopLevelType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedService {}
}

class Consumer {
    shared {
        func Read() int32 {
            let service = Issue3466ImportedService()
            return service.Value
        }
    }
}

var value = Consumer.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedGenericType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        prop Value T
    }
}

class Consumer {
    shared {
        func Create() Issue3466ImportedGenericService[int32] {
            return Issue3466ImportedGenericService[int32](7)
        }

        func Read() int32 {
            return Create().Value
        }
    }
}

Consumer.Read()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ImportedGenericQualifiedType_WithSameArityNestedSourceHomonym_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        class Token {
            prop SourceValue int32
        }
    }
}

func Read(value Issue3466ImportedGenericService[int32].Token) int32 {
    return value.ImportedValue
}

0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ImportedGenericLiteral_WithMatchingNestedMembers_BindsImportedType()
    {
        var source = @"
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericInitializer[T] {
        prop Value int32 { get; set; }
    }
}

let target = Issue3466ImportedGenericInitializer[string]{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void ImportedAlias_WithNestedSourceHomonym_BindsImportedTypeAtUnknownArity()
    {
        var source = @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedService

class Holder {
    class Service {
        prop Value int32
    }
}

func Create() Service {
    return Service()
}

Create().Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ImportedAliasLiteral_WithMatchingNestedMembers_BindsImportedType()
    {
        var source = @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }
}

let target = Service{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(107, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_TypeAnnotationWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func ReadImported(value Service) int32 {
    return value.Value
}

let nested = Holder.Service{Value: 7}
let imported = Service{Value: 7}
Holder.ReadNested(nested) * 1000 + ReadImported(imported)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7107, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_ConstructorWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func ConstructImported() int32 {
    let value = Service()
    return value.Value
}

Holder.ConstructNested() * 1000 + ConstructImported()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void NestedSourceHomonym_InContainingScope_LiteralWinsImportedAlias()
    {
        var source = NestedAliasScopeSource() + @"
func InitializeImported() int32 {
    let value = Service{Value: 7}
    return value.Value
}

Holder.InitializeNested() * 1000 + InitializeImported()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7107, result.Value);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void ImportedAliasLookup_NonPositiveArity_ResolvesExactNonGenericTarget(int preferredArity)
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(Issue3466ImportedService).Assembly.Location });
        var scope = new BoundScope(null, resolver);
        Assert.True(scope.TryImport(new ImportSymbol(
            "Service",
            typeof(Issue3466ImportedService).FullName!,
            declaration: null)));

        Assert.True(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity,
            declaration: null,
            out var imported));
        Assert.Equal(typeof(Issue3466ImportedService).FullName, imported.ClassType.FullName);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void ImportedGenericAliasLookup_NonPositiveArity_DoesNotResolveOpenType(int preferredArity)
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(Issue3466ImportedGenericService<>).Assembly.Location });
        var scope = new BoundScope(null, resolver);
        string target = typeof(Issue3466ImportedGenericService<>).FullName!.Split('`')[0];
        Assert.True(scope.TryImport(new ImportSymbol("Service", target, declaration: null)));

        Assert.False(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity,
            declaration: null,
            out _));
        Assert.True(scope.TryLookupImportedClassByArity(
            "Service",
            preferredArity: 1,
            declaration: null,
            out var imported));
        Assert.True(imported.ClassType.IsGenericTypeDefinition);
    }

    [Fact]
    public void ImportedGeneric_WithUnknownArity_DoesNotOverrideNestedNonGenericType()
    {
        var source = @"
package Demo
import System.Collections.Generic

class Holder {
    class List {
        prop Value int32 { get; set; }
    }
}

let target = List{Value: 7}
target.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void DictionaryStringInt_DefaultConstructor_Binds()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int32]()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_WithCapacityArgument_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder(16)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilder_TooManyArguments_Diagnoses()
    {
        var source = @"
import System.Text

var sb = StringBuilder(""x"", ""y"", ""z"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static string NestedAliasScopeSource() => @"
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }

    shared {
        func ReadNested(value Service) int32 {
            return value.Value
        }

        func ConstructNested() int32 {
            let value = Service()
            return value.Value
        }

        func InitializeNested() int32 {
            let value = Service{Value: 7}
            return value.Value
        }
    }
}
";

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}

public sealed class Issue3466ImportedService
{
    public Issue3466ImportedService()
    {
        this.Value = 7;
    }

    public int Value { get; }
}

public sealed class Issue3466ImportedGenericService<T>
{
    public Issue3466ImportedGenericService(T value)
    {
        this.Value = value;
    }

    public T Value { get; }

    public sealed class Token
    {
        public int ImportedValue => 11;
    }
}

public sealed class Issue3466ImportedGenericInitializer<T>
{
    private int value;

    public int Value
    {
        get => this.value + 100;
        set => this.value = value;
    }
}

public sealed class Issue3466ImportedInitializer
{
    private int value;

    public int Value
    {
        get => this.value + 100;
        set => this.value = value;
    }
}
